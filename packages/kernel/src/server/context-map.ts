import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { TaskCard } from "@kiln/protocol";
import { buildSanitizedEnv, checkScope, normalizeRepoRelativePath } from "../gate/index.js";
import { writeFileAtomic } from "../store/index.js";
import { parseGitPorcelainStatusZ } from "./orchestrator-git.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CONTEXT_MAP_BUDGET_MS = 140;
const DEFAULT_CONTEXT_MAP_MAX_BYTES = 24 * 1024;
const MAX_SCOPE_FILES_ANALYZED = 48;
const MAX_IMPORTER_FILES_SCANNED = 400;
const MAX_FILE_READ_BYTES = 16 * 1024;
const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "release",
  ".next",
  "build",
  "coverage",
  ".turbo",
  ".cache",
]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".sqlite",
  ".db",
  ".bin",
  ".exe",
  ".dmg",
]);
const SOURCE_CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
]);
const TEST_FILE_PATTERN = /\.(test|spec)\.[^./]+$/i;
const TEST_DIR_PATTERN = /(^|\/)(__tests__|evals)\//;

export interface ContextMapHeaderCounts {
  scope: number;
  tests: number;
  importers: number;
  oos: number;
}

export interface ContextMapResult {
  ok: boolean;
  path: string;
  bytes: number;
  elapsedMs: number;
  scopeFiles: number;
  testFiles: number;
  importerCount: number;
  outOfScopeImporters: number;
  timedOut: boolean;
}

export function parseContextMapHeader(content: string): ContextMapHeaderCounts | null {
  const match =
    /<!--\s*kiln-context-map:\s*scope=(\d+)\s+tests=(\d+)\s+importers=(\d+)\s+oos=(\d+)\s*-->/.exec(
      content,
    );
  if (!match) {
    return null;
  }
  return {
    scope: Number(match[1]),
    tests: Number(match[2]),
    importers: Number(match[3]),
    oos: Number(match[4]),
  };
}

function isBinaryOrIgnoredPath(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.some((p) => SKIP_DIR_NAMES.has(p))) {
    return true;
  }
  const ext = path.posix.extname(relPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isSourceCodePath(relPath: string): boolean {
  const ext = path.posix.extname(relPath).toLowerCase();
  return SOURCE_CODE_EXTENSIONS.has(ext);
}

function isTestPath(relPath: string): boolean {
  return TEST_FILE_PATTERN.test(relPath) || TEST_DIR_PATTERN.test(relPath);
}

function stripCodeExtension(relPath: string): string {
  const ext = path.posix.extname(relPath);
  if (!ext || !SOURCE_CODE_EXTENSIONS.has(ext.toLowerCase())) {
    return relPath;
  }
  return relPath.slice(0, -ext.length);
}

async function runFastGitStdout(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      env: buildSanitizedEnv(),
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      timeout: Math.max(20, Math.floor(timeoutMs)),
    });
    return stdout;
  } catch {
    return null;
  }
}

function walkRepoFilesBounded(rootDir: string, deadlineMs: number, limit = 1500): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && out.length < limit && performance.now() < deadlineMs) {
    const relDir = stack.pop()!;
    const absDir = relDir ? path.join(rootDir, relDir) : rootDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.isFile()) {
        out.push(normalizeRepoRelativePath(rel));
        if (out.length >= limit) {
          break;
        }
      }
    }
  }
  return out;
}

function readHeadSnippet(absPath: string): string | null {
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.allocUnsafe(MAX_FILE_READ_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, MAX_FILE_READ_BYTES, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function extractExportSymbols(relPath: string, content: string): string[] {
  const ext = path.posix.extname(relPath).toLowerCase();
  const seen = new Set<string>();
  const symbols: string[] = [];
  const add = (label: string) => {
    if (!seen.has(label) && symbols.length < 16) {
      seen.add(label);
      symbols.push(label);
    }
  };

  if (ext === ".py") {
    const pyRe = /^(?:async\s+)?(def|class)\s+([A-Za-z0-9_]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = pyRe.exec(content)) !== null) {
      if (!m[2]!.startsWith("_")) {
        add(`${m[1]} ${m[2]}`);
      }
    }
    return symbols;
  }

  if (ext === ".go") {
    const goRe = /^(func(?:\s*\([^)]+\))?|type|var|const)\s+([A-Z][A-Za-z0-9_]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = goRe.exec(content)) !== null) {
      add(`${m[1]!.startsWith("func") ? "func" : m[1]} ${m[2]}`);
    }
    return symbols;
  }

  if (ext === ".rs") {
    const rsRe =
      /^pub(?:\([^)]+\))?\s+(?:async\s+)?(fn|struct|enum|trait|type|const|mod)\s+([A-Za-z0-9_]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = rsRe.exec(content)) !== null) {
      add(`${m[1]} ${m[2]}`);
    }
    return symbols;
  }

  const tsRe =
    /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|class|interface|type|const|let|enum)\s+([A-Za-z0-9_$]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = tsRe.exec(content)) !== null) {
    add(`${m[1]!.replace(/\*$/, "")} ${m[2]}`);
  }
  if (/^export\s+default\b/m.test(content)) {
    add("default");
  }
  return symbols;
}

function extractImportSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const esmRe = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"'`\n;]*?\bfrom\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = esmRe.exec(content)) !== null) {
    if (m[1]) specs.push(m[1]);
  }
  const cjsRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = cjsRe.exec(content)) !== null) {
    if (m[1]) specs.push(m[1]);
  }
  const pyRe = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/gm;
  while ((m = pyRe.exec(content)) !== null) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

function resolveImportTargets(importerRel: string, spec: string): string[] {
  const importerDir = path.posix.dirname(importerRel);
  if (spec.startsWith(".")) {
    const joined = normalizeRepoRelativePath(
      path.posix.normalize(importerDir === "." ? spec : `${importerDir}/${spec}`),
    );
    const stripped = stripCodeExtension(joined);
    return [joined, stripped, `${stripped}/index`];
  }
  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const sub = stripCodeExtension(spec.slice(2));
    return [sub, `src/${sub}`, `${sub}/index`, `src/${sub}/index`];
  }
  if (/^[A-Za-z0-9_.]+$/.test(spec) && spec.includes(".")) {
    const slash = spec.replace(/\./g, "/");
    return [slash, `${slash}/__init__`];
  }
  return [];
}

function findCoLocatedTests(allFiles: readonly string[], scopeFiles: readonly string[]): string[] {
  const scopeSet = new Set(scopeFiles);
  const scopeDirs = new Set(scopeFiles.map((f) => path.posix.dirname(f)));
  const scopeStems = new Set(
    scopeFiles
      .filter((f) => !isTestPath(f))
      .map((f) => path.posix.basename(stripCodeExtension(f)))
      .filter((stem) => stem.length >= 2 && stem !== "index"),
  );

  const matched = new Set<string>();
  for (const file of allFiles) {
    if (!isTestPath(file)) {
      continue;
    }
    if (scopeSet.has(file)) {
      matched.add(file);
      continue;
    }
    const dir = path.posix.dirname(file);
    const parentDir = path.posix.dirname(dir);
    if (
      scopeDirs.has(dir) ||
      (path.posix.basename(dir) === "__tests__" && scopeDirs.has(parentDir))
    ) {
      matched.add(file);
      continue;
    }
    const base = path.posix.basename(file).replace(/\.(test|spec)\.[^./]+$/i, "");
    if (scopeStems.has(base)) {
      matched.add(file);
    }
  }
  return Array.from(matched).sort().slice(0, 40);
}

function truncateUtf8ToMaxBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  const suffix = "\n\n_(上下文地图已按 24KB 上限截断)_\n";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const targetBytes = Math.max(0, maxBytes - suffixBytes);
  let slice = buf.subarray(0, targetBytes).toString("utf8");
  while (Buffer.byteLength(slice, "utf8") > targetBytes && slice.length > 0) {
    slice = slice.slice(0, -1);
  }
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > slice.length * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  return `${slice}${suffix}`;
}

export async function generateAndWriteContextMap(params: {
  card: Pick<TaskCard, "id" | "contract">;
  worktreePath: string;
  outputPath: string;
  inputRef?: string;
  budgetMs?: number;
  maxBytes?: number;
}): Promise<ContextMapResult> {
  const startMs = performance.now();
  const budgetMs = params.budgetMs ?? DEFAULT_CONTEXT_MAP_BUDGET_MS;
  const maxBytes = params.maxBytes ?? DEFAULT_CONTEXT_MAP_MAX_BYTES;
  const deadlineMs = startMs + budgetMs;

  let timedOut = false;
  const remainingMs = () => Math.max(0, deadlineMs - performance.now());

  let allRepoFiles: string[] = [];
  let deltaSet = new Set<string>();

  if (fs.existsSync(params.worktreePath)) {
    const gitTimeout = Math.min(80, Math.max(25, remainingMs() * 0.6));
    const [lsOut, statusOut, diffOut] = await Promise.all([
      runFastGitStdout(["ls-files", "-z"], params.worktreePath, gitTimeout),
      runFastGitStdout(["status", "--porcelain", "-z"], params.worktreePath, gitTimeout),
      params.inputRef
        ? runFastGitStdout(
            ["diff", "--name-only", "-z", `${params.inputRef}..HEAD`],
            params.worktreePath,
            gitTimeout,
          )
        : Promise.resolve(null),
    ]);

    const fileSet = new Set<string>();
    if (lsOut !== null) {
      for (const token of lsOut.split("\0")) {
        if (token.length > 0) {
          const norm = normalizeRepoRelativePath(token);
          if (!isBinaryOrIgnoredPath(norm)) {
            fileSet.add(norm);
          }
        }
      }
    } else {
      for (const walked of walkRepoFilesBounded(params.worktreePath, deadlineMs)) {
        if (!isBinaryOrIgnoredPath(walked)) {
          fileSet.add(walked);
        }
      }
    }

    if (statusOut !== null) {
      const parsed = parseGitPorcelainStatusZ(statusOut);
      for (const p of parsed.dirtyPaths) {
        if (!isBinaryOrIgnoredPath(p)) {
          deltaSet.add(p);
          if (fs.existsSync(path.join(params.worktreePath, p))) {
            fileSet.add(p);
          }
        }
      }
    }

    if (diffOut !== null) {
      for (const token of diffOut.split("\0")) {
        if (token.length > 0) {
          const norm = normalizeRepoRelativePath(token);
          if (!isBinaryOrIgnoredPath(norm)) {
            deltaSet.add(norm);
          }
        }
      }
    }

    allRepoFiles = Array.from(fileSet).sort();
  }

  const scopePatterns = params.card.contract.scope;
  const scopeFiles = (
    scopePatterns.length > 0
      ? allRepoFiles.filter((f) => checkScope([f], scopePatterns).ok)
      : allRepoFiles.slice(0, MAX_SCOPE_FILES_ANALYZED)
  ).slice(0, MAX_SCOPE_FILES_ANALYZED);

  const deltaFiles = Array.from(deltaSet).sort().slice(0, 30);
  const testFiles = findCoLocatedTests(allRepoFiles, scopeFiles);

  const deltaLines: string[] = [];
  for (const rel of deltaFiles) {
    if (performance.now() >= deadlineMs) {
      timedOut = true;
      break;
    }
    const content = isSourceCodePath(rel)
      ? readHeadSnippet(path.join(params.worktreePath, rel))
      : null;
    const symbols = content ? extractExportSymbols(rel, content) : [];
    deltaLines.push(symbols.length > 0 ? `- \`${rel}\`: ${symbols.join(", ")}` : `- \`${rel}\``);
  }

  const skeletonLines: string[] = [];
  for (const rel of scopeFiles) {
    if (performance.now() >= deadlineMs) {
      timedOut = true;
      break;
    }
    if (!isSourceCodePath(rel) || isTestPath(rel)) {
      continue;
    }
    const content = readHeadSnippet(path.join(params.worktreePath, rel));
    if (!content) {
      continue;
    }
    const symbols = extractExportSymbols(rel, content);
    if (symbols.length > 0) {
      skeletonLines.push(`- \`${rel}\`: ${symbols.join(", ")}`);
    } else {
      skeletonLines.push(`- \`${rel}\``);
    }
  }

  const scopeTargetKeys = new Map<string, string>();
  for (const scopeFile of scopeFiles) {
    const noExt = stripCodeExtension(scopeFile);
    scopeTargetKeys.set(scopeFile, scopeFile);
    scopeTargetKeys.set(noExt, scopeFile);
  }

  interface ImporterHit {
    importer: string;
    targets: string[];
    outOfScope: boolean;
  }
  const importerHits: ImporterHit[] = [];
  const candidateImporters = allRepoFiles.filter((f) => isSourceCodePath(f));
  let scannedCount = 0;

  for (const candidate of candidateImporters) {
    if (scannedCount >= MAX_IMPORTER_FILES_SCANNED || performance.now() >= deadlineMs) {
      if (performance.now() >= deadlineMs) {
        timedOut = true;
      }
      break;
    }
    scannedCount += 1;
    const content = readHeadSnippet(path.join(params.worktreePath, candidate));
    if (!content) {
      continue;
    }
    const specs = extractImportSpecifiers(content);
    if (specs.length === 0) {
      continue;
    }
    const hitTargets = new Set<string>();
    for (const spec of specs) {
      for (const resolvedKey of resolveImportTargets(candidate, spec)) {
        const target = scopeTargetKeys.get(resolvedKey);
        if (target && target !== candidate) {
          hitTargets.add(target);
        }
      }
    }
    if (hitTargets.size > 0) {
      const outOfScope =
        scopePatterns.length > 0 ? !checkScope([candidate], scopePatterns).ok : false;
      importerHits.push({
        importer: candidate,
        targets: Array.from(hitTargets).sort(),
        outOfScope,
      });
    }
  }

  importerHits.sort((a, b) => {
    if (a.outOfScope !== b.outOfScope) {
      return a.outOfScope ? -1 : 1;
    }
    return a.importer.localeCompare(b.importer);
  });

  const outOfScopeCount = importerHits.filter((h) => h.outOfScope).length;
  const header = `<!-- kiln-context-map: scope=${scopeFiles.length} tests=${testFiles.length} importers=${importerHits.length} oos=${outOfScopeCount} -->`;
  const lines: string[] = [
    header,
    `# CONTEXT_MAP (${params.card.id})`,
    "",
    "## 本轮已改符号与变更摘要 (Active Delta)",
    ...(deltaLines.length > 0 ? deltaLines : ["- （尚无新增代码变更）"]),
    "",
    "## Scope 内导出骨架 (Export Skeleton)",
    ...(skeletonLines.length > 0 ? skeletonLines : ["- （Scope 内暂无可解析导出符号）"]),
    "",
    "## 反向引用与爆炸半径 (Reverse Importers)",
    ...(importerHits.length > 0
      ? importerHits
          .slice(0, 60)
          .map((hit) =>
            hit.outOfScope
              ? `- ⚠️ [Scope 外引用方] \`${hit.importer}\` -> ${hit.targets.map((t) => `\`${t}\``).join(", ")}`
              : `- \`${hit.importer}\` -> ${hit.targets.map((t) => `\`${t}\``).join(", ")}`,
          )
      : ["- （未检测到静态反向引用）"]),
    "",
    "## 关联单测文件 (Co-located Tests)",
    ...(testFiles.length > 0 ? testFiles.map((t) => `- \`${t}\``) : ["- （未命中同位置关联单测）"]),
    "",
  ];

  const finalMarkdown = truncateUtf8ToMaxBytes(lines.join("\n"), maxBytes);
  writeFileAtomic(params.outputPath, finalMarkdown);
  const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100;
  return {
    ok: true,
    path: params.outputPath,
    bytes: Buffer.byteLength(finalMarkdown, "utf8"),
    elapsedMs,
    scopeFiles: scopeFiles.length,
    testFiles: testFiles.length,
    importerCount: importerHits.length,
    outOfScopeImporters: outOfScopeCount,
    timedOut,
  };
}
