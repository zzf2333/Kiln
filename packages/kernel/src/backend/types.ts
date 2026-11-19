import type {
  BackendCapabilities,
  ReasoningEffort,
  RoleId,
  RunEvent,
  SessionRef,
} from "@kiln/protocol";

export interface BackendModeDescriptor {
  id: string;
  label: string;
  description?: string;
  isFullAccess?: boolean;
}

export interface BackendAgentDescriptor {
  id: string;
  label: string;
  capabilities: BackendCapabilities;
  modes: BackendModeDescriptor[];
  defaultModeId?: string | null;
}

export interface BackendModelDescriptor {
  id: string;
  label: string;
  description?: string;
  thinkingOptions: ReasoningEffort[];
  defaultThinkingOptionId?: ReasoningEffort;
}

export interface McpStdioMountSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface BackendRunSpec {
  runId: string;
  taskId: string;
  role: RoleId;
  agent: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  freshContext: boolean;
  allowFullAccessFallback?: boolean;
  mcpServers?: McpStdioMountSpec[];
  env?: Record<string, string>;
}

export interface ApprovalRequestEvent {
  id: string;
  sessionRef: SessionRef;
  action: string;
  detail: string;
  at: string;
}

export type ApprovalHandler = (request: ApprovalRequestEvent) => void | Promise<void>;

export interface SessionProbeResult {
  alive: boolean;
  status: "running" | "idle" | "closed" | "unknown";
  activeTurnId?: string | null;
  detail?: string;
}

/**
 * Execution backend abstraction isolating Kiln kernel from underlying agent runners.
 */
export interface ExecutionBackend {
  readonly backendId: string;
  listAgents(): Promise<BackendAgentDescriptor[]>;
  listModels(agent: string): Promise<BackendModelDescriptor[]>;
  capabilities(agent: string): Promise<BackendCapabilities>;
  start(runSpec: BackendRunSpec): Promise<SessionRef>;
  send(sessionRef: SessionRef, message: string): Promise<void>;
  events(sessionRef: SessionRef): AsyncIterable<RunEvent>;
  onApproval(handler: ApprovalHandler): () => void;
  answer(approvalId: string, allow: boolean, message?: string): Promise<void>;
  cancel(sessionRef: SessionRef): Promise<void>;
  probe(sessionRef: SessionRef): Promise<SessionProbeResult>;
  liveViewUrl(sessionRef: SessionRef): Promise<string | null>;
  dispose?(): Promise<void>;
}

/**
 * Raised when a provider only exposes full-access modes and unattended fallback is not allowed.
 */
export class FullAccessOnlyProviderError extends Error {
  readonly agent: string;
  readonly modes: readonly BackendModeDescriptor[];

  constructor(agent: string, modes: readonly BackendModeDescriptor[]) {
    const modeIds = modes.map((mode) => mode.id).join(", ");
    super(
      `Provider "${agent}" only exposes full-access modes (${modeIds || "none"}) and cannot be dispatched without allowFullAccessFallback`,
    );
    this.name = "FullAccessOnlyProviderError";
    this.agent = agent;
    this.modes = modes.map((mode) => ({ ...mode }));
  }
}

/**
 * Raised when an agent lacks required capabilities for a given Kiln role (e.g. intake/resolver).
 */
export class IneligibleRoleAgentError extends Error {
  readonly role: RoleId;
  readonly agent: string;
  readonly missingCapabilities: readonly (keyof BackendCapabilities)[];

  constructor(
    role: RoleId,
    agent: string,
    missingCapabilities: readonly (keyof BackendCapabilities)[],
  ) {
    super(
      `Agent "${agent}" is ineligible for role "${role}": missing required capabilities (${missingCapabilities.join(", ")})`,
    );
    this.name = "IneligibleRoleAgentError";
    this.role = role;
    this.agent = agent;
    this.missingCapabilities = [...missingCapabilities];
  }
}

/**
 * Raised when a backendId cannot be resolved in BackendRegistry.
 */
export class UnknownBackendError extends Error {
  readonly backendId: string;

  constructor(backendId: string) {
    super(`Unknown execution backend: "${backendId}"`);
    this.name = "UnknownBackendError";
    this.backendId = backendId;
  }
}

const FULL_ACCESS_PATTERN = /full[-_\s]?access|bypass/i;

/**
 * Identifies whether a backend permission mode grants unrestricted full-access/bypass execution.
 */
export function isFullAccessMode(mode: BackendModeDescriptor): boolean {
  if (mode.isFullAccess === true) {
    return true;
  }
  return FULL_ACCESS_PATTERN.test(mode.id) || FULL_ACCESS_PATTERN.test(mode.label);
}

/**
 * Selects the safest non-full-access modeId for a provider, aligned with M0 probe findings:
 * - empty modes (e.g. Pi) returns undefined so callers omit modeId completely;
 * - providers with restricted modes prefer "auto", then "default", then first non-full-access mode;
 * - full-access-only providers throw FullAccessOnlyProviderError unless allowFullAccessFallback is true.
 */
export function selectSafeModeId(
  agent: string,
  modes: readonly BackendModeDescriptor[],
  options?: { allowFullAccessFallback?: boolean },
): string | undefined {
  if (modes.length === 0) {
    return undefined;
  }

  const safeModes = modes.filter((mode) => !isFullAccessMode(mode));
  if (safeModes.length > 0) {
    const preferred =
      safeModes.find((mode) => mode.id === "auto") ??
      safeModes.find((mode) => mode.id === "default") ??
      safeModes[0];
    return preferred?.id;
  }

  if (options?.allowFullAccessFallback === true) {
    return modes[0]?.id;
  }

  throw new FullAccessOnlyProviderError(agent, modes);
}

const INTERACTIVE_MCP_ROLES: ReadonlySet<RoleId> = new Set<RoleId>(["intake", "resolver"]);

/**
 * Enforces role-level capability requirements: interactive chat roles (intake, resolver)
 * require both interactiveChat and mcpInjection.
 */
export function assertRoleAgentEligible(
  role: RoleId,
  agent: string,
  caps: BackendCapabilities,
): void {
  if (!INTERACTIVE_MCP_ROLES.has(role)) {
    return;
  }

  const missing: (keyof BackendCapabilities)[] = [];
  if (!caps.interactiveChat) {
    missing.push("interactiveChat");
  }
  if (!caps.mcpInjection) {
    missing.push("mcpInjection");
  }

  if (missing.length > 0) {
    throw new IneligibleRoleAgentError(role, agent, missing);
  }
}
