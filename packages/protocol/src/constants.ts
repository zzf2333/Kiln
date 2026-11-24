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
  "plan",
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

export const WORKFLOW_PRESETS = [
  "quick",
  "host_op",
  "standard_dev",
  "full_delivery",
  "custom",
] as const;
export type WorkflowPreset = (typeof WORKFLOW_PRESETS)[number];

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

/**
 * Decision categories that may be routed to the fresh-context `advisor` role before interrupting the user.
 * Any category outside this allowlist (scope, frozen tests, contract changes, external actions, etc.) fails closed to human review.
 */
export const ADVISOR_ELIGIBLE_DECISION_CATEGORIES = [
  "technical_ambiguity",
  "design_tradeoff",
  "layout_ambiguity",
  "implementation_choice",
  "architecture_choice",
] as const;
export type AdvisorEligibleDecisionCategory =
  (typeof ADVISOR_ELIGIBLE_DECISION_CATEGORIES)[number];

export function isAdvisorEligibleDecisionCategory(
  category: string,
): category is AdvisorEligibleDecisionCategory {
  return (ADVISOR_ELIGIBLE_DECISION_CATEGORIES as readonly string[]).includes(
    category.trim().toLowerCase(),
  );
}

export const DEFAULT_LOCAL_PORT = 4310;
export const DEFAULT_REMOTE_PORT = 4311;

export const REMOTE_NOTIFICATION_CHANNELS = ["bark", "ntfy", "webhook"] as const;
export type RemoteNotificationChannel = (typeof REMOTE_NOTIFICATION_CHANNELS)[number];

export const DEFAULT_REMOTE_NOTIFICATION_PRIORITIES: readonly Priority[] = ["P0", "P1"];

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export const PROVIDER_ADAPTER_KINDS = [
  "acp",
  "codex_app_server",
  "pi_rpc",
  "claude_direct",
  "paseo",
] as const;
export type ProviderAdapterKind = (typeof PROVIDER_ADAPTER_KINDS)[number];

export const PROVIDER_USAGE_SCOPES = [
  "per_turn",
  "per_message",
  "cumulative_thread",
] as const;
export type ProviderUsageScope = (typeof PROVIDER_USAGE_SCOPES)[number];

export const COST_SOURCES = [
  "custom",
  "local_agent",
  "catalog",
  "provider_reported",
  "unknown",
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const ROSTER_GROUPS = ["core", "specialist", "kernel", "custom"] as const;
export type RosterGroup = (typeof ROSTER_GROUPS)[number];

export const ROSTER_PERMISSIONS = [
  "read_only",
  "read_only_draft",
  "workspace_write",
  "host_staged",
  "accept_entry",
  "kernel_gate",
] as const;
export type RosterPermission = (typeof ROSTER_PERMISSIONS)[number];

export const ROSTER_EXECUTION_MODES = ["agent", "kernel", "on_conflict"] as const;
export type RosterExecutionMode = (typeof ROSTER_EXECUTION_MODES)[number];

export const ROSTER_TIER_HINTS = ["economy", "standard", "flagship"] as const;
export type RosterTierHint = (typeof ROSTER_TIER_HINTS)[number];

export const CORE_COGNITIVE_ROSTER_IDS = [
  "researcher",
  "pm",
  "advisor",
  "fast_fix",
  "main_dev",
  "reviewer",
  "verifier",
] as const;

export const DERIVED_ROSTER_INHERITANCE: Readonly<Record<string, readonly string[]>> = {
  architect: ["advisor", "pm"],
  triage: ["advisor", "pm"],
  resolver: ["pm"],
  retro: ["advisor", "pm"],
};

export const BUILTIN_ROSTER_ROLE_IDS = [
  "pm",
  "researcher",
  "architect",
  "advisor",
  "main_dev",
  "fast_fix",
  "reviewer",
  "verifier",
  "frontend_ui",
  "debugger",
  "ops_sec",
  "doc_writer",
  "tester",
  "deliverer",
  "triage",
  "resolver",
  "retro",
] as const;
export type BuiltinRosterRoleId = (typeof BUILTIN_ROSTER_ROLE_IDS)[number];

export const ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const SPACE_SCRIPT_KEYS = ["setup", "dev", "test", "lint", "deliver"] as const;
export type SpaceScriptKey = (typeof SPACE_SCRIPT_KEYS)[number];

export const ACCEPT_ENTRY_KINDS = [
  "http_server",
  "desktop_app",
  "cli_binary",
  "none",
] as const;
export type AcceptEntryKind = (typeof ACCEPT_ENTRY_KINDS)[number];

export const ACCEPT_PROBE_KINDS = ["http", "tcp", "stdout_regex", "delay"] as const;
export type AcceptProbeKind = (typeof ACCEPT_PROBE_KINDS)[number];

export const VERIFIER_CAPABILITIES = ["cli", "browser", "desktop_gui"] as const;
export type VerifierCapability = (typeof VERIFIER_CAPABILITIES)[number];

export const VERIFIER_ENTRY_MODES = [
  "browser",
  "desktop_gui",
  "cli",
  "artifact",
] as const;
export type VerifierEntryMode = (typeof VERIFIER_ENTRY_MODES)[number];

export const RETRO_ATTRIBUTION_CATEGORIES = [
  "intake_contract",
  "recon_plan",
  "model_fit",
  "context_cache",
  "space_rule",
] as const;
export type RetroAttributionCategory = (typeof RETRO_ATTRIBUTION_CATEGORIES)[number];

export const IMPROVEMENT_TARGET_KINDS = [
  "space_ledger",
  "space_ledger_merge",
  "space_ledger_archive",
  "space_intake_checklist",
  "space_accept_scenario",
  "roster_custom_instructions",
  "roster_policy",
  "space_default_workflow",
] as const;
export type ImprovementTargetKind = (typeof IMPROVEMENT_TARGET_KINDS)[number];

export const IMPROVEMENT_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "dismissed",
] as const;
export type ImprovementProposalStatus = (typeof IMPROVEMENT_PROPOSAL_STATUSES)[number];

export const MAX_ACTIVE_LEDGER_INJECT = 20;

export function isReadOnlyRosterPermission(perm: RosterPermission): boolean {
  return perm === "read_only" || perm === "read_only_draft";
}

export function isWriteCapableRosterPermission(perm: RosterPermission): boolean {
  return perm === "workspace_write" || perm === "host_staged";
}
