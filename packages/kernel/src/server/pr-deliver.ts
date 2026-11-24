import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  CommitPrActionRequestSchema,
  GateReportSchema,
  type CommitPrActionRequest,
  type GateReport,
} from "@kiln/protocol";
import { buildSanitizedEnv } from "../gate/command-runner.js";
import {
  assertSafeSegment,
  deriveTaskStatus,
  readYamlOptional,
  type KilnStore,
} from "../store/index.js";
import { ServerHttpError } from "./errors.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;

export type PrDeliverExecFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultPrDeliverExec: PrDeliverExecFn = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: MAX_OUTPUT_BUFFER,
    encoding: "utf8",
    windowsHide: true,
  });
  return { stdout, stderr };
};

export interface PrDraftSummary {
  taskId: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export type CommitPrActionResult =
  | {
      ok: true;
      action: "commit";
      alreadyClean: boolean;
      branch: string;
      commitSha: string;
    }
  | {
      ok: true;
      action: "push";
      alreadyUpToDate: boolean;
      branch: string;
      commitSha: string;
    }
  | {
      ok: true;
      action: "open_pr";
      alreadyExists: boolean;
      prUrl: string;
      prNumber: number | null;
      prTitle: string;
      branch: string;
      baseBranch: string;
    };

function assertSafeGitBranch(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("-") ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.includes("..")
  ) {
    throw new ServerHttpError(400, {
      error: "invalid_branch",
      field: label,
      message: `Invalid git branch name for ${label}: "${raw}"`,
    });
  }
  return trimmed;
}

function assertSafeCommitMessage(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw new ServerHttpError(400, {
      error: "invalid_commit_message",
      message: "Commit message contains invalid control characters or is empty",
    });
  }
  return trimmed;
}

function readOptionalTextTrimmed(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
  } catch {
    return "";
  }
}

function readLatestTaskGate(store: KilnStore, taskId: string): GateReport | null {
  const runsDir = store.paths.runsDir(taskId);
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  const dirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  for (let i = dirs.length - 1; i >= 0; i--) {
    const gate = readYamlOptional(store.paths.gateYaml(taskId, dirs[i]!), GateReportSchema);
    if (gate) {
      return gate;
    }
  }
  return null;
}

function excerptLines(markdown: string, maxChars = 600): string {
  if (!markdown) {
    return "";
  }
  return markdown.length > maxChars ? `${markdown.slice(0, maxChars).trimEnd()}\n...` : markdown;
}

/**
 * Generates an editable PR title & body draft grounded in `card.yaml`, `BRIEF.md`,
 * `RESEARCH.md`, `PLAN.md`, and deterministic `GATE.yaml` verification evidence.
 */
export function buildPrDraft(store: KilnStore, taskId: string): PrDraftSummary {
  const safeTaskId = assertSafeSegment(taskId, "taskId");
  if (!fs.existsSync(store.paths.cardYaml(safeTaskId))) {
    throw new ServerHttpError(404, {
      error: "task_not_found",
      taskId: safeTaskId,
      message: `Task "${safeTaskId}" was not found`,
    });
  }
  const card = store.readTaskCard(safeTaskId);
  const space = store.readSpace(card.space);
  const branch = `kiln/${card.id}`;
  const baseBranch = space?.default_branch ?? "main";
  const brief = readOptionalTextTrimmed(store.paths.briefMd(safeTaskId));
  const research = readOptionalTextTrimmed(store.paths.researchMd(safeTaskId));
  const plan = readOptionalTextTrimmed(store.paths.planMd(safeTaskId));
  const gate = readLatestTaskGate(store, safeTaskId);

  const nonGoals =
    card.contract.non_goals && card.contract.non_goals.length > 0
      ? card.contract.non_goals.map((item) => `- ${item}`).join("\n")
      : "- （未额外声明）";

  const gateLines = gate
    ? [
        `- 回执与租约 (schema_ok): ${gate.schema_ok ? "通过" : "未过"}`,
        `- 范围检查 (scope_ok): ${gate.scope_ok ? "通过" : `越界 ${gate.out_of_scope_paths.length} 项`}`,
        `- 冻结基线 (frozen_files_changed): ${gate.frozen_files_changed.length === 0 ? "未改动" : gate.frozen_files_changed.join(", ")}`,
        `- 验收命令 (\`${card.contract.accept_cmd}\`): exit ${gate.accept_exit_code}`,
      ].join("\n")
    : "- 尚未记录门禁报告 (GATE.yaml)";

  const sections = [
    `## 目标与终态`,
    `- 目标: ${card.contract.goal}`,
    `- 终点: ${card.contract.end}`,
    ``,
    `## 非目标边界 (non_goals)`,
    nonGoals,
    ...(brief ? [``, `## 立项方案摘要`, excerptLines(brief, 500)] : []),
    ...(research ? [``, `## 调研结论 (RESEARCH.md)`, excerptLines(research, 500)] : []),
    ...(plan ? [``, `## 技术方案 (PLAN.md)`, excerptLines(plan, 600)] : []),
    ``,
    `## 确定性门禁证据`,
    gateLines,
  ];

  return {
    taskId: card.id,
    branch,
    baseBranch,
    title: `[${card.id}] ${card.title}`,
    body: sections.join("\n"),
  };
}

function parseOpenPrListJson(
  stdout: string,
): Array<{ url: string; number: number | null; title: string }> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (item): item is { url: string; number?: number; title?: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { url?: unknown }).url === "string" &&
          (item as { url: string }).url.trim().length > 0,
      )
      .map((item) => ({
        url: item.url.trim(),
        number: typeof item.number === "number" ? item.number : null,
        title: typeof item.title === "string" ? item.title : "",
      }));
  } catch {
    return [];
  }
}

function parsePrNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url);
  if (!match) {
    return null;
  }
  const num = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(num) ? num : null;
}

/**
 * Executes human-confirmed `commit`, `push`, or `open_pr` steps on a `git_worktree`
 * task with read-only idempotency probes (`git ls-remote` / `gh pr list`) before
 * mutating any remote ref or opening a PR.
 */
export async function executeCommitPrAction(input: {
  store: KilnStore;
  taskId: string;
  request: CommitPrActionRequest;
  execCommand?: PrDeliverExecFn;
}): Promise<CommitPrActionResult> {
  const req = CommitPrActionRequestSchema.parse(input.request);
  const safeTaskId = assertSafeSegment(input.taskId, "taskId");
  if (!fs.existsSync(input.store.paths.cardYaml(safeTaskId))) {
    throw new ServerHttpError(404, {
      error: "task_not_found",
      taskId: safeTaskId,
      message: `Task "${safeTaskId}" was not found`,
    });
  }

  const card = input.store.readTaskCard(safeTaskId);
  if (card.workspace_mode !== "git_worktree") {
    throw new ServerHttpError(400, {
      error: "unsupported_workspace_mode",
      workspaceMode: card.workspace_mode,
      message: `Commit / Push / PR 仅支持 git_worktree 模式（当前为 ${card.workspace_mode}）`,
    });
  }

  const derived = deriveTaskStatus(card, input.store.readStateEvents(safeTaskId));
  if (derived.status === "running") {
    throw new ServerHttpError(409, {
      error: "task_running",
      taskId: safeTaskId,
      message: `任务 "${safeTaskId}" 正在执行中，请等待或暂停后再执行 Git 交付操作`,
    });
  }

  const worktreePath = path.join(input.store.paths.workspaceDir(safeTaskId), "worktree");
  if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
    throw new ServerHttpError(400, {
      error: "worktree_not_found",
      taskId: safeTaskId,
      worktreePath,
      message: `工作树目录不存在：${worktreePath}`,
    });
  }

  const space = input.store.readSpace(card.space);
  const branch = assertSafeGitBranch(req.branch ?? `kiln/${card.id}`, "branch");
  const baseBranch = assertSafeGitBranch(
    req.base_branch ?? space?.default_branch ?? "main",
    "base_branch",
  );

  const execCommand = input.execCommand ?? defaultPrDeliverExec;
  const localEnv = buildSanitizedEnv();
  const remoteEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const refCandidate of [branch, baseBranch]) {
    try {
      await execCommand("git", ["check-ref-format", "--branch", refCandidate], {
        cwd: worktreePath,
        env: localEnv,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch {
      throw new ServerHttpError(400, {
        error: "invalid_branch",
        branch: refCandidate,
        message: `Branch "${refCandidate}" failed git check-ref-format`,
      });
    }
  }

  if (req.action === "commit") {
    const statusRes = await execCommand("git", ["-C", worktreePath, "status", "--porcelain"], {
      cwd: worktreePath,
      env: localEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (statusRes.stdout.trim().length === 0) {
      const headRes = await execCommand("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
        cwd: worktreePath,
        env: localEnv,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      return {
        ok: true,
        action: "commit",
        alreadyClean: true,
        branch,
        commitSha: headRes.stdout.trim(),
      };
    }

    const commitMsg = assertSafeCommitMessage(
      req.commit_message ?? `kiln(${card.id}): ${card.title}`,
    );
    await execCommand("git", ["-C", worktreePath, "add", "-A"], {
      cwd: worktreePath,
      env: localEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    await execCommand("git", ["-C", worktreePath, "commit", "-m", commitMsg], {
      cwd: worktreePath,
      env: localEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const headRes = await execCommand("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      cwd: worktreePath,
      env: localEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    return {
      ok: true,
      action: "commit",
      alreadyClean: false,
      branch,
      commitSha: headRes.stdout.trim(),
    };
  }

  if (req.action === "push") {
    const statusRes = await execCommand("git", ["-C", worktreePath, "status", "--porcelain"], {
      cwd: worktreePath,
      env: localEnv,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (statusRes.stdout.trim().length > 0) {
      throw new ServerHttpError(409, {
        error: "dirty_worktree",
        taskId: safeTaskId,
        message: "工作树尚有未提交修改，请先确认提交后再推送分支",
      });
    }

    const localHead = (
      await execCommand("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
        cwd: worktreePath,
        env: localEnv,
        timeoutMs: COMMAND_TIMEOUT_MS,
      })
    ).stdout.trim();

    const targetRef = `refs/heads/${branch}`;
    const lsRemote = await execCommand(
      "git",
      ["-C", worktreePath, "ls-remote", "--heads", "origin", targetRef],
      { cwd: worktreePath, env: remoteEnv, timeoutMs: COMMAND_TIMEOUT_MS },
    );
    const remoteSha = lsRemote.stdout.trim().split(/\s+/)[0]?.trim();
    if (remoteSha && remoteSha === localHead) {
      return {
        ok: true,
        action: "push",
        alreadyUpToDate: true,
        branch,
        commitSha: localHead,
      };
    }

    // Bypass only Kiln's agent-blocking worktree pre-push hook after explicit human confirm.
    await execCommand(
      "git",
      ["-C", worktreePath, "push", "--no-verify", "-u", "origin", `HEAD:${targetRef}`],
      { cwd: worktreePath, env: remoteEnv, timeoutMs: COMMAND_TIMEOUT_MS },
    );
    return {
      ok: true,
      action: "push",
      alreadyUpToDate: false,
      branch,
      commitSha: localHead,
    };
  }

  // req.action === "open_pr"
  const draft = buildPrDraft(input.store, safeTaskId);
  const title = (req.pr_title ?? draft.title).trim();
  const body = req.pr_body ?? draft.body;

  const runGh = async (args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    try {
      return await execCommand("gh", args, {
        cwd: worktreePath,
        env: remoteEnv,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ServerHttpError(400, {
          error: "gh_cli_unavailable",
          message: "未检测到 GitHub CLI (gh)，请先安装并执行 gh auth login",
        });
      }
      throw err;
    }
  };

  // Read-only idempotency check before creating any PR.
  const existingPrRes = await runGh([
    "pr",
    "list",
    `--head=${branch}`,
    `--base=${baseBranch}`,
    "--state=open",
    "--json",
    "url,number,title",
  ]);
  const existingPrs = parseOpenPrListJson(existingPrRes.stdout);
  if (existingPrs.length > 0) {
    const first = existingPrs[0]!;
    return {
      ok: true,
      action: "open_pr",
      alreadyExists: true,
      prUrl: first.url,
      prNumber: first.number ?? parsePrNumberFromUrl(first.url),
      prTitle: first.title || title,
      branch,
      baseBranch,
    };
  }

  const targetRef = `refs/heads/${branch}`;
  const lsRemote = await execCommand(
    "git",
    ["-C", worktreePath, "ls-remote", "--heads", "origin", targetRef],
    { cwd: worktreePath, env: remoteEnv, timeoutMs: COMMAND_TIMEOUT_MS },
  );
  if (lsRemote.stdout.trim().length === 0) {
    throw new ServerHttpError(409, {
      error: "branch_not_pushed",
      branch,
      message: `远端尚未存在分支 ${branch}，请先执行推送后再创建 PR`,
    });
  }

  const createdRes = await runGh([
    "pr",
    "create",
    `--base=${baseBranch}`,
    `--head=${branch}`,
    `--title=${title}`,
    `--body=${body}`,
  ]);

  const urlMatch = /https?:\/\/\S+/.exec(createdRes.stdout);
  let prUrl = urlMatch ? urlMatch[0] : createdRes.stdout.trim();
  let prNumber = prUrl ? parsePrNumberFromUrl(prUrl) : null;
  if (!prUrl) {
    const fallbackList = await runGh([
      "pr",
      "list",
      `--head=${branch}`,
      `--base=${baseBranch}`,
      "--state=open",
      "--json",
      "url,number,title",
    ]);
    const prs = parseOpenPrListJson(fallbackList.stdout);
    if (prs[0]) {
      prUrl = prs[0].url;
      prNumber = prs[0].number;
    }
  }

  return {
    ok: true,
    action: "open_pr",
    alreadyExists: false,
    prUrl,
    prNumber,
    prTitle: title,
    branch,
    baseBranch,
  };
}
