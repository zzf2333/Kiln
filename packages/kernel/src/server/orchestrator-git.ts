import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { TaskCard } from "@kiln/protocol";
import { buildSanitizedEnv, checkScope, normalizeRepoRelativePath } from "../gate/index.js";

const execFileAsync = promisify(execFile);

export interface ParsedPorcelainStatus {
  dirtyPaths: string[];
  pathsToStage: string[];
}

export async function runGitCommand(args: readonly string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: buildSanitizedEnv(),
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

export function parseGitPorcelainStatusZ(raw: string): ParsedPorcelainStatus {
  const dirtySet = new Set<string>();
  const stageSet = new Set<string>();
  const tokens = raw.split("\0");
  let idx = 0;

  while (idx < tokens.length) {
    const token = tokens[idx];
    idx++;
    if (!token || token.length < 4) {
      continue;
    }

    const xy = token.slice(0, 2);
    const filePath = normalizeRepoRelativePath(token.slice(3));
    dirtySet.add(filePath);

    if (xy === "??" || xy[1] !== " ") {
      stageSet.add(filePath);
    }

    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const origPath = tokens[idx];
      idx++;
      if (origPath && origPath.length > 0) {
        dirtySet.add(normalizeRepoRelativePath(origPath));
      }
    }
  }

  return {
    dirtyPaths: Array.from(dirtySet).sort(),
    pathsToStage: Array.from(stageSet).sort(),
  };
}

export function collectRelativeFiles(dir: string, relPrefix = ""): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRelativeFiles(full, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

export async function computeWorktreeDirtySignature(worktreePath: string): Promise<string> {
  if (!fs.existsSync(worktreePath)) {
    return "missing";
  }
  try {
    let head = "no_head";
    try {
      head = (await runGitCommand(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
    } catch {
      head = "no_head";
    }
    const raw = await runGitCommand([
      "-C",
      worktreePath,
      "status",
      "--porcelain=v1",
      "-z",
      "-uall",
    ]);
    if (raw.length === 0) {
      return `clean:${head}`;
    }
    const parsed = parseGitPorcelainStatusZ(raw);
    const hash = createHash("sha256");
    hash.update(head);
    hash.update("\0");
    hash.update(raw);
    for (const relPath of parsed.dirtyPaths) {
      hash.update("\0");
      hash.update(relPath);
      hash.update("\0");
      const absPath = path.join(worktreePath, relPath);
      try {
        const stat = fs.lstatSync(absPath);
        if (stat.isSymbolicLink()) {
          hash.update(`sym:${fs.readlinkSync(absPath)}`);
        } else if (stat.isFile()) {
          hash.update(fs.readFileSync(absPath));
        } else {
          hash.update("dir");
        }
      } catch {
        hash.update("deleted");
      }
    }
    return `dirty:${hash.digest("hex")}`;
  } catch {
    return "git_error";
  }
}

export async function commitVerifiedWorktreeChanges(
  card: TaskCard,
  worktreePath: string,
  round: number,
): Promise<void> {
  const statusRaw = await runGitCommand([
    "-C",
    worktreePath,
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
  ]);
  if (statusRaw.length === 0) {
    return;
  }

  let parsed: ParsedPorcelainStatus;
  try {
    parsed = parseGitPorcelainStatusZ(statusRaw);
  } catch {
    return;
  }
  if (parsed.dirtyPaths.length === 0) {
    return;
  }

  // Re-verify all dirty/untracked paths remain strictly within contract scope before committing.
  const scopeCheck = checkScope(parsed.dirtyPaths, card.contract.scope);
  if (!scopeCheck.ok) {
    return;
  }

  if (parsed.pathsToStage.length > 0) {
    await runGitCommand(["-C", worktreePath, "add", "--", ...parsed.pathsToStage]);
  }

  const stagedRaw = await runGitCommand([
    "-C",
    worktreePath,
    "diff",
    "--cached",
    "--name-only",
    "-z",
  ]);
  if (stagedRaw.length === 0) {
    return;
  }

  const userName = (
    await runGitCommand(["-C", worktreePath, "config", "user.name"]).catch(() => "")
  ).trim();
  const userEmail = (
    await runGitCommand(["-C", worktreePath, "config", "user.email"]).catch(() => "")
  ).trim();

  const commitArgs = ["-C", worktreePath];
  if (!userName) {
    commitArgs.push("-c", "user.name=Kiln");
  }
  if (!userEmail) {
    commitArgs.push("-c", "user.email=kiln@local");
  }
  const cleanTitle = card.title.replace(/[\r\n]+/g, " ").trim();
  commitArgs.push("commit", "-m", `kiln(${card.id}): ${cleanTitle} (round ${round})`);
  await runGitCommand(commitArgs);
}
