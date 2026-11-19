import {
  calculateTurnCostUsd,
  type RunEvent,
  RunEventSchema,
  type RunUsage,
  RunUsageSchema,
  type SessionRef,
  SessionRefSchema,
} from "@kiln/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ApprovalRequestEvent,
  type BackendRunSpec,
  type ExecutionBackend,
  isFullAccessMode,
} from "../types.js";

export interface BackendContractHarness {
  backend: ExecutionBackend;
  createStreamingRun(): Promise<BackendRunSpec> | BackendRunSpec;
  createCancellableRun(): Promise<BackendRunSpec> | BackendRunSpec;
  createApprovalRun(branch: "deny" | "allow"): Promise<BackendRunSpec> | BackendRunSpec;
  createMultiTurnRun():
    | Promise<{ runSpec: BackendRunSpec; followUpMessage: string }>
    | { runSpec: BackendRunSpec; followUpMessage: string };
  cancelTimeoutMs?: number;
  cleanup?(): Promise<void> | void;
}

async function collectTurnEvents(
  backend: ExecutionBackend,
  sessionRef: SessionRef,
  timeoutMs = 5_000,
): Promise<RunEvent[]> {
  const collected: RunEvent[] = [];
  const iterator = backend.events(sessionRef)[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await iterator.return?.();
      throw new Error(`Timed out after ${timeoutMs}ms waiting for session ${sessionRef.sessionId} events`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for next RunEvent on ${sessionRef.sessionId}`,
            ),
          );
        }, remaining);
      }),
    ]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });

    if (step.done) {
      break;
    }
    const validated = RunEventSchema.parse(step.value);
    collected.push(validated);
  }

  return collected;
}

function assertSingleExitAtEnd(
  events: readonly RunEvent[],
  expectedReason?: "completed" | "cancelled" | "failed",
): Extract<RunEvent, { kind: "exit" }> {
  const exits = events.filter(
    (event): event is Extract<RunEvent, { kind: "exit" }> => event.kind === "exit",
  );
  expect(exits).toHaveLength(1);
  const lastEvent = events.at(-1);
  expect(lastEvent?.kind).toBe("exit");
  const exitEvent = exits[0]!;
  if (expectedReason !== undefined) {
    expect(exitEvent.reason).toBe(expectedReason);
  }
  return exitEvent;
}

/**
 * Shared backend-agnostic contract suite aligned with docs/architecture-and-engineering.md §7.3.
 */
export function verifyBackendContract(
  suiteName: string,
  createHarness: () => Promise<BackendContractHarness> | BackendContractHarness,
): void {
  describe(`${suiteName} · ExecutionBackend contract`, () => {
    let harness: BackendContractHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.cleanup?.();
      await harness.backend.dispose?.();
    });

    it("1. streams ordered RunEvents after start() and ends with exactly one exit event", async () => {
      const runSpec = await harness.createStreamingRun();
      const sessionRef = SessionRefSchema.parse(await harness.backend.start(runSpec));

      expect(sessionRef.backendId).toBe(harness.backend.backendId);
      expect(sessionRef.sessionId.length).toBeGreaterThan(0);

      const events = await collectTurnEvents(harness.backend, sessionRef);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((event) => event.kind !== "exit")).toBe(true);

      assertSingleExitAtEnd(events, "completed");

      const probe = await harness.backend.probe(sessionRef);
      expect(probe.status).not.toBe("running");
      expect(probe.activeTurnId ?? null).toBeNull();
    });

    it("2. terminates active turn within timeout on cancel() and emits exit(reason='cancelled')", async () => {
      const runSpec = await harness.createCancellableRun();
      const timeoutMs = harness.cancelTimeoutMs ?? 5_000;
      const sessionRef = await harness.backend.start(runSpec);

      const initialProbe = await harness.backend.probe(sessionRef);
      expect(initialProbe.alive).toBe(true);
      expect(initialProbe.status).toBe("running");

      const eventsPromise = collectTurnEvents(harness.backend, sessionRef, timeoutMs);
      const startedAt = Date.now();
      await harness.backend.cancel(sessionRef);
      const events = await eventsPromise;
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(timeoutMs);
      assertSingleExitAtEnd(events, "cancelled");

      const afterProbe = await harness.backend.probe(sessionRef);
      expect(["idle", "closed"]).toContain(afterProbe.status);
      expect(afterProbe.activeTurnId ?? null).toBeNull();
    });

    it("3. triggers onApproval in restricted mode and enforces answer(id, false) and answer(id, true)", async () => {
      // Branch A: deny out-of-scope action
      const denySpec = await harness.createApprovalRun("deny");
      expect(denySpec.allowFullAccessFallback).not.toBe(true);

      const denyRequests: ApprovalRequestEvent[] = [];
      const unsubDeny = harness.backend.onApproval(async (req) => {
        denyRequests.push(req);
        await harness.backend.answer(req.id, false, "Denied by policy");
      });

      const denySession = await harness.backend.start(denySpec);
      if (denySession.meta?.modeId) {
        expect(
          isFullAccessMode({ id: denySession.meta.modeId, label: denySession.meta.modeId }),
        ).toBe(false);
      }

      const denyEvents = await collectTurnEvents(harness.backend, denySession);
      unsubDeny();

      expect(denyRequests.length).toBeGreaterThanOrEqual(1);
      const deniedReq = denyRequests[0]!;
      expect(deniedReq.sessionRef.sessionId).toBe(denySession.sessionId);
      expect(
        denyEvents.some(
          (event) => event.kind === "approval" && event.id === deniedReq.id,
        ),
      ).toBe(true);

      const denyApprovalIndex = denyEvents.findIndex(
        (event) => event.kind === "approval" && event.id === deniedReq.id,
      );
      expect(
        denyEvents.slice(denyApprovalIndex + 1).some((event) => event.kind === "file_write"),
      ).toBe(false);
      assertSingleExitAtEnd(denyEvents);

      // Branch B: allow action after approval
      const allowSpec = await harness.createApprovalRun("allow");
      expect(allowSpec.allowFullAccessFallback).not.toBe(true);

      const allowRequests: ApprovalRequestEvent[] = [];
      const unsubAllow = harness.backend.onApproval(async (req) => {
        allowRequests.push(req);
        await harness.backend.answer(req.id, true);
      });

      const allowSession = await harness.backend.start(allowSpec);
      const allowEvents = await collectTurnEvents(harness.backend, allowSession);
      unsubAllow();

      expect(allowRequests.length).toBeGreaterThanOrEqual(1);
      const allowedReq = allowRequests[0]!;
      expect(allowedReq.sessionRef.sessionId).toBe(allowSession.sessionId);
      expect(
        allowEvents.some(
          (event) => event.kind === "approval" && event.id === allowedReq.id,
        ),
      ).toBe(true);

      const allowApprovalIndex = allowEvents.findIndex(
        (event) => event.kind === "approval" && event.id === allowedReq.id,
      );
      expect(
        allowEvents
          .slice(allowApprovalIndex + 1)
          .some((event) => event.kind === "file_write" || event.kind === "tool" || event.kind === "message"),
      ).toBe(true);
      assertSingleExitAtEnd(allowEvents, "completed");
    });

    it("4. aggregates multi-turn (start + send) usage idempotently by unique turnId", async () => {
      const { runSpec, followUpMessage } = await harness.createMultiTurnRun();
      const sessionRef = await harness.backend.start(runSpec);
      const turn1Events = await collectTurnEvents(harness.backend, sessionRef);
      assertSingleExitAtEnd(turn1Events, "completed");

      await harness.backend.send(sessionRef, followUpMessage);
      const turn2Events = await collectTurnEvents(harness.backend, sessionRef);
      assertSingleExitAtEnd(turn2Events, "completed");

      const turn1Usages = turn1Events.filter(
        (event): event is Extract<RunEvent, { kind: "usage" }> => event.kind === "usage",
      );
      const turn2Usages = turn2Events.filter(
        (event): event is Extract<RunEvent, { kind: "usage" }> => event.kind === "usage",
      );

      expect(turn1Usages.length).toBeGreaterThanOrEqual(1);
      expect(turn2Usages.length).toBeGreaterThanOrEqual(1);

      const turn1Ids = new Set(turn1Usages.map((usage) => usage.turnId));
      const turn2Ids = new Set(turn2Usages.map((usage) => usage.turnId));
      for (const id of turn1Ids) {
        expect(turn2Ids.has(id)).toBe(false);
      }

      // Simulate Kiln idempotent (run_id, turn_id) upsert including duplicate replay protection.
      const aggregatedByTurn = new Map<string, RunUsage>();
      for (const usage of [...turn1Usages, ...turn2Usages, ...turn1Usages, ...turn2Usages]) {
        const parsed = RunUsageSchema.parse(usage);
        aggregatedByTurn.set(`${runSpec.runId}:${parsed.turnId}`, parsed);
      }

      expect(aggregatedByTurn.size).toBe(turn1Ids.size + turn2Ids.size);

      const expectedInput = [...turn1Usages, ...turn2Usages].reduce(
        (sum, usage) => sum + usage.inputTokens,
        0,
      );
      const expectedOutput = [...turn1Usages, ...turn2Usages].reduce(
        (sum, usage) => sum + usage.outputTokens,
        0,
      );

      let actualInput = 0;
      let actualOutput = 0;
      for (const usage of aggregatedByTurn.values()) {
        actualInput += usage.inputTokens;
        actualOutput += usage.outputTokens;
        const cost = calculateTurnCostUsd(usage, { in: 1.25, cached: 0.125, out: 10.0 });
        expect(Number.isFinite(cost)).toBe(true);
        expect(cost).toBeGreaterThanOrEqual(0);
      }

      expect(actualInput).toBe(expectedInput);
      expect(actualOutput).toBe(expectedOutput);
    });
  });
}
