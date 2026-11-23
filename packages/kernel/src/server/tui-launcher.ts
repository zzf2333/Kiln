import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  OpenRunTuiResponseSchema,
  parseFrontmatterMarkdown,
  type GateReport,
  type OpenRunTuiResponse,
  type PricingConfig,
  type RunEvent,
  type RunMeta,
  type TaskCard,
  type TaskStatus,
} from "@kiln/protocol";
import type { UsageTurnRow } from "../store/index.js";
import { ServerHttpError } from "./errors.js";
import { computeUsageSnapshot } from "./pending-decisions.js";
import type { PickLocalDirectoryExecFn } from "./space-inspect.js";

const execFileAsync = promisify(execFile);

export const NATIVE_TUI_SUPPORTED_AGENTS = [
  "codex",
  "pi",
  "claude",
  "opencode",
  "agy",
  "gemini",
] as const;
export type NativeTuiSupportedAgent = (typeof NATIVE_TUI_SUPPORTED_AGENTS)[number];

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const NATIVE_SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_PI_SESSION_TARGET_LENGTH = 512;
const MAX_STORED_TUI_SCRIPTS = 20;

export interface ResolveNativeTuiCommandInput {
  agent: string;
  providerSessionId?: string | null;
  providerSessionPath?: string | null;
}

export type NativeTuiResolveErrorCode =
  | "unsupported_tui_agent"
  | "native_session_unavailable"
  | "invalid_tui_target";

export type ResolveNativeTuiCommandResult =
  | {
      ok: true;
      agent: NativeTuiSupportedAgent;
      binary: NativeTuiSupportedAgent;
      args: string[];
      providerSessionId: string;
      commandPreview: string;
    }
  | {
      ok: false;
      code: NativeTuiResolveErrorCode;
      status: 400 | 409;
      message: string;
    };

function quotePosixArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatPreviewArg(value: string): string {
  return /[^A-Za-z0-9._:@/=+-]/.test(value) ? quotePosixArg(value) : value;
}

function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_RE.test(value);
}

/**
 * Resolves a validated, shell-free argv descriptor for launching an agent's native interactive TUI.
 * Uses strict allowlists so internal Paseo UUIDs are never blindly passed to external CLIs.
 */
export function resolveNativeTuiCommand(
  input: ResolveNativeTuiCommandInput,
): ResolveNativeTuiCommandResult {
  const normalizedAgent = input.agent.trim().toLowerCase();
  if (!(NATIVE_TUI_SUPPORTED_AGENTS as readonly string[]).includes(normalizedAgent)) {
    return {
      ok: false,
      code: "unsupported_tui_agent",
      status: 400,
      message: `Agent "${input.agent}" 暂不支持直接拉起原生 TUI`,
    };
  }
  const typedAgent = normalizedAgent as NativeTuiSupportedAgent;

  const rawSessionId =
    typeof input.providerSessionId === "string" ? input.providerSessionId.trim() : "";
  const rawSessionPath =
    typeof input.providerSessionPath === "string" ? input.providerSessionPath.trim() : "";

  if (
    (rawSessionId.length > 0 && hasControlChars(rawSessionId)) ||
    (rawSessionPath.length > 0 && hasControlChars(rawSessionPath))
  ) {
    return {
      ok: false,
      code: "invalid_tui_target",
      status: 400,
      message: "原生 Session 标识包含非法控制字符，已拒绝构造 TUI 启动命令",
    };
  }

  if (typedAgent === "pi") {
    const target = rawSessionPath || rawSessionId;
    if (!target) {
      return {
        ok: false,
        code: "native_session_unavailable",
        status: 409,
        message: "该 Pi 执行轮次尚未捕获原生 Session ID 或文件路径，无法跳转原生 TUI",
      };
    }
    if (
      target.length > MAX_PI_SESSION_TARGET_LENGTH ||
      target.startsWith("-") ||
      (!rawSessionPath && !NATIVE_SESSION_ID_RE.test(rawSessionId))
    ) {
      return {
        ok: false,
        code: "invalid_tui_target",
        status: 400,
        message: "Pi 原生 Session 参数格式不合法",
      };
    }
    const args = ["--session", target];
    return {
      ok: true,
      agent: "pi",
      binary: "pi",
      args,
      providerSessionId: rawSessionId || target,
      commandPreview: `pi ${args.map(formatPreviewArg).join(" ")}`,
    };
  }

  if (!rawSessionId) {
    return {
      ok: false,
      code: "native_session_unavailable",
      status: 409,
      message: `该 ${typedAgent} 执行轮次未记录底层原生 Session ID，无法直达原生 TUI`,
    };
  }
  if (!NATIVE_SESSION_ID_RE.test(rawSessionId)) {
    return {
      ok: false,
      code: "invalid_tui_target",
      status: 400,
      message: `${typedAgent} 原生 Session ID "${rawSessionId}" 包含非法字符`,
    };
  }

  let args: string[];
  switch (typedAgent) {
    case "codex":
      args = ["resume", rawSessionId];
      break;
    case "claude":
      args = ["--resume", rawSessionId];
      break;
    case "opencode":
      args = ["--session", rawSessionId];
      break;
    case "agy":
      args = ["--conversation", rawSessionId];
      break;
    case "gemini":
      args = ["--resume", rawSessionId];
      break;
  }

  return {
    ok: true,
    agent: typedAgent,
    binary: typedAgent,
    args,
    providerSessionId: rawSessionId,
    commandPreview: `${typedAgent} ${args.map(formatPreviewArg).join(" ")}`,
  };
}

function isExistingDirectory(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed || hasControlChars(trimmed)) return false;
  try {
    return fs.statSync(trimmed).isDirectory();
  } catch {
    return false;
  }
}

function resolveLaunchCwd(options: {
  cwd?: string | null;
  fallbackCwd?: string | null;
  homedir: string;
}): { cwd: string; cwdFallback: boolean } {
  if (options.cwd && hasControlChars(options.cwd)) {
    throw new ServerHttpError(400, {
      error: "invalid_tui_target",
      message: "工作目录路径包含非法控制字符",
    });
  }
  if (isExistingDirectory(options.cwd)) {
    return { cwd: path.resolve(options.cwd), cwdFallback: false };
  }
  if (isExistingDirectory(options.fallbackCwd)) {
    return { cwd: path.resolve(options.fallbackCwd), cwdFallback: true };
  }
  return { cwd: path.resolve(options.homedir), cwdFallback: true };
}

function pruneOldTuiScripts(tuiDir: string): void {
  try {
    const entries = fs
      .readdirSync(tuiDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(tuiDir, e.name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of entries.slice(MAX_STORED_TUI_SCRIPTS)) {
      fs.rmSync(stale.full, { force: true });
    }
  } catch {
    // Best-effort cleanup of stale launcher scripts.
  }
}

function findBinaryOnPath(binaryName: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try next PATH entry.
    }
  }
  return null;
}

export interface LaunchNativeAgentTuiOptions {
  kilnHome: string;
  taskId: string;
  runDir: string;
  agent: string;
  providerSessionId?: string | null;
  providerSessionPath?: string | null;
  cwd?: string | null;
  fallbackCwd?: string | null;
  platform?: NodeJS.Platform;
  homedir?: string;
  execFileFn?: PickLocalDirectoryExecFn;
}

/**
 * Opens an interactive OS terminal window running the agent's native TUI session.
 * Never passes user-controlled arguments through a live shell string or AppleScript string interpolation.
 */
export async function launchNativeAgentTui(
  options: LaunchNativeAgentTuiOptions,
): Promise<OpenRunTuiResponse> {
  const resolved = resolveNativeTuiCommand({
    agent: options.agent,
    providerSessionId: options.providerSessionId,
    providerSessionPath: options.providerSessionPath,
  });
  if (!resolved.ok) {
    throw new ServerHttpError(resolved.status, {
      error: resolved.code,
      message: resolved.message,
    });
  }

  const homedir = options.homedir ?? os.homedir();
  const { cwd, cwdFallback } = resolveLaunchCwd({
    cwd: options.cwd,
    fallbackCwd: options.fallbackCwd,
    homedir,
  });

  const platform = options.platform ?? process.platform;
  const tuiDir = path.join(options.kilnHome, "run", "tui");
  fs.mkdirSync(tuiDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    try {
      fs.chmodSync(tuiDir, 0o700);
    } catch {
      // Ignore chmod failure on unsupported filesystems.
    }
  }

  const execFn: PickLocalDirectoryExecFn =
    options.execFileFn ??
    (async (file, args, opts) => {
      const res = await execFileAsync(file, [...args], {
        encoding: "utf8",
        ...opts,
      });
      return {
        stdout: String(res.stdout ?? ""),
        stderr: String(res.stderr ?? ""),
      };
    });

  const nonce = `${Date.now()}-${randomUUID().slice(0, 6)}`;
  try {
    if (platform === "darwin") {
      const scriptPath = path.join(tuiDir, `kiln-tui-${nonce}.command`);
      const script = [
        "#!/bin/sh",
        "set -eu",
        'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/mise/shims:$PATH"',
        `cd -- ${quotePosixArg(cwd)}`,
        'rm -f -- "$0"',
        `exec ${[resolved.binary, ...resolved.args].map(quotePosixArg).join(" ")}`,
        "",
      ].join("\n");
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      fs.chmodSync(scriptPath, 0o700);
      pruneOldTuiScripts(tuiDir);
      await execFn("/usr/bin/open", [scriptPath], {
        timeout: 10_000,
        encoding: "utf8",
      });
    } else if (platform === "win32") {
      const scriptPath = path.join(tuiDir, `kiln-tui-${nonce}.ps1`);
      const script = [
        `$env:Path = "$HOME\\.local\\bin;$env:LOCALAPPDATA\\Kiln\\bin;$env:Path"`,
        `Set-Location -LiteralPath ${quotePowerShellArg(cwd)}`,
        `& ${quotePowerShellArg(resolved.binary)} ${resolved.args.map(quotePowerShellArg).join(" ")}`,
        "",
      ].join("\r\n");
      fs.writeFileSync(scriptPath, script, { encoding: "utf8" });
      pruneOldTuiScripts(tuiDir);
      await execFn(
        "cmd.exe",
        [
          "/c",
          "start",
          "",
          "powershell.exe",
          "-NoExit",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ],
        {
          timeout: 10_000,
          windowsHide: true,
          encoding: "utf8",
        },
      );
    } else if (platform === "linux") {
      const scriptPath = path.join(tuiDir, `kiln-tui-${nonce}.sh`);
      const script = [
        "#!/bin/sh",
        "set -eu",
        'export PATH="$HOME/.local/bin:/usr/local/bin:$HOME/.local/share/mise/shims:$PATH"',
        `cd -- ${quotePosixArg(cwd)}`,
        'rm -f -- "$0"',
        `exec ${[resolved.binary, ...resolved.args].map(quotePosixArg).join(" ")}`,
        "",
      ].join("\n");
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      fs.chmodSync(scriptPath, 0o700);
      pruneOldTuiScripts(tuiDir);

      const terminalCandidates: Array<{ bin: string; makeArgs: (s: string) => string[] }> = [
        { bin: "x-terminal-emulator", makeArgs: (s) => ["-e", s] },
        { bin: "gnome-terminal", makeArgs: (s) => ["--", s] },
        { bin: "konsole", makeArgs: (s) => ["-e", s] },
        { bin: "kitty", makeArgs: (s) => [s] },
        { bin: "alacritty", makeArgs: (s) => ["-e", s] },
        { bin: "xterm", makeArgs: (s) => ["-e", s] },
      ];
      const availableTerm = terminalCandidates.find((t) => findBinaryOnPath(t.bin) !== null);
      if (!availableTerm && !options.execFileFn) {
        throw new ServerHttpError(500, {
          error: "tui_terminal_not_found",
          message: "未检测到可用的桌面终端程序（gnome-terminal / konsole / kitty / xterm）",
        });
      }
      const chosen = availableTerm ?? terminalCandidates[0]!;
      await execFn(chosen.bin, chosen.makeArgs(scriptPath), {
        timeout: 10_000,
        encoding: "utf8",
      });
    } else {
      throw new ServerHttpError(400, {
        error: "unsupported_platform",
        message: `Platform "${platform}" is not supported for native TUI launch`,
      });
    }
  } catch (err) {
    if (err instanceof ServerHttpError) {
      throw err;
    }
    throw new ServerHttpError(500, {
      error: "tui_launch_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return OpenRunTuiResponseSchema.parse({
    ok: true,
    taskId: options.taskId,
    runDir: options.runDir,
    agent: resolved.agent,
    providerSessionId: resolved.providerSessionId,
    cwd,
    cwdFallback,
    commandPreview: resolved.commandPreview,
  });
}

export interface RunSessionInfo {
  backendId: string;
  sessionId: string;
  providerSessionId: string | null;
  providerSessionPath: string | null;
  displaySessionId: string | null;
  cwd: string | null;
  tuiSupported: boolean;
  tuiCommandPreview: string | null;
  tuiUnavailableReason: string | null;
}

export interface RunIoSummary {
  inputTitle: string;
  inputRef: string | null;
  outputVerdict: string;
  outputSummary: string;
  changedPaths: string[];
  gatePassed: boolean | null;
  totalTokens: number;
  costUsd: number;
}

export interface BuildRunOverviewInput {
  card: TaskCard;
  meta: RunMeta | null;
  receipt: string | null;
  gate: GateReport | null;
  events: readonly RunEvent[];
  usageTurns: readonly UsageTurnRow[];
  pricing: PricingConfig | null;
  dirName: string;
  activeRunId: string | null;
  taskStatus: TaskStatus;
  spaceRepoPath?: string;
}

function formatShortSessionId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length <= 14) {
    return trimmed;
  }
  const base = path.basename(trimmed).replace(/\.jsonl$/i, "");
  if (base.length <= 14) {
    return base;
  }
  return base.slice(0, 12);
}

function extractFirstMeaningfulSectionLine(body: string, headings: readonly string[]): string {
  for (const heading of headings) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingMatch = new RegExp(
      `^#{1,3}[ \\t]+${escaped}(?:[ \\t:(（][^\\r\\n]*)?(?=\\r?\\n|$)`,
      "m",
    ).exec(body);
    if (!headingMatch) continue;
    const after = body.slice(headingMatch.index + headingMatch[0].length);
    const nextHeading = /^#{1,3}[ \t]+/m.exec(after);
    const slice = (nextHeading ? after.slice(0, nextHeading.index) : after).trim();
    for (const rawLine of slice.split(/\r?\n/)) {
      const cleaned = rawLine.replace(/^[-*>\d.\s]+/, "").trim();
      if (cleaned.length > 0 && cleaned !== "无" && !/^<.*>$/.test(cleaned)) {
        return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
      }
    }
  }
  return "";
}

function isGateReportPassed(gate: GateReport): boolean {
  return (
    gate.schema_ok &&
    gate.scope_ok &&
    gate.artifacts_ok !== false &&
    gate.accept_exit_code === 0
  );
}

/**
 * Builds normalized `session` identity + compact `ioSummary` metadata for each run in `GET /api/tasks/:id`.
 */
export function buildRunOverviewSummary(input: BuildRunOverviewInput): {
  session: RunSessionInfo | null;
  ioSummary: RunIoSummary;
} {
  const { card, meta, receipt, gate, events, usageTurns, pricing, activeRunId, taskStatus } =
    input;

  let providerSessionId = meta?.session_ref.meta?.providerSessionId?.trim() || null;
  let providerSessionPath = meta?.session_ref.meta?.providerSessionPath?.trim() || null;

  if (!providerSessionId || !providerSessionPath) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.kind === "session_bound") {
        if (!providerSessionId) {
          providerSessionId = ev.providerSessionId;
        }
        if (!providerSessionPath && ev.providerSessionPath) {
          providerSessionPath = ev.providerSessionPath;
        }
        break;
      }
    }
  }

  let session: RunSessionInfo | null = null;
  if (meta) {
    const resolvedCmd = resolveNativeTuiCommand({
      agent: meta.agent,
      providerSessionId,
      providerSessionPath,
    });
    const displaySource = providerSessionId ?? providerSessionPath ?? meta.session_ref.sessionId;
    session = {
      backendId: meta.backend_id,
      sessionId: meta.session_ref.sessionId,
      providerSessionId,
      providerSessionPath,
      displaySessionId: displaySource ? formatShortSessionId(displaySource) : null,
      cwd: meta.cwd ?? input.spaceRepoPath ?? null,
      tuiSupported: resolvedCmd.ok,
      tuiCommandPreview: resolvedCmd.ok ? resolvedCmd.commandPreview : null,
      tuiUnavailableReason: resolvedCmd.ok ? null : resolvedCmd.message,
    };
  }

  const runUsageRows = meta ? usageTurns.filter((u) => u.run_id === meta.run_id) : [];
  const runUsage = computeUsageSnapshot(runUsageRows, pricing);
  const gatePassed = gate ? isGateReportPassed(gate) : null;
  const exitEv = [...events].reverse().find((e) => e.kind === "exit");
  const isActive =
    taskStatus === "running" && meta !== null && meta.run_id === activeRunId;

  let outputVerdict = "完成";
  let outputSummary = "";
  let changedPaths: string[] = [];

  if (receipt) {
    try {
      const parsed = parseFrontmatterMarkdown(receipt);
      const fm = parsed.frontmatter;
      if (Array.isArray(fm.changed_paths)) {
        changedPaths = Array.from(
          new Set(
            fm.changed_paths
              .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
              .map((p) => p.trim()),
          ),
        ).slice(0, 8);
      }

      const verdict = typeof fm.verdict === "string" ? fm.verdict : "";
      const outcome = typeof fm.outcome === "string" ? fm.outcome : "";
      const recommendation =
        typeof fm.recommendation === "string" ? fm.recommendation : "";
      const chosen = typeof fm.chosen_approach === "string" ? fm.chosen_approach : "";

      if (verdict === "changes_requested" || verdict === "fail") {
        outputVerdict = "退回";
      } else if (verdict === "pass") {
        outputVerdict = "通过";
      } else if (outcome === "need_decision") {
        outputVerdict = "待决策";
      } else if (outcome === "resolved") {
        outputVerdict = "已裁决";
      } else if (recommendation) {
        outputVerdict = recommendation;
      }

      outputSummary =
        chosen ||
        (typeof fm.summary === "string" ? fm.summary : "") ||
        extractFirstMeaningfulSectionLine(parsed.body, [
          "改动说明",
          "结论",
          "验收场景明细",
          "研判结论",
          "技术取舍",
          "未完成或待决问题",
        ]);
      if (!outputSummary && typeof fm.output_ref === "string") {
        outputSummary = `产出引用: ${fm.output_ref}`;
      }
    } catch {
      outputSummary = "已提交回执（Markdown）";
    }
  }

  if (gate && !gatePassed) {
    outputVerdict = "退回";
    const gateNote = !gate.schema_ok
      ? "回执 Schema/租约未过"
      : !gate.scope_ok
        ? `越界路径 ${gate.out_of_scope_paths.length} 项`
        : gate.artifacts_ok === false
          ? "缺失预期产出物"
          : `验收命令 exit ${gate.accept_exit_code}`;
    outputSummary = outputSummary ? `${gateNote} · ${outputSummary}` : gateNote;
  } else if (gatePassed === true && outputVerdict === "完成") {
    outputVerdict = "通过";
  }

  if (!outputSummary) {
    if (isActive) {
      outputVerdict = "进行中";
      outputSummary = "Agent 正在执行当前阶段…";
    } else if (exitEv?.kind === "exit" && exitEv.reason !== "completed") {
      outputVerdict = exitEv.reason === "failed" ? "失败" : "中断";
      outputSummary = exitEv.detail ?? `回合${outputVerdict}`;
    } else {
      outputSummary = "已完成本轮动作";
    }
  }

  return {
    session,
    ioSummary: {
      inputTitle: card.contract.goal,
      inputRef: meta?.input_ref ?? null,
      outputVerdict,
      outputSummary,
      changedPaths,
      gatePassed,
      totalTokens: runUsage.totalTokens,
      costUsd: runUsage.costUsd,
    },
  };
}
