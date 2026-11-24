import { getProjectSpaces, useKilnStore } from "../state/store";

export function IntakeDock() {
  const { store, state } = useKilnStore();

  if (!state.intakeActiveOpen || state.view === "intake") {
    return null;
  }

  const { intakeForm, intakeMessages, intakeBusy, intakeHasUnreadReply, spaces } = state;
  const firstUserMsg = intakeMessages.find((m) => m.who === "me")?.text.trim() ?? "";
  const rawTitle = intakeForm.title.trim() || firstUserMsg || "未命名的立项对话";
  const displayTitle = rawTitle.length > 34 ? `${rawTitle.slice(0, 34)}…` : rawTitle;

  const projectSpaces = getProjectSpaces(spaces);
  const spaceLabel =
    intakeForm.mode === "local"
      ? "本机 / 临时"
      : (spaces[intakeForm.space]?.name ??
        (projectSpaces.length > 0 ? intakeForm.space || "项目任务" : "待选项目"));

  const scopeCount = intakeForm.scope
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
  const readyFields = [
    intakeForm.title.trim().length > 0,
    intakeForm.priority !== "",
    intakeForm.mode === "local"
      ? intakeForm.space === "local"
      : Boolean(spaces[intakeForm.space]?.repo_path),
    intakeForm.track !== "",
    intakeForm.mode === "local"
      ? intakeForm.workspace_mode === "scratch_dir" || intakeForm.workspace_mode === "host_scoped"
      : intakeForm.workspace_mode === "git_worktree",
    intakeForm.end.trim().length > 0,
    intakeForm.accept_cmd.trim().length > 0,
    scopeCount > 0,
  ].filter(Boolean).length;

  const statusText = intakeBusy
    ? "AI 正在回复…"
    : intakeHasUnreadReply
      ? "已有新回复"
      : "未完成的新需求";

  return (
    <aside className="intake-dock" aria-label="未完成的新需求对话" data-intake-dock="true">
      <button type="button" className="intake-dock-main" onClick={() => store.go("intake")}>
        <span
          className={`intake-dock-dot ${
            intakeBusy ? "is-busy" : intakeHasUnreadReply ? "is-unread" : ""
          }`}
        />
        <span className="intake-dock-info">
          <span className="intake-dock-meta">
            <span>{statusText}</span>
            <span className="mono muted">
              {spaceLabel} · {readyFields}/8
            </span>
          </span>
          <span className="intake-dock-title">{displayTitle}</span>
        </span>
        <span className="intake-dock-cta">继续对话</span>
      </button>

      <button
        type="button"
        className="intake-dock-close"
        aria-label="关闭未完成的新需求对话"
        title="关闭对话"
        disabled={state.attachmentUploadBusy}
        onClick={() => void store.closeIntakeSession()}
      >
        ×
      </button>
    </aside>
  );
}
