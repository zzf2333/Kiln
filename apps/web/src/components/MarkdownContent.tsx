import { Fragment, type ComponentChildren } from "preact";
import { useState } from "preact/hooks";

interface CodeBlockProps {
  lang: string;
  code: string;
}

function CodeBlock({ lang, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

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
        <span class="mono">{lang || "text"}</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm md-copy-btn"
          onClick={() => void handleCopy()}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre class="mono">
        <code>{code}</code>
      </pre>
    </div>
  );
}

type TableAlign = "left" | "center" | "right" | null;

type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "hr" }
  | { kind: "quote"; blocks: MdBlock[] }
  | {
      kind: "list";
      ordered: boolean;
      items: Array<{ text: string; checked?: boolean }>;
    }
  | {
      kind: "table";
      headers: string[];
      aligns: TableAlign[];
      rows: string[][];
    }
  | { kind: "paragraph"; lines: string[] };

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

function isWordBoundaryChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function renderInline(text: string, depth = 0): ComponentChildren {
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

    // Link: [label](url)
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
                {renderInline(label, depth + 1)}
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
            {renderInline(text.slice(i + 2, closeIdx), depth + 1)}
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
            {renderInline(text.slice(i + 2, closeIdx), depth + 1)}
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
            {renderInline(text.slice(i + 1, found), depth + 1)}
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
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
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

    // Unordered or ordered list
    const ulMatch = /^\s*[-*+]\s+(.*)$/.exec(line);
    const olMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch);
      const items: Array<{ text: string; checked?: boolean }> = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = ordered
          ? /^\s*\d+\.\s+(.*)$/.exec(cur)
          : /^\s*[-*+]\s+(.*)$/.exec(cur);
        if (!m) break;
        const body = m[1]!;
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
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
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
        /^\s*[-*+]\s+/.test(cur) ||
        /^\s*\d+\.\s+/.test(cur) ||
        /^\s*(?:[-*_]\s*){3,}$/.test(cur)
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

function renderBlocks(blocks: MdBlock[]): ComponentChildren {
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
        return <Tag key={idx}>{renderInline(b.text)}</Tag>;
      }
      case "code":
        return <CodeBlock key={idx} lang={b.lang} code={b.code} />;
      case "hr":
        return <hr key={idx} />;
      case "quote":
        return <blockquote key={idx}>{renderBlocks(b.blocks)}</blockquote>;
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
                <span>{renderInline(item.text)}</span>
              </li>
            ))}
          </ListTag>
        );
      }
      case "table":
        return (
          <div key={idx} class="md-table-wrap">
            <table class="md-table">
              <thead>
                <tr>
                  {b.headers.map((h, ci) => (
                    <th
                      key={ci}
                      style={
                        b.aligns[ci] ? { textAlign: b.aligns[ci]! } : undefined
                      }
                    >
                      {renderInline(h)}
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
                        style={
                          b.aligns[ci] ? { textAlign: b.aligns[ci]! } : undefined
                        }
                      >
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "paragraph":
        return (
          <p key={idx}>
            {b.lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {renderInline(line)}
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
}

export function MarkdownContent({ text, className }: MarkdownContentProps) {
  const blocks = parseMarkdown(text);
  return (
    <div class={className ? `md ${className}` : "md"}>
      {renderBlocks(blocks)}
    </div>
  );
}
