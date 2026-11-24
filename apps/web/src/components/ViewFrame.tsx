import type { ReactNode } from "react";
import { fmtTime } from "../state/format";
import { useKilnStore } from "../state/store";
import { MenuIcon } from "./Icons";

export interface ViewFrameProps {
  left: ReactNode;
  right?: ReactNode;
  isBoard?: boolean;
  children: ReactNode;
}

export function ViewFrame({ left, right, isBoard, children }: ViewFrameProps) {
  const { store, state } = useKilnStore();
  const isOffline = state.sseStatus === "reconnecting" || state.networkOffline;
  const lastOnlineText = state.lastConnectedAt ? fmtTime(state.lastConnectedAt) : "尚未连接";

  return (
    <section className="main">
      {state.authMode === "remote" && state.authAuthenticated ? (
        <div className="remote-bar" role="status" aria-label="远程会话状态">
          <span className="remote-bar-label">
            <span className="dot remote-dot" />
            <span className="remote-bar-text">
              远程 · {state.authDevice?.label ?? "已配对设备"}
            </span>
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void store.logoutRemote()}
          >
            退出登录
          </button>
        </div>
      ) : null}

      {isOffline ? (
        <div className="offline-banner" role="status" aria-live="polite" data-offline-banner="true">
          <span className="offline-banner-text">
            <span className="dot offline-dot" />
            <span>主机离线或连接已断开（最后在线 {lastOnlineText}）— 正在自动重连…</span>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={state.retryingConnection}
            onClick={() => void store.retryConnection()}
          >
            {state.retryingConnection ? "重试中…" : "立即重试"}
          </button>
        </div>
      ) : null}

      <header className={`topbar ${isBoard ? "is-board" : ""}`}>
        <button
          type="button"
          className="menu-btn"
          aria-label="打开导航"
          onClick={() => store.setNavOpen(!state.navOpen)}
        >
          <MenuIcon />
        </button>
        <div className="tb-l" id="tbL">
          {left}
        </div>
        <div className="tb-r" id="tbR">
          {right}
        </div>
      </header>
      <div className="view" id="view">
        {children}
      </div>
    </section>
  );
}
