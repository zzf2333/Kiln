import { createContext } from "react";
import { useContext, useEffect, useState } from "react";
import {
  ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  WORKFLOW_PRESETS,
  buildCustomWorkflow,
  buildWorkflowPreset,
  extractWorkflowToggles,
  validateSplitCardsDag,
  validateWorkflowBlueprint,
  type AttachmentMimeType,
  type ComposableWorkflowOptions,
  type DraftCard,
  type LedgerEntry,
  type LedgerFile,
  type LimitsConfig,
  type PendingDecision,
  type PricingConfig,
  type Priority,
  type RolesConfig,
  type SpaceConfig,
  type SseEvent,
  type StageId,
  type Track,
  type WorkflowAgentNode,
  type WorkflowAgentStage,
  type WorkflowBlueprint,
  type WorkflowPreset,
  type WorkflowStep,
  type WorkspaceMode,
} from "@kiln/protocol/web";
import {
  ApiError,
  cancelTask as apiCancelTask,
  commitDraft as apiCommitDraft,
  commitSplitDraft as apiCommitSplitDraft,
  completeTask as apiCompleteTask,
  deleteDraft as apiDeleteDraft,
  deleteDraftAttachment as apiDeleteDraftAttachment,
  deleteSpace as apiDeleteSpace,
  detectProviders as apiDetectProviders,
  discoverSpaces as apiDiscoverSpaces,
  executeGitDeliver as apiExecuteGitDeliver,
  fetchAgents as apiFetchAgents,
  fetchAuthStatus as apiFetchAuthStatus,
  fetchBootstrap as apiFetchBootstrap,
  fetchDraftChat as apiFetchDraftChat,
  fetchLedgers as apiFetchLedgers,
  fetchPrDraft as apiFetchPrDraft,
  fetchProviders as apiFetchProviders,
  fetchProvidersSettings as apiFetchProvidersSettings,
  fetchRosterSettings as apiFetchRosterSettings,
  fetchScriptRuns as apiFetchScriptRuns,
  fetchTaskChat as apiFetchTaskChat,
  fetchTaskCheckpoints as apiFetchTaskCheckpoints,
  fetchTaskDetail as apiFetchTaskDetail,
  inspectSpacePath as apiInspectSpacePath,
  logoutRemoteDevice as apiLogoutRemoteDevice,
  openRunTui as apiOpenRunTui,
  pairRemoteDevice as apiPairRemoteDevice,
  pauseTask as apiPauseTask,
  pickSpaceDirectory as apiPickSpaceDirectory,
  reconDraft as apiReconDraft,
  restoreHostBackup as apiRestoreHostBackup,
  resumeTask as apiResumeTask,
  revealLocalPath as apiRevealLocalPath,
  rollbackTaskCheckpoint as apiRollbackTaskCheckpoint,
  runSpaceScript as apiRunSpaceScript,
  sendIntakeChat as apiSendIntakeChat,
  sendResolveChat as apiSendResolveChat,
  setUnauthorizedHandler,
  steerTask as apiSteerTask,
  stopScriptRun as apiStopScriptRun,
  submitDecision as apiSubmitDecision,
  subscribeSseEvents,
  syncModelPricing as apiSyncModelPricing,
  testProvider as apiTestProvider,
  updatePriority as apiUpdatePriority,
  updateSettings as apiUpdateSettings,
  uploadDraftAttachment as apiUploadDraftAttachment,
  upsertDraft as apiUpsertDraft,
  upsertSpace as apiUpsertSpace,
} from "../api/client";
import type {
  AgentDescriptorInfo,
  BackendConnectionInfo,
  BootstrapResponse,
  BootstrapTask,
  ChatMessage,
  CheckpointRecord,
  CommitDraftPayload,
  CommitPrActionRequest,
  DeliverGitResponse,
  DiscoveredGitRepo,
  DraftCardWithBrief,
  InspectSpaceResult,
  PairCompleteRequest,
  PrDraftInfo,
  ProviderRuntimeStatus,
  ProvidersConfig,
  PublicPairedDevice,
  RawProviderUsageEntry,
  RestoreHostBackupResult,
  RosterConfig,
  SettingsSectionMap,
  SpaceScriptKey,
  SplitCardPlanItem,
  SubmitDecisionPayload,
  SyncPricingRequest,
  TaskAttachment,
  TaskDetailResponse,
  UpsertSpacePayload,
  UsageSnapshot,
} from "../api/types";
import {
  applyThemeToDocument,
  readStoredThemePreference,
  resolveTheme,
  subscribeSystemThemeChange,
  writeStoredThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

export type MvpView =
  | "board"
  | "lineup"
  | "detail"
  | "inbox"
  | "intake"
  | "resolve"
  | "usage"
  | "ledger"
  | "settings";

export type SettingsTab =
  | "roles"
  | "providers"
  | "spaces"
  | "limits"
  | "pricing"
  | "remote"
  | "conn";
export type PeriodFilter = "week" | "month" | "year" | "all";
export type IntakeMode = "project" | "local";
export type IntakeRightTab = "brief" | "settings";
export type AuthMode = "local" | "remote";

export interface IntakeProgressItem {
  kind: "thinking" | "tool" | "draft_updated";
  text: string;
  toolName?: string;
  at: string;
}

export interface PairSubmitOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  attemptsRemaining?: number;
}

export interface IntakeFormState {
  mode: IntakeMode;
  title: string;
  priority: Priority | "";
  space: string;
  track: Exclude<Track, "L3"> | "";
  workspace_mode: Exclude<WorkspaceMode, "external_only"> | "";
  workflow?: WorkflowBlueprint;
  end: string;
  accept_cmd: string;
  deliver_cmd: string;
  scope: string;
  non_goals: string[];
  attachments: TaskAttachment[];
  split_cards: SplitCardPlanItem[];
  depends_on: string;
  open_questions: string[];
  brief_markdown: string;
  research_markdown: string;
}

function collectAgentAssignmentsByStage(
  workflow: WorkflowBlueprint | undefined,
): Map<WorkflowAgentStage, WorkflowAgentNode> {
  const map = new Map<WorkflowAgentStage, WorkflowAgentNode>();
  if (!workflow) return map;
  for (const step of workflow.steps) {
    if (step.kind === "agent") {
      map.set(step.stage, step);
    } else if (step.kind === "loop") {
      for (const inner of step.steps) {
        if (inner.kind === "agent") {
          map.set(inner.stage, inner);
        }
      }
    }
  }
  return map;
}

function hasResearchStep(workflow: WorkflowBlueprint): boolean {
  return workflow.steps.some(
    (s) =>
      (s.kind === "agent" && s.stage === "research") ||
      (s.kind === "loop" && s.steps.some((inner) => inner.kind === "agent" && inner.stage === "research")),
  );
}

function preserveWorkflowAssignments(
  prev: WorkflowBlueprint | undefined,
  next: WorkflowBlueprint,
  options?: {
    preserveResearch?: boolean;
    dropRosterRoles?: ReadonlySet<string>;
  },
): WorkflowBlueprint {
  if (!prev) return next;
  const prevByStage = collectAgentAssignmentsByStage(prev);
  const dropSet = options?.dropRosterRoles;
  const mapAgentNode = (node: WorkflowAgentNode): WorkflowAgentNode => {
    const old = prevByStage.get(node.stage);
    const mergedRole = node.roster_role ?? old?.roster_role;
    const effectiveRole =
      mergedRole && dropSet?.has(mergedRole) ? undefined : mergedRole;
    const effectiveRationale = node.rationale ?? old?.rationale;
    return {
      ...node,
      ...(effectiveRole !== undefined ? { roster_role: effectiveRole } : {}),
      ...(effectiveRationale !== undefined ? { rationale: effectiveRationale } : {}),
    };
  };

  let steps: WorkflowStep[] = next.steps.map((step) => {
    if (step.kind === "agent") {
      return mapAgentNode(step);
    }
    if (step.kind === "loop") {
      return {
        ...step,
        steps: step.steps.map((inner) =>
          inner.kind === "agent" ? mapAgentNode(inner) : inner,
        ),
      };
    }
    return step;
  });

  if (options?.preserveResearch && !hasResearchStep(next)) {
    const prevResearch = prevByStage.get("research");
    if (prevResearch) {
      const researchNode = mapAgentNode(prevResearch);
      const implIdx = steps.findIndex(
        (s) =>
          (s.kind === "agent" && s.stage === "implement") ||
          s.kind === "loop",
      );
      const insertAt = implIdx >= 0 ? implIdx : steps.length;
      steps = [
        ...steps.slice(0, insertAt),
        researchNode,
        ...steps.slice(insertAt),
      ];
    }
  }

  const pmRationale = next.pm_rationale ?? prev.pm_rationale;
  return {
    ...next,
    steps,
    ...(pmRationale !== undefined ? { pm_rationale: pmRationale } : {}),
  };
}

export function resolveFormEffectiveWorkflow(form: IntakeFormState): WorkflowBlueprint {
  const hasDeliverCmd = form.deliver_cmd.trim().length > 0;
  const base: WorkflowBlueprint = form.workflow
    ? form.workflow
    : form.workspace_mode === "host_scoped"
      ? buildWorkflowPreset("host_op", { hasDeliverCmd })
      : form.track === "L1"
        ? buildWorkflowPreset("quick", { hasDeliverCmd })
        : buildWorkflowPreset("standard_dev", { hasDeliverCmd });

  const toggles = extractWorkflowToggles(base);
  if (toggles.hasDeliverCmd === hasDeliverCmd) {
    return base;
  }
  const rebuilt = buildCustomWorkflow({
    ...toggles,
    preset: base.preset,
    hasDeliverCmd,
  });
  return preserveWorkflowAssignments(form.workflow, rebuilt, {
    preserveResearch: true,
  });
}

export interface ScriptRunBuffer {
  scriptRunId: string;
  spaceId: string;
  taskId?: string;
  scriptKey: SpaceScriptKey;
  command?: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string | null;
  lines: string[];
  done: boolean;
  exitCode: number | null;
  updatedAt: string;
}

export interface ContextWindowSnapshot {
  usedTokens: number;
  contextWindowTokens: number;
  percent: number;
  at: string;
}

export interface KilnStoreState {
  view: MvpView;
  taskId: string | null;
  selectedRunIdx: number | null;
  settingsTab: SettingsTab;
  spaceFilter: string;
  periodFilter: PeriodFilter;
  priorityFilter: "all" | Priority;
  showParentSlices: boolean;
  navOpen: boolean;
  sidebarCollapsed: boolean;
  draftOpen: boolean;
  desktopDraftCollapsed: boolean;
  paletteOpen: boolean;
  toastMessage: string | null;
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;

  bootstrapping: boolean;
  bootstrapLoaded: boolean;
  bootstrapError: string | null;
  daemonVersion: string | null;

  authChecked: boolean;
  authMode: AuthMode;
  authAuthenticated: boolean;
  authDevice: PublicPairedDevice | null;
  authNotice: string | null;
  pendingPairToken: string | null;

  tasks: BootstrapTask[];
  pendingDecisions: PendingDecision[];
  drafts: DraftCard[];
  spaces: Record<string, SpaceConfig>;
  roles: RolesConfig;
  roster: RosterConfig;
  providersConfig: ProvidersConfig | null;
  providersConfigLoaded: boolean;
  providerStatuses: ProviderRuntimeStatus[];
  providerTestBusyId: string | null;
  limits: LimitsConfig;
  pricing: PricingConfig;
  usage: UsageSnapshot;
  runningCount: number;
  ledgers: Record<string, LedgerEntry[]>;
  agents: AgentDescriptorInfo[];
  backends: BackendConnectionInfo[];
  providerUsage: Record<string, RawProviderUsageEntry> | RawProviderUsageEntry[] | undefined;

  ratesByTask: Record<string, number>;
  liveTotals: { costUsd: number; tokPerSec: number } | null;
  sseStatus: "connecting" | "connected" | "reconnecting" | "closed";
  lastConnectedAt: string | null;
  networkOffline: boolean;
  retryingConnection: boolean;

  taskDetails: Record<string, TaskDetailResponse>;
  taskDetailLoading: boolean;
  taskDetailError: string | null;
  restoreResult: RestoreHostBackupResult | null;
  scriptRuns: Record<string, ScriptRunBuffer>;
  scriptDrawerOpen: boolean;
  contextWindowByTask: Record<string, ContextWindowSnapshot>;

  intakeDraftId: string | null;
  intakeForm: IntakeFormState;
  intakeRightTab: IntakeRightTab;
  intakeProgressLogs: IntakeProgressItem[];
  intakeMessages: ChatMessage[];
  intakeBusy: boolean;
  reconBusy: boolean;
  attachmentUploadBusy: boolean;
  intakeActiveOpen: boolean;
  intakeHasUnreadReply: boolean;

  spaceModalOpen: boolean;
  editingSpaceId: string | null;
  spaceModalSelectInIntake: boolean;
  spaceModalPrefillPath: string | null;
  discoveredRepos: DiscoveredGitRepo[];
  discoverBusy: boolean;
  discoverError: string | null;
  discoverLoaded: boolean;
  pickDirBusy: boolean;

  resolveMessagesByTask: Record<string, ChatMessage[]>;
  resolveBusy: boolean;
  pricingSyncBusy: boolean;
}

const VALID_VIEWS = new Set<MvpView>([
  "board",
  "lineup",
  "detail",
  "inbox",
  "intake",
  "resolve",
  "usage",
  "ledger",
  "settings",
]);

const VALID_SETTINGS_TABS = new Set<SettingsTab>([
  "roles",
  "providers",
  "spaces",
  "limits",
  "pricing",
  "remote",
  "conn",
]);

const DEFAULT_LIMITS: LimitsConfig = {
  schema_version: 1,
  max_concurrent_slots: 5,
  p0_extra_slot: true,
  max_waiting_wip: 5,
  retries_per_stage: 2,
  review_rounds: 2,
  advisor_calls: 1,
  max_card_tokens: 250_000,
};

const DEFAULT_ROLES: RolesConfig = {
  schema_version: 1,
  heterogeneous_review: true,
  roles: {},
};

const DEFAULT_ROSTER: RosterConfig = {
  schema_version: 2,
  heterogeneous_review: true,
  pm_orchestration: {
    enabled: true,
    allow_auto_tester: true,
    prefer_unthrottled: true,
    require_review_for_core: true,
  },
  roster: {},
};

const DEFAULT_PRICING: PricingConfig = {
  schema_version: 1,
  models: {},
};

const EMPTY_USAGE: UsageSnapshot = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  byAgent: {},
  byModel: {},
};

export function isProjectSpace(sp: SpaceConfig | undefined): sp is SpaceConfig {
  return Boolean(
    sp &&
      sp.id !== "local" &&
      typeof sp.repo_path === "string" &&
      sp.repo_path.trim().length > 0,
  );
}

export function getProjectSpaces(spaces: Record<string, SpaceConfig>): SpaceConfig[] {
  return Object.values(spaces)
    .filter((sp) => isProjectSpace(sp))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function createDefaultIntakeForm(
  spaces: Record<string, SpaceConfig> = {},
  preferredSpace?: string,
): IntakeFormState {
  if (preferredSpace === "local") {
    return {
      mode: "local",
      title: "",
      priority: "P2",
      space: "local",
      track: "L1",
      workspace_mode: "scratch_dir",
      workflow: buildWorkflowPreset("quick"),
      end: "",
      accept_cmd: "",
      deliver_cmd: "",
      scope: "",
      non_goals: [],
      attachments: [],
      split_cards: [],
      depends_on: "",
      open_questions: [],
      brief_markdown: "",
      research_markdown: "",
    };
  }
  const projects = getProjectSpaces(spaces);
  const preferred =
    preferredSpace && isProjectSpace(spaces[preferredSpace])
      ? spaces[preferredSpace]
      : undefined;
  const chosen = preferred ?? projects[0];
  return {
    mode: "project",
    title: "",
    priority: "P2",
    space: chosen?.id ?? "",
    track: "L2",
    workspace_mode: "git_worktree",
    workflow: buildWorkflowPreset("standard_dev"),
    end: "",
    accept_cmd: chosen?.default_accept_cmd ?? "",
    deliver_cmd: "",
    scope: "",
    non_goals: [],
    attachments: [],
    split_cards: [],
    depends_on: "",
    open_questions: [],
    brief_markdown: "",
    research_markdown: "",
  };
}

export function createEmptyIntakeForm(): IntakeFormState {
  return createDefaultIntakeForm({});
}

function defaultWelcomeIntakeMessages(): ChatMessage[] {
  return [
    {
      who: "agent",
      name: "intake",
      text: "说说你想做什么。代码需求、本机配置或临时沙盒任务都可以。我会把交付终点、验收命令和可改范围定下来；右侧立项单任意字段也可直接手改。",
    },
  ];
}

const ACTIVE_INTAKE_DRAFT_KEY = "kiln.activeIntakeDraftId";
const ACTIVE_INTAKE_LOCAL_KEY = "kiln.activeIntakeLocalDraft";

interface LocalIntakeSnapshot {
  form: IntakeFormState;
  messages: ChatMessage[];
  updatedAt: string;
}

function readStorageItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota or private-browsing errors
  }
}

function removeStorageItem(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

function normalizeIntakeForm(form: IntakeFormState): IntakeFormState {
  return {
    ...form,
    deliver_cmd: typeof form.deliver_cmd === "string" ? form.deliver_cmd : "",
    non_goals: Array.isArray(form.non_goals) ? form.non_goals : [],
    attachments: Array.isArray(form.attachments) ? form.attachments : [],
    split_cards: Array.isArray(form.split_cards) ? form.split_cards : [],
    open_questions: Array.isArray(form.open_questions) ? form.open_questions : [],
    brief_markdown: typeof form.brief_markdown === "string" ? form.brief_markdown : "",
    research_markdown:
      typeof form.research_markdown === "string" ? form.research_markdown : "",
  };
}

function readLocalIntakeSnapshot(): LocalIntakeSnapshot | null {
  const raw = readStorageItem(ACTIVE_INTAKE_LOCAL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LocalIntakeSnapshot>;
    if (!parsed || typeof parsed !== "object" || !parsed.form || !Array.isArray(parsed.messages)) {
      return null;
    }
    return {
      form: normalizeIntakeForm(parsed.form),
      messages: parsed.messages,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function writeLocalIntakeSnapshot(form: IntakeFormState, messages: ChatMessage[]): void {
  writeStorageItem(
    ACTIVE_INTAKE_LOCAL_KEY,
    JSON.stringify({
      form,
      messages,
      updatedAt: new Date().toISOString(),
    } satisfies LocalIntakeSnapshot),
  );
}

function clearActiveIntakePersistence(): void {
  removeStorageItem(ACTIVE_INTAKE_DRAFT_KEY);
  removeStorageItem(ACTIVE_INTAKE_LOCAL_KEY);
}

function draftToIntakeForm(draft: DraftCardWithBrief): IntakeFormState {
  const isLocal = draft.space === "local";
  return {
    mode: isLocal ? "local" : "project",
    title: draft.title,
    priority: draft.priority,
    space: draft.space,
    track: draft.track === "L3" ? "L2" : draft.track,
    workspace_mode: isLocal
      ? (draft.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir")
      : "git_worktree",
    ...(draft.workflow !== undefined ? { workflow: draft.workflow } : {}),
    end: draft.contract.end ?? "",
    accept_cmd: draft.contract.accept_cmd ?? "",
    deliver_cmd:
      draft.contract.deliver?.mode === "run_cmd" ? draft.contract.deliver.cmd : "",
    scope: (draft.contract.scope ?? []).join("\n"),
    non_goals: Array.isArray(draft.contract.non_goals)
      ? [...draft.contract.non_goals]
      : [],
    attachments: Array.isArray(draft.attachments) ? [...draft.attachments] : [],
    split_cards: [],
    depends_on: draft.depends_on.join(", "),
    open_questions: Array.isArray(draft.open_questions) ? draft.open_questions : [],
    brief_markdown: typeof draft.brief_markdown === "string" ? draft.brief_markdown : "",
    research_markdown:
      typeof draft.research_markdown === "string" ? draft.research_markdown : "",
  };
}

async function fileToBase64(file: File): Promise<string> {
  if (typeof file.arrayBuffer === "function") {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const chunkSize = 8192;
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(""));
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const idx = raw.indexOf(",");
      resolve(idx >= 0 ? raw.slice(idx + 1) : raw);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片文件失败"));
    reader.readAsDataURL(file);
  });
}

function extractRawSplitCardsFromReply(
  text: string,
): Array<Record<string, unknown>> | null {
  const match = text.match(/```kiln-split-cards[ \t]*\r?\n([\s\S]*?)\r?\n```/i);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    const rawCards = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { cards?: unknown }).cards)
        ? (parsed as { cards: unknown[] }).cards
        : null;
    if (!rawCards || rawCards.length < 2 || rawCards.length > 12) return null;
    const valid = rawCards.filter(
      (item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        const rec = item as Record<string, unknown>;
        if (typeof rec.temp_id !== "string" || !rec.temp_id.trim()) return false;
        if (typeof rec.title !== "string" || !rec.title.trim()) return false;
        if (
          rec.contract !== undefined &&
          (rec.contract === null || typeof rec.contract !== "object")
        ) {
          return false;
        }
        return true;
      },
    );
    return valid.length === rawCards.length ? valid : null;
  } catch {
    return null;
  }
}

function findSpaceByRepoPath(
  repoPath: string,
  spaces: Record<string, SpaceConfig>,
): SpaceConfig | undefined {
  return Object.values(spaces).find(
    (sp) => isProjectSpace(sp) && sp.repo_path === repoPath,
  );
}

function parseLocationHash(): {
  view: MvpView;
  taskId: string | null;
  settingsTab: SettingsTab;
  hadInvalidRoute: boolean;
  pairToken: string | null;
} {
  if (typeof window === "undefined") {
    return {
      view: "board",
      taskId: null,
      settingsTab: "roles",
      hadInvalidRoute: false,
      pairToken: null,
    };
  }
  const raw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!raw) {
    // Support push notification deep links like /tasks/<taskId>
    const pathMatch = /^\/tasks\/([^/]+)$/.exec(window.location.pathname);
    if (pathMatch && pathMatch[1]) {
      try {
        return {
          view: "detail",
          taskId: decodeURIComponent(pathMatch[1]),
          settingsTab: "roles",
          hadInvalidRoute: false,
          pairToken: null,
        };
      } catch {
        // Ignore malformed URI encoding
      }
    }
    return {
      view: "board",
      taskId: null,
      settingsTab: "roles",
      hadInvalidRoute: false,
      pairToken: null,
    };
  }
  const params = new URLSearchParams(raw);
  const pairParam = params.get("pair")?.trim() ?? "";
  if (pairParam.length > 0) {
    return {
      view: "board",
      taskId: null,
      settingsTab: "roles",
      hadInvalidRoute: false,
      pairToken: pairParam,
    };
  }
  const rawTab = params.get("tab");
  const settingsTab: SettingsTab =
    rawTab && VALID_SETTINGS_TABS.has(rawTab as SettingsTab)
      ? (rawTab as SettingsTab)
      : "roles";

  const taskParam = params.get("task");
  if (taskParam) {
    return {
      view: "detail",
      taskId: taskParam,
      settingsTab,
      hadInvalidRoute: false,
      pairToken: null,
    };
  }
  const resolveParam = params.get("resolve");
  if (resolveParam) {
    return {
      view: "resolve",
      taskId: resolveParam,
      settingsTab,
      hadInvalidRoute: false,
      pairToken: null,
    };
  }
  const viewParam = params.get("view");
  if (viewParam) {
    if (
      viewParam !== "detail" &&
      viewParam !== "resolve" &&
      VALID_VIEWS.has(viewParam as MvpView)
    ) {
      return {
        view: viewParam as MvpView,
        taskId: null,
        settingsTab,
        hadInvalidRoute: false,
        pairToken: null,
      };
    }
    return {
      view: "board",
      taskId: null,
      settingsTab,
      hadInvalidRoute: true,
      pairToken: null,
    };
  }
  return {
    view: "board",
    taskId: null,
    settingsTab,
    hadInvalidRoute: false,
    pairToken: null,
  };
}

function normalizeLedgers(
  raw: BootstrapResponse["ledgers"] | undefined,
): Record<string, LedgerEntry[]> {
  if (!raw) return {};
  const result: Record<string, LedgerEntry[]> = {};
  if (Array.isArray(raw)) {
    for (const file of raw) {
      result[file.space] = [...file.entries];
    }
    return result;
  }
  for (const [space, file] of Object.entries(raw)) {
    const entries = (file as LedgerFile | undefined)?.entries;
    if (Array.isArray(entries)) {
      result[space] = [...entries];
    }
  }
  return result;
}

function stripHostTwoPhaseWorkflow(
  workflow: WorkflowBlueprint,
  hasDeliverCmd: boolean,
  dropRosterRoles?: ReadonlySet<string>,
): WorkflowBlueprint {
  const toggles = extractWorkflowToggles(workflow);
  if (!toggles.hostTwoPhase) {
    return preserveWorkflowAssignments(workflow, workflow, {
      preserveResearch: true,
      ...(dropRosterRoles ? { dropRosterRoles } : {}),
    });
  }
  const nextPreset: WorkflowPreset =
    toggles.preset === "host_op"
      ? toggles.includeReview
        ? "standard_dev"
        : "quick"
      : (toggles.preset ?? workflow.preset);
  const rebuilt = buildCustomWorkflow({
    ...toggles,
    preset: nextPreset,
    hostTwoPhase: false,
    deliverApproval: hasDeliverCmd ? toggles.deliverApproval : false,
    hasDeliverCmd,
  });
  return preserveWorkflowAssignments(workflow, rebuilt, {
    preserveResearch: true,
    ...(dropRosterRoles ? { dropRosterRoles } : {}),
  });
}

export class KilnWebStore {
  private state: KilnStoreState;
  private readonly listeners = new Set<() => void>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private sseCleanup: (() => void) | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private authProbeInFlight: Promise<void> | null = null;
  private systemThemeCleanup: (() => void) | null = null;
  private intakeRestoredOnce = false;

  constructor() {
    const parsed = parseLocationHash();
    const initialThemePref = readStoredThemePreference();
    this.state = {
      view: parsed.view,
      taskId: parsed.taskId,
      selectedRunIdx: null,
      settingsTab: parsed.settingsTab,
      spaceFilter: "all",
      periodFilter: "all",
      priorityFilter: "all",
      showParentSlices: false,
      navOpen: false,
      sidebarCollapsed: false,
      draftOpen: false,
      desktopDraftCollapsed: false,
      paletteOpen: false,
      toastMessage: null,
      themePreference: initialThemePref,
      resolvedTheme: resolveTheme(initialThemePref),

      bootstrapping: true,
      bootstrapLoaded: false,
      bootstrapError: null,
      daemonVersion: null,

      authChecked: false,
      authMode: "local",
      authAuthenticated: true,
      authDevice: null,
      authNotice: null,
      pendingPairToken: parsed.pairToken,

      tasks: [],
      pendingDecisions: [],
      drafts: [],
      spaces: {},
      roles: { ...DEFAULT_ROLES, roles: {} },
      roster: {
        ...DEFAULT_ROSTER,
        pm_orchestration: { ...DEFAULT_ROSTER.pm_orchestration },
        roster: {},
      },
      providersConfig: null,
      providersConfigLoaded: false,
      providerStatuses: [],
      providerTestBusyId: null,
      limits: { ...DEFAULT_LIMITS },
      pricing: { ...DEFAULT_PRICING, models: {} },
      usage: { ...EMPTY_USAGE },
      runningCount: 0,
      ledgers: {},
      agents: [],
      backends: [],
      providerUsage: undefined,

      ratesByTask: {},
      liveTotals: null,
      sseStatus: "connecting",
      lastConnectedAt: null,
      networkOffline: false,
      retryingConnection: false,

      taskDetails: {},
      taskDetailLoading: false,
      taskDetailError: null,
      restoreResult: null,
      scriptRuns: {},
      scriptDrawerOpen: false,
      contextWindowByTask: {},

      intakeDraftId: null,
      intakeForm: createDefaultIntakeForm({}),
      intakeRightTab: "brief",
      intakeProgressLogs: [],
      intakeMessages: defaultWelcomeIntakeMessages(),
      intakeBusy: false,
      reconBusy: false,
      attachmentUploadBusy: false,
      intakeActiveOpen: false,
      intakeHasUnreadReply: false,

      spaceModalOpen: false,
      editingSpaceId: null,
      spaceModalSelectInIntake: false,
      spaceModalPrefillPath: null,
      discoveredRepos: [],
      discoverBusy: false,
      discoverError: null,
      discoverLoaded: false,
      pickDirBusy: false,

      resolveMessagesByTask: {},
      resolveBusy: false,
      pricingSyncBusy: false,
    };

    // Immediately strip #pair=<token> (or invalid routes) so one-time pairing tokens
    // never linger in window.location.hash or browser history.
    if (parsed.pairToken || parsed.hadInvalidRoute) {
      this.replaceHash("");
    }
  }

  getState(): KilnStoreState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setState(patch: Partial<KilnStoreState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private replaceHash(nextHash: string): void {
    if (typeof window === "undefined") return;
    try {
      const target =
        nextHash || window.location.pathname + window.location.search;
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", target);
      }
    } catch {
      // Ignore restricted history APIs
    }
  }

  private syncHashFromState(): void {
    if (!this.state.bootstrapLoaded || !this.state.authAuthenticated) return;
    let next = "";
    if (this.state.view === "detail" && this.state.taskId) {
      next = `#task=${encodeURIComponent(this.state.taskId)}`;
    } else if (this.state.view === "resolve" && this.state.taskId) {
      next = `#resolve=${encodeURIComponent(this.state.taskId)}`;
    } else if (this.state.view === "settings") {
      next =
        this.state.settingsTab !== "roles"
          ? `#view=settings&tab=${this.state.settingsTab}`
          : "#view=settings";
    } else if (this.state.view !== "board") {
      next = `#view=${this.state.view}`;
    }
    this.replaceHash(next);
  }

  private disconnectSse(): void {
    if (this.sseCleanup) {
      const cleanup = this.sseCleanup;
      this.sseCleanup = null;
      cleanup();
    }
  }

  private connectSse(): void {
    this.disconnectSse();
    this.setState({ sseStatus: "connecting" });
    this.sseCleanup = subscribeSseEvents({
      onEvent: (event) => this.handleSseEvent(event),
      onStatusChange: (sseStatus) => {
        if (sseStatus === "connected") {
          this.setState({
            sseStatus,
            lastConnectedAt: new Date().toISOString(),
            networkOffline: false,
          });
        } else if (sseStatus === "reconnecting") {
          this.setState({ sseStatus, networkOffline: true });
          if (this.state.authMode === "remote" && this.state.authAuthenticated) {
            void this.probeRemoteAuthAfterDisconnect();
          }
        } else {
          this.setState({ sseStatus });
        }
      },
    });
  }

  private async probeRemoteAuthAfterDisconnect(): Promise<void> {
    if (this.authProbeInFlight) return;
    const run = (async () => {
      try {
        const status = await apiFetchAuthStatus();
        if (status.mode === "remote" && !status.authenticated) {
          this.handleRemoteUnauthorized(
            "当前设备会话已失效或已被桌面端吊销，请重新配对登录。",
          );
        } else {
          this.setState({ lastConnectedAt: new Date().toISOString() });
        }
      } catch {
        // Host genuinely offline or unreachable; keep offline banner active.
      } finally {
        this.authProbeInFlight = null;
      }
    })();
    this.authProbeInFlight = run;
    await run;
  }

  private clearRemoteSession(notice: string): void {
    this.disconnectSse();
    this.intakeRestoredOnce = false;
    this.setState({
      authChecked: true,
      authMode: "remote",
      authAuthenticated: false,
      authDevice: null,
      authNotice: notice,
      bootstrapping: false,
      bootstrapLoaded: false,
      bootstrapError: null,
      daemonVersion: null,
      networkOffline: false,
      retryingConnection: false,
      navOpen: false,
      draftOpen: false,
      paletteOpen: false,
      spaceModalOpen: false,
      intakeActiveOpen: false,
      intakeHasUnreadReply: false,
      discoveredRepos: [],
      discoverLoaded: false,
      tasks: [],
      pendingDecisions: [],
      drafts: [],
      taskDetails: {},
      ledgers: {},
      resolveMessagesByTask: {},
      ratesByTask: {},
      liveTotals: null,
      providersConfig: null,
      providersConfigLoaded: false,
      providerStatuses: [],
      scriptRuns: {},
      scriptDrawerOpen: false,
      attachmentUploadBusy: false,
      contextWindowByTask: {},
      sseStatus: "closed",
    });
  }

  handleRemoteUnauthorized(notice: string): void {
    if (this.state.authMode === "remote" && !this.state.authAuthenticated) {
      return;
    }
    this.clearRemoteSession(notice);
  }

  clearPendingPairToken(): void {
    this.setState({ pendingPairToken: null });
  }

  async initializeSession(): Promise<void> {
    try {
      const status = await apiFetchAuthStatus();
      const nowIso = new Date().toISOString();
      if (status.mode === "remote" && !status.authenticated) {
        this.disconnectSse();
        this.setState({
          authChecked: true,
          authMode: "remote",
          authAuthenticated: false,
          authDevice: null,
          bootstrapping: false,
          lastConnectedAt: nowIso,
          networkOffline: false,
          sseStatus: "closed",
        });
        return;
      }

      this.setState({
        authChecked: true,
        authMode: status.mode,
        authAuthenticated: true,
        authDevice: status.device,
        authNotice: null,
        lastConnectedAt: nowIso,
        networkOffline: false,
      });
      this.connectSse();
      await this.bootstrap();
    } catch (err) {
      this.setState({
        authChecked: true,
        bootstrapping: false,
        networkOffline: true,
        bootstrapError:
          err instanceof Error ? err.message : "主机离线或无法连接 Kiln 服务",
      });
    }
  }

  async completeRemotePairing(input: PairCompleteRequest): Promise<PairSubmitOutcome> {
    try {
      const res = await apiPairRemoteDevice(input);
      this.setState({
        authChecked: true,
        authMode: "remote",
        authAuthenticated: true,
        authDevice: res.device,
        authNotice: null,
        pendingPairToken: null,
        bootstrapError: null,
        lastConnectedAt: new Date().toISOString(),
        networkOffline: false,
      });
      this.connectSse();
      await this.bootstrap();
      this.showToast(`已配对设备：${res.device.label}`);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        const attemptsRemaining =
          typeof err.payload?.attemptsRemaining === "number"
            ? err.payload.attemptsRemaining
            : undefined;
        return {
          ok: false,
          code: err.code,
          message: err.message,
          ...(attemptsRemaining !== undefined ? { attemptsRemaining } : {}),
        };
      }
      return {
        ok: false,
        code: "network_error",
        message: err instanceof Error ? err.message : "配对请求失败，请检查网络连接",
      };
    }
  }

  async logoutRemote(): Promise<void> {
    try {
      await apiLogoutRemoteDevice();
    } catch {
      // Clear local session state even if host is unreachable during logout.
    }
    this.clearRemoteSession("已退出当前设备的远程登录会话。");
    this.showToast("已退出远程登录");
  }

  async retryConnection(): Promise<void> {
    if (this.state.retryingConnection) return;
    this.setState({ retryingConnection: true });
    try {
      if (!this.state.bootstrapLoaded || this.state.authMode === "remote") {
        await this.initializeSession();
      } else {
        this.connectSse();
        await this.bootstrap();
      }
    } finally {
      this.setState({ retryingConnection: false });
    }
  }

  showToast(message: string): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    this.setState({ toastMessage: message });
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.setState({ toastMessage: null });
    }, 2600);
  }

  start(): () => void {
    const appliedTheme = applyThemeToDocument(this.state.themePreference);
    if (appliedTheme !== this.state.resolvedTheme) {
      this.setState({ resolvedTheme: appliedTheme });
    }
    this.systemThemeCleanup?.();
    this.systemThemeCleanup = subscribeSystemThemeChange(() => {
      if (this.state.themePreference === "system") {
        const next = applyThemeToDocument("system");
        if (next !== this.state.resolvedTheme) {
          this.setState({ resolvedTheme: next });
        }
      }
    });

    const onUnauthorized = (_url: string, err: ApiError): void => {
      if (this.state.authMode === "remote" || err.code === "unauthorized") {
        this.handleRemoteUnauthorized(
          "当前设备会话已失效或已被桌面端吊销，请重新配对登录。",
        );
      }
    };
    setUnauthorizedHandler(onUnauthorized);

    void this.initializeSession();

    const onHashChange = (): void => {
      const parsed = parseLocationHash();
      if (parsed.pairToken) {
        this.setState({ pendingPairToken: parsed.pairToken });
        this.replaceHash("");
        return;
      }
      if (!this.state.authAuthenticated) {
        return;
      }
      this.setState({
        view: parsed.view,
        taskId: parsed.taskId,
        settingsTab: parsed.settingsTab,
        selectedRunIdx: null,
        restoreResult: null,
      });
      this.enforceRouteGuard();
      if (
        this.state.view === "detail" ||
        this.state.view === "resolve"
      ) {
        if (this.state.taskId) {
          void this.loadTaskDetail(this.state.taskId);
        }
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", onHashChange);
    }

    return () => {
      setUnauthorizedHandler(null);
      this.disconnectSse();
      this.systemThemeCleanup?.();
      this.systemThemeCleanup = null;
      if (this.toastTimer) {
        clearTimeout(this.toastTimer);
        this.toastTimer = null;
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("hashchange", onHashChange);
      }
    };
  }

  private enforceRouteGuard(): void {
    if (!this.state.bootstrapLoaded) return;

    if (this.state.view === "detail") {
      const exists =
        this.state.taskId !== null &&
        this.state.tasks.some((t) => t.id === this.state.taskId);
      if (!exists) {
        this.setState({ view: "board", taskId: null, selectedRunIdx: null });
        this.syncHashFromState();
        return;
      }
    } else if (this.state.view === "resolve") {
      const hasTask =
        this.state.taskId !== null &&
        this.state.tasks.some((t) => t.id === this.state.taskId);
      const hasDecision =
        this.state.taskId !== null &&
        this.state.pendingDecisions.some((d) => d.task_id === this.state.taskId);
      if (!hasTask || !hasDecision) {
        this.setState({ view: "board", taskId: null, selectedRunIdx: null });
        this.syncHashFromState();
        return;
      }
    }

    this.syncHashFromState();
  }

  async bootstrap(): Promise<void> {
    if (this.refreshInFlight) {
      return await this.refreshInFlight;
    }
    this.setState({ bootstrapping: true, bootstrapError: null });
    const run = (async () => {
      try {
        const data = await apiFetchBootstrap();
        const roles = data.settings?.roles ?? data.roles ?? { ...DEFAULT_ROLES, roles: {} };
        const rawRoster = data.settings?.roster ?? data.roster;
        const roster =
          rawRoster &&
          typeof rawRoster === "object" &&
          rawRoster.roster &&
          typeof rawRoster.roster === "object"
            ? rawRoster
            : this.state.roster;
        const providersConfig = data.settings?.providers ?? this.state.providersConfig;
        const providersConfigLoaded =
          data.settings?.providers !== undefined
            ? true
            : this.state.providersConfigLoaded;
        const limits = data.settings?.limits ?? data.limits ?? { ...DEFAULT_LIMITS };
        const pricing = data.settings?.pricing ?? data.pricing ?? { ...DEFAULT_PRICING, models: {} };
        const nextRates = data.liveRates?.rates
          ? { ...this.state.ratesByTask, ...data.liveRates.rates }
          : this.state.ratesByTask;

        const nextSpaces = data.spaces ?? {};
        const nextDrafts = data.drafts ?? [];
        let nextIntakeForm = this.state.intakeForm;
        let nextIntakeDraftId = this.state.intakeDraftId;
        let nextIntakeMessages = this.state.intakeMessages;
        let nextIntakeActiveOpen = this.state.intakeActiveOpen;
        let nextIntakeHasUnread = this.state.intakeHasUnreadReply;
        let restoredDraftIdForChat: string | null = null;

        if (!this.intakeRestoredOnce && !this.state.intakeActiveOpen) {
          this.intakeRestoredOnce = true;
          const storedId = readStorageItem(ACTIVE_INTAKE_DRAFT_KEY);
          const matched =
            (storedId ? nextDrafts.find((d) => d.id === storedId) : undefined) ??
            nextDrafts.find((d) => d.intake_open === true) ??
            null;
          if (matched) {
            writeStorageItem(ACTIVE_INTAKE_DRAFT_KEY, matched.id);
            nextIntakeDraftId = matched.id;
            nextIntakeForm = draftToIntakeForm(matched);
            nextIntakeActiveOpen = true;
            nextIntakeHasUnread = false;
            restoredDraftIdForChat = matched.id;
          } else {
            if (storedId) {
              removeStorageItem(ACTIVE_INTAKE_DRAFT_KEY);
            }
            const localSnap = readLocalIntakeSnapshot();
            if (localSnap && localSnap.messages.length > 1) {
              nextIntakeDraftId = null;
              nextIntakeForm = localSnap.form;
              nextIntakeMessages = localSnap.messages;
              nextIntakeActiveOpen = true;
              nextIntakeHasUnread = false;
            }
          }
        }

        if (
          !nextIntakeDraftId &&
          !nextIntakeActiveOpen &&
          nextIntakeForm.mode === "project" &&
          !isProjectSpace(nextSpaces[nextIntakeForm.space])
        ) {
          const preferred =
            this.state.spaceFilter !== "all" ? this.state.spaceFilter : undefined;
          const projects = getProjectSpaces(nextSpaces);
          const chosen =
            (preferred && isProjectSpace(nextSpaces[preferred])
              ? nextSpaces[preferred]
              : undefined) ?? projects[0];
          if (chosen) {
            nextIntakeForm = {
              ...nextIntakeForm,
              space: chosen.id,
              workspace_mode: "git_worktree",
              ...(nextIntakeForm.accept_cmd.trim() === "" && chosen.default_accept_cmd
                ? { accept_cmd: chosen.default_accept_cmd }
                : {}),
            };
          } else if (nextIntakeForm.space && !nextSpaces[nextIntakeForm.space]) {
            nextIntakeForm = {
              ...nextIntakeForm,
              space: "",
            };
          }
        }

        this.setState({
          bootstrapping: false,
          bootstrapLoaded: true,
          bootstrapError: null,
          daemonVersion: data.version ?? null,
          lastConnectedAt: new Date().toISOString(),
          ...(this.state.sseStatus !== "reconnecting"
            ? { networkOffline: false }
            : {}),
          tasks: data.tasks ?? [],
          pendingDecisions: data.pendingDecisions ?? [],
          drafts: nextDrafts,
          spaces: nextSpaces,
          intakeDraftId: nextIntakeDraftId,
          intakeForm: nextIntakeForm,
          intakeMessages: nextIntakeMessages,
          intakeActiveOpen: nextIntakeActiveOpen,
          intakeHasUnreadReply: nextIntakeHasUnread,
          roles,
          roster,
          providersConfig,
          providersConfigLoaded,
          ...(data.providers !== undefined ? { providerStatuses: data.providers } : {}),
          limits,
          pricing,
          usage: data.usage ?? { ...EMPTY_USAGE },
          runningCount: data.runningCount ?? 0,
          ...(data.ledgers !== undefined
            ? { ledgers: normalizeLedgers(data.ledgers) }
            : {}),
          ...(data.agents !== undefined ? { agents: data.agents } : {}),
          ...(data.backends !== undefined ? { backends: data.backends } : {}),
          ...(data.providerUsage !== undefined
            ? { providerUsage: data.providerUsage }
            : {}),
          ratesByTask: nextRates,
          ...(data.liveRates?.totals !== undefined
            ? { liveTotals: data.liveRates.totals }
            : {}),
        });

        this.enforceRouteGuard();

        if (restoredDraftIdForChat) {
          void this.hydrateRestoredDraftChat(restoredDraftIdForChat);
        }

        if (
          (this.state.view === "detail" || this.state.view === "resolve") &&
          this.state.taskId
        ) {
          void this.loadTaskDetail(this.state.taskId);
          if (this.state.view === "resolve") {
            void this.loadResolveChat(this.state.taskId);
          }
        } else if (this.state.view === "ledger" && Object.keys(this.state.ledgers).length === 0) {
          void this.refreshLedgers();
        } else if (this.state.view === "settings" && this.state.agents.length === 0) {
          void this.refreshAgents();
        }

        if (
          (this.state.view === "lineup" ||
            (this.state.view === "settings" && this.state.settingsTab === "providers")) &&
          this.state.authMode === "local" &&
          !this.state.providersConfigLoaded
        ) {
          void this.refreshProvidersConfig();
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && this.state.authMode === "remote") {
          return;
        }
        const isOfflineError =
          !(err instanceof ApiError) ||
          err.status === 502 ||
          err.status === 503 ||
          err.status === 504;
        this.setState({
          bootstrapping: false,
          ...(isOfflineError ? { networkOffline: true } : {}),
          ...(!this.state.bootstrapLoaded
            ? {
                bootstrapError:
                  err instanceof Error ? err.message : "加载工作台失败",
              }
            : {}),
        });
      } finally {
        this.refreshInFlight = null;
      }
    })();

    this.refreshInFlight = run;
    await run;
  }

  private handleSseEvent(event: SseEvent): void {
    const nowIso = new Date().toISOString();
    if (this.state.networkOffline || !this.state.lastConnectedAt) {
      this.setState({ lastConnectedAt: nowIso, networkOffline: false });
    } else {
      this.state = { ...this.state, lastConnectedAt: nowIso };
    }
    if (event.type === "rate.tick") {
      this.setState({
        ratesByTask: { ...event.rates },
        liveTotals: { ...event.totals },
      });
      return;
    }

    if (event.type === "task.updated") {
      let found = false;
      const nextTasks = this.state.tasks.map((t) => {
        if (t.id !== event.taskId) return t;
        found = true;
        return {
          ...t,
          ...(event.patch.status !== undefined ? { status: event.patch.status } : {}),
          ...(event.patch.stage !== undefined ? { stage: event.patch.stage } : {}),
          ...(event.patch.round !== undefined ? { round: event.patch.round } : {}),
          ...(event.patch.priority !== undefined ? { priority: event.patch.priority } : {}),
          ...(event.patch.effectivePriority !== undefined
            ? { effective_priority: event.patch.effectivePriority }
            : {}),
          ...(event.patch.contractVersion !== undefined
            ? { contract_version: event.patch.contractVersion }
            : {}),
        };
      });
      if (found) {
        this.setState({ tasks: nextTasks });
      }
      if (
        !found ||
        event.patch.status === "waiting" ||
        event.patch.status === "done" ||
        event.patch.status === "cancelled"
      ) {
        void this.bootstrap();
      }
      if (this.state.taskId === event.taskId && (this.state.view === "detail" || this.state.view === "resolve")) {
        void this.loadTaskDetail(event.taskId);
      }
      return;
    }

    if (event.type === "decision.requested") {
      void this.bootstrap();
      if (this.state.taskId === event.taskId) {
        void this.loadTaskDetail(event.taskId);
      }
      return;
    }

    if (event.type === "intake.progress") {
      if (
        this.state.intakeBusy &&
        (!this.state.intakeDraftId || this.state.intakeDraftId === event.draftId)
      ) {
        const nextLogs = [
          ...this.state.intakeProgressLogs,
          {
            kind: event.kind,
            text: event.text,
            ...(event.toolName ? { toolName: event.toolName } : {}),
            at: event.at,
          },
        ].slice(-8);
        this.setState({ intakeProgressLogs: nextLogs });
      }
      return;
    }

    if (event.type === "provider.status") {
      const idx = this.state.providerStatuses.findIndex(
        (p) => p.provider_id === event.providerId,
      );
      if (idx >= 0) {
        const nextStatuses = this.state.providerStatuses.map((p, i) =>
          i === idx
            ? {
                ...p,
                status: event.status,
                ...(event.cooldownUntil !== undefined
                  ? { cooldown_until: event.cooldownUntil }
                  : { cooldown_until: null }),
                ...(event.detail !== undefined ? { detail: event.detail } : {}),
              }
            : p,
        );
        this.setState({ providerStatuses: nextStatuses });
      } else {
        void this.refreshProviders();
      }
      return;
    }

    if (event.type === "script.output") {
      const existing = this.state.scriptRuns[event.scriptRunId] ?? {
        scriptRunId: event.scriptRunId,
        spaceId: event.spaceId,
        ...(event.taskId ? { taskId: event.taskId } : {}),
        scriptKey: event.scriptKey,
        lines: [],
        done: false,
        exitCode: null,
        updatedAt: event.at,
      };
      const rawLines = event.chunk ? event.chunk.split(/\r?\n/) : [];
      if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
        rawLines.pop();
      }
      const merged = [...existing.lines, ...rawLines].slice(-500);
      this.setState({
        scriptRuns: {
          ...this.state.scriptRuns,
          [event.scriptRunId]: {
            ...existing,
            lines: merged,
            done: event.done !== undefined ? Boolean(event.done) : existing.done,
            exitCode: event.exitCode !== undefined ? event.exitCode : existing.exitCode,
            updatedAt: event.at,
          },
        },
      });
      return;
    }

    if (event.type === "run.event") {
      if (event.event.kind === "context_window") {
        const percent =
          event.event.percent ??
          Math.min(
            100,
            Math.round(
              (event.event.usedTokens / Math.max(1, event.event.contextWindowTokens)) * 100,
            ),
          );
        this.setState({
          contextWindowByTask: {
            ...this.state.contextWindowByTask,
            [event.taskId]: {
              usedTokens: event.event.usedTokens,
              contextWindowTokens: event.event.contextWindowTokens,
              percent,
              at: event.event.at,
            },
          },
        });
      } else if (event.event.kind === "rate_limited") {
        const provId = event.event.provider;
        const idx = this.state.providerStatuses.findIndex((p) => p.provider_id === provId);
        if (idx >= 0) {
          const nextStatuses = this.state.providerStatuses.map((p, i) =>
            i === idx
              ? {
                  ...p,
                  status: "cooldown" as const,
                  cooldown_until: event.event.kind === "rate_limited" ? (event.event.until ?? null) : null,
                  ...(event.event.kind === "rate_limited" && event.event.detail
                    ? { detail: event.event.detail }
                    : {}),
                }
              : p,
          );
          this.setState({ providerStatuses: nextStatuses });
        }
      }
      const detail = this.state.taskDetails[event.taskId];
      if (detail) {
        const nextRuns = detail.runs.map((run) => {
          if (run.meta?.run_id !== event.runId) return run;
          return {
            ...run,
            events: [...run.events, event.event],
            eventsCount: run.eventsCount + 1,
          };
        });
        this.setState({
          taskDetails: {
            ...this.state.taskDetails,
            [event.taskId]: { ...detail, runs: nextRuns },
          },
        });
      }
      if (event.event.kind === "usage" || event.event.kind === "exit") {
        void this.bootstrap();
        if (this.state.taskId === event.taskId) {
          void this.loadTaskDetail(event.taskId);
        }
      }
    }
  }

  go(view: MvpView, options?: { space?: string; settingsTab?: SettingsTab }): void {
    const shouldInitIntake =
      view === "intake" &&
      !this.state.intakeActiveOpen &&
      !this.state.intakeDraftId &&
      !this.state.intakeForm.title.trim() &&
      this.state.intakeMessages.length <= 1;

    const preferredSpace =
      this.state.spaceFilter !== "all" ? this.state.spaceFilter : undefined;

    const patch: Partial<KilnStoreState> = {
      view,
      navOpen: false,
      draftOpen: false,
      paletteOpen: false,
      restoreResult: null,
      scriptDrawerOpen: false,
      ...(view === "intake" ? { intakeHasUnreadReply: false } : {}),
      ...(view !== "detail" && view !== "resolve" ? { taskId: null, selectedRunIdx: null } : {}),
      ...(options?.space !== undefined ? { spaceFilter: options.space } : {}),
      ...(options?.settingsTab !== undefined ? { settingsTab: options.settingsTab } : {}),
      ...(shouldInitIntake
        ? { intakeForm: createDefaultIntakeForm(this.state.spaces, preferredSpace) }
        : {}),
    };
    this.setState(patch);
    this.syncHashFromState();
    if (view === "ledger" && Object.keys(this.state.ledgers).length === 0) {
      void this.refreshLedgers();
    } else if (
      (view === "settings" || view === "lineup") &&
      this.state.agents.length === 0
    ) {
      void this.refreshAgents();
    }
    if (view === "intake" && Object.keys(this.state.roster.roster).length === 0) {
      void this.refreshRoster();
    }
    if (view === "lineup") {
      if (Object.keys(this.state.roster.roster).length === 0) {
        void this.refreshRoster();
      }
      if (this.state.providerStatuses.length === 0) {
        void this.refreshProviders();
      }
      if (this.state.authMode === "local" && !this.state.providersConfigLoaded) {
        void this.refreshProvidersConfig();
      }
    } else if (
      view === "settings" &&
      (options?.settingsTab ?? this.state.settingsTab) === "providers" &&
      this.state.authMode === "local" &&
      !this.state.providersConfigLoaded
    ) {
      void this.refreshProvidersConfig();
    }
  }

  openTask(taskId: string): void {
    this.setState({
      view: "detail",
      taskId,
      selectedRunIdx: null,
      navOpen: false,
      draftOpen: false,
      paletteOpen: false,
      restoreResult: null,
      scriptDrawerOpen: false,
      taskDetailError: null,
    });
    this.syncHashFromState();
    void this.loadTaskDetail(taskId);
  }

  openResolve(taskId: string): void {
    this.setState({
      view: "resolve",
      taskId,
      navOpen: false,
      draftOpen: false,
      paletteOpen: false,
      restoreResult: null,
    });
    this.syncHashFromState();
    void this.loadTaskDetail(taskId);
    void this.loadResolveChat(taskId);
  }

  setSettingsTab(tab: SettingsTab): void {
    this.setState({ settingsTab: tab });
    this.syncHashFromState();
    if (
      tab === "providers" &&
      this.state.authMode === "local" &&
      !this.state.providersConfigLoaded
    ) {
      void this.refreshProvidersConfig();
    }
  }

  toggleSidebar(): void {
    this.setState({ sidebarCollapsed: !this.state.sidebarCollapsed });
  }

  setSpaceFilter(space: string): void {
    this.setState({ spaceFilter: space });
    if (this.state.view !== "board") {
      this.go("board", { space });
    }
  }

  setPeriodFilter(periodFilter: PeriodFilter): void {
    this.setState({ periodFilter });
  }

  setPriorityFilter(priorityFilter: "all" | Priority): void {
    this.setState({ priorityFilter });
  }

  toggleParentSlices(): void {
    this.setState({ showParentSlices: !this.state.showParentSlices });
  }

  selectRun(idx: number): void {
    this.setState({ selectedRunIdx: idx });
  }

  setNavOpen(navOpen: boolean): void {
    this.setState({ navOpen });
  }

  toggleDraftOpen(): void {
    this.setState({ draftOpen: !this.state.draftOpen });
  }

  toggleDesktopDraftCollapsed(): void {
    this.setState({ desktopDraftCollapsed: !this.state.desktopDraftCollapsed });
  }

  setThemePreference(themePreference: ThemePreference): void {
    writeStoredThemePreference(themePreference);
    const resolvedTheme = applyThemeToDocument(themePreference);
    this.setState({ themePreference, resolvedTheme });
  }

  setPaletteOpen(paletteOpen: boolean): void {
    this.setState({ paletteOpen });
  }

  clearRestoreResult(): void {
    this.setState({ restoreResult: null });
  }

  setScriptDrawerOpen(open: boolean): void {
    this.setState({ scriptDrawerOpen: open });
  }

  toggleScriptDrawer(): void {
    this.setState({ scriptDrawerOpen: !this.state.scriptDrawerOpen });
  }

  async loadScriptRunsForTask(spaceId: string, taskId: string): Promise<void> {
    try {
      const res = await apiFetchScriptRuns({ spaceId, taskId });
      const next = { ...this.state.scriptRuns };
      for (const item of res.runs) {
        const existing = next[item.scriptRunId];
        const serverLines = item.outputTail ? item.outputTail.split(/\r?\n/) : [];
        if (serverLines.length > 0 && serverLines[serverLines.length - 1] === "") {
          serverLines.pop();
        }
        const useServerLines = !existing || serverLines.length > existing.lines.length;
        next[item.scriptRunId] = {
          scriptRunId: item.scriptRunId,
          spaceId: item.spaceId,
          ...(item.taskId ? { taskId: item.taskId } : {}),
          scriptKey: item.script,
          command: item.command,
          cwd: item.cwd,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          lines: useServerLines ? serverLines : existing.lines,
          done: existing?.done ? true : !item.running,
          exitCode: item.exitCode ?? existing?.exitCode ?? null,
          updatedAt: item.endedAt ?? existing?.updatedAt ?? item.startedAt,
        };
      }
      this.setState({ scriptRuns: next });
    } catch {
      // Best-effort script run hydration
    }
  }

  async startSpaceScript(
    spaceId: string,
    script: SpaceScriptKey,
    taskId?: string,
  ): Promise<string | null> {
    try {
      const res = await apiRunSpaceScript(spaceId, {
        script,
        ...(taskId ? { taskId } : {}),
      });
      const existing = this.state.scriptRuns[res.scriptRunId];
      const nowIso = new Date().toISOString();
      this.setState({
        scriptDrawerOpen: true,
        scriptRuns: {
          ...this.state.scriptRuns,
          [res.scriptRunId]: {
            scriptRunId: res.scriptRunId,
            spaceId: res.spaceId,
            ...(taskId ? { taskId } : {}),
            scriptKey: res.script,
            command: res.command,
            cwd: res.cwd,
            lines:
              existing && existing.lines.length > 0
                ? existing.lines
                : [`$ ${res.command}`],
            done: existing?.done ?? false,
            exitCode: existing?.exitCode ?? null,
            startedAt: existing?.startedAt ?? nowIso,
            updatedAt: existing?.updatedAt ?? nowIso,
          },
        },
      });
      this.showToast(`已启动脚本 ${script}`);
      return res.scriptRunId;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : `启动脚本 ${script} 失败`);
      return null;
    }
  }

  async stopScriptRun(scriptRunId: string): Promise<void> {
    try {
      await apiStopScriptRun(scriptRunId);
      const existing = this.state.scriptRuns[scriptRunId];
      if (existing) {
        this.setState({
          scriptRuns: {
            ...this.state.scriptRuns,
            [scriptRunId]: {
              ...existing,
              done: true,
              exitCode: existing.exitCode ?? 143,
              updatedAt: new Date().toISOString(),
            },
          },
        });
      }
      this.showToast("已停止脚本进程");
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "停止脚本失败");
    }
  }

  clearScriptRunOutput(scriptRunId: string): void {
    const existing = this.state.scriptRuns[scriptRunId];
    if (!existing) return;
    this.setState({
      scriptRuns: {
        ...this.state.scriptRuns,
        [scriptRunId]: {
          ...existing,
          lines: [],
        },
      },
    });
  }

  async refreshTaskCheckpoints(taskId: string): Promise<CheckpointRecord[]> {
    try {
      const res = await apiFetchTaskCheckpoints(taskId);
      const curDetail = this.state.taskDetails[taskId];
      if (curDetail) {
        this.setState({
          taskDetails: {
            ...this.state.taskDetails,
            [taskId]: {
              ...curDetail,
              checkpoints: res.checkpoints,
            },
          },
        });
      }
      return res.checkpoints;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "读取快照列表失败");
      return [];
    }
  }

  async rollbackTaskCheckpoint(
    taskId: string,
    checkpointRef: string,
  ): Promise<boolean> {
    try {
      const res = await apiRollbackTaskCheckpoint(taskId, {
        checkpoint_ref: checkpointRef,
        confirm: true,
      });
      this.showToast(`已回滚工作树至快照 (${res.commit_sha.slice(0, 7)})`);
      await this.bootstrap();
      if (this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "回滚快照失败");
      return false;
    }
  }

  async fetchPrDraft(taskId: string): Promise<PrDraftInfo | null> {
    try {
      const res = await apiFetchPrDraft(taskId);
      return res.draft;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "生成 PR 草案失败");
      return null;
    }
  }

  async executeGitDeliver(
    taskId: string,
    payload: CommitPrActionRequest,
  ): Promise<DeliverGitResponse | null> {
    try {
      const res = await apiExecuteGitDeliver(taskId, payload);
      if (res.action === "commit") {
        this.showToast(
          res.alreadyClean
            ? "工作树已是干净状态，无需重复提交"
            : `已本地提交 ${res.commitSha.slice(0, 7)}`,
        );
      } else if (res.action === "push") {
        this.showToast(
          res.alreadyUpToDate
            ? `远端 ${res.branch} 已是最新`
            : `已推送到 origin/${res.branch}`,
        );
      } else {
        this.showToast(
          res.alreadyExists
            ? `已复用已有 PR${res.prNumber ? ` #${res.prNumber}` : ""}`
            : `已创建 PR${res.prNumber ? ` #${res.prNumber}` : ""}`,
        );
      }
      await this.bootstrap();
      if (this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
      return res;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "Git 交付操作失败");
      return null;
    }
  }

  async loadTaskDetail(taskId: string): Promise<void> {
    this.setState({ taskDetailLoading: true, taskDetailError: null });
    try {
      const detail = await apiFetchTaskDetail(taskId);
      const nextDetails = {
        ...this.state.taskDetails,
        [taskId]: detail,
      };
      const patch: Partial<KilnStoreState> = {
        taskDetails: nextDetails,
        taskDetailLoading: false,
        taskDetailError: null,
      };
      if (detail.chatMessages && detail.chatMessages.length > 0) {
        patch.resolveMessagesByTask = {
          ...this.state.resolveMessagesByTask,
          [taskId]: detail.chatMessages,
        };
      }
      this.setState(patch);
    } catch (err) {
      this.setState({
        taskDetailLoading: false,
        taskDetailError: err instanceof Error ? err.message : "加载任务详情失败",
      });
    }
  }

  async pauseTask(taskId: string): Promise<void> {
    try {
      await apiPauseTask(taskId);
      this.showToast("已暂停，留在进行中列");
      await this.bootstrap();
      if (this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "暂停失败");
    }
  }

  async resumeTask(taskId: string, stage?: StageId): Promise<void> {
    try {
      await apiResumeTask(taskId, stage);
      this.showToast("已恢复继续推进");
      await this.bootstrap();
      if (this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "恢复失败");
    }
  }

  async steerTask(
    taskId: string,
    message: string,
    interrupt = false,
  ): Promise<boolean> {
    const trimmed = message.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const res = await apiSteerTask(taskId, { message: trimmed, interrupt });
      this.showToast(
        res.interrupted
          ? "已中断当前棒并携新指令重跑"
          : "已记录补充纠偏指令，下一棒生效",
      );
      await this.bootstrap();
      if (this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "提交纠偏指令失败");
      return false;
    }
  }

  async completeTask(taskId: string, deliverRef?: string): Promise<void> {
    try {
      await apiCompleteTask(taskId, deliverRef);
      this.showToast("已标记任务完成");
      await this.bootstrap();
      if (this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "标记完成失败");
    }
  }

  async openRunTui(taskId: string, runDir: string): Promise<void> {
    try {
      const res = await apiOpenRunTui(taskId, runDir);
      const shortId = res.providerSessionId.slice(0, 12);
      this.showToast(`已拉起 ${res.agent} 原生 TUI (${shortId})`);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "打开原生 TUI 失败");
    }
  }

  async cancelTask(taskId: string, reason?: string): Promise<void> {
    try {
      await apiCancelTask(taskId, reason);
      this.showToast("已取消任务");
      await this.bootstrap();
      if (this.state.view === "detail" && this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "取消任务失败");
    }
  }

  async updatePriority(taskId: string, priority: Priority): Promise<void> {
    try {
      const res = await apiUpdatePriority(taskId, priority);
      this.showToast(`已改为 ${res.effectivePriority ?? priority}`);
      await this.bootstrap();
      if (this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "调整优先级失败");
    }
  }

  async submitDecision(
    taskId: string,
    payload: SubmitDecisionPayload,
  ): Promise<boolean> {
    try {
      await apiSubmitDecision(taskId, payload);
      this.showToast(
        payload.apply_ledger_rule
          ? "已提交决定并写入长期决策账本"
          : "已记录决定",
      );
      await this.bootstrap();
      if (this.state.view === "resolve" && this.state.taskId === taskId) {
        this.openTask(taskId);
      } else if (this.state.view === "detail" && this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "提交决定失败");
      return false;
    }
  }

  async restoreHostBackup(taskId: string): Promise<RestoreHostBackupResult | null> {
    try {
      const result = await apiRestoreHostBackup(taskId);
      this.setState({ restoreResult: result });
      if (result.ok) {
        this.showToast("SHA256 校验一致，已安全从备份恢复");
        await this.loadTaskDetail(taskId);
      } else if (result.code === "hash_mismatch") {
        this.showToast("拦截恢复：目标文件已被后续修改（SHA256 不一致）");
      } else {
        this.showToast(result.message);
      }
      return result;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "恢复备份失败");
      return null;
    }
  }

  setIntakeRightTab(tab: IntakeRightTab): void {
    this.setState({ intakeRightTab: tab });
  }

  updateIntakeForm(patch: Partial<IntakeFormState>): void {
    const nextForm = { ...this.state.intakeForm, ...patch };
    this.setState({ intakeForm: nextForm });
    if (this.state.intakeActiveOpen) {
      writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
    }
  }

  private getHostStagedRoleIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, entry] of Object.entries(this.state.roster.roster)) {
      if (entry.perm === "host_staged") {
        ids.add(id);
      }
    }
    return ids;
  }

  setIntakeMode(mode: IntakeMode): void {
    const cur = this.state.intakeForm;
    if (mode === cur.mode) return;
    if (mode === "project") {
      const projects = getProjectSpaces(this.state.spaces);
      const preferred =
        this.state.spaceFilter !== "all" && isProjectSpace(this.state.spaces[this.state.spaceFilter])
          ? this.state.spaces[this.state.spaceFilter]
          : undefined;
      const chosen =
        (isProjectSpace(this.state.spaces[cur.space])
          ? this.state.spaces[cur.space]
          : undefined) ??
        preferred ??
        projects[0];
      const prevDefault = this.state.spaces[cur.space]?.default_accept_cmd ?? "";
      const shouldFillAccept =
        cur.accept_cmd.trim() === "" || cur.accept_cmd === prevDefault;
      const hasDeliverCmd = cur.deliver_cmd.trim().length > 0;
      const nextTrack = cur.track || "L2";
      const currentWorkflow = resolveFormEffectiveWorkflow(cur);
      const toggles = extractWorkflowToggles(currentWorkflow);
      const nextWorkflow = stripHostTwoPhaseWorkflow(
        currentWorkflow,
        hasDeliverCmd,
        this.getHostStagedRoleIds(),
      );
      const resolvedTrack = toggles.hostTwoPhase
        ? toggles.includeReview
          ? "L2"
          : "L1"
        : nextTrack;
      const nextForm: IntakeFormState = {
        ...cur,
        mode: "project",
        space: chosen?.id ?? "",
        workspace_mode: "git_worktree",
        track: resolvedTrack,
        workflow: nextWorkflow,
        accept_cmd:
          shouldFillAccept && chosen?.default_accept_cmd
            ? chosen.default_accept_cmd
            : cur.accept_cmd,
      };
      this.setState({ intakeForm: nextForm });
      if (this.state.intakeActiveOpen) {
        writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
      }
      return;
    }

    const prevDefault = this.state.spaces[cur.space]?.default_accept_cmd ?? "";
    const nextWs =
      cur.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir";
    const hasDeliverCmd = cur.deliver_cmd.trim().length > 0;
    const currentWorkflow = resolveFormEffectiveWorkflow(cur);
    const curToggles = extractWorkflowToggles(currentWorkflow);
    const nextWorkflow =
      nextWs === "host_scoped"
        ? curToggles.hostTwoPhase
          ? currentWorkflow
          : preserveWorkflowAssignments(
              cur.workflow,
              buildWorkflowPreset("host_op", {
                includePlan: curToggles.includePlan,
                hasDeliverCmd,
              }),
              { preserveResearch: true },
            )
        : stripHostTwoPhaseWorkflow(
            currentWorkflow,
            hasDeliverCmd,
            this.getHostStagedRoleIds(),
          );
    const nextForm: IntakeFormState = {
      ...cur,
      mode: "local",
      space: "local",
      workspace_mode: nextWs,
      workflow: nextWorkflow,
      ...(cur.accept_cmd === prevDefault ? { accept_cmd: "" } : {}),
    };
    this.setState({ intakeForm: nextForm });
    if (this.state.intakeActiveOpen) {
      writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
    }
  }

  selectIntakeTrack(track: Exclude<Track, "L3">): void {
    const cur = this.state.intakeForm;
    const hasDeliverCmd = cur.deliver_cmd.trim().length > 0;
    const toggles = extractWorkflowToggles(resolveFormEffectiveWorkflow(cur));
    const built =
      track === "L1"
        ? cur.workspace_mode === "host_scoped"
          ? buildWorkflowPreset("host_op", {
              includePlan: toggles.includePlan,
              hasDeliverCmd,
            })
          : buildWorkflowPreset("quick", {
              includePlan: toggles.includePlan,
              humanAccept: toggles.includeAccept && toggles.acceptMode === "approval",
              deliverApproval: toggles.deliverApproval,
              hasDeliverCmd,
            })
        : buildCustomWorkflow({
            ...toggles,
            preset:
              cur.workspace_mode === "host_scoped"
                ? "custom"
                : cur.workflow?.preset === "full_delivery"
                  ? "full_delivery"
                  : cur.workflow?.preset === "custom"
                    ? "custom"
                    : "standard_dev",
            includeReview: true,
            hostTwoPhase: cur.workspace_mode === "host_scoped",
            deliverApproval:
              cur.workspace_mode === "host_scoped" ? true : toggles.deliverApproval,
            hasDeliverCmd,
          });
    const nextWorkflow = preserveWorkflowAssignments(cur.workflow, built, {
      preserveResearch: true,
    });
    const nextForm: IntakeFormState = {
      ...cur,
      track,
      workflow: nextWorkflow,
    };
    this.setState({ intakeForm: nextForm });
    if (this.state.intakeActiveOpen) {
      writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
    }
  }

  selectIntakeWorkspaceMode(ws: "scratch_dir" | "host_scoped"): void {
    const cur = this.state.intakeForm;
    const hasDeliverCmd = cur.deliver_cmd.trim().length > 0;
    const currentWorkflow = resolveFormEffectiveWorkflow(cur);
    const toggles = extractWorkflowToggles(currentWorkflow);
    const nextWorkflow =
      ws === "host_scoped"
        ? toggles.hostTwoPhase
          ? currentWorkflow
          : preserveWorkflowAssignments(
              cur.workflow,
              toggles.includeReview
                ? buildCustomWorkflow({
                    ...toggles,
                    preset: "custom",
                    hostTwoPhase: true,
                    deliverApproval: true,
                    hasDeliverCmd,
                  })
                : buildWorkflowPreset("host_op", {
                    includePlan: toggles.includePlan,
                    hasDeliverCmd,
                  }),
              { preserveResearch: true },
            )
        : stripHostTwoPhaseWorkflow(
            currentWorkflow,
            hasDeliverCmd,
            this.getHostStagedRoleIds(),
          );
    const nextForm: IntakeFormState = {
      ...cur,
      workspace_mode: ws,
      track: extractWorkflowToggles(nextWorkflow).includeReview ? "L2" : "L1",
      workflow: nextWorkflow,
    };
    this.setState({ intakeForm: nextForm });
    if (this.state.intakeActiveOpen) {
      writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
    }
  }

  selectIntakeWorkflowPreset(preset: Exclude<WorkflowPreset, "custom">): void {
    const cur = this.state.intakeForm;
    const hasDeliverCmd = cur.deliver_cmd.trim().length > 0;
    const rawPresetWorkflow = buildWorkflowPreset(preset, { hasDeliverCmd });
    const dropHostRoles = preset !== "host_op" ? this.getHostStagedRoleIds() : undefined;
    const nextWorkflow = preserveWorkflowAssignments(cur.workflow, rawPresetWorkflow, {
      preserveResearch: false,
      ...(dropHostRoles ? { dropRosterRoles: dropHostRoles } : {}),
    });

    if (preset === "host_op") {
      const prevDefault = this.state.spaces[cur.space]?.default_accept_cmd ?? "";
      const nextForm: IntakeFormState = {
        ...cur,
        mode: "local",
        space: "local",
        workspace_mode: "host_scoped",
        track: "L1",
        workflow: nextWorkflow,
        ...(cur.mode === "project" && cur.accept_cmd === prevDefault ? { accept_cmd: "" } : {}),
      };
      this.setState({ intakeForm: nextForm });
      if (this.state.intakeActiveOpen) {
        writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
      }
      return;
    }

    const nextWs: Exclude<WorkspaceMode, "external_only"> =
      cur.mode === "project" ? "git_worktree" : "scratch_dir";
    const nextForm: IntakeFormState = {
      ...cur,
      workspace_mode: nextWs,
      track: preset === "quick" ? "L1" : "L2",
      workflow: nextWorkflow,
    };
    this.setState({ intakeForm: nextForm });
    if (this.state.intakeActiveOpen) {
      writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
    }
  }

  updateIntakeWorkflowToggles(patch: Partial<ComposableWorkflowOptions>): void {
    const cur = this.state.intakeForm;
    const current = extractWorkflowToggles(resolveFormEffectiveWorkflow(cur));
    const merged: ComposableWorkflowOptions = {
      ...current,
      ...patch,
      preset: "custom",
      hostTwoPhase: cur.workspace_mode === "host_scoped",
      hasDeliverCmd: cur.deliver_cmd.trim().length > 0,
    };
    if (merged.hostTwoPhase) {
      merged.deliverApproval = true;
    }
    const nextWorkflow = preserveWorkflowAssignments(
      cur.workflow,
      buildCustomWorkflow(merged),
      { preserveResearch: true },
    );
    const nextForm: IntakeFormState = {
      ...cur,
      track: merged.includeReview ? "L2" : "L1",
      workflow: nextWorkflow,
    };
    this.setState({ intakeForm: nextForm });
    if (this.state.intakeActiveOpen) {
      writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
    }
  }

  selectIntakeProjectSpace(spaceId: string): void {
    const cur = this.state.intakeForm;
    const prevDefault = this.state.spaces[cur.space]?.default_accept_cmd ?? "";
    const nextSpace = this.state.spaces[spaceId];
    const shouldUpdateAccept =
      cur.accept_cmd.trim() === "" || cur.accept_cmd === prevDefault;
    const currentWorkflow = resolveFormEffectiveWorkflow(cur);
    const toggles = extractWorkflowToggles(currentWorkflow);
    const nextWorkflow = stripHostTwoPhaseWorkflow(
      currentWorkflow,
      cur.deliver_cmd.trim().length > 0,
      this.getHostStagedRoleIds(),
    );
    const nextForm: IntakeFormState = {
      ...cur,
      mode: "project",
      space: spaceId,
      workspace_mode: "git_worktree",
      ...(toggles.hostTwoPhase
        ? {
            track: toggles.includeReview ? "L2" : "L1",
            workflow: nextWorkflow,
          }
        : {}),
      accept_cmd: shouldUpdateAccept
        ? (nextSpace?.default_accept_cmd ?? "")
        : cur.accept_cmd,
    };
    this.setState({ intakeForm: nextForm });
    if (this.state.intakeActiveOpen) {
      writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
    }
  }

  setIntakeStepRosterRole(
    stage: WorkflowAgentStage,
    rosterRoleId: string | undefined,
  ): void {
    const cur = this.state.intakeForm;
    const baseWorkflow = resolveFormEffectiveWorkflow(cur);
    const updateAgent = (node: WorkflowAgentNode): WorkflowAgentNode => {
      if (node.stage !== stage) return node;
      if (!rosterRoleId) {
        const { roster_role: _removed, ...rest } = node;
        return rest;
      }
      return { ...node, roster_role: rosterRoleId };
    };
    const nextWorkflow: WorkflowBlueprint = {
      ...baseWorkflow,
      steps: baseWorkflow.steps.map((step) => {
        if (step.kind === "agent") return updateAgent(step);
        if (step.kind === "loop") {
          return {
            ...step,
            steps: step.steps.map((inner) =>
              inner.kind === "agent" ? updateAgent(inner) : inner,
            ),
          };
        }
        return step;
      }),
    };
    this.updateIntakeForm({ workflow: nextWorkflow });
  }

  addIntakeNonGoal(rawText: string): void {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    const cur = this.state.intakeForm.non_goals;
    if (cur.includes(trimmed)) return;
    this.updateIntakeForm({ non_goals: [...cur, trimmed] });
  }

  removeIntakeNonGoal(index: number): void {
    const cur = this.state.intakeForm.non_goals;
    if (index < 0 || index >= cur.length) return;
    this.updateIntakeForm({
      non_goals: cur.filter((_, idx) => idx !== index),
    });
  }

  private async ensureDraftForIntakeAction(): Promise<string | null> {
    if (this.state.intakeDraftId) {
      return this.state.intakeDraftId;
    }
    const f = this.state.intakeForm;
    const { depends_on, scopeList } = this.buildDraftContractFromForm();
    const effectiveSpace = f.mode === "local" ? "local" : f.space;
    const effectiveWorkspaceMode: Exclude<WorkspaceMode, "external_only"> =
      f.mode === "project"
        ? "git_worktree"
        : f.workspace_mode === "host_scoped"
          ? "host_scoped"
          : "scratch_dir";

    if (f.mode === "project" && !isProjectSpace(this.state.spaces[effectiveSpace])) {
      this.showToast("请先选择或添加一个项目空间");
      return null;
    }

    const contractPatch: Record<string, unknown> = {};
    if (f.title.trim()) contractPatch.goal = f.title.trim();
    if (f.end.trim()) contractPatch.end = f.end.trim();
    if (f.accept_cmd.trim()) contractPatch.accept_cmd = f.accept_cmd.trim();
    if (scopeList.length > 0) contractPatch.scope = scopeList;
    if (f.non_goals.length > 0) contractPatch.non_goals = f.non_goals;
    if (f.deliver_cmd.trim()) {
      contractPatch.deliver = { mode: "run_cmd" as const, cmd: f.deliver_cmd.trim() };
    }

    const res = await apiUpsertDraft({
      ...(f.title.trim() ? { title: f.title.trim() } : {}),
      space: effectiveSpace,
      priority: (f.priority || "P2") as Priority,
      track: (f.track || "L2") as Track,
      workspace_mode: effectiveWorkspaceMode,
      depends_on,
      open_questions: f.open_questions,
      workflow: resolveFormEffectiveWorkflow(f),
      ...(f.brief_markdown.trim() ? { brief_markdown: f.brief_markdown } : {}),
      intake_open: true,
      ...(Object.keys(contractPatch).length > 0 ? { contract: contractPatch } : {}),
    });
    writeStorageItem(ACTIVE_INTAKE_DRAFT_KEY, res.draft.id);
    this.setState({
      intakeDraftId: res.draft.id,
      intakeActiveOpen: true,
      intakeHasUnreadReply: false,
    });
    return res.draft.id;
  }

  async uploadIntakeAttachments(files: readonly File[]): Promise<void> {
    if (
      files.length === 0 ||
      this.state.attachmentUploadBusy ||
      this.state.intakeBusy
    ) {
      return;
    }
    const f = this.state.intakeForm;
    if (f.mode === "project" && !isProjectSpace(this.state.spaces[f.space])) {
      this.showToast("请先选择或添加一个项目空间，再上传图片附件");
      return;
    }

    const validFiles: File[] = [];
    let projectedCount = f.attachments.length;
    for (const file of files) {
      const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime)) {
        this.showToast(`仅支持 PNG / JPEG / WebP / GIF 图片（已跳过 ${file.name || "文件"}）`);
        continue;
      }
      if (file.size <= 0) {
        this.showToast(`图片「${file.name}」为空，已跳过`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        this.showToast(`图片「${file.name}」超过 10 MiB 上限，已跳过`);
        continue;
      }
      if (projectedCount >= 12) {
        this.showToast("每张任务卡片最多附加 12 张图片");
        break;
      }
      projectedCount += 1;
      validFiles.push(file);
    }

    if (validFiles.length === 0) return;

    this.setState({ attachmentUploadBusy: true });
    let uploadedCount = 0;
    try {
      const draftId = await this.ensureDraftForIntakeAction();
      if (!draftId || this.state.intakeDraftId !== draftId) {
        return;
      }
      for (const file of validFiles) {
        if (this.state.intakeDraftId !== draftId) {
          return;
        }
        const mime = file.type.split(";")[0]!.trim().toLowerCase() as AttachmentMimeType;
        const dataBase64 = await fileToBase64(file);
        if (this.state.intakeDraftId !== draftId) {
          return;
        }
        const res = await apiUploadDraftAttachment(draftId, {
          filename: file.name || "screenshot.png",
          mime_type: mime,
          data_base64: dataBase64,
        });
        if (this.state.intakeDraftId !== draftId) {
          return;
        }
        const nextAttachments = res.draft.attachments
          ? [...res.draft.attachments]
          : [...this.state.intakeForm.attachments, res.attachment];
        const nextForm: IntakeFormState = {
          ...this.state.intakeForm,
          attachments: nextAttachments,
        };
        this.setState({ intakeForm: nextForm });
        writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
        uploadedCount += 1;
      }
      if (uploadedCount > 0) {
        this.showToast(`已附加 ${uploadedCount} 张图片截图`);
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "上传图片附件失败");
    } finally {
      this.setState({ attachmentUploadBusy: false });
      if (uploadedCount > 0) {
        void this.bootstrap();
      }
    }
  }

  async deleteIntakeAttachment(attachmentId: string): Promise<boolean> {
    if (this.state.attachmentUploadBusy || this.state.intakeBusy) {
      return false;
    }
    const draftId = this.state.intakeDraftId;
    if (!draftId) {
      const nextForm: IntakeFormState = {
        ...this.state.intakeForm,
        attachments: this.state.intakeForm.attachments.filter(
          (a) => a.id !== attachmentId,
        ),
      };
      this.setState({ intakeForm: nextForm });
      return true;
    }
    this.setState({ attachmentUploadBusy: true });
    try {
      const res = await apiDeleteDraftAttachment(draftId, attachmentId);
      if (this.state.intakeDraftId !== draftId) {
        return false;
      }
      const nextForm: IntakeFormState = {
        ...this.state.intakeForm,
        attachments: res.draft.attachments ? [...res.draft.attachments] : [],
      };
      this.setState({ intakeForm: nextForm });
      if (this.state.intakeActiveOpen) {
        writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
      }
      this.showToast("已移除附件");
      void this.bootstrap();
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "删除附件失败");
      return false;
    } finally {
      this.setState({ attachmentUploadBusy: false });
    }
  }

  private buildSplitCardSkeleton(
    tempId: string,
    title: string,
    dependsOnTempIds: string[],
    formOverride?: IntakeFormState,
  ): SplitCardPlanItem {
    const f = formOverride ?? this.state.intakeForm;
    const { scopeList } = this.buildDraftContractFromForm(f);
    const effectiveSpace = f.mode === "local" ? "local" : f.space;
    const effectiveWs: Exclude<WorkspaceMode, "external_only"> =
      f.mode === "project"
        ? "git_worktree"
        : f.workspace_mode === "host_scoped"
          ? "host_scoped"
          : "scratch_dir";
    const workflow = resolveFormEffectiveWorkflow(f);
    const toggles = extractWorkflowToggles(workflow);
    const deliver = f.deliver_cmd.trim()
      ? { mode: "run_cmd" as const, cmd: f.deliver_cmd.trim() }
      : {
          mode: (effectiveWs === "git_worktree" ? "merge_main" : "manual") as
            | "merge_main"
            | "manual",
          cmd: null,
        };
    return {
      temp_id: tempId,
      title,
      space: effectiveSpace,
      priority: (f.priority || "P2") as Priority,
      track: (f.track || "L2") as Track,
      workspace_mode: effectiveWs,
      depends_on_temp_ids: dependsOnTempIds,
      depends_on: [],
      workflow,
      contract: {
        goal: title,
        end: f.end.trim() || "合入 main，门禁通过",
        accept_cmd: f.accept_cmd.trim() || "pnpm test",
        accept_files_hash: "pending",
        scope: scopeList.length > 0 ? scopeList : ["src/**"],
        ...(f.non_goals.length > 0 ? { non_goals: [...f.non_goals] } : {}),
        deliver,
        human_accept:
          toggles.includeAccept && toggles.acceptMode === "approval",
        external_actions: "ask",
      },
      brief_markdown: `# ${title}\n\n- 交付终点：${f.end.trim() || "合入 main"}\n- 验收命令：\`${f.accept_cmd.trim() || "pnpm test"}\``,
    };
  }

  private normalizeSplitCardsFromReply(
    text: string,
    formOverride: IntakeFormState,
  ): SplitCardPlanItem[] | null {
    const rawCards = extractRawSplitCardsFromReply(text);
    if (!rawCards) return null;
    const toStringArray = (val: unknown): string[] =>
      Array.isArray(val)
        ? val
            .filter((item): item is string => typeof item === "string")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    return rawCards.map((raw) => {
      const tempId = String(raw.temp_id).trim();
      const title = String(raw.title).trim();
      const deps = toStringArray(raw.depends_on_temp_ids);
      const skeleton = this.buildSplitCardSkeleton(tempId, title, deps, formOverride);
      const rawContract =
        raw.contract && typeof raw.contract === "object"
          ? (raw.contract as Record<string, unknown>)
          : undefined;
      const scopeArr = toStringArray(rawContract?.scope);
      const nonGoalsArr = toStringArray(rawContract?.non_goals);
      const rawDeliver =
        rawContract?.deliver && typeof rawContract.deliver === "object"
          ? (rawContract.deliver as { mode?: unknown; cmd?: unknown })
          : undefined;
      let normalizedDeliver: SplitCardPlanItem["contract"]["deliver"] | undefined;
      if (rawDeliver?.mode === "merge_main") {
        normalizedDeliver = { mode: "merge_main", cmd: null };
      } else if (rawDeliver?.mode === "open_pr") {
        normalizedDeliver = { mode: "open_pr", cmd: null };
      } else if (rawDeliver?.mode === "manual") {
        normalizedDeliver = { mode: "manual", cmd: null };
      } else if (
        rawDeliver?.mode === "run_cmd" &&
        typeof rawDeliver.cmd === "string" &&
        rawDeliver.cmd.trim().length > 0
      ) {
        normalizedDeliver = { mode: "run_cmd", cmd: rawDeliver.cmd.trim() };
      }
      let rawWf = skeleton.workflow;
      if (raw.workflow && typeof raw.workflow === "object") {
        const cand = raw.workflow as Partial<WorkflowBlueprint>;
        if (
          cand.schema_version === 1 &&
          typeof cand.preset === "string" &&
          (WORKFLOW_PRESETS as readonly string[]).includes(cand.preset) &&
          Array.isArray(cand.steps)
        ) {
          try {
            const checked = cand as WorkflowBlueprint;
            if (validateWorkflowBlueprint(checked).ok) {
              rawWf = checked;
            }
          } catch {
            // Fall back to skeleton workflow if blueprint contains malformed nodes
          }
        }
      }

      return {
        ...skeleton,
        ...(typeof raw.space === "string" && raw.space.trim()
          ? { space: raw.space.trim() }
          : {}),
        ...(raw.priority === "P0" ||
        raw.priority === "P1" ||
        raw.priority === "P2" ||
        raw.priority === "P3"
          ? { priority: raw.priority }
          : {}),
        ...(raw.track === "L1" || raw.track === "L2" || raw.track === "L3"
          ? { track: raw.track }
          : {}),
        ...(raw.workspace_mode === "git_worktree" ||
        raw.workspace_mode === "host_scoped" ||
        raw.workspace_mode === "scratch_dir"
          ? { workspace_mode: raw.workspace_mode }
          : {}),
        depends_on: toStringArray(raw.depends_on),
        workflow: rawWf,
        ...(typeof raw.brief_markdown === "string" && raw.brief_markdown.trim()
          ? { brief_markdown: raw.brief_markdown }
          : {}),
        contract: {
          ...skeleton.contract,
          ...(typeof rawContract?.goal === "string" && rawContract.goal.trim()
            ? { goal: rawContract.goal.trim() }
            : {}),
          ...(typeof rawContract?.end === "string" && rawContract.end.trim()
            ? { end: rawContract.end.trim() }
            : {}),
          ...(typeof rawContract?.accept_cmd === "string" &&
          rawContract.accept_cmd.trim()
            ? { accept_cmd: rawContract.accept_cmd.trim() }
            : {}),
          ...(typeof rawContract?.accept_files_hash === "string" &&
          rawContract.accept_files_hash.trim()
            ? { accept_files_hash: rawContract.accept_files_hash.trim() }
            : {}),
          ...(scopeArr.length > 0 ? { scope: scopeArr } : {}),
          ...(Array.isArray(rawContract?.non_goals)
            ? { non_goals: nonGoalsArr }
            : {}),
          ...(normalizedDeliver ? { deliver: normalizedDeliver } : {}),
          ...(typeof rawContract?.human_accept === "boolean"
            ? { human_accept: rawContract.human_accept }
            : {}),
        },
      };
    });
  }

  initSplitCardsFromDraft(): void {
    const f = this.state.intakeForm;
    if (f.split_cards.length >= 2) return;
    const baseTitle = f.title.trim() || "核心模块";
    const cards: SplitCardPlanItem[] = [
      this.buildSplitCardSkeleton("s1", `${baseTitle} · 切片 1（基础契约）`, []),
      this.buildSplitCardSkeleton("s2", `${baseTitle} · 切片 2（主链路交付）`, ["s1"]),
    ];
    this.updateIntakeForm({ split_cards: cards });
  }

  setSplitCards(cards: SplitCardPlanItem[]): void {
    this.updateIntakeForm({ split_cards: cards });
  }

  addSplitCard(): void {
    const cur = this.state.intakeForm.split_cards;
    if (cur.length >= 12) {
      this.showToast("最多支持同时拆分为 12 张关联卡片");
      return;
    }
    const existing = new Set(cur.map((c) => c.temp_id.trim()));
    let num = cur.length + 1;
    while (existing.has(`s${num}`)) {
      num += 1;
    }
    const prevTempId = cur[cur.length - 1]?.temp_id.trim();
    const nextCard = this.buildSplitCardSkeleton(
      `s${num}`,
      `切片 ${num}`,
      prevTempId ? [prevTempId] : [],
    );
    this.updateIntakeForm({ split_cards: [...cur, nextCard] });
  }

  updateSplitCard(index: number, patch: Partial<SplitCardPlanItem>): void {
    const cur = this.state.intakeForm.split_cards;
    if (index < 0 || index >= cur.length) return;
    const next = cur.map((card, i) => (i === index ? { ...card, ...patch } : card));
    this.updateIntakeForm({ split_cards: next });
  }

  removeSplitCard(index: number): void {
    const cur = this.state.intakeForm.split_cards;
    if (cur.length <= 2 || index < 0 || index >= cur.length) return;
    const removedId = cur[index]!.temp_id.trim();
    const next = cur
      .filter((_, i) => i !== index)
      .map((c) => ({
        ...c,
        depends_on_temp_ids: c.depends_on_temp_ids.filter(
          (tid) => tid.trim() !== removedId,
        ),
      }));
    this.updateIntakeForm({ split_cards: next });
  }

  clearSplitCards(): void {
    this.updateIntakeForm({ split_cards: [] });
  }

  private guardAttachmentUploadBusy(): boolean {
    if (!this.state.attachmentUploadBusy) return false;
    this.showToast("图片附件正在上传，请稍候");
    return true;
  }

  async commitSplitIntakeTasks(cards: SplitCardPlanItem[]): Promise<boolean> {
    if (this.guardAttachmentUploadBusy()) return false;
    if (cards.length < 2 || cards.length > 12) {
      this.showToast("批量拆卡数量须在 2–12 张之间");
      return false;
    }
    const dag = validateSplitCardsDag(cards);
    if (!dag.ok) {
      this.showToast(`DAG 校验未通过：${dag.errors[0]}`);
      return false;
    }

    this.setState({ intakeBusy: true });
    try {
      const draftId = await this.ensureDraftForIntakeAction();
      if (!draftId) {
        this.setState({ intakeBusy: false });
        return false;
      }
      const res = await apiCommitSplitDraft(draftId, cards);
      clearActiveIntakePersistence();
      const preferred =
        this.state.spaceFilter !== "all" ? this.state.spaceFilter : undefined;
      this.setState({
        intakeBusy: false,
        intakeDraftId: null,
        intakeForm: createDefaultIntakeForm(this.state.spaces, preferred),
        intakeRightTab: "brief",
        intakeProgressLogs: [],
        intakeMessages: defaultWelcomeIntakeMessages(),
        draftOpen: false,
        intakeActiveOpen: false,
        intakeHasUnreadReply: false,
      });
      await this.bootstrap();
      this.go("board");
      this.showToast(`已批量立项 ${res.cards.length} 张依赖任务卡`);
      return true;
    } catch (err) {
      this.setState({ intakeBusy: false });
      this.showToast(err instanceof Error ? err.message : "批量拆卡提交失败");
      return false;
    }
  }

  private async hydrateRestoredDraftChat(draftId: string): Promise<void> {
    const msgs = await apiFetchDraftChat(draftId).catch(() => null);
    if (
      msgs &&
      msgs.length > 0 &&
      this.state.intakeActiveOpen &&
      this.state.intakeDraftId === draftId &&
      this.state.intakeMessages.length <= 1
    ) {
      this.setState({ intakeMessages: msgs });
      writeLocalIntakeSnapshot(this.state.intakeForm, msgs);
    }
  }

  private async resetIntakeSessionState(markClosedOnServer: boolean): Promise<void> {
    const prevDraftId = this.state.intakeDraftId;
    clearActiveIntakePersistence();
    const preferred =
      this.state.spaceFilter !== "all" ? this.state.spaceFilter : undefined;
    this.setState({
      intakeDraftId: null,
      intakeForm: createDefaultIntakeForm(this.state.spaces, preferred),
      intakeRightTab: "brief",
      intakeProgressLogs: [],
      intakeMessages: defaultWelcomeIntakeMessages(),
      draftOpen: false,
      intakeActiveOpen: false,
      intakeHasUnreadReply: false,
    });
    if (markClosedOnServer && prevDraftId) {
      try {
        await apiUpsertDraft({ id: prevDraftId, intake_open: false });
        await this.bootstrap();
      } catch {
        // Best-effort server closure; local state is already reset.
      }
    }
  }

  startNewIntake(): void {
    if (this.guardAttachmentUploadBusy()) return;
    void this.resetIntakeSessionState(true);
  }

  async closeIntakeSession(): Promise<void> {
    if (this.guardAttachmentUploadBusy()) return;
    await this.resetIntakeSessionState(true);
    this.showToast("已关闭当前立项对话");
  }

  async deleteIntakeDraft(draftId: string): Promise<void> {
    if (this.guardAttachmentUploadBusy()) return;
    try {
      await apiDeleteDraft(draftId);
      if (this.state.intakeDraftId === draftId) {
        await this.resetIntakeSessionState(false);
      }
      await this.bootstrap();
      this.showToast("已删除草稿");
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "删除草稿失败");
    }
  }

  async loadDraftIntoIntake(draft: DraftCardWithBrief): Promise<void> {
    if (this.guardAttachmentUploadBusy()) return;
    const nextForm = draftToIntakeForm(draft);
    writeStorageItem(ACTIVE_INTAKE_DRAFT_KEY, draft.id);
    this.setState({
      intakeDraftId: draft.id,
      intakeForm: nextForm,
      intakeRightTab: "brief",
      intakeProgressLogs: [],
      intakeActiveOpen: true,
      intakeHasUnreadReply: false,
    });
    const msgs = await apiFetchDraftChat(draft.id).catch(() => null);
    const nextMessages =
      msgs && msgs.length > 0 ? msgs : defaultWelcomeIntakeMessages();
    this.setState({ intakeMessages: nextMessages });
    writeLocalIntakeSnapshot(nextForm, nextMessages);
  }

  private buildDraftContractFromForm(formOverride?: IntakeFormState): {
    depends_on: string[];
    scopeList: string[];
  } {
    const f = formOverride ?? this.state.intakeForm;
    const scopeList = f.scope
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const depends_on = f.depends_on
      .split(/[\n,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return { depends_on, scopeList };
  }

  async saveIntakeDraft(): Promise<DraftCard | null> {
    if (this.guardAttachmentUploadBusy()) return null;
    const f = this.state.intakeForm;
    if (!f.title.trim()) return null;
    if (f.mode === "project" && !isProjectSpace(this.state.spaces[f.space])) {
      this.showToast("请先选择或添加一个项目空间");
      return null;
    }
    const { depends_on, scopeList } = this.buildDraftContractFromForm();
    const effectiveSpace = f.mode === "local" ? "local" : f.space;
    const effectiveWorkspaceMode: Exclude<WorkspaceMode, "external_only"> =
      f.mode === "project"
        ? "git_worktree"
        : (f.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir");

    this.setState({ intakeBusy: true });
    try {
      const keepActiveOpen =
        this.state.intakeActiveOpen || this.state.intakeMessages.length > 1;
      const effectiveWorkflow = resolveFormEffectiveWorkflow(f);
      const res = await apiUpsertDraft({
        ...(this.state.intakeDraftId ? { id: this.state.intakeDraftId } : {}),
        title: f.title.trim(),
        space: effectiveSpace,
        priority: (f.priority || "P2") as Priority,
        track: (f.track || "L2") as Track,
        workspace_mode: effectiveWorkspaceMode,
        depends_on,
        open_questions: f.open_questions,
        workflow: effectiveWorkflow,
        brief_markdown: f.brief_markdown,
        ...(keepActiveOpen ? { intake_open: true } : {}),
        contract: {
          goal: f.title.trim(),
          ...(f.end.trim() ? { end: f.end.trim() } : {}),
          ...(f.accept_cmd.trim() ? { accept_cmd: f.accept_cmd.trim() } : {}),
          ...(scopeList.length > 0 ? { scope: scopeList } : {}),
          ...(this.state.intakeDraftId || f.non_goals.length > 0
            ? { non_goals: f.non_goals }
            : {}),
          ...(f.deliver_cmd.trim()
            ? { deliver: { mode: "run_cmd" as const, cmd: f.deliver_cmd.trim() } }
            : {}),
        },
      });
      if (keepActiveOpen) {
        writeStorageItem(ACTIVE_INTAKE_DRAFT_KEY, res.draft.id);
        writeLocalIntakeSnapshot(f, this.state.intakeMessages);
      }
      this.setState({
        intakeDraftId: res.draft.id,
        intakeBusy: false,
        ...(keepActiveOpen ? { intakeActiveOpen: true, intakeHasUnreadReply: false } : {}),
      });
      this.showToast("已保存至 drafts/ 草稿箱");
      await this.bootstrap();
      return res.draft;
    } catch (err) {
      this.setState({ intakeBusy: false });
      this.showToast(err instanceof Error ? err.message : "保存草稿失败");
      return null;
    }
  }

  private generateNextTaskId(): string {
    let maxNum = 100;
    for (const t of this.state.tasks) {
      const m = t.id.match(/^t-(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxNum) {
          maxNum = n;
        }
      }
    }
    let candidate = `t-${maxNum + 1}`;
    const existing = new Set(this.state.tasks.map((t) => t.id));
    while (existing.has(candidate)) {
      maxNum += 1;
      candidate = `t-${maxNum}`;
    }
    return candidate;
  }

  async commitIntakeTask(): Promise<boolean> {
    if (this.guardAttachmentUploadBusy()) return false;
    const f = this.state.intakeForm;
    const { depends_on, scopeList } = this.buildDraftContractFromForm();
    const effectiveSpace = f.mode === "local" ? "local" : f.space;
    const effectiveWorkspaceMode: Exclude<WorkspaceMode, "external_only"> =
      f.mode === "project"
        ? "git_worktree"
        : (f.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir");

    if (f.mode === "project" && !isProjectSpace(this.state.spaces[effectiveSpace])) {
      this.showToast("请先选择或添加一个项目空间");
      return false;
    }

    if (
      !f.title.trim() ||
      !f.priority ||
      !effectiveSpace ||
      !f.track ||
      !effectiveWorkspaceMode ||
      !f.end.trim() ||
      !f.accept_cmd.trim() ||
      scopeList.length === 0
    ) {
      return false;
    }

    this.setState({ intakeBusy: true });
    try {
      const effectiveWorkflow = resolveFormEffectiveWorkflow(f);
      const workflowToggles = extractWorkflowToggles(effectiveWorkflow);
      const deliverCmdTrimmed = f.deliver_cmd.trim();
      let draftId = this.state.intakeDraftId;
      if (!draftId) {
        const saved = await apiUpsertDraft({
          title: f.title.trim(),
          space: effectiveSpace,
          priority: f.priority,
          track: f.track,
          workspace_mode: effectiveWorkspaceMode,
          depends_on,
          workflow: effectiveWorkflow,
          contract: {
            goal: f.title.trim(),
            end: f.end.trim(),
            accept_cmd: f.accept_cmd.trim(),
            scope: scopeList,
            ...(f.non_goals.length > 0 ? { non_goals: f.non_goals } : {}),
            ...(deliverCmdTrimmed
              ? { deliver: { mode: "run_cmd" as const, cmd: deliverCmdTrimmed } }
              : {}),
          },
        });
        draftId = saved.draft.id;
      } else {
        // Ensure form edits such as workflow roster_role or non_goals are synced to draft before commit.
        await apiUpsertDraft({
          id: draftId,
          title: f.title.trim(),
          space: effectiveSpace,
          priority: f.priority,
          track: f.track,
          workspace_mode: effectiveWorkspaceMode,
          depends_on,
          workflow: effectiveWorkflow,
          contract: {
            goal: f.title.trim(),
            end: f.end.trim(),
            accept_cmd: f.accept_cmd.trim(),
            scope: scopeList,
            ...(f.non_goals.length > 0 ? { non_goals: f.non_goals } : {}),
            ...(deliverCmdTrimmed
              ? { deliver: { mode: "run_cmd" as const, cmd: deliverCmdTrimmed } }
              : {}),
          },
        });
      }

      const taskId = this.generateNextTaskId();
      const deliverConfig = deliverCmdTrimmed
        ? { mode: "run_cmd" as const, cmd: deliverCmdTrimmed }
        : {
            mode: (effectiveWorkspaceMode === "git_worktree"
              ? "merge_main"
              : "manual") as "merge_main" | "manual",
            cmd: null,
          };

      const customBrief = f.brief_markdown.trim();
      const fallbackBrief = `# ${f.title.trim()}\n\n- 目标：${f.title.trim()}\n- 交付终点：${f.end.trim()}\n- 验收命令：\`${f.accept_cmd.trim()}\`\n- 可改范围：${scopeList.join(", ")}\n`;

      const payload: CommitDraftPayload = {
        id: taskId,
        title: f.title.trim(),
        space: effectiveSpace,
        priority: f.priority,
        track: f.track,
        workspace_mode: effectiveWorkspaceMode,
        depends_on,
        workflow: effectiveWorkflow,
        contract: {
          goal: f.title.trim(),
          end: f.end.trim(),
          accept_cmd: f.accept_cmd.trim(),
          accept_files_hash: "pending",
          scope: scopeList,
          ...(f.non_goals.length > 0 ? { non_goals: f.non_goals } : {}),
          deliver: deliverConfig,
          human_accept:
            workflowToggles.includeAccept && workflowToggles.acceptMode === "approval",
          external_actions: "ask",
        },
        brief_markdown: customBrief.length > 0 ? f.brief_markdown : fallbackBrief,
      };

      const committed = await apiCommitDraft(draftId, payload);
      clearActiveIntakePersistence();
      const preferred =
        this.state.spaceFilter !== "all" ? this.state.spaceFilter : undefined;
      this.setState({
        intakeBusy: false,
        intakeDraftId: null,
        intakeForm: createDefaultIntakeForm(this.state.spaces, preferred),
        intakeRightTab: "brief",
        intakeProgressLogs: [],
        intakeMessages: defaultWelcomeIntakeMessages(),
        draftOpen: false,
        intakeActiveOpen: false,
        intakeHasUnreadReply: false,
      });
      await this.bootstrap();
      this.go("board");
      this.showToast(`已立项 ${committed.card.id}`);
      return true;
    } catch (err) {
      this.setState({ intakeBusy: false });
      this.showToast(err instanceof Error ? err.message : "立项提交失败");
      return false;
    }
  }

  async requestPmAutofill(): Promise<void> {
    await this.sendIntakeChat(
      "请结合当前项目目录与上述需求上下文，整理《产品方案 (BRIEF.md)》并自动补全立项单中的标题、交付终点、验收命令与可改范围。",
    );
  }

  async refreshIntakeRecon(hint?: string): Promise<void> {
    if (this.state.reconBusy || this.state.intakeBusy || this.guardAttachmentUploadBusy()) {
      return;
    }
    const f = this.state.intakeForm;
    if (f.mode !== "project" || !isProjectSpace(this.state.spaces[f.space])) {
      this.showToast("前置侦察仅适用于已绑定仓库的项目空间");
      return;
    }
    this.setState({ reconBusy: true });
    try {
      const draftId = await this.ensureDraftForIntakeAction();
      if (!draftId) {
        this.setState({ reconBusy: false });
        return;
      }
      const res = await apiReconDraft(draftId, hint);
      if (typeof res.research_markdown === "string" && res.research_markdown.trim()) {
        const nextForm = {
          ...this.state.intakeForm,
          research_markdown: res.research_markdown,
        };
        this.setState({ intakeForm: nextForm, reconBusy: false });
        writeLocalIntakeSnapshot(nextForm, this.state.intakeMessages);
        this.showToast("已完成项目前置侦察，简报已注入 PM 上下文");
      } else {
        this.setState({ reconBusy: false });
        this.showToast(
          res.skipped_reason === "researcher_not_enabled"
            ? "未启用 researcher 槽位，请先在阵容页绑定侦察模型"
            : `未能生成侦察简报（${res.skipped_reason ?? "empty"}）`,
        );
      }
    } catch (err) {
      this.setState({ reconBusy: false });
      this.showToast(err instanceof Error ? err.message : "刷新项目侦察失败");
    }
  }

  async sendIntakeChat(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.state.intakeBusy || this.guardAttachmentUploadBusy()) {
      return;
    }

    const f = this.state.intakeForm;
    const effectiveSpace = f.mode === "local" ? "local" : f.space;
    const effectiveWorkspaceMode: Exclude<WorkspaceMode, "external_only"> =
      f.mode === "project"
        ? "git_worktree"
        : (f.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir");

    if (f.mode === "project" && !isProjectSpace(this.state.spaces[effectiveSpace])) {
      this.showToast("请先添加或选择目标项目空间，再开始项目立项对话");
      return;
    }

    const userMsg: ChatMessage = { who: "me", text: trimmed };
    const optimisticMessages = [...this.state.intakeMessages, userMsg];
    this.setState({
      intakeMessages: optimisticMessages,
      intakeBusy: true,
      intakeProgressLogs: [],
      intakeActiveOpen: true,
      intakeHasUnreadReply: false,
    });
    writeLocalIntakeSnapshot(this.state.intakeForm, optimisticMessages);

    try {
      const { depends_on, scopeList } = this.buildDraftContractFromForm();
      const contractPatch: Partial<{
        goal: string;
        end: string;
        accept_cmd: string;
        scope: string[];
        non_goals: string[];
      }> = {};
      if (f.title.trim()) contractPatch.goal = f.title.trim();
      if (f.end.trim()) contractPatch.end = f.end.trim();
      if (f.accept_cmd.trim()) contractPatch.accept_cmd = f.accept_cmd.trim();
      if (scopeList.length > 0) contractPatch.scope = scopeList;
      if (this.state.intakeDraftId || f.non_goals.length > 0) {
        contractPatch.non_goals = f.non_goals;
      }

      const synced = await apiUpsertDraft({
        ...(this.state.intakeDraftId ? { id: this.state.intakeDraftId } : {}),
        ...(this.state.intakeDraftId
          ? (f.title.trim() ? { title: f.title.trim() } : {})
          : { title: f.title.trim() || trimmed.slice(0, 32) }),
        space: effectiveSpace,
        priority: (f.priority || "P2") as Priority,
        track: (f.track || "L2") as Track,
        workspace_mode: effectiveWorkspaceMode,
        depends_on,
        open_questions: f.open_questions,
        workflow: resolveFormEffectiveWorkflow(f),
        ...(f.brief_markdown.trim() ? { brief_markdown: f.brief_markdown } : {}),
        intake_open: true,
        ...(Object.keys(contractPatch).length > 0 ? { contract: contractPatch } : {}),
      });
      const draftId = synced.draft.id;
      writeStorageItem(ACTIVE_INTAKE_DRAFT_KEY, draftId);
      if (this.state.intakeDraftId !== draftId) {
        this.setState({ intakeDraftId: draftId });
      }

      const res = await apiSendIntakeChat(draftId, trimmed);
      const nextMsgs = res.messages
        ? res.messages
        : res.reply
          ? [
              ...this.state.intakeMessages,
              typeof res.reply === "string"
                ? ({ who: "agent", name: "intake", text: res.reply } as ChatMessage)
                : res.reply,
            ]
          : this.state.intakeMessages;

      const nextForm = { ...this.state.intakeForm };
      if (res.draft) {
        const resIsLocal = res.draft.space === "local";
        nextForm.mode = resIsLocal ? "local" : "project";
        if (res.draft.title) nextForm.title = res.draft.title;
        if (res.draft.priority) nextForm.priority = res.draft.priority;
        if (res.draft.space) nextForm.space = res.draft.space;
        if (res.draft.track && res.draft.track !== "L3") nextForm.track = res.draft.track;
        if (res.draft.workspace_mode && resIsLocal) {
          nextForm.workspace_mode =
            res.draft.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir";
        } else {
          nextForm.workspace_mode = resIsLocal ? "scratch_dir" : "git_worktree";
        }
        if (res.draft.workflow) nextForm.workflow = res.draft.workflow;
        if (res.draft.contract.end) nextForm.end = res.draft.contract.end;
        if (res.draft.contract.accept_cmd) {
          nextForm.accept_cmd = res.draft.contract.accept_cmd;
        }
        if (res.draft.contract.deliver?.mode === "run_cmd") {
          nextForm.deliver_cmd = res.draft.contract.deliver.cmd;
        }
        if (res.draft.contract.scope?.length) {
          nextForm.scope = res.draft.contract.scope.join("\n");
        }
        if (res.draft.contract.non_goals !== undefined) {
          nextForm.non_goals = res.draft.contract.non_goals;
        }
        if (res.draft.attachments !== undefined) {
          nextForm.attachments = res.draft.attachments;
        }
        if (res.draft.depends_on.length) {
          nextForm.depends_on = res.draft.depends_on.join(", ");
        }
        if (res.draft.open_questions !== undefined) {
          nextForm.open_questions = res.draft.open_questions;
        }
      }
      const latestAgentText =
        typeof res.reply === "string"
          ? res.reply
          : res.reply?.text ?? nextMsgs[nextMsgs.length - 1]?.text ?? "";
      const extractedSplit = latestAgentText
        ? this.normalizeSplitCardsFromReply(latestAgentText, nextForm)
        : null;
      if (extractedSplit) {
        nextForm.split_cards = extractedSplit;
      }
      const nextBrief = res.brief_markdown ?? res.draft?.brief_markdown;
      if (typeof nextBrief === "string") {
        nextForm.brief_markdown = nextBrief;
      }
      const nextResearch = res.research_markdown ?? res.draft?.research_markdown;
      if (typeof nextResearch === "string") {
        nextForm.research_markdown = nextResearch;
      }
      const unread = this.state.view !== "intake";
      this.setState({
        intakeMessages: nextMsgs,
        intakeForm: nextForm,
        intakeBusy: false,
        intakeProgressLogs: [],
        intakeActiveOpen: true,
        intakeHasUnreadReply: unread,
      });
      writeLocalIntakeSnapshot(nextForm, nextMsgs);
      if (unread) {
        this.showToast("立项助手已回复，点击右下角窗口继续");
      }
      void this.bootstrap();
    } catch (err) {
      const errMsgs: ChatMessage[] = [
        ...this.state.intakeMessages,
        {
          who: "agent",
          name: "系统提示",
          text:
            err instanceof Error
              ? `对话请求未完成（${err.message}），你也可以直接在右侧填写立项字段并提交。`
              : "对话暂不可用，请直接在右侧填写立项字段。",
        },
      ];
      this.setState({
        intakeBusy: false,
        intakeProgressLogs: [],
        intakeMessages: errMsgs,
        intakeHasUnreadReply: this.state.view !== "intake",
      });
      writeLocalIntakeSnapshot(this.state.intakeForm, errMsgs);
    }
  }

  async loadResolveChat(taskId: string): Promise<void> {
    const msgs = await apiFetchTaskChat(taskId).catch(() => null);
    if (msgs && msgs.length > 0) {
      this.setState({
        resolveMessagesByTask: {
          ...this.state.resolveMessagesByTask,
          [taskId]: msgs,
        },
      });
    }
  }

  async sendResolveChat(taskId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.state.resolveBusy) return;
    const prev = this.state.resolveMessagesByTask[taskId] ?? [];
    this.setState({
      resolveMessagesByTask: {
        ...this.state.resolveMessagesByTask,
        [taskId]: [...prev, { who: "me", text: trimmed }],
      },
      resolveBusy: true,
    });
    try {
      const res = await apiSendResolveChat(taskId, trimmed);
      const current = this.state.resolveMessagesByTask[taskId] ?? [];
      const nextMsgs = res.messages
        ? res.messages
        : res.reply
          ? [
              ...current,
              typeof res.reply === "string"
                ? ({ who: "agent", name: "resolver", text: res.reply } as ChatMessage)
                : res.reply,
            ]
          : current;
      this.setState({
        resolveMessagesByTask: {
          ...this.state.resolveMessagesByTask,
          [taskId]: nextMsgs,
        },
        resolveBusy: false,
      });
      if (res.pendingDecision || res.card) {
        await this.bootstrap();
        await this.loadTaskDetail(taskId);
      }
    } catch (err) {
      const current = this.state.resolveMessagesByTask[taskId] ?? [];
      this.setState({
        resolveBusy: false,
        resolveMessagesByTask: {
          ...this.state.resolveMessagesByTask,
          [taskId]: [
            ...current,
            {
              who: "agent",
              name: "系统提示",
              text:
                err instanceof Error
                  ? `讨论发送失败（${err.message}），可直接从右侧选项拍板。`
                  : "讨论发送失败，可直接从右侧选项拍板。",
            },
          ],
        },
      });
    }
  }

  updatePricingLocal(
    modelName: string,
    field: "in" | "cached" | "cache_write" | "out",
    val: number | undefined,
  ): void {
    const existing = this.state.pricing.models[modelName] ?? {
      in: 0,
      cached: 0,
      out: 0,
    };
    const nextPrice = { ...existing };
    if (field === "cache_write") {
      if (val === undefined) {
        delete nextPrice.cache_write;
      } else if (Number.isFinite(val) && val >= 0) {
        nextPrice.cache_write = val;
      } else {
        return;
      }
    } else {
      if (val === undefined || !Number.isFinite(val) || val < 0) return;
      nextPrice[field] = val;
    }
    const prevCustom = this.state.pricing.custom_models ?? [];
    const nextCustom = prevCustom.includes(modelName)
      ? prevCustom
      : [...prevCustom, modelName];
    this.setState({
      pricing: {
        ...this.state.pricing,
        models: {
          ...this.state.pricing.models,
          [modelName]: nextPrice,
        },
        custom_models: nextCustom,
      },
    });
  }

  async syncPricing(options: SyncPricingRequest = {}): Promise<boolean> {
    if (this.state.pricingSyncBusy) return false;
    this.setState({ pricingSyncBusy: true });
    try {
      const res = await apiSyncModelPricing(options);
      this.setState({ pricing: res.pricing, pricingSyncBusy: false });
      const sourceLabel =
        res.source === "models.dev"
          ? "models.dev"
          : res.source === "litellm"
            ? "LiteLLM"
            : "内置离线基线";
      if (options.restore_model) {
        this.showToast(`已恢复 ${options.restore_model} 为同步单价（${sourceLabel}）`);
      } else if (res.warning) {
        this.showToast(res.warning);
      } else {
        const overrideHint =
          res.preserved_overrides.length > 0
            ? `，保留 ${res.preserved_overrides.length} 项自定义覆盖`
            : "";
        this.showToast(
          `已从 ${sourceLabel} 同步 ${res.matched_models.length} 个模型单价${overrideHint}`,
        );
      }
      return true;
    } catch (err) {
      this.setState({ pricingSyncBusy: false });
      this.showToast(err instanceof Error ? err.message : "同步模型单价失败");
      return false;
    }
  }

  async restoreModelPricing(modelName: string): Promise<boolean> {
    return await this.syncPricing({ force: false, restore_model: modelName });
  }

  async saveSettingsSection<K extends keyof SettingsSectionMap>(
    section: K,
    data: SettingsSectionMap[K],
  ): Promise<boolean> {
    try {
      const res = await apiUpdateSettings(section, data);
      if (section === "roles") {
        this.setState({ roles: res.data as RolesConfig });
      } else if (section === "limits") {
        this.setState({ limits: res.data as LimitsConfig });
      } else if (section === "pricing") {
        this.setState({ pricing: res.data as PricingConfig });
      } else if (section === "providers") {
        this.setState({
          providersConfig: res.data as ProvidersConfig,
          providersConfigLoaded: true,
        });
        void this.refreshProviders();
        void this.refreshAgents(true);
      } else if (
        section === "roster" &&
        res?.data &&
        typeof res.data === "object" &&
        "roster" in res.data &&
        (res.data as RosterConfig).roster &&
        typeof (res.data as RosterConfig).roster === "object"
      ) {
        this.setState({ roster: res.data as RosterConfig });
        void this.bootstrap();
      }
      this.showToast(`已保存 config/${section}.yaml`);
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "保存设置失败");
      return false;
    }
  }

  async refreshProviders(): Promise<void> {
    try {
      const res = await apiFetchProviders();
      this.setState({ providerStatuses: res.providers });
    } catch {
      // Best-effort refresh; keep current snapshot on transient error
    }
  }

  async detectProviders(): Promise<ProvidersConfig | null> {
    if (this.state.authMode !== "local") return null;
    try {
      const res = await apiDetectProviders();
      this.setState({
        providersConfig: res.data,
        providersConfigLoaded: true,
        providerStatuses: res.providers,
      });
      void this.refreshAgents(true);
      const enabledCount = res.data.providers.filter((p) => p.enabled).length;
      const disabledCount = res.data.providers.length - enabledCount;
      this.showToast(`已按本机探测同步：启用 ${enabledCount} 项，关闭 ${disabledCount} 项`);
      return res.data;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "重新探测 Providers 失败");
      return null;
    }
  }

  async refreshProvidersConfig(): Promise<void> {
    if (this.state.authMode !== "local") return;
    try {
      const res = await apiFetchProvidersSettings();
      this.setState({
        providersConfig: res.data,
        providersConfigLoaded: true,
      });
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "读取 Providers 配置失败");
    }
  }

  async refreshRoster(): Promise<void> {
    try {
      const res = await apiFetchRosterSettings();
      if (
        res?.data &&
        typeof res.data === "object" &&
        res.data.roster &&
        typeof res.data.roster === "object"
      ) {
        this.setState({ roster: res.data });
      }
    } catch {
      // Ignore if endpoint is absent in legacy mock servers
    }
  }

  async testProvider(providerId: string): Promise<void> {
    if (this.state.authMode !== "local" || this.state.providerTestBusyId) return;
    this.setState({ providerTestBusyId: providerId });
    try {
      const res = await apiTestProvider(providerId);
      const next = res.status;
      const exists = this.state.providerStatuses.some(
        (p) => p.provider_id === next.provider_id,
      );
      const nextStatuses = exists
        ? this.state.providerStatuses.map((p) =>
            p.provider_id === next.provider_id ? next : p,
          )
        : [...this.state.providerStatuses, next];
      this.setState({
        providerStatuses: nextStatuses,
        providerTestBusyId: null,
      });
      const label = next.label || providerId;
      if (next.status === "ready") {
        this.showToast(`${label} 已就绪${next.version ? ` (v${next.version})` : ""}`);
      } else {
        this.showToast(`${label}：${next.detail ?? next.status}`);
      }
      void this.refreshAgents(true);
    } catch (err) {
      this.setState({ providerTestBusyId: null });
      this.showToast(err instanceof Error ? err.message : `检测 ${providerId} 失败`);
    }
  }

  async toggleSpacePin(spaceId: string): Promise<void> {
    const sp = this.state.spaces[spaceId];
    if (!isProjectSpace(sp)) return;
    const nextPinned = !Boolean(sp.pinned);
    try {
      const res = await apiUpsertSpace(spaceId, {
        name: sp.name,
        repo_path: sp.repo_path!,
        default_branch: sp.default_branch,
        copy_untracked: sp.copy_untracked,
        clone_deps: sp.clone_deps,
        ...(sp.default_accept_cmd ? { default_accept_cmd: sp.default_accept_cmd } : {}),
        freeze_patterns: sp.freeze_patterns,
        pinned: nextPinned,
        ...(sp.scripts ? { scripts: sp.scripts } : {}),
      });
      this.setState({
        spaces: {
          ...this.state.spaces,
          [spaceId]: res.space,
        },
      });
      this.showToast(nextPinned ? `已置顶项目 ${sp.name}` : `已取消置顶 ${sp.name}`);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "更新项目置顶状态失败");
    }
  }

  async refreshAgents(refresh = false): Promise<void> {
    try {
      const res = await apiFetchAgents({ refresh });
      if (!res) return;
      const totalModels = res.agents.reduce(
        (sum, agent) => sum + (agent.models?.length ?? 0),
        0,
      );
      this.setState({
        agents: res.agents,
        ...(res.backends.length > 0 || refresh ? { backends: res.backends } : {}),
      });
      if (res.agents.length === 0) {
        const failed = res.backends.find((b) => !b.connected && b.detail);
        this.showToast(
          failed?.detail
            ? `未读取到可用 Agent：${failed.detail}`
            : "未读取到可用 Agent，请检查连接与底座配置",
        );
      } else {
        this.showToast(`已读取 ${res.agents.length} 个 Agent（共 ${totalModels} 个模型）`);
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "读取 Agent 列表失败");
    }
  }

  async refreshLedgers(): Promise<void> {
    try {
      const data = await apiFetchLedgers();
      if (data) {
        this.setState({ ledgers: normalizeLedgers(data) });
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "读取账本失败");
    }
  }

  openAddSpaceModal(
    selectInIntake = false,
    prefillPath: string | null = null,
  ): void {
    this.setState({
      spaceModalOpen: true,
      editingSpaceId: null,
      spaceModalSelectInIntake: selectInIntake,
      spaceModalPrefillPath: prefillPath,
    });
  }

  openEditSpaceModal(spaceId: string): void {
    this.setState({
      spaceModalOpen: true,
      editingSpaceId: spaceId,
      spaceModalSelectInIntake: false,
      spaceModalPrefillPath: null,
    });
  }

  closeSpaceModal(): void {
    this.setState({
      spaceModalOpen: false,
      editingSpaceId: null,
      spaceModalSelectInIntake: false,
      spaceModalPrefillPath: null,
    });
  }

  suggestUniqueSpaceId(preferredId: string, repoPath: string): string {
    const existing = this.state.spaces[preferredId];
    if (!existing || existing.repo_path === repoPath) {
      return preferredId;
    }
    let suffix = 2;
    while (this.state.spaces[`${preferredId}-${suffix}`]) {
      const candidate = this.state.spaces[`${preferredId}-${suffix}`];
      if (candidate?.repo_path === repoPath) {
        return candidate.id;
      }
      suffix += 1;
    }
    return `${preferredId}-${suffix}`;
  }

  async discoverLocalSpaces(force = false): Promise<void> {
    if (this.state.discoverBusy) return;
    if (!force && this.state.discoverLoaded) return;
    this.setState({ discoverBusy: true, discoverError: null });
    try {
      const res = await apiDiscoverSpaces();
      this.setState({
        discoveredRepos: res.repos,
        discoverBusy: false,
        discoverLoaded: true,
      });
    } catch (err) {
      this.setState({
        discoverBusy: false,
        discoverError:
          err instanceof Error ? err.message : "扫描本机 Git 项目失败",
      });
    }
  }

  async pickSpaceDirectory(): Promise<string | null> {
    if (this.state.pickDirBusy) return null;
    this.setState({ pickDirBusy: true });
    try {
      const res = await apiPickSpaceDirectory();
      if (res.cancelled || !res.path) {
        return null;
      }
      return res.path;
    } catch (err) {
      this.showToast(
        err instanceof Error ? err.message : "打开系统文件夹选择器失败",
      );
      return null;
    } finally {
      this.setState({ pickDirBusy: false });
    }
  }

  async revealLocalPath(targetPath: string): Promise<void> {
    try {
      await apiRevealLocalPath(targetPath);
      this.showToast("已在文件管理器中定位");
    } catch (err) {
      this.showToast(
        err instanceof Error ? err.message : "在文件管理器中定位路径失败",
      );
    }
  }

  async pickDirectoryAndAttach(selectInIntake = true): Promise<void> {
    const pickedPath = await this.pickSpaceDirectory();
    if (!pickedPath) return;
    try {
      const info = await this.inspectSpace(pickedPath);
      const existing = findSpaceByRepoPath(info.repo_path, this.state.spaces);
      if (existing) {
        if (selectInIntake) {
          this.selectIntakeProjectSpace(existing.id);
          if (this.state.view !== "intake") {
            this.go("intake");
          }
          this.showToast(`已切换到项目空间 ${existing.name}`);
        } else {
          this.showToast(`项目空间 ${existing.name} 已存在`);
        }
        return;
      }
      this.openAddSpaceModal(selectInIntake, info.repo_path);
    } catch (err) {
      this.showToast(
        err instanceof Error ? err.message : "所选目录不是有效的 Git 仓库",
      );
    }
  }

  async inspectSpace(rawPath: string): Promise<InspectSpaceResult> {
    return await apiInspectSpacePath(rawPath);
  }

  async quickAddDiscoveredRepo(repo: DiscoveredGitRepo): Promise<SpaceConfig | null> {
    const info = await this.inspectSpace(repo.repo_path);
    const existing = findSpaceByRepoPath(info.repo_path, this.state.spaces);
    if (existing) {
      if (this.state.spaceModalSelectInIntake) {
        this.selectIntakeProjectSpace(existing.id);
      }
      this.closeSpaceModal();
      this.showToast(`已选择项目空间 ${existing.name}`);
      return existing;
    }
    const targetId = this.suggestUniqueSpaceId(info.suggested_id, info.repo_path);
    return await this.saveSpace(targetId, {
      name: info.suggested_name,
      repo_path: info.repo_path,
      default_branch: info.default_branch,
      copy_untracked: info.copy_untracked,
      clone_deps: info.clone_deps,
      ...(info.default_accept_cmd
        ? { default_accept_cmd: info.default_accept_cmd }
        : {}),
      freeze_patterns: [],
    });
  }

  async saveSpace(
    spaceId: string,
    payload: UpsertSpacePayload,
  ): Promise<SpaceConfig> {
    const shouldSelectInIntake =
      this.state.spaceModalSelectInIntake ||
      (this.state.view === "intake" &&
        this.state.intakeForm.mode === "project" &&
        !isProjectSpace(this.state.spaces[this.state.intakeForm.space]));
    const res = await apiUpsertSpace(spaceId, payload);
    this.closeSpaceModal();
    await this.bootstrap();
    void this.discoverLocalSpaces(true);
    if (shouldSelectInIntake) {
      this.selectIntakeProjectSpace(res.space.id);
    }
    this.showToast(`已保存项目空间 ${res.space.name}`);
    return res.space;
  }

  async removeSpace(spaceId: string): Promise<boolean> {
    try {
      await apiDeleteSpace(spaceId);
      const nextSpaces = { ...this.state.spaces };
      delete nextSpaces[spaceId];
      const remainingProjects = getProjectSpaces(nextSpaces);
      const patch: Partial<KilnStoreState> = {};
      if (this.state.spaceFilter === spaceId) {
        patch.spaceFilter = "all";
      }
      if (
        this.state.intakeForm.mode === "project" &&
        this.state.intakeForm.space === spaceId
      ) {
        patch.intakeForm = {
          ...this.state.intakeForm,
          space: remainingProjects[0]?.id ?? "",
          accept_cmd: remainingProjects[0]?.default_accept_cmd ?? "",
        };
      }
      if (Object.keys(patch).length > 0) {
        this.setState(patch);
      }
      await this.bootstrap();
      this.showToast(`已删除项目空间 ${spaceId}`);
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "删除项目空间失败");
      return false;
    }
  }
}

export const StoreContext = createContext<KilnWebStore | null>(null);

export function useKilnStore(): {
  store: KilnWebStore;
  state: KilnStoreState;
} {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useKilnStore must be used inside StoreContext.Provider");
  }
  const [state, setState] = useState<KilnStoreState>(() => store.getState());

  useEffect(() => {
    setState(store.getState());
    return store.subscribe(() => {
      setState(store.getState());
    });
  }, [store]);

  return { store, state };
}
