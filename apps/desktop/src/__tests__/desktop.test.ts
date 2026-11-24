import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildKilnChildEnv,
  collectVersionedNodeBins,
  installPosixCliWrappers,
  installWindowsCliShims,
  resolveBundledRuntimeCliPath,
  resolveKilnInvocationForPlatform,
} from "../daemon-client.js";
import {
  DEFAULT_KILND_URL,
  MAIN_WINDOW_LABEL,
  UrlValidationError,
  applyStartAction,
  buildChildCommandPathDirs,
  buildWorkbenchUrl,
  closePolicyForWindow,
  decideStartupWindowAction,
  endpointUrl,
  formatEngineSubmenuLabel,
  formatInboxMenuLabel,
  formatInstallCliMenuLabel,
  formatStartMenuLabel,
  formatTrayHeader,
  formatTrayMenuStatus,
  formatTrayTitle,
  formatTrayTooltip,
  formatTrayTooltipWithVersion,
  formatTrayVersionTag,
  isAllowedKilndUrl,
  isAllowedNavigationUrl,
  isStartMenuEnabled,
  isTrayStateOnline,
  parseBootstrapSummaryJson,
  parseHealthJson,
  parseSemverKey,
  parseSseEventBlock,
  pathContainsDir,
  renderPosixCliWrapper,
  renderWindowsCliShim,
  shouldPreventExit,
  summarizeStartError,
  trayStateFromBootstrap,
  trayStateFromProbe,
  validateKilndUrl,
} from "../model.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kiln-desktop-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("@kiln/desktop Electron core model & daemon client", () => {
  it("validates allowed loopback URLs and normalizes them", () => {
    const u1 = validateKilndUrl(DEFAULT_KILND_URL);
    expect(u1.host).toBe("127.0.0.1");
    expect(u1.port).toBe(4310);
    expect(u1.baseUrl).toBe("http://127.0.0.1:4310");
    expect(endpointUrl(u1, "/api/health")).toBe("http://127.0.0.1:4310/api/health");
    expect(endpointUrl(u1, "api/bootstrap")).toBe("http://127.0.0.1:4310/api/bootstrap");
    expect(u1.hostHeader).toBe("127.0.0.1:4310");

    const u2 = validateKilndUrl("HTTP://LocalHost:4310/");
    expect(u2.host).toBe("localhost");
    expect(u2.port).toBe(4310);
    expect(u2.baseUrl).toBe("http://localhost:4310");

    const u3 = validateKilndUrl("http://127.0.0.1");
    expect(u3.port).toBe(80);
    expect(u3.baseUrl).toBe("http://127.0.0.1");

    const u4 = validateKilndUrl("http://localhost:65535");
    expect(u4.port).toBe(65535);
    expect(isAllowedKilndUrl("http://localhost:1")).toBe(true);
  });

  it("rejects non-loopback schemes, userinfo, and bad ports", () => {
    const cases: Array<[string, string]> = [
      ["", "Empty"],
      ["   ", "ControlOrWhitespace"],
      ["http://127.0.0.1:4310\n", "ControlOrWhitespace"],
      ["https://127.0.0.1:4310", "UnsupportedScheme"],
      ["file:///etc/passwd", "UnsupportedScheme"],
      ["javascript:alert(1)", "UnsupportedScheme"],
      ["127.0.0.1:4310", "UnsupportedScheme"],
      ["http://user@127.0.0.1:4310", "UserinfoNotAllowed"],
      ["http://127.0.0.1:4310@evil.com", "UserinfoNotAllowed"],
      ["http://localhost.evil.com:4310", "NonLoopbackHost"],
      ["http://127.0.0.2:4310", "NonLoopbackHost"],
      ["http://0.0.0.0:4310", "NonLoopbackHost"],
      ["http://[::1]:4310", "NonLoopbackHost"],
      ["http://127.0.0.1:0", "InvalidPort"],
      ["http://127.0.0.1:65536", "InvalidPort"],
      ["http://127.0.0.1:abc", "InvalidPort"],
      ["http://127.0.0.1:", "InvalidPort"],
      ["http://127.0.0.1:4310/tasks", "UnexpectedPathOrSuffix"],
      ["http://127.0.0.1:4310?next=evil", "UnexpectedPathOrSuffix"],
      ["http://127.0.0.1:4310\\@evil.com", "InvalidAuthority"],
    ];

    for (const [raw, code] of cases) {
      expect(() => validateKilndUrl(raw)).toThrowError(UrlValidationError);
      try {
        validateKilndUrl(raw);
      } catch (err) {
        expect((err as UrlValidationError).code).toBe(code);
      }
      expect(isAllowedKilndUrl(raw)).toBe(false);
    }
  });

  it("navigation guard enforces exact loopback origin", () => {
    const origin = validateKilndUrl("http://127.0.0.1:4310");
    expect(isAllowedNavigationUrl("http://127.0.0.1:4310", origin)).toBe(true);
    expect(isAllowedNavigationUrl("http://127.0.0.1:4310/tasks/t-1?view=board#top", origin)).toBe(
      true,
    );
    expect(isAllowedNavigationUrl("http://127.0.0.1:9999/", origin)).toBe(false);
    expect(isAllowedNavigationUrl("http://localhost:4310/", origin)).toBe(false);
    expect(isAllowedNavigationUrl("https://127.0.0.1:4310/", origin)).toBe(false);
    expect(isAllowedNavigationUrl("http://127.0.0.1:4310\\@evil.com", origin)).toBe(false);
    expect(isAllowedNavigationUrl("http://localhost.evil.com:4310/", origin)).toBe(false);
    expect(isAllowedNavigationUrl("javascript:alert(1)", origin)).toBe(false);
  });

  it("builds safe loopback workbench URLs for all routes", () => {
    const origin = validateKilndUrl("http://127.0.0.1:4310");
    expect(buildWorkbenchUrl(origin, null)).toBe("http://127.0.0.1:4310");
    expect(buildWorkbenchUrl(origin, "board")).toBe("http://127.0.0.1:4310/#view=board");
    expect(buildWorkbenchUrl(origin, "intake")).toBe("http://127.0.0.1:4310/#view=intake");
    expect(buildWorkbenchUrl(origin, "inbox")).toBe("http://127.0.0.1:4310/#view=inbox");
    expect(buildWorkbenchUrl(origin, "lineup")).toBe("http://127.0.0.1:4310/#view=lineup");
    expect(buildWorkbenchUrl(origin, "ledger")).toBe("http://127.0.0.1:4310/#view=ledger");
    expect(buildWorkbenchUrl(origin, "usage")).toBe("http://127.0.0.1:4310/#view=usage");
    expect(buildWorkbenchUrl(origin, "settings")).toBe("http://127.0.0.1:4310/#view=settings");
  });

  it("parses health & bootstrap JSON and rejects malformed payloads", () => {
    expect(parseHealthJson('{"ok":true,"pid":4242,"version":"0.1.0"}')).toEqual({
      ok: true,
      pid: 4242,
      version: "0.1.0",
    });
    expect(parseHealthJson('{"ok":false,"pid":null,"version":null}')).toEqual({
      ok: false,
      pid: null,
      version: null,
    });
    expect(() => parseHealthJson("{}")).toThrow();
    expect(() => parseHealthJson('{"ok":"yes"}')).toThrow();
    expect(() => parseHealthJson('{"ok":true,"pid":-1}')).toThrow();
    expect(() => parseHealthJson("[]")).toThrow();

    const summary = parseBootstrapSummaryJson(
      JSON.stringify({
        tasks: [{ id: "t-1" }, { id: "t-2" }],
        pendingDecisions: [{ id: "dec-1" }],
        liveRates: { totals: { costUsd: 1.25, tokPerSec: 48.75 } },
        runningCount: 2,
      }),
    );
    expect(summary).toEqual({
      runningCount: 2,
      pendingDecisionCount: 1,
      taskCount: 2,
      totals: { costUsd: 1.25, tokPerSec: 48.75 },
    });

    const deep = "[".repeat(130) + "]".repeat(130);
    expect(() => parseBootstrapSummaryJson(deep)).toThrow(/depth/i);
  });

  it("parses SSE event blocks with comments, ids, and multiline data", () => {
    expect(parseSseEventBlock(": heartbeat\n\n")).toBeNull();
    expect(parseSseEventBlock("id: 7\nevent: ping\n")).toBeNull();
    expect(
      parseSseEventBlock(
        ': keepalive\r\nid: 42\r\nevent: task.updated\r\ndata: {"id":"t-1",\r\ndata:  "status":"running"}\r\nretry: 3000\r\n',
      ),
    ).toEqual({
      id: "42",
      event: "task.updated",
      data: '{"id":"t-1",\n "status":"running"}',
    });
  });

  it("formats tray states, versions, and window policies", () => {
    expect(closePolicyForWindow(MAIN_WINDOW_LABEL)).toBe("destroy");
    expect(decideStartupWindowAction(true)).toBe("open_immediately");
    expect(decideStartupWindowAction(false)).toBe("auto_start_then_open");
    expect(shouldPreventExit(null, false)).toBe(true);
    expect(shouldPreventExit(null, true)).toBe(false);
    expect(shouldPreventExit(0, false)).toBe(false);

    const offline = trayStateFromProbe({ ok: false, reason: "connection refused" }, null);
    expect(isTrayStateOnline(offline)).toBe(false);
    expect(formatTrayTitle(offline)).toBe("离线");
    expect(formatTrayTooltip(offline, DEFAULT_KILND_URL)).toContain("connection refused");
    expect(formatTrayMenuStatus(offline)).toBe("后台引擎未运行");
    expect(formatInboxMenuLabel(offline)).toBe("等你决定");
    expect(formatEngineSubmenuLabel(offline)).toBe("后台引擎（未运行）");
    expect(isStartMenuEnabled(offline)).toBe(true);

    const starting = applyStartAction(offline, { kind: "starting" });
    expect(formatTrayTitle(starting)).toBe("启动中…");
    expect(formatStartMenuLabel(starting)).toBe("正在启动 kilnd…");
    expect(isStartMenuEnabled(starting)).toBe(false);

    const failed = applyStartAction(offline, {
      kind: "failed",
      error: "unable to locate `kiln` CLI binary",
    });
    expect(formatTrayTitle(failed)).toBe("启动失败");
    expect(formatStartMenuLabel(failed)).toBe("重试启动 kilnd");
    expect(formatTrayMenuStatus(failed)).toContain("未找到 kiln CLI");

    const running = trayStateFromBootstrap({
      runningCount: 2,
      pendingDecisionCount: 0,
      taskCount: 5,
      totals: { costUsd: 1.5, tokPerSec: 48.4 },
    });
    expect(formatTrayTitle(running)).toBe("2 运行 · 48 tok/s");
    expect(formatTrayMenuStatus(running)).toBe("运行中 · 2 个任务 · 48 tok/s · $1.50");

    const waiting = trayStateFromBootstrap({
      runningCount: 1,
      pendingDecisionCount: 2,
      taskCount: 5,
      totals: { costUsd: 2.1, tokPerSec: 15.0 },
    });
    expect(formatTrayTitle(waiting)).toBe("2 待决 · 1 运行");
    expect(formatInboxMenuLabel(waiting)).toBe("等你决定（2）");

    expect(formatTrayVersionTag("0.0.5", "0.0.5")).toBe("v0.0.5");
    expect(formatTrayVersionTag("0.0.5", "0.0.4")).toBe("App v0.0.5 / kilnd v0.0.4");
    expect(formatTrayHeader("0.0.5", "0.0.4")).toBe("Kiln 工作台 · App v0.0.5 / kilnd v0.0.4");
    expect(formatTrayTooltipWithVersion(running, DEFAULT_KILND_URL, "0.0.5", "0.0.5")).toContain(
      "Kiln v0.0.5",
    );
    expect(summarizeStartError("kiln up failed: env: node: No such file or directory")).toBe(
      "未找到 Node.js (>=22)，请先安装 Node.js",
    );
    expect(
      formatInstallCliMenuLabel({ kind: "installed", binDir: "~/.local/bin", inPath: false }),
    ).toContain("请将 ~/.local/bin 加入 PATH");
  });

  it("collects versioned node bins sorted descending and resolves bundled E1 runtime cleanly", () => {
    const home = makeTempDir("semver-bins");
    const v22 = path.join(home, ".local/share/mise/installs/node/22.19.0/bin");
    const v24 = path.join(home, ".local/share/mise/installs/node/24.20.0/bin");
    const v20 = path.join(home, ".nvm/versions/node/v20.11.0/bin");
    const fnmV21 = path.join(home, ".fnm/node-versions/v21.7.3/installation/bin");
    const aliasDir = path.join(home, ".local/share/mise/installs/node/global/bin");
    for (const d of [v22, v24, v20, fnmV21, aliasDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    expect(parseSemverKey("v24.20.0")).toEqual([24, 20, 0]);
    expect(parseSemverKey("global")).toBeNull();
    expect(collectVersionedNodeBins(home)).toEqual([v24, v22, fnmV21, v20]);

    const resRoot = makeTempDir("electron-resources");
    const runtimeDir = path.join(resRoot, "kiln-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const cliMjs = path.join(runtimeDir, "kiln-cli.mjs");
    fs.writeFileSync(cliMjs, "// bundled cli\n", "utf8");
    expect(resolveBundledRuntimeCliPath({ resourcesPath: resRoot })).toBe(cliMjs);

    const bundledInv = resolveKilnInvocationForPlatform({
      execPath: "/Applications/Kiln.app/Contents/MacOS/Kiln",
      resourcesPath: resRoot,
      homeDir: home,
      isWindows: false,
    });
    expect(bundledInv).toEqual({
      command: "/Applications/Kiln.app/Contents/MacOS/Kiln",
      prefixArgs: [cliMjs],
      electronAsNode: true,
      sourceKind: "bundled_runtime",
    });

    const env = buildKilnChildEnv(bundledInv, { PATH: "/usr/bin:/bin", HOME: home });
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");

    const overrideBin = path.join(home, "custom-kiln");
    fs.writeFileSync(overrideBin, "#!/bin/sh\n", "utf8");
    const overrideInv = resolveKilnInvocationForPlatform({
      explicitKilnBin: overrideBin,
      resourcesPath: resRoot,
    });
    expect(overrideInv.sourceKind).toBe("override");
    expect(overrideInv.electronAsNode).toBe(false);

    expect(() =>
      resolveKilnInvocationForPlatform({ explicitKilnBin: path.join(home, "missing") }),
    ).toThrow(/KILN_BIN points to missing file/);
  });

  it("renders and installs POSIX & Windows Electron CLI wrappers without touching shell profiles", () => {
    const home = makeTempDir("cli-install");
    const exePath = path.join(home, "Kiln's App/Kiln");
    const cliMjs = path.join(home, "Kiln's App/kiln-cli.mjs");
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, "binary", "utf8");
    fs.writeFileSync(cliMjs, "// cli", "utf8");

    const posixWrapper = renderPosixCliWrapper({
      executable: exePath,
      entrypoint: cliMjs,
      electronAsNode: true,
    });
    expect(posixWrapper).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(posixWrapper).toContain("'\\''");
    expect(posixWrapper).toContain('"$@"');

    const localBin = path.join(home, ".local/bin");
    const posixOutcome = installPosixCliWrappers(
      {
        command: exePath,
        prefixArgs: [cliMjs],
        electronAsNode: true,
        sourceKind: "bundled_runtime",
      },
      localBin,
      "/usr/bin:/bin",
    );
    expect(posixOutcome.inPath).toBe(false);
    expect(fs.readFileSync(path.join(localBin, "kiln"), "utf8")).toContain(
      "ELECTRON_RUN_AS_NODE=1",
    );
    expect(fs.readFileSync(path.join(localBin, "kl"), "utf8")).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(fs.existsSync(path.join(home, ".zshrc"))).toBe(false);

    const winShim = renderWindowsCliShim({
      executable: "C:\\Users\\dev%20\\Kiln\\Kiln.exe",
      entrypoint: "C:\\Users\\dev%20\\Kiln\\resources\\kiln-runtime\\kiln-cli.mjs",
      electronAsNode: true,
    });
    expect(winShim).toContain("setlocal");
    expect(winShim).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(winShim).toContain("%%20");

    const winBin = path.join(home, "LocalAppData/Kiln/bin");
    const winOutcome = installWindowsCliShims(
      {
        command: exePath,
        prefixArgs: [cliMjs],
        electronAsNode: true,
        sourceKind: "bundled_runtime",
      },
      winBin,
      `${winBin};C:\\Windows\\System32`,
    );
    expect(winOutcome.inPath).toBe(true);
    expect(fs.existsSync(path.join(winBin, "kiln.cmd"))).toBe(true);
    expect(fs.existsSync(path.join(winBin, "kl.cmd"))).toBe(true);

    expect(pathContainsDir("/usr/bin:/Users/me/.local/bin/", "/Users/me/.local/bin", false)).toBe(
      true,
    );
    const childDirs = buildChildCommandPathDirs(localBin, "/usr/bin:/bin", "/Users/tester", [
      "/Users/tester/.local/share/mise/installs/node/24.20.0/bin",
    ]);
    expect(childDirs[0]).toBe(localBin);
    expect(childDirs).toContain("/opt/homebrew/opt/node@22/bin");
  });
});
