import { useState } from "react";
import {
  extractWorkflowToggles,
  flattenWorkflowSteps,
  validateBlueprintAgainstRoster,
  type Priority,
  type Track,
  type WorkflowAgentNode,
  type WorkflowPreset,
  type WorkspaceMode,
} from "@kiln/protocol/web";
import type { TaskAttachment } from "../api/types";
import { AttachmentLightbox } from "../components/AttachmentLightbox";
import { ChatComposer } from "../components/ChatComposer";
import { ChatTimeline } from "../components/ChatTimeline";
import { CheckIcon, CloseIcon, GitPrIcon } from "../components/Icons";
import { MarkdownContent } from "../components/MarkdownContent";
import { RosterRolePicker } from "../components/RosterRolePicker";
import { SplitCardsPanel } from "../components/SplitCardsPanel";
import { ViewFrame } from "../components/ViewFrame";
import { WORKFLOW_PRESET_LABEL, fmtTime, stageMeta } from "../state/format";
import {
  getProjectSpaces,
  isProjectSpace,
  resolveFormEffectiveWorkflow,
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

const WORKFLOW_PRESET_TABS: Array<[Exclude<WorkflowPreset, "custom">, string]> = [
  ["quick", WORKFLOW_PRESET_LABEL.quick],
  ["host_op", WORKFLOW_PRESET_LABEL.host_op],
  ["standard_dev", WORKFLOW_PRESET_LABEL.standard_dev],
  ["full_delivery", WORKFLOW_PRESET_LABEL.full_delivery],
];

const LOOP_ROUNDS_OPTIONS = [1, 2, 3, 5] as const;

export function IntakeView() {
  const { store, state } = useKilnStore();
  const [chatInput, setChatInput] = useState("");
  const [editingBriefRaw, setEditingBriefRaw] = useState(false);
  const [contractEditOpen, setContractEditOpen] = useState(false);
  const [newNonGoalInput, setNewNonGoalInput] = useState("");
  const [lightboxAttachment, setLightboxAttachment] =
    useState<TaskAttachment | null>(null);

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
  const effectiveWorkflow = resolveFormEffectiveWorkflow(intakeForm);
  const effectiveWorkspaceMode: Exclude<WorkspaceMode, "external_only"> =
    isProjectMode
      ? "git_worktree"
      : intakeForm.workspace_mode === "host_scoped"
        ? "host_scoped"
        : "scratch_dir";
  const rosterValidation = validateBlueprintAgainstRoster(
    effectiveWorkflow,
    state.roster.roster,
    { workspaceMode: effectiveWorkspaceMode },
  );
  const agentStepNodes = flattenWorkflowSteps(effectiveWorkflow).filter(
    (node): node is WorkflowAgentNode => node.kind === "agent",
  );
  const isSplitMode = intakeForm.split_cards.length > 0;
  const draftAttachmentUrl = (att: TaskAttachment): string =>
    intakeDraftId
      ? `/api/drafts/${encodeURIComponent(intakeDraftId)}/attachments/${encodeURIComponent(att.id)}`
      : "";
  const wfToggles = extractWorkflowToggles(effectiveWorkflow);
  const workflowPreviewParts: string[] = ["立项"];
  if (wfToggles.includePlan) {
    workflowPreviewParts.push("方案(顾问)");
  }
  if (wfToggles.includeReview) {
    workflowPreviewParts.push(
      `实施${wfToggles.hostTwoPhase ? "·暂存" : ""} → 验真${
        wfToggles.hostTwoPhase ? "·仅暂存" : ""
      } ⇄ 审查(≤${wfToggles.maxRounds ?? 3}轮)`,
    );
  } else {
    workflowPreviewParts.push(
      `实施${wfToggles.hostTwoPhase ? "·暂存" : ""}`,
      wfToggles.hostTwoPhase ? "验真(仅暂存)" : "验真",
    );
  }
  if (wfToggles.includeAccept) {
    workflowPreviewParts.push(
      wfToggles.acceptMode === "approval" ? "人工验收" : "独立验收",
    );
  }
  if (wfToggles.deliverApproval) {
    workflowPreviewParts.push("交付审批");
  }
  workflowPreviewParts.push(
    wfToggles.hostTwoPhase ? "交付(落盘+终验)" : "交付",
  );
  const workflowPreview = workflowPreviewParts.join(" → ");
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
    if (!val || intakeBusy || state.attachmentUploadBusy) return;
    if (val.toLowerCase() === "/new") {
      setChatInput("");
      store.startNewIntake();
      return;
    }
    if (projectBlocked) return;
    setChatInput("");
    await store.sendIntakeChat(val);
  };

  return (
    <ViewFrame
      left={
        <>
          <h1 className="tb-title">新需求</h1>
          <span className="tb-sub">
            聊清楚就能离开，未聊完保存在 drafts/ 目录
          </span>
        </>
      }
      right={
        <>
          <button
            type="button"
            className="btn btn-ghost desktop-panel-toggle"
            aria-pressed={state.desktopDraftCollapsed}
            onClick={() => store.toggleDesktopDraftCollapsed()}
          >
            {state.desktopDraftCollapsed ? "展开方案栏" : "收起侧栏"}
          </button>
          {intakeActiveOpen || hasDraftOrChat ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={intakeBusy || state.attachmentUploadBusy}
              onClick={() => void store.closeIntakeSession()}
            >
              关闭对话
            </button>
          ) : null}
          {hasDraftOrChat ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={intakeBusy || state.attachmentUploadBusy}
              onClick={() => store.startNewIntake()}
            >
              新建需求
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => store.go("board")}
          >
            返回看板
          </button>
        </>
      }
    >
      <div className={`converse ${state.desktopDraftCollapsed ? "is-panel-collapsed" : ""}`}>
        <div className="chat">
          {drafts.length > 0 ? (
            <div className="drafts">
              <span>未完成的立项</span>
              {drafts.map((d) => (
                <div
                  key={d.id}
                  className={`draft-chip ${intakeDraftId === d.id ? "is-active" : ""}`}
                >
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={intakeBusy || state.attachmentUploadBusy}
                    onClick={() => {
                      setEditingBriefRaw(false);
                      void store.loadDraftIntoIntake(d);
                    }}
                  >
                    <span>{d.title || d.id}</span>
                    <span className="muted mono">{fmtTime(d.updated_at)}</span>
                  </button>
                  <button
                    type="button"
                    className="draft-del"
                    aria-label={`删除草稿 ${d.title || d.id}`}
                    title="删除草稿"
                    disabled={intakeBusy || state.attachmentUploadBusy}
                    onClick={() => void store.deleteIntakeDraft(d.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="intake-bar">
            <div className="seg" role="group" aria-label="任务模式">
              <button
                type="button"
                className={isProjectMode ? "on" : ""}
                onClick={() => store.setIntakeMode("project")}
              >
                项目任务
              </button>
              <button
                type="button"
                className={!isProjectMode ? "on" : ""}
                onClick={() => store.setIntakeMode("local")}
              >
                本机 / 临时任务
              </button>
            </div>

            {isProjectMode ? (
              <div className="intake-target">
                {projectSpaces.length > 0 || (intakeForm.space && !selectedProject) ? (
                  <div className="intake-chips" role="radiogroup" aria-label="目标项目空间">
                    {projectSpaces.map((sp) => (
                      <button
                        key={sp.id}
                        type="button"
                        role="radio"
                        aria-checked={intakeForm.space === sp.id}
                        data-space-id={sp.id}
                        className={`chip-tab ${intakeForm.space === sp.id ? "on" : ""}`}
                        onClick={() => store.selectIntakeProjectSpace(sp.id)}
                      >
                        {sp.name}
                      </button>
                    ))}
                    {intakeForm.space && !selectedProject ? (
                      <span className="chip chip-bad">
                        {intakeForm.space}（未登记或缺少仓库路径）
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {selectedProject?.repo_path ? (
                  <span
                    className="intake-path mono muted"
                    title={selectedProject.repo_path}
                  >
                    {selectedProject.repo_path}
                  </span>
                ) : null}
                <button
                  type="button"
                  className={`btn btn-sm ${projectSpaces.length === 0 ? "btn-light" : ""}`}
                  onClick={() => store.openAddSpaceModal(true)}
                >
                  + 添加项目
                </button>
                {authMode === "local" ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={pickDirBusy}
                    onClick={() => void store.pickDirectoryAndAttach(true)}
                  >
                    {pickDirBusy ? "等待选择…" : "从文件目录选择"}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="intake-target">
                <span className="chip">本机与临时 (local)</span>
                <div className="seg" role="radiogroup" aria-label="本机工作区模式">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={intakeForm.workspace_mode !== "host_scoped"}
                      data-workspace-mode="scratch_dir"
                      className={intakeForm.workspace_mode !== "host_scoped" ? "on" : ""}
                      onClick={() => store.selectIntakeWorkspaceMode("scratch_dir")}
                    >
                      临时沙盒
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={intakeForm.workspace_mode === "host_scoped"}
                      data-workspace-mode="host_scoped"
                      className={intakeForm.workspace_mode === "host_scoped" ? "on" : ""}
                      onClick={() => store.selectIntakeWorkspaceMode("host_scoped")}
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
                <div className="intake-empty">
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
                  <div className="intake-empty-actions">
                    <button
                      type="button"
                      className="btn btn-light"
                      onClick={() => store.openAddSpaceModal(true)}
                    >
                      + 添加本地 Git 项目
                    </button>
                    {authMode === "local" ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={pickDirBusy}
                        onClick={() => void store.pickDirectoryAndAttach(true)}
                      >
                        {pickDirBusy ? "等待选择…" : "从文件目录选择"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => store.setIntakeMode("local")}
                    >
                      改用本机 / 临时任务
                    </button>
                  </div>
                </div>
              ) : null
            }
          />

          <ChatComposer
            role="intake"
            spaceId={intakeForm.space}
            isProjectSpace={isProjectMode && Boolean(selectedProject)}
            draftId={intakeDraftId}
            value={chatInput}
            disabled={intakeBusy || projectBlocked}
            placeholder={
              projectBlocked
                ? "请先添加或选择项目空间"
                : isProjectMode && selectedProject
                  ? `描述「${selectedProject.name}」需求（/ 调用指令或技能，@ 选择文件、MCP 或任务，可粘贴截图）`
                  : "描述本机或临时任务需求（/ 调用指令或技能，@ 选择当前目录文件、MCP 或任务，可粘贴截图）"
            }
            onChange={setChatInput}
            onSend={() => void handleSend()}
            attachments={intakeForm.attachments}
            attachmentUrlFor={draftAttachmentUrl}
            attachmentBusy={state.attachmentUploadBusy}
            onUploadImageFiles={(files) => void store.uploadIntakeAttachments(files)}
            onRemoveAttachment={(attId) => void store.deleteIntakeAttachment(attId)}
            onPreviewAttachment={(att) => setLightboxAttachment(att)}
            onClientCommand={(action) => {
              if (action === "new_draft") {
                store.startNewIntake();
                return true;
              }
              return false;
            }}
          />
        </div>

        <aside className={`draft ${draftOpen ? "open" : ""}`}>
          <div className="draft-head">
            <div className="draft-tabs" role="tablist" aria-label="立项面板">
              <button
                type="button"
                role="tab"
                aria-selected={intakeRightTab === "brief"}
                className={`draft-tab ${intakeRightTab === "brief" ? "on" : ""}`}
                onClick={() => store.setIntakeRightTab("brief")}
              >
                <span>产品方案</span>
                {openQuestions.length > 0 ? (
                  <span className="draft-tab-badge is-ask">{openQuestions.length}</span>
                ) : hasBrief ? (
                  <span className="draft-tab-badge is-ok">✓</span>
                ) : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={intakeRightTab === "settings"}
                className={`draft-tab ${intakeRightTab === "settings" ? "on" : ""}`}
                onClick={() => store.setIntakeRightTab("settings")}
              >
                <span>立项设置</span>
                <span className="mono muted" id="draftProg">
                  {doneCount} / 8
                </span>
              </button>
            </div>
            <button
              type="button"
              className="btn btn-sm draft-toggle"
              id="btnDraftToggle"
              onClick={() => store.toggleDraftOpen()}
            >
              {draftOpen ? "收起面板" : "展开编辑"}
            </button>
          </div>

          <div className="draft-body">
            {intakeRightTab === "brief" ? (
              <div className="brief-panel" role="tabpanel" aria-label="产品方案">
                <div className="brief-bar">
                  <span className="brief-status">
                    {openQuestions.length > 0
                      ? `待拍板 ${openQuestions.length} 项`
                      : hasBrief
                        ? "方案已就绪 · 提交后写入 BRIEF.md"
                        : "尚未生成产品方案"}
                  </span>
                  {hasBrief || editingBriefRaw ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditingBriefRaw((v) => !v)}
                    >
                      {editingBriefRaw ? "完成预览" : "编辑原文"}
                    </button>
                  ) : null}
                </div>

                {openQuestions.length > 0 ? (
                  <div className="open-questions" aria-label="待拍板事项">
                    <div className="oq-title">待拍板（{openQuestions.length}）</div>
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
                    className="input mono brief-editor"
                    rows={14}
                    placeholder="Markdown 格式产品设计方案与验收标准…"
                    value={intakeForm.brief_markdown}
                    onChange={(e) =>
                      store.updateIntakeForm({
                        brief_markdown: (e.currentTarget as HTMLTextAreaElement).value,
                      })
                    }
                  />
                ) : hasBrief ? (
                  <div className="brief-preview" data-brief-preview="true">
                    <MarkdownContent text={intakeForm.brief_markdown} />
                  </div>
                ) : (
                  <div className="brief-empty">
                    <p>
                      在左侧描述你的想法后，立项助手会先只读探索代码库与账本，输出结构化的《产品方案》(BRIEF.md) 并在本页实时预览，提交后直接驱动后续实施与验收。
                    </p>
                    <button
                      type="button"
                      className="btn btn-sm btn-light"
                      disabled={intakeBusy || projectBlocked}
                      onClick={() => void store.requestPmAutofill()}
                    >
                      让立项助手生成方案
                    </button>
                  </div>
                )}

                {effectiveWorkflow.pm_rationale ||
                intakeForm.non_goals.length > 0 ||
                intakeForm.attachments.length > 0 ||
                isSplitMode ? (
                  <div className="pm-assign" aria-label="立项约束摘要">
                    {isSplitMode ? (
                      <div className="contract-head">
                        <span className="chip chip-live">
                          已生成 {intakeForm.split_cards.length} 张拆卡方案
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm btn-light"
                          onClick={() => store.setIntakeRightTab("settings")}
                        >
                          查看拆卡 DAG
                        </button>
                      </div>
                    ) : null}
                    {effectiveWorkflow.pm_rationale ? (
                      <div className="pm-rationale">
                        <b>PM 排兵：</b>
                        {effectiveWorkflow.pm_rationale}
                      </div>
                    ) : null}
                    {intakeForm.non_goals.length > 0 ? (
                      <div className="ng-list">
                        {intakeForm.non_goals.map((item) => (
                          <span key={item} className="ng-tag">
                            不做: {item}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {intakeForm.attachments.length > 0 ? (
                      <span className="muted" style={{ fontSize: "11.5px" }}>
                        已附 {intakeForm.attachments.length} 张截图，提交后随卡片保存
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : isSplitMode ? (
              <SplitCardsPanel
                cards={intakeForm.split_cards}
                roster={state.roster}
                busy={intakeBusy || state.attachmentUploadBusy}
                onUpdateCard={(idx, patch) => store.updateSplitCard(idx, patch)}
                onAddCard={() => store.addSplitCard()}
                onRemoveCard={(idx) => store.removeSplitCard(idx)}
                onCommit={() =>
                  void store.commitSplitIntakeTasks(intakeForm.split_cards)
                }
                onCancel={() => store.clearSplitCards()}
              />
            ) : (
              <div className="settings-panel" role="tabpanel" aria-label="立项设置">
                <dl className="draft-fields">
                  <div className="field">
                    <div>
                      <dt>标题</dt>
                      <dd>
                        <input
                          aria-label="标题"
                          className="draft-edit"
                          placeholder="可简写，也可由助手自动提炼"
                          value={intakeForm.title}
                          onChange={(e) =>
                            store.updateIntakeForm({
                              title: (e.currentTarget as HTMLInputElement).value,
                            })
                          }
                        />
                      </dd>
                    </div>
                    <span className="field-mark">
                      {requiredChecks[0]![1] ? <CheckIcon /> : null}
                    </span>
                  </div>

                  <div className="field">
                    <div>
                      <dt>优先级</dt>
                      <dd>
                        <div className="seg seg-wrap" role="radiogroup" aria-label="优先级">
                          {PRIORITY_TABS.map(([val, label]) => (
                            <button
                              key={val}
                              type="button"
                              role="radio"
                              aria-checked={intakeForm.priority === val}
                              data-priority={val}
                              className={intakeForm.priority === val ? "on" : ""}
                              onClick={() => store.updateIntakeForm({ priority: val })}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </dd>
                    </div>
                    <span className="field-mark">
                      {requiredChecks[1]![1] ? <CheckIcon /> : null}
                    </span>
                  </div>

                  <div className="field">
                    <div>
                      <dt>轨道</dt>
                      <dd>
                        <div className="seg seg-wrap" role="radiogroup" aria-label="轨道">
                          {TRACK_TABS.map(([val, label]) => (
                            <button
                              key={val}
                              type="button"
                              role="radio"
                              aria-checked={intakeForm.track === val}
                              data-track={val}
                              className={intakeForm.track === val ? "on" : ""}
                              onClick={() => store.selectIntakeTrack(val)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </dd>
                    </div>
                    <span className="field-mark">
                      {requiredChecks[3]![1] ? <CheckIcon /> : null}
                    </span>
                  </div>

                  <div className="field">
                    <div>
                      <dt>流程蓝图 · {WORKFLOW_PRESET_LABEL[effectiveWorkflow.preset]}</dt>
                      <dd className="bp-box">
                        <div className="seg seg-wrap" role="radiogroup" aria-label="流程预设">
                          {WORKFLOW_PRESET_TABS.map(([val, label]) => (
                            <button
                              key={val}
                              type="button"
                              role="radio"
                              aria-checked={effectiveWorkflow.preset === val}
                              data-workflow-preset={val}
                              className={effectiveWorkflow.preset === val ? "on" : ""}
                              onClick={() => store.selectIntakeWorkflowPreset(val)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>

                        <div className="bp-toggles" role="group" aria-label="流程步骤开关">
                          <button
                            type="button"
                            className={`chip-tab ${wfToggles.includePlan ? "on" : ""}`}
                            aria-pressed={wfToggles.includePlan}
                            onClick={() =>
                              store.updateIntakeWorkflowToggles({
                                includePlan: !wfToggles.includePlan,
                              })
                            }
                          >
                            顾问方案
                          </button>
                          <button
                            type="button"
                            className={`chip-tab ${wfToggles.includeReview ? "on" : ""}`}
                            aria-pressed={wfToggles.includeReview}
                            onClick={() =>
                              store.updateIntakeWorkflowToggles({
                                includeReview: !wfToggles.includeReview,
                              })
                            }
                          >
                            独立审查
                          </button>
                          <button
                            type="button"
                            className={`chip-tab ${wfToggles.includeAccept ? "on" : ""}`}
                            aria-pressed={wfToggles.includeAccept}
                            onClick={() =>
                              store.updateIntakeWorkflowToggles({
                                includeAccept: !wfToggles.includeAccept,
                                acceptMode: wfToggles.acceptMode ?? "verifier",
                              })
                            }
                          >
                            独立验收
                          </button>
                          <button
                            type="button"
                            className={`chip-tab ${wfToggles.deliverApproval ? "on" : ""}`}
                            aria-pressed={wfToggles.deliverApproval}
                            disabled={
                              wfToggles.hostTwoPhase ||
                              intakeForm.deliver_cmd.trim().length > 0
                            }
                            onClick={() =>
                              store.updateIntakeWorkflowToggles({
                                deliverApproval: !wfToggles.deliverApproval,
                              })
                            }
                          >
                            交付审批
                          </button>
                        </div>

                        {wfToggles.includeReview ? (
                          <div className="bp-rounds">
                            <span className="bp-rounds-label">审查上限</span>
                            <div
                              className="seg seg-wrap"
                              role="radiogroup"
                              aria-label="最大循环轮数"
                            >
                              {LOOP_ROUNDS_OPTIONS.map((n) => (
                                <button
                                  key={n}
                                  type="button"
                                  role="radio"
                                  aria-checked={(wfToggles.maxRounds ?? 3) === n}
                                  data-loop-rounds={n}
                                  className={(wfToggles.maxRounds ?? 3) === n ? "on" : ""}
                                  onClick={() =>
                                    store.updateIntakeWorkflowToggles({ maxRounds: n })
                                  }
                                >
                                  {n} 轮
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        <div className="bp-preview mono" aria-label="流程预览">
                          {workflowPreview}
                        </div>
                      </dd>
                    </div>
                    <span className="field-mark">
                      <CheckIcon />
                    </span>
                  </div>

                  <div className="field">
                    <div>
                      <dt>目标空间与工作区</dt>
                      <dd>
                        <div className="draft-static" aria-label="空间与工作区摘要">
                          {targetSummary}
                        </div>
                      </dd>
                    </div>
                    <span className="field-mark">
                      {requiredChecks[2]![1] && requiredChecks[4]![1] ? (
                        <CheckIcon />
                      ) : null}
                    </span>
                  </div>
                </dl>

                <div className="pm-assign" aria-label="PM 排兵点将">
                  <div className="contract-head">
                    <span className="contract-title">PM 排兵点将</span>
                    <span
                      className={`chip ${
                        rosterValidation.ok ? "chip-ok" : "chip-bad"
                      }`}
                    >
                      {rosterValidation.ok
                        ? "权限校验通过"
                        : `红线拦截 (${rosterValidation.errors.length})`}
                    </span>
                  </div>
                  {effectiveWorkflow.pm_rationale ? (
                    <div className="pm-rationale">
                      <b>为什么这样排：</b>
                      {effectiveWorkflow.pm_rationale}
                    </div>
                  ) : null}
                  <div className="assign-list">
                    {agentStepNodes.map((node, nodeIdx) => (
                      <div
                        key={`${node.stage}-${nodeIdx}`}
                        className="assign-row"
                      >
                        <div className="assign-stage">
                          <b>{stageMeta(node.stage).label}</b>
                          {node.rationale ? (
                            <small title={node.rationale}>{node.rationale}</small>
                          ) : (
                            <small>{node.role}</small>
                          )}
                        </div>
                        <RosterRolePicker
                          stage={node.stage}
                          workspaceMode={effectiveWorkspaceMode}
                          selectedRoleId={node.roster_role}
                          roster={state.roster}
                          providerStatuses={state.providerStatuses}
                          disabled={intakeBusy}
                          onSelect={(roleId) =>
                            store.setIntakeStepRosterRole(node.stage, roleId)
                          }
                        />
                      </div>
                    ))}
                  </div>
                  {!rosterValidation.ok ? (
                    <div className="note note-bad" role="alert">
                      {rosterValidation.errors.join("；")}
                    </div>
                  ) : null}
                </div>

                <div className="contract-card">
                  <div className="contract-head">
                    <div>
                      <span className="contract-title">PM 执行契约摘要</span>
                      <span className="mono muted contract-count">
                        {contractDoneCount} / 3
                      </span>
                    </div>
                    <div className="contract-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={intakeBusy || projectBlocked}
                        onClick={() => store.initSplitCardsFromDraft()}
                      >
                        <GitPrIcon />
                        <span>拆分为多卡 DAG</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-light"
                        disabled={intakeBusy || projectBlocked}
                        onClick={() => void store.requestPmAutofill()}
                      >
                        让立项助手补全
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-expanded={contractEditOpen}
                        onClick={() => setContractEditOpen((v) => !v)}
                      >
                        {contractEditOpen ? "收起编辑" : "手动编辑"}
                      </button>
                    </div>
                  </div>

                  {!contractEditOpen ? (
                    <dl className="contract-summary">
                      <div className="cs-row">
                        <dt>交付终点</dt>
                        <dd>
                          {intakeForm.end.trim() || <span className="muted">待 PM 补全</span>}
                        </dd>
                      </div>
                      <div className="cs-row">
                        <dt>验收命令</dt>
                        <dd className="mono">
                          {intakeForm.accept_cmd.trim() || (
                            <span className="muted">待 PM 补全</span>
                          )}
                        </dd>
                      </div>
                      <div className="cs-row">
                        <dt>可改范围</dt>
                        <dd className="mono">
                          {scopeList.length > 0 ? (
                            scopeList.join(", ")
                          ) : (
                            <span className="muted">待 PM 补全</span>
                          )}
                        </dd>
                      </div>
                      {intakeForm.deliver_cmd.trim() ? (
                        <div className="cs-row">
                          <dt>交付命令</dt>
                          <dd className="mono">{intakeForm.deliver_cmd.trim()}</dd>
                        </div>
                      ) : null}
                      {intakeForm.depends_on.trim() ? (
                        <div className="cs-row">
                          <dt>前置任务</dt>
                          <dd className="mono">{intakeForm.depends_on.trim()}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : (
                    <dl className="draft-fields">
                      <div className="field">
                        <div>
                          <dt>交付终点</dt>
                          <dd>
                            <input
                              aria-label="交付终点"
                              className="draft-edit"
                              placeholder="对话生成或直接点击填写"
                              value={intakeForm.end}
                              onChange={(e) =>
                                store.updateIntakeForm({
                                  end: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span className="field-mark">
                          {requiredChecks[5]![1] ? <CheckIcon /> : null}
                        </span>
                      </div>

                      <div className="field">
                        <div>
                          <dt>验收命令</dt>
                          <dd>
                            <input
                              aria-label="验收命令"
                              className="draft-edit mono"
                              placeholder="如 pnpm test"
                              value={intakeForm.accept_cmd}
                              onChange={(e) =>
                                store.updateIntakeForm({
                                  accept_cmd: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span className="field-mark">
                          {requiredChecks[6]![1] ? <CheckIcon /> : null}
                        </span>
                      </div>

                      <div className="field">
                        <div>
                          <dt>可改范围</dt>
                          <dd>
                            <input
                              aria-label="可改范围"
                              className="draft-edit mono"
                              placeholder="多个路径用逗号或换行分隔"
                              value={intakeForm.scope}
                              onChange={(e) =>
                                store.updateIntakeForm({
                                  scope: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span className="field-mark">
                          {requiredChecks[7]![1] ? <CheckIcon /> : null}
                        </span>
                      </div>

                      <div className="field">
                        <div>
                          <dt>交付命令（可选）</dt>
                          <dd>
                            <input
                              aria-label="交付命令"
                              className="draft-edit mono"
                              placeholder="可选，如审批落盘后执行的命令"
                              value={intakeForm.deliver_cmd}
                              onChange={(e) =>
                                store.updateIntakeForm({
                                  deliver_cmd: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span className="field-mark">
                          {intakeForm.deliver_cmd.trim() ? <CheckIcon /> : null}
                        </span>
                      </div>

                      <div className="field">
                        <div>
                          <dt>前置任务（可选）</dt>
                          <dd>
                            <input
                              aria-label="前置任务"
                              className="draft-edit mono"
                              placeholder="选填，如 t-118"
                              value={intakeForm.depends_on}
                              onChange={(e) =>
                                store.updateIntakeForm({
                                  depends_on: (e.currentTarget as HTMLInputElement).value,
                                })
                              }
                            />
                          </dd>
                        </div>
                        <span className="field-mark">
                          {intakeForm.depends_on.trim() ? <CheckIcon /> : null}
                        </span>
                      </div>
                    </dl>
                  )}

                  <div className="ng-box" aria-label="明确不做边界">
                    <span className="contract-title" style={{ fontSize: "12px" }}>
                      明确不做（non_goals）
                    </span>
                    {intakeForm.non_goals.length > 0 ? (
                      <div className="ng-list">
                        {intakeForm.non_goals.map((item, idx) => (
                          <span key={`${item}-${idx}`} className="ng-tag">
                            <span>{item}</span>
                            <button
                              type="button"
                              aria-label={`移除排除项 ${item}`}
                              onClick={() => store.removeIntakeNonGoal(idx)}
                            >
                              <CloseIcon />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="muted" style={{ fontSize: "11.5px" }}>
                        尚未添加排除项（PM 梳理后也会自动锁定）
                      </span>
                    )}
                    <div className="ng-add-row">
                      <input
                        aria-label="新增明确不做项"
                        className="input"
                        placeholder="如：不引入新第三方依赖"
                        value={newNonGoalInput}
                        onChange={(e) => setNewNonGoalInput(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            if (newNonGoalInput.trim()) {
                              store.addIntakeNonGoal(newNonGoalInput);
                              setNewNonGoalInput("");
                            }
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!newNonGoalInput.trim()}
                        onClick={() => {
                          if (newNonGoalInput.trim()) {
                            store.addIntakeNonGoal(newNonGoalInput);
                            setNewNonGoalInput("");
                          }
                        }}
                      >
                        添加排除项
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="draft-foot">
            {!isSplitMode ? (
              <button
                type="button"
                className="btn btn-light"
                id="btnCreateTask"
                style={{ height: "36px", justifyContent: "center" }}
                disabled={
                  !ready ||
                  !rosterValidation.ok ||
                  intakeBusy ||
                  state.attachmentUploadBusy ||
                  projectBlocked
                }
                onClick={() => void store.commitIntakeTask()}
              >
                开始推进
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              id="btnSaveDraft"
              style={{ height: "32px", justifyContent: "center" }}
              disabled={
                !intakeForm.title.trim() ||
                intakeBusy ||
                state.attachmentUploadBusy ||
                projectBlocked
              }
              onClick={() => void store.saveIntakeDraft()}
            >
              先存为草稿
            </button>
            <span className="note" id="draftNote">
              {projectBlocked
                ? "请先添加或选择目标项目空间"
                : !rosterValidation.ok
                  ? rosterValidation.errors[0]
                  : isSplitMode
                    ? "当前处于多卡拆片 DAG 模式，请核对上方拓扑依赖后点击「批量立项」"
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

      <AttachmentLightbox
        attachment={lightboxAttachment}
        imageUrl={
          lightboxAttachment ? draftAttachmentUrl(lightboxAttachment) : null
        }
        onClose={() => setLightboxAttachment(null)}
      />
    </ViewFrame>
  );
}
