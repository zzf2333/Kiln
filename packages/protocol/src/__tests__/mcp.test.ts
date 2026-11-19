import { describe, expect, it } from "vitest";
import {
  isRoleAllowedForTool,
  MCP_TOOL_NAMES,
  RunTokenClaimsSchema,
  WbPlanInputSchema,
} from "../mcp.js";

describe("mcp contract and role allowlist", () => {
  it("exposes strictly the 7 allowed tools and excludes merge/push/publish tools", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "wb_get_context",
      "wb_list_tasks",
      "wb_read_ledger",
      "wb_plan",
      "wb_ask_decision",
      "wb_submit_receipt",
      "wb_propose_ledger",
    ]);
    const banned = ["merge", "push", "publish", "delete_branch", "close_task"];
    for (const tool of banned) {
      expect((MCP_TOOL_NAMES as readonly string[]).includes(tool)).toBe(false);
    }
  });

  it("enforces role permissions accurately across all 7 roles", () => {
    expect(isRoleAllowedForTool("worker", "wb_plan")).toBe(false);
    expect(isRoleAllowedForTool("reviewer", "wb_plan")).toBe(false);
    expect(isRoleAllowedForTool("intake", "wb_plan")).toBe(true);
    expect(isRoleAllowedForTool("triage", "wb_plan")).toBe(true);
    expect(isRoleAllowedForTool("resolver", "wb_plan")).toBe(true);

    expect(isRoleAllowedForTool("intake", "wb_submit_receipt")).toBe(false);
    expect(isRoleAllowedForTool("resolver", "wb_submit_receipt")).toBe(false);
    expect(isRoleAllowedForTool("worker", "wb_submit_receipt")).toBe(true);
    expect(isRoleAllowedForTool("reviewer", "wb_submit_receipt")).toBe(true);
    expect(isRoleAllowedForTool("verifier", "wb_submit_receipt")).toBe(true);
    expect(isRoleAllowedForTool("triage", "wb_submit_receipt")).toBe(true);
    expect(isRoleAllowedForTool("advisor", "wb_submit_receipt")).toBe(true);

    expect(isRoleAllowedForTool("worker", "wb_list_tasks")).toBe(false);
    expect(isRoleAllowedForTool("intake", "wb_list_tasks")).toBe(true);
  });

  it("validates RunTokenClaims and WbPlan discriminated inputs", () => {
    const claims = RunTokenClaimsSchema.parse({
      taskId: "t-1",
      runId: "r-1",
      role: "worker",
      contractVersion: 1,
      iat: 1000,
      exp: 2000,
    });
    expect(claims.role).toBe("worker");

    const plan = WbPlanInputSchema.parse({
      mode: "update_contract",
      task_id: "t-1",
      contract: { accept_cmd: "pnpm test" },
      affected_stages: ["implement", "verify"],
      rationale: "Clarified scope",
    });
    expect(plan.mode).toBe("update_contract");
  });
});
