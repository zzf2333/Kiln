import { useEffect, useRef, useState } from "preact/hooks";
import type { Priority, Track, WorkspaceMode } from "@kiln/protocol/web";
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

export function IntakeView() {
  const { store, state } = useKilnStore();
  const [chatInput, setChatInput] = useState("");
  const msgsRef = useRef<HTMLDivElement | null>(null);

  const {
    intakeDraftId,
    intakeForm,
    intakeMessages,
    intakeBusy,
    intakeActiveOpen,
    authMode,
    pickDirBusy,
    drafts,
    spaces,
    draftOpen,
  } = state;

  useEffect(() => {
    if (msgsRef.current) {
      msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
    }
  }, [intakeMessages.length, intakeBusy]);

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
    intakeForm.title.trim().length > 0;

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
    [
      "scope",
      intakeForm.scope
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean).length > 0,
    ],
  ];
  const doneCount = requiredChecks.filter(([, ok]) => ok).length;
  const ready = doneCount === 8;

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
      <div class="converse">
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
                    onClick={() => void store.loadDraftIntoIntake(d)}
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
              projectSpaces.length > 0 ? (
                <div class="intake-target">
                  <select
                    class="select"
                    aria-label="目标项目空间"
                    value={intakeForm.space}
                    onChange={(e) =>
                      store.selectIntakeProjectSpace(
                        (e.currentTarget as HTMLSelectElement).value,
                      )
                    }
                  >
                    {intakeForm.space && !selectedProject ? (
                      <option value={intakeForm.space} disabled>
                        {intakeForm.space}（未登记或缺少仓库路径）
                      </option>
                    ) : null}
                    {projectSpaces.map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.name} ({sp.id})
                      </option>
                    ))}
                  </select>
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
                    class="btn btn-sm"
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
                  <button
                    type="button"
                    class="btn btn-sm btn-light"
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
              )
            ) : (
              <div class="intake-target">
                <span class="chip">本机与临时 (local)</span>
                <div class="seg" role="group" aria-label="本机工作区模式">
                  <button
                    type="button"
                    class={intakeForm.workspace_mode !== "host_scoped" ? "on" : ""}
                    onClick={() =>
                      store.updateIntakeForm({ workspace_mode: "scratch_dir" })
                    }
                  >
                    临时沙盒
                  </button>
                  <button
                    type="button"
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

          <div class="msgs" id="msgs" ref={msgsRef}>
            {projectBlocked ? (
              <div class="intake-empty">
                <h3>
                  {projectSpaces.length === 0
                    ? "还没有登记项目空间"
                    : "当前所选空间未绑定 Git 仓库"}
                </h3>
                <p>
                  {projectSpaces.length === 0
                    ? "先绑定一个本地 Git 项目目录，立项对话就会直接进入该项目仓库只读探索代码与测试命令。"
                    : "当前草稿指向的空间尚未登记或缺少本地 Git 仓库路径，请在上方下拉框改选项目空间，或添加/补全对应空间。"}
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
            ) : null}

            {intakeMessages.map((m, idx) => {
              const who =
                m.who ??
                (m.role === "user" ? "me" : m.role === "tool" ? "tool" : "agent");
              if (who === "tool") {
                return (
                  <div key={idx} class="msg tool">
                    <span class="dot" style={{ background: "var(--t3)" }} />
                    <span>{m.text}</span>
                  </div>
                );
              }
              return (
                <div key={idx} class={`msg ${who === "me" ? "me" : "agent"}`}>
                  {who !== "me" ? (
                    <div class="msg-who">{m.name ?? "intake"}</div>
                  ) : null}
                  {who === "me" ? (
                    <div class="msg-text">{m.text}</div>
                  ) : (
                    <MarkdownContent text={m.text} className="msg-md" />
                  )}
                </div>
              );
            })}

            {intakeBusy ? (
              <div class="msg msg-thinking">
                <div class="msg-who">intake</div>
                <div class="msg-text muted">
                  {isProjectMode && selectedProject
                    ? `正在探索 ${selectedProject.name} 并整理立项草稿…`
                    : "正在思考并更新立项草稿…"}
                </div>
              </div>
            ) : null}
          </div>

          <div class="composer">
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

        <aside class={`draft ${draftOpen ? "open" : ""}`}>
          <div class="draft-head">
            <h3>
              立项单草稿 ·{" "}
              <span class="mono muted" id="draftProg">
                {doneCount} / 8
              </span>
            </h3>
            <button
              type="button"
              class="btn btn-sm draft-toggle"
              id="btnDraftToggle"
              onClick={() => store.toggleDraftOpen()}
            >
              {draftOpen ? "收起面板" : "展开编辑"}
            </button>
          </div>

          <dl class="draft-fields">
            <div class="field">
              <div>
                <dt>标题</dt>
                <dd>
                  <input
                    aria-label="标题"
                    class="draft-edit"
                    placeholder="对话生成或直接点击填写"
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
                  <select
                    aria-label="优先级"
                    class="draft-edit"
                    value={intakeForm.priority}
                    onChange={(e) =>
                      store.updateIntakeForm({
                        priority: (e.currentTarget as HTMLSelectElement)
                          .value as Priority,
                      })
                    }
                  >
                    <option value="P0">P0 紧急</option>
                    <option value="P1">P1 重要</option>
                    <option value="P2">P2 普通</option>
                    <option value="P3">P3 有空再做</option>
                  </select>
                </dd>
              </div>
              <span class="field-mark">
                {requiredChecks[1]![1] ? <CheckIcon /> : null}
              </span>
            </div>

            <div class="field">
              <div>
                <dt>空间</dt>
                <dd>
                  {isProjectMode ? (
                    <select
                      aria-label="空间"
                      class="draft-edit"
                      value={intakeForm.space}
                      onChange={(e) =>
                        store.selectIntakeProjectSpace(
                          (e.currentTarget as HTMLSelectElement).value,
                        )
                      }
                    >
                      {projectSpaces.length === 0 && !intakeForm.space ? (
                        <option value="">未配置项目空间</option>
                      ) : null}
                      {intakeForm.space && !selectedProject ? (
                        <option value={intakeForm.space} disabled>
                          {intakeForm.space}（未登记或缺少仓库路径）
                        </option>
                      ) : null}
                      {projectSpaces.map((sp) => (
                        <option key={sp.id} value={sp.id}>
                          {sp.name} ({sp.id})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div class="draft-static" aria-label="空间">
                      本机与临时 (local)
                    </div>
                  )}
                </dd>
              </div>
              <span class="field-mark">
                {requiredChecks[2]![1] ? <CheckIcon /> : null}
              </span>
            </div>

            <div class="field">
              <div>
                <dt>轨道</dt>
                <dd>
                  <select
                    aria-label="轨道"
                    class="draft-edit"
                    value={intakeForm.track}
                    onChange={(e) =>
                      store.updateIntakeForm({
                        track: (e.currentTarget as HTMLSelectElement)
                          .value as Exclude<Track, "L3">,
                      })
                    }
                  >
                    <option value="L1">L1 快车道</option>
                    <option value="L2">L2 标准交付</option>
                  </select>
                </dd>
              </div>
              <span class="field-mark">
                {requiredChecks[3]![1] ? <CheckIcon /> : null}
              </span>
            </div>

            <div class="field">
              <div>
                <dt>工作区</dt>
                <dd>
                  {isProjectMode ? (
                    <select
                      aria-label="工作区"
                      class="draft-edit"
                      value="git_worktree"
                      onChange={() =>
                        store.updateIntakeForm({ workspace_mode: "git_worktree" })
                      }
                    >
                      <option value="git_worktree">git_worktree · 代码工作树</option>
                    </select>
                  ) : (
                    <select
                      aria-label="工作区"
                      class="draft-edit"
                      value={
                        intakeForm.workspace_mode === "host_scoped"
                          ? "host_scoped"
                          : "scratch_dir"
                      }
                      onChange={(e) =>
                        store.updateIntakeForm({
                          workspace_mode: (e.currentTarget as HTMLSelectElement)
                            .value as Exclude<WorkspaceMode, "external_only">,
                        })
                      }
                    >
                      <option value="scratch_dir">scratch_dir · 临时沙盒</option>
                      <option value="host_scoped">
                        host_scoped · 本机白名单（两阶段暂存）
                      </option>
                    </select>
                  )}
                </dd>
              </div>
              <span class="field-mark">
                {requiredChecks[4]![1] ? <CheckIcon /> : null}
              </span>
            </div>

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
                  ? "确认后写入 card.yaml 和 BRIEF.md，进入队列调度"
                  : `还差 ${8 - doneCount} 项，继续对话或直接点击字段补齐`}
            </span>
          </div>
        </aside>
      </div>
    </ViewFrame>
  );
}
