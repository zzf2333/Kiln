import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdvisorRequestSchema,
  LimitsConfigSchema,
  RemoteConfigSchema,
  RolesConfigSchema,
  RunEventSchema,
  TaskCardSchema,
  type RunEvent,
} from "@kiln/protocol";
import { BackendRegistry, FakeBackend, type BackendAgentDescriptor } from "../../backend/index.js";
import { KilnStore, readNdjsonValidated, readYamlOptional } from "../../store/index.js";
import { KilndServer, evaluateRunStallState } from "../index.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function listRunSnapshots(
  store: KilnStore,
  taskId: string,
): Array<{ runDirName: string; events: RunEvent[] }> {
  const runsDir = store.paths.runsDir(taskId);
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => ({
      runDirName: d.name,
      events: readNdjsonValidated(store.paths.runEventsNdjson(taskId, d.name), RunEventSchema),
    }))
    .sort((a, b) => a.runDirName.localeCompare(b.runDirName));
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

const CLAUDE_DESCRIPTOR: BackendAgentDescriptor = {
  ...CODEX_DESCRIPTOR,
  id: "claude",
  label: "Claude Code",
};

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

describe("Track 5 [B12.1] Run heartbeat stall watchdog (Witness)", () => {
  const servers: KilndServer[] = [];
  const stores: KilnStore[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await s.orchestrator.stop().catch(() => {});
      await s.stop().catch(() => {});
    }
    for (const st of stores.splice(0)) {
      st.close();
    }
    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("evaluates pure Witness stall state transitions across healthy, soft_warn, dead probe, 2x hard timeout, and disabled", () => {
    expect(
      evaluateRunStallState({
        silentMs: 900_000,
        stallTimeoutMs: 0,
        alreadyWarned: false,
        probeResult: { alive: false, status: "closed" },
      }).action,
    ).toBe("none");

    expect(
      evaluateRunStallState({
        silentMs: 599_000,
        stallTimeoutMs: 600_000,
        alreadyWarned: false,
        probeResult: null,
      }).action,
    ).toBe("none");

    expect(
      evaluateRunStallState({
        silentMs: 605_000,
        stallTimeoutMs: 600_000,
        alreadyWarned: false,
        probeResult: { alive: true, status: "running" },
      }),
    ).toEqual({ action: "soft_warn", silentSec: 605 });

    // Deduplicated while still < 2x hard timeout and probe alive
    expect(
      evaluateRunStallState({
        silentMs: 900_000,
        stallTimeoutMs: 600_000,
        alreadyWarned: true,
        probeResult: { alive: true, status: "running" },
      }).action,
    ).toBe("none");

    // Immediate abort at 1x when probe says dead/closed
    expect(
      evaluateRunStallState({
        silentMs: 610_000,
        stallTimeoutMs: 600_000,
        alreadyWarned: false,
        probeResult: { alive: false, status: "closed" },
      }),
    ).toEqual({ action: "abort_dead", silentSec: 610 });

    // Hard timeout abort at >= 2x even if probe says alive
    expect(
      evaluateRunStallState({
        silentMs: 1_200_000,
        stallTimeoutMs: 600_000,
        alreadyWarned: true,
        probeResult: { alive: true, status: "running" },
      }),
    ).toEqual({ action: "abort_hard_timeout", silentSec: 1200 });
  });

  it("drives soft warning + pulse reset + 2x hard timeout retry + dead-probe advisor escalation + waiting convergence", async () => {
    const home = createTempDir("kiln-b12-witness-");
    let fakeNowMs = Date.parse("2026-11-24T04:00:00Z");

    const fakeBackend = new FakeBackend({
      backendId: "fake",
      agents: [CODEX_DESCRIPTOR, CLAUDE_DESCRIPTOR],
    });
    // Turn 1: emits initial thinking, later emits pulse message (resets silence), then hangs
    fakeBackend.enqueueScript(
      [
        { kind: "thinking" },
        { kind: "message", text: "pulse heartbeat", delayMs: 80 },
        { kind: "wait_for_cancel" },
      ],
      { role: "worker" },
    );
    // Turn 2 (retry implement): hangs immediately until aborted via dead probe
    fakeBackend.enqueueScript([{ kind: "thinking" }, { kind: "wait_for_cancel" }], {
      role: "worker",
    });
    // Turn 3 & 4 (advisor): hang until aborted and finally escalated to waiting
    fakeBackend.enqueueScript([{ kind: "thinking" }, { kind: "wait_for_cancel" }], {
      role: "advisor",
    });
    fakeBackend.enqueueScript([{ kind: "thinking" }, { kind: "wait_for_cancel" }], {
      role: "advisor",
    });

    const probeSpy = vi.spyOn(fakeBackend, "probe");
    const registry = new BackendRegistry();
    registry.register(fakeBackend);

    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeConfig(
      "roles",
      RolesConfigSchema.parse({
        schema_version: 1,
        heterogeneous_review: true,
        roles: {
          worker: { agent: "codex", model: "gpt-5.4" },
          reviewer: { agent: "claude", model: "claude-sonnet-4-6" },
          advisor: { agent: "claude", model: "claude-sonnet-4-6" },
        },
      }),
    );
    store.writeConfig(
      "limits",
      LimitsConfigSchema.parse({
        schema_version: 1,
        retries_per_stage: 1,
        advisor_calls: 1,
        stall_timeout_sec: 100,
      }),
    );
    store.writeConfig(
      "remote",
      RemoteConfigSchema.parse({
        schema_version: 1,
        enabled: false,
        notifications: {
          enabled: true,
          channel: "webhook",
          url: "https://notify.example.test/hook",
          priorities: ["P0", "P1"],
        },
      }),
    );

    const notifyPayloads: Array<Record<string, unknown>> = [];
    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-b12-witness",
      title: "Stall recovery test",
      space: "local",
      priority: "P1",
      track: "L2",
      workspace_mode: "scratch_dir",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Test stall recovery",
        end: "Done",
        accept_cmd: "echo ok",
        accept_files_hash: `sha256:${"a".repeat(64)}`,
        scope: ["**"],
        deliver: { mode: "manual", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 1,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 150_000,
        stall_timeout_sec: 100,
      },
      created_at: "2026-11-24T04:00:00Z",
      updated_at: "2026-11-24T04:00:00Z",
    });
    store.createTask(card, "# Brief");

    const server = new KilndServer({
      store,
      backendRegistry: registry,
      publicDir: null,
      enableOrchestrator: true,
      stallCheckIntervalMs: 60_000,
      orchestratorNowMs: () => fakeNowMs,
      notifyFetchImpl: (async (_url, init) => {
        notifyPayloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });
    servers.push(server);

    await server.orchestrator.start();
    await waitUntil(
      () => listRunSnapshots(store, card.id).some((r) => r.runDirName === "001-implement"),
      "001-implement started",
    );
    await waitUntil(
      () =>
        (listRunSnapshots(store, card.id).find((r) => r.runDirName === "001-implement")?.events
          .length ?? 0) >= 1,
      "turn 1 thinking event emitted",
    );

    // 1. Cross 1x threshold (110s) -> single soft_warning, probe alive, remote push emitted
    fakeNowMs += 110_000;
    await server.orchestrator.checkStalledRunsNow();
    expect(probeSpy).toHaveBeenCalledTimes(1);
    const run1AfterWarn = listRunSnapshots(store, card.id).find(
      (r) => r.runDirName === "001-implement",
    )!;
    expect(
      run1AfterWarn.events.filter((e) => e.kind === "stall_warning" && e.phase === "soft_warning"),
    ).toHaveLength(1);
    expect(notifyPayloads.some((p) => p.event === "run.stalled")).toBe(true);

    // Deduplicate at 130s before pulse arrives
    fakeNowMs += 20_000;
    await server.orchestrator.checkStalledRunsNow();
    const run1Dedup = listRunSnapshots(store, card.id).find(
      (r) => r.runDirName === "001-implement",
    )!;
    expect(
      run1Dedup.events.filter((e) => e.kind === "stall_warning" && e.phase === "soft_warning"),
    ).toHaveLength(1);

    // Wait for pulse heartbeat event to arrive -> resets silence timer & warning flag
    await waitUntil(
      () =>
        listRunSnapshots(store, card.id)
          .find((r) => r.runDirName === "001-implement")
          ?.events.some((e) => e.kind === "message" && e.text === "pulse heartbeat") ?? false,
      "pulse heartbeat arrived",
    );

    // 2. Advance 110s from pulse -> emits a SECOND soft_warning, then advance to 210s -> 2x hard abort & retry_stage!
    fakeNowMs += 110_000;
    await server.orchestrator.checkStalledRunsNow();
    const run1SecondWarn = listRunSnapshots(store, card.id).find(
      (r) => r.runDirName === "001-implement",
    )!;
    expect(
      run1SecondWarn.events.filter((e) => e.kind === "stall_warning" && e.phase === "soft_warning"),
    ).toHaveLength(2);

    fakeNowMs += 100_000;
    await server.orchestrator.checkStalledRunsNow();
    const run1Aborted = listRunSnapshots(store, card.id).find(
      (r) => r.runDirName === "001-implement",
    )!;
    const abortEvt1 = run1Aborted.events.find(
      (e) => e.kind === "stall_warning" && e.phase === "aborted",
    );
    expect(abortEvt1).toBeTruthy();
    if (abortEvt1?.kind === "stall_warning") {
      expect(abortEvt1.action).toBe("retry_stage");
    }

    // 3. Turn 2 (`002-implement`) starts; advance 1x + simulate dead probe -> immediate abort & advisor escalation!
    await waitUntil(
      () => listRunSnapshots(store, card.id).some((r) => r.runDirName === "002-implement"),
      "002-implement retry started",
    );
    probeSpy.mockResolvedValueOnce({ alive: false, status: "closed" });
    fakeNowMs += 105_000;
    await server.orchestrator.checkStalledRunsNow();

    const advReq = readYamlOptional(store.paths.advisorRequestYaml(card.id), AdvisorRequestSchema);
    expect(advReq?.trigger).toBe("run_stalled");
    expect(advReq?.source_stage).toBe("implement");

    // 4. Turn 3 (`003-advise`) starts -> stall #1 retries advise -> Turn 4 (`004-advise`) -> stall #2 escalates to waiting!
    await waitUntil(
      () => listRunSnapshots(store, card.id).some((r) => r.runDirName === "003-advise"),
      "003-advise started",
    );
    fakeNowMs += 210_000;
    await server.orchestrator.checkStalledRunsNow();

    await waitUntil(
      () => listRunSnapshots(store, card.id).some((r) => r.runDirName === "004-advise"),
      "004-advise started",
    );
    fakeNowMs += 210_000;
    await server.orchestrator.checkStalledRunsNow();

    await waitUntil(
      () => store.getTaskIndex(card.id)?.status === "waiting",
      "converged to waiting after advisor stall exhaustion",
    );
    expect(server.pendingDecisions.get(card.id)?.category).toBe("stage_failure_escalation");
  });

  it("ignores active runs when stall_timeout_sec=0 and never resurrects manually paused tasks", async () => {
    const home = createTempDir("kiln-b12-guard-");
    let fakeNowMs = Date.parse("2026-11-24T04:00:00Z");

    const fakeBackend = new FakeBackend({
      backendId: "fake",
      agents: [CODEX_DESCRIPTOR],
    });
    fakeBackend.enqueueScript([{ kind: "thinking" }, { kind: "wait_for_cancel" }]);
    const probeSpy = vi.spyOn(fakeBackend, "probe");

    const registry = new BackendRegistry();
    registry.register(fakeBackend);

    const store = new KilnStore({ kilnHome: home });
    stores.push(store);
    store.writeConfig(
      "roles",
      RolesConfigSchema.parse({
        schema_version: 1,
        heterogeneous_review: false,
        roles: {
          worker: { agent: "codex", model: "gpt-5.4" },
        },
      }),
    );
    store.writeConfig(
      "limits",
      LimitsConfigSchema.parse({
        schema_version: 1,
        stall_timeout_sec: 0,
      }),
    );

    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-b12-disabled",
      title: "Disabled & pause guard",
      space: "local",
      priority: "P1",
      track: "L1",
      workspace_mode: "scratch_dir",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Guard test",
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
      created_at: "2026-11-24T04:00:00Z",
      updated_at: "2026-11-24T04:00:00Z",
    });
    store.createTask(card, "# Brief");

    const server = new KilndServer({
      store,
      backendRegistry: registry,
      publicDir: null,
      enableOrchestrator: true,
      stallCheckIntervalMs: 60_000,
      orchestratorNowMs: () => fakeNowMs,
    });
    servers.push(server);

    await server.orchestrator.start();
    await waitUntil(
      () => listRunSnapshots(store, card.id).some((r) => r.runDirName === "001-implement"),
      "001-implement started",
    );

    // 1. Disabled (stall_timeout_sec = 0) never probes or warns
    fakeNowMs += 3_600_000;
    await server.orchestrator.checkStalledRunsNow();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(
      listRunSnapshots(store, card.id)[0]?.events.some((e) => e.kind === "stall_warning"),
    ).toBe(false);

    // 2. Pause task and enable watchdog -> pause must never be undone by watchdog
    store.writeConfig(
      "limits",
      LimitsConfigSchema.parse({
        schema_version: 1,
        stall_timeout_sec: 30,
      }),
    );
    await server.orchestrator.abortActiveRun(card.id);
    server.stateMachine.pauseTask(card.id, "Manual pause test");
    fakeNowMs += 3_600_000;
    await server.orchestrator.checkStalledRunsNow();
    expect(store.getTaskIndex(card.id)?.status).toBe("paused");
  });
});
