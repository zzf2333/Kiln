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
  options: ParsedOption[];
}

const FENCE_RE = /^\s*```/;
const QUESTION_HEADER_RE =
  /^\s*(?:#{1,4}\s*)?(?:\*\*)?(?:(?:Q|问题)\s*)?(\d+)\s*[.、)）:：]\s*(.+?)\s*$/;
const OPTION_LINE_RE =
  /^\s*(?:[-*•]\s*)?(?:\*\*)?([A-F])(?:\*\*)?(?:\s*[（(]([^）)]+)[）)])?(?:\*\*)?\s*[:：)）.]\s*(.+)$/;
const RECOMMENDED_RE = /推荐|建议|recommended/i;
const NEEDS_INPUT_RE = /指定|列出|补充|其他|自定义|名称|填入|请写|说明/;

function stripMarkdownWrappers(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    (markdown.indexOf(":") === -1 && markdown.indexOf("：") === -1 && !/[A-F][)）.]/.test(markdown))
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

    const optMatch = line.match(OPTION_LINE_RE);
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
  selections: Readonly<Record<string, string>>,
  notes: Readonly<Record<string, string>>,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const pickedKey = selections[q.number];
    if (!pickedKey) continue;
    const pickedOpt = q.options.find((o) => o.key === pickedKey);
    const note = (notes[q.number] ?? "").trim();
    const shortLabel = pickedOpt
      ? pickedOpt.label.length > 36
        ? `${pickedOpt.label.slice(0, 35)}…`
        : pickedOpt.label
      : "";
    const summary = shortLabel ? `（${shortLabel}）` : "";
    const notePart = note ? `，补充：${note}` : "";
    lines.push(`${q.number}. ${q.title}：选 ${pickedKey}${summary}${notePart}`);
  }
  return lines.join("\n");
}
