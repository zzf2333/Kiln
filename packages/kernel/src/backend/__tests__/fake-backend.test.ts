import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { BackendCapabilities, RoleId, RunEvent } from "@kiln/protocol";
import { describe, expect, it } from "vitest";
import {
  type ApprovalRequestEvent,
  assertRoleAgentEligible,
  BackendRegistry,
  type BackendRunSpec,
  FakeBackend,
  FullAccessOnlyProviderError,
  IneligibleRoleAgentError,
  isFullAccessMode,
  selectSafeModeId,
  UnknownBackendError,
} from "../index.js";
import { verifyBackendContract } from "./contract.suite.js";

function makeRunSpec(overrides: Partial<BackendRunSpec> = {}): BackendRunSpec {
  return {
    runId: "run-101",
    taskId: "t-101",
    role: "worker",
    agent: "codex",
    model: "gpt-6-luna",
    cwd: "/tmp/kiln-test",
    prompt: "Implement feature",
    freshContext: true,
    ...overrides,
  };
}

async function collectAll(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const event of iter) {
    out.push(event);
  }
  return out;
}

verifyBackendContract("FakeBackend", () => {
  const backend = new FakeBackend();

  return {
    backend,
    createStreamingRun() {
      backend.enqueueScript([
        { kind: "thinking", delayMs: 2 },
        { kind: "message", text: "Hello ", delta: true, delayMs: 2 },
        { kind: "message", text: "Kiln", delta: true, delayMs: 2 },
        { kind: "tool", name: "read_file", target: "README.md" },
        { kind: "usage", inputTokens: 150, cachedInputTokens: 50, outputTokens: 25 },
        { kind: "exit", reason: "completed" },
      ]);
      return makeRunSpec({ runId: "run-stream" });
    },
    createCancellableRun() {
      backend.enqueueScript([
        { kind: "thinking" },
        { kind: "message", text: "Working...", delta: true },
        { kind: "wait_for_cancel" },
      ]);
      return makeRunSpec({ runId: "run-cancel" });
    },
    createApprovalRun(branch) {
      backend.enqueueScript([
        { kind: "thinking" },
        {
          kind: "approval",
          action: "write_outside_scope",
          detail: "/etc/hosts",
          onDenyExitReason: "failed",
          onDenyDetail: "Out-of-scope write denied",
        },
        { kind: "file_write", path: "/etc/hosts" },
        { kind: "usage", inputTokens: 200, cachedInputTokens: 100, outputTokens: 40 },
        { kind: "exit", reason: "completed" },
      ]);
      return makeRunSpec({
        runId: `run-approval-${branch}`,
        allowFullAccessFallback: false,
      });
    },
    createMultiTurnRun() {
      backend.enqueueScript([
        { kind: "message", text: "Turn 1 answer", delta: false },
        { kind: "usage", inputTokens: 300, cachedInputTokens: 100, outputTokens: 50 },
        { kind: "exit", reason: "completed" },
      ]);
      backend.enqueueScript([
        { kind: "message", text: "Turn 2 answer", delta: false },
        { kind: "usage", inputTokens: 420, cachedInputTokens: 300, outputTokens: 60 },
        { kind: "exit", reason: "completed" },
      ]);
      return {
        runSpec: makeRunSpec({ runId: "run-multiturn", role: "intake" }),
        followUpMessage: "Please refine scope",
      };
    },
  };
});

describe("selectSafeModeId & isFullAccessMode", () => {
  it("recognizes full-access and bypass mode variants", () => {
    expect(isFullAccessMode({ id: "auto", label: "Default Permissions" })).toBe(false);
    expect(isFullAccessMode({ id: "auto-review", label: "Auto-review" })).toBe(false);
    expect(isFullAccessMode({ id: "custom", label: "Safe", isFullAccess: true })).toBe(true);
    expect(isFullAccessMode({ id: "full-access", label: "Normal Label" })).toBe(true);
    expect(isFullAccessMode({ id: "full_access", label: "Normal Label" })).toBe(true);
    expect(isFullAccessMode({ id: "x", label: "Full Access" })).toBe(true);
    expect(isFullAccessMode({ id: "bypass-permissions", label: "Bypass" })).toBe(true);
  });

  it("selects 'auto' for Codex, undefined for Pi (empty modes), and rejects full-access-only unless fallback allowed", () => {
    // Codex (M0 V1 profile)
    const codexMode = selectSafeModeId("codex", [
      { id: "auto", label: "Default Permissions" },
      { id: "auto-review", label: "Auto-review" },
      { id: "full-access", label: "Full Access", isFullAccess: true },
    ]);
    expect(codexMode).toBe("auto");

    // Provider with "default" mode when "auto" is absent
    expect(
      selectSafeModeId("custom-default", [
        { id: "plan", label: "Plan" },
        { id: "default", label: "Default" },
        { id: "full-access", label: "Full Access", isFullAccess: true },
      ]),
    ).toBe("default");

    // Provider with custom restricted modes only
    expect(
      selectSafeModeId("custom-restricted", [
        { id: "workspace-write", label: "Workspace Write" },
        { id: "bypass", label: "Bypass" },
      ]),
    ).toBe("workspace-write");

    // Pi (M0 V1 profile: empty modes must return undefined, never "default")
    expect(selectSafeModeId("pi", [])).toBeUndefined();
    expect(selectSafeModeId("pi", [], { allowFullAccessFallback: true })).toBeUndefined();

    // Antigravity 0.16.2 profile: full-access only
    const fullOnlyModes = [{ id: "full-access", label: "Full access", isFullAccess: true }];
    expect(() => selectSafeModeId("antigravity", fullOnlyModes)).toThrowError(
      FullAccessOnlyProviderError,
    );

    try {
      selectSafeModeId("antigravity", fullOnlyModes);
    } catch (err) {
      expect(err).toBeInstanceOf(FullAccessOnlyProviderError);
      const typed = err as FullAccessOnlyProviderError;
      expect(typed.agent).toBe("antigravity");
      expect(typed.modes).toHaveLength(1);
    }

    expect(
      selectSafeModeId("antigravity", fullOnlyModes, { allowFullAccessFallback: true }),
    ).toBe("full-access");
  });
});

describe("assertRoleAgentEligible", () => {
  const codexCaps: BackendCapabilities = {
    interactiveChat: true,
    approvals: true,
    mcpInjection: true,
    usageCacheBreakdown: true,
    interrupt: true,
  };
  const piCaps: BackendCapabilities = {
    interactiveChat: true,
    approvals: false,
    mcpInjection: false,
    usageCacheBreakdown: true,
    interrupt: true,
  };

  it("allows Pi (interactiveChat=true, mcpInjection=false) for intake and resolver roles", () => {
    for (const role of ["intake", "resolver"] as const) {
      expect(() => assertRoleAgentEligible(role, "pi", piCaps)).not.toThrow();
    }
  });

  it("blocks agents lacking interactiveChat from intake and resolver roles", () => {
    const batchOnlyCaps: BackendCapabilities = {
      interactiveChat: false,
      approvals: false,
      mcpInjection: false,
      usageCacheBreakdown: false,
      interrupt: false,
    };
    try {
      assertRoleAgentEligible("intake", "batch", batchOnlyCaps);
      expect.unreachable("Expected IneligibleRoleAgentError");
    } catch (err) {
      expect(err).toBeInstanceOf(IneligibleRoleAgentError);
      const typed = err as IneligibleRoleAgentError;
      expect(typed.missingCapabilities).toEqual(["interactiveChat"]);
    }
  });

  it("allows Pi for non-interactive backend roles and allows Codex for all 7 roles", () => {
    const backgroundRoles: readonly RoleId[] = [
      "worker",
      "reviewer",
      "verifier",
      "triage",
      "advisor",
    ];
    for (const role of backgroundRoles) {
      expect(() => assertRoleAgentEligible(role, "pi", piCaps)).not.toThrow();
    }

    const allRoles: readonly RoleId[] = ["intake", "resolver", ...backgroundRoles];
    for (const role of allRoles) {
      expect(() => assertRoleAgentEligible(role, "codex", codexCaps)).not.toThrow();
    }
  });
});

describe("FakeBackend behavior & diagnostics", () => {
  it("exposes built-in M0 agent profiles and enforces mode/role guards in start()", async () => {
    const backend = new FakeBackend({ liveViewBaseUrl: "paseo://h/local/agent" });

    const agents = await backend.listAgents();
    expect(agents.map((a) => a.id)).toEqual(["codex", "pi", "antigravity-full-only"]);
    expect((await backend.listModels("codex")).length).toBeGreaterThan(0);
    expect((await backend.capabilities("pi")).mcpInjection).toBe(false);

    // Codex selects "auto"
    const codexRef = await backend.start(makeRunSpec({ agent: "codex", role: "intake" }));
    expect(codexRef.meta?.modeId).toBe("auto");
    expect(backend.getSelectedModeId(codexRef)).toBe("auto");
    expect(await backend.liveViewUrl(codexRef)).toBe(
      `paseo://h/local/agent/${codexRef.sessionId}`,
    );
    await collectAll(backend.events(codexRef));

    // Pi omits modeId and is allowed for both intake and worker
    const piIntakeRef = await backend.start(makeRunSpec({ agent: "pi", role: "intake" }));
    expect(piIntakeRef.meta?.modeId).toBeUndefined();
    await collectAll(backend.events(piIntakeRef));

    const piRef = await backend.start(makeRunSpec({ agent: "pi", role: "worker" }));
    expect(piRef.meta?.modeId).toBeUndefined();
    expect("modeId" in (piRef.meta ?? {})).toBe(false);
    expect(backend.getSelectedModeId(piRef)).toBeUndefined();
    await collectAll(backend.events(piRef));

    // Antigravity full-only blocked unless allowFullAccessFallback is true
    await expect(
      backend.start(makeRunSpec({ agent: "antigravity-full-only", role: "worker" })),
    ).rejects.toBeInstanceOf(FullAccessOnlyProviderError);

    const agyRef = await backend.start(
      makeRunSpec({
        agent: "antigravity-full-only",
        role: "worker",
        allowFullAccessFallback: true,
      }),
    );
    expect(backend.getSelectedModeId(agyRef)).toBe("full-access");
    await collectAll(backend.events(agyRef));

    expect(backend.getRecordedSpecs()).toHaveLength(4);
    await backend.dispose();
  });

  it("supports matcher-based script enqueueing, late event attachment, and auto-exit", async () => {
    const backend = new FakeBackend();

    backend.enqueueScript(
      [
        { kind: "message", text: "Reviewer found no defects" },
        // Deliberately omit explicit exit step to verify automatic single exit emission
      ],
      { role: "reviewer" },
    );

    const ref = await backend.start(makeRunSpec({ role: "reviewer" }));
    // Wait long enough for the zero-delay turn to finish before attaching events()
    await new Promise((resolve) => setTimeout(resolve, 15));

    const [eventsA, eventsB] = await Promise.all([
      collectAll(backend.events(ref)),
      collectAll(backend.events(ref)),
    ]);

    expect(eventsA).toEqual(eventsB);
    expect(eventsA.map((e) => e.kind)).toEqual(["message", "exit"]);
    expect(eventsA[1]).toMatchObject({ kind: "exit", reason: "completed" });
    expect(await backend.liveViewUrl(ref)).toBeNull();
  });

  it("supports approval continuation when onDenyExitReason is omitted and cancels pending approvals fast", async () => {
    const backend = new FakeBackend();

    // Script 1: deny without onDenyExitReason -> continues to fallback message and completes
    backend.enqueueScript([
      { kind: "approval", action: "modify_system", detail: "/etc/profile" },
      { kind: "message", text: "Skipped restricted write after denial" },
      { kind: "exit", reason: "completed" },
    ]);

    const seenApprovals: ApprovalRequestEvent[] = [];
    const unsubscribe = backend.onApproval(async (req) => {
      seenApprovals.push(req);
      await backend.answer(req.id, false, "Use sandbox instead");
    });

    const ref1 = await backend.start(makeRunSpec({ runId: "r-continue" }));
    const ev1 = await collectAll(backend.events(ref1));
    unsubscribe();

    expect(seenApprovals).toHaveLength(1);
    expect(ev1.map((e) => e.kind)).toEqual(["approval", "message", "exit"]);
    expect(ev1[2]).toMatchObject({ kind: "exit", reason: "completed" });

    // Unsubscribed handler must not run on next approval
    backend.enqueueScript([
      { kind: "approval", action: "pending_action", detail: "wait until cancel" },
    ]);
    const ref2 = await backend.start(makeRunSpec({ runId: "r-cancel-approval" }));
    const stream2 = collectAll(backend.events(ref2));

    // Wait until approval event appears, then cancel instead of answering
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seenApprovals).toHaveLength(1);

    const startedCancel = Date.now();
    await backend.cancel(ref2);
    const ev2 = await stream2;
    expect(Date.now() - startedCancel).toBeLessThan(200);
    expect(ev2.filter((e) => e.kind === "exit")).toHaveLength(1);
    expect(ev2.at(-1)).toMatchObject({ kind: "exit", reason: "cancelled" });
    expect((await backend.probe(ref2)).status).toBe("idle");

    // Idempotent second cancel must not emit duplicate exit
    await backend.cancel(ref2);
    await backend.dispose();
    expect((await backend.probe(ref2)).status).toBe("closed");
    expect((await backend.probe(ref2)).alive).toBe(false);
  });

  it("matches turnNumber/message scripts, avoids duplicate exit after explicit exit, and surfaces invalid usage/errors", async () => {
    const backend = new FakeBackend();

    backend.enqueueScript([
      { kind: "message", text: "Turn 1 done" },
      { kind: "exit", reason: "completed" },
      // Trailing step after exit must never run or trigger second exit
      { kind: "message", text: "Unreachable" },
    ]);
    backend.enqueueScript(
      [
        { kind: "message", text: "Matched turn 2" },
        { kind: "usage", inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
        { kind: "exit", reason: "completed" },
      ],
      { turnNumber: 2, message: /follow up/i },
    );

    const ref = await backend.start(makeRunSpec({ runId: "r-edge" }));
    const turn1 = await collectAll(backend.events(ref));
    expect(turn1.map((e) => e.kind)).toEqual(["message", "exit"]);
    expect(turn1[0]).toMatchObject({ kind: "message", text: "Turn 1 done" });

    await backend.send(ref, "Please follow up");
    const turn2 = await collectAll(backend.events(ref));
    expect(turn2.map((e) => e.kind)).toEqual(["message", "usage", "exit"]);
    expect(turn2[0]).toMatchObject({ kind: "message", text: "Matched turn 2" });

    // Invalid usage (cached > input) must fail cleanly with exit(reason='failed')
    backend.enqueueScript([
      { kind: "usage", inputTokens: 10, cachedInputTokens: 50, outputTokens: 5 },
    ]);
    const badUsageRef = await backend.start(makeRunSpec({ runId: "r-bad-usage" }));
    const badUsageEvents = await collectAll(backend.events(badUsageRef));
    expect(badUsageEvents).toHaveLength(1);
    expect(badUsageEvents[0]).toMatchObject({ kind: "exit", reason: "failed" });

    // Unknown approval and active-turn send guard
    await expect(backend.answer("apr-missing", true)).rejects.toThrow(/Unknown or already resolved/);

    backend.enqueueScript([{ kind: "wait_for_cancel" }]);
    const activeRef = await backend.start(makeRunSpec({ runId: "r-busy" }));
    await expect(backend.send(activeRef, "concurrent")).rejects.toThrow(/active turn/i);
    await backend.cancel(activeRef);
    await collectAll(backend.events(activeRef));

    // Rejects send after dispose
    await backend.dispose();
    await expect(backend.send(activeRef, "after dispose")).rejects.toThrow(/disposed/i);
  });
});

describe("BackendRegistry", () => {
  it("registers, rejects duplicates unless replace=true, resolves sessions, and disposes all", async () => {
    const registry = new BackendRegistry();
    const fake1 = new FakeBackend({ backendId: "fake-1" });
    const fake2 = new FakeBackend({ backendId: "fake-2" });

    registry.register(fake1);
    registry.register(fake2);

    expect(registry.has("fake-1")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("fake-1")).toBe(fake1);

    expect(() => registry.register(new FakeBackend({ backendId: "fake-1" }))).toThrow(
      /already registered/i,
    );

    const replacement = new FakeBackend({ backendId: "fake-1" });
    registry.register(replacement, { replace: true });
    expect(registry.get("fake-1")).toBe(replacement);

    const sessionRef = await replacement.start(makeRunSpec());
    expect(registry.resolveForSession(sessionRef)).toBe(replacement);
    await collectAll(replacement.events(sessionRef));

    expect(() => registry.get("nonexistent")).toThrowError(UnknownBackendError);
    expect(() =>
      registry.resolveForSession({ backendId: "nonexistent", sessionId: "s-1" }),
    ).toThrowError(UnknownBackendError);

    await registry.disposeAll();
    expect(registry.list()).toHaveLength(0);
    expect((await replacement.probe(sessionRef)).status).toBe("closed");
  });

  it("propagates errors during disposeAll without skipping remaining backends", async () => {
    const registry = new BackendRegistry();
    const cleanBackend = new FakeBackend({ backendId: "clean" });
    let cleanDisposed = false;
    const origDispose = cleanBackend.dispose.bind(cleanBackend);
    cleanBackend.dispose = async () => {
      cleanDisposed = true;
      await origDispose();
    };

    const failingBackend: FakeBackend = new FakeBackend({ backendId: "failing" });
    failingBackend.dispose = async () => {
      throw new Error("dispose failure");
    };

    registry.register(failingBackend);
    registry.register(cleanBackend);

    await expect(registry.disposeAll()).rejects.toThrow("dispose failure");
    expect(cleanDisposed).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });
});

describe("Dependency boundary invariant", () => {
  it("contains zero SDK client imports outside packages/kernel/src/backend/paseo/", () => {
    const kernelSrcDir = path.resolve(import.meta.dirname, "../..");
    const allowedPaseoDir = path.join(kernelSrcDir, "backend", "paseo");
    const forbiddenPkg = ["@getpaseo", "client"].join("/");

    function collectNonPaseoTsFiles(dir: string): string[] {
      const files: string[] = [];
      for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (fullPath === allowedPaseoDir || entry === "__tests__") {
            continue;
          }
          files.push(...collectNonPaseoTsFiles(fullPath));
        } else if (entry.endsWith(".ts")) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const sourceFiles = collectNonPaseoTsFiles(kernelSrcDir);
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, "utf8");
      expect(content).not.toContain(forbiddenPkg);
    }
  });
});
