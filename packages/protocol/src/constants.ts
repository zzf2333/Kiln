export const TASK_STATUSES = [
  "queued",
  "running",
  "paused",
  "waiting",
  "external",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_RANK: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export const TRACKS = ["L1", "L2", "L3"] as const;
export type Track = (typeof TRACKS)[number];

export const WORKSPACE_MODES = [
  "git_worktree",
  "host_scoped",
  "scratch_dir",
  "external_only",
] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const STAGE_IDS = [
  "intake",
  "implement",
  "research",
  "verify",
  "review",
  "accept",
  "triage",
  "advise",
  "deliver",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const DECISION_ACTIONS = [
  "resume",
  "return_external",
  "finish",
  "cancel",
] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const ROLE_IDS = [
  "intake",
  "worker",
  "reviewer",
  "verifier",
  "triage",
  "advisor",
  "resolver",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const MCP_TOOL_NAMES = [
  "wb_get_context",
  "wb_list_tasks",
  "wb_read_ledger",
  "wb_plan",
  "wb_ask_decision",
  "wb_submit_receipt",
  "wb_propose_ledger",
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_ROLE_ALLOWLIST: Record<McpToolName, readonly RoleId[]> = {
  wb_get_context: ROLE_IDS,
  wb_list_tasks: ["intake", "triage", "resolver"],
  wb_read_ledger: ROLE_IDS,
  wb_plan: ["intake", "triage", "resolver"],
  wb_ask_decision: ["worker", "reviewer", "verifier", "triage", "advisor"],
  wb_submit_receipt: ["worker", "reviewer", "verifier", "triage", "advisor"],
  wb_propose_ledger: ROLE_IDS,
};

export function isRoleAllowedForTool(role: RoleId, tool: McpToolName): boolean {
  return MCP_ROLE_ALLOWLIST[tool].includes(role);
}

export const DEFAULT_LOCAL_PORT = 4310;
export const DEFAULT_REMOTE_PORT = 4311;

export const REMOTE_NOTIFICATION_CHANNELS = ["bark", "ntfy", "webhook"] as const;
export type RemoteNotificationChannel = (typeof REMOTE_NOTIFICATION_CHANNELS)[number];

export const DEFAULT_REMOTE_NOTIFICATION_PRIORITIES: readonly Priority[] = ["P0", "P1"];

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
