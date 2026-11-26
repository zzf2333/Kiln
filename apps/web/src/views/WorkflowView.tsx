import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import {
  DERIVED_ROSTER_INHERITANCE,
  REASONING_EFFORTS,
  VERIFIER_CAPABILITIES,
  buildWorkflowPreset,
  createDefaultWorkflowTemplates,
  ensureWorkflowAcceptStep,
  normalizeWorkflowBlueprintSafety,
  type ReasoningEffort,
  type StageId,
  type VerifierCapability,
  type WorkflowAgentNode,
  type WorkflowAgentRole,
  type WorkflowAgentStage,
  type WorkflowAtomicNode,
  type WorkflowBindingKey,
  type WorkflowBlueprint,
  type WorkflowLoopNode,
  type WorkflowNodeBinding,
  type WorkflowNodeOnFail,
  type WorkflowStep,
  type WorkflowTemplate,
  type WorkflowsConfig,
} from "@kiln/protocol/web";
import type { AgentDescriptorInfo, AgentModeInfo, ProviderRuntimeStatus } from "../api/types";
import {
  ArrowUpIcon,
  BoltIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseIcon,
  CpuIcon,
  PlusIcon,
  RefreshIcon,
  ShieldIcon,
  SparkleIcon,
  TrashIcon,
} from "../components/Icons";
import { KilnSelect } from "../components/KilnSelect";
import { ProviderAvatar } from "../components/ProviderAvatar";
import { ViewFrame } from "../components/ViewFrame";
import { fmtUsd } from "../state/format";
import { useKilnStore } from "../state/store";

type SlotZone = "pre_implement" | "in_implement" | "in_review" | "post_loop";

type InsertTarget =
  | { scope: "top"; index: number }
  | { scope: "loop"; loopIndex: number; innerIndex: number };

interface SlotSpec {
  id: string;
  title: string;
  zone: SlotZone;
  insertTarget: InsertTarget;
}

type SelectedTarget =
  | { kind: "stage"; key: WorkflowBindingKey }
  | { kind: "blueprint_node"; scope: "top"; index: number }
  | { kind: "blueprint_node"; scope: "loop"; loopIndex: number; innerIndex: number }
  | { kind: "deliver" }
  | { kind: "slot"; slot: SlotSpec };

interface StageUiMeta {
  title: string;
  subtitle: string;
  permLabel: string;
  permTone: "ro" | "rw" | "accept" | "kernel";
  interactive?: boolean;
  badge?: string;
}

const STAGE_META: Record<WorkflowBindingKey, StageUiMeta> = {
  intake: {
    title: "立项与讨论",
    subtitle: "对齐目标、验收命令与范围契约",
    permLabel: "只读·草稿",
    permTone: "ro",
    interactive: true,
    badge: "起点",
  },
  research: {
    title: "前置调研",
    subtitle: "只读摸底代码与约束，产出侦察结论",
    permLabel: "只读",
    permTone: "ro",
    badge: "可选",
  },
  plan: {
    title: "方案设计",
    subtitle: "形成技术方案与验证计划",
    permLabel: "只读",
    permTone: "ro",
    badge: "可选",
  },
  implement: {
    title: "实施写码",
    subtitle: "在隔离工作树修改代码并提交构建检查",
    permLabel: "工作区可写",
    permTone: "rw",
    badge: "核心",
  },
  review: {
    title: "独立审查",
    subtitle: "新上下文只读审查，不通过则退回实施",
    permLabel: "只读",
    permTone: "ro",
    badge: "审查",
  },
  accept: {
    title: "真实验收",
    subtitle: "从真实入口与产物端到端验证目标，失败自动回炉实施",
    permLabel: "只读+验收入口",
    permTone: "accept",
    badge: "必选验收",
  },
  advisor: {
    title: "技术顾问",
    subtitle: "遇到技术分歧或环路阻塞时只读裁决",
    permLabel: "只读·顾问",
    permTone: "ro",
    badge: "独立接入",
  },
  triage: {
    title: "异常研判",
    subtitle: "分析门禁失败或限流后的恢复路径",
    permLabel: "只读",
    permTone: "ro",
  },
  resolver: {
    title: "讨论对话",
    subtitle: "载入整卡上下文协助用户敲定待决问题",
    permLabel: "只读",
    permTone: "ro",
    interactive: true,
  },
  retro: {
    title: "任务复盘",
    subtitle: "提炼可复用经验并建议工作流调优",
    permLabel: "只读",
    permTone: "ro",
  },
};

const INHERITED_KEYS = new Set<WorkflowBindingKey>([
  "research",
  "plan",
  "triage",
  "resolver",
  "retro",
]);

const VERIFIER_CAPABILITY_LABELS: Record<VerifierCapability, string> = {
  cli: "CLI / 产物检查",
  browser: "真实浏览器操作",
  desktop_gui: "桌面 GUI 操控",
};

const LOOP_ROUNDS_OPTIONS = [1, 2, 3, 5] as const;

interface SlotPresetOption {
  label: string;
  stage: "research" | "plan" | "implement" | "review";
  perm: "read_only" | "workspace_write";
  onFail?: WorkflowNodeOnFail;
  instructions: string;
}

function getSlotPresets(zone: SlotZone): SlotPresetOption[] {
  if (zone === "pre_implement") {
    return [
      {
        label: "架构与影响面侦察",
        stage: "research",
        perm: "read_only",
        instructions: "只读梳理受影响模块、调用链与潜在风险边界，不改代码。",
      },
      {
        label: "接口/数据方案梳理",
        stage: "plan",
        perm: "read_only",
        instructions: "输出简洁可执行的技术方案、边界清单与验证点。",
      },
    ];
  }
  if (zone === "in_implement") {
    return [
      {
        label: "前端/样式精修",
        stage: "implement",
        perm: "workspace_write",
        instructions: "在同工作树内补充交互细节、双主题兼容与响应式检查。",
      },
      {
        label: "实现后自查",
        stage: "research",
        perm: "read_only",
        instructions: "只读核对改动与契约一致性，补充运行自检清单。",
      },
    ];
  }
  if (zone === "in_review") {
    return [
      {
        label: "安全与红线审计",
        stage: "review",
        perm: "read_only",
        onFail: "loop_back",
        instructions: "只读检查权限边界、路径校验与高风险回归项；不通过则退回实施修复。",
      },
      {
        label: "专项复核（仅提醒）",
        stage: "review",
        perm: "read_only",
        onFail: "continue",
        instructions: "记录性能、可读性或文档建议，不阻断后续推进。",
      },
    ];
  }
  return [
    {
      label: "文档与说明同步",
      stage: "implement",
      perm: "workspace_write",
      instructions: "同步更新相关文档与使用说明，完成后自动经过确定性 verify 门禁。",
    },
    {
      label: "发布前只读终检",
      stage: "review",
      perm: "read_only",
      onFail: "continue",
      instructions: "只读检查交付物清单、版本号卫生与变更摘要。",
    },
  ];
}

function cloneAtomicNode(node: WorkflowAtomicNode): WorkflowAtomicNode {
  if (node.kind === "agent" && node.binding) {
    return { ...node, binding: { ...node.binding } };
  }
  if (node.kind === "approval") {
    return { ...node, show: [...node.show] };
  }
  return { ...node };
}

function cloneBlueprint(bp: WorkflowBlueprint): WorkflowBlueprint {
  return {
    schema_version: 1,
    preset: bp.preset,
    steps: bp.steps.map((step): WorkflowStep => {
      if (step.kind === "loop") {
        return {
          ...step,
          steps: step.steps.map(cloneAtomicNode),
        };
      }
      return cloneAtomicNode(step);
    }),
    ...(bp.pm_rationale !== undefined ? { pm_rationale: bp.pm_rationale } : {}),
  };
}

function cloneWorkflowsConfig(src: WorkflowsConfig): WorkflowsConfig {
  const stage_bindings: WorkflowsConfig["stage_bindings"] = {};
  for (const [k, v] of Object.entries(src.stage_bindings ?? {})) {
    if (v) stage_bindings[k as WorkflowBindingKey] = { ...v };
  }
  const stage_fallbacks: WorkflowsConfig["stage_fallbacks"] = {};
  for (const [k, list] of Object.entries(src.stage_fallbacks ?? {})) {
    if (list) stage_fallbacks[k as WorkflowBindingKey] = list.map((fb) => ({ ...fb }));
  }
  const templates =
    src.templates && src.templates.length > 0
      ? src.templates.map((t) => ({
          ...t,
          blueprint: normalizeWorkflowBlueprintSafety(
            ensureWorkflowAcceptStep(cloneBlueprint(t.blueprint)),
          ),
        }))
      : createDefaultWorkflowTemplates();
  return {
    schema_version: 1,
    default_template_id: src.default_template_id || templates[0]!.id,
    heterogeneous_review: Boolean(src.heterogeneous_review),
    stage_bindings,
    stage_fallbacks,
    allow_full_access_fallback: { ...(src.allow_full_access_fallback ?? {}) },
    verifier_capabilities:
      src.verifier_capabilities && src.verifier_capabilities.length > 0
        ? [...src.verifier_capabilities]
        : ["cli"],
    deliver_mode: src.deliver_mode ?? "kernel",
    ...(src.deliver_binding ? { deliver_binding: { ...src.deliver_binding } } : {}),
    templates,
  };
}

function modelsForProvider(
  providerId: string,
  agents: readonly AgentDescriptorInfo[],
  customModelsByProvider: Map<string, string[]>,
  extraModels: readonly string[] = [],
): string[] {
  const set = new Set<string>();
  const agent = agents.find((a) => a.id === providerId || a.backendId === providerId);
  if (agent?.models) {
    for (const m of agent.models) {
      const id = typeof m === "string" ? m : m.id;
      if (id.trim()) set.add(id.trim());
    }
  }
  for (const m of customModelsByProvider.get(providerId) ?? []) {
    if (m.trim()) set.add(m.trim());
  }
  for (const m of extraModels) {
    if (m.trim()) set.add(m.trim());
  }
  return Array.from(set);
}

function isFullAccessOnlyAgent(agent: AgentDescriptorInfo | undefined): boolean {
  if (!agent?.modes || agent.modes.length === 0) return false;
  return agent.modes.every(
    (m: AgentModeInfo) => m.isFullAccess === true || /full[-_\s]?access|bypass/i.test(m.id),
  );
}

function defaultRoleForStage(stage: WorkflowAgentStage): WorkflowAgentRole {
  if (stage === "implement") return "worker";
  if (stage === "review") return "reviewer";
  if (stage === "accept") return "verifier";
  return "advisor";
}

function mapStageToBindingKey(stage: StageId): WorkflowBindingKey {
  if (stage === "advise") return "advisor";
  if (
    stage === "intake" ||
    stage === "research" ||
    stage === "plan" ||
    stage === "implement" ||
    stage === "review" ||
    stage === "accept" ||
    stage === "triage"
  ) {
    return stage;
  }
  return "implement";
}

function formatStepNum(num: number): string {
  return String(num).padStart(2, "0");
}

function FlowConnector({
  slot,
  selected,
  compact,
  onSelect,
}: {
  slot: SlotSpec;
  selected: boolean;
  compact?: boolean;
  onSelect: (slot: SlotSpec) => void;
}) {
  const h = compact ? 46 : 58;
  const lineEnd = h - 5;
  return (
    <div className={`wf-conn ${compact ? "is-compact" : ""} ${selected ? "is-selected" : ""}`}>
      <svg className="wf-conn-svg" viewBox={`0 0 28 ${h}`} aria-hidden="true">
        <line x1="14" y1="0" x2="14" y2={lineEnd} className="wf-conn-rail" />
        <line x1="14" y1="0" x2="14" y2={lineEnd} className="wf-conn-stream" />
        <line x1="14" y1="0" x2="14" y2={lineEnd} pathLength={100} className="wf-conn-pulse" />
        <path d={`M10 ${lineEnd - 4} L14 ${h - 1} L18 ${lineEnd - 4}`} className="wf-conn-arrow" />
      </svg>
      <button
        type="button"
        className={`wf-slot-btn ${selected ? "on" : ""}`}
        data-wf-slot={slot.id}
        aria-label={slot.title}
        title={slot.title}
        onClick={() => onSelect(slot)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

export function WorkflowView() {
  const { store, state } = useKilnStore();
  const { workflows, providerStatuses, providersConfig, agents, authMode } = state;

  const [draft, setDraft] = useState<WorkflowsConfig>(() => cloneWorkflowsConfig(workflows));
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const [activeTemplateId, setActiveTemplateId] = useState<string>(
    () => workflows.default_template_id || workflows.templates[0]?.id || "standard_dev",
  );
  const [selected, setSelected] = useState<SelectedTarget>({ kind: "stage", key: "implement" });
  const [auxExpanded, setAuxExpanded] = useState(true);

  const [refreshBusy, setRefreshBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);

  const [customModelDraft, setCustomModelDraft] = useState("");
  const [fbAddProvider, setFbAddProvider] = useState("");
  const [fbAddModel, setFbAddModel] = useState("");
  const [pendingConfirmFullAccessKey, setPendingConfirmFullAccessKey] =
    useState<WorkflowBindingKey | null>(null);

  const [newTplOpen, setNewTplOpen] = useState(false);
  const [newTplName, setNewTplName] = useState("");
  const [newTplDesc, setNewTplDesc] = useState("");
  const [newTplBaseId, setNewTplBaseId] = useState("standard_dev");
  const [newTplError, setNewTplError] = useState<string | null>(null);

  const [slotLabel, setSlotLabel] = useState("");
  const [slotPerm, setSlotPerm] = useState<"read_only" | "workspace_write">("read_only");
  const [slotStage, setSlotStage] = useState<"research" | "plan" | "implement" | "review">(
    "research",
  );
  const [slotProvider, setSlotProvider] = useState("");
  const [slotModel, setSlotModel] = useState("");
  const [slotEffort, setSlotEffort] = useState<ReasoningEffort>("medium");
  const [slotInstructions, setSlotInstructions] = useState("");
  const [slotOnFail, setSlotOnFail] = useState<WorkflowNodeOnFail>("loop_back");
  const [slotError, setSlotError] = useState<string | null>(null);

  useEffect(() => {
    if (dirtyRef.current) return;
    const cloned = cloneWorkflowsConfig(workflows);
    setDraft(cloned);
    if (!cloned.templates.some((t) => t.id === activeTemplateId)) {
      setActiveTemplateId(cloned.default_template_id || cloned.templates[0]?.id || "standard_dev");
    }
  }, [workflows]);

  const activeTemplate: WorkflowTemplate =
    draft.templates.find((t) => t.id === activeTemplateId) ??
    draft.templates[0] ??
    createDefaultWorkflowTemplates()[0]!;

  const statusByProvider = new Map<string, ProviderRuntimeStatus>(
    providerStatuses.map((p) => [p.provider_id, p]),
  );
  const disabledProviderIds = new Set(
    (providersConfig?.providers ?? []).filter((p) => !p.enabled).map((p) => p.id),
  );
  const isProviderVisible = (providerId: string): boolean => {
    if (disabledProviderIds.has(providerId)) return false;
    const st = statusByProvider.get(providerId)?.status;
    return st !== "unavailable";
  };
  const visibleProviders = providerStatuses.filter((p) => isProviderVisible(p.provider_id));

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
      ...visibleProviders.map(
        (p): [string, { id: string; label: string; status: ProviderRuntimeStatus["status"] }] => [
          p.provider_id,
          { id: p.provider_id, label: p.label, status: p.status },
        ],
      ),
      ...agents
        .filter((a) => isProviderVisible(a.id))
        .map(
          (a): [string, { id: string; label: string; status: ProviderRuntimeStatus["status"] }] => [
            a.id,
            {
              id: a.id,
              label: a.label ?? a.id,
              status: statusByProvider.get(a.id)?.status ?? "ready",
            },
          ],
        ),
    ]).values(),
  );

  const defaultProviderId =
    providerChoices.find((p) => p.status === "ready")?.id ?? providerChoices[0]?.id ?? "codex";

  const pickDefaultBinding = (preferredProvider?: string): WorkflowNodeBinding => {
    const pid = preferredProvider || defaultProviderId;
    const models = modelsForProvider(pid, agents, customModelsByProvider);
    return {
      provider: pid,
      model: models[0] ?? "default",
      effort: "medium",
    };
  };

  const mutateDraft = (updater: (prev: WorkflowsConfig) => WorkflowsConfig): void => {
    setDraft((prev) => updater(prev));
    setDirty(true);
  };

  const mutateActiveTemplate = (updater: (bp: WorkflowBlueprint) => WorkflowBlueprint): void => {
    mutateDraft((prev) => ({
      ...prev,
      templates: prev.templates.map((tpl) => {
        if (tpl.id !== activeTemplate.id) return tpl;
        return {
          ...tpl,
          blueprint: normalizeWorkflowBlueprintSafety(
            ensureWorkflowAcceptStep(updater(cloneBlueprint(tpl.blueprint))),
          ),
        };
      }),
    }));
  };

  const resolveInheritedSource = (key: WorkflowBindingKey): WorkflowBindingKey | null => {
    const chain =
      DERIVED_ROSTER_INHERITANCE[key === "intake" ? "pm" : key === "implement" ? "main_dev" : key];
    if (key === "plan" || key === "research" || key === "triage" || key === "resolver") {
      if (draft.stage_bindings.advisor) return "advisor";
    }
    if (key === "retro") {
      if (draft.stage_bindings.advisor) return "advisor";
      if (draft.stage_bindings.review) return "review";
    }
    if (chain) {
      for (const anc of chain) {
        const mapped: WorkflowBindingKey =
          anc === "main_dev"
            ? "implement"
            : anc === "reviewer"
              ? "review"
              : (anc as WorkflowBindingKey);
        if (draft.stage_bindings[mapped]) return mapped;
      }
    }
    return null;
  };

  const getEffectiveStageBinding = (
    key: WorkflowBindingKey,
  ): {
    binding: WorkflowNodeBinding | undefined;
    inheritedFrom: WorkflowBindingKey | null;
  } => {
    const direct = draft.stage_bindings[key];
    if (direct) {
      return { binding: direct, inheritedFrom: null };
    }
    const anc = resolveInheritedSource(key);
    if (anc && draft.stage_bindings[anc]) {
      return { binding: draft.stage_bindings[anc], inheritedFrom: anc };
    }
    return { binding: undefined, inheritedFrom: null };
  };

  const resolveReviewCollision = (): {
    effective: WorkflowNodeBinding | null;
    isFallback: boolean;
    fallbackIdx: number;
    clash: boolean;
    warning?: string;
  } => {
    const impl = draft.stage_bindings.implement;
    const rev = draft.stage_bindings.review;
    const planB = getEffectiveStageBinding("plan").binding;
    if (!rev) {
      return { effective: null, isFallback: false, fallbackIdx: -1, clash: false };
    }
    const statusBlocked = (b: WorkflowNodeBinding): boolean => {
      const st = statusByProvider.get(b.provider)?.status;
      return st === "cooldown" || st === "unavailable" || st === "auth_required";
    };
    const sameImpl = (b: WorkflowNodeBinding): boolean =>
      Boolean(
        draft.heterogeneous_review &&
        impl &&
        b.provider === impl.provider &&
        b.model === impl.model,
      );
    const samePlan = (b: WorkflowNodeBinding): boolean =>
      Boolean(
        draft.heterogeneous_review &&
        planB &&
        b.provider === planB.provider &&
        b.model === planB.model,
      );

    if (!statusBlocked(rev) && !sameImpl(rev) && !samePlan(rev)) {
      return { effective: rev, isFallback: false, fallbackIdx: -1, clash: false };
    }

    const fallbacks = draft.stage_fallbacks.review ?? [];
    for (let i = 0; i < fallbacks.length; i++) {
      const fb = fallbacks[i]!;
      if (!statusBlocked(fb) && !sameImpl(fb) && !samePlan(fb)) {
        return {
          effective: fb,
          isFallback: true,
          fallbackIdx: i,
          clash: false,
          warning:
            sameImpl(rev) || samePlan(rev)
              ? `主模型与上游撞车，派发时自动切到异构备选 #${i + 1} (${fb.provider} / ${fb.model})`
              : `主订阅不可用，自动切到备选 #${i + 1}`,
        };
      }
    }

    if (sameImpl(rev)) {
      for (let i = 0; i < fallbacks.length; i++) {
        const fb = fallbacks[i]!;
        if (!statusBlocked(fb) && !sameImpl(fb)) {
          return {
            effective: fb,
            isFallback: true,
            fallbackIdx: i,
            clash: false,
            warning: `仅单重异构：备选 #${i + 1} 已避开实施模型，但仍与方案模型相同`,
          };
        }
      }
      return {
        effective: rev,
        isFallback: false,
        fallbackIdx: -1,
        clash: true,
        warning: `独立审查与实施同模型 (${rev.provider} / ${rev.model})，请更换模型或添加不同家族备选`,
      };
    }

    return { effective: rev, isFallback: false, fallbackIdx: -1, clash: false };
  };

  const reviewStatus = resolveReviewCollision();

  const openSlotInspector = (slot: SlotSpec): void => {
    const presets = getSlotPresets(slot.zone);
    const first = presets[0]!;
    const defBinding = pickDefaultBinding();
    setSlotLabel("");
    setSlotPerm(first.perm);
    setSlotStage(first.stage);
    setSlotProvider(defBinding.provider);
    setSlotModel(defBinding.model);
    setSlotEffort(defBinding.effort ?? "medium");
    setSlotInstructions("");
    setSlotOnFail(first.onFail ?? "loop_back");
    setSlotError(null);
    setSelected({ kind: "slot", slot });
  };

  const handleInsertCustomNode = (slot: SlotSpec): void => {
    const label = slotLabel.trim();
    if (!label) {
      setSlotError("请填写步骤名称");
      return;
    }
    const prov = slotProvider || defaultProviderId;
    const model = slotModel.trim() || "default";
    const id = `step_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const node: WorkflowAgentNode = {
      kind: "agent",
      id,
      label,
      stage: slotStage,
      role: defaultRoleForStage(slotStage),
      fresh_context: true,
      binding: {
        provider: prov,
        model,
        effort: slotEffort,
      },
      ...(slotInstructions.trim() ? { instructions: slotInstructions.trim() } : {}),
      ...(slotStage === "review" ? { on_fail: slotOnFail } : {}),
    };

    mutateActiveTemplate((bp) => {
      if (slot.insertTarget.scope === "top") {
        const steps = [...bp.steps];
        steps.splice(slot.insertTarget.index, 0, node);
        return { ...bp, steps };
      }
      const targetLoopIdx = slot.insertTarget.loopIndex;
      const targetInnerIdx = slot.insertTarget.innerIndex;
      const steps = bp.steps.map((s, idx) => {
        if (idx !== targetLoopIdx || s.kind !== "loop") return s;
        const inner = [...s.steps];
        inner.splice(targetInnerIdx, 0, node);
        return { ...s, steps: inner };
      });
      return { ...bp, steps };
    });

    if (slot.insertTarget.scope === "top") {
      setSelected({ kind: "blueprint_node", scope: "top", index: slot.insertTarget.index });
    } else {
      setSelected({
        kind: "blueprint_node",
        scope: "loop",
        loopIndex: slot.insertTarget.loopIndex,
        innerIndex: slot.insertTarget.innerIndex,
      });
    }
    store.showToast(`已插入步骤「${label}」`);
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

  const handleSave = async (): Promise<void> => {
    if (saveBusy) return;
    setSaveBusy(true);
    try {
      const normalizedDraft: WorkflowsConfig = {
        ...draft,
        templates: draft.templates.map((tpl) => ({
          ...tpl,
          blueprint: normalizeWorkflowBlueprintSafety(ensureWorkflowAcceptStep(tpl.blueprint)),
        })),
      };
      const ok = await store.saveSettingsSection("workflows", normalizedDraft);
      if (ok) {
        setDraft(cloneWorkflowsConfig(normalizedDraft));
        setDirty(false);
      }
    } finally {
      setSaveBusy(false);
    }
  };

  const handleCreateTemplate = (): void => {
    const name = newTplName.trim();
    if (!name) {
      setNewTplError("请填写模板名称");
      return;
    }
    const baseTpl = draft.templates.find((t) => t.id === newTplBaseId) ?? draft.templates[0];
    const baseBp = baseTpl
      ? cloneBlueprint(baseTpl.blueprint)
      : buildWorkflowPreset("standard_dev");
    const newId = `tpl_${Date.now().toString(36)}`;
    const nextTpl: WorkflowTemplate = {
      id: newId,
      name,
      ...(newTplDesc.trim() ? { description: newTplDesc.trim() } : {}),
      builtin: false,
      blueprint: normalizeWorkflowBlueprintSafety(
        ensureWorkflowAcceptStep({
          ...baseBp,
          preset: "custom",
        }),
      ),
    };
    mutateDraft((prev) => ({
      ...prev,
      templates: [...prev.templates, nextTpl],
    }));
    setActiveTemplateId(newId);
    setNewTplOpen(false);
    store.showToast(`已新建模板「${name}」，记得点击保存工作流`);
  };

  const handleDuplicateTemplate = (): void => {
    const copyId = `tpl_${Date.now().toString(36)}`;
    const copyName = `${activeTemplate.name} (副本)`;
    const nextTpl: WorkflowTemplate = {
      id: copyId,
      name: copyName,
      ...(activeTemplate.description ? { description: activeTemplate.description } : {}),
      builtin: false,
      blueprint: {
        ...cloneBlueprint(activeTemplate.blueprint),
        preset: "custom",
      },
    };
    mutateDraft((prev) => ({
      ...prev,
      templates: [...prev.templates, nextTpl],
    }));
    setActiveTemplateId(copyId);
    store.showToast(`已复制模板「${copyName}」`);
  };

  const handleDeleteTemplate = (): void => {
    if (activeTemplate.builtin) return;
    const deletedName = activeTemplate.name;
    const remaining = draft.templates.filter((t) => t.id !== activeTemplate.id);
    const fallbackTpl = remaining[0] ?? createDefaultWorkflowTemplates()[0]!;
    mutateDraft((prev) => ({
      ...prev,
      default_template_id:
        prev.default_template_id === activeTemplate.id ? fallbackTpl.id : prev.default_template_id,
      templates: remaining,
    }));
    setActiveTemplateId(fallbackTpl.id);
    setSelected({ kind: "stage", key: "implement" });
    store.showToast(`已删除模板「${deletedName}」`);
  };

  const toggleOptionalStageInTemplate = (stage: "research" | "plan"): void => {
    mutateActiveTemplate((bp) => {
      const steps = [...bp.steps];
      const existingIdx = steps.findIndex((s) => s.kind === "agent" && s.stage === stage);
      if (existingIdx >= 0) {
        steps.splice(existingIdx, 1);
        return { ...bp, preset: "custom", steps };
      }
      const newNode: WorkflowAgentNode = {
        kind: "agent",
        stage,
        role: defaultRoleForStage(stage),
        fresh_context: true,
      };
      if (stage === "research") {
        steps.unshift(newNode);
      } else {
        const resIdx = steps.findIndex((s) => s.kind === "agent" && s.stage === "research");
        steps.splice(resIdx >= 0 ? resIdx + 1 : 0, 0, newNode);
      }
      return { ...bp, preset: "custom", steps };
    });
  };

  const toggleReviewLoopInTemplate = (): void => {
    mutateActiveTemplate((bp) => {
      const curLoopIdx = bp.steps.findIndex((s) => s.kind === "loop");
      if (curLoopIdx >= 0) {
        const loop = bp.steps[curLoopIdx] as WorkflowLoopNode;
        const kept = loop.steps.filter((s) => s.kind !== "agent" || s.stage !== "review");
        const nextSteps = [...bp.steps];
        nextSteps.splice(curLoopIdx, 1, ...kept);
        return { ...bp, preset: "custom", steps: nextSteps };
      }

      const firstCoreIdx = bp.steps.findIndex(
        (s) => s.kind === "gate" || (s.kind === "agent" && s.stage === "implement"),
      );
      const lastCoreIdx = (() => {
        let last = firstCoreIdx;
        for (let i = Math.max(0, firstCoreIdx); i < bp.steps.length; i++) {
          const s = bp.steps[i]!;
          if (
            s.kind === "gate" ||
            (s.kind === "agent" && (s.stage === "implement" || s.stage === "review"))
          ) {
            last = i;
          } else {
            break;
          }
        }
        return last;
      })();

      const innerCore: WorkflowAtomicNode[] =
        firstCoreIdx >= 0
          ? (bp.steps.slice(firstCoreIdx, lastCoreIdx + 1) as WorkflowAtomicNode[])
          : [
              { kind: "agent", stage: "implement", role: "worker", fresh_context: false },
              { kind: "gate", stage: "verify", check: "full" },
            ];
      if (!innerCore.some((n) => n.kind === "agent" && n.stage === "review")) {
        innerCore.push({
          kind: "agent",
          stage: "review",
          role: "reviewer",
          fresh_context: true,
        });
      }
      const newLoop: WorkflowLoopNode = {
        kind: "loop",
        max_rounds: 3,
        stuck_threshold: 2,
        steps: innerCore,
      };
      const nextSteps = [...bp.steps];
      if (firstCoreIdx >= 0) {
        nextSteps.splice(firstCoreIdx, lastCoreIdx - firstCoreIdx + 1, newLoop);
      } else {
        const acceptIdx = nextSteps.findIndex((s) => s.kind === "agent" && s.stage === "accept");
        nextSteps.splice(acceptIdx >= 0 ? acceptIdx : nextSteps.length, 0, newLoop);
      }
      return { ...bp, preset: "custom", steps: nextSteps };
    });
    if (selected.kind === "stage" && selected.key === "review") {
      setSelected({ kind: "stage", key: "implement" });
    }
  };

  // Normalize display blueprint to guarantee accept is always visible in flowchart
  const displayBlueprint = ensureWorkflowAcceptStep(activeTemplate.blueprint);
  const bpSteps = displayBlueprint.steps;
  const loopIndex = bpSteps.findIndex((s) => s.kind === "loop");
  const loopNode: WorkflowLoopNode | null =
    loopIndex >= 0 && bpSteps[loopIndex]?.kind === "loop"
      ? (bpSteps[loopIndex] as WorkflowLoopNode)
      : null;

  const topPreItems: Array<{ step: WorkflowAtomicNode; index: number }> = [];
  const topCoreItems: Array<{ step: WorkflowAtomicNode; index: number }> = [];
  const topPostItems: Array<{ step: WorkflowAtomicNode; index: number }> = [];

  if (loopIndex >= 0) {
    for (let i = 0; i < bpSteps.length; i++) {
      const s = bpSteps[i]!;
      if (s.kind === "loop") continue;
      if (i < loopIndex) {
        topPreItems.push({ step: s, index: i });
      } else {
        if ((s.kind === "command" || s.kind === "approval") && s.stage === "deliver") continue;
        topPostItems.push({ step: s, index: i });
      }
    }
  } else {
    let seenCore = false;
    for (let i = 0; i < bpSteps.length; i++) {
      const s = bpSteps[i]!;
      if (s.kind === "loop") continue;
      if ((s.kind === "command" || s.kind === "approval") && s.stage === "deliver") continue;
      if (s.kind === "gate" || s.stage === "implement") {
        seenCore = true;
        topCoreItems.push({ step: s, index: i });
      } else if (!seenCore && (s.stage === "research" || s.stage === "plan")) {
        topPreItems.push({ step: s, index: i });
      } else if (seenCore) {
        topPostItems.push({ step: s, index: i });
      } else {
        topPreItems.push({ step: s, index: i });
      }
    }
  }

  const hasResearch = topPreItems.some((x) => x.step.stage === "research");
  const hasPlan = topPreItems.some((x) => x.step.stage === "plan");
  const hasReviewLoop = Boolean(loopNode);

  // Assign continuous sequential step numbers (01, 02, 03...) across all agent steps
  let seqCounter = 1;
  const intakeNum = seqCounter++;
  const preStepNums = topPreItems.map((item) => (item.step.kind === "agent" ? seqCounter++ : null));
  const loopStepNums = loopNode
    ? loopNode.steps.map((inner) => (inner.kind === "agent" ? seqCounter++ : null))
    : [];
  const coreStepNums = topCoreItems.map((item) =>
    item.step.kind === "agent" ? seqCounter++ : null,
  );
  const postStepNums = topPostItems.map((item) =>
    item.step.kind === "agent" ? seqCounter++ : null,
  );
  const deliverNum = seqCounter++;

  const renderPoolBar = () => {
    const readyCount = visibleProviders.filter((p) => p.status === "ready").length;
    return (
      <div className="wf-pool-bar">
        <div className="wf-pool-meta">
          <CpuIcon />
          <span>订阅池 ({readyCount} 就绪)</span>
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
        {visibleProviders.length === 0 ? (
          <div className="muted" style={{ fontSize: "12px" }}>
            暂无可用本机订阅，请到「设置 → Providers 订阅底座」检查 CLI。
          </div>
        ) : (
          <div className="wf-pool-tiles">
            {visibleProviders.map((p) => {
              const isCooldown = p.status === "cooldown";
              const isDown = p.status === "unavailable" || p.status === "auth_required";
              const softBudget = quotaBudgetByProvider.get(p.provider_id);
              const localCost = p.local_window_cost_usd ?? 0;

              let labelRight = "无官方余额接口";
              let barCls = "acc";
              let pct = 0;

              if (isCooldown) {
                labelRight = p.cooldown_until ? `429 冷却至 ${p.cooldown_until}` : "429 冷却中";
                barCls = "bad";
                pct = 100;
              } else if (isDown) {
                labelRight = p.status === "auth_required" ? "需登录认证" : "未就绪";
                barCls = "bad";
              } else if (p.native_quota) {
                pct = Math.max(0, Math.min(100, Math.round(p.native_quota.used_percent)));
                barCls = pct >= 85 ? "bad" : pct >= 60 ? "warn" : "acc";
                labelRight = `官方窗口 ${pct}%`;
              } else if (softBudget && softBudget > 0) {
                pct = Math.min(100, Math.round((localCost / softBudget) * 100));
                barCls = pct >= 85 ? "bad" : pct >= 60 ? "warn" : "acc";
                labelRight = `今日折算 ${fmtUsd(localCost)}`;
              }

              return (
                <div
                  key={p.provider_id}
                  data-provider-tile={p.provider_id}
                  className={`wf-ptile ${isCooldown ? "limited" : ""}`}
                >
                  <ProviderAvatar providerId={p.provider_id} />
                  <div className="wf-ptile-info">
                    <div className="wf-ptile-top">
                      <b>{p.label}</b>
                      <span className={isCooldown ? "bad-txt" : "muted"}>{labelRight}</span>
                    </div>
                    <div className="meter" style={{ height: "3px" }}>
                      <i className={barCls} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderBindingChip = (binding: WorkflowNodeBinding | undefined, fallbackText: string) => {
    if (!binding) {
      return (
        <span className="muted mono" style={{ fontSize: "11.5px" }}>
          {fallbackText}
        </span>
      );
    }
    const provLabel = statusByProvider.get(binding.provider)?.label ?? binding.provider;
    return (
      <span className="wf-binding-bar wf-binding-card">
        <span className="wf-binding-top">
          <ProviderAvatar providerId={binding.provider} />
          <span className="wf-node-prov">{provLabel}</span>
          <span className="sp" />
          {binding.effort ? <span className="wf-effort">{binding.effort}</span> : null}
        </span>
        <span className="mono wf-node-model" title={binding.model}>
          {binding.model}
        </span>
      </span>
    );
  };

  const renderAtomicFlowNode = (
    node: WorkflowAtomicNode,
    loc: { scope: "top"; index: number } | { scope: "loop"; loopIndex: number; innerIndex: number },
    stepNumber: number | null,
  ) => {
    if (node.kind === "gate") {
      return (
        <div
          key={`gate-${loc.scope}-${loc.scope === "top" ? loc.index : loc.innerIndex}`}
          className="wf-node is-gate"
          data-wf-node="verify"
        >
          <div className="wf-node-head">
            <span className="wf-badge kernel">确定性门禁</span>
            <span className="wf-node-title">verify · 范围/构建/测试核验</span>
            <span className="sp" />
            <span className="mono muted" style={{ fontSize: "11px" }}>
              0 Token · 内核执行
            </span>
          </div>
        </div>
      );
    }

    if (node.kind !== "agent") return null;

    const isCustom = Boolean(node.id);
    const bindingKey = mapStageToBindingKey(node.stage);
    const meta = STAGE_META[bindingKey];
    const resolved = getEffectiveStageBinding(bindingKey);
    const effectiveBinding = node.binding ?? resolved.binding;
    const inheritedLabel =
      !node.binding && resolved.inheritedFrom
        ? `自动继承 ${STAGE_META[resolved.inheritedFrom].title}`
        : undefined;

    const isSelected = isCustom
      ? selected.kind === "blueprint_node" &&
        ((loc.scope === "top" && selected.scope === "top" && selected.index === loc.index) ||
          (loc.scope === "loop" &&
            selected.scope === "loop" &&
            selected.loopIndex === loc.loopIndex &&
            selected.innerIndex === loc.innerIndex))
      : selected.kind === "stage" && selected.key === bindingKey;

    const isReviewNode = bindingKey === "review" && !isCustom;
    const isAcceptNode = bindingKey === "accept" && !isCustom;
    const isCollision = isReviewNode && reviewStatus.clash;

    const permText = node.stage === "implement" ? "工作区可写" : meta.permLabel;
    const permTone = node.stage === "implement" ? "rw" : meta.permTone;
    const activeAcceptCaps = draft.verifier_capabilities ?? ["cli"];

    return (
      <button
        key={
          node.id ??
          `${node.stage}-${loc.scope}-${loc.scope === "top" ? loc.index : loc.innerIndex}`
        }
        type="button"
        data-wf-node={node.id ?? bindingKey}
        data-stage-node={node.stage}
        className={`wf-node ${isCustom ? "is-custom" : ""} ${isAcceptNode ? "is-accept" : ""} ${isSelected ? "on" : ""} ${isCollision ? "is-warn" : ""}`}
        onClick={() => {
          if (isCustom) {
            setSelected(
              loc.scope === "top"
                ? { kind: "blueprint_node", scope: "top", index: loc.index }
                : {
                    kind: "blueprint_node",
                    scope: "loop",
                    loopIndex: loc.loopIndex,
                    innerIndex: loc.innerIndex,
                  },
            );
          } else {
            setSelected({ kind: "stage", key: bindingKey });
          }
        }}
      >
        <div className="wf-node-head">
          {stepNumber !== null ? (
            <span className="wf-step-num" data-step-num={formatStepNum(stepNumber)}>
              {formatStepNum(stepNumber)}
            </span>
          ) : null}
          <span className={`wf-badge ${isCustom ? "custom" : permTone}`}>
            {isCustom ? "自定义" : (meta.badge ?? meta.title)}
          </span>
          <span className="wf-node-title">{node.label || meta.title}</span>
          <span className={`wf-perm-pill ${permTone}`} data-node-perm={permTone}>
            {permText}
          </span>
          {node.stage === "review" && node.on_fail === "continue" ? (
            <span className="wf-perm-pill ro">不阻断放行</span>
          ) : null}
          <span className="sp" />
          {isCollision ? <span className="chip chip-bad">撞模型</span> : null}
        </div>
        <div className="wf-node-body">
          {renderBindingChip(effectiveBinding, inheritedLabel ?? "未配置模型（点此绑定）")}
        </div>
        {isAcceptNode ? (
          <div className="wf-node-foot">
            <span className="wf-accept-caps">
              {activeAcceptCaps.map((cap) => (
                <span key={cap} className="wf-cap-tag">
                  {VERIFIER_CAPABILITY_LABELS[cap]}
                </span>
              ))}
            </span>
            <span className="muted" style={{ fontSize: "11px" }}>
              不通过 ↺ 自动回炉实施
            </span>
          </div>
        ) : null}
        {isReviewNode &&
        reviewStatus.effective &&
        !reviewStatus.clash &&
        draft.heterogeneous_review &&
        draft.stage_bindings.implement ? (
          <div className="wf-node-foot">
            <span className="wf-hetero-ok">
              <CheckCircleIcon />
              <span>
                主力 {draft.stage_bindings.implement.model} ≠ 审查 {reviewStatus.effective.model}
              </span>
            </span>
          </div>
        ) : null}
      </button>
    );
  };

  const renderStageInspector = (
    key: WorkflowBindingKey,
    customNodeInfo?: {
      node: WorkflowAgentNode;
      loc:
        | { scope: "top"; index: number }
        | { scope: "loop"; loopIndex: number; innerIndex: number };
    },
  ) => {
    const meta = STAGE_META[key];
    const customNode = customNodeInfo?.node;
    const isCustom = Boolean(customNode);
    const { binding: directOrInherited, inheritedFrom } = getEffectiveStageBinding(key);

    const activeBinding: WorkflowNodeBinding | undefined = isCustom
      ? customNode!.binding
      : draft.stage_bindings[key];
    const displayBinding = activeBinding ?? directOrInherited;
    const currentProvider = displayBinding?.provider ?? defaultProviderId;
    const currentModel = displayBinding?.model ?? "";
    const currentEffort = displayBinding?.effort ?? "medium";

    const candidateChoices = meta.interactive
      ? providerChoices.filter((p) => {
          const ag = agents.find((a) => a.id === p.id || a.backendId === p.id);
          return !ag || ag.capabilities.interactiveChat;
        })
      : providerChoices;

    const currentAgentObj = agents.find(
      (a) => a.id === currentProvider || a.backendId === currentProvider,
    );
    const currentModels = modelsForProvider(
      currentProvider,
      agents,
      customModelsByProvider,
      currentModel ? [currentModel] : [],
    );

    const isNonMcpInteractive =
      Boolean(meta.interactive) &&
      Boolean(currentAgentObj) &&
      currentAgentObj!.capabilities.interactiveChat &&
      !currentAgentObj!.capabilities.mcpInjection;
    const fullAccessOnly = isFullAccessOnlyAgent(currentAgentObj);
    const allowFullAccess = Boolean(draft.allow_full_access_fallback[key]);

    const updateBinding = (patch: Partial<WorkflowNodeBinding>): void => {
      if (isCustom && customNodeInfo) {
        const nextBinding: WorkflowNodeBinding = {
          provider: customNode!.binding?.provider ?? currentProvider,
          model: customNode!.binding?.model ?? (currentModel || "default"),
          effort: customNode!.binding?.effort ?? currentEffort,
          ...patch,
        };
        mutateActiveTemplate((bp) => {
          const updateNode = (s: WorkflowAtomicNode): WorkflowAtomicNode =>
            s.kind === "agent" ? { ...s, binding: nextBinding } : s;
          const targetLoc = customNodeInfo.loc;
          if (targetLoc.scope === "top") {
            const steps = bp.steps.map((s, idx) =>
              idx === targetLoc.index && s.kind !== "loop" ? updateNode(s) : s,
            );
            return { ...bp, steps };
          }
          const steps = bp.steps.map((s, idx) => {
            if (idx !== targetLoc.loopIndex || s.kind !== "loop") return s;
            return {
              ...s,
              steps: s.steps.map((inner, innerIdx) =>
                innerIdx === targetLoc.innerIndex ? updateNode(inner) : inner,
              ),
            };
          });
          return { ...bp, steps };
        });
        return;
      }

      const nextBinding: WorkflowNodeBinding = {
        provider: activeBinding?.provider ?? currentProvider,
        model: activeBinding?.model ?? (currentModels[0] || "default"),
        effort: activeBinding?.effort ?? currentEffort,
        ...patch,
      };
      mutateDraft((prev) => ({
        ...prev,
        stage_bindings: {
          ...prev.stage_bindings,
          [key]: nextBinding,
        },
      }));
    };

    const fallbacks = draft.stage_fallbacks[key] ?? [];
    const activeFbProvider = fbAddProvider || providerChoices[0]?.id || "codex";
    const fbModels = modelsForProvider(activeFbProvider, agents, customModelsByProvider);
    const activeFbModel =
      fbAddModel && fbModels.includes(fbAddModel) ? fbAddModel : (fbModels[0] ?? "");

    const moveCustomNode = (delta: -1 | 1): void => {
      if (!customNodeInfo) return;
      const loc = customNodeInfo.loc;
      if (loc.scope === "top") {
        const targetIdx = loc.index + delta;
        mutateActiveTemplate((bp) => {
          if (targetIdx < 0 || targetIdx >= bp.steps.length) return bp;
          const nextSteps = [...bp.steps];
          const [removed] = nextSteps.splice(loc.index, 1);
          nextSteps.splice(targetIdx, 0, removed!);
          return { ...bp, steps: nextSteps };
        });
        setSelected({ kind: "blueprint_node", scope: "top", index: targetIdx });
      } else {
        const targetInnerIdx = loc.innerIndex + delta;
        mutateActiveTemplate((bp) => ({
          ...bp,
          steps: bp.steps.map((s, idx) => {
            if (idx !== loc.loopIndex || s.kind !== "loop") return s;
            if (targetInnerIdx < 0 || targetInnerIdx >= s.steps.length) return s;
            const nextInner = [...s.steps];
            const [removed] = nextInner.splice(loc.innerIndex, 1);
            nextInner.splice(targetInnerIdx, 0, removed!);
            return { ...s, steps: nextInner };
          }),
        }));
        setSelected({
          kind: "blueprint_node",
          scope: "loop",
          loopIndex: loc.loopIndex,
          innerIndex: targetInnerIdx,
        });
      }
    };

    const deleteCustomNode = (): void => {
      if (!customNodeInfo) return;
      const loc = customNodeInfo.loc;
      mutateActiveTemplate((bp) => {
        if (loc.scope === "top") {
          const nextSteps = bp.steps.filter((_, idx) => idx !== loc.index);
          return { ...bp, steps: nextSteps };
        }
        return {
          ...bp,
          steps: bp.steps.map((s, idx) =>
            idx === loc.loopIndex && s.kind === "loop"
              ? { ...s, steps: s.steps.filter((_, i) => i !== loc.innerIndex) }
              : s,
          ),
        };
      });
      setSelected({ kind: "stage", key: "implement" });
    };

    const canInherit = INHERITED_KEYS.has(key) && !isCustom;
    const isInheritedNow = canInherit && !activeBinding && Boolean(inheritedFrom);

    return (
      <aside className="inspector" aria-label="步骤检查器">
        <div className="insp-sec">
          <div className="role-head">
            <span className={`wf-perm-pill ${meta.permTone}`}>
              {isCustom
                ? customNode!.stage === "implement"
                  ? "工作区可写"
                  : "只读"
                : meta.permLabel}
            </span>
            <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0 }}>
              {isCustom ? customNode!.label || "自定义步骤" : meta.title}
            </h2>
            <span className="sp" />
            <span className="mono muted" style={{ fontSize: "11px" }}>
              {isCustom ? customNode!.stage : key}
            </span>
          </div>
          <p className="muted" style={{ fontSize: "12px", lineHeight: 1.5 }}>
            {isCustom
              ? "插入到主工作流中的独立节点（每步可自由复用相同或不同模型）"
              : meta.subtitle}
          </p>

          {isInheritedNow ? (
            <div
              className="kernel-box"
              style={{ display: "flex", alignItems: "center", gap: "8px" }}
            >
              <span>
                当前自动继承「{STAGE_META[inheritedFrom!].title}」的模型；调整下方即单独覆写
              </span>
            </div>
          ) : canInherit && activeBinding ? (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() =>
                  mutateDraft((prev) => {
                    const next = { ...prev.stage_bindings };
                    delete next[key];
                    return { ...prev, stage_bindings: next };
                  })
                }
              >
                恢复继承技术顾问
              </button>
            </div>
          ) : null}

          {isNonMcpInteractive ? (
            <div className="muted" style={{ fontSize: "11.5px" }}>
              无 MCP 模式：自动通过结构化补丁同步草稿/契约
            </div>
          ) : null}

          {fullAccessOnly && !allowFullAccess ? (
            <div className="warn-line" role="alert" style={{ fontSize: "11.5px" }}>
              仅暴露 full-access，默认拦截派发，需先开启下方「允许全权兜底」
            </div>
          ) : null}
        </div>

        {isCustom && customNode ? (
          <div className="insp-sec">
            <div className="insp-h">
              <SparkleIcon />
              <span>自定义步骤设置</span>
            </div>
            <label className="modal-field" style={{ gap: "4px" }}>
              <span style={{ fontSize: "11.5px" }} className="muted">
                步骤名称
              </span>
              <input
                className="input input-sm"
                aria-label="自定义步骤名称"
                value={customNode.label ?? ""}
                onChange={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value;
                  const targetLoc = customNodeInfo!.loc;
                  mutateActiveTemplate((bp) => {
                    if (targetLoc.scope === "top") {
                      return {
                        ...bp,
                        steps: bp.steps.map((s, idx) =>
                          idx === targetLoc.index && s.kind === "agent" ? { ...s, label: val } : s,
                        ),
                      };
                    }
                    return {
                      ...bp,
                      steps: bp.steps.map((s, idx) =>
                        idx === targetLoc.loopIndex && s.kind === "loop"
                          ? {
                              ...s,
                              steps: s.steps.map((inner, ii) =>
                                ii === targetLoc.innerIndex && inner.kind === "agent"
                                  ? { ...inner, label: val }
                                  : inner,
                              ),
                            }
                          : s,
                      ),
                    };
                  });
                }}
              />
            </label>
            <label className="modal-field" style={{ gap: "4px" }}>
              <span style={{ fontSize: "11.5px" }} className="muted">
                步骤专属提示词
              </span>
              <textarea
                className="role-trait-in"
                style={{ minHeight: "58px" }}
                aria-label="自定义步骤说明"
                value={customNode.instructions ?? ""}
                placeholder="写清该步骤要重点核查或处理的事项"
                onChange={(e) => {
                  const val = (e.currentTarget as HTMLTextAreaElement).value;
                  const targetLoc = customNodeInfo!.loc;
                  mutateActiveTemplate((bp) => {
                    if (targetLoc.scope === "top") {
                      return {
                        ...bp,
                        steps: bp.steps.map((s, idx) =>
                          idx === targetLoc.index && s.kind === "agent"
                            ? { ...s, instructions: val }
                            : s,
                        ),
                      };
                    }
                    return {
                      ...bp,
                      steps: bp.steps.map((s, idx) =>
                        idx === targetLoc.loopIndex && s.kind === "loop"
                          ? {
                              ...s,
                              steps: s.steps.map((inner, ii) =>
                                ii === targetLoc.innerIndex && inner.kind === "agent"
                                  ? { ...inner, instructions: val }
                                  : inner,
                              ),
                            }
                          : s,
                      ),
                    };
                  });
                }}
              />
            </label>
            {customNode.stage === "review" ? (
              <div className="seg" role="group" aria-label="不通过时动作">
                <button
                  type="button"
                  className={(customNode.on_fail ?? "loop_back") === "loop_back" ? "on" : ""}
                  onClick={() =>
                    mutateActiveTemplate((bp) => {
                      const targetLoc = customNodeInfo!.loc;
                      if (targetLoc.scope === "top") {
                        return {
                          ...bp,
                          steps: bp.steps.map((s, idx) =>
                            idx === targetLoc.index && s.kind === "agent"
                              ? { ...s, on_fail: "loop_back" }
                              : s,
                          ),
                        };
                      }
                      return {
                        ...bp,
                        steps: bp.steps.map((s, idx) =>
                          idx === targetLoc.loopIndex && s.kind === "loop"
                            ? {
                                ...s,
                                steps: s.steps.map((inner, ii) =>
                                  ii === targetLoc.innerIndex && inner.kind === "agent"
                                    ? { ...inner, on_fail: "loop_back" }
                                    : inner,
                                ),
                              }
                            : s,
                        ),
                      };
                    })
                  }
                >
                  退回实施修复
                </button>
                <button
                  type="button"
                  className={customNode.on_fail === "continue" ? "on" : ""}
                  onClick={() =>
                    mutateActiveTemplate((bp) => {
                      const targetLoc = customNodeInfo!.loc;
                      if (targetLoc.scope === "top") {
                        return {
                          ...bp,
                          steps: bp.steps.map((s, idx) =>
                            idx === targetLoc.index && s.kind === "agent"
                              ? { ...s, on_fail: "continue" }
                              : s,
                          ),
                        };
                      }
                      return {
                        ...bp,
                        steps: bp.steps.map((s, idx) =>
                          idx === targetLoc.loopIndex && s.kind === "loop"
                            ? {
                                ...s,
                                steps: s.steps.map((inner, ii) =>
                                  ii === targetLoc.innerIndex && inner.kind === "agent"
                                    ? { ...inner, on_fail: "continue" }
                                    : inner,
                                ),
                              }
                            : s,
                        ),
                      };
                    })
                  }
                >
                  仅记录继续
                </button>
              </div>
            ) : null}
            {customNode.stage === "plan" ? (
              <div className="seg seg-wrap" role="group" aria-label="方案博弈模式">
                <button
                  type="button"
                  className={(customNode.plan_mode ?? "single") === "single" ? "on" : ""}
                  onClick={() =>
                    mutateActiveTemplate((bp) => {
                      const targetLoc = customNodeInfo!.loc;
                      if (targetLoc.scope === "top") {
                        return {
                          ...bp,
                          steps: bp.steps.map((s, idx) =>
                            idx === targetLoc.index && s.kind === "agent"
                              ? { ...s, plan_mode: "single" }
                              : s,
                          ),
                        };
                      }
                      return bp;
                    })
                  }
                >
                  单脑规划
                </button>
                <button
                  type="button"
                  className={customNode.plan_mode === "dual_synthesis" ? "on" : ""}
                  onClick={() =>
                    mutateActiveTemplate((bp) => {
                      const targetLoc = customNodeInfo!.loc;
                      if (targetLoc.scope === "top") {
                        return {
                          ...bp,
                          steps: bp.steps.map((s, idx) =>
                            idx === targetLoc.index && s.kind === "agent"
                              ? { ...s, plan_mode: "dual_synthesis" }
                              : s,
                          ),
                        };
                      }
                      return bp;
                    })
                  }
                >
                  双脑博弈合成 (E2)
                </button>
              </div>
            ) : null}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-sm"
                aria-label="上移步骤"
                onClick={() => moveCustomNode(-1)}
              >
                <ArrowUpIcon />
                <span>上移</span>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-label="下移步骤"
                onClick={() => moveCustomNode(1)}
              >
                <span>下移</span>
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                aria-label="删除自定义步骤"
                onClick={deleteCustomNode}
              >
                <TrashIcon />
                <span>删除步骤</span>
              </button>
            </div>
          </div>
        ) : null}

        <div className="insp-sec">
          <div className="insp-h">
            <CpuIcon />
            <span>主订阅与模型</span>
          </div>
          <div className="primary-grid">
            <KilnSelect
              className="select select-sm"
              ariaLabel="主订阅 Provider"
              value={currentProvider}
              options={[
                ...candidateChoices.map((p) => ({ value: p.id, label: p.label })),
                ...(!candidateChoices.some((p) => p.id === currentProvider)
                  ? [{ value: currentProvider, label: `${currentProvider}（当前）` }]
                  : []),
              ]}
              onChange={(nextProv) => {
                const nextModels = modelsForProvider(nextProv, agents, customModelsByProvider);
                updateBinding({
                  provider: nextProv,
                  model: nextModels[0] ?? "default",
                  effort: currentEffort,
                });
              }}
            />

            <KilnSelect
              className="select select-sm"
              ariaLabel="推理档位"
              value={currentEffort}
              options={REASONING_EFFORTS.map((eff) => ({ value: eff, label: eff }))}
              onChange={(nextEffort) =>
                updateBinding({
                  effort: nextEffort as ReasoningEffort,
                })
              }
            />

            <KilnSelect
              className="select select-sm mono"
              style={{ gridColumn: "1 / -1" }}
              ariaLabel="主模型"
              value={currentModel}
              options={
                currentModels.length === 0
                  ? [{ value: currentModel || "", label: currentModel || "请选择模型" }]
                  : [
                      ...(!currentModel ? [{ value: "", label: "请选择模型" }] : []),
                      ...currentModels.map((m) => ({ value: m, label: m })),
                    ]
              }
              onChange={(nextModel) => updateBinding({ model: nextModel })}
            />

            <div
              style={{ gridColumn: "1 / -1", display: "flex", gap: "6px", alignItems: "center" }}
            >
              <input
                className="input input-sm mono"
                aria-label="手动指定模型 ID"
                placeholder="或输入自定义模型 ID 回车应用"
                value={customModelDraft}
                onChange={(e) => setCustomModelDraft((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customModelDraft.trim()) {
                    e.preventDefault();
                    updateBinding({ model: customModelDraft.trim() });
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
                  updateBinding({ model: customModelDraft.trim() });
                  setCustomModelDraft("");
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>

        {key === "review" && !isCustom ? (
          <div className="insp-sec">
            <div className="insp-h">
              <ShieldIcon />
              <span>审查与循环策略</span>
            </div>
            <label className="rule" style={{ justifyContent: "space-between", width: "100%" }}>
              <span>审查避开实施所用模型</span>
              <span className="switch">
                <input
                  type="checkbox"
                  aria-label="审查避开实施所用模型"
                  checked={draft.heterogeneous_review}
                  onChange={(e) => {
                    const checked = (e.currentTarget as HTMLInputElement).checked;
                    mutateDraft((prev) => ({ ...prev, heterogeneous_review: checked }));
                  }}
                />
                <span />
              </span>
            </label>
            {reviewStatus.warning ? (
              <p className="warn-line" role="alert" style={{ fontSize: "11.5px" }}>
                {reviewStatus.warning}
              </p>
            ) : null}
            {loopNode ? (
              <div>
                <div className="muted" style={{ fontSize: "11.5px", marginBottom: "6px" }}>
                  最大循环退回轮数
                </div>
                <div className="seg" role="radiogroup" aria-label="最大循环退回轮数">
                  {LOOP_ROUNDS_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={loopNode.max_rounds === n}
                      className={loopNode.max_rounds === n ? "on" : ""}
                      onClick={() =>
                        mutateActiveTemplate((bp) => ({
                          ...bp,
                          steps: bp.steps.map((s) =>
                            s.kind === "loop" ? { ...s, max_rounds: n } : s,
                          ),
                        }))
                      }
                    >
                      {n} 轮
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {key === "accept" && !isCustom ? (
          <div className="insp-sec">
            <div className="insp-h">
              <ShieldIcon />
              <span>验收能力声明（必选主环）</span>
            </div>
            <div className="verifier-cap-row" role="group" aria-label="验收能力声明">
              {VERIFIER_CAPABILITIES.map((cap) => {
                const declared = draft.verifier_capabilities ?? ["cli"];
                const active = declared.includes(cap);
                return (
                  <button
                    key={cap}
                    type="button"
                    aria-pressed={active}
                    className={`verifier-cap-btn ${active ? "on" : ""}`}
                    onClick={() => {
                      const next = active ? declared.filter((c) => c !== cap) : [...declared, cap];
                      if (next.length === 0) return;
                      mutateDraft((prev) => ({ ...prev, verifier_capabilities: next }));
                    }}
                  >
                    {VERIFIER_CAPABILITY_LABELS[cap]}
                  </button>
                );
              })}
            </div>
            <p className="muted" style={{ fontSize: "11.5px" }}>
              真实验收通过真实入口与产物核查，失败将自动回炉实施修复；此处仅声明所绑 Agent
              自身具备的能力（Kiln 不内置浏览器驱动）。
            </p>
          </div>
        ) : null}

        {!isCustom ? (
          <>
            <div className="insp-sec">
              <div className="insp-h">
                <span>备选接棒（限流或避让时切换）</span>
                <span className="sp" />
                <span className="mono muted">{fallbacks.length} 级</span>
              </div>
              {fallbacks.length > 0 ? (
                <div className="chain">
                  {fallbacks.map((fb, idx) => (
                    <div key={`${fb.provider}-${fb.model}-${idx}`} className="chain-item">
                      <span className="chain-ord">{idx + 1}</span>
                      <ProviderAvatar providerId={fb.provider} />
                      <span className="chain-prov">
                        {statusByProvider.get(fb.provider)?.label ?? fb.provider}
                      </span>
                      <span className="mono muted">{fb.model}</span>
                      <span className="sp" />
                      {idx > 0 ? (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`上移备选 ${fb.model}`}
                          onClick={() => {
                            const next = [...fallbacks];
                            const [item] = next.splice(idx, 1);
                            next.splice(idx - 1, 0, item!);
                            mutateDraft((prev) => ({
                              ...prev,
                              stage_fallbacks: { ...prev.stage_fallbacks, [key]: next },
                            }));
                          }}
                        >
                          <ArrowUpIcon />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`移除备选 ${fb.model}`}
                        onClick={() =>
                          mutateDraft((prev) => ({
                            ...prev,
                            stage_fallbacks: {
                              ...prev.stage_fallbacks,
                              [key]: fallbacks.filter((_, i) => i !== idx),
                            },
                          }))
                        }
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted" style={{ fontSize: "11.5px", marginBottom: "6px" }}>
                  当前未添加备选（仅在 429 限流或异构避让时按顺序接棒）
                </div>
              )}
              <div className="chain-add">
                <KilnSelect
                  className="select select-sm"
                  ariaLabel="备选 Provider"
                  value={activeFbProvider}
                  options={providerChoices.map((p) => ({ value: p.id, label: p.label }))}
                  onChange={(p) => {
                    setFbAddProvider(p);
                    const ms = modelsForProvider(p, agents, customModelsByProvider);
                    setFbAddModel(ms[0] ?? "");
                  }}
                />
                <KilnSelect
                  className="select select-sm mono"
                  ariaLabel="备选模型"
                  value={activeFbModel}
                  options={fbModels.map((m) => ({ value: m, label: m }))}
                  onChange={(m) => setFbAddModel(m)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ width: "28px", height: "28px", padding: 0, justifyContent: "center" }}
                  aria-label="添加备选"
                  disabled={!activeFbProvider || !activeFbModel}
                  onClick={() => {
                    mutateDraft((prev) => ({
                      ...prev,
                      stage_fallbacks: {
                        ...prev.stage_fallbacks,
                        [key]: [
                          ...fallbacks,
                          { provider: activeFbProvider, model: activeFbModel, effort: "medium" },
                        ],
                      },
                    }));
                  }}
                >
                  <PlusIcon />
                </button>
              </div>
            </div>

            <div className="insp-sec">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                }}
              >
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
                    checked={allowFullAccess}
                    onChange={(e) => {
                      const checked = (e.currentTarget as HTMLInputElement).checked;
                      if (checked) {
                        setPendingConfirmFullAccessKey(key);
                      } else {
                        setPendingConfirmFullAccessKey(null);
                        mutateDraft((prev) => ({
                          ...prev,
                          allow_full_access_fallback: {
                            ...prev.allow_full_access_fallback,
                            [key]: false,
                          },
                        }));
                      }
                    }}
                  />
                  <span />
                </label>
              </div>
              {pendingConfirmFullAccessKey === key ? (
                <div className="confirm-bar" role="alertdialog" aria-label="确认开启全权兜底">
                  <p>仅为「{meta.title}」启用 full-access 兜底？</p>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      className="btn btn-light btn-sm"
                      onClick={() => {
                        mutateDraft((prev) => ({
                          ...prev,
                          allow_full_access_fallback: {
                            ...prev.allow_full_access_fallback,
                            [key]: true,
                          },
                        }));
                        setPendingConfirmFullAccessKey(null);
                      }}
                    >
                      确认开启
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setPendingConfirmFullAccessKey(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </aside>
    );
  };

  const renderSlotInspector = (slot: SlotSpec) => {
    const presets = getSlotPresets(slot.zone);
    const slotModels = modelsForProvider(
      slotProvider || defaultProviderId,
      agents,
      customModelsByProvider,
      slotModel ? [slotModel] : [],
    );

    return (
      <aside className="inspector" aria-label="插入自定义步骤">
        <div className="insp-sec">
          <div className="role-head">
            <span
              className={`wf-perm-pill ${slotPerm === "workspace_write" ? "rw" : "ro"}`}
              data-slot-perm={slotPerm}
            >
              {slotPerm === "workspace_write" ? "工作区可写" : "只读"}
            </span>
            <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0 }}>插入自定义步骤</h2>
          </div>
          <p className="muted" style={{ fontSize: "12px", lineHeight: 1.5 }}>
            {slot.title}：按所处位置自动锁定安全权限，严禁并行分叉。
          </p>
        </div>

        <div className="insp-sec">
          <div className="insp-h">
            <SparkleIcon />
            <span>快速预设</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`btn btn-sm ${slotLabel === p.label ? "btn-light" : ""}`}
                onClick={() => {
                  setSlotLabel(p.label);
                  setSlotStage(p.stage);
                  setSlotPerm(p.perm);
                  setSlotInstructions(p.instructions);
                  if (p.onFail) setSlotOnFail(p.onFail);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="insp-sec">
          <label className="modal-field" style={{ gap: "4px" }}>
            <span style={{ fontSize: "11.5px" }} className="muted">
              步骤名称
            </span>
            <input
              className="input input-sm"
              aria-label="自定义步骤名称"
              placeholder="如 安全审计 / 架构侦察 / 规范复核"
              value={slotLabel}
              onChange={(e) => {
                setSlotLabel((e.currentTarget as HTMLInputElement).value);
                setSlotError(null);
              }}
            />
          </label>

          {slot.zone === "in_implement" || slot.zone === "post_loop" ? (
            <div style={{ marginTop: "6px" }}>
              <div className="muted" style={{ fontSize: "11.5px", marginBottom: "4px" }}>
                权限类型
              </div>
              <div className="seg" role="group" aria-label="步骤权限类型">
                <button
                  type="button"
                  className={slotPerm === "read_only" ? "on" : ""}
                  onClick={() => {
                    setSlotPerm("read_only");
                    setSlotStage(slot.zone === "post_loop" ? "review" : "research");
                  }}
                >
                  只读检查
                </button>
                <button
                  type="button"
                  className={slotPerm === "workspace_write" ? "on" : ""}
                  onClick={() => {
                    setSlotPerm("workspace_write");
                    setSlotStage("implement");
                  }}
                >
                  工作区可写（自动加 verify 门禁）
                </button>
              </div>
            </div>
          ) : (
            <div className="kernel-box" style={{ marginTop: "6px" }}>
              当前位置强制锁定为 <b>只读 ({slotPerm})</b>，确保上游准备与独立审查不越权改代码。
            </div>
          )}

          {slot.zone === "in_review" || (slot.zone === "post_loop" && slotStage === "review") ? (
            <div style={{ marginTop: "6px" }}>
              <div className="muted" style={{ fontSize: "11.5px", marginBottom: "4px" }}>
                审查未通过处理
              </div>
              <div className="seg" role="group" aria-label="审查未通过处理">
                <button
                  type="button"
                  className={slotOnFail === "loop_back" ? "on" : ""}
                  onClick={() => setSlotOnFail("loop_back")}
                >
                  退回实施修复
                </button>
                <button
                  type="button"
                  className={slotOnFail === "continue" ? "on" : ""}
                  onClick={() => setSlotOnFail("continue")}
                >
                  仅记录继续
                </button>
              </div>
            </div>
          ) : null}

          <div className="primary-grid" style={{ marginTop: "8px" }}>
            <KilnSelect
              className="select select-sm"
              ariaLabel="插槽 Provider"
              value={slotProvider || defaultProviderId}
              options={providerChoices.map((p) => ({ value: p.id, label: p.label }))}
              onChange={(p) => {
                setSlotProvider(p);
                const ms = modelsForProvider(p, agents, customModelsByProvider);
                setSlotModel(ms[0] ?? "default");
              }}
            />
            <KilnSelect
              className="select select-sm"
              ariaLabel="插槽推理档位"
              value={slotEffort}
              options={REASONING_EFFORTS.map((e) => ({ value: e, label: e }))}
              onChange={(e) => setSlotEffort(e as ReasoningEffort)}
            />
            <KilnSelect
              className="select select-sm mono"
              style={{ gridColumn: "1 / -1" }}
              ariaLabel="插槽模型"
              value={slotModel}
              options={
                slotModels.length === 0
                  ? [{ value: slotModel || "default", label: slotModel || "default" }]
                  : slotModels.map((m) => ({ value: m, label: m }))
              }
              onChange={(m) => setSlotModel(m)}
            />
          </div>

          <textarea
            className="role-trait-in"
            style={{ marginTop: "8px", minHeight: "64px" }}
            aria-label="插槽步骤提示词"
            placeholder="可选：说明这个插入步骤要重点做什么"
            value={slotInstructions}
            onChange={(e) => setSlotInstructions((e.currentTarget as HTMLTextAreaElement).value)}
          />

          {slotError ? (
            <p className="warn-line" role="alert">
              {slotError}
            </p>
          ) : null}

          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <button
              type="button"
              className="btn btn-light btn-sm"
              onClick={() => handleInsertCustomNode(slot)}
            >
              <PlusIcon />
              <span>确认插入步骤</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSelected({ kind: "stage", key: "implement" })}
            >
              取消
            </button>
          </div>
        </div>
      </aside>
    );
  };

  const renderDeliverInspector = () => {
    const mode = draft.deliver_mode;
    const binding = draft.deliver_binding;
    const currentProvider = binding?.provider ?? defaultProviderId;
    const currentModel = binding?.model ?? "";
    const models = modelsForProvider(
      currentProvider,
      agents,
      customModelsByProvider,
      currentModel ? [currentModel] : [],
    );

    return (
      <aside className="inspector" aria-label="合并交付设置">
        <div className="insp-sec">
          <div className="role-head">
            <span className="wf-perm-pill kernel">
              {mode === "kernel"
                ? "0 Token 内核"
                : mode === "on_conflict"
                  ? "冲突按需"
                  : "Agent 合并"}
            </span>
            <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0 }}>合并交付</h2>
          </div>
          <p className="muted" style={{ fontSize: "12px", lineHeight: 1.5 }}>
            决定任务通过审查与真实验收后如何合回目标分支。
          </p>
        </div>

        <div className="insp-sec">
          <div className="insp-h">
            <BoltIcon />
            <span>合并执行方式</span>
          </div>
          <div className="seg" role="group" aria-label="合并执行方式">
            <button
              type="button"
              className={mode === "kernel" ? "on" : ""}
              onClick={() => mutateDraft((prev) => ({ ...prev, deliver_mode: "kernel" }))}
            >
              内核
            </button>
            <button
              type="button"
              className={mode === "on_conflict" ? "on" : ""}
              onClick={() =>
                mutateDraft((prev) => ({
                  ...prev,
                  deliver_mode: "on_conflict",
                  deliver_binding: prev.deliver_binding ?? pickDefaultBinding(),
                }))
              }
            >
              冲突按需
            </button>
            <button
              type="button"
              className={mode === "agent" ? "on" : ""}
              onClick={() =>
                mutateDraft((prev) => ({
                  ...prev,
                  deliver_mode: "agent",
                  deliver_binding: prev.deliver_binding ?? pickDefaultBinding(),
                }))
              }
            >
              Agent
            </button>
          </div>
          <div className="kernel-box">
            {mode === "kernel"
              ? "默认由确定性内核 0 Token 执行 merge_main，不额外消耗订阅额度。"
              : mode === "on_conflict"
                ? "平时 0 Token 内核合并；仅遇 git 合并冲突时唤起绑定模型在隔离工作树解冲突，并强制重过 verify 门禁。"
                : "交由绑定模型生成合并提交与交付总结，合并后仍经过工作区与分支检查。"}
          </div>
        </div>

        {mode !== "kernel" ? (
          <div className="insp-sec">
            <div className="insp-h">
              <CpuIcon />
              <span>解冲突 / 交付模型</span>
            </div>
            <div className="primary-grid">
              <KilnSelect
                className="select select-sm"
                ariaLabel="主订阅 Provider"
                value={currentProvider}
                options={providerChoices.map((p) => ({ value: p.id, label: p.label }))}
                onChange={(nextProv) => {
                  const ms = modelsForProvider(nextProv, agents, customModelsByProvider);
                  mutateDraft((prev) => ({
                    ...prev,
                    deliver_binding: {
                      provider: nextProv,
                      model: ms[0] ?? "default",
                      effort: prev.deliver_binding?.effort ?? "medium",
                    },
                  }));
                }}
              />
              <KilnSelect
                className="select select-sm"
                ariaLabel="推理档位"
                value={binding?.effort ?? "medium"}
                options={REASONING_EFFORTS.map((e) => ({ value: e, label: e }))}
                onChange={(e) =>
                  mutateDraft((prev) => ({
                    ...prev,
                    deliver_binding: {
                      provider: currentProvider,
                      model: currentModel || models[0] || "default",
                      effort: e as ReasoningEffort,
                    },
                  }))
                }
              />
              <KilnSelect
                className="select select-sm mono"
                style={{ gridColumn: "1 / -1" }}
                ariaLabel="主模型"
                value={currentModel}
                options={
                  models.length === 0
                    ? [{ value: currentModel || "", label: currentModel || "请选择模型" }]
                    : models.map((m) => ({ value: m, label: m }))
                }
                onChange={(m) =>
                  mutateDraft((prev) => ({
                    ...prev,
                    deliver_binding: {
                      provider: currentProvider,
                      model: m,
                      effort: prev.deliver_binding?.effort ?? "medium",
                    },
                  }))
                }
              />
            </div>
          </div>
        ) : null}
      </aside>
    );
  };

  const renderInspector = () => {
    if (selected.kind === "slot") {
      return renderSlotInspector(selected.slot);
    }
    if (selected.kind === "deliver") {
      return renderDeliverInspector();
    }
    if (selected.kind === "blueprint_node") {
      let node: WorkflowAtomicNode | undefined;
      if (selected.scope === "top") {
        const s = bpSteps[selected.index];
        if (s && s.kind !== "loop") node = s;
      } else {
        const loop = bpSteps[selected.loopIndex];
        if (loop?.kind === "loop") {
          node = loop.steps[selected.innerIndex];
        }
      }
      if (node && node.kind === "agent") {
        const loc =
          selected.scope === "top"
            ? ({ scope: "top", index: selected.index } as const)
            : ({
                scope: "loop",
                loopIndex: selected.loopIndex,
                innerIndex: selected.innerIndex,
              } as const);
        return renderStageInspector(mapStageToBindingKey(node.stage), { node, loc });
      }
    }
    const fallbackKey = selected.kind === "stage" ? selected.key : "implement";
    return renderStageInspector(fallbackKey);
  };

  const advisorResolved = getEffectiveStageBinding("advisor");
  const isDefaultTpl = draft.default_template_id === activeTemplate.id;
  const deliverInsertIdx = (() => {
    const idx = bpSteps.findIndex(
      (s) => (s.kind === "approval" || s.kind === "command") && s.stage === "deliver",
    );
    return idx >= 0 ? idx : bpSteps.length;
  })();

  return (
    <ViewFrame
      left={
        <>
          <h1 className="tb-title">工作流</h1>
          <div className="wf-tpl-controls">
            <KilnSelect
              className="select select-sm"
              ariaLabel="当前工作流模板"
              value={activeTemplate.id}
              options={draft.templates.map((t) => ({
                value: t.id,
                label: t.id === draft.default_template_id ? `${t.name}（默认）` : t.name,
              }))}
              onChange={(tplId) => {
                setActiveTemplateId(tplId);
                setSelected({ kind: "stage", key: "implement" });
              }}
            />
            {!isDefaultTpl ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() =>
                  mutateDraft((prev) => ({
                    ...prev,
                    default_template_id: activeTemplate.id,
                  }))
                }
              >
                设为默认
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setNewTplName("");
                setNewTplDesc("");
                setNewTplBaseId(activeTemplate.id);
                setNewTplError(null);
                setNewTplOpen(true);
              }}
            >
              <PlusIcon />
              <span>新建模板</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={handleDuplicateTemplate}
            >
              复制
            </button>
            {!activeTemplate.builtin ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                aria-label="删除模板"
                onClick={handleDeleteTemplate}
              >
                删除模板
              </button>
            ) : null}
          </div>
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
            <span>{refreshBusy ? "刷新中…" : "重新读取"}</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${dirty ? "btn-light" : ""}`}
            disabled={saveBusy}
            onClick={() => void handleSave()}
          >
            {saveBusy ? "保存中…" : dirty ? "保存工作流 *" : "保存工作流"}
          </button>
        </>
      }
    >
      {renderPoolBar()}

      <div className="wf-split">
        <div className="wf-canvas-main">
          <div className="wf-canvas-toolbar">
            <span className="muted" style={{ fontSize: "12px" }}>
              单线推进 · 点任意连接线「+」插入步骤 · 真实验收必经
            </span>
            <div className="wf-stage-toggles" role="group" aria-label="可选阶段开关">
              <button
                type="button"
                className={`chip-tab ${hasResearch ? "on" : ""}`}
                aria-pressed={hasResearch}
                onClick={() => toggleOptionalStageInTemplate("research")}
              >
                前置调研
              </button>
              <button
                type="button"
                className={`chip-tab ${hasPlan ? "on" : ""}`}
                aria-pressed={hasPlan}
                onClick={() => toggleOptionalStageInTemplate("plan")}
              >
                方案设计
              </button>
              <button
                type="button"
                className={`chip-tab ${hasReviewLoop ? "on" : ""}`}
                aria-pressed={hasReviewLoop}
                onClick={toggleReviewLoopInTemplate}
              >
                独立审查循环
              </button>
            </div>
            {draft.heterogeneous_review && reviewStatus.clash ? (
              <span className="chip chip-bad">审查与实施撞模型</span>
            ) : null}
          </div>

          <div className="wf-stage-layout">
            <div className="wf-flow-col" aria-label="工作流主流程图">
              {/* Step 01: Intake anchor */}
              <button
                type="button"
                data-wf-node="intake"
                className={`wf-node is-anchor ${selected.kind === "stage" && selected.key === "intake" ? "on" : ""}`}
                onClick={() => setSelected({ kind: "stage", key: "intake" })}
              >
                <div className="wf-node-head">
                  <span className="wf-step-num" data-step-num={formatStepNum(intakeNum)}>
                    {formatStepNum(intakeNum)}
                  </span>
                  <span className="wf-badge ro">{STAGE_META.intake.badge}</span>
                  <span className="wf-node-title">{STAGE_META.intake.title}</span>
                  <span className="wf-perm-pill ro">{STAGE_META.intake.permLabel}</span>
                </div>
                <div className="wf-node-body">
                  {renderBindingChip(draft.stage_bindings.intake, "未绑定模型")}
                </div>
              </button>

              <FlowConnector
                slot={{
                  id: "after_intake",
                  title: "在「立项与讨论」后插入只读准备步骤",
                  zone: "pre_implement",
                  insertTarget: { scope: "top", index: 0 },
                }}
                selected={selected.kind === "slot" && selected.slot.id === "after_intake"}
                onSelect={openSlotInspector}
              />

              {/* Pre-loop steps (research / plan / custom read-only) */}
              {topPreItems.map(({ step, index }, posIdx) => (
                <div
                  key={`pre-wrap-${step.kind === "agent" ? (step.id ?? `${step.stage}-${index}`) : `${step.stage}-${index}`}`}
                  className="wf-chain-unit"
                >
                  {renderAtomicFlowNode(step, { scope: "top", index }, preStepNums[posIdx] ?? null)}
                  <FlowConnector
                    slot={{
                      id: `after_top_${index}`,
                      title: "在此处插入只读准备步骤",
                      zone: "pre_implement",
                      insertTarget: { scope: "top", index: index + 1 },
                    }}
                    selected={selected.kind === "slot" && selected.slot.id === `after_top_${index}`}
                    onSelect={openSlotInspector}
                  />
                </div>
              ))}

              {/* Loop box (implement <-> verify <-> review) OR quick serial core */}
              {loopNode ? (
                <section className="wf-loop-box" aria-label="实施与审查循环">
                  <div className="wf-loop-head">
                    <span className="wf-loop-title">实施 ↔ 门禁 ↔ 审查 · 自动纠偏闭环</span>
                    <span className="chip">上限 {loopNode.max_rounds} 轮</span>
                  </div>
                  <div className="wf-loop-body">
                    {/* Three-part aligned loop return curve (top curved arrow + fluid vertical rail + bottom curve) */}
                    <div className="wf-loop-return" aria-hidden="true">
                      <svg
                        className="wf-loop-return-cap"
                        width="72"
                        height="28"
                        viewBox="0 0 72 28"
                      >
                        <path d="M 24 28 L 24 20 Q 24 12, 32 12 L 66 12" className="wf-loop-rail" />
                        <path
                          d="M 24 28 L 24 20 Q 24 12, 32 12 L 66 12"
                          className="wf-loop-stream"
                        />
                        <path d="M 60 7 L 67 12 L 60 17" className="wf-loop-arrow-head" />
                      </svg>
                      <svg
                        className="wf-loop-return-mid"
                        viewBox="0 0 72 100"
                        preserveAspectRatio="none"
                      >
                        <line
                          x1="24"
                          y1="0"
                          x2="24"
                          y2="100"
                          className="wf-loop-rail"
                          vectorEffect="non-scaling-stroke"
                        />
                        <line
                          x1="24"
                          y1="0"
                          x2="24"
                          y2="100"
                          className="wf-loop-stream"
                          vectorEffect="non-scaling-stroke"
                        />
                        <line
                          x1="24"
                          y1="0"
                          x2="24"
                          y2="100"
                          pathLength={100}
                          className="wf-loop-pulse"
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                      <svg
                        className="wf-loop-return-cap"
                        width="72"
                        height="28"
                        viewBox="0 0 72 28"
                      >
                        <path d="M 68 16 L 32 16 Q 24 16, 24 8 L 24 0" className="wf-loop-rail" />
                        <path d="M 68 16 L 32 16 Q 24 16, 24 8 L 24 0" className="wf-loop-stream" />
                      </svg>
                      <span className="wf-loop-return-tag">↺ 退回修复</span>
                    </div>

                    <div className="wf-loop-steps">
                      {loopNode.steps.map((inner, innerIdx) => {
                        const verifyIdx = loopNode.steps.findIndex((s) => s.kind === "gate");
                        const slotZone: SlotZone =
                          verifyIdx >= 0 && innerIdx < verifyIdx ? "in_implement" : "in_review";
                        const slotId = `loop_${loopIndex}_after_${innerIdx}`;
                        const isLastInner = innerIdx === loopNode.steps.length - 1;
                        return (
                          <div
                            key={`loop-inner-${inner.kind === "agent" ? (inner.id ?? `${inner.stage}-${innerIdx}`) : `${inner.stage}-${innerIdx}`}`}
                            className="wf-chain-unit"
                          >
                            {renderAtomicFlowNode(
                              inner,
                              {
                                scope: "loop",
                                loopIndex,
                                innerIndex: innerIdx,
                              },
                              loopStepNums[innerIdx] ?? null,
                            )}
                            {!isLastInner ? (
                              <FlowConnector
                                compact
                                slot={{
                                  id: slotId,
                                  title:
                                    slotZone === "in_implement"
                                      ? "在循环实施区插入写码/自检步骤"
                                      : "在循环审查区插入只读审查步骤",
                                  zone: slotZone,
                                  insertTarget: {
                                    scope: "loop",
                                    loopIndex,
                                    innerIndex: innerIdx + 1,
                                  },
                                }}
                                selected={selected.kind === "slot" && selected.slot.id === slotId}
                                onSelect={openSlotInspector}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="wf-loop-foot">
                    <span className="muted" style={{ fontSize: "11px" }}>
                      审查通过后向下进入真实验收
                    </span>
                    <button
                      type="button"
                      className={`wf-loop-tail-btn ${selected.kind === "slot" && selected.slot.id === "loop_after_review" ? "on" : ""}`}
                      data-wf-slot="loop_after_review"
                      onClick={() =>
                        openSlotInspector({
                          id: "loop_after_review",
                          title: "在独立审查后追加只读审查步骤",
                          zone: "in_review",
                          insertTarget: {
                            scope: "loop",
                            loopIndex,
                            innerIndex: loopNode.steps.length,
                          },
                        })
                      }
                    >
                      <PlusIcon />
                      <span>在审查后追加只读步骤</span>
                    </button>
                  </div>
                </section>
              ) : (
                topCoreItems.map(({ step, index }, posIdx) => (
                  <div
                    key={`core-${step.kind === "agent" ? (step.id ?? `${step.stage}-${index}`) : `${step.stage}-${index}`}`}
                    className="wf-chain-unit"
                  >
                    {renderAtomicFlowNode(
                      step,
                      { scope: "top", index },
                      coreStepNums[posIdx] ?? null,
                    )}
                    <FlowConnector
                      compact
                      slot={{
                        id: `after_core_${index}`,
                        title:
                          step.stage === "implement"
                            ? "在门禁前插入写码/自检步骤"
                            : "在主流程后插入步骤",
                        zone: step.stage === "implement" ? "in_implement" : "post_loop",
                        insertTarget: { scope: "top", index: index + 1 },
                      }}
                      selected={
                        selected.kind === "slot" && selected.slot.id === `after_core_${index}`
                      }
                      onSelect={openSlotInspector}
                    />
                  </div>
                ))
              )}

              {/* Post-loop connector into mandatory accept */}
              {loopNode ? (
                <FlowConnector
                  slot={{
                    id: "after_loop",
                    title: "在审查闭环后插入验收前步骤",
                    zone: "post_loop",
                    insertTarget: { scope: "top", index: loopIndex + 1 },
                  }}
                  selected={selected.kind === "slot" && selected.slot.id === "after_loop"}
                  onSelect={openSlotInspector}
                />
              ) : null}

              {/* Post-loop steps (mandatory accept + optional custom steps) */}
              {topPostItems.map(({ step, index }, posIdx) => (
                <div
                  key={`post-${step.kind === "agent" ? (step.id ?? `${step.stage}-${index}`) : `${step.stage}-${index}`}`}
                  className="wf-chain-unit"
                >
                  {renderAtomicFlowNode(
                    step,
                    { scope: "top", index },
                    postStepNums[posIdx] ?? null,
                  )}
                  <FlowConnector
                    slot={{
                      id: `after_post_${index}`,
                      title: "在合并交付前插入步骤",
                      zone: "post_loop",
                      insertTarget: { scope: "top", index: index + 1 },
                    }}
                    selected={
                      selected.kind === "slot" && selected.slot.id === `after_post_${index}`
                    }
                    onSelect={openSlotInspector}
                  />
                </div>
              ))}

              {topPostItems.length === 0 && !loopNode && topCoreItems.length === 0 ? (
                <FlowConnector
                  slot={{
                    id: "before_deliver",
                    title: "在合并交付前插入步骤",
                    zone: "post_loop",
                    insertTarget: { scope: "top", index: deliverInsertIdx },
                  }}
                  selected={selected.kind === "slot" && selected.slot.id === "before_deliver"}
                  onSelect={openSlotInspector}
                />
              ) : null}

              {/* Final Step: Deliver anchor */}
              <button
                type="button"
                data-wf-node="deliver"
                className={`wf-node is-anchor ${selected.kind === "deliver" ? "on" : ""}`}
                onClick={() => setSelected({ kind: "deliver" })}
              >
                <div className="wf-node-head">
                  <span className="wf-step-num" data-step-num={formatStepNum(deliverNum)}>
                    {formatStepNum(deliverNum)}
                  </span>
                  <span className="wf-badge kernel">终点</span>
                  <span className="wf-node-title">合并交付</span>
                  <span className="wf-perm-pill kernel">
                    {draft.deliver_mode === "kernel"
                      ? "内核 0 Token"
                      : draft.deliver_mode === "on_conflict"
                        ? "冲突按需"
                        : "Agent 合并"}
                  </span>
                </div>
                <div className="wf-node-body">
                  {draft.deliver_mode === "kernel" ? (
                    <span className="muted" style={{ fontSize: "11.5px" }}>
                      由确定性内核执行 merge_main，零额外 Token 开销
                    </span>
                  ) : (
                    renderBindingChip(draft.deliver_binding, "未绑定解冲突模型")
                  )}
                </div>
              </button>
            </div>

            {/* Right dock: independent advisor + collapsed aux inheritance */}
            <div className="wf-dock-col">
              <div className="wf-advisor-wrap">
                <div className="wf-advisor-bridge" aria-hidden="true">
                  <svg className="wf-advisor-bridge-svg" viewBox="0 0 28 36">
                    <line x1="3" y1="18" x2="25" y2="18" className="wf-advisor-rail" />
                    <line x1="3" y1="18" x2="25" y2="18" className="wf-advisor-stream" />
                    <line
                      x1="3"
                      y1="18"
                      x2="25"
                      y2="18"
                      pathLength={100}
                      className="wf-advisor-pulse"
                    />
                    <circle cx="3" cy="18" r="2.8" className="wf-advisor-dot" />
                    <circle cx="25" cy="18" r="2.8" className="wf-advisor-dot" />
                  </svg>
                  <span className="wf-advisor-tag">随时介入</span>
                </div>

                <button
                  type="button"
                  data-wf-node="advisor"
                  className={`wf-dock-card ${selected.kind === "stage" && selected.key === "advisor" ? "on" : ""}`}
                  onClick={() => setSelected({ kind: "stage", key: "advisor" })}
                >
                  <div className="wf-node-head">
                    <span className="wf-badge ask">独立接入</span>
                    <span className="wf-node-title">技术顾问</span>
                    <span className="wf-perm-pill ro">只读</span>
                    <span className="wf-perm-pill ro">顾问</span>
                  </div>
                  <p
                    className="muted"
                    style={{ fontSize: "11.5px", lineHeight: 1.45, margin: "4px 0 8px" }}
                  >
                    遇技术分歧或环路阻塞时只读介入决策；涉及权限/契约越界自动转人类拍板。
                  </p>
                  <div className="wf-node-body">
                    {renderBindingChip(advisorResolved.binding, "未配置顾问模型")}
                  </div>
                </button>
              </div>

              <div className="wf-aux-dock">
                <button
                  type="button"
                  className="wf-aux-toggle"
                  aria-expanded={auxExpanded}
                  onClick={() => setAuxExpanded((v) => !v)}
                >
                  <ChevronRightIcon />
                  <span>低频辅助（自动继承）</span>
                  <span className="sp" />
                  <span className="mono muted" style={{ fontSize: "11px" }}>
                    3 项
                  </span>
                </button>
                {auxExpanded ? (
                  <div className="wf-aux-list">
                    {(["triage", "resolver", "retro"] as const).map((k) => {
                      const info = STAGE_META[k];
                      const res = getEffectiveStageBinding(k);
                      const isSel = selected.kind === "stage" && selected.key === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          data-wf-node={k}
                          className={`wf-aux-row ${isSel ? "on" : ""}`}
                          onClick={() => setSelected({ kind: "stage", key: k })}
                        >
                          <div className="wf-aux-top">
                            <b>{info.title}</b>
                            <span className="wf-perm-pill ro">{info.permLabel}</span>
                          </div>
                          <div className="wf-aux-sub">
                            {!draft.stage_bindings[k] && res.inheritedFrom ? (
                              <span className="muted wf-aux-inherit">
                                自动继承 {STAGE_META[res.inheritedFrom].title}
                                {res.binding ? ` · ${res.binding.model}` : ""}
                              </span>
                            ) : (
                              renderBindingChip(res.binding, "待绑定")
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {renderInspector()}
      </div>

      {/* 新建工作流模板弹窗 */}
      <Dialog.Root open={newTplOpen} onOpenChange={setNewTplOpen}>
        <Dialog.Portal>
          <Dialog.Overlay
            className="palette-mask open centered"
            onClick={(e) => {
              if (e.target === e.currentTarget) setNewTplOpen(false);
            }}
          >
            <Dialog.Content
              className="modal-card"
              aria-label="新建工作流模板"
              aria-describedby={undefined}
            >
              <div className="modal-head">
                <Dialog.Title asChild>
                  <h2>新建工作流模板</h2>
                </Dialog.Title>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setNewTplOpen(false)}
                >
                  关闭
                </button>
              </div>
              <div className="modal-body">
                <label className="modal-field">
                  <span>模板名称</span>
                  <input
                    className="input"
                    aria-label="新模板名称"
                    placeholder="如 安全强化流 / 前端精细流"
                    value={newTplName}
                    onChange={(e) => {
                      setNewTplName((e.currentTarget as HTMLInputElement).value);
                      setNewTplError(null);
                    }}
                  />
                </label>
                <label className="modal-field">
                  <span>基于模板</span>
                  <KilnSelect
                    className="select"
                    ariaLabel="新模板基础"
                    value={newTplBaseId}
                    options={draft.templates.map((t) => ({ value: t.id, label: t.name }))}
                    onChange={(v) => setNewTplBaseId(v)}
                  />
                </label>
                <label className="modal-field">
                  <span>说明（可选）</span>
                  <input
                    className="input"
                    aria-label="新模板说明"
                    placeholder="简单描述适用任务类型"
                    value={newTplDesc}
                    onChange={(e) => setNewTplDesc((e.currentTarget as HTMLInputElement).value)}
                  />
                </label>
                {newTplError ? (
                  <p className="warn-line" role="alert">
                    {newTplError}
                  </p>
                ) : null}
              </div>
              <div className="modal-foot">
                <button type="button" className="btn" onClick={() => setNewTplOpen(false)}>
                  取消
                </button>
                <button type="button" className="btn btn-light" onClick={handleCreateTemplate}>
                  创建模板
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
    </ViewFrame>
  );
}
