import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PricingConfig, RunMeta, TaskCard } from "@kiln/protocol";
import {
  BackendRegistry,
  FakeBackend,
  KilndServer,
  realpathCanonical,
  writeFileAtomic,
  type ExecutionBackend,
} from "@kiln/kernel";
import {
  LINUX_SYSTEMD_SERVICE_NAME,
  MACOS_LAUNCH_AGENT_LABEL,
  WINDOWS_RUN_REGISTRY_KEY,
  WINDOWS_RUN_VALUE_NAME,
  buildDaemonForegroundArgs,
  getServiceStatus,
  installService,
  readNewLogTail,
  renderLaunchAgentPlist,
  renderSystemdUnit,
  renderWindowsRunCommand,
  resolveKilnPidPath,
  resolveKilnShutdownTokenPath,
  runCli,
  stopManagedDaemon,
  uninstallService,
  type DoctorReport,
  type WindowsRegistryBackend,
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
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
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
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain(`<string>${MACOS_LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/kiln/dist/bin.js</string>");
    expect(plist).toContain("Kiln &amp; &quot;Work&quot; &lt;dir&gt;&apos;1");
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
    expect(linuxContent).toContain(`Environment="KILN_HOME=${h.kilnHome.replace(/\\/g, "\\\\")}"`);
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
    execFileSync("git", ["-C", repoPath, "config", "user.email", "kiln@example.com"], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "init"], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", repoPath, "worktree", "add", "-b", "kiln/t-dirty", wtPath, "HEAD"], {
      stdio: "pipe",
    });
    const dirtyFile = path.join(wtPath, "uncommitted.txt");
    fs.writeFileSync(dirtyFile, "do not delete me\n", "utf8");

    const cleanWtPath = path.join(h.kilnHome, "workspaces", "t-clean", "worktree");
    fs.mkdirSync(path.dirname(cleanWtPath), { recursive: true });
    execFileSync(
      "git",
      ["-C", repoPath, "worktree", "add", "-b", "kiln/t-clean", cleanWtPath, "HEAD"],
      { stdio: "pipe" },
    );

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

  it("registers PaseoBackend on `kiln up --foreground`, forwards url/password, exposes /api/agents, and disposes on abort or start failure", async () => {
    const createDisposableFakePaseo = (disposeCounter: { count: number }): ExecutionBackend => {
      const inner = new FakeBackend({ backendId: "paseo" });
      return Object.assign(inner, {
        dispose: async (): Promise<void> => {
          disposeCounter.count += 1;
        },
      });
    };

    const startForegroundAndWaitReady = (
      args: readonly string[],
      extraOpts: Parameters<typeof runCli>[1],
    ): {
      runPromise: ReturnType<typeof runCli>;
      serverReady: Promise<KilndServer>;
    } => {
      let resolveServer!: (srv: KilndServer) => void;
      let rejectServer!: (err: unknown) => void;
      const serverReady = new Promise<KilndServer>((resolve, reject) => {
        resolveServer = resolve;
        rejectServer = reject;
      });
      const runPromise = runCli(args, {
        isDaemonRunning: () => false,
        ...extraOpts,
        onForegroundServer: (srv) => {
          extraOpts?.onForegroundServer?.(srv);
          resolveServer(srv);
        },
      });
      void runPromise.then(
        (res) => {
          if (res.exitCode !== 0) {
            rejectServer(new Error(`kiln up exited early (${res.exitCode}): ${res.stderr}`));
          }
        },
        (err) => rejectServer(err),
      );
      return { runPromise, serverReady };
    };

    const savedUrl = process.env.PASEO_URL;
    const savedPassword = process.env.PASEO_PASSWORD;
    const savedDisable = process.env.KILN_DISABLE_PASEO;

    try {
      process.env.PASEO_URL = "ws://127.0.0.1:9797/ws";
      process.env.PASEO_PASSWORD = "paseo-secret-token";
      delete process.env.KILN_DISABLE_PASEO;

      // 1. Foreground startup registers Paseo backend, forwards url/password, exposes /api/agents, and disposes on abort
      const kilnHome1 = path.join(makeTempDir("kiln-fg-"), "kh");
      const receivedOpts: Array<{ url?: string; password?: string }> = [];
      const disposeCounter1 = { count: 0 };
      const ac1 = new AbortController();

      const fg1 = startForegroundAndWaitReady(
        ["up", "--foreground", "--port", "0", "--paseo-url", "wss://paseo.local:7777/ws"],
        {
          kilnHome: kilnHome1,
          foregroundSignal: ac1.signal,
          createPaseoBackend: (opts) => {
            receivedOpts.push(opts);
            return createDisposableFakePaseo(disposeCounter1);
          },
        },
      );

      const server1 = await fg1.serverReady;
      expect(receivedOpts).toEqual([
        { url: "wss://paseo.local:7777/ws", password: "paseo-secret-token" },
      ]);

      const agentsRes = await server1.app.request(new Request("http://127.0.0.1/api/agents"));
      expect(agentsRes.status).toBe(200);
      const agentsJson = (await agentsRes.json()) as {
        ok: boolean;
        backends: Array<{ backendId: string; connected: boolean }>;
        agents: Array<{ id: string; backendId: string }>;
      };
      expect(agentsJson.ok).toBe(true);
      expect(agentsJson.backends).toEqual(
        expect.arrayContaining([expect.objectContaining({ backendId: "paseo", connected: true })]),
      );
      expect(agentsJson.agents.some((a) => a.backendId === "paseo")).toBe(true);
      expect(disposeCounter1.count).toBe(0);

      ac1.abort();
      const fgResult = await fg1.runPromise;
      expect(fgResult.exitCode).toBe(0);
      expect(fgResult.stdout).toContain("kilnd listening in foreground");
      expect(disposeCounter1.count).toBe(1);
      expect(fs.existsSync(resolveKilnPidPath(kilnHome1))).toBe(false);

      // 2. Priority check: options.paseoUrl overrides process.env.PASEO_URL when CLI flag is omitted
      const kilnHome2 = path.join(makeTempDir("kiln-opt-"), "kh");
      const receivedOpts2: Array<{ url?: string; password?: string }> = [];
      const disposeCounter2 = { count: 0 };
      const ac2 = new AbortController();
      const fg2 = startForegroundAndWaitReady(["up", "--foreground", "--port", "0"], {
        kilnHome: kilnHome2,
        paseoUrl: "ws://127.0.0.1:8888/ws",
        foregroundSignal: ac2.signal,
        createPaseoBackend: (opts) => {
          receivedOpts2.push(opts);
          return createDisposableFakePaseo(disposeCounter2);
        },
      });
      await fg2.serverReady;
      expect(receivedOpts2).toEqual([
        { url: "ws://127.0.0.1:8888/ws", password: "paseo-secret-token" },
      ]);
      ac2.abort();
      const fgResult2 = await fg2.runPromise;
      expect(fgResult2.exitCode).toBe(0);
      expect(disposeCounter2.count).toBe(1);

      // 2b. Fallback check: process.env.PASEO_URL is forwarded when CLI flag and options.paseoUrl are omitted
      const kilnHomeEnv = path.join(makeTempDir("kiln-env-"), "kh");
      const receivedOptsEnv: Array<{ url?: string; password?: string }> = [];
      const disposeCounterEnv = { count: 0 };
      const acEnv = new AbortController();
      const fgEnv = startForegroundAndWaitReady(["up", "--foreground", "--port", "0"], {
        kilnHome: kilnHomeEnv,
        foregroundSignal: acEnv.signal,
        createPaseoBackend: (opts) => {
          receivedOptsEnv.push(opts);
          return createDisposableFakePaseo(disposeCounterEnv);
        },
      });
      await fgEnv.serverReady;
      expect(receivedOptsEnv).toEqual([
        { url: "ws://127.0.0.1:9797/ws", password: "paseo-secret-token" },
      ]);
      acEnv.abort();
      const fgResultEnv = await fgEnv.runPromise;
      expect(fgResultEnv.exitCode).toBe(0);
      expect(disposeCounterEnv.count).toBe(1);

      // 3. Failure path: server.start() throwing EADDRINUSE reliably invokes backendRegistry.disposeAll()
      const blocker = http.createServer((_req, res) => {
        res.statusCode = 500;
        res.end();
      });
      await new Promise<void>((resolve) => {
        blocker.listen(0, "127.0.0.1", () => resolve());
      });
      const busyPort = (blocker.address() as { port: number }).port;
      try {
        const kilnHomeFail = path.join(makeTempDir("kiln-fail-"), "kh");
        const disposeFailCounter = { count: 0 };
        const failRes = await runCli(
          ["up", "--foreground", "--host", "127.0.0.1", "--port", String(busyPort)],
          {
            kilnHome: kilnHomeFail,
            isDaemonRunning: () => false,
            createPaseoBackend: () => createDisposableFakePaseo(disposeFailCounter),
          },
        );
        expect(failRes.exitCode).toBe(1);
        expect(disposeFailCounter.count).toBe(1);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }

      // 4. External backendRegistry reuse (ownsRegistry = false) does NOT dispose caller registry on stop
      const externalRegistry = new BackendRegistry();
      const externalDisposeCounter = { count: 0 };
      externalRegistry.register(createDisposableFakePaseo(externalDisposeCounter));
      const kilnHomeExt = path.join(makeTempDir("kiln-ext-"), "kh");
      const acExt = new AbortController();
      const fgExt = startForegroundAndWaitReady(["up", "--foreground", "--port", "0"], {
        kilnHome: kilnHomeExt,
        backendRegistry: externalRegistry,
        foregroundSignal: acExt.signal,
      });
      await fgExt.serverReady;
      acExt.abort();
      const fgExtRes = await fgExt.runPromise;
      expect(fgExtRes.exitCode).toBe(0);
      expect(externalDisposeCounter.count).toBe(0);
    } finally {
      if (savedUrl === undefined) delete process.env.PASEO_URL;
      else process.env.PASEO_URL = savedUrl;
      if (savedPassword === undefined) delete process.env.PASEO_PASSWORD;
      else process.env.PASEO_PASSWORD = savedPassword;
      if (savedDisable === undefined) delete process.env.KILN_DISABLE_PASEO;
      else process.env.KILN_DISABLE_PASEO = savedDisable;
    }
  });

  it("supports --no-paseo, KILN_DISABLE_PASEO=1, validates --paseo-url, and builds spawn passthrough args", async () => {
    const savedDisable = process.env.KILN_DISABLE_PASEO;
    const savedUrl = process.env.PASEO_URL;

    try {
      delete process.env.KILN_DISABLE_PASEO;
      delete process.env.PASEO_URL;

      // 1. Invalid --paseo-url returns exitCode 2
      const badHttp = await runCli(["up", "--paseo-url", "http://bad"]);
      expect(badHttp.exitCode).toBe(2);
      expect(badHttp.stderr).toContain("Invalid --paseo-url");

      const emptyFlag = await runCli(["up", "--paseo-url", ""]);
      expect(emptyFlag.exitCode).toBe(2);
      expect(emptyFlag.stderr).toContain("Invalid --paseo-url");

      process.env.PASEO_URL = "http://127.0.0.1:6767/ws";
      const badEnvUrl = await runCli(["up"]);
      expect(badEnvUrl.exitCode).toBe(2);
      expect(badEnvUrl.stderr).toContain("Invalid --paseo-url");
      delete process.env.PASEO_URL;

      // 2. --no-paseo skips createPaseoBackend and leaves /api/agents empty
      let factoryCalls = 0;
      const kh1 = path.join(makeTempDir("kiln-nop-"), "kh");
      const ac1 = new AbortController();
      let resolveSrv1!: (srv: KilndServer) => void;
      const ready1 = new Promise<KilndServer>((resolve) => {
        resolveSrv1 = resolve;
      });
      const p1 = runCli(["up", "--foreground", "--port", "0", "--no-paseo"], {
        kilnHome: kh1,
        isDaemonRunning: () => false,
        foregroundSignal: ac1.signal,
        onForegroundServer: (srv) => resolveSrv1(srv),
        createPaseoBackend: () => {
          factoryCalls += 1;
          return new FakeBackend({ backendId: "paseo" });
        },
      });
      const srv1 = await ready1;
      const res1 = await srv1.app.request(new Request("http://127.0.0.1/api/agents"));
      const body1 = (await res1.json()) as { backends: unknown[]; agents: unknown[] };
      expect(body1.backends).toEqual([]);
      expect(body1.agents).toEqual([]);
      expect(factoryCalls).toBe(0);
      ac1.abort();
      expect((await p1).exitCode).toBe(0);

      // 3. KILN_DISABLE_PASEO=1 skips createPaseoBackend
      process.env.KILN_DISABLE_PASEO = "1";
      const kh2 = path.join(makeTempDir("kiln-envd-"), "kh");
      const ac2 = new AbortController();
      let resolveSrv2!: (srv: KilndServer) => void;
      const ready2 = new Promise<KilndServer>((resolve) => {
        resolveSrv2 = resolve;
      });
      const p2 = runCli(["up", "--foreground", "--port", "0"], {
        kilnHome: kh2,
        isDaemonRunning: () => false,
        foregroundSignal: ac2.signal,
        onForegroundServer: (srv) => resolveSrv2(srv),
        createPaseoBackend: () => {
          factoryCalls += 1;
          return new FakeBackend({ backendId: "paseo" });
        },
      });
      await ready2;
      expect(factoryCalls).toBe(0);
      ac2.abort();
      expect((await p2).exitCode).toBe(0);

      // 4. Detached spawn argument passthrough construction
      expect(
        buildDaemonForegroundArgs({
          entrypoint: "/opt/kiln/bin.js",
          host: "127.0.0.1",
          port: 4310,
        }),
      ).toEqual([
        "/opt/kiln/bin.js",
        "up",
        "--foreground",
        "--host",
        "127.0.0.1",
        "--port",
        "4310",
      ]);

      expect(
        buildDaemonForegroundArgs({
          entrypoint: "/opt/kiln/bin.js",
          host: "127.0.0.1",
          port: 4310,
          paseoUrl: "ws://127.0.0.1:7777/ws",
          disablePaseo: true,
        }),
      ).toEqual([
        "/opt/kiln/bin.js",
        "up",
        "--foreground",
        "--host",
        "127.0.0.1",
        "--port",
        "4310",
        "--paseo-url",
        "ws://127.0.0.1:7777/ws",
        "--no-paseo",
      ]);
    } finally {
      if (savedDisable === undefined) delete process.env.KILN_DISABLE_PASEO;
      else process.env.KILN_DISABLE_PASEO = savedDisable;
      if (savedUrl === undefined) delete process.env.PASEO_URL;
      else process.env.PASEO_URL = savedUrl;
    }
  });

  it("reports Paseo check in `kiln doctor --json` for connected (pass), disconnected/empty (warn), and offline kilnd (skip)", async () => {
    // 1. Connected Paseo backend -> pass
    const root1 = makeTempDir("kiln-doc-pass-");
    const registry = new BackendRegistry();
    registry.register(new FakeBackend({ backendId: "paseo" }));
    const connectedServer = new KilndServer({
      kilnHome: path.join(root1, "kiln-home"),
      port: 0,
      tokenSecret: "cli-doc-secret-0123456789abcdef",
      backendRegistry: registry,
    });
    servers.push(connectedServer);

    const passRes = await runCli(["doctor", "--json"], {
      kilnHome: path.join(root1, "kiln-home"),
      homeDir: path.join(root1, "home"),
      launchAgentsDir: path.join(root1, "home", "Library", "LaunchAgents"),
      systemdDir: path.join(root1, "home", ".config", "systemd", "user"),
      fetchImpl: createInProcessFetch(connectedServer),
    });
    expect(passRes.exitCode).toBe(0);
    const passReport = JSON.parse(passRes.stdout) as DoctorReport;
    const passPaseo = passReport.checks.find((c) => c.id === "paseo");
    expect(passPaseo).toBeDefined();
    expect(passPaseo?.ok).toBe(true);
    expect(passPaseo?.required).toBe(false);
    expect(passPaseo?.status).toBe("pass");
    expect(passPaseo?.detail).toContain("paseo");
    expect(passPaseo?.detail).toContain("codex");
    expect(passPaseo?.meta).toMatchObject({
      connected: true,
      backends: expect.arrayContaining([
        expect.objectContaining({ backendId: "paseo", connected: true }),
      ]),
      agents: expect.arrayContaining([
        expect.objectContaining({ id: "codex", backendId: "paseo" }),
      ]),
    });

    // 2. Empty / disconnected backends -> warn (still exitCode 0 because required: false)
    const hEmpty = makeTestHarness("kiln-doc-warn-");
    const emptyRes = await runCli(["doctor", "--json"], {
      kilnHome: hEmpty.kilnHome,
      homeDir: hEmpty.homeDir,
      launchAgentsDir: hEmpty.launchAgentsDir,
      systemdDir: hEmpty.systemdDir,
      fetchImpl: createInProcessFetch(hEmpty.server),
    });
    expect(emptyRes.exitCode).toBe(0);
    const emptyReport = JSON.parse(emptyRes.stdout) as DoctorReport;
    const emptyPaseo = emptyReport.checks.find((c) => c.id === "paseo");
    expect(emptyPaseo).toMatchObject({
      id: "paseo",
      ok: false,
      required: false,
      status: "warn",
    });
    expect(emptyPaseo?.detail).toContain("PASEO_URL");

    // Disconnected backend response -> warn
    const disconnectedFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ ok: true, pid: 1234, version: "0.1.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/agents")) {
        return new Response(
          JSON.stringify({
            ok: true,
            agents: [],
            backends: [
              {
                backendId: "paseo",
                id: "paseo",
                connected: false,
                status: "disconnected",
                detail: "connect ECONNREFUSED 127.0.0.1:6767",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const discRes = await runCli(["doctor", "--json"], {
      kilnHome: hEmpty.kilnHome,
      homeDir: hEmpty.homeDir,
      launchAgentsDir: hEmpty.launchAgentsDir,
      systemdDir: hEmpty.systemdDir,
      fetchImpl: disconnectedFetch,
    });
    expect(discRes.exitCode).toBe(0);
    const discReport = JSON.parse(discRes.stdout) as DoctorReport;
    expect(discReport.checks.find((c) => c.id === "paseo")).toMatchObject({
      id: "paseo",
      ok: false,
      required: false,
      status: "warn",
    });

    // Non-2xx /api/agents response -> warn (still exitCode 0)
    const agentsErrorFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ ok: true, pid: 1234, version: "0.1.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("backend error", { status: 503 });
    };
    const errRes = await runCli(["doctor", "--json"], {
      kilnHome: hEmpty.kilnHome,
      homeDir: hEmpty.homeDir,
      launchAgentsDir: hEmpty.launchAgentsDir,
      systemdDir: hEmpty.systemdDir,
      fetchImpl: agentsErrorFetch,
    });
    expect(errRes.exitCode).toBe(0);
    const errReport = JSON.parse(errRes.stdout) as DoctorReport;
    expect(errReport.checks.find((c) => c.id === "paseo")).toMatchObject({
      id: "paseo",
      ok: false,
      required: false,
      status: "warn",
    });

    // 3. Offline kilnd -> skip (still exitCode 0)
    const offlineRes = await runCli(["doctor", "--json"], {
      kilnHome: hEmpty.kilnHome,
      homeDir: hEmpty.homeDir,
      launchAgentsDir: hEmpty.launchAgentsDir,
      systemdDir: hEmpty.systemdDir,
      isDaemonRunning: () => false,
    });
    expect(offlineRes.exitCode).toBe(0);
    const offlineReport = JSON.parse(offlineRes.stdout) as DoctorReport;
    expect(offlineReport.checks.find((c) => c.id === "paseo")).toEqual({
      id: "paseo",
      ok: false,
      required: false,
      status: "skip",
      detail: "Paseo check skipped because kilnd is offline",
    });
  });

  it("manages project spaces via `kiln space add/list/rm` in both online and offline modes and rejects non-git, reserved IDs, and busy spaces", async () => {
    const h = makeTestHarness("kiln-cli-space-");
    const repoPath = path.join(h.root, "My-Repo");
    const nonGitDir = path.join(h.root, "not-git");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.mkdirSync(nonGitDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "my-repo", scripts: { test: "vitest run" } }),
    );
    fs.writeFileSync(path.join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "config", "user.name", "Kiln Test"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "config", "user.email", "kiln@example.com"], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", repoPath, "commit", "-m", "init"], { stdio: "pipe" });

    const canonicalRepo = realpathCanonical(repoPath);

    // 1. Offline add (passing subdirectory auto-normalizes to repo root), list --json, and rm
    const offlineAdd = await runCli(["space", "add", path.join(repoPath, "src"), "--json"], {
      kilnHome: h.kilnHome,
      isDaemonRunning: () => false,
    });
    expect(offlineAdd.exitCode).toBe(0);
    const offlineAdded = JSON.parse(offlineAdd.stdout) as {
      mode: string;
      space: { id: string; repo_path: string; default_branch: string; default_accept_cmd: string };
    };
    expect(offlineAdded.mode).toBe("offline");
    expect(offlineAdded.space.id).toBe("my-repo");
    expect(offlineAdded.space.repo_path).toBe(canonicalRepo);
    expect(offlineAdded.space.default_branch).toBe("main");
    expect(offlineAdded.space.default_accept_cmd).toBe("pnpm test");

    const offlineList = await runCli(["space", "list", "--json"], {
      kilnHome: h.kilnHome,
      isDaemonRunning: () => false,
    });
    expect(offlineList.exitCode).toBe(0);
    expect(JSON.parse(offlineList.stdout).spaces).toHaveLength(1);

    // Non-git path & reserved IDs fail cleanly
    const badGitAdd = await runCli(["space", "add", nonGitDir], {
      kilnHome: h.kilnHome,
      isDaemonRunning: () => false,
    });
    expect(badGitAdd.exitCode).toBe(1);
    expect(badGitAdd.stderr).toContain("not inside a Git repository");

    const reservedAdd = await runCli(["space", "add", repoPath, "--id", "local"], {
      kilnHome: h.kilnHome,
      isDaemonRunning: () => false,
    });
    expect(reservedAdd.exitCode).toBe(2);
    expect(reservedAdd.stderr).toContain("reserved");

    // 2. Online add/list/rm via KilndServer HTTP API, plus refusal when active task remains
    await h.server.start();
    const fetchImpl = createInProcessFetch(h.server);

    const onlineAdd = await runCli(
      ["space", "add", repoPath, "--id", "online-proj", "--name", "Online Proj", "--json"],
      { kilnHome: h.kilnHome, fetchImpl },
    );
    expect(onlineAdd.exitCode).toBe(0);
    expect(JSON.parse(onlineAdd.stdout).mode).toBe("online");

    const onlineList = await runCli(["space", "list"], {
      kilnHome: h.kilnHome,
      fetchImpl,
    });
    expect(onlineList.exitCode).toBe(0);
    expect(onlineList.stdout).toContain("online-proj (Online Proj)");

    h.server.stateMachine.createTask(
      makeTaskCard({ id: "t-busy-space", space: "online-proj" }),
      "# Busy space task",
    );
    const busyRm = await runCli(["space", "rm", "online-proj"], {
      kilnHome: h.kilnHome,
      fetchImpl,
    });
    expect(busyRm.exitCode).toBe(1);
    expect(busyRm.stderr).toContain("未完成任务");

    h.server.stateMachine.cancelTask("t-busy-space");
    const onlineRm = await runCli(["space", "rm", "online-proj"], {
      kilnHome: h.kilnHome,
      fetchImpl,
    });
    expect(onlineRm.exitCode).toBe(0);
    expect(h.server.store.readSpace("online-proj")).toBeNull();

    // Offline rm on previously added space with active task also blocked until cancelled
    h.server.stateMachine.createTask(
      makeTaskCard({ id: "t-busy-offline", space: "my-repo" }),
      "# Offline busy",
    );
    const offlineBusyRm = await runCli(["space", "rm", "my-repo"], {
      kilnHome: h.kilnHome,
      isDaemonRunning: () => false,
    });
    expect(offlineBusyRm.exitCode).toBe(1);
    expect(offlineBusyRm.stderr).toContain("active task");
  });

  it("supports kiln remote status/enable/disable/pair/devices/revoke/tailscale with flags and --json", async () => {
    const root = makeTempDir("kiln-cli-remote-");
    const kilnHome = path.join(root, ".kiln");
    const server = new KilndServer({
      kilnHome,
      publicDir: null,
      tokenSecret: "cli-remote-test-secret-0123456789",
      tailscaleExecFile: async (_file, args) => {
        if (args[0] === "status") {
          return {
            stdout: JSON.stringify({
              BackendState: "Running",
              Self: { DNSName: "studio.tail77.ts.net." },
            }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({
            Web: {
              "studio.tail77.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:4411" } },
              },
            },
          }),
          stderr: "",
        };
      },
    });
    servers.push(server);
    const fetchImpl = createInProcessFetch(server);

    // 1. Default status (disabled, port 4311)
    const status0 = await runCli(["remote", "status", "--json"], {
      kilnHome,
      fetchImpl,
    });
    expect(status0.exitCode).toBe(0);
    const status0Json = JSON.parse(status0.stdout) as {
      remote: { enabled: boolean; remote_port: number };
      activeDeviceCount: number;
    };
    expect(status0Json.remote.enabled).toBe(false);
    expect(status0Json.remote.remote_port).toBe(4311);
    expect(status0Json.activeDeviceCount).toBe(0);

    // 2. Reject --remote-port colliding with --port
    const portConflict = await runCli(
      ["remote", "enable", "--port", "4310", "--remote-port", "4310"],
      { kilnHome, fetchImpl },
    );
    expect(portConflict.exitCode).toBe(2);
    expect(portConflict.stderr).toContain("must differ");

    // 3. Enable with custom --remote-port and --public-url
    const enableRes = await runCli(
      [
        "remote",
        "enable",
        "--remote-port",
        "4411",
        "--public-url",
        "https://studio.tail77.ts.net",
        "--json",
      ],
      { kilnHome, fetchImpl },
    );
    expect(enableRes.exitCode).toBe(0);
    const enableJson = JSON.parse(enableRes.stdout) as {
      data: { enabled: boolean; remote_port: number; public_url: string };
    };
    expect(enableJson.data.enabled).toBe(true);
    expect(enableJson.data.remote_port).toBe(4411);
    expect(enableJson.data.public_url).toBe("https://studio.tail77.ts.net");

    // 4. Tailscale inspection reflects configured remote port 4411
    const tsRes = await runCli(["remote", "tailscale", "--json"], {
      kilnHome,
      fetchImpl,
    });
    expect(tsRes.exitCode).toBe(0);
    const tsJson = JSON.parse(tsRes.stdout) as {
      installed: boolean;
      running: boolean;
      magicDnsUrl: string;
      serveConfiguredForPort: boolean;
      recommendedCommand: string;
    };
    expect(tsJson.installed).toBe(true);
    expect(tsJson.running).toBe(true);
    expect(tsJson.magicDnsUrl).toBe("https://studio.tail77.ts.net");
    expect(tsJson.serveConfiguredForPort).toBe(true);
    expect(tsJson.recommendedCommand).toBe("tailscale serve --bg http://127.0.0.1:4411");

    // 5. Pair -> returns 6-digit code, token, and #pair=<token> fragment URL
    const pair1 = await runCli(["remote", "pair", "--json"], {
      kilnHome,
      fetchImpl,
    });
    expect(pair1.exitCode).toBe(0);
    const pair1Json = JSON.parse(pair1.stdout) as {
      code: string;
      token: string;
      pairUrl: string;
    };
    expect(pair1Json.code).toMatch(/^\d{6}$/);
    expect(pair1Json.pairUrl).toBe(
      `https://studio.tail77.ts.net/#pair=${encodeURIComponent(pair1Json.token)}`,
    );

    // Complete pairing against remoteApp
    const complete1 = await server.remoteApp.request(
      new Request("http://127.0.0.1:4411/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pair1Json.code, label: "CLI Test Phone" }),
      }),
    );
    expect(complete1.status).toBe(200);
    const dev1Id = ((await complete1.json()) as { device: { id: string } }).device.id;

    // Pair a second device so we can test both single revoke and --all revoke
    const pair2 = await runCli(["remote", "pair", "--json"], { kilnHome, fetchImpl });
    const pair2Json = JSON.parse(pair2.stdout) as { token: string };
    const complete2 = await server.remoteApp.request(
      new Request("http://127.0.0.1:4411/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pair2Json.token, label: "CLI Test Tablet" }),
      }),
    );
    expect(complete2.status).toBe(200);

    // 6. List paired devices
    const devicesRes = await runCli(["remote", "devices", "--json"], {
      kilnHome,
      fetchImpl,
    });
    expect(devicesRes.exitCode).toBe(0);
    const devicesJson = JSON.parse(devicesRes.stdout) as {
      devices: Array<{ id: string; label: string; revoked_at?: string }>;
    };
    expect(devicesJson.devices).toHaveLength(2);

    // 7. Revoke single device
    const revokeOne = await runCli(["remote", "revoke", dev1Id, "--json"], {
      kilnHome,
      fetchImpl,
    });
    expect(revokeOne.exitCode).toBe(0);
    const revokeOneJson = JSON.parse(revokeOne.stdout) as {
      revoked: boolean;
      device: { id: string; revoked_at?: string };
    };
    expect(revokeOneJson.revoked).toBe(true);
    expect(revokeOneJson.device.id).toBe(dev1Id);
    expect(revokeOneJson.device.revoked_at).toBeTruthy();

    // 8. Revoke remaining devices with --all
    const revokeAll = await runCli(["remote", "revoke", "--all", "--json"], {
      kilnHome,
      fetchImpl,
    });
    expect(revokeAll.exitCode).toBe(0);
    const revokeAllJson = JSON.parse(revokeAll.stdout) as { revokedCount: number };
    expect(revokeAllJson.revokedCount).toBe(1);

    // 9. Disable remote access
    const disableRes = await runCli(["remote", "disable", "--json"], {
      kilnHome,
      fetchImpl,
    });
    expect(disableRes.exitCode).toBe(0);
    const disableJson = JSON.parse(disableRes.stdout) as {
      data: { enabled: boolean; remote_port: number };
    };
    expect(disableJson.data.enabled).toBe(false);
    expect(disableJson.data.remote_port).toBe(4411);

    // 10. Offline daemon reports clear error with exit code 1
    const offlineStatus = await runCli(["remote", "status"], {
      kilnHome,
      fetchImpl: createInProcessFetch(server, () => false),
    });
    expect(offlineStatus.exitCode).toBe(1);
    expect(offlineStatus.stderr).toContain("offline");
  });

  it("supports win32 user-level HKCU Run service install/status/uninstall, CommandLineToArgvW escaping, and kiln doctor", async () => {
    const h = makeTestHarness("kiln-cli-win-svc-");
    const regStore = new Map<string, string>();
    const fakeRegistry: WindowsRegistryBackend = {
      add(key, valueName, data) {
        regStore.set(`${key}\\${valueName}`, data);
      },
      delete(key, valueName) {
        return regStore.delete(`${key}\\${valueName}`);
      },
      query(key, valueName) {
        return regStore.get(`${key}\\${valueName}`) ?? null;
      },
    };

    // Strict Windows CommandLineToArgvW quoting & trailing backslash stripping
    const cmd = renderWindowsRunCommand({
      executable: "C:\\Program Files\\Kiln App\\kiln.exe",
      kilnHome: "C:\\Users\\Alice Smith\\.kiln\\",
    });
    expect(cmd).toBe(
      '"C:\\Program Files\\Kiln App\\kiln.exe" "up" --kiln-home "C:\\Users\\Alice Smith\\.kiln"',
    );

    const driveRootCmd = renderWindowsRunCommand({
      executable: "C:\\kiln.exe",
      kilnHome: "D:\\",
    });
    expect(driveRootCmd).toContain('--kiln-home "D:\\\\"');

    expect(() =>
      renderWindowsRunCommand({
        executable: "C:\\kiln.exe",
        kilnHome: "C:\\bad\n& calc.exe",
      }),
    ).toThrow(/control characters/i);

    // Rejects non-HKCU (admin/UAC) registry keys
    await expect(
      installService({
        platform: "win32",
        kilnHome: h.kilnHome,
        windowsRunKey: "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        windowsRegistry: fakeRegistry,
      }),
    ).rejects.toThrow(/HKCU/i);

    // `kiln up` NEVER installs Windows startup registry entry automatically
    const upRes = await runCli(["up", "--kiln-home", h.kilnHome, "--port", "4322"], {
      platform: "win32",
      windowsRegistry: fakeRegistry,
      isDaemonRunning: () => false,
      spawnDaemon: (ctx) => {
        expect(ctx.kilnHome).toBe(path.resolve(h.kilnHome));
        return { pid: 61234, port: 4322 };
      },
    });
    expect(upRes.exitCode).toBe(0);
    expect(regStore.size).toBe(0);

    // `kiln service install/status/uninstall --platform win32`
    const statusBefore = await runCli(["service", "status", "--platform", "win32"], {
      kilnHome: h.kilnHome,
      windowsRegistry: fakeRegistry,
    });
    expect(statusBefore.exitCode).toBe(0);
    expect((statusBefore.data as { installed: boolean }).installed).toBe(false);

    const installRes = await runCli(["service", "install", "--platform", "win32"], {
      kilnHome: h.kilnHome,
      windowsRegistry: fakeRegistry,
    });
    expect(installRes.exitCode).toBe(0);
    const expectedRegPath = `${WINDOWS_RUN_REGISTRY_KEY}\\${WINDOWS_RUN_VALUE_NAME}`;
    expect(regStore.has(expectedRegPath)).toBe(true);
    expect(regStore.get(expectedRegPath)).toContain("--kiln-home");
    expect(regStore.get(expectedRegPath)).toContain(path.resolve(h.kilnHome));

    const statusAfter = await runCli(["service", "status", "--platform", "win32"], {
      kilnHome: h.kilnHome,
      windowsRegistry: fakeRegistry,
    });
    expect(statusAfter.exitCode).toBe(0);
    expect((statusAfter.data as { installed: boolean }).installed).toBe(true);

    // `kiln doctor` on win32 checks service status cleanly
    const docWin = await runCli(["doctor", "--json"], {
      platform: "win32",
      kilnHome: h.kilnHome,
      windowsRegistry: fakeRegistry,
      isDaemonRunning: () => false,
    });
    expect(docWin.exitCode).toBe(0);
    const docReport = JSON.parse(docWin.stdout) as DoctorReport;
    expect(docReport.checks.find((c) => c.id === "service")?.status).toBe("pass");

    // `kiln uninstall --platform win32` removes HKCU entry cleanly and idempotently
    const uninstallRes = await runCli(["uninstall", "--platform", "win32"], {
      kilnHome: h.kilnHome,
      windowsRegistry: fakeRegistry,
      stopDaemon: () => true,
    });
    expect(uninstallRes.exitCode).toBe(0);
    expect(regStore.has(expectedRegPath)).toBe(false);

    const uninstallAgain = await uninstallService({
      platform: "win32",
      kilnHome: h.kilnHome,
      windowsRegistry: fakeRegistry,
    });
    expect(uninstallAgain.removed).toBe(false);

    // Also verifies reg.exe argument list when executeSystemControl hook is supplied
    const regCalls: Array<{ command: string; args: readonly string[] }> = [];
    await installService({
      platform: "win32",
      kilnHome: h.kilnHome,
      executeSystemControl: (command, args) => {
        regCalls.push({ command, args });
      },
    });
    expect(regCalls[0]?.command).toBe("reg.exe");
    expect(regCalls[0]?.args.slice(0, 6)).toEqual([
      "add",
      WINDOWS_RUN_REGISTRY_KEY,
      "/v",
      WINDOWS_RUN_VALUE_NAME,
      "/t",
      "REG_SZ",
    ]);
  });

  it("stops managed daemon via local IPC /rpc/shutdown first and falls back to taskkill on win32", async () => {
    const h = makeTestHarness("kiln-cli-graceful-stop-");
    const pidFile = resolveKilnPidPath(h.kilnHome);
    const tokenFile = resolveKilnShutdownTokenPath(h.kilnHome);

    // 1. When kilnd.shutdown exists and IPC shutdown succeeds, stops cleanly without SIGTERM or taskkill
    writeFileAtomic(pidFile, "88111\n");
    writeFileAtomic(tokenFile, "graceful-control-token-123\n");
    let alive = true;
    const signals: Array<NodeJS.Signals | 0 | undefined> = [];
    const rpcCalls: Array<{ socketPath: string; shutdownToken: string }> = [];
    let taskkillCalled = false;

    const gracefulRes = await stopManagedDaemon({
      kilnHome: h.kilnHome,
      platform: "win32",
      requestGracefulShutdown: async (ctx) => {
        rpcCalls.push(ctx);
        alive = false;
        return true;
      },
      signalProcess: (_pid, sig) => {
        signals.push(sig);
        if (!alive) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
      },
      killProcessTree: () => {
        taskkillCalled = true;
        return true;
      },
      waitTimeoutMs: 500,
    });

    expect(gracefulRes.stopped).toBe(true);
    expect(gracefulRes.method).toBe("ipc_shutdown");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.shutdownToken).toBe("graceful-control-token-123");
    expect(rpcCalls[0]?.socketPath.startsWith("\\\\.\\pipe\\kiln-rpc-")).toBe(true);
    expect(signals.every((s) => s === 0)).toBe(true);
    expect(taskkillCalled).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(tokenFile)).toBe(false);

    // 2. On win32, falls back to killProcessTree (taskkill) if IPC shutdown fails or times out
    writeFileAtomic(pidFile, "88222\n");
    writeFileAtomic(tokenFile, "stale-token\n");
    let winAlive = true;
    const killedPids: number[] = [];

    const fallbackRes = await stopManagedDaemon({
      kilnHome: h.kilnHome,
      platform: "win32",
      requestGracefulShutdown: async () => false,
      signalProcess: (_pid, sig) => {
        if (sig === 0 && !winAlive) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
      },
      killProcessTree: (pid) => {
        killedPids.push(pid);
        winAlive = false;
        return true;
      },
      waitTimeoutMs: 200,
    });

    expect(fallbackRes.stopped).toBe(true);
    expect(fallbackRes.method).toBe("taskkill");
    expect(killedPids).toEqual([88222]);
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(tokenFile)).toBe(false);

    // 3. Foreground `kiln up --foreground` cleanly exits when receiving POST /rpc/shutdown
    const fgHome = path.join(makeTempDir("kiln-cli-fg-rpc-stop-"), "kh");
    const fgAc = new AbortController();
    let resolveServer!: (srv: KilndServer) => void;
    const serverReady = new Promise<KilndServer>((resolve) => {
      resolveServer = resolve;
    });
    const fgPromise = runCli(["up", "--foreground", "--port", "0", "--no-paseo"], {
      kilnHome: fgHome,
      isDaemonRunning: () => false,
      foregroundSignal: fgAc.signal,
      onForegroundServer: (srv) => resolveServer(srv),
    });

    const fgServer = await serverReady;
    const fgTokenFile = resolveKilnShutdownTokenPath(fgHome);
    const fgToken = fs.readFileSync(fgTokenFile, "utf8").trim();
    const rpcRes = await fgServer.invokeMcpRpc({
      method: "POST",
      url: "/rpc/shutdown",
      headers: { Authorization: `Bearer ${fgToken}` },
    });
    expect(rpcRes.status).toBe(200);

    const fgExit = await fgPromise;
    expect(fgExit.exitCode).toBe(0);
    expect(fs.existsSync(resolveKilnPidPath(fgHome))).toBe(false);
    expect(fs.existsSync(fgTokenFile)).toBe(false);

    // 4. Programmatic `kiln up --foreground` without foregroundSignal falls back to KilndServer default stop()
    const fgNoSigHome = path.join(makeTempDir("kiln-cli-fg-nosig-"), "kh");
    let capturedNoSigServer: KilndServer | null = null;
    const fgNoSigRes = await runCli(["up", "--foreground", "--port", "0", "--no-paseo"], {
      kilnHome: fgNoSigHome,
      isDaemonRunning: () => false,
      onForegroundServer: (srv) => {
        capturedNoSigServer = srv;
        servers.push(srv);
      },
    });
    expect(fgNoSigRes.exitCode).toBe(0);
    expect(capturedNoSigServer).not.toBeNull();
    const noSigToken = fs.readFileSync(resolveKilnShutdownTokenPath(fgNoSigHome), "utf8").trim();
    const noSigRpc = await capturedNoSigServer!.invokeMcpRpc({
      method: "POST",
      url: "/rpc/shutdown",
      headers: { Authorization: `Bearer ${noSigToken}` },
    });
    expect(noSigRpc.status).toBe(200);
    const deadline = Date.now() + 2_000;
    while (capturedNoSigServer!.address !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(capturedNoSigServer!.address).toBeNull();
  });

  it("supports hidden `kiln __mcp` stdio bridge and compiled-binary argument/service/doctor modes", async () => {
    // 1. `__mcp` is hidden from normal help output
    const helpRes = await runCli(["--help"]);
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).not.toContain("__mcp");

    // 2. Missing KILN_RUN_TOKEN fails cleanly on stderr without polluting stdout
    const missingTokenRes = await runCli(["__mcp"], { env: {} });
    expect(missingTokenRes.exitCode).toBe(1);
    expect(missingTokenRes.stdout).toBe("");
    expect(missingTokenRes.stderr).toContain("KILN_RUN_TOKEN");

    // 3. Real MCP handshake + listTools + callTool via `runCli(["__mcp"])` over InMemoryTransport
    const kilnHome = path.join(makeTempDir("kiln-cli-mcp-"), "kh");
    const server = new KilndServer({
      kilnHome,
      port: 0,
      publicDir: null,
      tokenSecret: "cli-mcp-bridge-secret-0123456789",
    });
    servers.push(server);

    const token = server.issueRunToken({
      taskId: "t-mcp-1",
      runId: "r-mcp-1",
      role: "intake",
      contractVersion: 1,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpAc = new AbortController();
    const mcpCliPromise = runCli(["__mcp"], {
      env: { KILN_RUN_TOKEN: token, KILN_HOME: kilnHome },
      foregroundSignal: mcpAc.signal,
      mcpOptions: {
        mcpTransport: serverTransport,
        rpcTransport: async (req) =>
          server.invokeMcpRpc({
            method: req.method,
            url: req.path,
            headers: req.headers,
            rawBody: req.rawBody,
          }),
      },
    });

    const mcpClient = new Client({ name: "kiln-cli-test", version: "0.0.1" });
    await mcpClient.connect(clientTransport);
    const listed = await mcpClient.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      "wb_ask_decision",
      "wb_get_context",
      "wb_list_tasks",
      "wb_plan",
      "wb_propose_ledger",
      "wb_read_ledger",
      "wb_submit_receipt",
    ]);
    const listRes = await mcpClient.callTool({ name: "wb_list_tasks", arguments: {} });
    expect(listRes.isError).not.toBe(true);
    await mcpClient.close();
    mcpAc.abort();

    const mcpExit = await mcpCliPromise;
    expect(mcpExit.exitCode).toBe(0);
    expect(mcpExit.stdout).toBe("");

    // 4. Compiled single-binary helpers omit JS entrypoint in daemon spawn & service templates
    expect(
      buildDaemonForegroundArgs({
        host: "127.0.0.1",
        port: 4310,
      }),
    ).toEqual(["up", "--foreground", "--host", "127.0.0.1", "--port", "4310"]);

    const plist = renderLaunchAgentPlist({
      nodeExecutable: "/Users/tester/.local/bin/kiln",
      kilnHome: "/Users/tester/.kiln",
      logDir: "/Users/tester/.kiln/logs",
      args: ["up", "--foreground"],
    });
    expect(plist).toContain("<string>/Users/tester/.local/bin/kiln</string>");
    expect(plist).toContain("<string>up</string>");
    expect(plist).not.toContain("dist/bin.js");

    const unit = renderSystemdUnit({
      nodeExecutable: "/home/tester/.local/bin/kiln",
      kilnHome: "/home/tester/.kiln",
      args: ["up", "--foreground"],
    });
    expect(unit).toContain('ExecStart="/home/tester/.local/bin/kiln" "up" "--foreground"');

    const electronPlist = renderLaunchAgentPlist({
      nodeExecutable: "/Applications/Kiln.app/Contents/MacOS/Kiln",
      kilndEntrypoint: "/Applications/Kiln.app/Contents/Resources/kiln-runtime/kiln-cli.mjs",
      kilnHome: "/Users/tester/.kiln",
      logDir: "/Users/tester/.kiln/logs",
      args: ["up", "--foreground"],
      electronAsNode: true,
    });
    expect(electronPlist).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    expect(electronPlist).toContain("<string>1</string>");

    const electronUnit = renderSystemdUnit({
      nodeExecutable: "/opt/Kiln/kiln",
      kilndEntrypoint: "/opt/Kiln/resources/kiln-runtime/kiln-cli.mjs",
      kilnHome: "/home/tester/.kiln",
      args: ["up", "--foreground"],
      electronAsNode: true,
    });
    expect(electronUnit).toContain("Environment=ELECTRON_RUN_AS_NODE=1");

    // 5. `kiln doctor --json` in compiledBinary mode passes runtime check without requiring Node.js
    const docRoot = makeTempDir("kiln-cli-doc-compiled-");
    const docRes = await runCli(["doctor", "--json"], {
      compiledBinary: true,
      kilnHome: path.join(docRoot, "kh"),
      homeDir: path.join(docRoot, "home"),
      launchAgentsDir: path.join(docRoot, "home", "Library", "LaunchAgents"),
      isDaemonRunning: () => false,
      execFileImpl: async () => ({ stdout: "git version 2.45.0\n", stderr: "" }),
    });
    expect(docRes.exitCode).toBe(0);
    const report = docRes.data as DoctorReport;
    const nodeCheck = report.checks.find((c) => c.id === "node");
    expect(nodeCheck?.ok).toBe(true);
    expect(nodeCheck?.detail).toContain("Node.js not required");

    // 6. readNewLogTail extracts only bytes appended after startOffset and caps at maxBytes
    const logFile = path.join(docRoot, "kilnd.log");
    fs.writeFileSync(logFile, "old-header\n", "utf8");
    const offset = fs.statSync(logFile).size;
    expect(readNewLogTail(logFile, offset)).toBe("");
    fs.appendFileSync(logFile, "line1\nError: named pipe failure\n", "utf8");
    expect(readNewLogTail(logFile, offset)).toBe("line1\nError: named pipe failure");
    expect(readNewLogTail(logFile, offset, 19)).toBe("named pipe failure");
    expect(readNewLogTail(path.join(docRoot, "missing.log"), 0)).toBe("");
  });

  it("supports `kiln rm` in online and offline modes with safety checks and --purge-usage", async () => {
    const h = makeTestHarness("kiln-cli-rm-");
    await h.server.start();
    const fetchImpl = createInProcessFetch(h.server);

    const tDone = makeTaskCard({ id: "t-cli-rm-1", title: "Delete online task" });
    const tDepParent = makeTaskCard({ id: "t-cli-rm-parent", title: "Dep parent" });
    const tDepChild = makeTaskCard({
      id: "t-cli-rm-child",
      title: "Dep child",
      depends_on: ["t-cli-rm-parent"],
    });
    const tRun = makeTaskCard({ id: "t-cli-rm-run", title: "Running task" });

    h.server.store.createTask(tDone, "# Done brief");
    h.server.store.createTask(tDepParent, "# Parent brief");
    h.server.store.createTask(tDepChild, "# Child brief");
    h.server.store.createTask(tRun, "# Running brief");
    h.server.store.persistRunBeforeDispatch(
      makeRunMeta({ task_id: tRun.id, run_id: "run-rm-active" }),
      "001-implement",
    );

    const missingOnline = await runCli(["rm", "t-missing"], {
      kilnHome: h.kilnHome,
      fetchImpl,
      isDaemonRunning: () => true,
    });
    expect(missingOnline.exitCode).toBe(1);

    const runningOnline = await runCli(["rm", tRun.id], {
      kilnHome: h.kilnHome,
      fetchImpl,
      isDaemonRunning: () => true,
    });
    expect(runningOnline.exitCode).toBe(1);
    expect(runningOnline.stderr).toContain("正在运行中");

    const okOnline = await runCli(["rm", tDone.id, "--json"], {
      kilnHome: h.kilnHome,
      fetchImpl,
      isDaemonRunning: () => true,
    });
    expect(okOnline.exitCode).toBe(0);
    expect(okOnline.data).toEqual({
      deleted: true,
      id: tDone.id,
      purgedUsage: false,
      mode: "online",
    });
    expect(fs.existsSync(h.server.store.paths.taskDir(tDone.id))).toBe(false);

    await h.server.stop();

    const blockedParentOffline = await runCli(["rm", tDepParent.id], {
      kilnHome: h.kilnHome,
      isDaemonRunning: () => false,
    });
    expect(blockedParentOffline.exitCode).toBe(1);
    expect(blockedParentOffline.stderr).toContain("depended on by downstream task(s)");

    const blockedRunningOffline = await runCli(["rm", tRun.id], {
      kilnHome: h.kilnHome,
      isDaemonRunning: () => false,
    });
    expect(blockedRunningOffline.exitCode).toBe(1);
    expect(blockedRunningOffline.stderr).toContain("Cannot remove running task");

    const okOffline = await runCli(["rm", tDepChild.id, "--purge-usage", "--json"], {
      kilnHome: h.kilnHome,
      isDaemonRunning: () => false,
    });
    expect(okOffline.exitCode).toBe(0);
    expect(okOffline.data).toEqual({
      deleted: true,
      id: tDepChild.id,
      purgedUsage: true,
      mode: "offline",
    });
    expect(fs.existsSync(path.join(h.kilnHome, "tasks", tDepChild.id))).toBe(false);
  });
});
