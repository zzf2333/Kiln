import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderRuntimeStatusSchema,
  ProvidersConfigSchema,
  RosterConfigSchema,
  SseEventSchema,
  TaskCardSchema,
  createDefaultProvidersConfig,
  createDefaultBuiltinRosterMetadata,
  type RunEvent,
  type SessionRef,
  type SseEvent,
} from "@kiln/protocol";
import {
  BackendRegistry,
  type BackendRunSpec,
  type ExecutionBackend,
} from "../../backend/index.js";
import { KilndServer, resolveNativeTuiCommand } from "../index.js";
import { ensureDir, writeFileAtomic } from "../../store/index.js";

function makeTempDir(prefix = "kiln-prov-api-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeGitRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# repo\n", "utf8");
  execFileSync("git", ["init", "-b", "main", repoPath], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Kiln Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@kiln.local"], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "init"], { stdio: "pipe" });
}

describe("Providers/Roster HTTP API, :4311 security isolation, SSE provider.status, TUI & read-only guard", () => {
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

  it("exposes GET /api/providers, GET/PUT /api/settings/{providers,roster}, POST /api/providers/:id/test, bootstrap fields, and enforces :4311 local_only_endpoint", async () => {
    const root = makeTempDir();
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const server = new KilndServer({
      kilnHome,
      port: 0,
      remotePort: 0,
      tokenSecret: "prov-api-secret-0123456789abcdef",
    });
    servers.push(server);
    await server.start();

    // Seed providers.yaml with a secret env var and non-existent command for safe deterministic test
    const cfg = createDefaultProvidersConfig();
    const customCfg = ProvidersConfigSchema.parse({
      schema_version: 1,
      providers: cfg.providers.map((p) =>
        p.id === "codex"
          ? {
              ...p,
              command: process.execPath,
              args: ["-e", "console.log('1.2.3')"],
              env: { OPENAI_API_KEY: "super-secret-env-key" },
            }
          : p,
      ),
    });
    server.store.writeConfig("providers", customCfg);

    // 1. Local GET /api/providers strips command/args/env secrets
    const provRes = await server.app.request(new Request("http://127.0.0.1/api/providers"));
    expect(provRes.status).toBe(200);
    const provJson = (await provRes.json()) as {
      ok: boolean;
      providers: Array<{ provider_id: string; status: string }>;
    };
    expect(provJson.ok).toBe(true);
    expect(provJson.providers.length).toBeGreaterThanOrEqual(4);
    for (const item of provJson.providers) {
      ProviderRuntimeStatusSchema.parse(item);
    }
    expect(provJson.providers.find((p) => p.provider_id === "paseo")?.status).toBe("unavailable");
    expect(JSON.stringify(provJson)).not.toContain("super-secret-env-key");

    // 2. Local GET /api/settings/providers and PUT /api/settings/roster (syncs roles.yaml)
    const getProvSettings = await server.app.request(
      new Request("http://127.0.0.1/api/settings/providers"),
    );
    expect(getProvSettings.status).toBe(200);
    const getRoster = await server.app.request(new Request("http://127.0.0.1/api/settings/roster"));
    expect(getRoster.status).toBe(200);

    const rosterMeta = createDefaultBuiltinRosterMetadata();
    rosterMeta.main_dev = {
      ...rosterMeta.main_dev,
      enabled: true,
      primary: { provider: "codex", model: "gpt-5.4", effort: "high" },
    };
    const nextRoster = RosterConfigSchema.parse({
      schema_version: 2,
      heterogeneous_review: true,
      roster: rosterMeta,
    });
    const putRoster = await server.app.request(
      new Request("http://127.0.0.1/api/settings/roster", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextRoster),
      }),
    );
    expect(putRoster.status).toBe(200);
    expect(server.store.readConfig("roles")?.roles.worker).toMatchObject({
      agent: "codex",
      model: "gpt-5.4",
      reasoning_effort: "high",
    });

    // 3. POST /api/providers/:id/test emits exactly 1 provider.status SSE event
    const sseEvents: SseEvent[] = [];
    const unsub = server.sseHub.subscribe((ev) => {
      sseEvents.push(SseEventSchema.parse(ev));
    });
    const testRes = await server.app.request(
      new Request("http://127.0.0.1/api/providers/codex/test", { method: "POST" }),
    );
    unsub();
    expect(testRes.status).toBe(200);
    const testJson = (await testRes.json()) as {
      ok: boolean;
      status: { provider_id: string; status: string };
    };
    expect(testJson.status.provider_id).toBe("codex");
    expect(testJson.status.status).toBe("ready");
    expect(sseEvents.filter((e) => e.type === "provider.status")).toHaveLength(1);

    // 4. Local vs Remote /api/bootstrap and :4311 local_only_endpoint isolation
    const localBoot = (await (
      await server.app.request(new Request("http://127.0.0.1/api/bootstrap"))
    ).json()) as {
      providers?: unknown[];
      roster?: unknown;
      settings?: { providers?: unknown; roster?: unknown };
    };
    expect(Array.isArray(localBoot.providers)).toBe(true);
    expect(localBoot.roster).toBeDefined();
    expect(localBoot.settings?.providers).toBeDefined();
    expect(localBoot.settings?.roster).toBeDefined();

    // Enable remote port and pair a device
    await server.applyRemoteConfig({
      schema_version: 1,
      enabled: true,
      remote_port: 14311,
      keep_awake_on_ac: false,
      notifications: { enabled: false, channel: "webhook", url: "", priorities: ["P0", "P1"] },
    });
    const challenge = server.remoteAuth.createPairingChallenge();
    const pairRes = await server.remoteApp.request(
      new Request("http://127.0.0.1/api/auth/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: challenge.code, label: "iPhone" }),
      }),
    );
    expect(pairRes.status).toBe(200);
    const cookie = pairRes.headers.get("set-cookie")!.split(";")[0]!;

    // Remote authenticated GET /api/providers and /api/bootstrap succeed cleanly without provider secrets
    const remProv = await server.remoteApp.request(
      new Request("http://127.0.0.1/api/providers", { headers: { Cookie: cookie } }),
    );
    expect(remProv.status).toBe(200);
    expect(JSON.stringify(await remProv.json())).not.toContain("super-secret-env-key");

    const remBoot = (await (
      await server.remoteApp.request(
        new Request("http://127.0.0.1/api/bootstrap", { headers: { Cookie: cookie } }),
      )
    ).json()) as { providers?: unknown[]; settings?: { providers?: unknown } };
    expect(Array.isArray(remBoot.providers)).toBe(true);
    expect(remBoot.settings?.providers).toBeUndefined();
    expect(JSON.stringify(remBoot)).not.toContain("super-secret-env-key");

    // Remote port MUST block all provider settings & test endpoints with 403 local_only_endpoint
    for (const req of [
      new Request("http://127.0.0.1/api/settings/providers", { headers: { Cookie: cookie } }),
      new Request("http://127.0.0.1/api/settings/providers", {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(customCfg),
      }),
      new Request("http://127.0.0.1/api/providers/codex/test", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
      new Request("http://127.0.0.1/api/providers/detect", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
    ]) {
      const res = await server.remoteApp.request(req);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("local_only_endpoint");
    }

    // 5. Local POST /api/providers/detect auto-enables available binaries and auto-disables missing ones
    const detectCfg = ProvidersConfigSchema.parse({
      schema_version: 1,
      providers: cfg.providers.map((p) => {
        if (p.id === "codex") {
          return {
            ...p,
            enabled: false,
            command: process.execPath,
            args: ["-e", "console.log('9.9.9')"],
          };
        }
        if (p.id === "gemini") {
          return {
            ...p,
            enabled: true,
            command: "/nonexistent/kiln-missing-gemini-cli-binary",
          };
        }
        return p;
      }),
    });
    server.store.writeConfig("providers", detectCfg);

    const detectRes = await server.app.request(
      new Request("http://127.0.0.1/api/providers/detect", { method: "POST" }),
    );
    expect(detectRes.status).toBe(200);
    const detectJson = (await detectRes.json()) as {
      ok: boolean;
      data: { providers: Array<{ id: string; enabled: boolean }> };
      providers: Array<{ provider_id: string; status: string }>;
    };
    expect(detectJson.ok).toBe(true);
    expect(detectJson.data.providers.find((p) => p.id === "codex")?.enabled).toBe(true);
    expect(detectJson.data.providers.find((p) => p.id === "gemini")?.enabled).toBe(false);
    expect(detectJson.data.providers.find((p) => p.id === "paseo")?.enabled).toBe(false);
    expect(detectJson.providers.find((p) => p.provider_id === "codex")?.status).toBe("ready");
    expect(detectJson.providers.find((p) => p.provider_id === "gemini")?.status).toBe(
      "unavailable",
    );
    expect(detectJson.providers.find((p) => p.provider_id === "paseo")?.status).toBe("unavailable");
    const persisted = server.store.readEffectiveProvidersConfig();
    expect(persisted.providers.find((p) => p.id === "codex")?.enabled).toBe(true);
    expect(persisted.providers.find((p) => p.id === "gemini")?.enabled).toBe(false);
  });

  it("orchestrator records rate_limited -> provider.status SSE and detects read-only reviewer worktree mutation", async () => {
    const root = makeTempDir("kiln-orch-v005-");
    tempDirs.push(root);
    const kilnHome = path.join(root, "kiln-home");
    const repoPath = path.join(root, "repo");
    createFakeGitRepo(repoPath);

    const sessionScripts = new Map<string, RunEvent[]>();
    const backend: ExecutionBackend = {
      backendId: "fake",
      async listAgents() {
        return [
          {
            id: "claude",
            label: "Claude",
            capabilities: {
              interactiveChat: true,
              approvals: false,
              mcpInjection: true,
              usageCacheBreakdown: true,
              interrupt: true,
            },
            modes: [{ id: "plan", label: "Plan" }],
            defaultModeId: "plan",
          },
        ];
      },
      async listModels() {
        return [{ id: "claude-sonnet-4-6", label: "Sonnet", thinkingOptions: [] }];
      },
      async capabilities() {
        return {
          interactiveChat: true,
          approvals: false,
          mcpInjection: true,
          usageCacheBreakdown: true,
          interrupt: true,
        };
      },
      async start(runSpec: BackendRunSpec): Promise<SessionRef> {
        fs.writeFileSync(path.join(runSpec.cwd, "UNAUTHORIZED_BY_REVIEWER.txt"), "oops\n", "utf8");
        const receiptDir = path.join(server.store.paths.runsDir("t-ro-guard"), "001-review");
        ensureDir(receiptDir);
        writeFileAtomic(
          path.join(receiptDir, "RECEIPT.md"),
          [
            "---",
            `run_id: ${runSpec.runId}`,
            "contract_version: 1",
            "reviewed_ref: HEAD",
            "verdict: pass",
            "p0: 0",
            "p1: 0",
            "p2: 0",
            "---",
            "## 结论",
            "ok",
            "",
            "## 缺陷清单",
            "无",
            "",
            "## 测试真实性与复现核查",
            "ok",
            "",
          ].join("\n"),
        );
        const sid = `sess-${runSpec.runId}`;
        sessionScripts.set(sid, [
          {
            kind: "rate_limited",
            at: new Date().toISOString(),
            provider: "claude",
            retryAfterSec: 20,
            detail: "429 busy",
          },
          { kind: "message", at: new Date().toISOString(), text: "reviewed", delta: false },
          { kind: "exit", at: new Date().toISOString(), reason: "completed" },
        ]);
        return { backendId: "fake", sessionId: sid };
      },
      async send() {},
      async *events(sessionRef) {
        for (const ev of sessionScripts.get(sessionRef.sessionId) ?? []) {
          yield ev;
        }
      },
      onApproval() {
        return () => {};
      },
      async answer() {},
      async cancel() {},
      async probe() {
        return { alive: false, status: "idle" };
      },
      async liveViewUrl() {
        return null;
      },
    };
    const registry = new BackendRegistry();
    registry.register(backend);

    const server = new KilndServer({
      kilnHome,
      port: 0,
      backendRegistry: registry,
      enableOrchestrator: true,
      tokenSecret: "orch-v005-secret-0123456789abcde",
    });
    servers.push(server);
    server.store.writeSpace({
      schema_version: 1,
      id: "demo",
      name: "Demo",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
    });
    server.store.writeConfig("roles", {
      schema_version: 1,
      heterogeneous_review: false,
      roles: {
        worker: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          backend_id: "fake",
          allow_full_access_fallback: false,
        },
        reviewer: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          backend_id: "fake",
          allow_full_access_fallback: false,
        },
      },
    });
    await server.start();

    // Create task directly in review stage and simulate reviewer mutating worktree file
    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-ro-guard",
      title: "RO review guard test",
      space: "demo",
      priority: "P1",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Test read-only guard",
        end: "Done",
        accept_cmd: "echo ok",
        accept_files_hash: "pending",
        scope: ["README.md"],
        deliver: { mode: "merge_main", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 0,
        review_rounds: 1,
        advisor_calls: 0,
        max_tokens: 100000,
        max_card_tokens: 100000,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    server.stateMachine.createTask(card, "# Brief\n");

    const sseEvents: SseEvent[] = [];
    const unsub = server.sseHub.subscribe((ev) => sseEvents.push(ev));

    // Manually advance task to queued review so orchestrator runs review directly
    const worktreeDir = path.join(server.store.paths.workspaceDir("t-ro-guard"), "worktree");
    ensureDir(path.dirname(worktreeDir));
    execFileSync(
      "git",
      ["-C", repoPath, "worktree", "add", "-B", "kiln/t-ro-guard", worktreeDir, "main"],
      {
        stdio: "pipe",
      },
    );
    server.store.appendStateEvent("t-ro-guard", {
      type: "running",
      stage: "review",
      round: 1,
      run_id: "seed-1",
      at: new Date().toISOString(),
    });
    server.store.appendStateEvent("t-ro-guard", {
      type: "queued",
      at: new Date().toISOString(),
    });

    await server.orchestrator.wake();

    // Wait until task transitions to waiting (retries_per_stage: 0 escalates failure -> waiting)
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const idx = server.store.getTaskIndex("t-ro-guard");
      if (idx?.status === "waiting" || idx?.status === "done") {
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    unsub();

    const finalIdx = server.store.getTaskIndex("t-ro-guard");
    expect(finalIdx?.status).toBe("waiting");
    const pending = server.pendingDecisions.get("t-ro-guard");
    expect(pending?.question).toContain("read_only_workspace_mutation");
    expect(
      sseEvents.some(
        (e) => e.type === "provider.status" && e.providerId === "claude" && e.status === "cooldown",
      ),
    ).toBe(true);
    expect(server.providerHealth.isInCooldown("claude")).toBe(true);
  });

  it("resolveNativeTuiCommand supports agy and gemini while keeping antigravity unsupported", () => {
    expect(resolveNativeTuiCommand({ agent: "agy", providerSessionId: "conv-1" })).toMatchObject({
      ok: true,
      binary: "agy",
      args: ["--conversation", "conv-1"],
    });
    expect(resolveNativeTuiCommand({ agent: "gemini", providerSessionId: "gem-9" })).toMatchObject({
      ok: true,
      binary: "gemini",
      args: ["--resume", "gem-9"],
    });
    expect(
      resolveNativeTuiCommand({ agent: "antigravity", providerSessionId: "legacy" }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "unsupported_tui_agent",
    });
  });
});
