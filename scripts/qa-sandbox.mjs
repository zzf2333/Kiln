import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const CLI_BIN_PATH = path.join(ROOT_DIR, "packages", "cli", "dist", "bin.js");
const KERNEL_PUBLIC_INDEX = path.join(ROOT_DIR, "packages", "kernel", "public", "index.html");
const DESKTOP_MAIN_PATH = path.join(ROOT_DIR, "apps", "desktop", "dist", "main.js");
const PNPM_CMD = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function defaultRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `qa-${date}-${time}`;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/qa-sandbox.mjs [options]",
      "",
      "Options:",
      "  --mode <desktop|web|prepare>  Sandbox mode (default: desktop)",
      "  --run-id <id>                 QA run identifier (default: qa-YYYYMMDD-HHMMSS)",
      "  --port <port>                 Preferred kilnd port (default: 4390, auto-increments if busy)",
      "  --root <dir>                  Sandbox root directory (default: /tmp/kiln-qa/<runId>)",
      "  -h, --help                    Show this help message",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  let mode = "desktop";
  let runId = defaultRunId();
  let preferredPort = 4390;
  let customRoot = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      mode = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else if (arg === "--run-id") {
      runId = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--run-id=")) {
      runId = arg.slice("--run-id=".length);
    } else if (arg === "--port") {
      preferredPort = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      preferredPort = Number(arg.slice("--port=".length));
    } else if (arg === "--root") {
      customRoot = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--root=")) {
      customRoot = arg.slice("--root=".length);
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (mode !== "desktop" && mode !== "web" && mode !== "prepare") {
    throw new Error(`Invalid --mode "${mode}" (expected "desktop", "web", or "prepare")`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error(`Invalid --run-id "${runId}" (allowed: [a-zA-Z0-9._-])`);
  }
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
    throw new Error(`Invalid --port "${preferredPort}"`);
  }

  const sandboxRoot = customRoot ? path.resolve(customRoot) : path.join("/tmp", "kiln-qa", runId);

  return { mode, runId, preferredPort, sandboxRoot };
}

function runCommandSync(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && cmd === PNPM_CMD,
  });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(
      `Command "${cmd} ${args.join(" ")}" failed (${res.status ?? 1})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (res.stdout || "").trim();
}

function getRepoCommit() {
  try {
    return runCommandSync("git", ["rev-parse", "--short", "HEAD"], ROOT_DIR);
  } catch {
    return "unknown";
  }
}

function ensureBuildArtifacts(mode) {
  const needsDesktop = mode === "desktop";
  const missing =
    !fs.existsSync(CLI_BIN_PATH) ||
    !fs.existsSync(KERNEL_PUBLIC_INDEX) ||
    (needsDesktop && !fs.existsSync(DESKTOP_MAIN_PATH));

  if (!missing) return;

  process.stdout.write("[qa-sandbox] Build artifacts missing; running pnpm build...\n");
  const res = spawnSync(PNPM_CMD, ["build"], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    throw new Error(`pnpm build exited with code ${res.status ?? 1}`);
  }
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort, maxAttempts = 40) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    if (candidate <= 65535 && (await isPortAvailable(candidate))) {
      return candidate;
    }
  }
  throw new Error(`No free port found near 127.0.0.1:${startPort}`);
}

async function isHttpOk(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHttpOk(url, timeoutMs, proc, name) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) {
      throw new Error(`${name} exited early with code ${proc.exitCode}`);
    }
    if (await isHttpOk(url, 1500)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${name} at ${url}`);
}

function ensureFixtureRepo(fixtureRepoDir) {
  if (fs.existsSync(path.join(fixtureRepoDir, ".git"))) {
    return;
  }

  fs.mkdirSync(path.join(fixtureRepoDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRepoDir, "test"), { recursive: true });

  fs.writeFileSync(
    path.join(fixtureRepoDir, "package.json"),
    `${JSON.stringify(
      {
        name: "kiln-qa-fixture",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          test: "node --test test/*.test.mjs",
          start: "node src/server.mjs",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const mathMain = [
    "export function add(a, b) {",
    "  return a + b;",
    "}",
    "",
    "export function clamp(value, min, max) {",
    "  if (min > max) {",
    '    throw new RangeError("min must be <= max");',
    "  }",
    "  return Math.min(Math.max(value, min), max);",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(fixtureRepoDir, "src", "math.mjs"), mathMain, "utf8");

  const mathTest = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add, clamp } from "../src/math.mjs";',
    "",
    'test("add adds two numbers", () => {',
    "  assert.equal(add(2, 3), 5);",
    "  assert.equal(add(-1, 4), 3);",
    "});",
    "",
    'test("clamp restricts value within [min, max]", () => {',
    "  assert.equal(clamp(5, 0, 10), 5);",
    "  assert.equal(clamp(-3, 0, 10), 0);",
    "  assert.equal(clamp(20, 0, 10), 10);",
    "});",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(fixtureRepoDir, "test", "math.test.mjs"), mathTest, "utf8");

  const serverSource = [
    'import http from "node:http";',
    "",
    "const port = Number(process.env.PORT) || 3000;",
    "const items = [",
    '  { id: 1, name: "alpha", status: "ready" },',
    '  { id: 2, name: "beta", status: "queued" },',
    "];",
    "",
    "const server = http.createServer((req, res) => {",
    '  const url = (req.url || "/").split("?")[0];',
    '  if (url === "/health") {',
    '    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });',
    "    res.end(JSON.stringify({ ok: true }));",
    "    return;",
    "  }",
    '  if (url === "/api/items") {',
    '    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });',
    "    res.end(JSON.stringify(items));",
    "    return;",
    "  }",
    '  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });',
    "  res.end(",
    '    "<!doctype html><html><head><title>Kiln QA Fixture</title></head>" +',
    '      "<body><h1>Kiln QA Fixture</h1><p>Status: OK</p></body></html>",',
    "  );",
    "});",
    "",
    'server.listen(port, "127.0.0.1", () => {',
    "  process.stdout.write(`fixture server listening on http://127.0.0.1:${port}\\n`);",
    "});",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(fixtureRepoDir, "src", "server.mjs"), serverSource, "utf8");

  const readme = [
    "# Kiln QA Fixture Repo",
    "",
    "Isolated toy repository generated by `scripts/qa-sandbox.mjs` for real-machine QA.",
    "",
    "- `npm test`: run `node --test test/*.test.mjs`",
    "- `npm start`: start `src/server.mjs` on `PORT || 3000`",
    "- Branch `conflict-demo`: modifies `src/math.mjs` line 2 for merge-conflict testing",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(fixtureRepoDir, "README.md"), readme, "utf8");

  runCommandSync("git", ["init", "-b", "main"], fixtureRepoDir);
  runCommandSync("git", ["config", "user.name", "Kiln QA"], fixtureRepoDir);
  runCommandSync("git", ["config", "user.email", "qa@kiln.local"], fixtureRepoDir);
  runCommandSync("git", ["add", "."], fixtureRepoDir);
  runCommandSync("git", ["commit", "-m", "chore: initial qa fixture baseline"], fixtureRepoDir);

  // Prepare conflict-demo branch modifying the same line in src/math.mjs, then switch back to main
  runCommandSync("git", ["checkout", "-b", "conflict-demo"], fixtureRepoDir);
  const mathConflict = mathMain.replace("  return a + b;", "  return Number(a) + Number(b);");
  fs.writeFileSync(path.join(fixtureRepoDir, "src", "math.mjs"), mathConflict, "utf8");
  runCommandSync("git", ["add", "src/math.mjs"], fixtureRepoDir);
  runCommandSync(
    "git",
    ["commit", "-m", "feat: coerce add operands on conflict-demo"],
    fixtureRepoDir,
  );
  runCommandSync("git", ["checkout", "main"], fixtureRepoDir);
}

function ensureReportSkeleton(meta) {
  fs.mkdirSync(path.join(meta.reportDir, "issues"), { recursive: true });
  fs.mkdirSync(path.join(meta.reportDir, "screenshots"), { recursive: true });

  const summaryPath = path.join(meta.reportDir, "SUMMARY.md");
  if (fs.existsSync(summaryPath)) return;

  const content = [
    `# Kiln 实机 QA 测试报告：${meta.runId}`,
    "",
    `- **Git Commit**: \`${meta.gitCommit}\``,
    `- **运行模式**: \`${meta.mode}\``,
    `- **Kilnd URL**: \`${meta.kilndUrl}\``,
    `- **KILN_HOME**: \`${meta.kilnHome}\``,
    `- **Fixture Repo**: \`${meta.fixtureRepoDir}\``,
    `- **Artifacts Dir**: \`${meta.artifactsDir}\``,
    `- **创建时间**: ${meta.createdAt}`,
    "",
    "## 剧本执行清单",
    "",
    "| 剧本 | 状态 | 发现问题数 | 备注 |",
    "| :--- | :--- | :--- | :--- |",
    "| M1 · 桌面壳与初始化配置 | 待测 | 0 | |",
    "| M2 · 立项到自动交付闭环 | 待测 | 0 | |",
    "",
    "## 缺陷草稿清单",
    "",
    "<!-- 每发现一个确认缺陷，在 issues/ 下按 ISSUE_TEMPLATE.md 新增文件并在此索引 -->",
    "",
    "## 疑似设计行为 / 待确认项",
    "",
    "<!-- 不确定是否为 Bug 的现象记在此处，不直接建缺陷单 -->",
    "",
  ].join("\n");
  fs.writeFileSync(summaryPath, content, "utf8");
}

function spawnWithLog(cmd, args, options, logPath, prefix) {
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(cmd, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const forward = (chunk, target) => {
    logStream.write(chunk);
    const text = chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (i === lines.length - 1 && line === "") continue;
      target.write(`[${prefix}] ${line}\n`);
    }
  };

  child.stdout?.on("data", (chunk) => forward(chunk, process.stdout));
  child.stderr?.on("data", (chunk) => forward(chunk, process.stderr));
  child.once("close", () => {
    logStream.end();
  });

  return child;
}

function terminateChild(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function main() {
  const { mode, runId, preferredPort, sandboxRoot } = parseArgs(process.argv.slice(2));
  const kilnHome = path.join(sandboxRoot, "kiln-home");
  const electronUserDataDir = path.join(sandboxRoot, "electron-user-data");
  const artifactsDir = path.join(sandboxRoot, "artifacts");
  const fixtureRepoDir = path.join(sandboxRoot, "fixture-repo");
  const reportDir = path.join(ROOT_DIR, "docs", "qa", "reports", runId);

  fs.mkdirSync(kilnHome, { recursive: true });
  fs.mkdirSync(electronUserDataDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  ensureFixtureRepo(fixtureRepoDir);

  const kilndPort = mode === "prepare" ? preferredPort : await findAvailablePort(preferredPort);
  const kilndUrl = `http://127.0.0.1:${kilndPort}`;
  const gitCommit = getRepoCommit();

  const meta = {
    runId,
    mode,
    gitCommit,
    kilnHome,
    kilndPort,
    kilndUrl,
    electronUserDataDir,
    fixtureRepoDir,
    artifactsDir,
    reportDir,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(artifactsDir, "sandbox-meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
  ensureReportSkeleton(meta);

  if (mode === "prepare") {
    process.stdout.write(
      [
        "[qa-sandbox] Prepared isolated QA sandbox (prepare mode):",
        `  runId:           ${runId}`,
        `  gitCommit:       ${gitCommit}`,
        `  kilnHome:        ${kilnHome}`,
        `  fixtureRepoDir:  ${fixtureRepoDir}`,
        `  artifactsDir:    ${artifactsDir}`,
        `  reportDir:       ${reportDir}`,
        `  metaFile:        ${path.join(artifactsDir, "sandbox-meta.json")}`,
        "",
      ].join("\n"),
    );
    return;
  }

  ensureBuildArtifacts(mode);

  const managedChildren = [];
  let shuttingDown = false;

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\n[qa-sandbox] Stopping managed processes...\n");
    await Promise.all(managedChildren.reverse().map((child) => terminateChild(child)));
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  const childBaseEnv = { ...process.env };
  delete childBaseEnv.KILN_UI_DEV_URL;

  const kilndLogPath = path.join(artifactsDir, "kilnd.log");
  const kilndChild = spawnWithLog(
    process.execPath,
    [CLI_BIN_PATH, "up", "--port", String(kilndPort), "--foreground", "--kiln-home", kilnHome],
    {
      cwd: ROOT_DIR,
      env: {
        ...childBaseEnv,
        KILN_HOME: kilnHome,
      },
    },
    kilndLogPath,
    "kilnd",
  );
  managedChildren.push(kilndChild);
  kilndChild.on("exit", (code) => {
    if (!shuttingDown) {
      void shutdown(code ?? 1);
    }
  });

  await waitForHttpOk(`${kilndUrl}/api/health`, 30_000, kilndChild, "kilnd");

  process.stdout.write(
    [
      "",
      "============================================================",
      `Kiln QA Sandbox Ready (${mode})`,
      `  runId:           ${runId}`,
      `  gitCommit:       ${gitCommit}`,
      `  kilndUrl:        ${kilndUrl}`,
      `  kilnHome:        ${kilnHome}`,
      `  fixtureRepoDir:  ${fixtureRepoDir}`,
      `  artifactsDir:    ${artifactsDir}`,
      `  reportDir:       ${reportDir}`,
      `  metaFile:        ${path.join(artifactsDir, "sandbox-meta.json")}`,
      "  stop:            Press Ctrl+C in this terminal",
      "============================================================",
      "",
    ].join("\n"),
  );

  if (mode === "desktop") {
    const electronLogPath = path.join(artifactsDir, "electron.log");
    const electronChild = spawnWithLog(
      PNPM_CMD,
      [
        "--filter",
        "@kiln/desktop",
        "exec",
        "electron",
        ".",
        `--user-data-dir=${electronUserDataDir}`,
      ],
      {
        cwd: ROOT_DIR,
        shell: process.platform === "win32",
        env: {
          ...childBaseEnv,
          KILN_HOME: kilnHome,
          KILND_URL: kilndUrl,
          KILN_BIN: CLI_BIN_PATH,
        },
      },
      electronLogPath,
      "electron",
    );
    managedChildren.push(electronChild);
    electronChild.on("exit", (code) => {
      if (!shuttingDown) {
        void shutdown(code ?? 0);
      }
    });
  }
}

main().catch((err) => {
  process.stderr.write(`[qa-sandbox] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
