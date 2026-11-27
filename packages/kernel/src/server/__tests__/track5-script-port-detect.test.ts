import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunMetaSchema, TaskCardSchema, type SseEvent } from "@kiln/protocol";
import { BackendRegistry, FakeBackend, type BackendAgentDescriptor } from "../../backend/index.js";
import { KilnStore, writeYamlAtomic } from "../../store/index.js";
import { KilndServer } from "../index.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const CODEX_DESCRIPTOR: BackendAgentDescriptor = {
  id: "codex",
  label: "Codex",
  capabilities: {
    interactiveChat: true,
    approvals: true,
    mcpInjection: false,
    usageCacheBreakdown: true,
    interrupt: true,
    imageInput: true,
    warmSessionReuse: false,
  },
  modes: [{ id: "auto", label: "Auto" }],
  defaultModeId: "auto",
};

describe("Track 5 [B12.3] Script local port detection & bootstrap stall summary", () => {
  const servers: KilndServer[] = [];
  const stores: KilnStore[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await s.stop().catch(() => {});
    }
    for (const st of stores.splice(0)) {
      st.close();
    }
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("extracts normalized loopback URLs into script.output SSE and summary while ignoring non-loopback domains, and exposes stall_silent_sec in /api/bootstrap", async () => {
    const home = createTempDir("kiln-b123-home-");
    const repoPath = createTempDir("kiln-b123-repo-");

    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeSpace({
      schema_version: 1,
      id: "demo",
      name: "Demo",
      repo_path: repoPath,
      default_branch: "main",
      copy_untracked: [],
      clone_deps: [],
      freeze_patterns: [],
      scripts: {
        dev: `${JSON.stringify(process.execPath)} -e "console.log('\\u001b[32mLocal: http://0.0.0.0:5173/app\\u001b[0m'); console.log('Bad: https://evil.example.com:8443/x');"`,
      },
    });

    // Seed a running task whose latest run ends with soft stall_warning
    const now = "2026-11-24T04:00:00Z";
    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-b123-stall",
      title: "Running with stall warning",
      space: "demo",
      priority: "P1",
      track: "L1",
      workspace_mode: "scratch_dir",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Test bootstrap stall badge",
        end: "Done",
        accept_cmd: "echo ok",
        accept_files_hash: `sha256:${"a".repeat(64)}`,
        scope: ["**"],
        deliver: { mode: "manual", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 150_000,
      },
      created_at: now,
      updated_at: now,
    });
    store.createTask(card, "# Brief");
    store.appendStateEvent(card.id, {
      type: "running",
      at: now,
      stage: "implement",
      round: 1,
      run_id: "r-b123-1",
    });
    writeYamlAtomic(
      store.paths.runYaml(card.id, "001-implement"),
      RunMetaSchema.parse({
        schema_version: 1,
        run_id: "r-b123-1",
        task_id: card.id,
        stage: "implement",
        round: 1,
        contract_version: 1,
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        backend_id: "fake",
        session_ref: { backendId: "fake", sessionId: "s-1" },
        started_at: now,
      }),
      RunMetaSchema,
    );
    store.recordRunEvent(card.id, "001-implement", {
      kind: "stall_warning",
      at: "2026-11-24T04:10:00Z",
      phase: "soft_warning",
      silentSec: 615,
      probeAlive: true,
      probeStatus: "running",
      action: "warn",
    });

    const registry = new BackendRegistry();
    registry.register(new FakeBackend({ backendId: "fake", agents: [CODEX_DESCRIPTOR] }));
    const server = new KilndServer({
      store,
      backendRegistry: registry,
      publicDir: null,
      enableOrchestrator: false,
    });
    servers.push(server);

    const sseEvents: SseEvent[] = [];
    server.sseHub.subscribe((ev) => sseEvents.push(ev));

    // 1. Run space script and wait for completion
    const startRes = await server.app.request(
      new Request("http://127.0.0.1/api/spaces/demo/scripts/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: "dev" }),
      }),
    );
    expect(startRes.status).toBe(202);
    const { scriptRunId } = (await startRes.json()) as { scriptRunId: string };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const hit = server.scriptRunner
        .listRuns({ spaceId: "demo" })
        .find((r) => r.scriptRunId === scriptRunId);
      if (hit && !hit.running) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const scriptListRes = await server.app.request(
      new Request("http://127.0.0.1/api/scripts?spaceId=demo"),
    );
    expect(scriptListRes.status).toBe(200);
    const scriptListJson = (await scriptListRes.json()) as {
      runs: Array<{ scriptRunId: string; detectedUrls: string[] }>;
    };
    const runItem = scriptListJson.runs.find((r) => r.scriptRunId === scriptRunId)!;
    expect(runItem.detectedUrls).toEqual(["http://127.0.0.1:5173/app"]);

    const scriptEvents = sseEvents.filter(
      (ev): ev is Extract<SseEvent, { type: "script.output" }> =>
        ev.type === "script.output" && ev.scriptRunId === scriptRunId,
    );
    expect(scriptEvents.some((ev) => ev.detectedUrls?.includes("http://127.0.0.1:5173/app"))).toBe(
      true,
    );
    expect(
      scriptEvents.some((ev) => ev.detectedUrls?.some((u) => u.includes("evil.example.com"))),
    ).toBe(false);

    // 2. Verify /api/bootstrap includes stall_silent_sec on running card
    const bootRes = await server.app.request(new Request("http://127.0.0.1/api/bootstrap"));
    expect(bootRes.status).toBe(200);
    const bootJson = (await bootRes.json()) as {
      tasks: Array<{ id: string; stall_silent_sec?: number }>;
    };
    const taskItem = bootJson.tasks.find((t) => t.id === "t-b123-stall");
    expect(taskItem?.stall_silent_sec).toBe(615);
  });
});
