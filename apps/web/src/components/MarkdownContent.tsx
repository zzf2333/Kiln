import { Fragment, type ComponentChildren } from "preact";
import { useContext, useState } from "preact/hooks";
import { StoreContext } from "../state/store";

interface CodeBlockProps {
  lang: string;
  code: string;
}

const LONG_CODE_LINE_LIMIT = 28;

const CODE_TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|(?:^|\s)(--?[A-Za-z0-9][A-Za-z0-9_-]*)|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|async|await|import|from|export|type|interface|class|extends|implements|new|try|catch|throw|finally|def|elif|with|as|pass|yield|lambda|pub|fn|struct|enum|impl|match|use|mod|crate|true|false|null|undefined|None|True|False)\b|\b\d+(?:\.\d+)?(?:[KMGTP]i?B?)?\b)/gm;

function highlightCodeLineDiff(lines: string[]): ComponentChildren {
  return lines.map((line, idx) => {
    const cls =
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("+++") ||
      line.startsWith("---")
        ? "tok-meta"
        : line.startsWith("@@")
          ? "tok-hunk"
          : line.startsWith("+")
            ? "tok-add"
            : line.startsWith("-")
              ? "tok-del"
              : null;
    const content = idx < lines.length - 1 ? `${line}\n` : line;
    return cls ? (
      <span key={idx} class={cls}>
        {content}
      </span>
    ) : (
      <Fragment key={idx}>{content}</Fragment>
    );
  });
}

function highlightCode(code: string, lang: string): ComponentChildren {
  const norm = lang.trim().toLowerCase();
  if (norm === "diff" || norm === "patch") {
    return highlightCodeLineDiff(code.split("\n"));
  }
  if (!code) return "";

  const out: ComponentChildren[] = [];
  let cursor = 0;
  CODE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let count = 0;

  while ((match = CODE_TOKEN_RE.exec(code)) !== null) {
    if (count > 2500) {
      out.push(code.slice(cursor));
      cursor = code.length;
      break;
    }
    const full = match[0];
    let start = match.index;
    let tok = full;

    // Preserve leading whitespace captured before CLI flags
    if (match[2] !== undefined) {
      const leadLen = full.length - match[2].length;
      if (leadLen > 0) {
        start += leadLen;
        tok = match[2];
      }
    }

    if (start > cursor) {
      out.push(code.slice(cursor, start));
    }

    let cls: string;
    if (tok.startsWith("//") || tok.startsWith("/*") || tok.startsWith("#")) {
      cls = "tok-cmt";
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) {
      cls = "tok-str";
    } else if (tok.startsWith("-")) {
      cls = "tok-key";
    } else if (/^\d/.test(tok)) {
      cls = "tok-num";
    } else {
      cls = "tok-kw";
    }

    out.push(
      <span key={out.length} class={cls}>
        {tok}
      </span>,
    );
    cursor = start + tok.length;
    count += 1;
    if (CODE_TOKEN_RE.lastIndex === match.index) {
      CODE_TOKEN_RE.lastIndex += 1;
    }
  }

  if (cursor < code.length) {
    out.push(code.slice(cursor));
  }
  return out.length === 0 ? code : out;
}

function CodeBlock({ lang, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const lineCount = code.split("\n").length;
  const isLong = lineCount > LONG_CODE_LINE_LIMIT;
  const [expanded, setExpanded] = useState(!isLong);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable in restricted contexts
    }
  };

  return (
    <div class="md-code">
      <div class="md-code-head">
        <span class="mono">
          {lang || "text"}
          {isLong ? ` · ${lineCount} 行` : ""}
        </span>
        <div class="md-code-actions">
          {isLong ? (
            <button
              type="button"
              class="btn btn-ghost btn-sm md-copy-btn"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起代码" : `展开全部 ${lineCount} 行`}
            </button>
          ) : null}
          <button
            type="button"
            class="btn btn-ghost btn-sm md-copy-btn"
            onClick={() => void handleCopy()}
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <div class={`md-code-body ${!expanded ? "is-collapsed" : ""}`}>
        <pre class="mono code">
          <code>{highlightCode(code, lang)}</code>
        </pre>
      </div>
    </div>
  );
}

interface FilePathPillProps {
  label: string;
  fullPath: string;
  allowReveal: boolean;
  onReveal: ((targetPath: string) => void) | null;
  onCopied: ((targetPath: string) => void) | null;
}

function FilePathPill({
  label,
  fullPath,
  allowReveal,
  onReveal,
  onCopied,
}: FilePathPillProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(fullPath);
      setCopied(true);
      onCopied?.(fullPath);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      onCopied?.(fullPath);
    }
  };

  return (
    <span class="md-file-pill">
      <button
        type="button"
        class="md-file-copy"
        title={`点击复制路径：${fullPath}`}
        onClick={() => void handleCopy()}
      >
        <svg
          class="md-file-ico"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l1.6 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
        </svg>
        <span class="mono md-file-name">{label}</span>
        {copied ? <span class="md-file-ok">✓</span> : null}
      </button>
      {allowReveal ? (
        <button
          type="button"
          class="md-file-reveal"
          aria-label={`在文件管理器中定位 ${label}`}
          title={`在文件管理器中定位：${fullPath}`}
          onClick={() => onReveal?.(fullPath)}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M14 5h5v5" />
            <path d="M10 14L19 5" />
            <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}

type TableAlign = "left" | "center" | "right" | null;
type TableColSize = "compact" | "medium" | "wide";

interface MdListItem {
  text: string;
  checked?: boolean;
  children?: MdBlock[];
}

type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "hr" }
  | { kind: "quote"; blocks: MdBlock[] }
  | {
      kind: "list";
      ordered: boolean;
      items: MdListItem[];
    }
  | {
      kind: "table";
      headers: string[];
      aligns: TableAlign[];
      rows: string[][];
    }
  | { kind: "paragraph"; lines: string[] };

interface InlineRenderContext {
  allowReveal: boolean;
  onReveal: ((targetPath: string) => void) | null;
  onCopied: ((targetPath: string) => void) | null;
}

function isSafeHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseSafeFileUrl(
  raw: string,
): { path: string; lineSuffix?: string } | null {
  const trimmed = raw.trim();
  if (!/^file:\/\//i.test(trimmed)) return null;

  let base = trimmed;
  let lineSuffix: string | undefined;
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx >= 0) {
    base = trimmed.slice(0, hashIdx);
    const frag = trimmed.slice(hashIdx + 1);
    const lineMatch = /^L(\d+)(?:-L?(\d+))?$/i.exec(frag);
    if (lineMatch) {
      lineSuffix = lineMatch[2]
        ? `:${lineMatch[1]}-${lineMatch[2]}`
        : `:${lineMatch[1]}`;
    }
  }

  let rawPathPart: string;
  if (/^file:\/\/localhost\//i.test(base)) {
    rawPathPart = base.slice("file://localhost".length);
  } else if (/^file:\/\/\//i.test(base)) {
    rawPathPart = base.slice("file://".length);
  } else {
    return null;
  }

  if (!rawPathPart.startsWith("/")) return null;
  let decoded = rawPathPart;
  try {
    decoded = decodeURIComponent(rawPathPart);
  } catch {
    // Keep rawPathPart if malformed percent escapes
  }
  if (!decoded || decoded.includes("\0")) return null;
  return {
    path: decoded,
    ...(lineSuffix ? { lineSuffix } : {}),
  };
}

function cleanFileLabel(rawLabel: string, lineSuffix?: string): string {
  let cleaned = rawLabel.trim();
  if (
    cleaned.length >= 2 &&
    cleaned.startsWith("`") &&
    cleaned.endsWith("`") &&
    !cleaned.slice(1, -1).includes("`")
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (lineSuffix && !cleaned.endsWith(lineSuffix)) {
    return `${cleaned}${lineSuffix}`;
  }
  return cleaned;
}

function isWordBoundaryChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function renderInline(
  text: string,
  ctx: InlineRenderContext,
  depth = 0,
): ComponentChildren {
  if (depth > 8 || text.length === 0) return text;
  const out: ComponentChildren[] = [];
  let buf = "";
  let i = 0;

  const flush = (): void => {
    if (buf.length > 0) {
      out.push(buf);
      buf = "";
    }
  };

  while (i < text.length) {
    const ch = text[i]!;

    // Inline code: `...` or ``...``
    if (ch === "`") {
      let ticks = 1;
      while (i + ticks < text.length && text[i + ticks] === "`") {
        ticks += 1;
      }
      const marker = "`".repeat(ticks);
      const closeIdx = text.indexOf(marker, i + ticks);
      if (closeIdx !== -1) {
        flush();
        let inner = text.slice(i + ticks, closeIdx);
        if (ticks >= 2 && inner.startsWith(" ") && inner.endsWith(" ")) {
          inner = inner.slice(1, -1);
        }
        out.push(
          <code key={out.length} class="md-inline-code">
            {inner}
          </code>,
        );
        i = closeIdx + ticks;
        continue;
      }
    }

    // Link: [label](url) — http/https links or safe local file:// pills
    if (ch === "[") {
      const labelEnd = text.indexOf("]", i + 1);
      if (labelEnd > i + 1 && text[labelEnd + 1] === "(") {
        let pDepth = 1;
        let p = labelEnd + 2;
        while (p < text.length && pDepth > 0) {
          if (text[p] === "(") pDepth += 1;
          else if (text[p] === ")") pDepth -= 1;
          p += 1;
        }
        if (pDepth === 0) {
          const label = text.slice(i + 1, labelEnd);
          const rawUrl = text.slice(labelEnd + 2, p - 1);
          const safeFile = parseSafeFileUrl(rawUrl);
          if (safeFile) {
            flush();
            out.push(
              <FilePathPill
                key={out.length}
                label={cleanFileLabel(label, safeFile.lineSuffix)}
                fullPath={safeFile.path}
                allowReveal={ctx.allowReveal}
                onReveal={ctx.onReveal}
                onCopied={ctx.onCopied}
              />,
            );
            i = p;
            continue;
          }
          const safeUrl = isSafeHttpUrl(rawUrl);
          if (safeUrl) {
            flush();
            out.push(
              <a
                key={out.length}
                class="md-link"
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {renderInline(label, ctx, depth + 1)}
              </a>,
            );
            i = p;
            continue;
          }
        }
      }
    }

    // Bold: **...** or __...__
    if (
      (ch === "*" && text[i + 1] === "*") ||
      (ch === "_" && text[i + 1] === "_" && !isWordBoundaryChar(text[i - 1]))
    ) {
      const marker = text.slice(i, i + 2);
      const closeIdx = text.indexOf(marker, i + 2);
      if (
        closeIdx > i + 2 &&
        (ch !== "_" || !isWordBoundaryChar(text[closeIdx + 2]))
      ) {
        flush();
        out.push(
          <strong key={out.length}>
            {renderInline(text.slice(i + 2, closeIdx), ctx, depth + 1)}
          </strong>,
        );
        i = closeIdx + 2;
        continue;
      }
    }

    // Strikethrough: ~~...~~
    if (ch === "~" && text[i + 1] === "~") {
      const closeIdx = text.indexOf("~~", i + 2);
      if (closeIdx > i + 2) {
        flush();
        out.push(
          <del key={out.length}>
            {renderInline(text.slice(i + 2, closeIdx), ctx, depth + 1)}
          </del>,
        );
        i = closeIdx + 2;
        continue;
      }
    }

    // Italic: *...* or word-bounded _..._
    if (
      (ch === "*" && text[i + 1] !== " ") ||
      (ch === "_" && !isWordBoundaryChar(text[i - 1]) && text[i + 1] !== " ")
    ) {
      let closeIdx = i + 1;
      let found = -1;
      while (closeIdx < text.length) {
        const cur = text[closeIdx]!;
        if (cur === "`") {
          const nextTick = text.indexOf("`", closeIdx + 1);
          closeIdx = nextTick === -1 ? closeIdx + 1 : nextTick + 1;
          continue;
        }
        if (
          cur === ch &&
          text[closeIdx - 1] !== " " &&
          (ch !== "_" || !isWordBoundaryChar(text[closeIdx + 1]))
        ) {
          found = closeIdx;
          break;
        }
        closeIdx += 1;
      }
      if (found > i + 1) {
        flush();
        out.push(
          <em key={out.length}>
            {renderInline(text.slice(i + 1, found), ctx, depth + 1)}
          </em>,
        );
        i = found + 1;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out.length === 1 ? out[0] : out;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1);
  }

  const cells: string[] = [];
  let cur = "";
  let inBackticks = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") {
      cur += "|";
      i += 1;
      continue;
    }
    if (ch === "`") {
      inBackticks = !inBackticks;
      cur += ch;
      continue;
    }
    if (ch === "|" && !inBackticks) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableSeparator(line: string, expectedCols: number): TableAlign[] | null {
  if (!line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (cells.length !== expectedCols || cells.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(":") && cell.endsWith(":")) aligns.push("center");
    else if (cell.endsWith(":")) aligns.push("right");
    else if (cell.startsWith(":")) aligns.push("left");
    else aligns.push(null);
  }
  return aligns;
}

function measureVisibleTextWidth(raw: string): number {
  const visible = raw
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
  let width = 0;
  for (const ch of visible) {
    width += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return width;
}

function classifyTableColumns(headers: string[], rows: string[][]): TableColSize[] {
  return headers.map((h, ci) => {
    let maxW = measureVisibleTextWidth(h);
    for (const row of rows) {
      const w = measureVisibleTextWidth(row[ci] ?? "");
      if (w > maxW) maxW = w;
    }
    if (maxW <= 18) return "compact";
    if (maxW <= 42) return "medium";
    return "wide";
  });
}

function lineIndent(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

const LIST_ITEM_RE = /^([ \t]*)(?:([-*+])|(\d+)\.)\s+(.*)$/;

function parseListBlock(
  lines: string[],
  startIdx: number,
): { block: MdBlock; nextIdx: number } | null {
  const firstLine = lines[startIdx];
  if (!firstLine) return null;
  const firstMatch = LIST_ITEM_RE.exec(firstLine);
  if (!firstMatch) return null;

  const baseIndent = lineIndent(firstMatch[1]!);
  const ordered = Boolean(firstMatch[3]);
  const items: MdListItem[] = [];
  let i = startIdx;

  while (i < lines.length) {
    const cur = lines[i]!;
    if (cur.trim() === "") {
      // Allow single blank line between list items at >= baseIndent
      let peek = i + 1;
      while (peek < lines.length && lines[peek]!.trim() === "") {
        peek += 1;
      }
      const nextLine = lines[peek];
      if (!nextLine) {
        i = peek;
        break;
      }
      const nextMatch = LIST_ITEM_RE.exec(nextLine);
      if (nextMatch) {
        const nextIndent = lineIndent(nextMatch[1]!);
        const nextOrdered = Boolean(nextMatch[3]);
        if (nextIndent > baseIndent || (nextIndent === baseIndent && nextOrdered === ordered)) {
          i = peek;
          continue;
        }
      }
      break;
    }

    const m = LIST_ITEM_RE.exec(cur);
    if (m) {
      const indent = lineIndent(m[1]!);
      const isOrd = Boolean(m[3]);
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        if (items.length === 0) break;
        const nested = parseListBlock(lines, i);
        if (!nested) break;
        const prev = items[items.length - 1]!;
        prev.children = [...(prev.children ?? []), nested.block];
        i = nested.nextIdx;
        continue;
      }
      if (isOrd !== ordered) break;

      const body = m[4]!;
      const taskMatch = !ordered ? /^\[( |x|X)\]\s+(.*)$/.exec(body) : null;
      if (taskMatch) {
        items.push({
          text: taskMatch[2]!,
          checked: taskMatch[1]!.toLowerCase() === "x",
        });
      } else {
        items.push({ text: body });
      }
      i += 1;
      continue;
    }

    // Continuation line indented further than bullet start belongs to previous item
    if (
      items.length > 0 &&
      lineIndent(cur) > baseIndent &&
      !/^\s*(```|~~~|#{1,6}\s|>\s?|(?:[-*_]\s*){3,}$)/.test(cur)
    ) {
      const prev = items[items.length - 1]!;
      prev.text = `${prev.text}\n${cur.trim()}`;
      i += 1;
      continue;
    }

    break;
  }

  return {
    block: { kind: "list", ordered, items },
    nextIdx: i,
  };
}

function parseMarkdown(raw: string): MdBlock[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "") {
      i += 1;
      continue;
    }

    // Fenced code block: ``` or ~~~
    const fenceMatch = /^\s*(```|~~~)\s*(.*)$/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const lang = fenceMatch[2]!.trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // Heading: # .. ######
    const headingMatch = /^\s*(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: headingMatch[1]!.length,
        text: headingMatch[2]!,
      });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", blocks: parseMarkdown(quoteLines.join("\n")) });
      continue;
    }

    // Pipe table
    if (line.includes("|") && i + 1 < lines.length) {
      const headers = splitTableRow(line);
      const aligns = parseTableSeparator(lines[i + 1]!, headers.length);
      if (aligns) {
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
          const rowCells = splitTableRow(lines[i]!);
          while (rowCells.length < headers.length) rowCells.push("");
          rows.push(rowCells.slice(0, headers.length));
          i += 1;
        }
        blocks.push({ kind: "table", headers, aligns, rows });
        continue;
      }
    }

    // Nested indentation-aware list
    if (LIST_ITEM_RE.test(line)) {
      const parsedList = parseListBlock(lines, i);
      if (parsedList) {
        blocks.push(parsedList.block);
        i = parsedList.nextIdx;
        continue;
      }
    }

    // Paragraph: collect contiguous normal lines
    const pLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      if (
        cur.trim() === "" ||
        /^\s*(```|~~~)/.test(cur) ||
        /^\s*#{1,6}\s+/.test(cur) ||
        /^\s*>\s?/.test(cur) ||
        LIST_ITEM_RE.test(cur) ||
        /^\s*(?:[-*_]\s*){3,}$/.test(cur)
      ) {
        break;
      }
      if (
        cur.includes("|") &&
        i + 1 < lines.length &&
        parseTableSeparator(lines[i + 1]!, splitTableRow(cur).length) !== null
      ) {
        break;
      }
      pLines.push(cur);
      i += 1;
    }
    if (pLines.length > 0) {
      blocks.push({ kind: "paragraph", lines: pLines });
    } else {
      i += 1;
    }
  }

  return blocks;
}

function renderInlineMultiline(
  text: string,
  ctx: InlineRenderContext,
): ComponentChildren {
  if (!text.includes("\n")) {
    return renderInline(text, ctx);
  }
  const parts = text.split("\n");
  return parts.map((part, idx) => (
    <Fragment key={idx}>
      {idx > 0 ? <br /> : null}
      {renderInline(part, ctx)}
    </Fragment>
  ));
}

function renderBlocks(blocks: MdBlock[], ctx: InlineRenderContext): ComponentChildren {
  return blocks.map((b, idx) => {
    switch (b.kind) {
      case "heading": {
        const Tag =
          b.level === 1
            ? "h1"
            : b.level === 2
              ? "h2"
              : b.level === 3
                ? "h3"
                : "h4";
        return <Tag key={idx}>{renderInline(b.text, ctx)}</Tag>;
      }
      case "code":
        return <CodeBlock key={idx} lang={b.lang} code={b.code} />;
      case "hr":
        return <hr key={idx} />;
      case "quote":
        return <blockquote key={idx}>{renderBlocks(b.blocks, ctx)}</blockquote>;
      case "list": {
        const ListTag = b.ordered ? "ol" : "ul";
        return (
          <ListTag key={idx}>
            {b.items.map((item, j) => (
              <li
                key={j}
                class={item.checked !== undefined ? "md-task-item" : undefined}
              >
                {item.checked !== undefined ? (
                  <span
                    class={`md-task-box ${item.checked ? "is-checked" : ""}`}
                    aria-hidden="true"
                  >
                    {item.checked ? "✓" : ""}
                  </span>
                ) : null}
                <div class="md-li-body">
                  <span>{renderInlineMultiline(item.text, ctx)}</span>
                  {item.children && item.children.length > 0
                    ? renderBlocks(item.children, ctx)
                    : null}
                </div>
              </li>
            ))}
          </ListTag>
        );
      }
      case "table": {
        const colSizes = classifyTableColumns(b.headers, b.rows);
        return (
          <div key={idx} class="md-table-wrap">
            <table class="md-table">
              <thead>
                <tr>
                  {b.headers.map((h, ci) => (
                    <th
                      key={ci}
                      class={`col-${colSizes[ci] ?? "medium"}`}
                      style={
                        b.aligns[ci] ? { textAlign: b.aligns[ci]! } : undefined
                      }
                    >
                      {renderInline(h, ctx)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        class={`col-${colSizes[ci] ?? "medium"}`}
                        style={
                          b.aligns[ci] ? { textAlign: b.aligns[ci]! } : undefined
                        }
                      >
                        {renderInline(cell, ctx)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "paragraph":
        return (
          <p key={idx}>
            {b.lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {renderInline(line, ctx)}
              </Fragment>
            ))}
          </p>
        );
    }
  });
}

export interface MarkdownContentProps {
  text: string;
  className?: string;
  allowReveal?: boolean;
  onReveal?: (targetPath: string) => void;
}

export function MarkdownContent({
  text,
  className,
  allowReveal,
  onReveal,
}: MarkdownContentProps) {
  const kilnStore = useContext(StoreContext);
  const effectiveReveal =
    allowReveal ?? (kilnStore ? kilnStore.getState().authMode === "local" : false);
  const ctx: InlineRenderContext = {
    allowReveal: effectiveReveal,
    onReveal:
      onReveal ?? (kilnStore ? (p) => void kilnStore.revealLocalPath(p) : null),
    onCopied: kilnStore
      ? (p) => kilnStore.showToast(`已复制路径：${p}`)
      : null,
  };
  const blocks = parseMarkdown(text);
  return (
    <div class={className ? `md ${className}` : "md"}>
      {renderBlocks(blocks, ctx)}
    </div>
  );
}
