import { Popover } from "radix-ui";
import { useRef, useState } from "react";
import type { CheckpointRecord } from "../api/types";
import { fmtTime, stageMeta } from "../state/format";
import { useKilnStore } from "../state/store";
import { HistoryIcon, RefreshIcon } from "./Icons";

export interface CheckpointPopoverProps {
  taskId: string;
  checkpoints: CheckpointRecord[];
  isRunning: boolean;
}

export function CheckpointPopover({ taskId, checkpoints, isRunning }: CheckpointPopoverProps) {
  const { store } = useKilnStore();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRef, setConfirmRef] = useState<string | null>(null);
  const [rollingBackRef, setRollingBackRef] = useState<string | null>(null);
  const rollbackLockRef = useRef(false);

  const handleRefresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await store.refreshTaskCheckpoints(taskId);
    } finally {
      setRefreshing(false);
    }
  };

  const handleRollback = async (ref: string): Promise<void> => {
    if (isRunning || rollingBackRef || rollbackLockRef.current) return;
    rollbackLockRef.current = true;
    setRollingBackRef(ref);
    try {
      const ok = await store.rollbackTaskCheckpoint(taskId, ref);
      if (ok) {
        setConfirmRef(null);
        setOpen(false);
      }
    } finally {
      rollbackLockRef.current = false;
      setRollingBackRef(null);
    }
  };

  const ordered = [...checkpoints].reverse();

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void handleRefresh();
        } else {
          setConfirmRef(null);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className="btn" aria-label={`快照（${checkpoints.length}）`}>
          <HistoryIcon />
          <span>快照</span>
          {checkpoints.length > 0 ? <span className="nav-count">{checkpoints.length}</span> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="ckpt-pop"
          align="end"
          sideOffset={6}
          aria-label="Git 检查点快照"
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            setConfirmRef(null);
            setOpen(false);
          }}
        >
          <div className="ckpt-head">
            <b>Git 检查点快照</b>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
            >
              <RefreshIcon />
              <span>{refreshing ? "刷新中…" : "刷新"}</span>
            </button>
          </div>

          {isRunning ? (
            <div className="note note-ask" style={{ marginBottom: "8px" }}>
              任务运行中，请先暂停再回滚快照
            </div>
          ) : null}

          {ordered.length === 0 ? (
            <p className="muted" style={{ fontSize: "12px", padding: "8px 0" }}>
              暂无快照，阶段完成后会自动记录 Git 检查点
            </p>
          ) : (
            <div className="ckpt-list">
              {ordered.map((cp) => {
                const stMeta = stageMeta(cp.stage);
                const confirming = confirmRef === cp.ref;
                const busyThis = rollingBackRef === cp.ref;
                return (
                  <div key={cp.ref} className="ckpt-item">
                    <div className="ckpt-row">
                      <div className="ckpt-title">
                        <b>
                          {stMeta.label}
                          {cp.round > 1 ? ` · 第 ${cp.round} 轮` : ""}
                        </b>
                        <span className="mono muted">{cp.commit_sha.slice(0, 7)}</span>
                        <span className="mono muted">{fmtTime(cp.created_at)}</span>
                      </div>
                      {!confirming ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={isRunning || rollingBackRef !== null}
                          onClick={() => setConfirmRef(cp.ref)}
                        >
                          回滚到此快照
                        </button>
                      ) : null}
                    </div>
                    <div className="ckpt-ref mono muted" title={cp.ref}>
                      {cp.ref}
                    </div>
                    {confirming ? (
                      <div className="ckpt-confirm">
                        <span>确认将工作树回滚到此快照？</span>
                        <div className="ckpt-confirm-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={isRunning || busyThis}
                            onClick={() => void handleRollback(cp.ref)}
                          >
                            {busyThis ? "回滚中…" : "确认回滚"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyThis}
                            onClick={() => setConfirmRef(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
