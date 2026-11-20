import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type {
  DraftCard,
  LedgerEntry,
  LedgerFile,
  LimitsConfig,
  PendingDecision,
  PricingConfig,
  Priority,
  RolesConfig,
  SpaceConfig,
  SseEvent,
  Track,
  WorkspaceMode,
} from "@kiln/protocol/web";
import {
  ApiError,
  cancelTask as apiCancelTask,
  commitDraft as apiCommitDraft,
  deleteDraft as apiDeleteDraft,
  deleteSpace as apiDeleteSpace,
  fetchAgents as apiFetchAgents,
  fetchAuthStatus as apiFetchAuthStatus,
  fetchBootstrap as apiFetchBootstrap,
  fetchDraftChat as apiFetchDraftChat,
  fetchLedgers as apiFetchLedgers,
  fetchTaskChat as apiFetchTaskChat,
  fetchTaskDetail as apiFetchTaskDetail,
  inspectSpacePath as apiInspectSpacePath,
  logoutRemoteDevice as apiLogoutRemoteDevice,
  pairRemoteDevice as apiPairRemoteDevice,
  pauseTask as apiPauseTask,
  restoreHostBackup as apiRestoreHostBackup,
  resumeTask as apiResumeTask,
  sendIntakeChat as apiSendIntakeChat,
  sendResolveChat as apiSendResolveChat,
  setUnauthorizedHandler,
  submitDecision as apiSubmitDecision,
  subscribeSseEvents,
  updatePriority as apiUpdatePriority,
  updateSettings as apiUpdateSettings,
  upsertDraft as apiUpsertDraft,
  upsertSpace as apiUpsertSpace,
} from "../api/client";
import type {
  AgentDescriptorInfo,
  BackendConnectionInfo,
  BootstrapResponse,
  BootstrapTask,
  ChatMessage,
  CommitDraftPayload,
  InspectSpaceResult,
  PairCompleteRequest,
  PublicPairedDevice,
  RawProviderUsageEntry,
  RestoreHostBackupResult,
  SettingsSectionMap,
  SubmitDecisionPayload,
  TaskDetailResponse,
  UpsertSpacePayload,
  UsageSnapshot,
} from "../api/types";

export type MvpView =
  | "board"
  | "detail"
  | "inbox"
  | "intake"
  | "resolve"
  | "usage"
  | "ledger"
  | "settings";

export type SettingsTab = "roles" | "spaces" | "limits" | "pricing" | "remote" | "conn";
export type PeriodFilter = "week" | "month" | "year" | "all";
export type IntakeMode = "project" | "local";
export type AuthMode = "local" | "remote";

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
  end: string;
  accept_cmd: string;
  scope: string;
  depends_on: string;
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
  draftOpen: boolean;
  paletteOpen: boolean;
  toastMessage: string | null;

  bootstrapping: boolean;
  bootstrapLoaded: boolean;
  bootstrapError: string | null;

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

  intakeDraftId: string | null;
  intakeForm: IntakeFormState;
  intakeMessages: ChatMessage[];
  intakeBusy: boolean;

  spaceModalOpen: boolean;
  editingSpaceId: string | null;
  spaceModalSelectInIntake: boolean;

  resolveMessagesByTask: Record<string, ChatMessage[]>;
  resolveBusy: boolean;
}

const VALID_VIEWS = new Set<MvpView>([
  "board",
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
      end: "",
      accept_cmd: "",
      scope: "",
      depends_on: "",
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
    end: "",
    accept_cmd: chosen?.default_accept_cmd ?? "",
    scope: "",
    depends_on: "",
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

export class KilnWebStore {
  private state: KilnStoreState;
  private readonly listeners = new Set<() => void>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private sseCleanup: (() => void) | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private authProbeInFlight: Promise<void> | null = null;

  constructor() {
    const parsed = parseLocationHash();
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
      draftOpen: false,
      paletteOpen: false,
      toastMessage: null,

      bootstrapping: true,
      bootstrapLoaded: false,
      bootstrapError: null,

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

      intakeDraftId: null,
      intakeForm: createDefaultIntakeForm({}),
      intakeMessages: defaultWelcomeIntakeMessages(),
      intakeBusy: false,

      spaceModalOpen: false,
      editingSpaceId: null,
      spaceModalSelectInIntake: false,

      resolveMessagesByTask: {},
      resolveBusy: false,
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
    this.setState({
      authChecked: true,
      authMode: "remote",
      authAuthenticated: false,
      authDevice: null,
      authNotice: notice,
      bootstrapping: false,
      bootstrapLoaded: false,
      bootstrapError: null,
      networkOffline: false,
      retryingConnection: false,
      navOpen: false,
      draftOpen: false,
      paletteOpen: false,
      spaceModalOpen: false,
      tasks: [],
      pendingDecisions: [],
      drafts: [],
      taskDetails: {},
      ledgers: {},
      resolveMessagesByTask: {},
      ratesByTask: {},
      liveTotals: null,
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
        const limits = data.settings?.limits ?? data.limits ?? { ...DEFAULT_LIMITS };
        const pricing = data.settings?.pricing ?? data.pricing ?? { ...DEFAULT_PRICING, models: {} };
        const nextRates = data.liveRates?.rates
          ? { ...this.state.ratesByTask, ...data.liveRates.rates }
          : this.state.ratesByTask;

        const nextSpaces = data.spaces ?? {};
        let nextIntakeForm = this.state.intakeForm;
        if (
          !this.state.intakeDraftId &&
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
          lastConnectedAt: new Date().toISOString(),
          ...(this.state.sseStatus !== "reconnecting"
            ? { networkOffline: false }
            : {}),
          tasks: data.tasks ?? [],
          pendingDecisions: data.pendingDecisions ?? [],
          drafts: data.drafts ?? [],
          spaces: nextSpaces,
          intakeForm: nextIntakeForm,
          roles,
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

    if (event.type === "run.event") {
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
    } else if (view === "settings" && this.state.agents.length === 0) {
      void this.refreshAgents();
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

  setPaletteOpen(paletteOpen: boolean): void {
    this.setState({ paletteOpen });
  }

  clearRestoreResult(): void {
    this.setState({ restoreResult: null });
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

  async resumeTask(taskId: string): Promise<void> {
    try {
      await apiResumeTask(taskId);
      this.showToast("已恢复继续推进");
      await this.bootstrap();
      if (this.state.taskId === taskId) {
        await this.loadTaskDetail(taskId);
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "恢复失败");
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

  updateIntakeForm(patch: Partial<IntakeFormState>): void {
    this.setState({
      intakeForm: { ...this.state.intakeForm, ...patch },
    });
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
      this.setState({
        intakeForm: {
          ...cur,
          mode: "project",
          space: chosen?.id ?? "",
          workspace_mode: "git_worktree",
          track: cur.track || "L2",
          accept_cmd:
            shouldFillAccept && chosen?.default_accept_cmd
              ? chosen.default_accept_cmd
              : cur.accept_cmd,
        },
      });
      return;
    }

    const prevDefault = this.state.spaces[cur.space]?.default_accept_cmd ?? "";
    this.setState({
      intakeForm: {
        ...cur,
        mode: "local",
        space: "local",
        workspace_mode:
          cur.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir",
        ...(cur.accept_cmd === prevDefault ? { accept_cmd: "" } : {}),
      },
    });
  }

  selectIntakeProjectSpace(spaceId: string): void {
    const cur = this.state.intakeForm;
    const prevDefault = this.state.spaces[cur.space]?.default_accept_cmd ?? "";
    const nextSpace = this.state.spaces[spaceId];
    const shouldUpdateAccept =
      cur.accept_cmd.trim() === "" || cur.accept_cmd === prevDefault;
    this.setState({
      intakeForm: {
        ...cur,
        mode: "project",
        space: spaceId,
        workspace_mode: "git_worktree",
        accept_cmd: shouldUpdateAccept
          ? (nextSpace?.default_accept_cmd ?? "")
          : cur.accept_cmd,
      },
    });
  }

  startNewIntake(): void {
    const preferred =
      this.state.spaceFilter !== "all" ? this.state.spaceFilter : undefined;
    this.setState({
      intakeDraftId: null,
      intakeForm: createDefaultIntakeForm(this.state.spaces, preferred),
      intakeMessages: defaultWelcomeIntakeMessages(),
      draftOpen: false,
    });
  }

  async deleteIntakeDraft(draftId: string): Promise<void> {
    try {
      await apiDeleteDraft(draftId);
      if (this.state.intakeDraftId === draftId) {
        this.startNewIntake();
      }
      await this.bootstrap();
      this.showToast("已删除草稿");
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "删除草稿失败");
    }
  }

  async loadDraftIntoIntake(draft: DraftCard): Promise<void> {
    const isLocal = draft.space === "local";
    const mode: IntakeMode = isLocal ? "local" : "project";
    const workspaceMode: Exclude<WorkspaceMode, "external_only"> = isLocal
      ? (draft.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir")
      : "git_worktree";
    this.setState({
      intakeDraftId: draft.id,
      intakeForm: {
        mode,
        title: draft.title,
        priority: draft.priority,
        space: draft.space,
        track: draft.track === "L3" ? "L2" : draft.track,
        workspace_mode: workspaceMode,
        end: draft.contract.end ?? "",
        accept_cmd: draft.contract.accept_cmd ?? "",
        scope: (draft.contract.scope ?? []).join("\n"),
        depends_on: draft.depends_on.join(", "),
      },
    });
    const msgs = await apiFetchDraftChat(draft.id).catch(() => null);
    this.setState({
      intakeMessages:
        msgs && msgs.length > 0 ? msgs : defaultWelcomeIntakeMessages(),
    });
  }

  private buildDraftContractFromForm(): {
    depends_on: string[];
    scopeList: string[];
  } {
    const f = this.state.intakeForm;
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
      const res = await apiUpsertDraft({
        ...(this.state.intakeDraftId ? { id: this.state.intakeDraftId } : {}),
        title: f.title.trim(),
        space: effectiveSpace,
        priority: (f.priority || "P2") as Priority,
        track: (f.track || "L2") as Track,
        workspace_mode: effectiveWorkspaceMode,
        depends_on,
        contract: {
          goal: f.title.trim(),
          ...(f.end.trim() ? { end: f.end.trim() } : {}),
          ...(f.accept_cmd.trim() ? { accept_cmd: f.accept_cmd.trim() } : {}),
          ...(scopeList.length > 0 ? { scope: scopeList } : {}),
        },
      });
      this.setState({ intakeDraftId: res.draft.id, intakeBusy: false });
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
      let draftId = this.state.intakeDraftId;
      if (!draftId) {
        const saved = await apiUpsertDraft({
          title: f.title.trim(),
          space: effectiveSpace,
          priority: f.priority,
          track: f.track,
          workspace_mode: effectiveWorkspaceMode,
          depends_on,
          contract: {
            goal: f.title.trim(),
            end: f.end.trim(),
            accept_cmd: f.accept_cmd.trim(),
            scope: scopeList,
          },
        });
        draftId = saved.draft.id;
      }

      const taskId = this.generateNextTaskId();
      const deliverMode =
        effectiveWorkspaceMode === "git_worktree" ? "merge_main" : "manual";

      const payload: CommitDraftPayload = {
        id: taskId,
        title: f.title.trim(),
        space: effectiveSpace,
        priority: f.priority,
        track: f.track,
        workspace_mode: effectiveWorkspaceMode,
        depends_on,
        contract: {
          goal: f.title.trim(),
          end: f.end.trim(),
          accept_cmd: f.accept_cmd.trim(),
          accept_files_hash: "pending",
          scope: scopeList,
          deliver: { mode: deliverMode, cmd: null },
          human_accept: false,
          external_actions: "ask",
        },
        brief_markdown: `# ${f.title.trim()}\n\n- 目标：${f.title.trim()}\n- 交付终点：${f.end.trim()}\n- 验收命令：\`${f.accept_cmd.trim()}\`\n- 可改范围：${scopeList.join(", ")}\n`,
      };

      const committed = await apiCommitDraft(draftId, payload);
      const preferred =
        this.state.spaceFilter !== "all" ? this.state.spaceFilter : undefined;
      this.setState({
        intakeBusy: false,
        intakeDraftId: null,
        intakeForm: createDefaultIntakeForm(this.state.spaces, preferred),
        intakeMessages: defaultWelcomeIntakeMessages(),
        draftOpen: false,
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

  async sendIntakeChat(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.state.intakeBusy) return;

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
    this.setState({
      intakeMessages: [...this.state.intakeMessages, userMsg],
      intakeBusy: true,
    });

    try {
      const { depends_on, scopeList } = this.buildDraftContractFromForm();
      const contractPatch: Partial<{
        goal: string;
        end: string;
        accept_cmd: string;
        scope: string[];
      }> = {};
      if (f.title.trim()) contractPatch.goal = f.title.trim();
      if (f.end.trim()) contractPatch.end = f.end.trim();
      if (f.accept_cmd.trim()) contractPatch.accept_cmd = f.accept_cmd.trim();
      if (scopeList.length > 0) contractPatch.scope = scopeList;

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
        ...(Object.keys(contractPatch).length > 0 ? { contract: contractPatch } : {}),
      });
      const draftId = synced.draft.id;
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
        nextForm.workspace_mode = resIsLocal
          ? (res.draft.workspace_mode === "host_scoped" ? "host_scoped" : "scratch_dir")
          : "git_worktree";
        if (res.draft.contract.end) nextForm.end = res.draft.contract.end;
        if (res.draft.contract.accept_cmd) {
          nextForm.accept_cmd = res.draft.contract.accept_cmd;
        }
        if (res.draft.contract.scope?.length) {
          nextForm.scope = res.draft.contract.scope.join("\n");
        }
        if (res.draft.depends_on.length) {
          nextForm.depends_on = res.draft.depends_on.join(", ");
        }
      }
      this.setState({
        intakeMessages: nextMsgs,
        intakeForm: nextForm,
        intakeBusy: false,
      });
      void this.bootstrap();
    } catch (err) {
      this.setState({
        intakeBusy: false,
        intakeMessages: [
          ...this.state.intakeMessages,
          {
            who: "agent",
            name: "系统提示",
            text:
              err instanceof Error
                ? `对话请求未完成（${err.message}），你也可以直接在右侧填写立项字段并提交。`
                : "对话暂不可用，请直接在右侧填写立项字段。",
          },
        ],
      });
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

  updatePricingLocal(modelName: string, field: "in" | "cached" | "out", val: number): void {
    if (!Number.isFinite(val) || val < 0) return;
    const existing = this.state.pricing.models[modelName] ?? {
      in: 0,
      cached: 0,
      out: 0,
    };
    this.setState({
      pricing: {
        ...this.state.pricing,
        models: {
          ...this.state.pricing.models,
          [modelName]: {
            ...existing,
            [field]: val,
          },
        },
      },
    });
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
      }
      this.showToast(`已保存 config/${section}.yaml`);
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : "保存设置失败");
      return false;
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

  openAddSpaceModal(selectInIntake = false): void {
    this.setState({
      spaceModalOpen: true,
      editingSpaceId: null,
      spaceModalSelectInIntake: selectInIntake,
    });
  }

  openEditSpaceModal(spaceId: string): void {
    this.setState({
      spaceModalOpen: true,
      editingSpaceId: spaceId,
      spaceModalSelectInIntake: false,
    });
  }

  closeSpaceModal(): void {
    this.setState({
      spaceModalOpen: false,
      editingSpaceId: null,
      spaceModalSelectInIntake: false,
    });
  }

  async inspectSpace(rawPath: string): Promise<InspectSpaceResult> {
    return await apiInspectSpacePath(rawPath);
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
