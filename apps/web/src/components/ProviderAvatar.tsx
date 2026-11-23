import type { ProviderAdapterKind } from "../api/types";

const AVATAR_META: Record<string, { label: string; cls: string }> = {
  codex: { label: "CX", cls: "av-codex" },
  claude: { label: "CL", cls: "av-claude" },
  pi: { label: "PI", cls: "av-pi" },
  agy: { label: "AG", cls: "av-agy" },
  antigravity: { label: "AG", cls: "av-agy" },
  gemini: { label: "GM", cls: "av-gemini" },
  opencode: { label: "OC", cls: "av-opencode" },
  paseo: { label: "PS", cls: "av-paseo" },
  kernel: { label: "KN", cls: "av-kernel" },
  pm: { label: "PM", cls: "av-pm" },
};

export function ProviderAvatar({
  providerId,
  large = false,
  size,
}: {
  providerId: string;
  large?: boolean;
  size?: "xs" | "sm" | "lg";
}) {
  const key = providerId.toLowerCase();
  const meta = AVATAR_META[key] ?? {
    label: providerId.slice(0, 2).toUpperCase() || "AG",
    cls: "",
  };
  const resolvedSize = size ?? (large ? "lg" : "sm");
  const sizeCls =
    resolvedSize === "lg" ? "av-lg" : resolvedSize === "xs" ? "av-xs" : "";
  return (
    <span
      className={`av ${meta.cls} ${sizeCls}`.trim()}
      aria-hidden="true"
    >
      {meta.label}
    </span>
  );
}

const ADAPTER_LABELS: Record<ProviderAdapterKind, string> = {
  acp: "标准 ACP",
  codex_app_server: "Codex App Server",
  pi_rpc: "Pi RPC",
  claude_direct: "Claude Stream-JSON",
  paseo: "Paseo Bridge",
};

export function formatAdapterLabel(adapter: ProviderAdapterKind | string): string {
  return ADAPTER_LABELS[adapter as ProviderAdapterKind] ?? adapter;
}
