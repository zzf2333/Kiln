import type { ComponentChildren } from "preact";
import { fmtTime } from "../state/format";
import { useKilnStore } from "../state/store";
import { MenuIcon } from "./Icons";

export interface ViewFrameProps {
  left: ComponentChildren;
  right?: ComponentChildren;
  isBoard?: boolean;
  children: ComponentChildren;
}

export function ViewFrame({ left, right, isBoard, children }: ViewFrameProps) {
  const { store, state } = useKilnStore();
  const isOffline = state.sseStatus === "reconnecting" || state.networkOffline;
  const lastOnlineText = state.lastConnectedAt
    ? fmtTime(state.lastConnectedAt)
    : "尚未连接";

  return (
    <section class="main">
      {state.authMode === "remote" && state.authAuthenticated ? (
        <div class="remote-bar" role="status" aria-label="远程会话状态">
          <span class="remote-bar-label">
            <span class="dot remote-dot" />
            <span class="remote-bar-text">
              远程 · {state.authDevice?.label ?? "已配对设备"}
            </span>
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void store.logoutRemote()}
          >
            退出登录
          </button>
        </div>
      ) : null}

      {isOffline ? (
        <div
          class="offline-banner"
          role="status"
          aria-live="polite"
          data-offline-banner="true"
        >
          <span class="offline-banner-text">
            <span class="dot offline-dot" />
            <span>
              主机离线或连接已断开（最后在线 {lastOnlineText}）— 正在自动重连…
            </span>
          </span>
          <button
            type="button"
            class="btn btn-sm"
            disabled={state.retryingConnection}
            onClick={() => void store.retryConnection()}
          >
            {state.retryingConnection ? "重试中…" : "立即重试"}
          </button>
        </div>
      ) : null}

      <header class={`topbar ${isBoard ? "is-board" : ""}`}>
        <button
          type="button"
          class="menu-btn"
          aria-label="打开导航"
          onClick={() => store.setNavOpen(!state.navOpen)}
        >
          <MenuIcon />
        </button>
        <div class="tb-l" id="tbL">
          {left}
        </div>
        <div class="tb-r" id="tbR">
          {right}
        </div>
      </header>
      <div class="view" id="view">
        {children}
      </div>
    </section>
  );
}
