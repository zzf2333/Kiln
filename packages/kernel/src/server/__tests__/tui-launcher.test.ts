import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GateReportSchema,
  RunEventSchema,
  RunMetaSchema,
  TaskCardSchema,
  buildWorkflowPreset,
} from "@kiln/protocol";
import {
  KilndServer,
  buildRunOverviewSummary,
  detectAvailableTuiTerminals,
  launchNativeAgentTui,
  resolveNativeTuiCommand,
} from "../index.js";

function makeTempDir(prefix = "kiln-tui-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Native TUI launcher, run overview I/O summary & local-only open-tui endpoint", () => {
  const tempDirs: string[] = [];
  const servers: KilndServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("resolveNativeTuiCommand maps supported agents and fail-closes invalid or unbound sessions", () => {
    expect(
      resolveNativeTuiCommand({
        agent: "codex",
        providerSessionId: "0195a3f1-aaaa-bbbb",
      }),
    ).toMatchObject({
      ok: true,
      agent: "codex",
      binary: "codex",
      args: ["resume", "0195a3f1-aaaa-bbbb"],
      commandPreview: "codex resume 0195a3f1-aaaa-bbbb",
    });

    expect(
      resolveNativeTuiCommand({
        agent: "pi",
        providerSessionId: "pi-id-1",
        providerSessionPath: "/tmp/pi sessions/s1.jsonl",
      }),
    ).toMatchObject({
      ok: true,
      agent: "pi",
      binary: "pi",
      args: ["--session", "/tmp/pi sessions/s1.jsonl"],
    });

    expect(
      resolveNativeTuiCommand({
        agent: "pi",
        providerSessionId: "pi-id-only",
      }),
    ).toMatchObject({
      ok: true,
      binary: "pi",
      args: ["--session", "pi-id-only"],
    });

    expect(
      resolveNativeTuiCommand({
        agent: "claude",
        providerSessionId: "claude-sess-9",
      }),
    ).toMatchObject({
      ok: true,
      binary: "claude",
      args: ["--resume", "claude-sess-9"],
    });

    expect(
      resolveNativeTuiCommand({
        agent: "opencode",
        providerSessionId: "oc-sess-42",
      }),
    ).toMatchObject({
      ok: true,
      binary: "opencode",
      args: ["--session", "oc-sess-42"],
    });

    expect(
      resolveNativeTuiCommand({
        agent: "antigravity",
        providerSessionId: "agy-1",
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "unsupported_tui_agent",
    });

    expect(
      resolveNativeTuiCommand({
        agent: "codex",
        providerSessionId: null,
      }),
    ).toMatchObject({
      ok: false,
      status: 409,
      code: "native_session_unavailable",
    });

    expect(
      resolveNativeTuiCommand({
        agent: "codex",
        providerSessionId: "bad\nrm -rf /",
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_tui_target",
    });

    expect(
      resolveNativeTuiCommand({
        agent: "codex",
        providerSessionId: "id;touch /tmp/pwn",
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_tui_target",
    });

    expect(
      resolveNativeTuiCommand({
        agent: "codex",
        providerSessionId: "--dangerously-bypass-approvals-and-sandbox",
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_tui_target",
    });

    expect(
      resolveNativeTuiCommand({
        agent: "pi",
        providerSessionPath: "-e malicious",
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_tui_target",
    });
  });

  it("launchNativeAgentTui writes safe launcher scripts with cwd fallback across darwin and win32", async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const homeDir = path.join(root, "home");
    const fallbackRepo = path.join(root, "repo-fallback");
    const quotedCwd = path.join(root, "it's a 'space' dir");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(fallbackRepo, { recursive: true });
    fs.mkdirSync(quotedCwd, { recursive: true });

    const emptyProbe = {
      pathExists: () => false,
      findBinary: () => null,
    };

    const macCalls: Array<{ file: string; args: readonly string[] }> = [];
    const macRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-mac",
      runDir: "001-implement",
      agent: "codex",
      providerSessionId: "codex-mac-1",
      cwd: quotedCwd,
      fallbackCwd: fallbackRepo,
      homedir: homeDir,
      platform: "darwin",
      probe: emptyProbe,
      execFileFn: async (file, args) => {
        macCalls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });
    expect(macRes.cwd).toBe(
      fs.realpathSync(quotedCwd).startsWith("/private")
        ? path.resolve(quotedCwd)
        : path.resolve(quotedCwd),
    );
    expect(macRes.cwdFallback).toBe(false);
    expect(macRes.terminalId).toBe("terminal");
    expect(macRes.terminal).toBe("系统默认终端");
    expect(macCalls).toHaveLength(1);
    expect(macCalls[0]!.file).toBe("/usr/bin/open");
    const macScript = macCalls[0]!.args[0]!;
    expect(path.basename(macScript)).toMatch(/^kiln-tui-.*\.command$/);
    if (process.platform !== "win32") {
      const macStat = fs.statSync(macScript);
      expect(macStat.mode & 0o777).toBe(0o700);
    }
    const macContent = fs.readFileSync(macScript, "utf8");
    expect(macContent).toContain(`cd -- '${path.resolve(quotedCwd).replace(/'/g, `'\\''`)}'`);
    expect(macContent).toContain("exec 'codex' 'resume' 'codex-mac-1'");

    // Fallback when run cwd does not exist -> falls back to space repo_path, then homedir
    const winCalls: Array<{
      file: string;
      args: readonly string[];
      options?: { windowsHide?: boolean };
    }> = [];
    const winRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-win",
      runDir: "001-implement",
      agent: "pi",
      providerSessionId: "pi-win-1",
      providerSessionPath: "C:\\Users\\dev\\pi's session.jsonl",
      cwd: path.join(root, "does-not-exist"),
      fallbackCwd: fallbackRepo,
      homedir: homeDir,
      platform: "win32",
      probe: emptyProbe,
      execFileFn: async (file, args, opts) => {
        winCalls.push({ file, args, options: opts });
        return { stdout: "", stderr: "" };
      },
    });
    expect(winRes.cwd).toBe(path.resolve(fallbackRepo));
    expect(winRes.cwdFallback).toBe(true);
    expect(winRes.terminalId).toBe("powershell");
    expect(winCalls).toHaveLength(1);
    expect(winCalls[0]!.file).toBe("cmd.exe");
    expect(winCalls[0]!.options?.windowsHide).toBe(true);
    const ps1Path = winCalls[0]!.args[winCalls[0]!.args.length - 1]!;
    expect(ps1Path).toMatch(/\.ps1$/);
    const ps1Content = fs.readFileSync(ps1Path, "utf8");
    expect(ps1Content).toContain(`Set-Location -LiteralPath '${path.resolve(fallbackRepo)}'`);
    expect(ps1Content).toContain("& 'pi' '--session' 'C:\\Users\\dev\\pi''s session.jsonl'");

    const linuxRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-linux",
      runDir: "001-implement",
      agent: "codex",
      providerSessionId: "codex-linux-1",
      cwd: path.join(root, "missing-cwd"),
      fallbackCwd: path.join(root, "missing-fallback"),
      homedir: homeDir,
      platform: "linux",
      probe: emptyProbe,
      execFileFn: async () => ({ stdout: "", stderr: "" }),
    });
    expect(linuxRes.cwd).toBe(path.resolve(homeDir));
    expect(linuxRes.cwdFallback).toBe(true);
    expect(linuxRes.terminalId).toBe("x_terminal_emulator");
  });

  it("prioritizes modern terminals across darwin/win32/linux, honors preferredTerminal, and falls back on launch error", async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const homeDir = path.join(root, "home");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    // 1. macOS priority: Ghostty > Warp > WezTerm > Kitty > iTerm2 > Alacritty > Terminal
    const macDetected = detectAvailableTuiTerminals({
      platform: "darwin",
      homedir: homeDir,
      pathExists: (p) => p === "/Applications/Warp.app" || p === "/Applications/iTerm.app",
      findBinary: () => null,
    });
    expect(macDetected.map((t) => [t.id, t.available])).toEqual([
      ["ghostty", false],
      ["warp", true],
      ["wezterm", false],
      ["kitty", false],
      ["iterm2", true],
      ["alacritty", false],
      ["terminal", true],
    ]);

    const warpCalls: Array<{ file: string; args: readonly string[] }> = [];
    const warpRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-warp",
      runDir: "001-implement",
      agent: "codex",
      providerSessionId: "codex-warp-1",
      cwd,
      homedir: homeDir,
      platform: "darwin",
      probe: {
        pathExists: (p) => p === "/Applications/Warp.app" || p === "/Applications/iTerm.app",
        findBinary: () => null,
      },
      execFileFn: async (file, args) => {
        warpCalls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });
    expect(warpRes.terminalId).toBe("warp");
    expect(warpRes.terminal).toBe("Warp");
    expect(warpCalls[0]!.file).toBe("/usr/bin/open");
    expect(warpCalls[0]!.args[0]).toBe("-a");
    expect(warpCalls[0]!.args[1]).toBe("/Applications/Warp.app");

    // Ghostty takes precedence over Warp when installed
    const ghosttyCalls: Array<{ file: string; args: readonly string[] }> = [];
    const ghosttyRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-ghostty",
      runDir: "001-implement",
      agent: "codex",
      providerSessionId: "codex-ghostty-1",
      cwd,
      homedir: homeDir,
      platform: "darwin",
      probe: {
        pathExists: (p) => p === "/Applications/Ghostty.app" || p === "/Applications/Warp.app",
        findBinary: () => null,
      },
      execFileFn: async (file, args) => {
        ghosttyCalls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });
    expect(ghosttyRes.terminalId).toBe("ghostty");
    expect(ghosttyRes.terminal).toBe("Ghostty");
    expect(ghosttyCalls[0]!.args.slice(0, 4)).toEqual([
      "-na",
      "/Applications/Ghostty.app",
      "--args",
      "-e",
    ]);

    // Explicit preferredTerminal overrides auto priority; unavailable preference degrades to auto
    const itermCalls: Array<{ file: string; args: readonly string[] }> = [];
    const itermRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-iterm",
      runDir: "001-implement",
      agent: "codex",
      providerSessionId: "codex-iterm-1",
      cwd,
      homedir: homeDir,
      platform: "darwin",
      preferredTerminal: "iterm2",
      probe: {
        pathExists: (p) => p === "/Applications/Warp.app" || p === "/Applications/iTerm.app",
        findBinary: () => null,
      },
      execFileFn: async (file, args) => {
        itermCalls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });
    expect(itermRes.terminalId).toBe("iterm2");
    expect(itermCalls[0]!.args[1]).toBe("/Applications/iTerm.app");

    // If preferred modern terminal fails to open, automatically falls back to system default terminal
    const fallbackCalls: Array<{ file: string; args: readonly string[] }> = [];
    const fallbackRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-fallback",
      runDir: "001-implement",
      agent: "codex",
      providerSessionId: "codex-fb-1",
      cwd,
      homedir: homeDir,
      platform: "darwin",
      preferredTerminal: "warp",
      probe: {
        pathExists: (p) => p === "/Applications/Warp.app",
        findBinary: () => null,
      },
      execFileFn: async (file, args) => {
        fallbackCalls.push({ file, args });
        if (args[0] === "-a" && args[1] === "/Applications/Warp.app") {
          throw new Error("Warp failed to launch");
        }
        return { stdout: "", stderr: "" };
      },
    });
    expect(fallbackCalls).toHaveLength(2);
    expect(fallbackRes.terminalId).toBe("terminal");
    expect(fallbackCalls[1]!.args).toHaveLength(1);

    // 2. Windows priority: Windows Terminal (with pwsh) > WezTerm > Alacritty > pwsh > PowerShell
    const wtCalls: Array<{ file: string; args: readonly string[] }> = [];
    const wtRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-wt",
      runDir: "001-implement",
      agent: "codex",
      providerSessionId: "codex-wt-1",
      cwd,
      homedir: homeDir,
      platform: "win32",
      probe: {
        pathExists: () => false,
        findBinary: (bin) => {
          if (bin === "wt.exe")
            return "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
          if (bin === "pwsh.exe") return "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
          return null;
        },
      },
      execFileFn: async (file, args) => {
        wtCalls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });
    expect(wtRes.terminalId).toBe("windows_terminal");
    expect(wtRes.terminal).toBe("Windows Terminal");
    expect(wtCalls[0]!.file).toBe("C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe");
    expect(wtCalls[0]!.args.slice(0, 3)).toEqual([
      "-d",
      path.resolve(cwd),
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ]);

    // 3. Linux priority: ghostty > wezterm > kitty > ... > xterm
    const linuxModernCalls: Array<{ file: string; args: readonly string[] }> = [];
    const linuxModernRes = await launchNativeAgentTui({
      kilnHome,
      taskId: "t-linux-modern",
      runDir: "001-implement",
      agent: "codex",
      providerSessionId: "codex-linux-modern-1",
      cwd,
      homedir: homeDir,
      platform: "linux",
      probe: {
        pathExists: () => false,
        findBinary: (bin) => (bin === "kitty" || bin === "xterm" ? `/usr/bin/${bin}` : null),
      },
      execFileFn: async (file, args) => {
        linuxModernCalls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });
    expect(linuxModernRes.terminalId).toBe("kitty");
    expect(linuxModernCalls[0]!.file).toBe("/usr/bin/kitty");
  });

  it("buildRunOverviewSummary prefers RUN.yaml session and extracts compact I/O overview", () => {
    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-sum",
      title: "Summary test",
      space: "proj",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      workflow: buildWorkflowPreset("standard_dev"),
      contract_version: 1,
      contract: {
        goal: "修复认证回调",
        end: "单测全过",
        accept_cmd: "pnpm test",
        accept_files_hash: "sha256:sum",
        scope: ["src/**"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
      created_at: "2026-11-22T09:00:00.000Z",
      updated_at: "2026-11-22T09:00:00.000Z",
    });

    const meta = RunMetaSchema.parse({
      run_id: "r-1",
      task_id: "t-sum",
      stage: "implement",
      round: 1,
      role: "worker",
      agent: "codex",
      model: "gpt-6-luna",
      backend_id: "paseo",
      cwd: "/tmp/proj",
      input_ref: "brief:v1",
      session_ref: {
        backendId: "paseo",
        sessionId: "paseo-internal-uuid",
        meta: { agent: "codex" },
      },
      contract_version: 1,
      started_at: "2026-11-22T09:00:00.000Z",
    });

    const events = [
      RunEventSchema.parse({
        kind: "session_bound",
        at: "2026-11-22T09:00:02.000Z",
        providerSessionId: "0195a3f1-real-thread",
      }),
      RunEventSchema.parse({
        kind: "exit",
        at: "2026-11-22T09:01:00.000Z",
        reason: "completed",
      }),
    ];

    const gate = GateReportSchema.parse({
      schema_version: 1,
      run_id: "r-1",
      task_id: "t-sum",
      stage: "implement",
      contract_version: 1,
      schema_ok: true,
      scope_ok: true,
      artifacts_ok: true,
      out_of_scope_paths: [],
      frozen_files_changed: [],
      accept_exit_code: 0,
      accept_output_tail: "",
      accept_duration_ms: 1200,
      escalated_to_l2: false,
      checked_at: "2026-11-22T09:01:00.000Z",
    });

    const summary = buildRunOverviewSummary({
      card,
      meta,
      receipt: [
        "---",
        "run_id: r-1",
        "contract_version: 1",
        "changed_paths:",
        "  - src/auth.ts",
        "  - src/session.ts",
        "---",
        "## 改动说明",
        "补齐本地回调签名验证并刷新状态。",
      ].join("\n"),
      gate,
      events,
      usageTurns: [],
      pricing: null,
      dirName: "001-implement",
      activeRunId: null,
      taskStatus: "done",
    });

    expect(summary.session).toMatchObject({
      providerSessionId: "0195a3f1-real-thread",
      displaySessionId: "0195a3f1-rea",
      cwd: "/tmp/proj",
      tuiSupported: true,
      tuiCommandPreview: "codex resume 0195a3f1-real-thread",
    });
    expect(summary.ioSummary).toMatchObject({
      inputTitle: "修复认证回调",
      inputRef: "brief:v1",
      outputVerdict: "通过",
      outputSummary: "补齐本地回调签名验证并刷新状态。",
      changedPaths: ["src/auth.ts", "src/session.ts"],
      gatePassed: true,
    });
  });

  it("enforces local-only 403 on :4311 and validates params/404/409/200 on POST .../open-tui", async () => {
    const kilnHome = makeTempDir();
    tempDirs.push(kilnHome);
    const repoDir = makeTempDir("kiln-repo-");
    tempDirs.push(repoDir);

    const openSpy = vi.fn(async ({ taskId, runDir }) => ({
      ok: true as const,
      taskId,
      runDir,
      agent: "codex",
      providerSessionId: "codex-native-99",
      cwd: repoDir,
      cwdFallback: false,
      commandPreview: "codex resume codex-native-99",
    }));

    const server = new KilndServer({
      kilnHome,
      publicDir: null,
      tokenSecret: "tui-test-secret-0123456789abcdef",
      openRunTui: openSpy,
    });
    servers.push(server);

    server.store.writeSpace({
      schema_version: 1,
      id: "proj",
      name: "Proj",
      repo_path: repoDir,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    server.stateMachine.createTask(
      TaskCardSchema.parse({
        schema_version: 1,
        id: "t-tui-1",
        title: "Open TUI endpoint test",
        space: "proj",
        priority: "P1",
        track: "L2",
        workspace_mode: "git_worktree",
        parent: null,
        depends_on: [],
        workflow: buildWorkflowPreset("quick"),
        contract_version: 1,
        contract: {
          goal: "Open TUI test",
          end: "Done",
          accept_cmd: "pnpm test",
          accept_files_hash: "sha256:tui1",
          scope: ["src/**"],
          deliver: { mode: "merge_main", cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        limits: { retries_per_stage: 2, review_rounds: 2, advisor_calls: 1, max_tokens: 1_000_000 },
        created_at: "2026-11-22T09:10:00.000Z",
        updated_at: "2026-11-22T09:10:00.000Z",
      }),
      "# Brief",
    );

    const run1Dir = server.store.paths.runDir("t-tui-1", "001-implement");
    fs.mkdirSync(run1Dir, { recursive: true });
    fs.writeFileSync(
      server.store.paths.runYaml("t-tui-1", "001-implement"),
      [
        "run_id: r-1",
        "task_id: t-tui-1",
        "stage: implement",
        "round: 1",
        "role: worker",
        "agent: codex",
        "model: gpt-6-luna",
        "backend_id: paseo",
        `cwd: ${repoDir}`,
        "session_ref:",
        "  backendId: paseo",
        "  sessionId: paseo-internal-1",
        "  meta:",
        "    agent: codex",
        "    providerSessionId: codex-native-99",
        "contract_version: 1",
        "started_at: 2026-11-22T09:10:01.000Z",
      ].join("\n"),
    );

    const run2Dir = server.store.paths.runDir("t-tui-1", "002-review");
    fs.mkdirSync(run2Dir, { recursive: true });
    fs.writeFileSync(
      server.store.paths.runYaml("t-tui-1", "002-review"),
      [
        "run_id: r-2",
        "task_id: t-tui-1",
        "stage: review",
        "round: 1",
        "role: reviewer",
        "agent: codex",
        "model: gpt-6-luna",
        "backend_id: fake",
        "session_ref:",
        "  backendId: fake",
        "  sessionId: fake-sess-2",
        "contract_version: 1",
        "started_at: 2026-11-22T09:11:01.000Z",
      ].join("\n"),
    );

    // Pair a remote session cookie so :4311 authenticates and specifically rejects local_only_endpoint
    const pairCreate = await server.app.request(
      new Request("http://127.0.0.1:4310/api/remote/pair", { method: "POST" }),
    );
    expect(pairCreate.status).toBe(201);
    const challenge = (await pairCreate.json()) as { token: string };

    const pairRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: challenge.token }),
      }),
    );
    expect(pairRes.status).toBe(200);
    const setCookie = pairRes.headers.get("set-cookie") ?? "";
    const sessionToken = /^kiln_session=([^;]+)/.exec(setCookie)![1]!;

    const remoteRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/tasks/t-tui-1/runs/001-implement/open-tui", {
        method: "POST",
        headers: {
          Cookie: `kiln_session=${sessionToken}`,
          Origin: "http://127.0.0.1:4311",
        },
      }),
    );
    expect(remoteRes.status).toBe(403);
    expect((await remoteRes.json()) as { error: string }).toMatchObject({
      error: "local_only_endpoint",
    });

    const badSegmentRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/tasks/t-tui-1/runs/..%2Fsecret/open-tui", {
        method: "POST",
      }),
    );
    expect(badSegmentRes.status).toBe(400);

    const missingRunRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/tasks/t-tui-1/runs/999-missing/open-tui", {
        method: "POST",
      }),
    );
    expect(missingRunRes.status).toBe(404);

    const unboundRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/tasks/t-tui-1/runs/002-review/open-tui", {
        method: "POST",
      }),
    );
    expect(unboundRes.status).toBe(409);
    expect((await unboundRes.json()) as { error: string }).toMatchObject({
      error: "native_session_unavailable",
    });

    const localRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/tasks/t-tui-1/runs/001-implement/open-tui", {
        method: "POST",
      }),
    );
    expect(localRes.status).toBe(200);
    expect(await localRes.json()).toMatchObject({
      ok: true,
      taskId: "t-tui-1",
      runDir: "001-implement",
      providerSessionId: "codex-native-99",
    });
    expect(openSpy).toHaveBeenCalledWith({
      taskId: "t-tui-1",
      runDir: "001-implement",
    });

    // Local bootstrap exposes detected tuiTerminals while remote :4311 omits host terminal list
    const localBootstrapRes = await server.app.request(
      new Request("http://127.0.0.1:4310/api/bootstrap"),
    );
    expect(localBootstrapRes.status).toBe(200);
    const localBootstrap = (await localBootstrapRes.json()) as {
      tuiTerminals?: Array<{ id: string; available: boolean }>;
    };
    expect(Array.isArray(localBootstrap.tuiTerminals)).toBe(true);
    expect(localBootstrap.tuiTerminals!.length).toBeGreaterThan(0);

    const remoteBootstrapRes = await server.remoteApp.request(
      new Request("http://127.0.0.1:4311/api/bootstrap", {
        headers: {
          Cookie: `kiln_session=${sessionToken}`,
        },
      }),
    );
    expect(remoteBootstrapRes.status).toBe(200);
    const remoteBootstrap = (await remoteBootstrapRes.json()) as {
      tuiTerminals?: unknown;
    };
    expect(remoteBootstrap.tuiTerminals).toBeUndefined();
  });
});
