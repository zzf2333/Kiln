import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { TaskStatus } from "@kiln/protocol/web";
import type { DeliverGitResponse } from "../api/types";
import { isSafeHttpUrl } from "../state/format";
import { useKilnStore } from "../state/store";
import { CloseIcon, GitPrIcon } from "./Icons";

export interface DeliverPrModalProps {
  taskId: string;
  taskStatus: TaskStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeliverPrModal({
  taskId,
  taskStatus,
  open,
  onOpenChange,
}: DeliverPrModalProps) {
  const { store } = useKilnStore();
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [busyAction, setBusyAction] = useState<"commit" | "push" | "open_pr" | null>(
    null,
  );
  const actionLockRef = useRef(false);
  const [branch, setBranch] = useState(`kiln/${taskId}`);
  const [baseBranch, setBaseBranch] = useState("main");
  const [commitMessage, setCommitMessage] = useState(`[${taskId}] 交付任务改动`);
  const [prTitle, setPrTitle] = useState(`[${taskId}]`);
  const [prBody, setPrBody] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<
    Extract<DeliverGitResponse, { action: "commit" }> | null
  >(null);
  const [pushResult, setPushResult] = useState<
    Extract<DeliverGitResponse, { action: "push" }> | null
  >(null);
  const [prResult, setPrResult] = useState<
    Extract<DeliverGitResponse, { action: "open_pr" }> | null
  >(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingDraft(true);
    setErrorMsg(null);
    setCommitResult(null);
    setPushResult(null);
    setPrResult(null);

    void store
      .fetchPrDraft(taskId)
      .then((draft) => {
        if (cancelled || !draft) return;
        setBranch(draft.branch);
        setBaseBranch(draft.baseBranch);
        setCommitMessage(draft.title);
        setPrTitle(draft.title);
        setPrBody(draft.body);
      })
      .finally(() => {
        if (!cancelled) setLoadingDraft(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, taskId, store]);

  if (!open) {
    return null;
  }

  const isTaskRunning = taskStatus === "running";
  const controlsDisabled = isTaskRunning || busyAction !== null;

  const runAction = async (action: "commit" | "push" | "open_pr"): Promise<void> => {
    if (controlsDisabled || actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction(action);
    setErrorMsg(null);
    try {
      const payload =
        action === "commit"
          ? {
              action: "commit" as const,
              branch: branch.trim() || undefined,
              commit_message: commitMessage.trim() || prTitle.trim() || `[${taskId}] commit`,
              confirm: true as const,
            }
          : action === "push"
            ? {
                action: "push" as const,
                branch: branch.trim() || undefined,
                confirm: true as const,
              }
            : {
                action: "open_pr" as const,
                branch: branch.trim() || undefined,
                base_branch: baseBranch.trim() || undefined,
                pr_title: prTitle.trim() || undefined,
                pr_body: prBody,
                confirm: true as const,
              };
      const res = await store.executeGitDeliver(taskId, payload);
      if (!res) {
        setErrorMsg("Git 交付请求未成功完成，请查看上方提示或工作树状态");
        return;
      }
      if (res.action === "commit") setCommitResult(res);
      else if (res.action === "push") setPushResult(res);
      else setPrResult(res);
    } finally {
      actionLockRef.current = false;
      setBusyAction(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="palette-mask open"
          onClick={(e) => {
            if (e.target === e.currentTarget) onOpenChange(false);
          }}
        >
          <Dialog.Content
            className="modal-card modal-card-wide"
            aria-describedby={undefined}
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              onOpenChange(false);
            }}
          >
            <div className="modal-head">
              <Dialog.Title className="pr-modal-title">
                <GitPrIcon />
                <span>Commit → Push → Open PR</span>
              </Dialog.Title>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭交付弹窗"
                onClick={() => onOpenChange(false)}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="modal-body">
              <p className="muted" style={{ fontSize: "12.5px", lineHeight: 1.55 }}>
                每一步均需显式点击确认后才执行，绝不自动推送。推送与建 PR 前会先执行只读探测，避免重复创建。
              </p>

              {isTaskRunning ? (
                <div className="note note-ask">
                  任务正在执行中，请先等待当前轮次结束或暂停后再执行 Git 提交与 PR 操作。
                </div>
              ) : null}

              {errorMsg ? <div className="note note-bad">{errorMsg}</div> : null}

              {loadingDraft ? (
                <p className="muted" style={{ fontSize: "12.5px" }}>
                  正在基于 BRIEF.md / PLAN.md / GATE.yaml 生成 PR 草案…
                </p>
              ) : null}

              <div className="modal-grid">
                <label className="modal-field">
                  <span>工作分支 (branch)</span>
                  <input
                    className="input mono"
                    value={branch}
                    disabled={controlsDisabled}
                    onChange={(e) => setBranch(e.currentTarget.value)}
                  />
                </label>
                <label className="modal-field">
                  <span>目标基础分支 (base_branch)</span>
                  <input
                    className="input mono"
                    value={baseBranch}
                    disabled={controlsDisabled}
                    onChange={(e) => setBaseBranch(e.currentTarget.value)}
                  />
                </label>
              </div>

              <label className="modal-field">
                <span>提交信息 (commit_message)</span>
                <input
                  className="input"
                  value={commitMessage}
                  disabled={controlsDisabled}
                  onChange={(e) => setCommitMessage(e.currentTarget.value)}
                />
              </label>

              <label className="modal-field">
                <span>PR 标题</span>
                <input
                  className="input"
                  value={prTitle}
                  disabled={controlsDisabled}
                  onChange={(e) => setPrTitle(e.currentTarget.value)}
                />
              </label>

              <label className="modal-field">
                <span>PR 说明正文（源自 BRIEF / RESEARCH / PLAN / GATE）</span>
                <textarea
                  className="input mono pr-body-in"
                  rows={6}
                  value={prBody}
                  disabled={controlsDisabled}
                  onChange={(e) => setPrBody(e.currentTarget.value)}
                />
              </label>

              <div className="pr-steps">
                <div className="pr-step">
                  <div>
                    <b>1. 本地提交 (git commit)</b>
                    <p className="muted">
                      {commitResult
                        ? commitResult.alreadyClean
                          ? `工作树已是干净状态（HEAD ${commitResult.commitSha.slice(0, 7)}）`
                          : `已提交 ${commitResult.commitSha.slice(0, 7)} 到 ${commitResult.branch}`
                        : "将当前工作树改动提交到本地分支"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={controlsDisabled}
                    onClick={() => void runAction("commit")}
                  >
                    {busyAction === "commit" ? "提交中…" : "确认 Commit"}
                  </button>
                </div>

                <div className="pr-step">
                  <div>
                    <b>2. 推送远端 (git push)</b>
                    <p className="muted">
                      {pushResult
                        ? pushResult.alreadyUpToDate
                          ? `远端分支 ${pushResult.branch} 已是最新 (${pushResult.commitSha.slice(0, 7)})`
                          : `已推送 ${pushResult.commitSha.slice(0, 7)} 至 origin/${pushResult.branch}`
                        : "先通过 ls-remote 探测远端，再推送分支"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={controlsDisabled}
                    onClick={() => void runAction("push")}
                  >
                    {busyAction === "push" ? "推送中…" : "确认 Push"}
                  </button>
                </div>

                <div className="pr-step">
                  <div>
                    <b>3. 创建 Pull Request (gh pr create)</b>
                    <p className="muted">
                      {prResult ? (
                        <>
                          {prResult.alreadyExists ? "已存在同分支 PR" : "已创建 PR"}
                          {prResult.prNumber ? ` #${prResult.prNumber}` : ""}
                          {isSafeHttpUrl(prResult.prUrl) ? (
                            <>
                              {" · "}
                              <a
                                className="md-link"
                                href={prResult.prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {prResult.prUrl}
                              </a>
                            </>
                          ) : null}
                        </>
                      ) : (
                        "先检索是否已有同分支 PR，避免重复建单"
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-light"
                    disabled={controlsDisabled}
                    onClick={() => void runAction("open_pr")}
                  >
                    {busyAction === "open_pr" ? "创建中…" : "确认 Open PR"}
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-foot">
              <button
                type="button"
                className="btn"
                onClick={() => onOpenChange(false)}
              >
                关闭
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
