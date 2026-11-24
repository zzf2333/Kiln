import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import {
  CORE_COGNITIVE_ROSTER_IDS,
  DERIVED_ROSTER_INHERITANCE,
  REASONING_EFFORTS,
  ROSTER_TIER_HINTS,
  VERIFIER_CAPABILITIES,
  type ReasoningEffort,
  type RosterConfig,
  type RosterEntry,
  type RosterGroup,
  type RosterModelBinding,
  type RosterPermission,
  type RosterTierHint,
  type StageId,
  type VerifierCapability,
} from "@kiln/protocol/web";
import type { AgentDescriptorInfo, ProviderRuntimeStatus } from "../api/types";
import {
  ArrowUpIcon,
  CheckCircleIcon,
  CloseIcon,
  CpuIcon,
  PlusIcon,
  RefreshIcon,
  ShieldIcon,
  SparkleIcon,
  TrashIcon,
  WarnCircleIcon,
  BoltIcon,
} from "../components/Icons";
import { ProviderAvatar, formatAdapterLabel } from "../components/ProviderAvatar";
import { ViewFrame } from "../components/ViewFrame";
import { fmtUsd } from "../state/format";
import { useKilnStore } from "../state/store";

type RosterFilter = "all" | "core" | "specialist" | "kernel";

const STAGE_LABELS: Record<StageId, string> = {
  intake: "立项",
  research: "调研",
  plan: "方案",
  implement: "实施",
  verify: "独立测试",
  review: "异构审查",
  accept: "验收",
  triage: "异常研判",
  advise: "顾问",
  deliver: "交付",
};

const PERM_META: Record<RosterPermission, { label: string; tone: string }> = {
  read_only: { label: "只读", tone: "ro" },
  read_only_draft: { label: "只读·草稿", tone: "ro" },
  workspace_write: { label: "工作区可写", tone: "rw" },
  host_staged: { label: "沙盒暂存", tone: "host" },
  accept_entry: { label: "只读+验收入口", tone: "accept" },
  kernel_gate: { label: "内核确定性门禁", tone: "kernel" },
};

const CUSTOM_STAGE_OPTIONS: ReadonlyArray<{
  stage: StageId;
  label: string;
  perm: RosterPermission;
}> = [
  { stage: "implement", label: "实施（工作区可写）", perm: "workspace_write" },
  { stage: "research", label: "调研（严格只读）", perm: "read_only" },
  { stage: "plan", label: "方案（严格只读）", perm: "read_only" },
  { stage: "advise", label: "顾问（严格只读）", perm: "read_only" },
  { stage: "review", label: "审查（严格只读）", perm: "read_only" },
  { stage: "accept", label: "验收（只读+真实入口）", perm: "accept_entry" },
];

const TIER_HINT_LABELS: Record<RosterTierHint, string> = {
  economy: "省钱快用",
  standard: "均衡主力",
  flagship: "最高智商",
};

const VERIFIER_CAPABILITY_LABELS: Record<VerifierCapability, string> = {
  cli: "CLI / 产物检查",
  browser: "真实浏览器操作",
  desktop_gui: "桌面 GUI 操控",
};

const BUILTIN_ID_ORDER: readonly string[] = [
  ...CORE_COGNITIVE_ROSTER_IDS,
  "architect",
  "triage",
  "resolver",
  "frontend_ui",
  "debugger",
  "ops_sec",
  "doc_writer",
  "tester",
  "deliverer",
];

function cloneRosterConfig(src: RosterConfig): RosterConfig {
  const nextRoster: Record<string, RosterEntry> = {};
  for (const [id, entry] of Object.entries(src.roster)) {
    nextRoster[id] = {
      ...entry,
      secondary_stages: [...(entry.secondary_stages ?? [])],
      ...(entry.primary ? { primary: { ...entry.primary } } : {}),
      ...(entry.verifier_capabilities
        ? { verifier_capabilities: [...entry.verifier_capabilities] }
        : {}),
      fallbacks: (entry.fallbacks ?? []).map((fb) => ({ ...fb })),
    };
  }
  return {
    schema_version: 2,
    heterogeneous_review: src.heterogeneous_review,
    pm_orchestration: { ...src.pm_orchestration },
    roster: nextRoster,
  };
}

function modelsForProvider(
  providerId: string,
  agents: readonly AgentDescriptorInfo[],
  customModelsByProvider: Map<string, string[]>,
  extraModels: readonly string[] = [],
): string[] {
  const set = new Set<string>();
  const agent = agents.find(
    (a) => a.id === providerId || a.backendId === providerId,
  );
  if (agent?.models) {
    for (const m of agent.models) {
      const id = typeof m === "string" ? m : m.id;
      if (id.trim()) set.add(id.trim());
    }
  }
  for (const cm of customModelsByProvider.get(providerId) ?? []) {
    if (cm.trim()) set.add(cm.trim());
  }
  for (const em of extraModels) {
    if (em.trim()) set.add(em.trim());
  }
  return Array.from(set);
}

export function LineupView() {
  const { store, state } = useKilnStore();
  const {
    roster,
    providerStatuses,
    providersConfig,
    agents,
    authMode,
  } = state;

  const [rosterDraft, setRosterDraft] = useState<RosterConfig>(() =>
    cloneRosterConfig(roster),
  );
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [saveBusy, setSaveBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [selectedId, setSelectedId] = useState<string>("main_dev");
  const [fbAddProvider, setFbAddProvider] = useState<string>("");
  const [fbAddModel, setFbAddModel] = useState<string>("");
  const [customModelDraft, setCustomModelDraft] = useState<string>("");
  const [pendingConfirmFullAccessId, setPendingConfirmFullAccessId] = useState<string | null>(null);
  const [pendingDeleteRoleId, setPendingDeleteRoleId] = useState<string | null>(null);

  // New custom specialist modal state
  const [newRoleOpen, setNewRoleOpen] = useState(false);
  const [newRoleId, setNewRoleId] = useState("");
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleStage, setNewRoleStage] = useState<StageId>("implement");
  const [newRoleTraits, setNewRoleTraits] = useState("");
  const [newRoleProvider, setNewRoleProvider] = useState("");
  const [newRoleModel, setNewRoleModel] = useState("");
  const [newRoleError, setNewRoleError] = useState<string | null>(null);

  useEffect(() => {
    if (dirtyRef.current) return;
    setRosterDraft(cloneRosterConfig(roster));
  }, [roster]);

  const roleIds = Object.keys(rosterDraft.roster).sort((a, b) => {
    const ia = BUILTIN_ID_ORDER.indexOf(a);
    const ib = BUILTIN_ID_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });

  useEffect(() => {
    if (!rosterDraft.roster[selectedId] && roleIds.length > 0) {
      setSelectedId(roleIds[0]!);
    }
  }, [selectedId, roleIds.join(",")]);

  const statusByProvider = new Map<string, ProviderRuntimeStatus>(
    providerStatuses.map((p) => [p.provider_id, p]),
  );
  const disabledProviderIds = new Set(
    (providersConfig?.providers ?? [])
      .filter((p) => !p.enabled)
      .map((p) => p.id),
  );
  const isProviderVisible = (providerId: string): boolean => {
    if (disabledProviderIds.has(providerId)) return false;
    const st = statusByProvider.get(providerId)?.status;
    return st !== "unavailable";
  };
  const visibleProviders = providerStatuses.filter((p) =>
    isProviderVisible(p.provider_id),
  );

  const customModelsByProvider = new Map<string, string[]>();
  const quotaBudgetByProvider = new Map<string, number>();
  if (providersConfig) {
    for (const p of providersConfig.providers) {
      customModelsByProvider.set(p.id, p.custom_models ?? []);
      if (p.quota?.soft_daily_usd) {
        quotaBudgetByProvider.set(p.id, p.quota.soft_daily_usd);
      }
    }
  }

  const providerChoices = Array.from(
    new Map<string, { id: string; label: string; status: ProviderRuntimeStatus["status"] }>([
      ...visibleProviders.map((p): [string, { id: string; label: string; status: ProviderRuntimeStatus["status"] }] => [
        p.provider_id,
        { id: p.provider_id, label: p.label, status: p.status },
      ]),
      ...agents
        .filter((a) => isProviderVisible(a.id))
        .map((a): [string, { id: string; label: string; status: ProviderRuntimeStatus["status"] }] => [
          a.id,
          {
            id: a.id,
            label: a.label ?? a.id,
            status: statusByProvider.get(a.id)?.status ?? "ready",
          },
        ]),
    ]).values(),
  );

  const defaultProviderId =
    providerChoices.find((p) => p.status === "ready")?.id ??
    providerChoices[0]?.id ??
    "codex";

  const pickDefaultBinding = (preferredProvider?: string): RosterModelBinding => {
    const pid = preferredProvider || defaultProviderId;
    const models = modelsForProvider(pid, agents, customModelsByProvider);
    return {
      provider: pid,
      model: models[0] ?? "default",
      effort: "medium",
    };
  };

  const mutateRoster = (updater: (draft: RosterConfig) => RosterConfig): void => {
    setRosterDraft((prev) => updater(prev));
    setDirty(true);
  };

  const updateRole = (roleId: string, patch: Partial<RosterEntry>): void => {
    mutateRoster((prev) => {
      const existing = prev.roster[roleId];
      if (!existing) return prev;
      return {
        ...prev,
        roster: {
          ...prev.roster,
          [roleId]: { ...existing, ...patch },
        },
      };
    });
  };

  const toggleRoleEnabled = (roleId: string): void => {
    const existing = rosterDraft.roster[roleId];
    if (!existing) return;
    const nextEnabled = !existing.enabled;
    const patch: Partial<RosterEntry> = { enabled: nextEnabled };
    if (
      nextEnabled &&
      (existing.mode === "agent" || existing.mode === "on_conflict") &&
      !existing.primary
    ) {
      patch.primary = pickDefaultBinding();
    }
    updateRole(roleId, patch);
  };

  const resolveDerivedAncestor = (roleId: string): string | null => {
    const chain = DERIVED_ROSTER_INHERITANCE[roleId];
    if (!chain) return null;
    for (const ancId of chain) {
      const anc = rosterDraft.roster[ancId];
      if (anc?.enabled && anc.mode === "agent" && anc.primary) {
        return ancId;
      }
    }
    return null;
  };

  const resolveBindingStatus = (
    _roleId: string,
    entry: RosterEntry,
  ): {
    effective: RosterModelBinding | null;
    isFallback: boolean;
    fallbackIdx: number;
    heteroSwitched: boolean;
    clash: boolean;
    warning?: string;
  } => {
    if (entry.mode === "kernel" || !entry.primary) {
      return {
        effective: null,
        isFallback: false,
        fallbackIdx: -1,
        heteroSwitched: false,
        clash: false,
      };
    }

    const avoidStages: StageId[] = entry.avoid_same_as
      ? Array.isArray(entry.avoid_same_as)
        ? entry.avoid_same_as
        : [entry.avoid_same_as]
      : [];
    const impl = rosterDraft.roster.main_dev?.primary;
    const planEntry = rosterDraft.roster.architect;
    const planAncId = !planEntry?.enabled ? resolveDerivedAncestor("architect") : null;
    const planBinding = planEntry?.enabled
      ? planEntry.primary
      : planAncId
        ? rosterDraft.roster[planAncId]?.primary
        : undefined;

    const avoidImpl = rosterDraft.heterogeneous_review && avoidStages.includes("implement") && Boolean(impl);
    const avoidPlan = rosterDraft.heterogeneous_review && avoidStages.includes("plan") && Boolean(planBinding);

    const sameAsImpl = (b: RosterModelBinding): boolean =>
      Boolean(avoidImpl && impl && b.provider === impl.provider && b.model === impl.model);
    const sameAsPlan = (b: RosterModelBinding): boolean =>
      Boolean(
        avoidPlan &&
          planBinding &&
          b.provider === planBinding.provider &&
          b.model === planBinding.model,
      );

    const isUnavailable = (b: RosterModelBinding): boolean => {
      const st = statusByProvider.get(b.provider)?.status;
      return st === "cooldown" || st === "unavailable" || st === "auth_required";
    };

    const primaryBlocked = isUnavailable(entry.primary);
    const primaryClashesImpl = sameAsImpl(entry.primary);
    const primaryClashesPlan = sameAsPlan(entry.primary);

    if (!primaryBlocked && !primaryClashesImpl && !primaryClashesPlan) {
      return {
        effective: entry.primary,
        isFallback: false,
        fallbackIdx: -1,
        heteroSwitched: false,
        clash: false,
      };
    }

    for (let i = 0; i < entry.fallbacks.length; i++) {
      const fb = entry.fallbacks[i]!;
      if (!isUnavailable(fb) && !sameAsImpl(fb) && !sameAsPlan(fb)) {
        return {
          effective: fb,
          isFallback: true,
          fallbackIdx: i,
          heteroSwitched: primaryClashesImpl || primaryClashesPlan,
          clash: false,
          warning:
            primaryClashesImpl || primaryClashesPlan
              ? `主模型与上游撞车，派发时自动切到异构备选 #${i + 1} (${fb.provider} / ${fb.model})`
              : `主订阅当前不可用，备选 #${i + 1} (${fb.provider} / ${fb.model}) 将自动接棒`,
        };
      }
    }

    if (primaryClashesImpl) {
      for (let i = 0; i < entry.fallbacks.length; i++) {
        const fb = entry.fallbacks[i]!;
        if (!isUnavailable(fb) && !sameAsImpl(fb)) {
          return {
            effective: fb,
            isFallback: true,
            fallbackIdx: i,
            heteroSwitched: true,
            clash: false,
            warning: `仅单重异构：备选 #${i + 1} 已避开实施模型，但仍与方案模型相同`,
          };
        }
      }
      return {
        effective: entry.primary,
        isFallback: false,
        fallbackIdx: -1,
        heteroSwitched: false,
        clash: true,
        warning: `${entry.name}与主力开发同模型 (${entry.primary.provider} / ${entry.primary.model})，请更换模型或添加不同家族备选`,
      };
    }

    if (primaryClashesPlan && !primaryBlocked) {
      return {
        effective: entry.primary,
        isFallback: false,
        fallbackIdx: -1,
        heteroSwitched: false,
        clash: false,
        warning: `仅单重异构：已避开实施模型，但与方案模型同款 (${entry.primary.provider} / ${entry.primary.model})`,
      };
    }

    return {
      effective: entry.primary,
      isFallback: false,
      fallbackIdx: -1,
      heteroSwitched: false,
      clash: false,
      warning: `主订阅 ${entry.primary.provider} 当前${statusByProvider.get(entry.primary.provider)?.status === "cooldown" ? "处于 429 冷却" : "不可用"}，建议添加可用备选`,
    };
  };

  const selectedEntry = rosterDraft.roster[selectedId];
  const selectedResolved = selectedEntry
    ? resolveBindingStatus(selectedId, selectedEntry)
    : null;

  const mainDevEntry = rosterDraft.roster.main_dev;
  const reviewerEntry = rosterDraft.roster.reviewer;
  const revResolved = reviewerEntry
    ? resolveBindingStatus("reviewer", reviewerEntry)
    : null;

  const readyCount = visibleProviders.filter((p) => p.status === "ready").length;
  const enabledCount = roleIds.filter((id) => rosterDraft.roster[id]?.enabled).length;

  const groups: ReadonlyArray<{
    key: Exclude<RosterFilter, "all">;
    matches: ReadonlySet<RosterGroup>;
    title: string;
    hint: string;
  }> = [
    {
      key: "core",
      matches: new Set<RosterGroup>(["core"]),
      title: "核心推进",
      hint: "日常研发主链路",
    },
    {
      key: "specialist",
      matches: new Set<RosterGroup>(["specialist", "custom"]),
      title: "专长候选",
      hint: "平时待命，命中特性才点将",
    },
    {
      key: "kernel",
      matches: new Set<RosterGroup>(["kernel"]),
      title: "内核默认位",
      hint: "默认 0 Token 确定性内核兜底，可切为 Agent",
    },
  ];

  const handleSave = async (): Promise<void> => {
    if (saveBusy) return;
    setSaveBusy(true);
    try {
      const ok = await store.saveSettingsSection("roster", rosterDraft);
      if (ok) {
        setDirty(false);
      }
    } finally {
      setSaveBusy(false);
    }
  };

  const handleRefresh = async (): Promise<void> => {
    if (refreshBusy) return;
    setRefreshBusy(true);
    try {
      await Promise.all([
        store.refreshProviders(),
        store.refreshAgents(true),
        ...(authMode === "local" ? [store.refreshProvidersConfig()] : []),
      ]);
    } finally {
      setRefreshBusy(false);
    }
  };

  const openNewRole = (): void => {
    const prov = defaultProviderId;
    const models = modelsForProvider(prov, agents, customModelsByProvider);
    setNewRoleId("");
    setNewRoleName("");
    setNewRoleStage("implement");
    setNewRoleTraits("");
    setNewRoleProvider(prov);
    setNewRoleModel(models[0] ?? "default");
    setNewRoleError(null);
    setNewRoleOpen(true);
  };

  const handleCreateCustomRole = (): void => {
    const id = newRoleId.trim();
    const name = newRoleName.trim();
    const traits = newRoleTraits.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) {
      setNewRoleError("角色 ID 需为小写字母、数字、_ 或 -（1~48 位）");
      return;
    }
    if (rosterDraft.roster[id]) {
      setNewRoleError(`角色 ID "${id}" 已存在`);
      return;
    }
    if (!name) {
      setNewRoleError("请填写角色名称");
      return;
    }
    if (!traits) {
      setNewRoleError("请填写能力特性（PM 将据此点将）");
      return;
    }
    const stageMeta =
      CUSTOM_STAGE_OPTIONS.find((o) => o.stage === newRoleStage) ??
      CUSTOM_STAGE_OPTIONS[0]!;
    const prov = newRoleProvider || defaultProviderId;
    const model = newRoleModel.trim() || "default";

    const nextEntry: RosterEntry = {
      group: "specialist",
      enabled: true,
      name,
      stage: stageMeta.stage,
      secondary_stages: [],
      perm: stageMeta.perm,
      traits,
      mode: "agent",
      primary: { provider: prov, model, effort: "medium" },
      fallbacks: [],
      allow_full_access_fallback: false,
      builtin: false,
    };
    mutateRoster((prev) => ({
      ...prev,
      roster: {
        ...prev.roster,
        [id]: nextEntry,
      },
    }));
    setSelectedId(id);
    setNewRoleOpen(false);
    store.showToast(`已添加专长角色「${name}」，记得点击右上角保存阵容`);
  };

  const renderPool = () => {
    if (visibleProviders.length === 0) {
      return (
        <div className="empty" style={{ padding: "16px 0" }}>
          当前没有可用的本机订阅 Provider，请在「设置 → Providers 订阅底座」检查本机 CLI。
        </div>
      );
    }

    return (
      <div className="pool">
        {visibleProviders.map((p) => {
          const isCooldown = p.status === "cooldown";
          const isDown = p.status === "unavailable" || p.status === "auth_required";
          const softBudget = quotaBudgetByProvider.get(p.provider_id);
          const localCost = p.local_window_cost_usd ?? 0;

          let ratio = 0;
          let barCls = "acc";
          let leftLabel = "";
          let rightLabel = "";

          if (isCooldown) {
            ratio = 1;
            barCls = "bad";
            leftLabel = p.cooldown_until ? `429 冷却至 ${p.cooldown_until}` : "429 冷却中";
            rightLabel = "备选接棒";
          } else if (isDown) {
            ratio = 0;
            leftLabel = p.status === "auth_required" ? "需登录认证" : "未就绪";
            rightLabel = p.detail ?? "待检测";
          } else if (p.native_quota) {
            ratio = Math.max(0, Math.min(1, p.native_quota.used_percent / 100));
            barCls = ratio >= 0.85 ? "bad" : ratio >= 0.6 ? "warn" : "acc";
            leftLabel = `官方窗口 ${Math.round(p.native_quota.used_percent)}%`;
            rightLabel = p.native_quota.resets_at
              ? `${p.native_quota.resets_at} 重置`
              : p.native_quota.plan_type ?? "官方配额";
          } else if (softBudget && softBudget > 0) {
            ratio = Math.min(1, localCost / softBudget);
            barCls = ratio >= 0.85 ? "bad" : ratio >= 0.6 ? "warn" : "acc";
            leftLabel = `今日折算 ${fmtUsd(localCost)}`;
            rightLabel = `/ ${fmtUsd(softBudget)} 软预算`;
          } else {
            ratio = localCost > 0 ? 0.12 : 0;
            leftLabel = `今日折算 ${fmtUsd(localCost)}`;
            rightLabel = "无官方余额接口";
          }

          return (
            <div
              key={p.provider_id}
              className={`pool-tile ${isCooldown ? "limited" : ""} ${isDown ? "is-down" : ""}`}
              data-provider-tile={p.provider_id}
            >
              <div className="pool-top">
                <ProviderAvatar providerId={p.provider_id} large />
                <div>
                  <b>{p.label}</b>
                  <small>
                    {formatAdapterLabel(p.adapter)}
                    {p.version ? ` · v${p.version}` : ""}
                  </small>
                </div>
              </div>
              <div className="meter">
                <i className={barCls} style={{ width: `${Math.round(ratio * 100)}%` }} />
              </div>
              <div className="pool-meta">
                <span>{leftLabel}</span>
                <span>{rightLabel}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderInspector = () => {
    if (!selectedEntry) {
      return (
        <aside className="inspector" aria-label="角色详情">
          <div className="insp-sec">
            <p className="muted">从左侧阵容中选择一个角色查看或编辑。</p>
          </div>
        </aside>
      );
    }

    const permInfo = PERM_META[selectedEntry.perm];
    const isKernelMode = selectedEntry.mode === "kernel";
    const canToggleKernelMode =
      selectedEntry.group === "kernel" ||
      selectedEntry.stage === "verify" ||
      selectedEntry.stage === "deliver";

    const primaryProvider = selectedEntry.primary?.provider ?? defaultProviderId;
    const primaryModel = selectedEntry.primary?.model ?? "";
    const primaryModels = modelsForProvider(
      primaryProvider,
      agents,
      customModelsByProvider,
      primaryModel ? [primaryModel] : [],
    );

    const activeFbProvider =
      fbAddProvider ||
      providerChoices.find((p) => p.status === "ready" && p.id !== primaryProvider)?.id ||
      defaultProviderId;
    const fbModels = modelsForProvider(activeFbProvider, agents, customModelsByProvider);
    const activeFbModel =
      fbAddModel && fbModels.includes(fbAddModel) ? fbAddModel : (fbModels[0] ?? "");

    const moveFallback = (idx: number, dir: -1 | 1): void => {
      const target = idx + dir;
      const list = [...selectedEntry.fallbacks];
      if (target < 0 || target >= list.length) return;
      const [item] = list.splice(idx, 1);
      list.splice(target, 0, item!);
      updateRole(selectedId, { fallbacks: list });
    };

    const removeFallback = (idx: number): void => {
      const list = selectedEntry.fallbacks.filter((_, i) => i !== idx);
      updateRole(selectedId, { fallbacks: list });
    };

    const addFallback = (): void => {
      if (!activeFbProvider || !activeFbModel) return;
      const dup = selectedEntry.fallbacks.some(
        (fb) => fb.provider === activeFbProvider && fb.model === activeFbModel,
      );
      if (dup) {
        store.showToast("该备选模型已在接棒顺序中");
        return;
      }
      updateRole(selectedId, {
        fallbacks: [
          ...selectedEntry.fallbacks,
          { provider: activeFbProvider, model: activeFbModel, effort: "medium" },
        ],
      });
    };

    return (
      <aside className="inspector" aria-label="角色详情">
        <div className="insp-sec">
          <div className="role-head">
            <ProviderAvatar
              providerId={isKernelMode ? "kernel" : primaryProvider}
              large
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="muted" style={{ fontSize: "11.5px", marginBottom: "2px" }}>
                {STAGE_LABELS[selectedEntry.stage]} ·{" "}
                <span className="mono">{selectedId}</span>
              </div>
              <input
                className="role-name-in"
                aria-label="角色名称"
                value={selectedEntry.name}
                onChange={(e) =>
                  updateRole(selectedId, {
                    name: (e.currentTarget as HTMLInputElement).value || selectedEntry.name,
                  })
                }
              />
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <span
              className={`perm perm-${permInfo.tone}`}
              title="内核硬锁权限，UI 不可放宽"
              data-role-perm={selectedEntry.perm}
            >
              {permInfo.label}
            </span>
            {!selectedEntry.builtin ? <span className="chip">自定义</span> : null}
            <span className="sp" />
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "12px",
                color: "var(--t2)",
              }}
            >
              <span>待命启用</span>
              <span className="switch">
                <input
                  type="checkbox"
                  aria-label="待命启用"
                  checked={selectedEntry.enabled}
                  onChange={() => toggleRoleEnabled(selectedId)}
                />
                <span />
              </span>
            </label>
          </div>

          {!selectedEntry.enabled ? (
            <div className="note">
              <WarnCircleIcon />
              <span>
                {(() => {
                  const ancId = resolveDerivedAncestor(selectedId);
                  if (ancId && rosterDraft.roster[ancId]) {
                    return `未单独覆写：派发时自动继承「${rosterDraft.roster[ancId]!.name}」的模型绑定。`;
                  }
                  return "已停用，PM 排兵时不会点将此角色。";
                })()}
              </span>
            </div>
          ) : selectedResolved?.warning ? (
            <div className={`note ${selectedResolved.clash ? "note-bad" : "note-ask"}`}>
              <WarnCircleIcon />
              <span>{selectedResolved.warning}</span>
            </div>
          ) : null}
        </div>

        <div className="insp-sec">
          <div className="insp-h">
            <SparkleIcon />
            <span>能力特性</span>
            <span className="sp" />
            <span className="muted" style={{ fontWeight: 400 }}>
              PM 按这段文字点将
            </span>
          </div>
          <textarea
            className="role-trait-in"
            aria-label="能力特性"
            value={selectedEntry.traits}
            placeholder="写清专长、成本与适合承担的任务类型"
            onChange={(e) =>
              updateRole(selectedId, {
                traits: (e.currentTarget as HTMLTextAreaElement).value,
              })
            }
          />
          <div className="primary-grid" style={{ marginTop: "8px" }}>
            <label className="modal-field" style={{ gap: "4px" }}>
              <span style={{ fontSize: "11.5px" }} className="muted">模型档位定位</span>
              <select
                className="select select-sm"
                aria-label="模型档位定位"
                value={selectedEntry.tier_hint ?? ""}
                onChange={(e) => {
                  const val = (e.currentTarget as HTMLSelectElement).value;
                  if (val === "") {
                    mutateRoster((prev) => {
                      const cur = prev.roster[selectedId];
                      if (!cur) return prev;
                      const { tier_hint: _dropped, ...rest } = cur;
                      return { ...prev, roster: { ...prev.roster, [selectedId]: rest } };
                    });
                  } else {
                    updateRole(selectedId, { tier_hint: val as RosterTierHint });
                  }
                }}
              >
                <option value="">未标注</option>
                {ROSTER_TIER_HINTS.map((t) => (
                  <option key={t} value={t}>
                    {TIER_HINT_LABELS[t]} ({t})
                  </option>
                ))}
              </select>
            </label>

            {selectedEntry.stage === "implement" ? (
              <label className="modal-field" style={{ gap: "4px" }}>
                <span style={{ fontSize: "11.5px" }} className="muted">失败自动升档目标</span>
                <select
                  className="select select-sm"
                  aria-label="失败自动升档目标"
                  value={selectedEntry.escalation_target ?? ""}
                  onChange={(e) => {
                    const val = (e.currentTarget as HTMLSelectElement).value;
                    if (!val) {
                      mutateRoster((prev) => {
                        const cur = prev.roster[selectedId];
                        if (!cur) return prev;
                        const { escalation_target: _dropped, ...rest } = cur;
                        return { ...prev, roster: { ...prev.roster, [selectedId]: rest } };
                      });
                    } else {
                      updateRole(selectedId, { escalation_target: val });
                    }
                  }}
                >
                  <option value="">不自动升档</option>
                  {roleIds
                    .filter((rid) => rid !== selectedId && rosterDraft.roster[rid]?.stage === "implement")
                    .map((rid) => (
                      <option key={rid} value={rid}>
                        {rosterDraft.roster[rid]!.name} ({rid})
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </div>
          <textarea
            className="role-trait-in"
            style={{ marginTop: "8px", minHeight: "52px" }}
            aria-label="槽位专属指令"
            value={selectedEntry.custom_instructions ?? ""}
            placeholder="可选：注入该槽位专属领域提示（不微操 CLI 内部工具，留空则不额外注入）"
            onChange={(e) => {
              const val = (e.currentTarget as HTMLTextAreaElement).value;
              if (!val.trim()) {
                mutateRoster((prev) => {
                  const cur = prev.roster[selectedId];
                  if (!cur) return prev;
                  const { custom_instructions: _dropped, ...rest } = cur;
                  return { ...prev, roster: { ...prev.roster, [selectedId]: rest } };
                });
              } else {
                updateRole(selectedId, { custom_instructions: val });
              }
            }}
          />
        </div>

        {canToggleKernelMode ? (
          <div className="insp-sec">
            <div className="insp-h">
              <BoltIcon />
              <span>执行方式</span>
              <span className="sp" />
              <div className="seg" role="group" aria-label="执行方式">
                <button
                  type="button"
                  className={isKernelMode ? "on" : ""}
                  onClick={() => updateRole(selectedId, { mode: "kernel" })}
                >
                  内核
                </button>
                {selectedEntry.stage === "deliver" ? (
                  <button
                    type="button"
                    className={selectedEntry.mode === "on_conflict" ? "on" : ""}
                    onClick={() =>
                      updateRole(selectedId, {
                        mode: "on_conflict",
                        ...(selectedEntry.primary
                          ? {}
                          : { primary: pickDefaultBinding() }),
                      })
                    }
                  >
                    冲突按需
                  </button>
                ) : null}
                <button
                  type="button"
                  className={selectedEntry.mode === "agent" ? "on" : ""}
                  onClick={() =>
                    updateRole(selectedId, {
                      mode: "agent",
                      ...(selectedEntry.primary
                        ? {}
                        : { primary: pickDefaultBinding() }),
                    })
                  }
                >
                  Agent
                </button>
              </div>
            </div>
            {isKernelMode ? (
              <div className="kernel-box">
                当前由确定性内核直接执行（0 Token），不调用订阅模型；若需 Agent 介入或复杂冲突处理，可切换为{selectedEntry.stage === "deliver" ? "「冲突按需」或" : ""} Agent 模式。
              </div>
            ) : selectedEntry.mode === "on_conflict" ? (
              <div className="kernel-box">
                平时仍由内核 0 Token 自动合并主分支；仅当 merge_main 遇到合并冲突时唤起绑定模型在隔离工作树解冲突，并强制重过确定性 verify 门禁。
              </div>
            ) : null}
          </div>
        ) : null}

        {selectedEntry.stage === "accept" ? (
          <div className="insp-sec">
            <div className="insp-h">
              <ShieldIcon />
              <span>验收能力声明</span>
            </div>
            <div className="verifier-cap-row" role="group" aria-label="验收能力声明">
              {VERIFIER_CAPABILITIES.map((cap) => {
                const declared = selectedEntry.verifier_capabilities ?? ["cli"];
                const active = declared.includes(cap);
                return (
                  <button
                    key={cap}
                    type="button"
                    aria-pressed={active}
                    className={`verifier-cap-btn ${active ? "on" : ""}`}
                    onClick={() => {
                      const next = active
                        ? declared.filter((c) => c !== cap)
                        : [...declared, cap];
                      if (next.length === 0) return;
                      updateRole(selectedId, { verifier_capabilities: next });
                    }}
                  >
                    {VERIFIER_CAPABILITY_LABELS[cap]}
                  </button>
                );
              })}
            </div>
            <p className="muted" style={{ fontSize: "11.5px", marginTop: "6px" }}>
              仅声明你为此槽位绑定的 Agent 自身具备的能力，用于调度前防配错（Kiln 不内置浏览器驱动）。
            </p>
          </div>
        ) : null}

        {!isKernelMode ? (
          <>
            <div className="insp-sec">
              <div className="insp-h">
                <CpuIcon />
                <span>主订阅</span>
              </div>
              <div className="primary-grid">
                <select
                  className="select select-sm"
                  aria-label="主订阅 Provider"
                  value={primaryProvider}
                  onChange={(e) => {
                    const nextProv = (e.currentTarget as HTMLSelectElement).value;
                    const nextModels = modelsForProvider(
                      nextProv,
                      agents,
                      customModelsByProvider,
                    );
                    updateRole(selectedId, {
                      primary: {
                        provider: nextProv,
                        model: nextModels[0] ?? "default",
                        effort: selectedEntry.primary?.effort ?? "medium",
                      },
                    });
                  }}
                >
                  {providerChoices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                  {!providerChoices.some((p) => p.id === primaryProvider) ? (
                    <option value={primaryProvider}>{primaryProvider}（不可用）</option>
                  ) : null}
                </select>

                <select
                  className="select select-sm"
                  aria-label="推理档位"
                  value={selectedEntry.primary?.effort ?? "medium"}
                  onChange={(e) =>
                    updateRole(selectedId, {
                      primary: {
                        provider: primaryProvider,
                        model: primaryModel || primaryModels[0] || "default",
                        effort: (e.currentTarget as HTMLSelectElement)
                          .value as ReasoningEffort,
                      },
                    })
                  }
                >
                  {REASONING_EFFORTS.map((eff) => (
                    <option key={eff} value={eff}>
                      {eff}
                    </option>
                  ))}
                </select>

                <select
                  className="select select-sm mono"
                  style={{ gridColumn: "1 / -1" }}
                  aria-label="主模型"
                  value={primaryModel}
                  onChange={(e) =>
                    updateRole(selectedId, {
                      primary: {
                        provider: primaryProvider,
                        model: (e.currentTarget as HTMLSelectElement).value,
                        effort: selectedEntry.primary?.effort ?? "medium",
                      },
                    })
                  }
                >
                  {primaryModels.length === 0 ? (
                    <option value={primaryModel || "default"}>
                      {primaryModel || "default"}
                    </option>
                  ) : (
                    primaryModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))
                  )}
                </select>

                <div
                  style={{
                    gridColumn: "1 / -1",
                    display: "flex",
                    gap: "6px",
                    alignItems: "center",
                  }}
                >
                  <input
                    className="input input-sm mono"
                    aria-label="手动指定模型 ID"
                    placeholder="或输入自定义模型 ID 回车应用"
                    value={customModelDraft}
                    onChange={(e) =>
                      setCustomModelDraft((e.currentTarget as HTMLInputElement).value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customModelDraft.trim()) {
                        e.preventDefault();
                        updateRole(selectedId, {
                          primary: {
                            provider: primaryProvider,
                            model: customModelDraft.trim(),
                            effort: selectedEntry.primary?.effort ?? "medium",
                          },
                        });
                        setCustomModelDraft("");
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!customModelDraft.trim()}
                    onClick={() => {
                      if (!customModelDraft.trim()) return;
                      updateRole(selectedId, {
                        primary: {
                          provider: primaryProvider,
                          model: customModelDraft.trim(),
                          effort: selectedEntry.primary?.effort ?? "medium",
                        },
                      });
                      setCustomModelDraft("");
                    }}
                  >
                    应用
                  </button>
                </div>
              </div>
            </div>

            <div className="insp-sec">
              <div className="insp-h">
                <span>接棒顺序（备选）</span>
                <span className="sp" />
                <span className="mono muted" style={{ fontWeight: 400 }}>
                  {selectedEntry.fallbacks.length} 级备选
                </span>
              </div>

              <div className="chain">
                {selectedEntry.primary ? (
                  <div className="chain-item">
                    <span className="chain-ord">主</span>
                    <ProviderAvatar providerId={selectedEntry.primary.provider} />
                    <span className="chain-prov">
                      {statusByProvider.get(selectedEntry.primary.provider)?.label ??
                        selectedEntry.primary.provider}
                    </span>
                    <span className="mono muted">{selectedEntry.primary.model}</span>
                  </div>
                ) : null}

                {selectedEntry.fallbacks.map((fb, idx) => {
                  const isHot =
                    selectedResolved?.isFallback && selectedResolved.fallbackIdx === idx;
                  return (
                    <div
                      key={`${fb.provider}-${fb.model}-${idx}`}
                      className={`chain-item ${isHot ? "hot" : ""}`}
                    >
                      <span className="chain-ord">{idx + 1}</span>
                      <ProviderAvatar providerId={fb.provider} />
                      <span className="chain-prov">
                        {statusByProvider.get(fb.provider)?.label ?? fb.provider}
                      </span>
                      <span className="mono muted">{fb.model}</span>
                      {isHot ? <span className="chip chip-ask">接棒中</span> : null}
                      <span className="sp" />
                      {idx > 0 ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title="上移"
                          aria-label={`上移备选 ${fb.model}`}
                          onClick={() => moveFallback(idx, -1)}
                        >
                          <ArrowUpIcon />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="icon-btn"
                        title="移除"
                        aria-label={`移除备选 ${fb.model}`}
                        onClick={() => removeFallback(idx)}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="chain-add">
                <select
                  className="select select-sm"
                  aria-label="备选 Provider"
                  value={activeFbProvider}
                  onChange={(e) => {
                    const p = (e.currentTarget as HTMLSelectElement).value;
                    setFbAddProvider(p);
                    const ms = modelsForProvider(p, agents, customModelsByProvider);
                    setFbAddModel(ms[0] ?? "");
                  }}
                >
                  {providerChoices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <select
                  className="select select-sm mono"
                  aria-label="备选模型"
                  value={activeFbModel}
                  onChange={(e) =>
                    setFbAddModel((e.currentTarget as HTMLSelectElement).value)
                  }
                >
                  {fbModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ width: "28px", padding: 0, justifyContent: "center" }}
                  aria-label="添加备选"
                  title="添加到接棒顺序"
                  disabled={!activeFbProvider || !activeFbModel}
                  onClick={addFallback}
                >
                  <PlusIcon />
                </button>
              </div>
              <p className="muted" style={{ fontSize: "11.5px", lineHeight: 1.5 }}>
                主订阅 429 冷却或异构审查撞模型时，按此顺序自动切换下一级订阅。
              </p>
            </div>

            <div className="insp-sec">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                <div>
                  <div style={{ fontSize: "12.5px", fontWeight: 500 }}>允许全权兜底</div>
                  <div className="muted" style={{ fontSize: "11.5px" }}>
                    仅当 Provider 仅暴露 full-access 时显式放行
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label="允许全权兜底"
                    checked={selectedEntry.allow_full_access_fallback}
                    onChange={(e) => {
                      const checked = (e.currentTarget as HTMLInputElement).checked;
                      if (checked) {
                        setPendingConfirmFullAccessId(selectedId);
                      } else {
                        setPendingConfirmFullAccessId(null);
                        updateRole(selectedId, { allow_full_access_fallback: false });
                      }
                    }}
                  />
                  <span />
                </label>
              </div>
              {pendingConfirmFullAccessId === selectedId ? (
                <div className="confirm-bar" role="alertdialog" aria-label="确认开启全权兜底">
                  <p>
                    仅为「{selectedEntry.name}」启用 full-access 兜底？
                  </p>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      className="btn btn-light btn-sm"
                      onClick={() => {
                        updateRole(selectedId, { allow_full_access_fallback: true });
                        setPendingConfirmFullAccessId(null);
                      }}
                    >
                      确认开启
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setPendingConfirmFullAccessId(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {!selectedEntry.builtin ? (
          <div className="insp-sec">
            {pendingDeleteRoleId === selectedId ? (
              <div className="confirm-bar" role="alertdialog" aria-label="确认删除自定义角色">
                <p>确认删除自定义角色「{selectedEntry.name}」？</p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => {
                      mutateRoster((prev) => {
                        const next = { ...prev.roster };
                        delete next[selectedId];
                        return { ...prev, roster: next };
                      });
                      setPendingDeleteRoleId(null);
                      setSelectedId("main_dev");
                    }}
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setPendingDeleteRoleId(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setPendingDeleteRoleId(selectedId)}
              >
                <TrashIcon />
                <span>删除这个角色</span>
              </button>
            )}
          </div>
        ) : null}
      </aside>
    );
  };

  const heteroBanner = (() => {
    if (!rosterDraft.heterogeneous_review || !mainDevEntry?.primary || !revResolved) {
      return null;
    }
    if (revResolved.clash) {
      return <span className="chip chip-bad">审查与实施撞模型</span>;
    }
    if (revResolved.effective && mainDevEntry.primary) {
      return (
        <span className="hetero-ok">
          <CheckCircleIcon />
          <span>
            主力 {mainDevEntry.primary.model} ≠ 审查 {revResolved.effective.model}
          </span>
        </span>
      );
    }
    return null;
  })();

  return (
    <ViewFrame
      left={
        <>
          <h1 className="tb-title">编排与阵容</h1>
          <span className="tb-sub">
            配好常备角色，PM 每次只点将用得上的那几位
          </span>
        </>
      }
      right={
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={refreshBusy}
            onClick={() => void handleRefresh()}
          >
            <RefreshIcon />
            <span>{refreshBusy ? "刷新中…" : "刷新状态"}</span>
          </button>
          <button type="button" className="btn btn-sm" onClick={openNewRole}>
            <PlusIcon />
            <span>自定义角色</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${dirty ? "btn-light" : ""}`}
            disabled={saveBusy}
            onClick={() => void handleSave()}
          >
            {saveBusy ? "保存中…" : dirty ? "保存阵容 *" : "保存阵容"}
          </button>
        </>
      }
    >
      <div className="lineup-split">
        <div className="lineup-main">
          <div className="lineup-wrap">
            <section>
              <div className="sec-h">
                <h2>
                  <CpuIcon />
                  <span>订阅池</span>
                </h2>
                <span className="sec-note">
                  {readyCount} 份已就绪 · 仅真实采集额度，不伪造官方余额
                </span>
                <span className="sp" />
                {authMode === "local" ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => store.go("settings", { settingsTab: "providers" })}
                  >
                    管理 Providers
                  </button>
                ) : null}
              </div>
              {renderPool()}
            </section>

            <section>
              <div className="sec-h">
                <h2>
                  <ShieldIcon />
                  <span>排兵规则</span>
                </h2>
                <span className="sec-note">PM 按这些规则从待命角色里点将</span>
                <span className="sp" />
                {heteroBanner}
              </div>
              <div className="rules">
                <label className="rule">
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={rosterDraft.pm_orchestration.enabled}
                      onChange={(e) =>
                        mutateRoster((prev) => ({
                          ...prev,
                          pm_orchestration: {
                            ...prev.pm_orchestration,
                            enabled: (e.currentTarget as HTMLInputElement).checked,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                  <span>按特性从待命池点将</span>
                </label>

                <label className="rule">
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={rosterDraft.pm_orchestration.allow_auto_tester}
                      onChange={(e) =>
                        mutateRoster((prev) => ({
                          ...prev,
                          pm_orchestration: {
                            ...prev.pm_orchestration,
                            allow_auto_tester: (e.currentTarget as HTMLInputElement).checked,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                  <span>高风险任务自动加独立测试</span>
                </label>

                <label className="rule">
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={rosterDraft.pm_orchestration.prefer_unthrottled}
                      onChange={(e) =>
                        mutateRoster((prev) => ({
                          ...prev,
                          pm_orchestration: {
                            ...prev.pm_orchestration,
                            prefer_unthrottled: (e.currentTarget as HTMLInputElement).checked,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                  <span>限流时优先派未冷却的备选</span>
                </label>

                <label className="rule">
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={rosterDraft.pm_orchestration.require_review_for_core}
                      onChange={(e) =>
                        mutateRoster((prev) => ({
                          ...prev,
                          pm_orchestration: {
                            ...prev.pm_orchestration,
                            require_review_for_core: (e.currentTarget as HTMLInputElement).checked,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                  <span>改核心代码必须异构审查</span>
                </label>

                <label className="rule">
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={rosterDraft.heterogeneous_review}
                      onChange={(e) =>
                        mutateRoster((prev) => ({
                          ...prev,
                          heterogeneous_review: (e.currentTarget as HTMLInputElement).checked,
                        }))
                      }
                    />
                    <span />
                  </span>
                  <span>审查模型优先同时避开实施与方案</span>
                </label>

                <label className="rule">
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={rosterDraft.pm_orchestration.intake_auto_recon ?? true}
                      onChange={(e) =>
                        mutateRoster((prev) => ({
                          ...prev,
                          pm_orchestration: {
                            ...prev.pm_orchestration,
                            intake_auto_recon: (e.currentTarget as HTMLInputElement).checked,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                  <span>立项首轮自动快探项目上下文</span>
                </label>

                <label className="rule">
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={rosterDraft.pm_orchestration.plan_prefers_fast_exec ?? true}
                      onChange={(e) =>
                        mutateRoster((prev) => ({
                          ...prev,
                          pm_orchestration: {
                            ...prev.pm_orchestration,
                            plan_prefers_fast_exec: (e.currentTarget as HTMLInputElement).checked,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                  <span>有 PLAN.md 时优先快修执行再按需升档</span>
                </label>
              </div>
            </section>

            <section>
              <div className="sec-h">
                <h2>常备阵容</h2>
                <span className="sec-note">
                  {roleIds.length} 名 · {enabledCount} 名待命
                </span>
                <span className="sp" />
                <div className="seg" role="group" aria-label="筛选阵容分组">
                  {(
                    [
                      ["all", "全部"],
                      ["core", "核心"],
                      ["specialist", "专长"],
                      ["kernel", "内核"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      className={filter === k ? "on" : ""}
                      onClick={() => setFilter(k)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="roster">
                {groups
                  .filter((g) => filter === "all" || filter === g.key)
                  .map((g) => {
                    const groupIds = roleIds.filter((id) =>
                      g.matches.has(rosterDraft.roster[id]!.group),
                    );
                    if (groupIds.length === 0) return null;
                    return (
                      <div key={g.key}>
                        <div className="rg-head">
                          <b>{g.title}</b>
                          <span>
                            {groupIds.length} 名 · {g.hint}
                          </span>
                        </div>
                        {groupIds.map((id) => {
                          const entry = rosterDraft.roster[id]!;
                          const perm = PERM_META[entry.perm];
                          const res = resolveBindingStatus(id, entry);
                          const used = res.effective;
                          const isSelected = selectedId === id;

                          return (
                            <div
                              key={id}
                              className={`rr ${isSelected ? "sel" : ""} ${!entry.enabled ? "off" : ""}`}
                            >
                              <button
                                type="button"
                                data-roster-row={id}
                                className="rr-pick"
                                aria-pressed={isSelected}
                                onClick={() => setSelectedId(id)}
                              >
                                <span className="rr-main">
                                  <span className="rr-name">
                                    {entry.name}
                                    <small>{STAGE_LABELS[entry.stage]}</small>
                                    <span className={`perm perm-${perm.tone}`}>
                                      {perm.label}
                                    </span>
                                    {entry.tier_hint ? (
                                      <span className="chip" style={{ height: "18px", fontSize: "10.5px" }}>
                                        {TIER_HINT_LABELS[entry.tier_hint]}
                                      </span>
                                    ) : null}
                                    {entry.escalation_target ? (
                                      <span className="chip" style={{ height: "18px", fontSize: "10.5px" }}>
                                        升档→{rosterDraft.roster[entry.escalation_target]?.name ?? entry.escalation_target}
                                      </span>
                                    ) : null}
                                    {!entry.enabled ? (() => {
                                      const ancId = resolveDerivedAncestor(id);
                                      return ancId ? (
                                        <span className="chip" style={{ height: "18px", fontSize: "10.5px" }}>
                                          自动继承 {rosterDraft.roster[ancId]?.name ?? ancId}
                                        </span>
                                      ) : null;
                                    })() : null}
                                    {!entry.builtin ? (
                                      <span className="chip" style={{ height: "18px", fontSize: "10.5px" }}>
                                        自定义
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="rr-traits">{entry.traits}</span>
                                </span>

                                <span className="rr-sub">
                                  {entry.mode === "kernel" || !used ? (
                                    <>
                                      <ProviderAvatar providerId="kernel" />
                                      <span>0 Token 内核</span>
                                    </>
                                  ) : (
                                    <>
                                      <ProviderAvatar providerId={used.provider} />
                                      <span>
                                        {entry.mode === "on_conflict" ? `冲突按需 · ${used.model}` : used.model}
                                      </span>
                                      {used.effort ? <em>{used.effort}</em> : null}
                                    </>
                                  )}
                                </span>

                                <span className={`rr-fb ${res.isFallback ? "hot" : ""}`}>
                                  {res.isFallback
                                    ? `备选 ${res.fallbackIdx + 1}`
                                    : entry.fallbacks.length > 0
                                      ? `+${entry.fallbacks.length} 备选`
                                      : "无备选"}
                                </span>
                              </button>

                              <span className="rr-switch-wrap">
                                <label className="switch" title={entry.enabled ? "已启用" : "已停用"}>
                                  <input
                                    type="checkbox"
                                    aria-label={`启用 ${entry.name}`}
                                    checked={entry.enabled}
                                    onChange={() => toggleRoleEnabled(id)}
                                  />
                                  <span />
                                </label>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
              </div>
            </section>
          </div>
        </div>

        {renderInspector()}
      </div>

      <Dialog.Root open={newRoleOpen} onOpenChange={setNewRoleOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="palette-mask open">
            <Dialog.Content
              className="modal-card"
              aria-label="新增自定义专长角色"
              aria-describedby={undefined}
            >
              <div className="modal-head">
                <Dialog.Title asChild>
                  <h2>新增自定义专长角色</h2>
                </Dialog.Title>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setNewRoleOpen(false)}
                >
                  关闭
                </button>
              </div>

              <div className="modal-body">
                <div className="modal-grid">
                  <label className="modal-field">
                    <span>角色 ID</span>
                    <input
                      aria-label="自定义角色 ID"
                      className="input mono"
                      placeholder="如 perf_auditor"
                      value={newRoleId}
                      onChange={(e) =>
                        setNewRoleId((e.currentTarget as HTMLInputElement).value)
                      }
                    />
                  </label>
                  <label className="modal-field">
                    <span>显示名称</span>
                    <input
                      aria-label="自定义角色名称"
                      className="input"
                      placeholder="如 性能剖析专员"
                      value={newRoleName}
                      onChange={(e) =>
                        setNewRoleName((e.currentTarget as HTMLInputElement).value)
                      }
                    />
                  </label>
                </div>

                <div className="modal-grid">
                  <label className="modal-field">
                    <span>负责阶段（权限自动锁定）</span>
                    <select
                      className="select"
                      aria-label="自定义角色阶段"
                      value={newRoleStage}
                      onChange={(e) =>
                        setNewRoleStage(
                          (e.currentTarget as HTMLSelectElement).value as StageId,
                        )
                      }
                    >
                      {CUSTOM_STAGE_OPTIONS.map((o) => (
                        <option key={o.stage} value={o.stage}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="modal-field">
                    <span>主 Provider</span>
                    <select
                      className="select"
                      aria-label="自定义角色 Provider"
                      value={newRoleProvider}
                      onChange={(e) => {
                        const p = (e.currentTarget as HTMLSelectElement).value;
                        setNewRoleProvider(p);
                        const ms = modelsForProvider(p, agents, customModelsByProvider);
                        setNewRoleModel(ms[0] ?? "default");
                      }}
                    >
                      {providerChoices.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="modal-field">
                  <span>主模型</span>
                  <input
                    aria-label="自定义角色模型"
                    className="input mono"
                    value={newRoleModel}
                    onChange={(e) =>
                      setNewRoleModel((e.currentTarget as HTMLInputElement).value)
                    }
                  />
                </label>

                <label className="modal-field">
                  <span>能力特性（PM 按此文本自动点将）</span>
                  <textarea
                    aria-label="自定义角色能力特性"
                    className="role-trait-in"
                    placeholder="例如：专攻 SQLite 慢查询、内存泄漏排查与 Benchmark 对比"
                    value={newRoleTraits}
                    onChange={(e) =>
                      setNewRoleTraits((e.currentTarget as HTMLTextAreaElement).value)
                    }
                  />
                </label>

                {newRoleError ? (
                  <p className="warn-line" role="alert">
                    {newRoleError}
                  </p>
                ) : null}
              </div>

              <div className="modal-foot">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setNewRoleOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-light"
                  onClick={handleCreateCustomRole}
                >
                  添加角色
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
    </ViewFrame>
  );
}
