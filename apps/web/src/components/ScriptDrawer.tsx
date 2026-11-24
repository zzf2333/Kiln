import { SPACE_SCRIPT_KEYS, type SpaceScriptKey } from "@kiln/protocol/web";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SpaceScripts } from "../api/types";
import { useKilnStore, type ScriptRunBuffer } from "../state/store";
import { CloseIcon, TerminalIcon } from "./Icons";

export interface ScriptDrawerProps {
  spaceId: string;
  taskId: string;
  scripts?: SpaceScripts;
}

export function ScriptDrawer({ spaceId, taskId, scripts }: ScriptDrawerProps) {
  const { store, state } = useKilnStore();
  const outRef = useRef<HTMLPreElement | null>(null);

  const configuredKeys = useMemo(
    () =>
      SPACE_SCRIPT_KEYS.filter(
        (key) => typeof scripts?.[key] === "string" && scripts[key]!.trim().length > 0,
      ),
    [scripts],
  );

  const [selectedKey, setSelectedKey] = useState<SpaceScriptKey>(
    () =>
      configuredKeys.includes("test")
        ? "test"
        : (configuredKeys[0] ?? "test"),
  );

  useEffect(() => {
    if (configuredKeys.length > 0 && !configuredKeys.includes(selectedKey)) {
      setSelectedKey(
        configuredKeys.includes("test") ? "test" : configuredKeys[0]!,
      );
    }
  }, [configuredKeys, selectedKey]);

  const currentRun = useMemo<ScriptRunBuffer | undefined>(() => {
    const matching = Object.values(state.scriptRuns).filter(
      (run) =>
        run.spaceId === spaceId &&
        run.scriptKey === selectedKey &&
        (run.taskId === taskId || !run.taskId),
    );
    if (matching.length === 0) return undefined;
    matching.sort((a, b) => {
      const taskBiasA = a.taskId === taskId ? 1 : 0;
      const taskBiasB = b.taskId === taskId ? 1 : 0;
      if (taskBiasA !== taskBiasB) return taskBiasB - taskBiasA;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return matching[0];
  }, [state.scriptRuns, spaceId, taskId, selectedKey]);

  useEffect(() => {
    if (!state.scriptDrawerOpen || !outRef.current) return;
    outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [state.scriptDrawerOpen, currentRun?.lines.length]);

  if (!state.scriptDrawerOpen) {
    return null;
  }

  const activeCommand = scripts?.[selectedKey]?.trim() ?? "";
  const isRunning = Boolean(currentRun && !currentRun.done);

  return (
    <section className="script-drawer" aria-label="项目脚本输出">
      <div className="script-head">
        <span className="script-title">
          <TerminalIcon />
          <span>脚本输出</span>
        </span>

        {configuredKeys.length > 0 ? (
          <div className="script-tabs" role="tablist" aria-label="空间脚本列表">
            {configuredKeys.map((key) => {
              const runningForKey = Object.values(state.scriptRuns).some(
                (r) =>
                  r.spaceId === spaceId &&
                  r.scriptKey === key &&
                  (r.taskId === taskId || !r.taskId) &&
                  !r.done,
              );
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={selectedKey === key}
                  className={`script-tab ${selectedKey === key ? "on" : ""}`}
                  onClick={() => setSelectedKey(key)}
                >
                  <span>{key}</span>
                  {runningForKey ? <span className="dot dot-run" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {currentRun ? (
          <span
            className={`chip ${
              !currentRun.done
                ? "chip-live"
                : currentRun.exitCode === 0
                  ? "chip-ok"
                  : "chip-bad"
            }`}
          >
            {!currentRun.done
              ? "运行中"
              : currentRun.exitCode !== null
                ? `exit ${currentRun.exitCode}`
                : "已结束"}
          </span>
        ) : null}

        {activeCommand ? (
          <span className="script-cmd mono muted" title={activeCommand}>
            $ {activeCommand}
          </span>
        ) : null}

        <span className="sp" />

        {configuredKeys.length > 0 ? (
          isRunning && currentRun ? (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void store.stopScriptRun(currentRun.scriptRunId)}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-light"
              onClick={() =>
                void store.startSpaceScript(spaceId, selectedKey, taskId)
              }
            >
              {currentRun ? "重新运行" : "运行"}
            </button>
          )
        ) : null}

        {currentRun ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => store.clearScriptRunOutput(currentRun.scriptRunId)}
          >
            清空
          </button>
        ) : null}

        <button
          type="button"
          className="icon-btn"
          aria-label="收起脚本抽屉"
          title="收起 (J)"
          onClick={() => store.setScriptDrawerOpen(false)}
        >
          <CloseIcon />
        </button>
      </div>

      {currentRun?.detectedUrls && currentRun.detectedUrls.length > 0 ? (
        <div className="script-preview-bar" aria-label="探测到的本机预览地址">
          <span className="muted">本机预览</span>
          {currentRun.detectedUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="chip chip-ok mono"
            >
              ↗ {url}
            </a>
          ))}
          {state.authMode === "remote" ? (
            <span className="muted">（仅宿主机本机可访问）</span>
          ) : null}
        </div>
      ) : null}

      {configuredKeys.length === 0 ? (
        <div className="script-empty">
          <span>
            当前项目空间尚未配置脚本，可在「设置 → 项目空间」配置 setup / dev / test / lint / deliver。
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => store.go("settings", { settingsTab: "spaces" })}
          >
            前往配置脚本
          </button>
        </div>
      ) : (
        <pre ref={outRef} className="script-out mono">
          {currentRun && currentRun.lines.length > 0
            ? currentRun.lines.join("\n")
            : `$ ${activeCommand}\n点击上方「运行」开始执行空间脚本`}
        </pre>
      )}
    </section>
  );
}
