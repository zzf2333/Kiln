import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type TaskCard } from "@kiln/protocol";
import { KilnStore } from "../../store/index.js";
import { generateAndWriteContextMap, parseContextMapHeader } from "../context-map.js";
import { buildHandoffPayload } from "../orchestrator-handoff.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initSampleGitRepo(repoDir: string): string {
  fs.mkdirSync(path.join(repoDir, "src", "core"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src", "web"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src", "core", "__tests__"), { recursive: true });

  fs.writeFileSync(
    path.join(repoDir, "src", "core", "calc.ts"),
    [
      "export function addValues(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export const DEFAULT_RATIO = 2;",
      "export interface CalcOptions { strict: boolean }",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "src", "core", "__tests__", "calc.test.ts"),
    ['import { addValues } from "../calc.js";', "export const ok = addValues(1, 2) === 3;"].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "src", "web", "widget.ts"),
    [
      'import { addValues } from "../core/calc.js";',
      "export function renderTotal(): number {",
      "  return addValues(4, 5);",
      "}",
    ].join("\n"),
    "utf8",
  );

  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@kiln.local"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Kiln Test"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
}

function makeSampleCard(spaceId = "sp-track7"): TaskCard {
  const now = "2026-11-26T00:00:00.000Z";
  return {
    schema_version: 1,
    id: "t-track7-ctx",
    space: spaceId,
    parent: null,
    title: "Track 7 context map task",
    priority: "P1",
    track: "L2",
    workspace_mode: "git_worktree",
    created_at: now,
    updated_at: now,
    contract_version: 1,
    depends_on: [],
    contract: {
      goal: "Add calculator feature",
      end: "Add calculator feature with tests",
      scope: ["src/core/**"],
      accept_cmd: "echo ok",
      accept_files_hash: "sha256:empty",
      human_accept: false,
      external_actions: "ask",
      deliver: { mode: "merge_main", cmd: null },
    },
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 250_000,
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Track 7 E3: on-demand CONTEXT_MAP.md & progressive disclosure pointer", () => {
  it("generates bounded 0-token CONTEXT_MAP.md with delta, exports, out-of-scope importers, and tests under 140ms & 24KB", async () => {
    const kilnHome = makeTempDir("kiln-e3-home-");
    const repoDir = makeTempDir("kiln-e3-repo-");
    const baseSha = initSampleGitRepo(repoDir);

    // Mutate an in-scope file so Active Delta shows changes
    fs.appendFileSync(
      path.join(repoDir, "src", "core", "calc.ts"),
      "\nexport function multiplyValues(a: number, b: number): number { return a * b; }\n",
      "utf8",
    );

    const store = new KilnStore({ kilnHome });
    const card = makeSampleCard();
    try {
      store.createTask(card, "# Goal\nAdd calculator feature");
      const outputPath = store.paths.contextMapMd(card.id);

      const res = await generateAndWriteContextMap({
        card,
        worktreePath: repoDir,
        outputPath,
        inputRef: baseSha,
      });

      expect(res.ok).toBe(true);
      expect(res.bytes).toBeLessThanOrEqual(24 * 1024);
      expect(res.elapsedMs).toBeLessThan(140);
      expect(res.scopeFiles).toBeGreaterThanOrEqual(2);
      expect(res.testFiles).toBeGreaterThanOrEqual(1);
      expect(res.outOfScopeImporters).toBeGreaterThanOrEqual(1);

      const md = fs.readFileSync(outputPath, "utf8");
      const parsedHeader = parseContextMapHeader(md);
      expect(parsedHeader).toEqual({
        scope: res.scopeFiles,
        tests: res.testFiles,
        importers: res.importerCount,
        oos: res.outOfScopeImporters,
      });
      expect(md).toContain("## 本轮已改符号与变更摘要 (Active Delta)");
      expect(md).toContain("multiplyValues");
      expect(md).toContain("## Scope 内导出骨架 (Export Skeleton)");
      expect(md).toContain("addValues");
      expect(md).toContain("## 反向引用与爆炸半径 (Reverse Importers)");
      expect(md).toContain("⚠️ [Scope 外引用方] `src/web/widget.ts`");
      expect(md).toContain("## 关联单测文件 (Co-located Tests)");
      expect(md).toContain("src/core/__tests__/calc.test.ts");

      // Verify HANDOFF.md injects only the concise 3-line pointer on non-accept stages,
      // and hides it on accept (black-box) stage.
      const implHandoff = buildHandoffPayload({
        store,
        card,
        stage: "implement",
        role: "worker",
        runId: "run-impl-e3",
        runDirName: "0001-implement-r1",
        round: 1,
        cwd: repoDir,
        mcpEnabled: true,
      });
      expect(implHandoff.fullMarkdown).toContain("## 代码地图索引 (CONTEXT_MAP.md 指针)");
      expect(implHandoff.fullMarkdown).toContain(outputPath);
      expect(implHandoff.fullMarkdown).not.toContain("⚠️ [Scope 外引用方]");

      const acceptHandoff = buildHandoffPayload({
        store,
        card,
        stage: "accept",
        role: "verifier",
        runId: "run-accept-e3",
        runDirName: "0002-accept-r1",
        round: 1,
        cwd: repoDir,
        mcpEnabled: true,
      });
      expect(acceptHandoff.fullMarkdown).not.toContain("CONTEXT_MAP.md 指针");
    } finally {
      store.close();
    }
  });
});
