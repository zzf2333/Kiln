import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PricingConfig, RunMeta, TaskCard } from "@kiln/protocol";
import { KilndServer, writeFileAtomic } from "@kiln/kernel";
import {
  LINUX_SYSTEMD_SERVICE_NAME,
  MACOS_LAUNCH_AGENT_LABEL,
  getServiceStatus,
  installService,
  renderLaunchAgentPlist,
  renderSystemdUnit,
  resolveKilnPidPath,
  runCli,
  uninstallService,
} from "../index.js";

const tempDirs: string[] = [];
const servers: KilndServer[] = [];

function makeTempDir(prefix = "kiln-cli-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    schema_version: 1,
    id: "t-cli-1",
    title: "CLI integration task",
    space: "kiln",
    priority: "P1",
    track: "L2",
    workspace_mode: "git_worktree",
    parent: null,
    depends_on: [],
    contract_version: 1,
    contract: {
      goal: "Verify CLI integration against KilndServer",
      end: "All CLI commands succeed cleanly",
      accept_cmd: "pnpm --filter @kiln/cli test",
      accept_files_hash: "sha256:cli-test-v1",
      scope: ["packages/cli/**"],
      deliver: { mode: "manual", cmd: null },
      human_accept: false,
      external_actions: "ask",
    },
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 250_000,
    },
    created_at: "2026-11-19T10:00:00.000Z",
    updated_at: "2026-11-19T10:00:00.000Z",
    ...overrides,
  };
}

function makeRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    schema_version: 1,
    run_id: "run-cli-1",
    task_id: "t-cli-1",
    stage: "implement",
    round: 1,
    role: "worker",
    contract_version: 1,
    backend_id: "fake",
    agent: "codex",
    model: "gpt-5.4",
    session_ref: {
      backendId: "fake",
      sessionId: "sess-cli-1",
    },
    input_ref: "main",
    started_at: "2026-11-19T10:01:00.000Z",
    ...overrides,
  };
}

function createInProcessFetch(
  server: KilndServer,
  isRunning: () => boolean = () => true,
): typeof fetch {
  return async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    if (!isRunning()) {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }
    const req = input instanceof Request ? input : new Request(String(input), init);
    return await server.app.request(req);
  };
}

function makeTestHarness(prefix = "kiln-cli-harness-"): {
  root: string;
  homeDir: string;
  kilnHome: string;
  launchAgentsDir: string;
  systemdDir: string;
  plistPath: string;
  systemdPath: string;
  server: KilndServer;
} {
  const root = makeTempDir(prefix);
  const homeDir = path.join(root, "home");
  const kilnHome = path.join(root, "kiln-home");
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const systemdDir = path.join(homeDir, ".config", "systemd", "user");
  const plistPath = path.join(launchAgentsDir, `${MACOS_LAUNCH_AGENT_LABEL}.plist`);
  const systemdPath = path.join(systemdDir, LINUX_SYSTEMD_SERVICE_NAME);

  const server = new KilndServer({
    kilnHome,
    port: 0,
    tokenSecret: "cli-test-secret-0123456789abcdef",
  });
  servers.push(server);

  return {
    root,
    homeDir,
    kilnHome,
    launchAgentsDir,
    systemdDir,
    plistPath,
    systemdPath,
    server,
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop()!;
    await srv.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("@kiln/cli", () => {
  it("runs up / status / open / down without ever writing LaunchAgent or systemd files", async () => {
    const h = makeTestHarness();
    let daemonOnline = false;
    let spawnCount = 0;
    let stopCount = 0;
    const openedUrls: string[] = [];

    const pricing: PricingConfig = {
      schema_version: 1,
      models: {
        "gpt-5.4": { in: 10, cached: 2.5, out: 40 },
      },
    };
    h.server.store.writeConfig("pricing", pricing);
    h.server.stateMachine.createTask(makeTaskCard(), "# CLI task");
    h.server.persistRunForDispatch(makeRunMeta(), "001-implement");
    h.server.store.recordRunEvent("t-cli-1", "001-implement", {
      kind: "usage",
      at: "2026-11-19T10:05:00.000Z",
      agent: "codex",
      model: "gpt-5.4",
      turnId: "turn-1",
      inputTokens: 100_000,
      cachedInputTokens: 40_000,
      outputTokens: 25_000,
    });

    const fetchImpl = createInProcessFetch(h.server, () => daemonOnline);

    // 1. First `kiln up` starts daemon, writes kilnd.pid, and NEVER writes LaunchAgent/systemd
    const up1 = await runCli(["up", "--port", "4319"], {
      kilnHome: h.kilnHome,
      homeDir: h.homeDir,
      launchAgentsDir: h.launchAgentsDir,
      systemdDir: h.systemdDir,
      fetchImpl,
      isDaemonRunning: () => daemonOnline,
      spawnDaemon: () => {
        spawnCount += 1;
        daemonOnline = true;
        return { pid: 55123, port: 4319 };
      },
    });
    expect(up1.exitCode).toBe(0);
    expect(spawnCount).toBe(1);
    expect(up1.stdout).toContain("http://127.0.0.1:4319");
    expect(up1.stdout).toContain("55123");
    expect(fs.readFileSync(resolveKilnPidPath(h.kilnHome), "utf8").trim()).toBe("55123");
    expect(fs.existsSync(h.plistPath)).toBe(false);
    expect(fs.existsSync(h.systemdPath)).toBe(false);

    // 2. Second `kiln up` is idempotent and still does not write plist
    const up2 = await runCli(["up", "--port", "4319"], {
      kilnHome: h.kilnHome,
      homeDir: h.homeDir,
      launchAgentsDir: h.launchAgentsDir,
      systemdDir: h.systemdDir,
      fetchImpl,
      isDaemonRunning: () => daemonOnline,
      spawnDaemon: () => {
        spawnCount += 1;
        return { pid: 99999 };
      },
    });
    expect(up2.exitCode).toBe(0);
    expect(spawnCount).toBe(1);
    expect(up2.stdout).toContain("already running");
    expect(fs.existsSync(h.plistPath)).toBe(false);

    // 3. `kiln status` online reads /api/bootstrap and formats running tasks & API cost
    // Cost = ((100_000 - 40_000)*10 + 40_000*2.5 + 25_000*40) / 1e6 = (600k + 100k + 1000k)/1e6 = $1.70
    const statusOnline = await runCli(["status", "--port", "4319"], {
      kilnHome: h.kilnHome,
      homeDir: h.homeDir,
      fetchImpl,
      isDaemonRunning: () => daemonOnline,
    });
    expect(statusOnline.exitCode).toBe(0);
    expect(statusOnline.stdout).toContain("Daemon: online");
    expect(statusOnline.stdout).toContain("Running: 1");
    expect(statusOnline.stdout).toContain("t-cli-1");
    expect(statusOnline.stdout).toContain("$1.7000");

    // 4. `kiln open` passes resolved URL to openUrl
    const openRes = await runCli(["open", "--port", "4319"], {
      openUrl: (url) => {
        openedUrls.push(url);
      },
    });
    expect(openRes.exitCode).toBe(0);
    expect(openedUrls).toEqual(["http://127.0.0.1:4319"]);

    // 5. `kiln down` stops managed daemon and removes kilnd.pid
    const downRes = await runCli(["down"], {
      kilnHome: h.kilnHome,
      homeDir: h.homeDir,
      stopDaemon: () => {
        stopCount += 1;
        daemonOnline = false;
        return true;
      },
    });
    expect(downRes.exitCode).toBe(0);
    expect(stopCount).toBe(1);
    expect(fs.existsSync(resolveKilnPidPath(h.kilnHome))).toBe(false);

    // 6. `kiln status` offline falls back cleanly to local KilnStore
    const statusOffline = await runCli(["status", "--port", "4319"], {
      kilnHome: h.kilnHome,
      homeDir: h.homeDir,
      fetchImpl,
      isDaemonRunning: () => daemonOnline,
    });
    expect(statusOffline.exitCode).toBe(0);
    expect(statusOffline.stdout).toContain("Daemon: offline");
    expect(statusOffline.stdout).toContain("Running: 1");
    expect(statusOffline.stdout).toContain("$1.7000");

    // 7. `kiln down` cleans up stale/corrupt/non-positive kilnd.pid safely without signaling PID <= 0
    const pidFile = resolveKilnPidPath(h.kilnHome);
    writeFileAtomic(pidFile, "0\n");
    const signaledPids: number[] = [];
    const downZero = await runCli(["down"], {
      kilnHome: h.kilnHome,
      signalProcess: (pid) => {
        signaledPids.push(pid);
      },
    });
    expect(downZero.exitCode).toBe(0);
    expect(signaledPids).toEqual([]);
    expect(fs.existsSync(pidFile)).toBe(false);

    writeFileAtomic(pidFile, "77777\n");
    const downLive = await runCli(["down"], {
      kilnHome: h.kilnHome,
      signalProcess: (pid, sig) => {
        signaledPids.push(pid);
        if (sig === 0 && signaledPids.filter((p) => p === 77777).length >= 2) {
          const err = new Error("No such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
      },
    });
    expect(downLive.exitCode).toBe(0);
    expect(signaledPids).toContain(77777);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("writes drafts via both offline KilnStore and online POST /api/drafts", async () => {
    const h = makeTestHarness();
    const fetchImpl = createInProcessFetch(h.server);

    // Offline draft
    const offlineDraft = await runCli(
      [
        "draft",
        "给博客加全文 RSS",
        "--id",
        "d-offline-1",
        "--space",
        "blog",
        "--priority",
        "P1",
        "--track",
        "L1",
        "--mode",
        "scratch_dir",
      ],
      {
        kilnHome: h.kilnHome,
        homeDir: h.homeDir,
        isDaemonRunning: () => false,
      },
    );
    expect(offlineDraft.exitCode).toBe(0);
    expect(offlineDraft.stdout).toContain("d-offline-1");
    expect(offlineDraft.stdout).toContain("offline");
    const storedOffline = h.server.store.readDraft("d-offline-1");
    expect(storedOffline?.title).toBe("给博客加全文 RSS");
    expect(storedOffline?.space).toBe("blog");
    expect(storedOffline?.priority).toBe("P1");
    expect(storedOffline?.track).toBe("L1");
    expect(storedOffline?.workspace_mode).toBe("scratch_dir");

    // Online draft via server.app.request
    const onlineDraft = await runCli(
      [
        "draft",
        "给博客加全文 RSS",
        "--id",
        "d-online-1",
        "--space",
        "blog",
        "--priority",
        "P0",
        "--track",
        "L2",
        "--mode",
        "host_scoped",
      ],
      {
        kilnHome: h.kilnHome,
        homeDir: h.homeDir,
        fetchImpl,
      },
    );
    expect(onlineDraft.exitCode).toBe(0);
    expect(onlineDraft.stdout).toContain("d-online-1");
    expect(onlineDraft.stdout).toContain("online");
    const storedOnline = h.server.store.readDraft("d-online-1");
    expect(storedOnline?.title).toBe("给博客加全文 RSS");
    expect(storedOnline?.priority).toBe("P0");
    expect(storedOnline?.workspace_mode).toBe("host_scoped");

    // Rejects Post-MVP external_only mode, L3 track, and traversal space names
    const badMode = await runCli(["draft", "bad", "--mode", "external_only"], {
      kilnHome: h.kilnHome,
    });
    expect(badMode.exitCode).toBe(2);
    expect(badMode.stderr).toContain("Post-MVP");

    const badTrack = await runCli(["draft", "bad", "--track", "L3"], {
      kilnHome: h.kilnHome,
    });
    expect(badTrack.exitCode).toBe(2);
    expect(badTrack.stderr).toContain("Post-MVP");

    const badSpace = await runCli(["draft", "bad", "--space", "../escape"], {
      kilnHome: h.kilnHome,
    });
    expect(badSpace.exitCode).toBe(2);

    // Offline status on a non-existent kilnHome stays read-only and does not create index.sqlite
    const emptyKilnHome = path.join(h.root, "nonexistent-kiln-home");
    const emptyStatus = await runCli(["status"], {
      kilnHome: emptyKilnHome,
      isDaemonRunning: () => false,
    });
    expect(emptyStatus.exitCode).toBe(0);
    expect(emptyStatus.stdout).toContain("Daemon: offline");
    expect(fs.existsSync(emptyKilnHome)).toBe(false);
  });

  it("lists pending decisions and submits chosen option with and without --apply-ledger", async () => {
    const h = makeTestHarness();
    h.server.stateMachine.createTask(makeTaskCard({ id: "t-dec-1" }), "# Decide test");
    h.server.persistRunForDispatch(
      makeRunMeta({ task_id: "t-dec-1", run_id: "run-dec-1" }),
      "001-implement",
    );

    const workerToken1 = h.server.issueRunToken({
      taskId: "t-dec-1",
      runId: "run-dec-1",
      role: "worker",
      contractVersion: 1,
    });
    const ask1 = await h.server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${workerToken1}` },
      rawBody: JSON.stringify({
        category: "scope",
        reason: "Need RSS feed format confirmation",
        question: "Which feed format should we generate?",
        options: [
          {
            id: "opt-atom-rss",
            label: "Generate RSS 2.0 + Atom with full content",
            action: "resume",
            recommended: true,
            ledger_rule: "Always emit full-text RSS 2.0 feeds",
          },
          {
            id: "opt-cancel",
            label: "Abort task",
            action: "cancel",
            recommended: false,
          },
        ],
      }),
    });
    expect(ask1.status).toBe(200);
    h.server.pendingDecisions.hydrateFromDisk();

    const fetchImpl = createInProcessFetch(h.server);

    // 1. `kiln decide` lists pending decisions and highlights recommended option
    const listRes = await runCli(["decide"], {
      kilnHome: h.kilnHome,
      fetchImpl,
    });
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain("t-dec-1");
    expect(listRes.stdout).toContain("opt-atom-rss [recommended]");
    expect(listRes.stdout).toContain("opt-cancel (cancel)");

    // 2. Submit without `--apply-ledger` transitions state without polluting ledger/<space>.yaml
    const submit1 = await runCli(
      [
        "decide",
        "t-dec-1",
        "--option",
        "opt-atom-rss",
        "--rationale",
        "Proceed with full-text feed",
      ],
      {
        kilnHome: h.kilnHome,
        fetchImpl,
      },
    );
    expect(submit1.exitCode).toBe(0);
    expect(submit1.stdout).toContain("status=queued");
    expect(submit1.stdout).toContain("(contract v1)");
    expect(submit1.stdout).not.toContain("vundefined");
    expect(h.server.store.getTaskIndex("t-dec-1")?.status).toBe("queued");
    expect(h.server.store.readLedger("kiln")).toBeNull();

    // 3. Submit a second decision WITH `--apply-ledger` and verify ledger/<space>.yaml persists
    h.server.persistRunForDispatch(
      makeRunMeta({ task_id: "t-dec-1", run_id: "run-dec-2", round: 2 }),
      "002-implement",
    );
    const workerToken2 = h.server.issueRunToken({
      taskId: "t-dec-1",
      runId: "run-dec-2",
      role: "worker",
      contractVersion: 1,
    });
    const ask2 = await h.server.invokeMcpRpc({
      method: "POST",
      url: "/rpc/mcp/wb_ask_decision",
      headers: { Authorization: `Bearer ${workerToken2}` },
      rawBody: JSON.stringify({
        category: "convention",
        reason: "Record RSS convention",
        question: "Persist RSS rule to space ledger?",
        options: [
          {
            id: "opt-record",
            label: "Resume and save convention",
            action: "resume",
            recommended: true,
            ledger_rule: "Always emit full-text RSS 2.0 feeds",
          },
        ],
      }),
    });
    expect(ask2.status).toBe(200);

    const submit2 = await runCli(
      ["decide", "t-dec-1", "--option", "opt-record", "--apply-ledger"],
      {
        kilnHome: h.kilnHome,
        fetchImpl,
      },
    );
    expect(submit2.exitCode).toBe(0);
    expect(submit2.stdout).toContain("(contract v1)");
    expect(submit2.stdout).not.toContain("vundefined");
    expect(submit2.stdout).toContain("Ledger rule recorded");
    const ledger = h.server.store.readLedger("kiln");
    expect(ledger?.entries).toHaveLength(1);
    expect(ledger?.entries[0]?.rule).toBe("Always emit full-text RSS 2.0 feeds");

    // 4. Rejects missing task-id when --option is specified
    const missingTask = await runCli(["decide", "--option", "opt-record"], {
      kilnHome: h.kilnHome,
      fetchImpl,
    });
    expect(missingTask.exitCode).toBe(2);
  });

  it("runs kiln doctor checking real Node >= 22, git --version, temp APFS clone, kilnd, and service status", async () => {
    const h = makeTestHarness();
    const fetchImpl = createInProcessFetch(h.server);

    const beforeTmpCount = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("kiln-doctor-apfs-")).length;

    const docRes = await runCli(["doctor"], {
      kilnHome: h.kilnHome,
      homeDir: h.homeDir,
      launchAgentsDir: h.launchAgentsDir,
      systemdDir: h.systemdDir,
      fetchImpl,
    });
    expect(docRes.exitCode).toBe(0);
    expect(docRes.stdout).toContain("node:");
    expect(docRes.stdout).toContain("git version");
    expect(docRes.stdout).toContain("kilnd is online");

    const afterTmpCount = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("kiln-doctor-apfs-")).length;
    expect(afterTmpCount).toBe(beforeTmpCount);

    const report = docRes.data as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean; status: string; meta?: Record<string, unknown> }>;
    };
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "node")?.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "git")?.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "kilnd")?.ok).toBe(true);
    if (process.platform === "darwin") {
      expect(report.checks.find((c) => c.id === "apfs_clone")?.ok).toBe(true);
      expect(report.checks.find((c) => c.id === "apfs_clone")?.meta?.supported).toBe(true);
    }

    // Fails cleanly if Node version < 22
    const oldNode = await runCli(["doctor"], {
      kilnHome: h.kilnHome,
      homeDir: h.homeDir,
      launchAgentsDir: h.launchAgentsDir,
      systemdDir: h.systemdDir,
      fetchImpl,
      nodeVersion: "20.18.0",
    });
    expect(oldNode.exitCode).toBe(1);
    expect(oldNode.stdout).toContain("[FAIL] node");

    // Fails cleanly if git is unavailable
    const missingGit = await runCli(["doctor"], {
      kilnHome: h.kilnHome,
      homeDir: h.homeDir,
      launchAgentsDir: h.launchAgentsDir,
      systemdDir: h.systemdDir,
      fetchImpl,
      platform: "linux",
      execFileImpl: async () => {
        throw new Error("spawn git ENOENT");
      },
    });
    expect(missingGit.exitCode).toBe(1);
    expect(missingGit.stdout).toContain("[FAIL] git");
  });

  it("installs, inspects, and cleanly uninstalls macOS LaunchAgent and Linux systemd services with escaping", async () => {
    const h = makeTestHarness();
    const specialKilnHome = path.join(h.root, `Kiln & "Work" <dir>'1`);

    // Direct XML escaping & control-char injection guards
    const plist = renderLaunchAgentPlist({
      nodeExecutable: "/usr/local/bin/node",
      kilndEntrypoint: "/opt/kiln/dist/bin.js",
      kilnHome: specialKilnHome,
      logDir: path.join(specialKilnHome, "logs"),
    });
    expect(plist).toContain("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    expect(plist).toContain(`<string>${MACOS_LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain(
      "<string>/usr/local/bin/node</string>",
    );
    expect(plist).toContain(
      "<string>/opt/kiln/dist/bin.js</string>",
    );
    expect(plist).toContain(
      "Kiln &amp; &quot;Work&quot; &lt;dir&gt;&apos;1",
    );
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(() =>
      renderLaunchAgentPlist({
        nodeExecutable: "/usr/bin/node",
        kilndEntrypoint: "/app/bin.js",
        kilnHome: "/tmp/bad\n<key>Inject</key>",
        logDir: "/tmp/logs",
      }),
    ).toThrow(/control characters/i);

    const unit = renderSystemdUnit({
      nodeExecutable: "/usr/bin/node",
      kilndEntrypoint: "/opt/my kiln/bin.js",
      kilnHome: "/tmp/kiln%home",
      logDir: "/tmp/logs",
    });
    expect(unit).toContain('Environment="KILN_HOME=/tmp/kiln%%home"');
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/my kiln/bin.js"');
    expect(() =>
      renderSystemdUnit({
        nodeExecutable: "/usr/bin/node",
        kilndEntrypoint: "/app/bin.js",
        kilnHome: "/tmp/bad\nExecStart=/bin/evil",
      }),
    ).toThrow(/control characters/i);

    // macOS CLI service install -> status -> uninstall
    const macInstall = await runCli(["service", "install", "--platform", "darwin"], {
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      launchAgentsDir: h.launchAgentsDir,
    });
    expect(macInstall.exitCode).toBe(0);
    expect(fs.existsSync(h.plistPath)).toBe(true);
    const macContent = fs.readFileSync(h.plistPath, "utf8");
    expect(macContent).toContain(`<string>${h.kilnHome}</string>`);
    expect(macContent).toContain("<string>up</string>");
    expect(macContent).toContain("<string>--foreground</string>");
    expect((macInstall.data as { executedControl: boolean }).executedControl).toBe(false);

    const macStatus1 = await runCli(["service", "status", "--platform", "darwin"], {
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      launchAgentsDir: h.launchAgentsDir,
    });
    expect(macStatus1.exitCode).toBe(0);
    expect(macStatus1.stdout).toContain("installed");
    expect((macStatus1.data as { installed: boolean }).installed).toBe(true);

    const macUninstall = await runCli(["service", "uninstall", "--platform", "darwin"], {
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      launchAgentsDir: h.launchAgentsDir,
    });
    expect(macUninstall.exitCode).toBe(0);
    expect(fs.existsSync(h.plistPath)).toBe(false);
    expect(
      getServiceStatus({
        platform: "darwin",
        homeDir: h.homeDir,
        launchAgentsDir: h.launchAgentsDir,
      }).installed,
    ).toBe(false);

    // Idempotent second uninstall
    const macUninstall2 = await uninstallService({
      platform: "darwin",
      homeDir: h.homeDir,
      launchAgentsDir: h.launchAgentsDir,
    });
    expect(macUninstall2.removed).toBe(false);

    // Linux CLI service install -> status -> uninstall
    const linuxInstall = await runCli(["service", "install", "--platform", "linux"], {
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      systemdDir: h.systemdDir,
    });
    expect(linuxInstall.exitCode).toBe(0);
    expect(fs.existsSync(h.systemdPath)).toBe(true);
    const linuxContent = fs.readFileSync(h.systemdPath, "utf8");
    expect(linuxContent).toContain(`Environment="KILN_HOME=${h.kilnHome}"`);
    expect(linuxContent).toContain('"up" "--foreground"');

    const linuxStatus = await runCli(["service", "status", "--platform", "linux"], {
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      systemdDir: h.systemdDir,
    });
    expect(linuxStatus.exitCode).toBe(0);
    expect((linuxStatus.data as { installed: boolean }).installed).toBe(true);

    const linuxUninstall = await runCli(["service", "uninstall", "--platform", "linux"], {
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      systemdDir: h.systemdDir,
    });
    expect(linuxUninstall.exitCode).toBe(0);
    expect(fs.existsSync(h.systemdPath)).toBe(false);

    // Verify optional executeSystemControl hook is called only when explicitly supplied
    const controlCalls: Array<{ command: string; args: readonly string[] }> = [];
    await installService({
      platform: "darwin",
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      launchAgentsDir: h.launchAgentsDir,
      executeSystemControl: (command, args) => {
        controlCalls.push({ command, args });
      },
    });
    await uninstallService({
      platform: "darwin",
      homeDir: h.homeDir,
      launchAgentsDir: h.launchAgentsDir,
      executeSystemControl: (command, args) => {
        controlCalls.push({ command, args });
      },
    });
    expect(controlCalls).toEqual([
      { command: "launchctl", args: ["load", "-w", h.plistPath] },
      { command: "launchctl", args: ["unload", "-w", h.plistPath] },
    ]);
  });

  it("uninstalls cleanly while preserving kilnHome and dirty worktrees by default, and deletes kilnHome with --purge-data", async () => {
    const h = makeTestHarness();
    h.server.stateMachine.createTask(makeTaskCard(), "# Keep me");
    h.server.store.writeLedger({
      schema_version: 1,
      space: "demo",
      entries: [
        {
          id: "led-1",
          space: "demo",
          rule: "Preserve historical ledger",
          source_task_id: "t-cli-1",
          created_at: "2026-11-19T10:00:00.000Z",
        },
      ],
    });

    // Create a real temp git repo + dirty Kiln worktree registered in spaces/demo/space.yaml
    const repoPath = path.join(h.root, "demo-repo");
    const wtPath = path.join(h.root, "demo-wt-dirty");
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "config", "user.name", "Kiln Test"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "config", "user.email", "kiln@example.com"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "worktree", "add", "-b", "kiln/t-dirty", wtPath, "HEAD"], { stdio: "pipe" });
    const dirtyFile = path.join(wtPath, "uncommitted.txt");
    fs.writeFileSync(dirtyFile, "do not delete me\n", "utf8");

    const cleanWtPath = path.join(h.kilnHome, "workspaces", "t-clean", "worktree");
    fs.mkdirSync(path.dirname(cleanWtPath), { recursive: true });
    execFileSync("git", ["-C", repoPath, "worktree", "add", "-b", "kiln/t-clean", cleanWtPath, "HEAD"], { stdio: "pipe" });

    h.server.store.writeSpace({
      schema_version: 1,
      id: "demo",
      name: "Demo Repo",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });

    await installService({
      platform: "darwin",
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      launchAgentsDir: h.launchAgentsDir,
    });
    writeFileAtomic(resolveKilnPidPath(h.kilnHome), "43210\n");

    let stopCalled = false;
    const preserveRes = await runCli(["uninstall", "--platform", "darwin"], {
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      launchAgentsDir: h.launchAgentsDir,
      stopDaemon: () => {
        stopCalled = true;
        return true;
      },
    });

    expect(preserveRes.exitCode).toBe(0);
    expect(stopCalled).toBe(true);
    expect(fs.existsSync(h.plistPath)).toBe(false);
    expect(fs.existsSync(resolveKilnPidPath(h.kilnHome))).toBe(false);
    // Data and dirty worktree MUST remain intact; clean worktree was cleanly removed!
    expect(fs.existsSync(h.kilnHome)).toBe(true);
    expect(fs.existsSync(dirtyFile)).toBe(true);
    expect(fs.existsSync(cleanWtPath)).toBe(false);
    expect(preserveRes.stdout).toContain("Data preserved");
    expect(preserveRes.stdout).toContain("dirty (preserved)");
    expect(preserveRes.stdout).toContain("clean (removed)");

    // Close store before --purge-data removes kilnHome
    await h.server.stop();

    await installService({
      platform: "darwin",
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      launchAgentsDir: h.launchAgentsDir,
    });
    const purgeRes = await runCli(["uninstall", "--platform", "darwin", "--purge-data"], {
      homeDir: h.homeDir,
      kilnHome: h.kilnHome,
      launchAgentsDir: h.launchAgentsDir,
    });
    expect(purgeRes.exitCode).toBe(0);
    expect(fs.existsSync(h.plistPath)).toBe(false);
    expect(fs.existsSync(h.kilnHome)).toBe(false);
    expect(purgeRes.stdout).toContain("Data purged");
    // Dirty worktree outside kilnHome is still untouched
    expect(fs.existsSync(dirtyFile)).toBe(true);
  });

  it("returns non-zero exit codes and help text for unknown commands and invalid flags", async () => {
    const unknownCmd = await runCli(["nonexistent"]);
    expect(unknownCmd.exitCode).toBe(2);
    expect(unknownCmd.stderr).toContain('Unknown command "nonexistent"');
    expect(unknownCmd.stderr).toContain("Usage:");

    const badFlag = await runCli(["status", "--unknown-flag"]);
    expect(badFlag.exitCode).toBe(2);
    expect(badFlag.stderr).toContain("Usage: kiln status");

    const badPort = await runCli(["up", "--port", "abc"]);
    expect(badPort.exitCode).toBe(2);
    expect(badPort.stderr).toContain("Invalid --port");

    const bgZeroPort = await runCli(["up", "--port", "0"]);
    expect(bgZeroPort.exitCode).toBe(2);
    expect(bgZeroPort.stderr).toContain("Invalid --port");

    const badService = await runCli(["service"]);
    expect(badService.exitCode).toBe(2);
    expect(badService.stderr).toContain("service requires one action");

    const helpRes = await runCli(["--help"]);
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain("Kiln CLI");
  });
});
