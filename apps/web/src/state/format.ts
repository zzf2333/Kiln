import type { Priority, StageId, TaskStatus, Track, WorkspaceMode } from "@kiln/protocol/web";

export interface StageMeta {
  label: string;
  colorVar: string;
}

export const STAGE_META: Record<StageId, StageMeta> = {
  intake: { label: "立项", colorVar: "--s-intake" },
  implement: { label: "实施", colorVar: "--s-impl" },
  research: { label: "调研", colorVar: "--s-research" },
  verify: { label: "验真", colorVar: "--s-verify" },
  review: { label: "审查", colorVar: "--s-review" },
  accept: { label: "验收", colorVar: "--s-accept" },
  triage: { label: "异常研判", colorVar: "--s-advise" },
  advise: { label: "顾问裁决", colorVar: "--s-advise" },
  deliver: { label: "交付", colorVar: "--s-deliver" },
};

export function stageMeta(stage: StageId | string | null | undefined): StageMeta {
  if (stage && stage in STAGE_META) {
    return STAGE_META[stage as StageId];
  }
  return { label: stage ?? "未知", colorVar: "--s-deliver" };
}

export const TRACK_LABEL: Record<Track, string> = {
  L1: "快车道",
  L2: "标准交付",
  L3: "调研",
};

export const WORKSPACE_LABEL: Record<WorkspaceMode, string> = {
  git_worktree: "代码工作树",
  host_scoped: "本机白名单",
  scratch_dir: "临时沙盒",
  external_only: "仅外部",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: "P0 紧急",
  P1: "P1 重要",
  P2: "P2 普通",
  P3: "P3 有空再做",
};

export const STATUS_CHIP: Record<TaskStatus, [string, string]> = {
  running: ["进行中", "chip-live"],
  paused: ["已暂停", "chip-paused"],
  queued: ["排队", ""],
  waiting: ["等你决定", "chip-ask"],
  external: ["外部等待", ""],
  done: ["已完成", "chip-ok"],
  cancelled: ["已取消", "chip-bad"],
};

export function getPipelineStages(track: Track, humanAccept = false): StageId[] {
  if (track === "L1") {
    return humanAccept
      ? ["intake", "implement", "verify", "accept", "deliver"]
      : ["intake", "implement", "verify", "deliver"];
  }
  return humanAccept
    ? ["intake", "implement", "verify", "review", "accept", "deliver"]
    : ["intake", "implement", "verify", "review", "deliver"];
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "$0.00";
  return `$${n.toFixed(2)}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${mo}-${da}`;
}

export function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec} 秒`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min} 分钟`;
  const hrs = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${hrs} 小时 ${rem} 分` : `${hrs} 小时`;
}

export function fmtRelativeSince(iso: string | null | undefined): string {
  if (!iso) return "刚刚";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "刚刚";
  return fmtDurationMs(ms);
}

export function heatOf(rate: number | undefined): number {
  return Number(Math.max(0.35, Math.min(1.3, (rate || 100) / 160)).toFixed(2));
}

export interface ParsedMarkdownBlock {
  kind: "heading" | "code" | "list" | "text";
  title?: string;
  body?: string;
  items?: string[];
}

export function splitFrontmatter(raw: string): {
  metaLines: Array<[string, string]>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    return { metaLines: [], body: raw };
  }
  const yamlText = match[1] ?? "";
  const body = match[2] ?? "";
  const metaLines: Array<[string, string]> = [];
  for (const line of yamlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx > 0) {
      metaLines.push([trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim()]);
    }
  }
  return { metaLines, body };
}

export function parseMarkdownBlocks(raw: string): ParsedMarkdownBlock[] {
  const lines = raw.split(/\r?\n/);
  const blocks: ParsedMarkdownBlock[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let textBuf: string[] = [];
  let listBuf: string[] = [];

  const flushText = (): void => {
    const joined = textBuf.join("\n").trim();
    if (joined) {
      blocks.push({ kind: "text", body: joined });
    }
    textBuf = [];
  };

  const flushList = (): void => {
    if (listBuf.length > 0) {
      blocks.push({ kind: "list", items: listBuf });
      listBuf = [];
    }
  };

  for (const line of lines) {
    if (inCode) {
      if (line.trimStart().startsWith("```")) {
        blocks.push({
          kind: "code",
          ...(codeLang ? { title: codeLang } : {}),
          body: codeBuf.join("\n"),
        });
        codeBuf = [];
        codeLang = "";
        inCode = false;
      } else {
        codeBuf.push(line);
      }
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      flushText();
      flushList();
      inCode = true;
      codeLang = line.trimStart().slice(3).trim();
      continue;
    }

    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      flushText();
      flushList();
      blocks.push({ kind: "heading", title: headingMatch[1]!.trim() });
      continue;
    }

    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (listMatch) {
      flushText();
      listBuf.push(listMatch[1]!);
      continue;
    }

    if (line.trim() === "") {
      flushText();
      flushList();
      continue;
    }

    flushList();
    textBuf.push(line);
  }

  if (inCode && codeBuf.length > 0) {
    blocks.push({ kind: "code", body: codeBuf.join("\n") });
  }
  flushText();
  flushList();
  return blocks;
}

export function isSafeHttpOrPaseoUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "paseo:"
    );
  } catch {
    return false;
  }
}
