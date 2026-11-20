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
  cancelTask as apiCancelTask,
  commitDraft as apiCommitDraft,
  fetchAgents as apiFetchAgents,
  fetchBootstrap as apiFetchBootstrap,
  fetchDraftChat as apiFetchDraftChat,
  fetchLedgers as apiFetchLedgers,
  fetchTaskChat as apiFetchTaskChat,
  fetchTaskDetail as apiFetchTaskDetail,
  pauseTask as apiPauseTask,
  restoreHostBackup as apiRestoreHostBackup,
  resumeTask as apiResumeTask,
  sendIntakeChat as apiSendIntakeChat,
  sendResolveChat as apiSendResolveChat,
  submitDecision as apiSubmitDecision,
  subscribeSseEvents,
  updatePriority as apiUpdatePriority,
  updateSettings as apiUpdateSettings,
  upsertDraft as apiUpsertDraft,
} from "../api/client";
import type {
  AgentDescriptorInfo,
  BackendConnectionInfo,
  BootstrapResponse,
  BootstrapTask,
  ChatMessage,
  CommitDraftPayload,
  RawProviderUsageEntry,
  RestoreHostBackupResult,
  SettingsSectionMap,
  SubmitDecisionPayload,
  TaskDetailResponse,
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

export type SettingsTab = "roles" | "limits" | "pricing" | "conn";
export type PeriodFilter = "week" | "month" | "year" | "all";

export interface IntakeFormState {
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

  taskDetails: Record<string, TaskDetailResponse>;
  taskDetailLoading: boolean;
  taskDetailError: string | null;
  restoreResult: RestoreHostBackupResult | null;

  intakeDraftId: string | null;
  intakeForm: IntakeFormState;
  intakeMessages: ChatMessage[];
  intakeBusy: boolean;

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
  "limits",
  "pricing",
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

export function createEmptyIntakeForm(): IntakeFormState {
  return {
    title: "",
    priority: "P2",
    space: "local",
    track: "L2",
    workspace_mode: "git_worktree",
    end: "",
    accept_cmd: "",
    scope: "",
    depends_on: "",
  };
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
} {
  if (typeof window === "undefined") {
    return { view: "board", taskId: null, settingsTab: "roles", hadInvalidRoute: false };
  }
  const raw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!raw) {
    return { view: "board", taskId: null, settingsTab: "roles", hadInvalidRoute: false };
  }
  const params = new URLSearchParams(raw);
  const rawTab = params.get("tab");
  const settingsTab: SettingsTab =
    rawTab && VALID_SETTINGS_TABS.has(rawTab as SettingsTab)
      ? (rawTab as SettingsTab)
      : "roles";

  const taskParam = params.get("task");
  if (taskParam) {
    return { view: "detail", taskId: taskParam, settingsTab, hadInvalidRoute: false };
  }
  const resolveParam = params.get("resolve");
  if (resolveParam) {
    return { view: "resolve", taskId: resolveParam, settingsTab, hadInvalidRoute: false };
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
      };
    }
    return { view: "board", taskId: null, settingsTab, hadInvalidRoute: true };
  }
  return { view: "board", taskId: null, settingsTab, hadInvalidRoute: false };
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

      taskDetails: {},
      taskDetailLoading: false,
      taskDetailError: null,
      restoreResult: null,

      intakeDraftId: null,
      intakeForm: createEmptyIntakeForm(),
      intakeMessages: defaultWelcomeIntakeMessages(),
      intakeBusy: false,

      resolveMessagesByTask: {},
      resolveBusy: false,
    };

    if (parsed.hadInvalidRoute) {
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
    if (!this.state.bootstrapLoaded) return;
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
    void this.bootstrap();
    this.sseCleanup = subscribeSseEvents({
      onEvent: (event) => this.handleSseEvent(event),
      onStatusChange: (sseStatus) => this.setState({ sseStatus }),
    });

    const onHashChange = (): void => {
      const parsed = parseLocationHash();
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
      if (this.sseCleanup) {
        this.sseCleanup();
        this.sseCleanup = null;
      }
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

        this.setState({
          bootstrapping: false,
          bootstrapLoaded: true,
          bootstrapError: null,
          tasks: data.tasks ?? [],
          pendingDecisions: data.pendingDecisions ?? [],
          drafts: data.drafts ?? [],
          spaces: data.spaces ?? {},
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
        this.setState({
          bootstrapping: false,
          bootstrapError: err instanceof Error ? err.message : "加载工作台失败",
        });
      } finally {
        this.refreshInFlight = null;
      }
    })();

    this.refreshInFlight = run;
    await run;
  }

  private handleSseEvent(event: SseEvent): void {
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
    const patch: Partial<KilnStoreState> = {
      view,
      navOpen: false,
      draftOpen: false,
      paletteOpen: false,
      restoreResult: null,
      ...(view !== "detail" && view !== "resolve" ? { taskId: null, selectedRunIdx: null } : {}),
      ...(options?.space !== undefined ? { spaceFilter: options.space } : {}),
      ...(options?.settingsTab !== undefined ? { settingsTab: options.settingsTab } : {}),
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

  applyIntakePreset(
    presetForm: Partial<IntakeFormState>,
    messages: ChatMessage[],
  ): void {
    this.setState({
      intakeForm: { ...this.state.intakeForm, ...presetForm },
      intakeMessages: [...this.state.intakeMessages, ...messages],
    });
  }

  async loadDraftIntoIntake(draft: DraftCard): Promise<void> {
    this.setState({
      intakeDraftId: draft.id,
      intakeForm: {
        title: draft.title,
        priority: draft.priority,
        space: draft.space,
        track: draft.track === "L3" ? "L2" : draft.track,
        workspace_mode:
          draft.workspace_mode === "external_only"
            ? "scratch_dir"
            : draft.workspace_mode,
        end: draft.contract.end ?? "",
        accept_cmd: draft.contract.accept_cmd ?? "",
        scope: (draft.contract.scope ?? []).join("\n"),
        depends_on: draft.depends_on.join(", "),
      },
    });
    const msgs = await apiFetchDraftChat(draft.id).catch(() => null);
    if (msgs && msgs.length > 0) {
      this.setState({ intakeMessages: msgs });
    }
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
    const { depends_on, scopeList } = this.buildDraftContractFromForm();
    this.setState({ intakeBusy: true });
    try {
      const res = await apiUpsertDraft({
        ...(this.state.intakeDraftId ? { id: this.state.intakeDraftId } : {}),
        title: f.title.trim(),
        space: f.space || "local",
        priority: (f.priority || "P2") as Priority,
        track: (f.track || "L2") as Track,
        workspace_mode: (f.workspace_mode || "git_worktree") as WorkspaceMode,
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
    if (
      !f.title.trim() ||
      !f.priority ||
      !f.space ||
      !f.track ||
      !f.workspace_mode ||
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
          space: f.space,
          priority: f.priority,
          track: f.track,
          workspace_mode: f.workspace_mode,
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
        f.workspace_mode === "git_worktree" ? "merge_main" : "manual";

      const payload: CommitDraftPayload = {
        id: taskId,
        title: f.title.trim(),
        space: f.space,
        priority: f.priority,
        track: f.track,
        workspace_mode: f.workspace_mode,
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
      this.setState({
        intakeBusy: false,
        intakeDraftId: null,
        intakeForm: createEmptyIntakeForm(),
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
    const userMsg: ChatMessage = { who: "me", text: trimmed };
    this.setState({
      intakeMessages: [...this.state.intakeMessages, userMsg],
      intakeBusy: true,
    });

    try {
      let draftId = this.state.intakeDraftId;
      if (!draftId) {
        const created = await apiUpsertDraft({
          title: this.state.intakeForm.title.trim() || trimmed.slice(0, 32),
          space: this.state.intakeForm.space || "local",
          priority: (this.state.intakeForm.priority || "P2") as Priority,
          track: (this.state.intakeForm.track || "L2") as Track,
          workspace_mode: (this.state.intakeForm.workspace_mode ||
            "git_worktree") as WorkspaceMode,
        });
        draftId = created.draft.id;
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
        if (res.draft.title) nextForm.title = res.draft.title;
        if (res.draft.priority) nextForm.priority = res.draft.priority;
        if (res.draft.space) nextForm.space = res.draft.space;
        if (res.draft.track && res.draft.track !== "L3") nextForm.track = res.draft.track;
        if (
          res.draft.workspace_mode &&
          res.draft.workspace_mode !== "external_only"
        ) {
          nextForm.workspace_mode = res.draft.workspace_mode;
        }
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
      if (res.pendingDecision) {
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

  async refreshAgents(): Promise<void> {
    try {
      const list = await apiFetchAgents();
      if (list) {
        this.setState({ agents: list });
        this.showToast("已重新读取可用 Agent 与模型列表");
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
