import { describe, expect, it } from "vitest";
import {
  GateReportSchema,
  PRIORITY_RANK,
  RunMetaSchema,
  StateEventSchema,
  TaskCardSchema,
} from "../card.js";

function validCard() {
  return {
    schema_version: 1 as const,
    id: "t-118",
    title: "回执 Schema 强校验与过期 run_id 拒收",
    space: "kiln",
    priority: "P1" as const,
    track: "L2" as const,
    workspace_mode: "git_worktree" as const,
    parent: null,
    depends_on: ["t-117"],
    contract_version: 1,
    contract: {
      goal: "提交回执时按 run_id 租约校验",
      end: "合入 main，验真与审查通过",
      accept_cmd: "pnpm test packages/kernel",
      accept_files_hash: "sha256:abc123",
      scope: ["packages/kernel/**"],
      deliver: { mode: "merge_main" as const, cmd: null },
      human_accept: false,
      external_actions: "ask" as const,
    },
    limits: {
      retries_per_stage: 2,
      review_rounds: 2,
      advisor_calls: 1,
      max_tokens: 250000,
    },
    created_at: "2026-11-19T12:00:00.000Z",
    updated_at: "2026-11-19T12:00:00.000Z",
  };
}

describe("card schemas", () => {
  it("accepts a valid TaskCard and enforces priority order", () => {
    const parsed = TaskCardSchema.parse(validCard());
    expect(parsed.id).toBe("t-118");
    expect(PRIORITY_RANK.P0).toBeLessThan(PRIORITY_RANK.P1);
    expect(PRIORITY_RANK.P1).toBeLessThan(PRIORITY_RANK.P2);
    expect(PRIORITY_RANK.P2).toBeLessThan(PRIORITY_RANK.P3);
  });

  it("rejects deliver.mode=run_cmd when cmd is null or blank", () => {
    const missingCmd = validCard();
    // @ts-expect-error testing invalid runtime input
    missingCmd.contract.deliver = { mode: "run_cmd", cmd: null };
    expect(TaskCardSchema.safeParse(missingCmd).success).toBe(false);

    const blankCmd = validCard();
    // @ts-expect-error testing invalid runtime input
    blankCmd.contract.deliver = { mode: "run_cmd", cmd: "   " };
    expect(TaskCardSchema.safeParse(blankCmd).success).toBe(false);

    const okCmd = validCard();
    // @ts-expect-error reassign discriminated branch
    okCmd.contract.deliver = { mode: "run_cmd", cmd: "pnpm release" };
    expect(TaskCardSchema.safeParse(okCmd).success).toBe(true);
  });

  it("rejects unknown track, workspace_mode, or non-positive contract_version", () => {
    const badTrack = { ...validCard(), track: "L9" };
    expect(TaskCardSchema.safeParse(badTrack).success).toBe(false);

    const badWorkspace = { ...validCard(), workspace_mode: "free_for_all" };
    expect(TaskCardSchema.safeParse(badWorkspace).success).toBe(false);

    const badVersion = { ...validCard(), contract_version: 0 };
    expect(TaskCardSchema.safeParse(badVersion).success).toBe(false);
  });

  it("validates RunMeta, StateEvent discriminated union, and GateReport", () => {
    const runMeta = RunMetaSchema.parse({
      run_id: "run-001",
      task_id: "t-118",
      stage: "implement",
      round: 1,
      role: "worker",
      contract_version: 1,
      backend_id: "paseo",
      agent: "codex",
      model: "gpt-6.2-sol",
      session_ref: { backendId: "paseo", sessionId: "sess-1" },
      started_at: "2026-11-19T12:00:00.000Z",
    });
    expect(runMeta.session_ref.backendId).toBe("paseo");

    const event = StateEventSchema.parse({
      type: "contract_updated",
      at: "2026-11-19T12:05:00.000Z",
      from_version: 1,
      to_version: 2,
      affected_stages: ["implement", "verify", "review"],
    });
    expect(event.type).toBe("contract_updated");

    const gate = GateReportSchema.parse({
      schema_version: 1,
      run_id: "run-001",
      contract_version: 1,
      schema_ok: true,
      scope_ok: true,
      out_of_scope_paths: [],
      frozen_files_changed: [],
      accept_exit_code: 0,
      accept_duration_ms: 420,
      escalated_to_l2: false,
      checked_at: "2026-11-19T12:06:00.000Z",
    });
    expect(gate.escalated_to_l2).toBe(false);
  });
});
