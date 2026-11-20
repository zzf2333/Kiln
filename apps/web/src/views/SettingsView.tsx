import { useEffect, useState } from "preact/hooks";
import {
  REASONING_EFFORTS,
  ROLE_IDS,
  type LimitsConfig,
  type ReasoningEffort,
  type RoleAssignment,
  type RoleId,
  type RolesConfig,
} from "@kiln/protocol/web";
import type { AgentDescriptorInfo, AgentModeInfo } from "../api/types";
import { RemoteSettingsPanel } from "../components/RemoteSettingsPanel";
import { ViewFrame } from "../components/ViewFrame";
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

export function SettingsView() {
  const { store, state } = useKilnStore();
  const { settingsTab, roles, limits, pricing, spaces, agents, backends, sseStatus } =
    state;

  const [rolesDraft, setRolesDraft] = useState<RolesConfig>(() => ({
    schema_version: 1,
    heterogeneous_review: roles.heterogeneous_review,
    roles: { ...roles.roles },
  }));
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
  const [refreshBusy, setRefreshBusy] = useState(false);

  useEffect(() => {
    setRolesDraft({
      schema_version: 1,
      heterogeneous_review: roles.heterogeneous_review,
      roles: { ...roles.roles },
    });
  }, [roles]);

  useEffect(() => {
    setLimitsDraft({ ...limits });
  }, [limits]);

  const tabs: Array<[SettingsTab, string]> = [
    ["roles", "角色与模型"],
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
        <div class="sync-line">
          <span>
            可选项来自 ExecutionBackend.listAgents()（当前已发现 {agents.length}{" "}
            个 Agent，共 {totalModels} 个模型）
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
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

        <table class="t">
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
                    <div class="role-name">
                      {info.label}{" "}
                      <span class="mono muted" style={{ fontSize: "11px" }}>
                        {roleId}
                      </span>
                    </div>
                    <div class="role-desc">{info.desc}</div>
                    {currentIneligible ? (
                      <div class="warn-line" style={{ marginTop: "4px", fontSize: "11.5px" }}>
                        当前 {currentAgentId} 不支持实时交互对话，请更换
                      </div>
                    ) : isNonMcpInteractive ? (
                      <div class="role-desc" style={{ marginTop: "4px" }}>
                        无 MCP 模式：自动通过结构化补丁同步草稿/契约
                      </div>
                    ) : null}
                    {fullAccessOnly &&
                    !assignment?.allow_full_access_fallback ? (
                      <div class="warn-line" style={{ marginTop: "4px", fontSize: "11.5px" }}>
                        仅暴露 full-access，默认拦截派发，需先开启右侧「允许全权兜底」
                      </div>
                    ) : null}
                  </td>

                  <td>
                    <select
                      class="select"
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
                      class="select mono"
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
                      class="select"
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
                      <span class="muted" style={{ fontSize: "12px" }}>
                        —
                      </span>
                    ) : (
                      <select
                        class="select mono"
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
                    <label class="switch">
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
          <div class="confirm-bar" role="alertdialog" aria-label="确认开启全权兜底">
            <p>
              高风险确认：仅为「{ROLE_INFO[pendingConfirmRole].label}」显式启用{" "}
              <span class="mono">allow_full_access_fallback</span>？当所选
              Provider 仅暴露 full-access 模式时，守护进程将放行无人值守派发。
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                class="btn btn-light btn-sm"
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
                class="btn btn-sm"
                onClick={() => setPendingConfirmRole(null)}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        {samePrimaryModel ? (
          <p class="warn-line" role="alert">
            {fbClash
              ? `独立审查与实施主模型和备选均撞车（${worker?.agent} / ${worker?.model}），请为独立审查选择不同的备选模型`
              : `独立审查与实施当前选了同一模型（${worker?.agent} / ${worker?.model}），派发时将自动切换为备选（${reviewer?.fallback?.agent} / ${reviewer?.fallback?.model}）`}
          </p>
        ) : null}

        <div class="setting-row">
          <div>
            <span>审查避开实施所用模型</span>
            <p>独立审查与实施撞同一模型时，自动改用该行的备选模型</p>
          </div>
          <label class="switch" style={{ justifySelf: "end" }}>
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
            class="btn btn-light"
            onClick={() => void store.saveSettingsSection("roles", rolesDraft)}
          >
            保存
          </button>
          <span class="muted">
            修改写入 config/roles.yaml，只影响之后派发的执行
          </span>
        </div>
      </>
    );
  };

  const renderSpacesTab = () => {
    const customSpaces = Object.values(spaces)
      .filter((sp) => sp.id !== "local")
      .sort((a, b) => a.id.localeCompare(b.id));

    return (
      <>
        <div class="sync-line">
          <span>
            项目空间决定代码任务的仓库路径、工作树基准分支与默认验收命令，立项对话将直接进入对应仓库目录探索。
          </span>
          <button
            type="button"
            class="btn btn-light btn-sm"
            onClick={() => store.openAddSpaceModal(false)}
          >
            + 添加项目空间
          </button>
        </div>

        <div class="setting-row">
          <div>
            <span>
              本机与临时 <span class="mono muted">local</span>
            </span>
            <p>内置空间：用于本机配置修改（host_scoped）与临时沙盒任务（scratch_dir），不可删除</p>
          </div>
          <span class="chip" style={{ justifySelf: "end" }}>
            内置
          </span>
        </div>

        {customSpaces.length === 0 ? (
          <div class="empty">
            暂无已登记的项目空间。点击右上角「+ 添加项目空间」或在项目根目录运行{" "}
            <span class="mono">kiln space add .</span>。
          </div>
        ) : (
          <table class="t" style={{ marginTop: "8px" }}>
            <thead>
              <tr>
                <th style={{ width: "20%" }}>空间</th>
                <th>仓库路径</th>
                <th style={{ width: "100px" }}>默认分支</th>
                <th style={{ width: "160px" }}>默认验收命令</th>
                <th style={{ width: "140px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {customSpaces.map((sp) => {
                const validRepo = isProjectSpace(sp);
                return (
                  <tr key={sp.id}>
                    <td>
                      <div class="role-name">{sp.name}</div>
                      <div class="role-desc mono">{sp.id}</div>
                    </td>
                    <td class="mono" style={{ fontSize: "12px", wordBreak: "break-all" }}>
                      {validRepo ? (
                        sp.repo_path
                      ) : (
                        <span class="warn-line" style={{ marginTop: "0" }}>
                          缺少 repo_path，请点击编辑绑定本地 Git 仓库
                        </span>
                      )}
                    </td>
                    <td class="mono">{sp.default_branch}</td>
                    <td class="mono" style={{ fontSize: "12px" }}>
                      {sp.default_accept_cmd || <span class="muted">—</span>}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          class="btn btn-sm"
                          onClick={() => store.openEditSpaceModal(sp.id)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          class="btn btn-sm btn-danger"
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
          <div class="confirm-bar" role="alertdialog" aria-label="确认删除项目空间">
            <p>
              确认删除项目空间 <span class="mono">{pendingDeleteSpaceId}</span>
              ？仅删除 <span class="mono">space.yaml</span> 配置，不会删除磁盘代码仓库或历史任务记录。
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                class="btn btn-danger btn-sm"
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
                class="btn btn-sm"
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
      key: Exclude<keyof LimitsConfig, "schema_version" | "p0_extra_slot">;
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
          <div key={f.key} class="setting-row">
            <div>
              <span>{f.label}</span>
              <p>{f.desc}</p>
            </div>
            <input
              type="number"
              class="input mono"
              aria-label={f.label}
              min={f.min}
              value={limitsDraft[f.key]}
              onInput={(e) => {
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

        <div class="setting-row">
          <div>
            <span>P0 紧急任务允许临时多占 1 个执行槽</span>
            <p>插到队首立即启动，但不强杀正在运行的他卡阶段</p>
          </div>
          <label class="switch" style={{ justifySelf: "end" }}>
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

        <div style={{ marginTop: "20px" }}>
          <button
            type="button"
            class="btn btn-light"
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

  const renderPricingTab = () => {
    const modelEntries = Object.entries(pricing.models);
    const addModel = (): void => {
      const m = newModelName.trim();
      if (!m) return;
      store.updatePricingLocal(m, "in", pricing.models[m]?.in ?? 1);
      setNewModelName("");
    };

    return (
      <>
        <div class="sync-line">
          <span>
            统一按官方 API 标价折算（美元 / 百万 Token），写入
            config/pricing.yaml，修改后左下角与用量页实时重算
          </span>
        </div>

        <table class="t">
          <thead>
            <tr>
              <th>模型标识</th>
              <th style={{ width: "150px" }}>输入单价 ($/1M)</th>
              <th style={{ width: "150px" }}>缓存命中 ($/1M)</th>
              <th style={{ width: "150px" }}>输出单价 ($/1M)</th>
            </tr>
          </thead>
          <tbody>
            {modelEntries.map(([m, p]) => (
              <tr key={m}>
                <td class="mono">{m}</td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    class="input mono"
                    aria-label={`${m} 输入单价`}
                    value={p.in}
                    onInput={(e) =>
                      store.updatePricingLocal(
                        m,
                        "in",
                        Number((e.currentTarget as HTMLInputElement).value),
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.005"
                    min="0"
                    class="input mono"
                    aria-label={`${m} 缓存命中`}
                    value={p.cached}
                    onInput={(e) =>
                      store.updatePricingLocal(
                        m,
                        "cached",
                        Number((e.currentTarget as HTMLInputElement).value),
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    class="input mono"
                    aria-label={`${m} 输出单价`}
                    value={p.out}
                    onInput={(e) =>
                      store.updatePricingLocal(
                        m,
                        "out",
                        Number((e.currentTarget as HTMLInputElement).value),
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

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
            class="input mono"
            placeholder="新增模型标识（如 gpt-5.4）"
            value={newModelName}
            onInput={(e) =>
              setNewModelName((e.currentTarget as HTMLInputElement).value)
            }
          />
          <button type="button" class="btn" onClick={addModel}>
            添加模型
          </button>
        </div>

        <div style={{ marginTop: "20px" }}>
          <button
            type="button"
            class="btn btn-light"
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
      {backends.length > 0 ? (
        backends.map((b, idx) => (
          <div key={b.backendId ?? b.id ?? idx} class="setting-row">
            <div>
              <span>{b.backendId ?? b.id ?? "ExecutionBackend"}</span>
              <p>{b.detail ?? b.url ?? "包在自有 ExecutionBackend 接口之后"}</p>
            </div>
            <span
              class={`chip ${b.connected ? "chip-ok" : "chip-bad"}`}
              style={{ justifySelf: "end" }}
            >
              {b.connected ? "已连接" : b.status ?? "未连接"}
            </span>
          </div>
        ))
      ) : (
        <div class="setting-row">
          <div>
            <span>Paseo daemon（V1 自动执行底座）</span>
            <p>
              当前未上报独立底座健康快照；所有派发经自有 ExecutionBackend 接口隔离
            </p>
          </div>
          <span class="chip" style={{ justifySelf: "end" }}>
            待检测
          </span>
        </div>
      )}

      <div class="setting-row">
        <div>
          <span>实时事件流（SSE /api/events）</span>
          <p>支持单调递增 seq 与断线 Last-Event-ID 增量重放</p>
        </div>
        <span
          class={`chip ${sseStatus === "connected" ? "chip-ok" : ""}`}
          style={{ justifySelf: "end" }}
        >
          {sseStatus === "connected"
            ? "已连接"
            : sseStatus === "reconnecting"
              ? "重连中"
              : "未连接"}
        </span>
      </div>

      <div class="setting-row">
        <div>
          <span>外部只读巡检 / Passkey</span>
          <p>external_only 巡检与 Passkey / Web Push 属于后续版本；远程访问与 Bark/ntfy/Webhook 推送请在「远程访问」标签页管理</p>
        </div>
        <span class="chip" style={{ justifySelf: "end" }}>
          后续规划
        </span>
      </div>
    </>
  );

  return (
    <ViewFrame left={<h1 class="tb-title">设置</h1>}>
      <div class="page">
        <div class="page-inner" style={{ maxWidth: "980px" }}>
          <div class="tabs" role="tablist">
            {tabs.map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={settingsTab === k}
                class={settingsTab === k ? "on" : ""}
                onClick={() => store.setSettingsTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
          {settingsTab === "roles"
            ? renderRolesTab()
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
