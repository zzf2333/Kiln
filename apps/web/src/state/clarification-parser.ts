import type { ChatOptionQuestion } from "../api/types";

export interface ParsedOption {
  key: string;
  label: string;
  detail: string;
  recommended: boolean;
  needsInput: boolean;
  raw: string;
}

export interface ParsedQuestion {
  number: string;
  title: string;
  multiSelect?: boolean;
  options: ParsedOption[];
}

const FENCE_RE = /^\s*```/;
const QUESTION_HEADER_RE =
  /^\s*(?:#{1,4}\s*)?(?:\*\*)?(?:(?:Q|问题)\s*)?(\d+)\s*[.、)）:：]\s*(.+?)\s*$/;
const OPTION_LINE_RE =
  /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:(?:方案|选项|Option)\s*)?([A-F])(?:\*\*)?(?:\s*[（(]([^）)]+)[）)])?(?:\*\*)?\s*[:：)）.]\s*(.+)$/;
const HEADING_OPTION_LINE_RE =
  /^\s*#{1,6}\s+(?:\*\*)?(?:方案|选项|Option)\s*([A-F])(?:\*\*)?(?:\s*[（(]([^）)]+)[）)])?(?:\*\*)?\s*[:：)）.]\s*(.+)$/i;
const TABLE_ROW_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_OPTION_CELL_RE =
  /^\s*(?:(?:方案|选项|Option)\s*)?([A-F])(?:\s*[（(]([^）)]+)[）)])?\s*(?:[:：.、)）]\s*|\s+)(.+)$/i;
const RECOMMENDED_RE = /推荐|建议|recommended/i;
const TRAILING_REC_TAG_RE = /\s*[（(]\s*(?:推荐|建议|recommended)\s*[）)]\s*/gi;
const NEEDS_INPUT_RE = /指定|列出|补充|其他|自定义|名称|填入|请写|说明/;

function stripMarkdownWrappers(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "；")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStructuredQuestions(
  questions?: readonly ChatOptionQuestion[],
): ParsedQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) return [];
  const normalized: ParsedQuestion[] = [];
  for (const q of questions) {
    if (!q || typeof q.title !== "string" || !Array.isArray(q.options)) continue;
    const options: ParsedOption[] = [];
    const seenKeys = new Set<string>();
    for (const opt of q.options) {
      const key = opt.key.trim().toUpperCase();
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const label = opt.label.trim();
      if (!label) continue;
      const detail = (opt.detail ?? "").trim();
      const raw = detail ? `${label} ${detail}` : label;
      options.push({
        key,
        label,
        detail,
        recommended: Boolean(opt.recommended),
        needsInput: Boolean(opt.needs_input) || NEEDS_INPUT_RE.test(raw),
        raw,
      });
    }
    if (options.length < 2) continue;
    normalized.push({
      number: q.number,
      title: q.title,
      ...(q.multi_select ? { multiSelect: true } : {}),
      options,
    });
  }
  return normalized;
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => stripMarkdownWrappers(cell));
}

function inferTableQuestionTitle(lines: readonly string[], tableStartIdx: number): string {
  for (let idx = tableStartIdx - 1; idx >= Math.max(0, tableStartIdx - 4); idx -= 1) {
    const raw = (lines[idx] ?? "").trim();
    if (!raw || raw === "---" || FENCE_RE.test(raw)) continue;
    const headingMatch = raw.match(
      /^#{1,6}\s+(?:\*\*)?(?:(?:Q|问题)?\s*\d+\s*[.、)）:：]\s*)?(.+?)\s*$/,
    );
    const cleaned = stripMarkdownWrappers(headingMatch ? headingMatch[1]! : raw)
      .replace(/\s*[（(][^）)]*推荐[^）)]*[）)]\s*$/i, "")
      .replace(/[：:]\s*$/, "")
      .trim();
    if (cleaned.length > 0 && cleaned.length <= 64) {
      return cleaned;
    }
    break;
  }
  return "请选择方案";
}

function tryParseMarkdownTableQuestion(
  lines: readonly string[],
  startIdx: number,
  pendingQuestion: ParsedQuestion | null,
  fallbackNumber: string,
): { question: ParsedQuestion; endIdx: number } | null {
  const headerLine = lines[startIdx];
  const sepLine = lines[startIdx + 1];
  if (!headerLine || !sepLine) return null;
  if (!TABLE_ROW_RE.test(headerLine) || !TABLE_SEPARATOR_RE.test(sepLine)) return null;

  let endIdx = startIdx + 1;
  const parsedOptions: ParsedOption[] = [];
  const seenKeys = new Set<string>();

  for (let r = startIdx + 2; r < lines.length; r += 1) {
    const rowLine = lines[r]!;
    if (!TABLE_ROW_RE.test(rowLine)) break;
    endIdx = r;

    const cells = splitTableCells(rowLine);
    const firstCell = cells[0] ?? "";
    const cellMatch = firstCell.match(TABLE_OPTION_CELL_RE);
    if (!cellMatch) continue;

    const key = cellMatch[1]!.toUpperCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const tag = cellMatch[2] ?? "";
    const rawBody = cellMatch[3]!.trim();
    const hasTrailingRec = RECOMMENDED_RE.test(tag) || TRAILING_REC_TAG_RE.test(rawBody);
    TRAILING_REC_TAG_RE.lastIndex = 0;
    const cleanFirst = rawBody.replace(TRAILING_REC_TAG_RE, " ").replace(/\s+/g, " ").trim();
    const extraCols = cells.slice(1).filter((c) => c.length > 0);
    const { label, detail } = splitOptionLabelAndDetail(cleanFirst || rawBody, extraCols);
    const fullClean = [cleanFirst || rawBody, ...extraCols].join(" ").trim();

    parsedOptions.push({
      key,
      label: label || cleanFirst || rawBody,
      detail,
      recommended: hasTrailingRec,
      needsInput: NEEDS_INPUT_RE.test(fullClean),
      raw: fullClean,
    });
  }

  if (parsedOptions.length < 2) {
    return null;
  }

  return {
    question: {
      number: pendingQuestion ? pendingQuestion.number : fallbackNumber,
      title: pendingQuestion ? pendingQuestion.title : inferTableQuestionTitle(lines, startIdx),
      options: parsedOptions,
    },
    endIdx,
  };
}

function splitOptionLabelAndDetail(
  rawBody: string,
  extraLines: string[],
): {
  label: string;
  detail: string;
} {
  const cleanBody = stripMarkdownWrappers(rawBody);
  const cleanExtra = extraLines.map(stripMarkdownWrappers).filter(Boolean);

  // Separate concise first clause/sentence from trade-off or explanatory sentences.
  const firstPeriodIdx = cleanBody.search(/[。；]/);
  let label = cleanBody;
  const tailParts: string[] = [];

  if (firstPeriodIdx > 0 && firstPeriodIdx < cleanBody.length - 1) {
    label = cleanBody.slice(0, firstPeriodIdx).trim();
    const rest = cleanBody.slice(firstPeriodIdx + 1).trim();
    if (rest) tailParts.push(rest);
  } else if (cleanBody.length > 56) {
    const parenIdx = cleanBody.indexOf("（");
    if (parenIdx > 6 && parenIdx < 48) {
      label = cleanBody.slice(0, parenIdx).trim();
      tailParts.push(cleanBody.slice(parenIdx).trim());
    }
  }

  for (const line of cleanExtra) {
    tailParts.push(line);
  }

  return {
    label,
    detail: tailParts.join(" · "),
  };
}

export function parseClarificationQuestions(markdown: string): ParsedQuestion[] {
  if (
    !markdown ||
    (markdown.indexOf(":") === -1 &&
      markdown.indexOf("：") === -1 &&
      markdown.indexOf("|") === -1 &&
      !/[A-F][)）.]/.test(markdown))
  ) {
    return [];
  }

  const lines = markdown.split(/\r?\n/);
  const questions: ParsedQuestion[] = [];
  let inFence = false;
  let currentQuestion: ParsedQuestion | null = null;
  let currentOption: {
    key: string;
    recommended: boolean;
    rawLines: string[];
  } | null = null;

  const flushOption = (): void => {
    if (!currentOption) return;
    if (!currentQuestion) {
      currentQuestion = {
        number: String(questions.length + 1),
        title: "请选择方案",
        options: [],
      };
    }
    const [firstLine = "", ...restLines] = currentOption.rawLines;
    const { label, detail } = splitOptionLabelAndDetail(firstLine, restLines);
    const fullClean = stripMarkdownWrappers(currentOption.rawLines.join(" "));
    if (!currentQuestion.options.some((o) => o.key === currentOption!.key)) {
      currentQuestion.options.push({
        key: currentOption.key,
        label: label || fullClean,
        detail,
        recommended: currentOption.recommended || RECOMMENDED_RE.test(firstLine),
        needsInput: NEEDS_INPUT_RE.test(fullClean),
        raw: fullClean,
      });
    }
    currentOption = null;
  };

  const flushQuestion = (): void => {
    flushOption();
    if (currentQuestion && currentQuestion.options.length >= 2) {
      questions.push(currentQuestion);
    }
    currentQuestion = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      // Blank line ends option continuation only if the next non-empty line is not an option/sub-line of the same question.
      continue;
    }

    if (TABLE_ROW_RE.test(line) && lines[i + 1] && TABLE_SEPARATOR_RE.test(lines[i + 1]!)) {
      flushOption();
      const pendingQ =
        currentQuestion && currentQuestion.options.length === 0 ? currentQuestion : null;
      if (!pendingQ) {
        flushQuestion();
      }
      const tableRes = tryParseMarkdownTableQuestion(
        lines,
        i,
        pendingQ,
        String(questions.length + 1),
      );
      if (tableRes) {
        questions.push(tableRes.question);
        currentQuestion = null;
        i = tableRes.endIdx;
        continue;
      }
    }

    const optMatch = line.match(OPTION_LINE_RE) ?? line.match(HEADING_OPTION_LINE_RE);
    if (optMatch) {
      flushOption();
      const key = optMatch[1]!.toUpperCase();
      const tag = optMatch[2] ?? "";
      const body = optMatch[3]!.trim();
      currentOption = {
        key,
        recommended: RECOMMENDED_RE.test(tag),
        rawLines: [body],
      };
      continue;
    }

    const qMatch = line.match(QUESTION_HEADER_RE);
    if (qMatch) {
      const qNum = qMatch[1]!;
      const qTitle = stripMarkdownWrappers(qMatch[2]!);
      flushQuestion();
      currentQuestion = {
        number: qNum,
        title: qTitle,
        options: [],
      };
      continue;
    }

    if (currentOption) {
      // Continuation line (e.g. "收益：...", "代价：...", or wrapped description under an option)
      if (
        /^(?:收益|代价|说明|适用|注意|备注|优点|缺点|Pros|Cons)\s*[:：]/i.test(trimmed) ||
        /^\s{2,}/.test(line)
      ) {
        currentOption.rawLines.push(trimmed);
      } else {
        // Non-indented plain paragraph after options terminates the current question block cleanly.
        flushQuestion();
      }
    }
  }

  flushQuestion();
  return questions;
}

export function formatSelectedOptionsReply(
  questions: readonly ParsedQuestion[],
  selections: Readonly<Record<string, string | readonly string[]>>,
  notes: Readonly<Record<string, string>>,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const rawPicked = selections[q.number];
    const pickedKeys = Array.isArray(rawPicked)
      ? rawPicked.filter((k) => k.length > 0)
      : typeof rawPicked === "string" && rawPicked.length > 0
        ? [rawPicked]
        : [];
    if (pickedKeys.length === 0) continue;

    const note = (notes[q.number] ?? "").trim();
    const notePart = note ? `，补充：${note}` : "";

    const shortLabels = pickedKeys
      .map((key) => {
        const opt = q.options.find((o) => o.key === key);
        if (!opt) return "";
        return opt.label.length > 36 ? `${opt.label.slice(0, 35)}…` : opt.label;
      })
      .filter((s) => s.length > 0);
    const summary = shortLabels.length > 0 ? `（${shortLabels.join("；")}）` : "";
    lines.push(`${q.number}. ${q.title}：选 ${pickedKeys.join("、")}${summary}${notePart}`);
  }
  return lines.join("\n");
}
