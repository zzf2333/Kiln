import { Accordion, Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import {
  REASONING_EFFORTS,
  ROLE_IDS,
  type LimitsConfig,
  type PricingSyncSource,
  type ProviderEntry,
  type ProvidersConfig,
  type ReasoningEffort,
  type RoleAssignment,
  type RoleId,
  type RolesConfig,
} from "@kiln/protocol/web";
import type { AgentDescriptorInfo, AgentModeInfo } from "../api/types";
import {
  ChevronRightIcon,
  CloseIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from "../components/Icons";
import { ProviderAvatar, formatAdapterLabel } from "../components/ProviderAvatar";
import { RemoteSettingsPanel } from "../components/RemoteSettingsPanel";
import { ViewFrame } from "../components/ViewFrame";
import { fmtTime } from "../state/format";
import { isProjectSpace, useKilnStore, type SettingsTab } from "../state/store";

const ROLE_INFO: Record<
  RoleId,
  { label: string; desc: string; interactive: boolean }
> = {
  intake: {
    label: "立项对话",
    desc: "查在途任务与账本，把想法聊成立项单",
    interactive: true,
  },
  worker: {
    label: "实施",
    desc: "写代码、生成本机暂存补丁",
    interactive: false,
  },
  reviewer: {
    label: "独立审查",
    desc: "新上下文，只读固定版本",
    interactive: false,
  },
  verifier: {
    label: "真实验收",
    desc: "从真实入口跑验收场景",
    interactive: false,
  },
  triage: {
    label: "异常研判",
    desc: "核查失败与阻塞事实，决定重试或升级",
    interactive: false,
  },
  advisor: {
    label: "技术顾问",
    desc: "授权内的技术路线取舍",
    interactive: false,
  },
  resolver: {
    label: "讨论对话",
    desc: "载入整卡上下文陪你处理待决问题",
    interactive: true,
  },
};

function isFullAccessOnlyAgent(agent: AgentDescriptorInfo | undefined): boolean {
  if (!agent?.modes || agent.modes.length === 0) return false;
  return agent.modes.every(
    (m: AgentModeInfo) =>
      m.isFullAccess === true || /full[-_\s]?access|bypass/i.test(m.id),
  );
}

function modelsForAgent(
  agent: AgentDescriptorInfo | undefined,
  currentModel: string,
): Array<{ id: string; efforts: ReasoningEffort[] }> {
  const result: Array<{ id: string; efforts: ReasoningEffort[] }> = [];
  if (agent?.models) {
    for (const m of agent.models) {
      if (typeof m === "string") {
        result.push({ id: m, efforts: [...REASONING_EFFORTS] });
      } else {
        result.push({
          id: m.id,
          efforts:
            m.thinkingOptions && m.thinkingOptions.length > 0
              ? m.thinkingOptions
              : [...REASONING_EFFORTS],
        });
      }
    }
  }
  if (currentModel && !result.some((r) => r.id === currentModel)) {
    result.unshift({ id: currentModel, efforts: [...REASONING_EFFORTS] });
  }
  return result;
}

const BUILTIN_PROVIDER_IDS = new Set([
  "codex",
  "pi",
  "agy",
  "claude",
  "gemini",
  "opencode",
  "paseo",
]);

function cloneProvidersConfig(cfg: ProvidersConfig | null): ProvidersConfig {
  if (!cfg) {
    return { schema_version: 1, providers: [] };
  }
  return {
    schema_version: 1,
    providers: cfg.providers.map((p) => ({
      ...p,
      args: [...(p.args ?? [])],
      env: { ...(p.env ?? {}) },
      custom_models: [...(p.custom_models ?? [])],
      ...(p.usage_rule ? { usage_rule: { ...p.usage_rule } } : {}),
      ...(p.quota ? { quota: { ...p.quota } } : {}),
    })),
  };
}

function parseEnvLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1);
    if (key.length > 0) {
      out[key] = val;
    }
  }
  return out;
}

function formatEnvLines(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function splitArgsString(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

function pickDefaultExpandedProviderId(providers: readonly ProviderEntry[]): string {
  return providers.find((p) => p.enabled)?.id ?? providers[0]?.id ?? "";
}

export function SettingsView() {
  const { store, state } = useKilnStore();
  const {
    settingsTab,
    authMode,
    roles,
    roster,
    limits,
    pricing,
    pricingSyncBusy,
    providersConfig,
    providerStatuses,
    providerTestBusyId,
    spaces,
    agents,
    backends,
    sseStatus,
  } = state;

  const [rolesDraft, setRolesDraft] = useState<RolesConfig>(() => ({
    schema_version: 1,
    heterogeneous_review: roles.heterogeneous_review,
    roles: { ...roles.roles },
  }));
  const [providersDraft, setProvidersDraft] = useState<ProvidersConfig>(() =>
    cloneProvidersConfig(providersConfig),
  );
  const [providersDirty, setProvidersDirty] = useState(false);
  const providersDirtyRef = useRef(false);
  providersDirtyRef.current = providersDirty;
  const [argsRawByProvider, setArgsRawByProvider] = useState<Record<string, string>>(() =>
    Object.fromEntries((providersConfig?.providers ?? []).map((p) => [p.id, p.args.join(" ")])),
  );
  const [envRawByProvider, setEnvRawByProvider] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (providersConfig?.providers ?? []).map((p) => [p.id, formatEnvLines(p.env)]),
    ),
  );
  const [quotaRawByProvider, setQuotaRawByProvider] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (providersConfig?.providers ?? []).map((p) => [
        p.id,
        p.quota?.soft_daily_usd !== undefined ? String(p.quota.soft_daily_usd) : "",
      ]),
    ),
  );
  const [customModelInputs, setCustomModelInputs] = useState<Record<string, string>>({});
  const [expandedProviderId, setExpandedProviderId] = useState<string>(() =>
    pickDefaultExpandedProviderId(providersConfig?.providers ?? []),
  );
  const [newAcpOpen, setNewAcpOpen] = useState(false);
  const [newAcpId, setNewAcpId] = useState("");
  const [newAcpLabel, setNewAcpLabel] = useState("");
  const [newAcpCmd, setNewAcpCmd] = useState("");
  const [newAcpArgs, setNewAcpArgs] = useState("acp");
  const [newAcpModels, setNewAcpModels] = useState("");
  const [newAcpError, setNewAcpError] = useState<string | null>(null);
  const [limitsDraft, setLimitsDraft] = useState<LimitsConfig>(() => ({
    ...limits,
  }));
  const [pendingConfirmRole, setPendingConfirmRole] = useState<RoleId | null>(
    null,
  );
  const [pendingDeleteSpaceId, setPendingDeleteSpaceId] = useState<string | null>(
    null,
  );
  const [newModelName, setNewModelName] = useState("");
  const [showExtraPricingModels, setShowExtraPricingModels] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);

  useEffect(() => {
    setRolesDraft({
      schema_version: 1,
      heterogeneous_review: roles.heterogeneous_review,
      roles: { ...roles.roles },
    });
  }, [roles]);

  useEffect(() => {
    if (providersDirtyRef.current) return;
    const cloned = cloneProvidersConfig(providersConfig);
    setProvidersDraft(cloned);
    setArgsRawByProvider(
      Object.fromEntries(cloned.providers.map((p) => [p.id, p.args.join(" ")])),
    );
    setEnvRawByProvider(
      Object.fromEntries(cloned.providers.map((p) => [p.id, formatEnvLines(p.env)])),
    );
    setQuotaRawByProvider(
      Object.fromEntries(
        cloned.providers.map((p) => [
          p.id,
          p.quota?.soft_daily_usd !== undefined ? String(p.quota.soft_daily_usd) : "",
        ]),
      ),
    );
    setExpandedProviderId((prev) =>
      prev && cloned.providers.some((p) => p.id === prev)
        ? prev
        : pickDefaultExpandedProviderId(cloned.providers),
    );
  }, [providersConfig]);

  useEffect(() => {
    setLimitsDraft({ ...limits });
  }, [limits]);

  const tabs: Array<[SettingsTab, string]> = [
    ["roles", "角色与模型"],
    ["providers", "Providers 订阅底座"],
    ["spaces", "项目空间"],
    ["limits", "限额与熔断"],
    ["pricing", "模型单价"],
    ["remote", "远程访问"],
    ["conn", "连接与底座"],
  ];

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const allFallbackCombos: Array<{ agent: string; model: string }> = [];
  for (const a of agents) {
    for (const m of modelsForAgent(a, "")) {
      allFallbackCombos.push({ agent: a.id, model: m.id });
    }
  }
  for (const r of Object.values(rolesDraft.roles)) {
    if (
      r?.agent &&
      r?.model &&
      !allFallbackCombos.some((c) => c.agent === r.agent && c.model === r.model)
    ) {
      allFallbackCombos.push({ agent: r.agent, model: r.model });
    }
    if (
      r?.fallback &&
      !allFallbackCombos.some(
        (c) =>
          c.agent === r.fallback!.agent && c.model === r.fallback!.model,
      )
    ) {
      allFallbackCombos.push({
        agent: r.fallback.agent,
        model: r.fallback.model,
      });
    }
  }

  const updateRole = (roleId: RoleId, patch: Partial<RoleAssignment>): void => {
    const existing = rolesDraft.roles[roleId] ?? {
      agent: agents[0]?.id ?? "codex",
      model: "",
      allow_full_access_fallback: false,
    };
    const nextAssignment: RoleAssignment = {
      ...existing,
      ...patch,
    };
    setRolesDraft({
      ...rolesDraft,
      roles: {
        ...rolesDraft.roles,
        [roleId]: nextAssignment,
      },
    });
  };

  const updateProviderDraft = (
    providerId: string,
    patch: Partial<ProviderEntry>,
  ): void => {
    setProvidersDraft((prev) => ({
      ...prev,
      providers: prev.providers.map((p) =>
        p.id === providerId ? { ...p, ...patch } : p,
      ),
    }));
    setProvidersDirty(true);
  };

  const renderProvidersTab = () => {
    const statusMap = new Map(providerStatuses.map((s) => [s.provider_id, s]));
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    if (authMode === "remote") {
      return (
        <div className="remote-readonly-card">
          <div className="remote-card-head">
            <h3>仅限本机桌面端管理 Providers 订阅底座</h3>
            <span className="chip chip-ask">远程只读隔离</span>
          </div>
          <p className="muted" style={{ fontSize: "12.5px", lineHeight: 1.6 }}>
            订阅 CLI 的可执行路径、启动参数与环境变量涉及宿主机进程安全，仅允许在本机{" "}
            <span className="mono">127.0.0.1:4310</span> 查看、编辑与连通性测试。下方为脱敏后的运行状态快照：
          </p>
          <div style={{ marginTop: "14px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {providerStatuses.length === 0 ? (
              <p className="muted" style={{ fontSize: "12.5px" }}>
                暂无订阅运行状态快照
              </p>
            ) : (
              providerStatuses.map((ps) => (
                <div key={ps.provider_id} className="group" style={{ marginBottom: 0 }}>
                  <div className="group-h">
                    <ProviderAvatar providerId={ps.provider_id} />
                    <b>{ps.label}</b>
                    <small>{formatAdapterLabel(ps.adapter)}</small>
                    <span className="sp" />
                    <span
                      className={`chip ${
                        ps.status === "ready"
                          ? "chip-ok"
                          : ps.status === "cooldown"
                            ? "chip-ask"
                            : "chip-bad"
                      }`}
                    >
                      {ps.status === "ready"
                        ? "已就绪"
                        : ps.status === "cooldown"
                          ? "429 冷却中"
                          : ps.status === "auth_required"
                            ? "需登录"
                            : "不可用"}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      );
    }

    const handleAddCustomModel = (providerId: string): void => {
      const modelId = (customModelInputs[providerId] ?? "").trim();
      if (!modelId) return;
      const target = providersDraft.providers.find((p) => p.id === providerId);
      if (!target) return;
      if (target.custom_models.includes(modelId)) {
        store.showToast(`模型 ${modelId} 已存在`);
        return;
      }
      updateProviderDraft(providerId, {
        custom_models: [...target.custom_models, modelId],
      });
      setCustomModelInputs((prev) => ({ ...prev, [providerId]: "" }));
    };

    const handleCreateCustomAcp = (): void => {
      const id = newAcpId.trim();
      const label = newAcpLabel.trim();
      const cmd = newAcpCmd.trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) {
        setNewAcpError("ID 需为小写字母、数字、_ 或 -（1~48 位）");
        return;
      }
      if (providersDraft.providers.some((p) => p.id === id)) {
        setNewAcpError(`Provider "${id}" 已存在`);
        return;
      }
      if (!label || !cmd) {
        setNewAcpError("请填写显示名称与可执行命令");
        return;
      }
      const nextEntry: ProviderEntry = {
        id,
        label,
        adapter: "acp",
        enabled: true,
        command: cmd,
        args: splitArgsString(newAcpArgs),
        env: {},
        custom_models: newAcpModels
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      setProvidersDraft((prev) => ({
        ...prev,
        providers: [...prev.providers, nextEntry],
      }));
      setArgsRawByProvider((prev) => ({ ...prev, [id]: newAcpArgs }));
      setEnvRawByProvider((prev) => ({ ...prev, [id]: "" }));
      setQuotaRawByProvider((prev) => ({ ...prev, [id]: "" }));
      setProvidersDirty(true);
      setExpandedProviderId(id);
      setNewAcpOpen(false);
      store.showToast(`已添加自定义 ACP「${label}」，请点击保存生效`);
    };

    const sanitizeForSave = (cfg: ProvidersConfig): ProvidersConfig => ({
      schema_version: 1,
      providers: cfg.providers.map((p) => {
        const rawArgs = argsRawByProvider[p.id];
        const parsedArgs =
          rawArgs !== undefined ? splitArgsString(rawArgs) : p.args.filter((a) => a.length > 0);
        const rawEnv = envRawByProvider[p.id];
        const parsedEnv =
          rawEnv !== undefined
            ? parseEnvLines(rawEnv)
            : Object.fromEntries(
                Object.entries(p.env ?? {}).filter(([k]) => k.trim().length > 0),
              );
        const rawQuota = quotaRawByProvider[p.id];
        let nextQuota = p.quota ? { ...p.quota } : undefined;
        if (rawQuota !== undefined) {
          const trimmedQuota = rawQuota.trim();
          if (!trimmedQuota) {
            if (nextQuota) {
              delete nextQuota.soft_daily_usd;
            }
          } else {
            const num = Number(trimmedQuota);
            if (Number.isFinite(num) && num > 0) {
              nextQuota = { ...(nextQuota ?? {}), soft_daily_usd: num };
            }
          }
        }
        const hasQuota = Boolean(
          nextQuota &&
            (nextQuota.soft_daily_usd ||
              nextQuota.soft_weekly_usd ||
              nextQuota.soft_monthly_usd),
        );
        const entry: ProviderEntry = {
          id: p.id,
          label: p.label.trim() || p.id,
          adapter: p.adapter,
          enabled: p.enabled,
          args: parsedArgs,
          env: parsedEnv,
          custom_models: p.custom_models.map((m) => m.trim()).filter(Boolean),
          ...(p.command && p.command.trim().length > 0
            ? { command: p.command.trim() }
            : {}),
          ...(p.usage_rule ? { usage_rule: p.usage_rule } : {}),
          ...(hasQuota && nextQuota ? { quota: nextQuota } : {}),
          ...(p.paseo_url && p.paseo_url.trim().length > 0
            ? { paseo_url: p.paseo_url.trim() }
            : {}),
        };
        return entry;
      }),
    });

    return (
      <>
        <div className="sync-line">
          <span>
            自动检测本机已安装 CLI 并开关对应订阅底座（无则关闭）；点击项标题可折叠或展开详细参数与 `custom_models`。
          </span>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={refreshBusy}
              onClick={async () => {
                setRefreshBusy(true);
                try {
                  const detected = await store.detectProviders();
                  if (detected) {
                    setProvidersDirty(false);
                    setExpandedProviderId(pickDefaultExpandedProviderId(detected.providers));
                  }
                } finally {
                  setRefreshBusy(false);
                }
              }}
            >
              <RefreshIcon />
              <span>{refreshBusy ? "探测中…" : "重新探测"}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setNewAcpId("");
                setNewAcpLabel("");
                setNewAcpCmd("");
                setNewAcpArgs("acp");
                setNewAcpModels("");
                setNewAcpError(null);
                setNewAcpOpen(true);
              }}
            >
              <PlusIcon />
              <span>注册自定义 ACP</span>
            </button>
            <button
              type="button"
              className={`btn btn-sm ${providersDirty ? "btn-light" : ""}`}
              onClick={async () => {
                const ok = await store.saveSettingsSection(
                  "providers",
                  sanitizeForSave(providersDraft),
                );
                if (ok) {
                  setProvidersDirty(false);
                }
              }}
            >
              {providersDirty ? "保存 Providers *" : "保存 Providers"}
            </button>
          </div>
        </div>

        {providersDraft.providers.length === 0 ? (
          <div className="empty">
            正在读取 `config/providers.yaml`，或点击上方「重新探测」。
          </div>
        ) : (
          <Accordion.Root
            type="single"
            collapsible
            value={expandedProviderId}
            onValueChange={setExpandedProviderId}
            className="prov-accordion"
          >
            {providersDraft.providers.map((p) => {
              const st = statusMap.get(p.id);
              const agentDesc = agentMap.get(p.id);
              const discoveredModels = (agentDesc?.models ?? []).map((m) =>
                typeof m === "string" ? m : m.id,
              );
              const totalModelsCount = discoveredModels.length + p.custom_models.length;
              const isTesting = providerTestBusyId === p.id;
              const statusChip =
                !p.enabled
                  ? { cls: "", label: "已关闭" }
                  : st?.status === "ready"
                    ? { cls: "chip-ok", label: "已就绪" }
                    : st?.status === "cooldown"
                      ? { cls: "chip-ask", label: "429 冷却中" }
                      : st?.status === "auth_required"
                        ? { cls: "chip-bad", label: "需登录认证" }
                        : st?.status === "unavailable"
                          ? { cls: "chip-bad", label: "不可用" }
                          : { cls: "", label: "待检测" };

              const cap = (ok: boolean | undefined, yesText: string, noText: string) => (
                <span className={`cap ${ok ? "ok" : ""}`}>
                  {ok ? yesText : noText}
                </span>
              );

              const collapsedSummary = !p.enabled
                ? st?.detail || "未检测到本机 CLI，已自动关闭"
                : totalModelsCount > 0
                  ? `已识别 ${totalModelsCount} 个模型`
                  : p.command || p.id;

              return (
                <Accordion.Item
                  key={p.id}
                  value={p.id}
                  className={`group prov-acc-item ${!p.enabled || st?.status === "unavailable" ? "is-dim" : ""}`}
                  data-provider-card={p.id}
                >
                  <div className="group-h prov-acc-head">
                    <Accordion.Header asChild>
                      <div className="prov-acc-hwrap">
                        <Accordion.Trigger className="prov-acc-trigger">
                          <span className="prov-acc-chev" aria-hidden="true">
                            <ChevronRightIcon />
                          </span>
                          <ProviderAvatar providerId={p.id} large />
                          <div className="prov-acc-meta">
                            <b>{p.label}</b>
                            <small>
                              {formatAdapterLabel(p.adapter)}
                              {st?.version ? ` · v${st.version}` : ""}
                            </small>
                          </div>
                          <span className="prov-acc-summary" title={collapsedSummary}>
                            {collapsedSummary}
                          </span>
                          <span className={`chip ${statusChip.cls}`}>{statusChip.label}</span>
                        </Accordion.Trigger>
                      </div>
                    </Accordion.Header>
                    <div className="prov-acc-actions">
                      <label className="switch" title={p.enabled ? "已启用" : "已停用"}>
                        <input
                          type="checkbox"
                          aria-label={`启用 ${p.label}`}
                          checked={p.enabled}
                          onChange={(e) => {
                            const nextEnabled = (e.currentTarget as HTMLInputElement).checked;
                            updateProviderDraft(p.id, { enabled: nextEnabled });
                            if (nextEnabled) {
                              setExpandedProviderId(p.id);
                            } else if (expandedProviderId === p.id) {
                              setExpandedProviderId("");
                            }
                          }}
                        />
                        <span />
                      </label>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={isTesting || !p.enabled}
                        title={!p.enabled ? "请先启用该订阅底座后再测试连通" : undefined}
                        onClick={() => void store.testProvider(p.id)}
                      >
                        {isTesting ? "测试中…" : "测试连通"}
                      </button>
                      {!BUILTIN_PROVIDER_IDS.has(p.id) ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          aria-label={`移除 ${p.label}`}
                          onClick={() => {
                            setProvidersDraft((prev) => ({
                              ...prev,
                              providers: prev.providers.filter((item) => item.id !== p.id),
                            }));
                            if (expandedProviderId === p.id) {
                              setExpandedProviderId("");
                            }
                            setProvidersDirty(true);
                          }}
                        >
                          <TrashIcon />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <Accordion.Content className="prov-acc-body">
                    {st?.detail ? (
                      <div className="g-stack">
                        <span className="muted" style={{ fontSize: "12px" }}>
                          {st.detail}
                        </span>
                      </div>
                    ) : null}

                    {agentDesc ? (
                      <div className="g-stack">
                        <div className="cap-badges">
                          {cap(agentDesc.capabilities.mcpInjection, "MCP 注入", "补丁回执协议")}
                          {cap(agentDesc.capabilities.readOnlySandbox, "只读硬拦截", "沙盒 + 门禁兜底")}
                          {cap(agentDesc.capabilities.imageInput, "多模态图片", "纯文本输入")}
                          {cap(agentDesc.capabilities.cacheWriteTelemetry, "上报缓存写入", "仅上报缓存读取")}
                          {cap(agentDesc.capabilities.contextWindowTelemetry, "上下文水位", "无实时水位")}
                          <span className="cap">
                            {agentDesc.capabilities.nativeQuotaWindow ? "官方额度窗口" : "本机统计 + 软预算"}
                          </span>
                        </div>
                      </div>
                    ) : null}

                    {p.adapter !== "paseo" ? (
                      <>
                        <div className="g-row2">
                          <div className="lbl">
                            <b>可执行命令</b>
                            <p>二进制名称或绝对路径，留空按 Provider ID 查找</p>
                          </div>
                          <input
                            className="input mono input-sm"
                            aria-label={`${p.label} 命令`}
                            placeholder={p.id}
                            value={p.command ?? ""}
                            onChange={(e) =>
                              updateProviderDraft(p.id, {
                                command: (e.currentTarget as HTMLInputElement).value,
                              })
                            }
                          />
                        </div>

                        <div className="g-row2">
                          <div className="lbl">
                            <b>启动参数</b>
                            <p>空格分隔，如 acp --stdio</p>
                          </div>
                          <input
                            className="input mono input-sm"
                            aria-label={`${p.label} 参数`}
                            value={argsRawByProvider[p.id] ?? p.args.join(" ")}
                            onChange={(e) => {
                              const raw = (e.currentTarget as HTMLInputElement).value;
                              setArgsRawByProvider((prev) => ({ ...prev, [p.id]: raw }));
                              if (raw !== p.args.join(" ")) {
                                setProvidersDirty(true);
                              }
                            }}
                            onBlur={() => {
                              const raw = argsRawByProvider[p.id];
                              if (raw === undefined) return;
                              const nextArgs = splitArgsString(raw);
                              if (
                                nextArgs.length !== p.args.length ||
                                nextArgs.some((v, i) => v !== p.args[i])
                              ) {
                                updateProviderDraft(p.id, { args: nextArgs });
                              }
                            }}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="g-row2">
                        <div className="lbl">
                          <b>Paseo URL</b>
                          <p>仅作历史兼容桥接，推荐优先使用自建 ACP 与 CLI 直连</p>
                        </div>
                        <input
                          className="input mono input-sm"
                          aria-label={`${p.label} URL`}
                          placeholder="http://127.0.0.1:..."
                          value={p.paseo_url ?? ""}
                          onChange={(e) =>
                            updateProviderDraft(p.id, {
                              paseo_url: (e.currentTarget as HTMLInputElement).value,
                            })
                          }
                        />
                      </div>
                    )}

                    <div className="g-row2">
                      <div className="lbl">
                        <b>日软预算上限 ($ USD)</b>
                        <p>仅作本地统计对比提示，不会强制阻断执行</p>
                      </div>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        className="input mono input-sm"
                        aria-label={`${p.label} 日软预算`}
                        placeholder="不限制"
                        value={
                          quotaRawByProvider[p.id] ??
                          (p.quota?.soft_daily_usd !== undefined
                            ? String(p.quota.soft_daily_usd)
                            : "")
                        }
                        onChange={(e) => {
                          const raw = (e.currentTarget as HTMLInputElement).value;
                          setQuotaRawByProvider((prev) => ({ ...prev, [p.id]: raw }));
                          const initialStr =
                            p.quota?.soft_daily_usd !== undefined
                              ? String(p.quota.soft_daily_usd)
                              : "";
                          if (raw !== initialStr) {
                            setProvidersDirty(true);
                          }
                        }}
                        onBlur={() => {
                          const raw = (quotaRawByProvider[p.id] ?? "").trim();
                          const prevVal = p.quota?.soft_daily_usd;
                          if (!raw) {
                            if (prevVal === undefined) return;
                            const nextQuota = { ...(p.quota ?? {}) };
                            delete nextQuota.soft_daily_usd;
                            updateProviderDraft(p.id, { quota: nextQuota });
                            return;
                          }
                          const num = Number(raw);
                          if (Number.isFinite(num) && num > 0 && num !== prevVal) {
                            updateProviderDraft(p.id, {
                              quota: { ...(p.quota ?? {}), soft_daily_usd: num },
                            });
                          }
                        }}
                      />
                    </div>

                    <div className="g-stack">
                      <div className="lbl">
                        <b>环境变量（每行 KEY=VALUE）</b>
                      </div>
                      <textarea
                        className="role-trait-in mono"
                        style={{ minHeight: "48px", fontSize: "11.5px" }}
                        aria-label={`${p.label} 环境变量`}
                        placeholder="例如：ANTHROPIC_BASE_URL=https://..."
                        value={envRawByProvider[p.id] ?? formatEnvLines(p.env)}
                        onChange={(e) => {
                          const raw = (e.currentTarget as HTMLTextAreaElement).value;
                          setEnvRawByProvider((prev) => ({ ...prev, [p.id]: raw }));
                          if (raw !== formatEnvLines(p.env)) {
                            setProvidersDirty(true);
                          }
                        }}
                        onBlur={() => {
                          const raw = envRawByProvider[p.id];
                          if (raw === undefined) return;
                          const nextEnv = parseEnvLines(raw);
                          const prevEntries = Object.entries(p.env ?? {});
                          const nextEntries = Object.entries(nextEnv);
                          const changed =
                            prevEntries.length !== nextEntries.length ||
                            nextEntries.some(([k, v]) => p.env?.[k] !== v);
                          if (changed) {
                            updateProviderDraft(p.id, { env: nextEnv });
                          }
                        }}
                      />
                    </div>

                    <div className="g-stack">
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--t3)" }}>
                        <span>可用与自定义模型</span>
                        <span className="mono">
                          发现 {discoveredModels.length} + 自定义 {p.custom_models.length}
                        </span>
                      </div>
                      <div className="tag-list">
                        {discoveredModels.map((m) => (
                          <span key={`disc-${m}`} className="tag-pill">
                            {m}
                          </span>
                        ))}
                        {p.custom_models.map((m) => (
                          <span key={`cust-${m}`} className="tag-pill custom">
                            {m}
                            <button
                              type="button"
                              aria-label={`删除模型 ${m}`}
                              onClick={() =>
                                updateProviderDraft(p.id, {
                                  custom_models: p.custom_models.filter((item) => item !== m),
                                })
                              }
                            >
                              <CloseIcon />
                            </button>
                          </span>
                        ))}
                        <input
                          className="input mono input-sm"
                          style={{ width: "170px" }}
                          aria-label={`${p.label} 新增自定义模型`}
                          placeholder="自定义模型 ID"
                          value={customModelInputs[p.id] ?? ""}
                          onChange={(e) => {
                            const v = (e.currentTarget as HTMLInputElement).value;
                            setCustomModelInputs((prev) => ({ ...prev, [p.id]: v }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddCustomModel(p.id);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => handleAddCustomModel(p.id)}
                        >
                          添加
                        </button>
                      </div>
                    </div>
                  </Accordion.Content>
                </Accordion.Item>
              );
            })}
          </Accordion.Root>
        )}

        <Dialog.Root open={newAcpOpen} onOpenChange={setNewAcpOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="palette-mask open">
              <Dialog.Content
                className="modal-card"
                aria-label="注册自定义 ACP"
                aria-describedby={undefined}
              >
                <div className="modal-head">
                  <Dialog.Title asChild>
                    <h2>注册自定义 ACP Agent</h2>
                  </Dialog.Title>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setNewAcpOpen(false)}
                  >
                    关闭
                  </button>
                </div>
                <div className="modal-body">
                  <div className="modal-grid">
                    <label className="modal-field">
                      <span>Provider ID</span>
                      <input
                        aria-label="自定义 ACP ID"
                        className="input mono"
                        placeholder="如 cursor"
                        value={newAcpId}
                        onChange={(e) =>
                          setNewAcpId((e.currentTarget as HTMLInputElement).value)
                        }
                      />
                    </label>
                    <label className="modal-field">
                      <span>显示名称</span>
                      <input
                        aria-label="自定义 ACP 名称"
                        className="input"
                        placeholder="如 Cursor Agent"
                        value={newAcpLabel}
                        onChange={(e) =>
                          setNewAcpLabel((e.currentTarget as HTMLInputElement).value)
                        }
                      />
                    </label>
                  </div>
                  <div className="modal-grid">
                    <label className="modal-field">
                      <span>命令</span>
                      <input
                        aria-label="自定义 ACP 命令"
                        className="input mono"
                        placeholder="如 cursor-agent"
                        value={newAcpCmd}
                        onChange={(e) =>
                          setNewAcpCmd((e.currentTarget as HTMLInputElement).value)
                        }
                      />
                    </label>
                    <label className="modal-field">
                      <span>启动参数</span>
                      <input
                        aria-label="自定义 ACP 参数"
                        className="input mono"
                        placeholder="acp --stdio"
                        value={newAcpArgs}
                        onChange={(e) =>
                          setNewAcpArgs((e.currentTarget as HTMLInputElement).value)
                        }
                      />
                    </label>
                  </div>
                  <label className="modal-field">
                    <span>预登记模型（逗号或换行分隔，可选）</span>
                    <input
                      aria-label="自定义 ACP 模型"
                      className="input mono"
                      placeholder="如 claude-sonnet-4-6, gpt-5.4"
                      value={newAcpModels}
                      onChange={(e) =>
                        setNewAcpModels((e.currentTarget as HTMLInputElement).value)
                      }
                    />
                  </label>
                  {newAcpError ? (
                    <p className="warn-line" role="alert">
                      {newAcpError}
                    </p>
                  ) : null}
                </div>
                <div className="modal-foot">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setNewAcpOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn-light"
                    onClick={handleCreateCustomAcp}
                  >
                    确认添加
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>
      </>
    );
  };

  const renderRolesTab = () => {
    const worker = rolesDraft.roles.worker;
    const reviewer = rolesDraft.roles.reviewer;
    const samePrimaryModel =
      Boolean(rolesDraft.heterogeneous_review) &&
      Boolean(worker?.agent && worker?.model) &&
      worker?.agent === reviewer?.agent &&
      worker?.model === reviewer?.model;

    const fbClash =
      samePrimaryModel &&
      (!reviewer?.fallback ||
        (reviewer.fallback.agent === worker?.agent &&
          reviewer.fallback.model === worker?.model));

    const totalModels = agents.reduce(
      (sum, agent) => sum + (agent.models?.length ?? 0),
      0,
    );

    return (
      <>
        <div className="sync-line">
          <span>
            可选项来自 ExecutionBackend.listAgents()（当前已发现 {agents.length}{" "}
            个 Agent，共 {totalModels} 个模型）
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={refreshBusy}
            onClick={async () => {
              if (refreshBusy) return;
              setRefreshBusy(true);
              try {
                await store.refreshAgents(true);
              } finally {
                setRefreshBusy(false);
              }
            }}
          >
            {refreshBusy ? "刷新中…" : "重新读取"}
          </button>
        </div>

        <table className="t">
          <thead>
            <tr>
              <th style={{ width: "22%" }}>角色</th>
              <th>Agent</th>
              <th>主模型</th>
              <th style={{ width: "112px" }}>推理档位</th>
              <th>备选（撞模型/限流）</th>
              <th style={{ width: "110px" }}>允许全权兜底</th>
            </tr>
          </thead>
          <tbody>
            {ROLE_IDS.map((roleId) => {
              const info = ROLE_INFO[roleId];
              const assignment = rolesDraft.roles[roleId];
              const currentAgentId = assignment?.agent ?? "";
              const currentModel = assignment?.model ?? "";

              const candidateAgents = info.interactive
                ? agents.filter((a) => a.capabilities.interactiveChat)
                : agents;

              const selectedAgentObj = agentById.get(currentAgentId);
              const modelOpts = modelsForAgent(selectedAgentObj, currentModel);
              const selectedModelObj = modelOpts.find(
                (m) => m.id === currentModel,
              );
              const effortOpts =
                selectedModelObj?.efforts ?? [...REASONING_EFFORTS];

              const fallbackKey = assignment?.fallback
                ? `${assignment.fallback.agent} / ${assignment.fallback.model}`
                : "";

              const fullAccessOnly = isFullAccessOnlyAgent(selectedAgentObj);
              const currentIneligible =
                info.interactive &&
                Boolean(selectedAgentObj) &&
                !selectedAgentObj!.capabilities.interactiveChat;
              const isNonMcpInteractive =
                info.interactive &&
                Boolean(selectedAgentObj) &&
                selectedAgentObj!.capabilities.interactiveChat &&
                !selectedAgentObj!.capabilities.mcpInjection;

              return (
                <tr key={roleId}>
                  <td>
                    <div className="role-name">
                      {info.label}{" "}
                      <span className="mono muted" style={{ fontSize: "11px" }}>
                        {roleId}
                      </span>
                    </div>
                    <div className="role-desc">{info.desc}</div>
                    {currentIneligible ? (
                      <div className="warn-line" style={{ marginTop: "4px", fontSize: "11.5px" }}>
                        当前 {currentAgentId} 不支持实时交互对话，请更换
                      </div>
                    ) : isNonMcpInteractive ? (
                      <div className="role-desc" style={{ marginTop: "4px" }}>
                        无 MCP 模式：自动通过结构化补丁同步草稿/契约
                      </div>
                    ) : null}
                    {fullAccessOnly &&
                    !assignment?.allow_full_access_fallback ? (
                      <div className="warn-line" style={{ marginTop: "4px", fontSize: "11.5px" }}>
                        仅暴露 full-access，默认拦截派发，需先开启右侧「允许全权兜底」
                      </div>
                    ) : null}
                  </td>

                  <td>
                    <select
                      className="select"
                      aria-label={`${info.label} Agent`}
                      value={currentAgentId}
                      onChange={(e) => {
                        const nextAgentId = (e.currentTarget as HTMLSelectElement)
                          .value;
                        const nextAgent = agentById.get(nextAgentId);
                        const nextModels = modelsForAgent(nextAgent, "");
                        const firstModel = nextModels[0]?.id ?? "";
                        updateRole(roleId, {
                          agent: nextAgentId,
                          model: firstModel,
                          ...(nextAgent?.backendId
                            ? { backend_id: nextAgent.backendId }
                            : {}),
                        });
                      }}
                    >
                      {!currentAgentId ? <option value="">选择 Agent</option> : null}
                      {currentAgentId &&
                      !candidateAgents.some((a) => a.id === currentAgentId) ? (
                        <option value={currentAgentId}>
                          {currentAgentId}
                          {currentIneligible ? "（不兼容）" : ""}
                        </option>
                      ) : null}
                      {candidateAgents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label ?? a.id}
                        </option>
                      ))}
                    </select>
                  </td>

                  <td>
                    <select
                      className="select mono"
                      aria-label={`${info.label} 主模型`}
                      style={{ fontSize: "12px" }}
                      value={currentModel}
                      onChange={(e) =>
                        updateRole(roleId, {
                          model: (e.currentTarget as HTMLSelectElement).value,
                        })
                      }
                    >
                      {!currentModel ? <option value="">选择模型</option> : null}
                      {modelOpts.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  </td>

                  <td>
                    <select
                      className="select"
                      aria-label={`${info.label} 推理档位`}
                      value={assignment?.reasoning_effort ?? "medium"}
                      onChange={(e) =>
                        updateRole(roleId, {
                          reasoning_effort: (
                            e.currentTarget as HTMLSelectElement
                          ).value as ReasoningEffort,
                        })
                      }
                    >
                      {effortOpts.map((eff) => (
                        <option key={eff} value={eff}>
                          {eff}
                        </option>
                      ))}
                    </select>
                  </td>

                  <td>
                    {info.interactive ? (
                      <span className="muted" style={{ fontSize: "12px" }}>
                        —
                      </span>
                    ) : (
                      <select
                        className="select mono"
                        aria-label={`${info.label} 备选`}
                        style={{ fontSize: "11.5px" }}
                        value={fallbackKey}
                        onChange={(e) => {
                          const val = (e.currentTarget as HTMLSelectElement)
                            .value;
                          if (!val) {
                            const next = { ...rolesDraft.roles[roleId]! };
                            delete next.fallback;
                            setRolesDraft({
                              ...rolesDraft,
                              roles: { ...rolesDraft.roles, [roleId]: next },
                            });
                            return;
                          }
                          const [fbAgent, fbModel] = val.split(" / ");
                          if (fbAgent && fbModel) {
                            updateRole(roleId, {
                              fallback: { agent: fbAgent, model: fbModel },
                            });
                          }
                        }}
                      >
                        <option value="">无备选</option>
                        {allFallbackCombos.map((c) => {
                          const k = `${c.agent} / ${c.model}`;
                          return (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          );
                        })}
                      </select>
                    )}
                  </td>

                  <td>
                    <label className="switch">
                      <input
                        type="checkbox"
                        aria-label={`${info.label} 允许全权兜底`}
                        checked={Boolean(
                          assignment?.allow_full_access_fallback,
                        )}
                        onChange={(e) => {
                          const checked = (
                            e.currentTarget as HTMLInputElement
                          ).checked;
                          if (checked) {
                            setPendingConfirmRole(roleId);
                          } else {
                            if (pendingConfirmRole === roleId) {
                              setPendingConfirmRole(null);
                            }
                            updateRole(roleId, {
                              allow_full_access_fallback: false,
                            });
                          }
                        }}
                      />
                      <span />
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {pendingConfirmRole ? (
          <div className="confirm-bar" role="alertdialog" aria-label="确认开启全权兜底">
            <p>
              高风险确认：仅为「{ROLE_INFO[pendingConfirmRole].label}」显式启用{" "}
              <span className="mono">allow_full_access_fallback</span>？当所选
              Provider 仅暴露 full-access 模式时，守护进程将放行无人值守派发。
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className="btn btn-light btn-sm"
                onClick={() => {
                  updateRole(pendingConfirmRole, {
                    allow_full_access_fallback: true,
                  });
                  setPendingConfirmRole(null);
                }}
              >
                确认开启
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPendingConfirmRole(null)}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        {samePrimaryModel ? (
          <p className="warn-line" role="alert">
            {fbClash
              ? `独立审查与实施主模型和备选均撞车（${worker?.agent} / ${worker?.model}），请为独立审查选择不同的备选模型`
              : `独立审查与实施当前选了同一模型（${worker?.agent} / ${worker?.model}），派发时将自动切换为备选（${reviewer?.fallback?.agent} / ${reviewer?.fallback?.model}）`}
          </p>
        ) : null}

        <div className="setting-row">
          <div>
            <span>审查避开实施所用模型</span>
            <p>独立审查与实施撞同一模型时，自动改用该行的备选模型</p>
          </div>
          <label className="switch" style={{ justifySelf: "end" }}>
            <input
              type="checkbox"
              checked={rolesDraft.heterogeneous_review}
              onChange={(e) =>
                setRolesDraft({
                  ...rolesDraft,
                  heterogeneous_review: (e.currentTarget as HTMLInputElement)
                    .checked,
                })
              }
            />
            <span />
          </label>
        </div>

        <div
          style={{
            marginTop: "20px",
            display: "flex",
            gap: "12px",
            alignItems: "center",
          }}
        >
          <button
            type="button"
            className="btn btn-light"
            onClick={() => void store.saveSettingsSection("roles", rolesDraft)}
          >
            保存
          </button>
          <span className="muted">
            修改写入 config/roles.yaml，只影响之后派发的执行
          </span>
        </div>
      </>
    );
  };

  const renderSpacesTab = () => {
    const customSpaces = Object.values(spaces)
      .filter((sp) => sp.id !== "local")
      .sort((a, b) => {
        const pinA = Boolean(a.pinned);
        const pinB = Boolean(b.pinned);
        if (pinA !== pinB) return pinA ? -1 : 1;
        return a.id.localeCompare(b.id);
      });

    return (
      <>
        <div className="sync-line">
          <span>
            项目空间决定代码任务的仓库路径、工作树基准分支、默认验收命令与结构化脚本（setup 在新建工作树时自动运行），立项对话将直接进入对应仓库目录探索。
          </span>
          <button
            type="button"
            className="btn btn-light btn-sm"
            onClick={() => store.openAddSpaceModal(false)}
          >
            + 添加项目空间
          </button>
        </div>

        <div className="setting-row">
          <div>
            <span>
              本机与临时 <span className="mono muted">local</span>
            </span>
            <p>内置空间：用于本机配置修改（host_scoped）与临时沙盒任务（scratch_dir），不可删除</p>
          </div>
          <span className="chip" style={{ justifySelf: "end" }}>
            内置
          </span>
        </div>

        {customSpaces.length === 0 ? (
          <div className="empty">
            暂无已登记的项目空间。点击右上角「+ 添加项目空间」或在项目根目录运行{" "}
            <span className="mono">kiln space add .</span>。
          </div>
        ) : (
          <table className="t" style={{ marginTop: "8px" }}>
            <thead>
              <tr>
                <th style={{ width: "22%" }}>空间</th>
                <th>仓库路径</th>
                <th style={{ width: "96px" }}>默认分支</th>
                <th style={{ width: "160px" }}>验收 / 脚本</th>
                <th style={{ width: "176px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {customSpaces.map((sp) => {
                const validRepo = isProjectSpace(sp);
                const scriptKeys = sp.scripts
                  ? Object.entries(sp.scripts)
                      .filter(([, cmd]) => Boolean(cmd && cmd.trim()))
                      .map(([k]) => k)
                  : [];
                return (
                  <tr key={sp.id}>
                    <td>
                      <div className="role-name" style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                        <span>{sp.name}</span>
                        {sp.pinned ? (
                          <span className="chip chip-live" style={{ height: "18px", fontSize: "10.5px" }}>
                            置顶
                          </span>
                        ) : null}
                      </div>
                      <div className="role-desc mono">{sp.id}</div>
                    </td>
                    <td className="mono" style={{ fontSize: "12px", wordBreak: "break-all" }}>
                      {validRepo ? (
                        sp.repo_path
                      ) : (
                        <span className="warn-line" style={{ marginTop: "0" }}>
                          缺少 repo_path，请点击编辑绑定本地 Git 仓库
                        </span>
                      )}
                    </td>
                    <td className="mono">{sp.default_branch}</td>
                    <td className="mono" style={{ fontSize: "12px" }}>
                      <div>{sp.default_accept_cmd || <span className="muted">—</span>}</div>
                      {scriptKeys.length > 0 ? (
                        <div className="muted" style={{ fontSize: "11px", marginTop: "2px" }}>
                          脚本: {scriptKeys.join(" · ")}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: "6px" }}>
                        {validRepo ? (
                          <button
                            type="button"
                            className={`btn btn-sm ${sp.pinned ? "on" : ""}`}
                            title={sp.pinned ? "取消置顶" : "置顶"}
                            aria-label={sp.pinned ? `取消置顶 ${sp.name}` : `置顶 ${sp.name}`}
                            onClick={() => void store.toggleSpacePin(sp.id)}
                          >
                            <PinIcon />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => store.openEditSpaceModal(sp.id)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => setPendingDeleteSpaceId(sp.id)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {pendingDeleteSpaceId ? (
          <div className="confirm-bar" role="alertdialog" aria-label="确认删除项目空间">
            <p>
              确认删除项目空间 <span className="mono">{pendingDeleteSpaceId}</span>
              ？仅删除 <span className="mono">space.yaml</span> 配置，不会删除磁盘代码仓库或历史任务记录。
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  const id = pendingDeleteSpaceId;
                  setPendingDeleteSpaceId(null);
                  await store.removeSpace(id);
                }}
              >
                确认删除
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPendingDeleteSpaceId(null)}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  };

  const renderLimitsTab = () => {
    const numFields: Array<{
      key: Exclude<
        keyof LimitsConfig,
        "schema_version" | "p0_extra_slot" | "auto_retro_high_signal"
      >;
      label: string;
      desc: string;
      min: number;
    }> = [
      {
        key: "max_concurrent_slots",
        label: "同时运行的执行者槽位",
        desc: "超出的任务排队等待",
        min: 1,
      },
      {
        key: "max_waiting_wip",
        label: "等你决定的上限（注意力闸门）",
        desc: "达到上限时暂停拉起低优先级新任务；手动暂停不计入此上限",
        min: 1,
      },
      {
        key: "retries_per_stage",
        label: "单阶段自动重试次数（L0）",
        desc: "超过后唤醒异常研判 triage",
        min: 0,
      },
      {
        key: "review_rounds",
        label: "独立审查自动返工轮数（L1）",
        desc: "超过后先由异常研判核查事实，属技术取舍再唤起顾问",
        min: 0,
      },
      {
        key: "advisor_calls",
        label: "每张卡技术顾问调用上限（L2）",
        desc: "顾问仍无解就进入等你决定",
        min: 0,
      },
      {
        key: "max_card_tokens",
        label: "单卡累计 Token 软上限",
        desc: "超过后触发熔断进入等你决定",
        min: 1,
      },
    ];

    return (
      <>
        {numFields.map((f) => (
          <div key={f.key} className="setting-row">
            <div>
              <span>{f.label}</span>
              <p>{f.desc}</p>
            </div>
            <input
              type="number"
              className="input mono"
              aria-label={f.label}
              min={f.min}
              value={limitsDraft[f.key]}
              onChange={(e) => {
                const raw = Number((e.currentTarget as HTMLInputElement).value);
                if (Number.isFinite(raw)) {
                  setLimitsDraft({
                    ...limitsDraft,
                    [f.key]: Math.max(f.min, Math.trunc(raw)),
                  });
                }
              }}
            />
          </div>
        ))}

        <div className="setting-row">
          <div>
            <span>P0 紧急任务允许临时多占 1 个执行槽</span>
            <p>插到队首立即启动，但不强杀正在运行的他卡阶段</p>
          </div>
          <label className="switch" style={{ justifySelf: "end" }}>
            <input
              type="checkbox"
              aria-label="P0 紧急任务允许临时多占 1 个执行槽"
              checked={limitsDraft.p0_extra_slot}
              onChange={(e) =>
                setLimitsDraft({
                  ...limitsDraft,
                  p0_extra_slot: (e.currentTarget as HTMLInputElement).checked,
                })
              }
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div>
            <span>高信号终态自动 AI 归因复盘</span>
            <p>
              默认关闭；0-Token 确定性复盘始终自动落盘。开启后仅对失败、取消或发生返工/升级/验收打回的高信号任务自动唤起冷只读复盘分析
            </p>
          </div>
          <label className="switch" style={{ justifySelf: "end" }}>
            <input
              type="checkbox"
              aria-label="高信号终态自动 AI 归因复盘"
              checked={Boolean(limitsDraft.auto_retro_high_signal)}
              onChange={(e) =>
                setLimitsDraft({
                  ...limitsDraft,
                  auto_retro_high_signal: (e.currentTarget as HTMLInputElement)
                    .checked,
                })
              }
            />
            <span />
          </label>
        </div>

        <div style={{ marginTop: "20px" }}>
          <button
            type="button"
            className="btn btn-light"
            onClick={() =>
              void store.saveSettingsSection("limits", limitsDraft)
            }
          >
            保存
          </button>
        </div>
      </>
    );
  };

  const formatPricingSource = (source: PricingSyncSource): string =>
    source === "models.dev"
      ? "models.dev"
      : source === "litellm"
        ? "LiteLLM"
        : "内置离线基线";

  const renderPricingTab = () => {
    const roleUsageByModel = new Map<string, string[]>();
    const recordRoleModel = (rawModel: string | undefined, tag: string): void => {
      const m = rawModel?.trim();
      if (!m) return;
      const list = roleUsageByModel.get(m) ?? [];
      if (!list.includes(tag)) {
        list.push(tag);
      }
      roleUsageByModel.set(m, list);
    };
    for (const roleId of ROLE_IDS) {
      const assignment = roles.roles[roleId];
      if (!assignment) continue;
      recordRoleModel(assignment.model, ROLE_INFO[roleId].label);
      if (assignment.fallback?.model) {
        recordRoleModel(
          assignment.fallback.model,
          `${ROLE_INFO[roleId].label}·备选`,
        );
      }
    }
    for (const rKey of Object.keys(roster.roster)) {
      const entry = roster.roster[rKey];
      if (!entry || !entry.enabled || entry.mode !== "agent") continue;
      recordRoleModel(entry.primary?.model, entry.name);
      for (const fb of entry.fallbacks ?? []) {
        recordRoleModel(fb.model, `${entry.name}·备选`);
      }
    }

    const customModels = new Set(pricing.custom_models ?? []);
    const configuredModelIds = Array.from(roleUsageByModel.keys()).sort();
    const usedModelIds = Object.keys(state.usage.byModel ?? {})
      .map((m) => m.trim())
      .filter((m) => m.length > 0 && !roleUsageByModel.has(m))
      .sort();
    const usedSet = new Set(usedModelIds);
    const basePrimarySet = new Set([...configuredModelIds, ...usedModelIds]);
    const customOnlyIds = Array.from(customModels)
      .filter((m) => m.trim().length > 0 && !basePrimarySet.has(m))
      .sort();
    const primaryModelIds =
      configuredModelIds.length > 0 || usedModelIds.length > 0
        ? [...configuredModelIds, ...usedModelIds, ...customOnlyIds]
        : Object.keys(pricing.models).sort();
    const primarySet = new Set(primaryModelIds);
    const extraModelIds = Object.keys(pricing.models)
      .filter((m) => !primarySet.has(m))
      .sort();
    const visibleModelIds = showExtraPricingModels
      ? [...primaryModelIds, ...extraModelIds]
      : primaryModelIds;

    const addModel = (): void => {
      const m = newModelName.trim();
      if (!m) return;
      store.updatePricingLocal(m, "in", pricing.models[m]?.in ?? 1);
      setNewModelName("");
    };

    const handlePriceInput = (
      modelId: string,
      field: "in" | "cached" | "cache_write" | "out",
      rawStr: string,
    ): void => {
      if (rawStr.trim() === "") {
        if (field === "cache_write") {
          store.updatePricingLocal(modelId, "cache_write", undefined);
        }
        return;
      }
      const num = Number(rawStr);
      if (Number.isFinite(num) && num >= 0) {
        store.updatePricingLocal(modelId, field, num);
      }
    };

    return (
      <>
        <div className="sync-line">
          <span>
            仅展示当前角色已配置使用的模型单价（按 models.dev / LiteLLM / 本机模型目录与离线基线自动同步，支持手动覆盖微调，美元 / 百万 Token）。
            {pricing.sync ? (
              <>
                {" "}
                最近同步：<span className="mono">{formatPricingSource(pricing.sync.source)}</span> ·{" "}
                <span className="mono">{fmtTime(pricing.sync.synced_at)}</span>
              </>
            ) : (
              " 尚未执行自动同步。"
            )}
          </span>
          <button
            type="button"
            className="btn btn-light btn-sm"
            disabled={pricingSyncBusy}
            onClick={() => void store.syncPricing({ force: true })}
          >
            {pricingSyncBusy ? "同步中…" : "立即同步单价"}
          </button>
        </div>

        <table className="t">
          <thead>
            <tr>
              <th>模型标识</th>
              <th style={{ width: "120px" }}>输入单价 ($/1M)</th>
              <th style={{ width: "120px" }}>缓存命中 ($/1M)</th>
              <th style={{ width: "120px" }}>缓存写 ($/1M)</th>
              <th style={{ width: "120px" }}>输出单价 ($/1M)</th>
            </tr>
          </thead>
          <tbody>
            {visibleModelIds.map((m) => {
              const p = pricing.models[m];
              const isCustom = customModels.has(m);
              const roleTags = roleUsageByModel.get(m) ?? [];
              const writePlaceholder = p
                ? /claude/i.test(m)
                  ? "默认 1.25×"
                  : "同输入"
                : "可选";
              return (
                <tr key={m}>
                  <td>
                    <div className="pricing-model-cell">
                      <span className="mono">{m}</span>
                      {roleTags.length > 0 ? (
                        <span className="pricing-role-tags">
                          {roleTags.map((tag) => (
                            <span key={tag} className="chip">
                              {tag}
                            </span>
                          ))}
                        </span>
                      ) : usedSet.has(m) ? (
                        <span className="chip">已计费</span>
                      ) : null}
                      {!p ? <span className="chip chip-ask">未匹配</span> : null}
                      {isCustom ? (
                        <>
                          <span className="chip">自定义</span>
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-label={`恢复 ${m} 同步单价`}
                            disabled={pricingSyncBusy}
                            onClick={() => void store.restoreModelPricing(m)}
                          >
                            恢复同步价
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="input mono"
                      aria-label={`${m} 输入单价`}
                      placeholder={p ? undefined : "待填"}
                      value={p ? p.in : ""}
                      onChange={(e) =>
                        handlePriceInput(
                          m,
                          "in",
                          (e.currentTarget as HTMLInputElement).value,
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.005"
                      min="0"
                      className="input mono"
                      aria-label={`${m} 缓存命中`}
                      placeholder={p ? undefined : "待填"}
                      value={p ? p.cached : ""}
                      onChange={(e) =>
                        handlePriceInput(
                          m,
                          "cached",
                          (e.currentTarget as HTMLInputElement).value,
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="input mono"
                      aria-label={`${m} 缓存写`}
                      placeholder={writePlaceholder}
                      value={p?.cache_write !== undefined ? p.cache_write : ""}
                      onChange={(e) =>
                        handlePriceInput(
                          m,
                          "cache_write",
                          (e.currentTarget as HTMLInputElement).value,
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      className="input mono"
                      aria-label={`${m} 输出单价`}
                      placeholder={p ? undefined : "待填"}
                      value={p ? p.out : ""}
                      onChange={(e) =>
                        handlePriceInput(
                          m,
                          "out",
                          (e.currentTarget as HTMLInputElement).value,
                        )
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {extraModelIds.length > 0 ? (
          <div className="pricing-extra-bar">
            <span>已隐藏 {extraModelIds.length} 个未绑定到当前角色的模型价格</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowExtraPricingModels((prev) => !prev)}
            >
              {showExtraPricingModels
                ? "收起未配置模型"
                : `显示其他已记录/历史模型 (${extraModelIds.length})`}
            </button>
          </div>
        ) : null}

        <div
          style={{
            marginTop: "14px",
            display: "flex",
            gap: "8px",
            maxWidth: "360px",
          }}
        >
          <input
            type="text"
            className="input mono"
            placeholder="新增模型标识（如 gpt-5.4）"
            value={newModelName}
            onChange={(e) =>
              setNewModelName((e.currentTarget as HTMLInputElement).value)
            }
          />
          <button type="button" className="btn" onClick={addModel}>
            添加模型
          </button>
        </div>

        <div style={{ marginTop: "20px" }}>
          <button
            type="button"
            className="btn btn-light"
            onClick={() => void store.saveSettingsSection("pricing", pricing)}
          >
            保存单价表
          </button>
        </div>
      </>
    );
  };

  const renderConnTab = () => (
    <>
      <div className="setting-row">
        <div>
          <span>Kiln 版本与运行模式</span>
          <p>
            当前接入：
            {state.authMode === "remote" ? "远程认证访问" : "本机回环 / 桌面端"} · 与运行中 kilnd 实时同步
          </p>
        </div>
        <span className="chip mono" style={{ justifySelf: "end" }}>
          {state.daemonVersion ? `v${state.daemonVersion}` : "未获取"}
        </span>
      </div>

      <div className="setting-row setting-row-wide">
        <div>
          <span>外观主题</span>
          <p>
            支持浅色、深色或跟随系统自动切换（当前生效：
            {state.resolvedTheme === "light" ? "浅色" : "深色"}）
          </p>
        </div>
        <div
          className="seg"
          role="radiogroup"
          aria-label="外观主题设置"
          style={{ justifySelf: "end" }}
        >
          <button
            type="button"
            role="radio"
            aria-checked={state.themePreference === "system"}
            className={state.themePreference === "system" ? "on" : ""}
            onClick={() => store.setThemePreference("system")}
          >
            跟随系统
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={state.themePreference === "light"}
            className={state.themePreference === "light" ? "on" : ""}
            onClick={() => store.setThemePreference("light")}
          >
            浅色
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={state.themePreference === "dark"}
            className={state.themePreference === "dark" ? "on" : ""}
            onClick={() => store.setThemePreference("dark")}
          >
            深色
          </button>
        </div>
      </div>

      {backends.length > 0 ? (
        backends.map((b, idx) => (
          <div key={b.backendId ?? b.id ?? idx} className="setting-row">
            <div>
              <span>{b.backendId ?? b.id ?? "ExecutionBackend"}</span>
              <p>{b.detail ?? b.url ?? "包在自有 ExecutionBackend 接口之后"}</p>
            </div>
            <span
              className={`chip ${b.connected ? "chip-ok" : "chip-bad"}`}
              style={{ justifySelf: "end" }}
            >
              {b.connected ? "已连接" : b.status ?? "未连接"}
            </span>
          </div>
        ))
      ) : (
        <div className="setting-row">
          <div>
            <span>Paseo daemon（V1 自动执行底座）</span>
            <p>
              当前未上报独立底座健康快照；所有派发经自有 ExecutionBackend 接口隔离
            </p>
          </div>
          <span className="chip" style={{ justifySelf: "end" }}>
            待检测
          </span>
        </div>
      )}

      <div className="setting-row">
        <div>
          <span>实时事件流（SSE /api/events）</span>
          <p>支持单调递增 seq 与断线 Last-Event-ID 增量重放</p>
        </div>
        <span
          className={`chip ${sseStatus === "connected" ? "chip-ok" : ""}`}
          style={{ justifySelf: "end" }}
        >
          {sseStatus === "connected"
            ? "已连接"
            : sseStatus === "reconnecting"
              ? "重连中"
              : "未连接"}
        </span>
      </div>

      <div className="setting-row">
        <div>
          <span>外部只读巡检 / Passkey</span>
          <p>external_only 巡检与 Passkey / Web Push 属于后续版本；远程访问与 Bark/ntfy/Webhook 推送请在「远程访问」标签页管理</p>
        </div>
        <span className="chip" style={{ justifySelf: "end" }}>
          后续规划
        </span>
      </div>
    </>
  );

  return (
    <ViewFrame left={<h1 className="tb-title">设置</h1>}>
      <div className="page">
        <div className="page-inner" style={{ maxWidth: "980px" }}>
          <div className="tabs" role="tablist">
            {tabs.map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={settingsTab === k}
                className={settingsTab === k ? "on" : ""}
                onClick={() => store.setSettingsTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
          {settingsTab === "roles"
            ? renderRolesTab()
            : settingsTab === "providers"
              ? renderProvidersTab()
              : settingsTab === "spaces"
                ? renderSpacesTab()
                : settingsTab === "limits"
                  ? renderLimitsTab()
                  : settingsTab === "pricing"
                    ? renderPricingTab()
                    : settingsTab === "remote"
                      ? <RemoteSettingsPanel />
                      : renderConnTab()}
        </div>
      </div>
    </ViewFrame>
  );
}
