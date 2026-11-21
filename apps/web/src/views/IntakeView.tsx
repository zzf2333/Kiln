import { useState } from "preact/hooks";
import type { Priority, Track } from "@kiln/protocol/web";
import { ChatTimeline } from "../components/ChatTimeline";
import { CheckIcon } from "../components/Icons";
import { MarkdownContent } from "../components/MarkdownContent";
import { ViewFrame } from "../components/ViewFrame";
import { fmtTime } from "../state/format";
import {
  getProjectSpaces,
  isProjectSpace,
  useKilnStore,
  type IntakeFormState,
} from "../state/store";

const PRIORITY_TABS: Array<[Priority, string]> = [
  ["P0", "P0 紧急"],
  ["P1", "P1 重要"],
  ["P2", "P2 普通"],
  ["P3", "P3 有空"],
];

const TRACK_TABS: Array<[Exclude<Track, "L3">, string]> = [
  ["L1", "L1 快车道"],
  ["L2", "L2 标准交付"],
];

export function IntakeView() {
  const { store, state } = useKilnStore();
  const [chatInput, setChatInput] = useState("");
  const [editingBriefRaw, setEditingBriefRaw] = useState(false);
  const [contractEditOpen, setContractEditOpen] = useState(false);

  const {
    intakeDraftId,
    intakeForm,
    intakeRightTab,
    intakeProgressLogs,
    intakeMessages,
    intakeBusy,
    intakeActiveOpen,
    authMode,
    pickDirBusy,
    drafts,
    spaces,
    draftOpen,
  } = state;

  const isProjectMode = intakeForm.mode === "project";
  const projectSpaces = getProjectSpaces(spaces);
  const selectedProject =
    isProjectMode && isProjectSpace(spaces[intakeForm.space])
      ? spaces[intakeForm.space]
      : undefined;
  const projectBlocked = isProjectMode && !selectedProject;
  const hasDraftOrChat =
    Boolean(intakeDraftId) ||
    intakeMessages.length > 1 ||
    intakeForm.title.trim().length > 0 ||
    intakeForm.brief_markdown.trim().length > 0;

  const scopeList = intakeForm.scope
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const requiredChecks: Array<[keyof IntakeFormState, boolean]> = [
    ["title", intakeForm.title.trim().length > 0],
    ["priority", intakeForm.priority !== ""],
    ["space", isProjectMode ? Boolean(selectedProject) : intakeForm.space === "local"],
    ["track", intakeForm.track !== ""],
    [
      "workspace_mode",
      isProjectMode
        ? intakeForm.workspace_mode === "git_worktree"
        : intakeForm.workspace_mode === "scratch_dir" ||
          intakeForm.workspace_mode === "host_scoped",
    ],
    ["end", intakeForm.end.trim().length > 0],
    ["accept_cmd", intakeForm.accept_cmd.trim().length > 0],
    ["scope", scopeList.length > 0],
  ];
  const doneCount = requiredChecks.filter(([, ok]) => ok).length;
  const contractDoneCount = [
    requiredChecks[5]![1],
    requiredChecks[6]![1],
    requiredChecks[7]![1],
  ].filter(Boolean).length;
  const ready = doneCount === 8;

  const hasBrief = intakeForm.brief_markdown.trim().length > 0;
  const openQuestions = intakeForm.open_questions;
  const targetSummary = isProjectMode
    ? selectedProject
      ? `${selectedProject.name} (${selectedProject.id}) · 代码工作树 git_worktree`
      : `${intakeForm.space || "未选择"}（请先绑定项目仓库）`
    : `本机与临时 (local) · ${
        intakeForm.workspace_mode === "host_scoped"
          ? "本机配置修改 host_scoped"
          : "临时沙盒 scratch_dir"
      }`;

  const handleSend = async (): Promise<void> => {
    const val = chatInput.trim();
    if (!val || intakeBusy || projectBlocked) return;
    setChatInput("");
    await store.sendIntakeChat(val);
  };

  return (
    <ViewFrame
      left={
        <>
          <h1 class="tb-title">新需求</h1>
          <span class="tb-sub">
            聊清楚就能离开，未聊完保存在 drafts/ 目录
          </span>
        </>
      }
      right={
        <>
          <button
            type="button"
            class="btn btn-ghost desktop-panel-toggle"
            aria-pressed={state.desktopDraftCollapsed}
            onClick={() => store.toggleDesktopDraftCollapsed()}
          >
            {state.desktopDraftCollapsed ? "展开方案栏" : "收起侧栏"}
          </button>
          {intakeActiveOpen || hasDraftOrChat ? (
            <button
              type="button"
              class="btn btn-ghost"
              disabled={intakeBusy}
              onClick={() => void store.closeIntakeSession()}
            >
              关闭对话
            </button>
          ) : null}
          {hasDraftOrChat ? (
            <button
              type="button"
              class="btn btn-ghost"
              disabled={intakeBusy}
              onClick={() => store.startNewIntake()}
            >
              新建需求
            </button>
          ) : null}
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => store.go("board")}
          >
            返回看板
          </button>
        </>
      }
    >
      <div class={`converse ${state.desktopDraftCollapsed ? "is-panel-collapsed" : ""}`}>
        <div class="chat">
          {drafts.length > 0 ? (
            <div class="drafts">
              <span>未完成的立项</span>
              {drafts.map((d) => (
                <div
                  key={d.id}
                  class={`draft-chip ${intakeDraftId === d.id ? "is-active" : ""}`}
                >
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={() => {
                      setEditingBriefRaw(false);
                      void store.loadDraftIntoIntake(d);
                    }}
                  >
                    <span>{d.title || d.id}</span>
                    <span class="muted mono">{fmtTime(d.updated_at)}</span>
                  </button>
                  <button
                    type="button"
                    class="draft-del"
                    aria-label={`删除草稿 ${d.title || d.id}`}
                    title="删除草稿"
                    disabled={intakeBusy}
                    onClick={() => void store.deleteIntakeDraft(d.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div class="intake-bar">
            <div class="seg" role="group" aria-label="任务模式">
              <button
                type="button"
                class={isProjectMode ? "on" : ""}
                onClick={() => store.setIntakeMode("project")}
              >
                项目任务
              </button>
              <button
                type="button"
                class={!isProjectMode ? "on" : ""}
                onClick={() => store.setIntakeMode("local")}
              >
                本机 / 临时任务
              </button>
            </div>

            {isProjectMode ? (
              <div class="intake-target">
                {projectSpaces.length > 0 || (intakeForm.space && !selectedProject) ? (
                  <div class="intake-chips" role="radiogroup" aria-label="目标项目空间">
                    {projectSpaces.map((sp) => (
                      <button
                        key={sp.id}
                        type="button"
                        role="radio"
                        aria-checked={intakeForm.space === sp.id}
                        data-space-id={sp.id}
                        class={`chip-tab ${intakeForm.space === sp.id ? "on" : ""}`}
                        onClick={() => store.selectIntakeProjectSpace(sp.id)}
                      >
                        {sp.name}
                      </button>
                    ))}
                    {intakeForm.space && !selectedProject ? (
                      <span class="chip chip-bad">
                        {intakeForm.space}（未登记或缺少仓库路径）
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {selectedProject?.repo_path ? (
                  <span
                    class="intake-path mono muted"
                    title={selectedProject.repo_path}
                  >
                    {selectedProject.repo_path}
                  </span>
                ) : null}
                <button
                  type="button"
                  class={`btn btn-sm ${projectSpaces.length === 0 ? "btn-light" : ""}`}
                  onClick={() => store.openAddSpaceModal(true)}
                >
                  + 添加项目
                </button>
                {authMode === "local" ? (
                  <button
                    type="button"
                    class="btn btn-sm"
                    disabled={pickDirBusy}
                    onClick={() => void store.pickDirectoryAndAttach(true)}
                  >
                    {pickDirBusy ? "等待选择…" : "从文件目录选择"}
                  </button>
                ) : null}
              </div>
            ) : (
              <div class="intake-target">
                <span class="chip">本机与临时 (local)</span>
                <div class="seg" role="radiogroup" aria-label="本机工作区模式">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={intakeForm.workspace_mode !== "host_scoped"}
                    data-workspace-mode="scratch_dir"
                    class={intakeForm.workspace_mode !== "host_scoped" ? "on" : ""}
                    onClick={() =>
                      store.updateIntakeForm({ workspace_mode: "scratch_dir" })
                    }
                  >
                    临时沙盒
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={intakeForm.workspace_mode === "host_scoped"}
                    data-workspace-mode="host_scoped"
                    class={intakeForm.workspace_mode === "host_scoped" ? "on" : ""}
                    onClick={() =>
                      store.updateIntakeForm({ workspace_mode: "host_scoped" })
                    }
                  >
                    本机配置修改
                  </button>
                </div>
              </div>
            )}
          </div>

          <ChatTimeline
            messages={intakeMessages}
            busy={intakeBusy}
            busyLabel={
              isProjectMode && selectedProject
                ? `正在探索 ${selectedProject.name} 并整理产品方案…`
                : "正在思考并整理产品方案…"
            }
            progressLogs={intakeProgressLogs}
            roleLabel="立项助手"
            defaultAgentName="intake"
            emptySlot={
              projectBlocked ? (
                <div class="intake-empty">
                  <h3>
                    {projectSpaces.length === 0
                      ? "还没有登记项目空间"
                      : "当前所选空间未绑定 Git 仓库"}
                  </h3>
                  <p>
                    {projectSpaces.length === 0
                      ? "先绑定一个本地 Git 项目目录，立项对话就会直接进入该项目仓库只读探索代码与测试命令。"
                      : "当前草稿指向的空间尚未登记或缺少本地 Git 仓库路径，请在上方切换项目空间，或添加/补全对应空间。"}
                  </p>
                  <div class="intake-empty-actions">
                    <button
                      type="button"
                      class="btn btn-light"
                      onClick={() => store.openAddSpaceModal(true)}
                    >
                      + 添加本地 Git 项目
                    </button>
                    {authMode === "local" ? (
                      <button
                        type="button"
                        class="btn"
                        disabled={pickDirBusy}
                        onClick={() => void store.pickDirectoryAndAttach(true)}
                      >
                        {pickDirBusy ? "等待选择…" : "从文件目录选择"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      class="btn"
                      onClick={() => store.setIntakeMode("local")}
                    >
                      改用本机 / 临时任务
                    </button>
                  </div>
                </div>
              ) : null
            }
          />

          <div class="composer">
            <div class="composer-inner">
              <textarea
                id="chatIn"
                class="input"
                rows={2}
                placeholder={
                  projectBlocked
                    ? "请先添加或选择项目空间"
                    : isProjectMode && selectedProject
                      ? `描述「${selectedProject.name}」需求（Enter 发送，Shift+Enter 换行）`
                      : "描述本机或临时任务需求（Enter 发送，Shift+Enter 换行）"
                }
                value={chatInput}
                disabled={intakeBusy || projectBlocked}
                onInput={(e) =>
                  setChatInput((e.currentTarget as HTMLTextAreaElement).value)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button
                type="button"
                class="btn btn-light"
                disabled={intakeBusy || projectBlocked || !chatInput.trim()}
                onClick={() => void handleSend()}
              >
                发送
              </button>
            </div>
          </div>
        </div>

        <aside class={`draft ${draftOpen ? "open" : ""}`}>
          <div class="draft-head">
            <div class="draft-tabs" role="tablist" aria-label="立项面板">
              <button
                type="button"
                role="tab"
                aria-selected={intakeRightTab === "brief"}
                class={`draft-tab ${intakeRightTab === "brief" ? "on" : ""}`}
                onClick={() => store.setIntakeRightTab("brief")}
              >
                <span>产品方案</span>
                {openQuestions.length > 0 ? (
                  <span class="draft-tab-badge is-ask">{openQuestions.length}</span>
                ) : hasBrief ? (
                  <span class="draft-tab-badge is-ok">✓</span>
                ) : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={intakeRightTab === "settings"}
                class={`draft-tab ${intakeRightTab === "settings" ? "on" : ""}`}
                onClick={() => store.setIntakeRightTab("settings")}
              >
                <span>立项设置</span>
                <span class="mono muted" id="draftProg">
                  {doneCount} / 8
                </span>
              </button>
            </div>
            <button
              type="button"
              class="btn btn-sm draft-toggle"
              id="btnDraftToggle"
              onClick={() => store.toggleDraftOpen()}
            >
              {draftOpen ? "收起面板" : "展开编辑"}
            </button>
          </div>

          <div class="draft-body">
            {intakeRightTab === "brief" ? (
              <div class="brief-panel" role="tabpanel" aria-label="产品方案">
                <div class="brief-bar">
                  <span class="brief-status">
                    {openQuestions.length > 0
                      ? `待拍板 ${openQuestions.length} 项`
                      : hasBrief
                        ? "方案已就绪 · 提交后写入 BRIEF.md"
                        : "尚未生成产品方案"}
                  </span>
                  {hasBrief || editingBriefRaw ? (
                    <button
                      type="button"
                      class="btn btn-sm"
                      onClick={() => setEditingBriefRaw((v) => !v)}
                    >
                      {editingBriefRaw ? "完成预览" : "编辑原文"}
                    </button>
                  ) : null}
                </div>

                {openQuestions.length > 0 ? (
                  <div class="open-questions" aria-label="待拍板事项">
                    <div class="oq-title">待拍板（{openQuestions.length}）</div>
                    <ul>
                      {openQuestions.map((q, idx) => (
                        <li key={idx}>{q}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {editingBriefRaw ? (
                  <textarea
                    aria-label="产品方案原文"
                    class="input mono brief-editor"
                    rows={14}
                    placeholder="Markdown 格式产品设计方案与验收标准…"
                    value={intakeForm.brief_markdown}
                    onInput={(e) =>
                      store.updateIntakeForm({
                        brief_markdown: (e.currentTarget as HTMLTextAreaElement).value,
                      })
                    }
                  />
                ) : hasBrief ? (
                  <div class="brief-preview" data-brief-preview="true">
                    <MarkdownContent text={intakeForm.brief_markdown} />
                  </div>
                ) : (
                  <div class="brief-empty">
                    <p>
                      在左侧描述你的想法后，立项助手会先只读探索代码库与账本，输出结构化的《产品方案》(BRIEF.md) 并在本页实时预览，提交后直接驱动后续实施与验收。
                    </p>
                    <button
                      type="button"
                      class="btn btn-sm btn-light"
                      disabled={intakeBusy || projectBlocked}
                      onClick={() => void store.requestPmAutofill()}
                    >
                      让立项助手生成方案
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div class="settings-panel" role="tabpanel" aria-label="立项设置">
                <dl class="draft-fields">
                  <div class="field">
                    <div>
                      <dt>标题</dt>
                      <dd>
                        <input
                          aria-label="标题"
                          class="draft-edit"
                          placeholder="可简写，也可由助手自动提炼"
                          value={intakeForm.title}
                          onInput={(e) =>
                            store.updateIntakeForm({
                              title: (e.currentTarget as HTMLInputElement).value,
                            })
                          }
                        />
                      </dd>
                    </div>
                    <span class="field-mark">
                      {requiredChecks[0]![1] ? <CheckIcon /> : null}
                    </span>
                  </div>

                  <div class="field">
                    <div>
                      <dt>优先级</dt>
                      <dd>
                        <div class="seg seg-wrap" role="radiogroup" aria-label="优先级">
                          {PRIORITY_TABS.map(([val, label]) => (
                            <button
                              key={val}
                              type="button"
                              role="radio"
                              aria-checked={intakeForm.priority === val}
                              data-priority={val}
                              class={intakeForm.priority === val ? "on" : ""}
                              onClick={() => store.updateIntakeForm({ priority: val })}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </dd>
                    </div>
                    <span class="field-mark">
                      {requiredChecks[1]![1] ? <CheckIcon /> : null}
                    </span>
                  </div>

                  <div class="field">
                    <div>
                      <dt>轨道</dt>
                      <dd>
                        <div class="seg seg-wrap" role="radiogroup" aria-label="轨道">
                          {TRACK_TABS.map(([val, label]) => (
                            <button
                              key={val}
                              type="button"
                              role="radio"
                              aria-checked={intakeForm.track === val}
                              data-track={val}
                              class={intakeForm.track === val ? "on" : ""}
                              onClick={() => store.updateIntakeForm({ track: val })}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </dd>
                    </div>
                    <span class="field-mark">
                      {requiredChecks[3]![1] ? <CheckIcon /> : null}
                    </span>
                  </div>

                  <div class="field">
                    <div>
                      <dt>目标空间与工作区</dt>
                      <dd>
                        <div class="draft-static" aria-label="空间与工作区摘要">
                          {targetSummary}
                        </div>
                      </dd>
                    </div>
                    <span class="field-mark">
                      {requiredChecks[2]![1] && requiredChecks[4]![1] ? (
                        <CheckIcon />
                      ) : null}
                    </span>
                  </div>
                </dl>

                <div class="contract-card">
                  <div class="contract-head">
                    <div>
                      <span class="contract-title">PM 执行契约摘要</span>
                      <span class="mono muted contract-count">
                        {contractDoneCount} / 3
                      </span>
                    </div>
                    <div class="contract-actions">
                      <button
                        type="button"
                        class="btn btn-sm btn-light"
                        disabled={intakeBusy || projectBlocked}
                        onClick={() => void store.requestPmAutofill()}
                      >
                        让立项助手补全
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm"
                        aria-expanded={contractEditOpen}
                        onClick={() => setContractEditOpen((v) => !v)}
                      >
                        {contractEditOpen ? "收起编辑" : "手动编辑"}
                      </button>
                    </div>
                  </div>

                  {!contractEditOpen ? (
                    <dl class="contract-summary">
                      <div class="cs-row">
                        <dt>交付终点</dt>
                        <dd>
                          {intakeForm.end.trim() || <span class="muted">待 PM 补全</span>}
                        </dd>
                      </div>
                      <div class="cs-row">
                        <dt>验收命令</dt>
                        <dd class="mono">
                          {intakeForm.accept_cmd.trim() || (
                            <span class="muted">待 PM 补全</span>
                          )}
                        </dd>
                      </div>
                      <div class="cs-row">
                        <dt>可改范围</dt>
                        <dd class="mono">
                          {scopeList.length > 0 ? (
                            scopeList.join(", ")
                          ) : (
                            <span class="muted">待 PM 补全</span>
                          )}
                        </dd>
                      </div>
                      {intakeForm.depends_on.trim() ? (
                        <div class="cs-row">
                          <dt>前置任务</dt>
                          <dd class="mono">{intakeForm.depends_on.trim()}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : (
                    <dl class="draft-fields">
                      <div class="field">
                        <div>
                          <dt>交付终点</dt>
                          <dd>
                            <input
                              aria-label="交付终点"
                              class="draft-edit"
                              placeholder="对话生成或直接点击填写"
                              value={intakeForm.end}
                              onInput={(e) =>
                                store.updateIntakeForm({
                                  end: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span class="field-mark">
                          {requiredChecks[5]![1] ? <CheckIcon /> : null}
                        </span>
                      </div>

                      <div class="field">
                        <div>
                          <dt>验收命令</dt>
                          <dd>
                            <input
                              aria-label="验收命令"
                              class="draft-edit mono"
                              placeholder="如 pnpm test"
                              value={intakeForm.accept_cmd}
                              onInput={(e) =>
                                store.updateIntakeForm({
                                  accept_cmd: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span class="field-mark">
                          {requiredChecks[6]![1] ? <CheckIcon /> : null}
                        </span>
                      </div>

                      <div class="field">
                        <div>
                          <dt>可改范围</dt>
                          <dd>
                            <input
                              aria-label="可改范围"
                              class="draft-edit mono"
                              placeholder="多个路径用逗号或换行分隔"
                              value={intakeForm.scope}
                              onInput={(e) =>
                                store.updateIntakeForm({
                                  scope: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span class="field-mark">
                          {requiredChecks[7]![1] ? <CheckIcon /> : null}
                        </span>
                      </div>

                      <div class="field">
                        <div>
                          <dt>前置任务（可选）</dt>
                          <dd>
                            <input
                              aria-label="前置任务"
                              class="draft-edit mono"
                              placeholder="选填，如 t-118"
                              value={intakeForm.depends_on}
                              onInput={(e) =>
                                store.updateIntakeForm({
                                  depends_on: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span class="field-mark">
                          {intakeForm.depends_on.trim() ? <CheckIcon /> : null}
                        </span>
                      </div>
                    </dl>
                  )}
                </div>
              </div>
            )}
          </div>

          <div class="draft-foot">
            <button
              type="button"
              class="btn btn-light"
              id="btnCreateTask"
              style={{ height: "36px", justifyContent: "center" }}
              disabled={!ready || intakeBusy || projectBlocked}
              onClick={() => void store.commitIntakeTask()}
            >
              开始推进
            </button>
            <button
              type="button"
              class="btn"
              id="btnSaveDraft"
              style={{ height: "32px", justifyContent: "center" }}
              disabled={!intakeForm.title.trim() || intakeBusy || projectBlocked}
              onClick={() => void store.saveIntakeDraft()}
            >
              先存为草稿
            </button>
            <span class="note" id="draftNote">
              {projectBlocked
                ? "请先添加或选择目标项目空间"
                : ready
                  ? openQuestions.length > 0
                    ? `契约已齐，但仍有 ${openQuestions.length} 项待拍板；也可直接点击开始推进`
                    : hasBrief
                      ? "《产品方案》与契约已就绪，确认后写入 card.yaml 和 BRIEF.md"
                      : "确认后写入 card.yaml 和 BRIEF.md，进入队列调度"
                  : `还差 ${8 - doneCount} 项，继续对话或点「让立项助手补全」`}
            </span>
          </div>
        </aside>
      </div>
    </ViewFrame>
  );
}
