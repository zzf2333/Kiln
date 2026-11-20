import { useState } from "preact/hooks";
import { BrandIcon } from "../components/Icons";
import { useKilnStore, type PairSubmitOutcome } from "../state/store";

function inferDefaultDeviceLabel(): string {
  if (typeof navigator === "undefined") return "移动设备";
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) return "我的 iPhone";
  if (/iPad/i.test(ua)) return "我的 iPad";
  if (/Android/i.test(ua)) return "Android 手机";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac 浏览器";
  if (/Windows/i.test(ua)) return "Windows 浏览器";
  return "移动设备";
}

function formatPairError(res: PairSubmitOutcome): string {
  switch (res.code) {
    case "invalid_pairing_challenge":
      return "桌面端当前没有有效的配对码，请在桌面端「设置 → 远程访问」重新生成。";
    case "pairing_expired":
      return "配对凭证已过期（5 分钟有效），请在桌面端重新生成后再试。";
    case "pairing_attempts_exceeded":
      return "连续输错次数已达上限（5 次），本次配对码已自动作废，请在桌面端重新生成。";
    case "invalid_pairing_credentials":
      return res.attemptsRemaining !== undefined
        ? `配对码或凭证不正确（剩余 ${res.attemptsRemaining} 次尝试）。`
        : "配对码或凭证不正确，请核对后重试。";
    default:
      return res.message ?? "配对失败，请重试。";
  }
}

export function RemoteAuthView() {
  const { store, state } = useKilnStore();
  const [deviceLabel, setDeviceLabel] = useState<string>(() =>
    inferDefaultDeviceLabel(),
  );
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const hasToken = Boolean(state.pendingPairToken);

  const submitToken = async (): Promise<void> => {
    if (!state.pendingPairToken || busy) return;
    setBusy(true);
    setErrorText(null);
    const label = deviceLabel.trim();
    const res = await store.completeRemotePairing({
      token: state.pendingPairToken,
      ...(label ? { label } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setErrorText(formatPairError(res));
      if (
        res.code === "pairing_expired" ||
        res.code === "invalid_pairing_challenge" ||
        res.code === "pairing_attempts_exceeded"
      ) {
        store.clearPendingPairToken();
      }
    }
  };

  const submitCode = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const normalized = codeInput.replace(/[\s-]+/g, "").trim();
    if (!normalized) {
      setErrorText("请输入桌面端显示的 6 位配对码。");
      return;
    }
    setBusy(true);
    setErrorText(null);
    const label = deviceLabel.trim();
    const res = await store.completeRemotePairing({
      code: normalized,
      ...(label ? { label } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setErrorText(formatPairError(res));
    }
  };

  return (
    <main class="auth-gate" aria-label="Kiln 远程配对登录">
      <div class="auth-card">
        <div class="auth-brand">
          <span class="brand-mark">
            <BrandIcon />
          </span>
          <div>
            <h1>Kiln 远程访问</h1>
            <p class="auth-sub">需配对授权后方可访问本机工作台</p>
          </div>
        </div>

        {state.authNotice ? (
          <div class="auth-notice" role="alert">
            {state.authNotice}
          </div>
        ) : null}

        {errorText ? (
          <div class="auth-error" role="alert">
            {errorText}
          </div>
        ) : null}

        {hasToken ? (
          <div class="auth-section">
            <div class="auth-token-banner">
              <strong>已读取一次性扫码配对凭证</strong>
              <p>配对链接中的一次性令牌已自动从浏览器地址栏与历史记录清除。</p>
            </div>

            <label class="modal-field">
              <span>设备名称（用于桌面端识别与管理）</span>
              <input
                type="text"
                class="input"
                aria-label="设备名称"
                maxLength={120}
                placeholder="例如：我的 iPhone"
                value={deviceLabel}
                onInput={(e) =>
                  setDeviceLabel((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>

            <button
              type="button"
              class="btn btn-light auth-submit"
              disabled={busy}
              onClick={() => void submitToken()}
            >
              {busy ? "配对中…" : "一键完成配对"}
            </button>

            <button
              type="button"
              class="btn btn-ghost auth-switch"
              disabled={busy}
              onClick={() => {
                setErrorText(null);
                store.clearPendingPairToken();
              }}
            >
              改用 6 位配对码手动输入
            </button>
          </div>
        ) : (
          <form class="auth-section" onSubmit={(e) => void submitCode(e)}>
            <label class="modal-field">
              <span>6 位配对码</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                class="input mono auth-code-input"
                aria-label="6 位配对码"
                placeholder="000000"
                maxLength={12}
                value={codeInput}
                onInput={(e) =>
                  setCodeInput((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>

            <label class="modal-field">
              <span>设备名称（可选）</span>
              <input
                type="text"
                class="input"
                aria-label="设备名称"
                maxLength={120}
                placeholder="例如：我的 iPhone"
                value={deviceLabel}
                onInput={(e) =>
                  setDeviceLabel((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>

            <button
              type="submit"
              class="btn btn-light auth-submit"
              disabled={busy}
            >
              {busy ? "验证配对中…" : "配对并进入工作台"}
            </button>
          </form>
        )}

        <p class="auth-foot">
          请在桌面端 Kiln 的「设置 → 远程访问」或终端运行{" "}
          <span class="mono">kiln remote pair</span>{" "}
          获取配对二维码或 6 位配对码。会话以 30 天 HttpOnly Cookie 持久保存，可随时在桌面端一键吊销。
        </p>
      </div>
    </main>
  );
}
