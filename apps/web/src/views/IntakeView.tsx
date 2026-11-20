import { useEffect, useRef, useState } from "preact/hooks";
import type { Priority, Track, WorkspaceMode } from "@kiln/protocol/web";
import { CheckIcon } from "../components/Icons";
import { ViewFrame } from "../components/ViewFrame";
import { fmtTime } from "../state/format";
import { useKilnStore, type IntakeFormState } from "../state/store";

interface PresetDef {
  key: string;
  label: string;
  ask: string;
  tools: string[];
  reply: string;
  form: Partial<IntakeFormState>;
}

const MVP_PRESETS: readonly PresetDef[] = [
  {
    key: "local",
    label: "清理本机 zsh 配置",
    ask: "终端启动越来越慢，PATH 里好像有很多重复的路径，帮我清一下",
    tools: ["wb_read_ledger · local", "wb_list_tasks · 检查同路径锁冲突"],
    reply:
      "走本机白名单（host_scoped 两阶段暂存）：Agent 只在沙盒生成补丁，内核备份原文件并请你批准后原子写入。",
    form: {
      title: "清理 zsh PATH 重复项",
      priority: "P2",
      space: "local",
      track: "L1",
      workspace_mode: "host_scoped",
      end: "本机生效，新开终端 PATH 无重复项",
      accept_cmd: "zsh -i -c 'echo $PATH | tr \":\" \"\\n\" | sort | uniq -d'",
      scope: "~/.zshrc\n~/.zprofile",
    },
  },
  {
    key: "code",
    label: "新功能标准交付",
    ask: "给工作台新增列表导出功能，需要自动测试和独立审查",
    tools: ["wb_read_ledger · 检查代码规范", "wb_list_tasks · 检查在途依赖"],
    reply:
      "走 L2 标准交付（git_worktree）：包含实施、确定性门禁验真与异构独立审查。",
    form: {
      title: "新增列表导出功能",
      priority: "P2",
      space: "local",
      track: "L2",
      workspace_mode: "git_worktree",
      end: "合入 main，单测与审查通过",
      accept_cmd: "pnpm test",
      scope: "src/**",
    },
  },
  {
    key: "scratch",
    label: "临时沙盒脚本",
    ask: "在独立沙盒目录整理一份日志分析脚本并输出报告",
    tools: ["wb_list_tasks · 检查工作区可用性"],
    reply:
      "走 L1 快车道 + scratch_dir 临时沙盒，产物限定在 workspaces/<新任务>/ 下，提交时自动替换为真实任务 ID。",
    form: {
      title: "日志统计脚本与报告",
      priority: "P3",
      space: "local",
      track: "L1",
      workspace_mode: "scratch_dir",
      end: "output.md 生成且非空",
      accept_cmd: "test -s workspaces/<新任务>/output.md",
      scope: "workspaces/<新任务>/**",
    },
  },
];

export function IntakeView() {
  const { store, state } = useKilnStore();
  const [chatInput, setChatInput] = useState("");
  const msgsRef = useRef<HTMLDivElement | null>(null);

  const { intakeForm, intakeMessages, intakeBusy, drafts, spaces, draftOpen } =
    state;

  useEffect(() => {
    if (msgsRef.current) {
      msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
    }
  }, [intakeMessages.length]);

  const spaceOptions = Array.from(
    new Set(["local", ...Object.keys(spaces), intakeForm.space].filter(Boolean)),
  );

  const requiredChecks: Array<[keyof IntakeFormState, boolean]> = [
    ["title", intakeForm.title.trim().length > 0],
    ["priority", intakeForm.priority !== ""],
    ["space", intakeForm.space.trim().length > 0],
    ["track", intakeForm.track !== ""],
    ["workspace_mode", intakeForm.workspace_mode !== ""],
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
    if (!val || intakeBusy) return;
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
        <button
          type="button"
          class="btn btn-ghost"
          onClick={() => store.go("board")}
        >
          返回看板
        </button>
      }
    >
      <div class="converse">
        <div class="chat">
          {drafts.length > 0 ? (
            <div class="drafts">
              <span>未完成的立项</span>
              {drafts.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  class="btn btn-sm"
                  onClick={() => void store.loadDraftIntoIntake(d)}
                >
                  <span>{d.title || d.id}</span>
                  <span class="muted mono">{fmtTime(d.updated_at)}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div class="msgs" id="msgs" ref={msgsRef}>
            {intakeMessages.map((m, idx) => {
              const who = m.who ?? (m.role === "user" ? "me" : m.role === "tool" ? "tool" : "agent");
              if (who === "tool") {
                return (
                  <div key={idx} class="msg tool">
                    <span class="dot" style={{ background: "var(--t3)" }} />
                    <span>{m.text}</span>
                  </div>
                );
              }
              return (
                <div key={idx} class={`msg ${who === "me" ? "me" : ""}`}>
                  {who !== "me" ? (
                    <div class="msg-who">{m.name ?? "intake"}</div>
                  ) : null}
                  <div class="msg-text">{m.text}</div>
                </div>
              );
            })}
          </div>

          <div class="presets">
            {MVP_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                class="btn btn-sm"
                onClick={() =>
                  store.applyIntakePreset(
                    {
                      ...p.form,
                      space:
                        p.key === "code" && Object.keys(spaces).length > 0
                          ? (Object.keys(spaces)[0] ?? "local")
                          : p.form.space,
                    },
                    [
                      { who: "me", text: p.ask },
                      ...p.tools.map((t) => ({ who: "tool" as const, text: t })),
                      { who: "agent", name: "intake", text: p.reply },
                    ],
                  )
                }
              >
                {p.label}
              </button>
            ))}
          </div>

          <div class="composer">
            <input
              id="chatIn"
              class="input"
              placeholder="描述需求（回车发送）"
              value={chatInput}
              disabled={intakeBusy}
              onInput={(e) =>
                setChatInput((e.currentTarget as HTMLInputElement).value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleSend();
                }
              }}
            />
            <button
              type="button"
              class="btn btn-light"
              disabled={intakeBusy || !chatInput.trim()}
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
                  <select
                    aria-label="空间"
                    class="draft-edit"
                    value={intakeForm.space}
                    onChange={(e) =>
                      store.updateIntakeForm({
                        space: (e.currentTarget as HTMLSelectElement).value,
                      })
                    }
                  >
                    {spaceOptions.map((spId) => (
                      <option key={spId} value={spId}>
                        {spaces[spId]?.name ?? spId}
                      </option>
                    ))}
                  </select>
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
                        track: (e.currentTarget as HTMLSelectElement).value as Exclude<
                          Track,
                          "L3"
                        >,
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
                  <select
                    aria-label="工作区"
                    class="draft-edit"
                    value={intakeForm.workspace_mode}
                    onChange={(e) =>
                      store.updateIntakeForm({
                        workspace_mode: (e.currentTarget as HTMLSelectElement)
                          .value as Exclude<WorkspaceMode, "external_only">,
                      })
                    }
                  >
                    <option value="git_worktree">git_worktree · 代码工作树</option>
                    <option value="host_scoped">
                      host_scoped · 本机白名单（两阶段暂存）
                    </option>
                    <option value="scratch_dir">scratch_dir · 临时沙盒</option>
                  </select>
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
              disabled={!ready || intakeBusy}
              onClick={() => void store.commitIntakeTask()}
            >
              开始推进
            </button>
            <button
              type="button"
              class="btn"
              id="btnSaveDraft"
              style={{ height: "32px", justifyContent: "center" }}
              disabled={!intakeForm.title.trim() || intakeBusy}
              onClick={() => void store.saveIntakeDraft()}
            >
              先存为草稿
            </button>
            <span class="note" id="draftNote">
              {ready
                ? "确认后写入 card.yaml 和 BRIEF.md，进入队列调度"
                : `还差 ${8 - doneCount} 项，继续对话或直接点击字段补齐`}
            </span>
          </div>
        </aside>
      </div>
    </ViewFrame>
  );
}
