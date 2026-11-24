import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LOCAL_PORT,
  DEFAULT_REMOTE_PORT,
  PRIORITIES,
  REMOTE_NOTIFICATION_CHANNELS,
  type Priority,
  type PublicPairedDevice,
  type RemoteConfig,
  type RemoteNotificationChannel,
  type RemotePairChallengeResponse,
  type TailscaleStatusResponse,
} from "@kiln/protocol/web";
import {
  createRemotePairingChallenge,
  fetchRemoteDevices,
  fetchRemoteSettings,
  fetchTailscaleStatus,
  revokeAllRemoteDevices,
  revokeRemoteDevice,
  sendRemoteNotificationTest,
  updateRemoteSettings,
} from "../api/client";
import type { RemoteRuntimeStatus } from "../api/types";
import { buildQrSvgGeometry } from "../lib/qr";
import { fmtDateShort, fmtTime } from "../state/format";
import { useKilnStore } from "../state/store";

const CHANNELS: Record<RemoteNotificationChannel, [string, string]> = {
  bark: ["Bark（iOS 推送）", "https://api.day.app/<device_key>"],
  ntfy: ["ntfy（跨平台推送）", "https://ntfy.sh/<topic>"],
  webhook: ["通用 Webhook", "https://example.com/kiln-webhook"],
};

const defaultDraft = (): RemoteConfig => ({
  schema_version: 1,
  enabled: false,
  remote_port: DEFAULT_REMOTE_PORT,
  keep_awake_on_ac: false,
  notifications: {
    enabled: false,
    channel: "webhook",
    url: "",
    priorities: ["P0", "P1"],
  },
});

const fmtTs = (iso?: string): string => (iso ? `${fmtDateShort(iso)} ${fmtTime(iso)}` : "—");

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "已过期，请重新生成";
  const s = Math.ceil(ms / 1000);
  return `剩余 ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to execCommand below
    }
  }
  if (typeof document !== "undefined") {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "true");
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand?.("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }
}

export function RemoteSettingsPanel() {
  const { store, state } = useKilnStore();
  const mounted = useRef(true);

  const [loading, setLoading] = useState(state.authMode === "local");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RemoteConfig>(defaultDraft);
  const [portInput, setPortInput] = useState(String(DEFAULT_REMOTE_PORT));
  const [publicUrlInput, setPublicUrlInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [runtime, setRuntime] = useState<RemoteRuntimeStatus>({
    listening: false,
    port: null,
    baseUrl: null,
  });
  const [devices, setDevices] = useState<PublicPairedDevice[]>([]);
  const [tailscale, setTailscale] = useState<TailscaleStatusResponse | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<RemotePairChallengeResponse | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [confirmTarget, setConfirmTarget] = useState<"all" | PublicPairedDevice | null>(null);
  const [pushFeedback, setPushFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const setFlag = (key: string, val: boolean): void => {
    if (mounted.current) setBusy((prev) => ({ ...prev, [key]: val }));
  };

  const loadAll = async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    const [sRes, dRes, tRes] = await Promise.allSettled([
      fetchRemoteSettings(),
      fetchRemoteDevices(),
      fetchTailscaleStatus(),
    ]);
    if (!mounted.current) return;
    if (sRes.status === "fulfilled") {
      const cfg = sRes.value.remote;
      setDraft(cfg);
      setPortInput(String(cfg.remote_port));
      setPublicUrlInput(cfg.public_url ?? "");
      setSecretInput(cfg.notifications.secret ?? "");
      setRuntime(sRes.value.runtime);
    } else {
      setLoadError(sRes.reason instanceof Error ? sRes.reason.message : "读取远程访问配置失败");
    }
    if (dRes.status === "fulfilled") setDevices(dRes.value.devices);
    if (tRes.status === "fulfilled") setTailscale(tRes.value);
    setLoading(false);
  };

  useEffect(() => {
    mounted.current = true;
    if (state.authMode === "local") void loadAll();
    return () => {
      mounted.current = false;
    };
  }, [state.authMode]);

  useEffect(() => {
    if (!challenge) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [challenge]);

  const effectivePairUrl = useMemo(() => {
    if (!challenge) return null;
    if (challenge.pairUrl) return challenge.pairUrl;
    const raw = publicUrlInput.trim();
    if (!raw || !isHttpUrl(raw)) return null;
    const parsed = new URL(raw);
    if (parsed.search || parsed.hash) return null;
    const base = raw.replace(/\/+$/, "");
    return `${base}/#pair=${encodeURIComponent(challenge.token)}`;
  }, [challenge, publicUrlInput]);

  const qr = useMemo(() => {
    if (!challenge) return null;
    try {
      return buildQrSvgGeometry(effectivePairUrl ?? challenge.token, 4);
    } catch {
      return null;
    }
  }, [challenge, effectivePairUrl]);

  if (state.authMode === "remote") {
    return (
      <div className="remote-readonly-card" role="region" aria-label="远程访问只读提示">
        <div className="remote-card-head">
          <h3>仅限本机桌面端管理远程访问</h3>
          <span className="chip chip-ask">远程只读隔离</span>
        </div>
        <p className="remote-card-desc">
          远程端口开关、公网地址、配对二维码、设备吊销与推送通知仅允许在宿主本机（
          <span className="mono">http://127.0.0.1:{DEFAULT_LOCAL_PORT}</span>
          ）管理，远程端口拒绝管理操作。
        </p>
        {state.authDevice ? (
          <div className="setting-row" style={{ marginTop: "8px" }}>
            <div>
              <span>当前远程设备：{state.authDevice.label}</span>
              <p className="mono">
                {state.authDevice.id} · 配对于 {fmtTs(state.authDevice.created_at)}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              style={{ justifySelf: "end" }}
              onClick={() => void store.logoutRemote()}
            >
              退出当前设备登录
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const refreshDevices = async (): Promise<void> => {
    try {
      const res = await fetchRemoteDevices();
      if (mounted.current) setDevices(res.devices);
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : "刷新已配对设备失败");
    }
  };

  const handleSave = async (): Promise<void> => {
    if (busy.save) return;
    setSaveError(null);
    const port = Number(portInput.trim());
    if (!portInput.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      setSaveError("远程端口必须为 1–65535 之间的整数。");
      return;
    }
    if (port === DEFAULT_LOCAL_PORT) {
      setSaveError(
        `远程端口不可与本机端口 ${DEFAULT_LOCAL_PORT} 冲突，默认 ${DEFAULT_REMOTE_PORT}。`,
      );
      return;
    }
    const pub = publicUrlInput.trim();
    if (pub) {
      if (!isHttpUrl(pub)) {
        setSaveError("公网访问地址必须是有效的 https:// 或 http:// URL。");
        return;
      }
      const parsed = new URL(pub);
      if (parsed.search || parsed.hash) {
        setSaveError("公网访问地址不能包含查询参数或 # 片段。");
        return;
      }
    }
    const nUrl = draft.notifications.url.trim();
    if (draft.notifications.enabled && !nUrl) {
      setSaveError("启用推送通知时必须填写推送地址 URL。");
      return;
    }
    if (nUrl && !isHttpUrl(nUrl)) {
      setSaveError("推送地址必须是有效的 https:// 或 http:// URL。");
      return;
    }

    const secret = secretInput.trim();
    const payload: RemoteConfig = {
      schema_version: 1,
      enabled: draft.enabled,
      remote_port: port,
      ...(pub ? { public_url: pub } : {}),
      keep_awake_on_ac: draft.keep_awake_on_ac,
      notifications: {
        enabled: draft.notifications.enabled,
        channel: draft.notifications.channel,
        url: nUrl,
        ...(secret ? { secret } : {}),
        priorities: draft.notifications.priorities,
      },
    };

    setFlag("save", true);
    try {
      const res = await updateRemoteSettings(payload);
      if (!mounted.current) return;
      setDraft(res.data);
      setPortInput(String(res.data.remote_port));
      setPublicUrlInput(res.data.public_url ?? "");
      setSecretInput(res.data.notifications.secret ?? "");
      setRuntime(res.runtime);
      store.showToast("已保存 config/remote.yaml");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存远程访问配置失败";
      if (mounted.current) setSaveError(msg);
      store.showToast(msg);
    } finally {
      setFlag("save", false);
    }
  };

  const handleConfirmRevoke = async (): Promise<void> => {
    if (!confirmTarget || busy.revoke) return;
    const target = confirmTarget;
    setConfirmTarget(null);
    setFlag("revoke", true);
    try {
      if (target === "all") {
        const res = await revokeAllRemoteDevices();
        await refreshDevices();
        store.showToast(
          `已踢出全部 ${res.revokedCount} 台设备（断开 ${res.closedStreams} 条实时流）`,
        );
      } else {
        const res = await revokeRemoteDevice(target.id);
        await refreshDevices();
        store.showToast(`已吊销设备「${target.label}」（断开 ${res.closedStreams} 条实时流）`);
      }
    } catch (err) {
      store.showToast(err instanceof Error ? err.message : "吊销设备失败");
    } finally {
      setFlag("revoke", false);
    }
  };

  const handleTestPush = async (): Promise<void> => {
    if (busy.push) return;
    setFlag("push", true);
    setPushFeedback(null);
    try {
      const url = draft.notifications.url.trim();
      const secret = secretInput.trim();
      const res = await sendRemoteNotificationTest({
        channel: draft.notifications.channel,
        ...(url ? { url } : {}),
        ...(secret ? { secret } : {}),
      });
      const text = `测试推送已送达（${res.channel ?? draft.notifications.channel}${res.status ? ` · HTTP ${res.status}` : ""}）`;
      if (mounted.current) setPushFeedback({ ok: true, text });
      store.showToast(text);
    } catch (err) {
      const text = err instanceof Error ? err.message : "测试推送发送失败";
      if (mounted.current) setPushFeedback({ ok: false, text });
      store.showToast(text);
    } finally {
      setFlag("push", false);
    }
  };

  const activeDevices = devices.filter((d) => !d.revoked_at);
  const recommendedCmd = `tailscale serve --bg http://127.0.0.1:${draft.remote_port}`;
  const remainMs = challenge ? Date.parse(challenge.expiresAt) - nowMs : 0;

  if (loading) return <div className="empty">正在读取远程访问配置…</div>;

  return (
    <div className="remote-panel">
      {loadError ? (
        <div className="conflict-box">
          <div className="conflict-head">
            <span>读取远程配置失败</span>
            <button type="button" className="btn btn-sm" onClick={() => void loadAll()}>
              重试
            </button>
          </div>
          <p>{loadError}</p>
        </div>
      ) : null}

      <section className="remote-section">
        <div className="remote-card-head">
          <div>
            <h3>远程监听与公网入口</h3>
            <p className="remote-card-desc">
              独立远程端口强制 HttpOnly 会话认证，与本机 :{DEFAULT_LOCAL_PORT} 隔离。
            </p>
          </div>
          <span
            className={`chip ${runtime.listening ? "chip-ok" : ""}`}
            data-remote-runtime={runtime.listening ? "listening" : "stopped"}
          >
            {runtime.listening ? `已监听 :${runtime.port ?? draft.remote_port}` : "未开启"}
          </span>
        </div>

        <div className="setting-row">
          <div>
            <span>启用远程访问监听</span>
            <p>热启停独立远程端口，供手机 PWA 经 HTTPS 隧道访问</p>
          </div>
          <label className="switch" style={{ justifySelf: "end" }}>
            <input
              type="checkbox"
              aria-label="启用远程访问"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: (e.currentTarget as HTMLInputElement).checked })
              }
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div>
            <span>远程监听端口</span>
            <p>
              默认 {DEFAULT_REMOTE_PORT}，仅绑 127.0.0.1 供隧道转发，不可为 {DEFAULT_LOCAL_PORT}
            </p>
          </div>
          <input
            type="number"
            className="input mono"
            aria-label="远程监听端口"
            min={1}
            max={65535}
            value={portInput}
            onChange={(e) => {
              const raw = (e.currentTarget as HTMLInputElement).value;
              setPortInput(raw);
              const n = Number(raw);
              if (Number.isInteger(n) && n >= 1 && n <= 65535) {
                setDraft({ ...draft, remote_port: n });
              }
            }}
          />
        </div>

        <div className="setting-row setting-row-wide">
          <div>
            <span>公网 HTTPS 地址（public_url）</span>
            <p>支持 Tailscale Serve、Cloudflare Tunnel 或任意 HTTPS 反代（不可含参数或 #）</p>
          </div>
          <input
            type="url"
            className="input mono"
            aria-label="公网 HTTPS 地址"
            placeholder="https://my-mac.tail12345.ts.net"
            value={publicUrlInput}
            onChange={(e) => setPublicUrlInput((e.currentTarget as HTMLInputElement).value)}
          />
        </div>

        <div className="setting-row">
          <div>
            <span>远程待命防休眠（仅插电时生效）</span>
            <p>
              仅接入交流电源时阻止系统自动休眠；电池供电不生效，笔记本合盖默认仍会休眠（合盖待命需接电源与外接显示器）
            </p>
          </div>
          <label className="switch" style={{ justifySelf: "end" }}>
            <input
              type="checkbox"
              aria-label="远程待命防休眠（仅插电时生效）"
              checked={draft.keep_awake_on_ac}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  keep_awake_on_ac: (e.currentTarget as HTMLInputElement).checked,
                })
              }
            />
            <span />
          </label>
        </div>

        {saveError ? (
          <p className="warn-line" role="alert">
            {saveError}
          </p>
        ) : null}

        <div className="remote-actions-row">
          <button
            type="button"
            className="btn btn-light"
            disabled={busy.save}
            onClick={() => void handleSave()}
          >
            {busy.save ? "保存中…" : "保存远程设置"}
          </button>
          <span className="muted">写入 config/remote.yaml 并即时生效</span>
        </div>
      </section>

      <section className="remote-section">
        <div className="remote-card-head">
          <div>
            <h3>Tailscale 隧道引导（兼容 Cloudflare / 任意 HTTPS 反代）</h3>
            <p className="remote-card-desc">
              请将隧道指向 <span className="mono">http://127.0.0.1:{draft.remote_port}</span>
              （切勿指向 :{DEFAULT_LOCAL_PORT}）。
            </p>
          </div>
          <div className="remote-head-actions">
            {tailscale ? (
              <span
                className={`chip ${
                  tailscale.running && tailscale.serveConfiguredForPort
                    ? "chip-ok"
                    : tailscale.running
                      ? "chip-ask"
                      : ""
                }`}
              >
                {!tailscale.installed
                  ? "未安装 Tailscale"
                  : !tailscale.running
                    ? `未运行${tailscale.backendState ? ` (${tailscale.backendState})` : ""}`
                    : tailscale.serveConfiguredForPort
                      ? `Serve 已转发 :${tailscale.remotePort}`
                      : `已运行 · 未转发 :${tailscale.remotePort}`}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy.ts}
              onClick={async () => {
                setFlag("ts", true);
                try {
                  const next = await fetchTailscaleStatus();
                  if (mounted.current) setTailscale(next);
                } catch (err) {
                  store.showToast(err instanceof Error ? err.message : "检测 Tailscale 失败");
                } finally {
                  setFlag("ts", false);
                }
              }}
            >
              {busy.ts ? "检测中…" : "重新检测"}
            </button>
          </div>
        </div>

        {tailscale?.magicDnsUrl ? (
          <div className="remote-inline-box">
            <div style={{ minWidth: 0 }}>
              <div className="muted" style={{ fontSize: "11.5px" }}>
                已探测到 MagicDNS HTTPS 地址
              </div>
              <div className="mono" style={{ fontSize: "12.5px", wordBreak: "break-all" }}>
                {tailscale.magicDnsUrl}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setPublicUrlInput(tailscale.magicDnsUrl ?? "");
                store.showToast("已填入公网地址，请点击「保存远程设置」");
              }}
            >
              填入公网地址
            </button>
          </div>
        ) : null}

        <div className="remote-cmd-box">
          <code className="mono">{recommendedCmd}</code>
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              await copyText(recommendedCmd);
              store.showToast("已复制 Tailscale Serve 命令");
            }}
          >
            复制命令
          </button>
        </div>
        {tailscale?.detail ? (
          <p className="muted" style={{ fontSize: "12px", marginTop: "6px" }}>
            {tailscale.detail}
          </p>
        ) : null}
      </section>

      <section className="remote-section">
        <div className="remote-card-head">
          <div>
            <h3>手机扫码与配对码</h3>
            <p className="remote-card-desc">5 分钟有效、5 次输错作废；二维码完全本地 SVG 渲染。</p>
          </div>
          <button
            type="button"
            className="btn btn-light btn-sm"
            disabled={busy.pair}
            onClick={async () => {
              setFlag("pair", true);
              try {
                const next = await createRemotePairingChallenge();
                if (mounted.current) {
                  setChallenge(next);
                  setNowMs(Date.now());
                }
              } catch (err) {
                store.showToast(err instanceof Error ? err.message : "生成配对码失败");
              } finally {
                setFlag("pair", false);
              }
            }}
          >
            {busy.pair ? "生成中…" : challenge ? "重新生成配对码" : "生成配对二维码"}
          </button>
        </div>

        {!runtime.listening ? (
          <p className="warn-line" style={{ marginTop: "0", marginBottom: "10px" }}>
            提示：远程监听未开启，请先启用并保存上方配置后再用手机访问。
          </p>
        ) : null}

        {challenge ? (
          <div className="pair-box">
            {qr ? (
              <div className="qr-frame">
                <svg
                  className="qr-svg"
                  viewBox={`0 0 ${qr.viewBoxSize} ${qr.viewBoxSize}`}
                  width="176"
                  height="176"
                  role="img"
                  aria-label="远程配对二维码"
                >
                  <rect x="0" y="0" width={qr.viewBoxSize} height={qr.viewBoxSize} fill="#ffffff" />
                  <path d={qr.pathData} fill="#121110" shapeRendering="crispEdges" />
                </svg>
              </div>
            ) : null}
            <div className="pair-info">
              <div className="pair-label">6 位一次性配对码</div>
              <div className="pair-code mono" data-pairing-code={challenge.code}>
                {challenge.code.length === 6
                  ? `${challenge.code.slice(0, 3)} ${challenge.code.slice(3)}`
                  : challenge.code}
              </div>
              <div
                className={`pair-countdown mono ${remainMs <= 0 ? "is-expired" : ""}`}
                data-pairing-countdown
              >
                {fmtCountdown(remainMs)}
              </div>
              {!effectivePairUrl ? (
                <p className="warn-line" style={{ marginTop: "4px", fontSize: "12px" }}>
                  尚未配置公网 HTTPS 地址，手机打开远程页后请手动输入上方 6 位配对码。
                </p>
              ) : null}
              <div className="pair-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await copyText(challenge.code);
                    store.showToast("已复制 6 位配对码");
                  }}
                >
                  复制配对码
                </button>
                {effectivePairUrl ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      await copyText(effectivePairUrl);
                      store.showToast("已复制一次性配对链接");
                    }}
                  >
                    复制配对链接
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="remote-empty-hint">
            点击右上角「生成配对二维码」，手机扫码或输入 6 位码即可登录。
          </div>
        )}
      </section>

      <section className="remote-section">
        <div className="remote-card-head">
          <div>
            <h3>已配对设备（有效 {activeDevices.length} 台）</h3>
            <p className="remote-card-desc">
              仅存 SHA-256 哈希于 <span className="mono">config/devices.yaml</span>
              （0600），吊销即时断流。
            </p>
          </div>
          <div className="remote-head-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void refreshDevices()}
            >
              刷新
            </button>
            {activeDevices.length > 0 ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy.revoke}
                onClick={() => setConfirmTarget("all")}
              >
                踢出全部设备
              </button>
            ) : null}
          </div>
        </div>

        {confirmTarget ? (
          <div
            className="confirm-bar"
            role="alertdialog"
            aria-label={confirmTarget === "all" ? "确认踢出全部设备" : "确认吊销设备"}
          >
            <p>
              {confirmTarget === "all" ? (
                `确认吊销全部 ${activeDevices.length} 台有效远程设备并立即断开实时连接？`
              ) : (
                <>
                  确认吊销设备「{confirmTarget.label}」（
                  <span className="mono">{confirmTarget.id}</span>）？会话将立即失效。
                </>
              )}
            </p>
            <div className="remote-head-actions">
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy.revoke}
                onClick={() => void handleConfirmRevoke()}
              >
                {confirmTarget === "all" ? "确认踢出全部" : "确认吊销"}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmTarget(null)}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        {devices.length === 0 ? (
          <div className="remote-empty-hint">暂无已配对设备。</div>
        ) : (
          <table className="t" style={{ marginTop: "8px" }}>
            <thead>
              <tr>
                <th>设备</th>
                <th style={{ width: "130px" }}>配对时间</th>
                <th style={{ width: "130px" }}>最后活跃</th>
                <th style={{ width: "80px" }}>状态</th>
                <th style={{ width: "80px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((dev) => {
                const revoked = Boolean(dev.revoked_at);
                return (
                  <tr key={dev.id}>
                    <td>
                      <div className="role-name">{dev.label}</div>
                      <div className="role-desc mono">{dev.id}</div>
                    </td>
                    <td className="mono" style={{ fontSize: "12px" }}>
                      {fmtTs(dev.created_at)}
                    </td>
                    <td className="mono" style={{ fontSize: "12px" }}>
                      {fmtTs(dev.last_seen_at)}
                    </td>
                    <td>
                      <span className={`chip ${revoked ? "chip-bad" : "chip-ok"}`}>
                        {revoked ? "已吊销" : "有效"}
                      </span>
                    </td>
                    <td>
                      {revoked ? (
                        <span className="muted">—</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={busy.revoke}
                          onClick={() => setConfirmTarget(dev)}
                        >
                          吊销
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="remote-section">
        <div className="remote-card-head">
          <div>
            <h3>待决推送通知（Bark / ntfy / Webhook）</h3>
            <p className="remote-card-desc">
              命中选定优先级的待决任务将非阻塞推送至手机（默认 P0 / P1）。
            </p>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <span>启用推送通知</span>
            <p>超时严格 ≤ 5 秒，失败不影响守护进程</p>
          </div>
          <label className="switch" style={{ justifySelf: "end" }}>
            <input
              type="checkbox"
              aria-label="启用待决推送通知"
              checked={draft.notifications.enabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  notifications: {
                    ...draft.notifications,
                    enabled: (e.currentTarget as HTMLInputElement).checked,
                  },
                })
              }
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div>
            <span>推送通道</span>
            <p>支持 Bark、ntfy 或自定义 Webhook</p>
          </div>
          <select
            className="select"
            aria-label="推送通道"
            value={draft.notifications.channel}
            onChange={(e) =>
              setDraft({
                ...draft,
                notifications: {
                  ...draft.notifications,
                  channel: (e.currentTarget as HTMLSelectElement)
                    .value as RemoteNotificationChannel,
                },
              })
            }
          >
            {REMOTE_NOTIFICATION_CHANNELS.map((ch) => (
              <option key={ch} value={ch}>
                {CHANNELS[ch][0]}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-row setting-row-wide">
          <div>
            <span>推送目标 URL</span>
            <p>Bark Key URL、ntfy 主题 URL 或 Webhook 接收地址</p>
          </div>
          <input
            type="url"
            className="input mono"
            aria-label="推送地址"
            placeholder={CHANNELS[draft.notifications.channel][1]}
            value={draft.notifications.url}
            onChange={(e) =>
              setDraft({
                ...draft,
                notifications: {
                  ...draft.notifications,
                  url: (e.currentTarget as HTMLInputElement).value,
                },
              })
            }
          />
        </div>

        <div className="setting-row setting-row-wide">
          <div>
            <span>签名密钥 / Token（可选）</span>
            <p>附带 Bearer 与 X-Kiln-Signature-256 HMAC 签名</p>
          </div>
          <input
            type="password"
            className="input mono"
            aria-label="推送密钥"
            placeholder="可选"
            value={secretInput}
            onChange={(e) => setSecretInput((e.currentTarget as HTMLInputElement).value)}
          />
        </div>

        <div className="setting-row setting-row-wide">
          <div>
            <span>触发推送的优先级</span>
            <p>默认勾选 P0 / P1</p>
          </div>
          <div className="priority-checks" role="group" aria-label="推送优先级">
            {PRIORITIES.map((p: Priority) => (
              <label key={p} className="pri-check">
                <input
                  type="checkbox"
                  aria-label={`推送优先级 ${p}`}
                  checked={draft.notifications.priorities.includes(p)}
                  onChange={(e) => {
                    const next = new Set(draft.notifications.priorities);
                    if ((e.currentTarget as HTMLInputElement).checked) next.add(p);
                    else next.delete(p);
                    setDraft({
                      ...draft,
                      notifications: {
                        ...draft.notifications,
                        priorities: PRIORITIES.filter((x) => next.has(x)),
                      },
                    });
                  }}
                />
                <span className={`pri pri-${p}`}>{p}</span>
              </label>
            ))}
          </div>
        </div>

        {pushFeedback ? (
          <p
            className={pushFeedback.ok ? "modal-ok" : "warn-line"}
            role="status"
            style={{ marginTop: "10px" }}
          >
            {pushFeedback.text}
          </p>
        ) : null}

        <div className="remote-actions-row">
          <button
            type="button"
            className="btn btn-light"
            disabled={busy.save}
            onClick={() => void handleSave()}
          >
            {busy.save ? "保存中…" : "保存远程设置"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy.push}
            onClick={() => void handleTestPush()}
          >
            {busy.push ? "发送中…" : "发送测试推送"}
          </button>
        </div>
      </section>
    </div>
  );
}
