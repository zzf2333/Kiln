import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { VERIFIER_ENTRY_MODES } from "./constants.js";

export const RECEIPT_KINDS = [
  "worker",
  "reviewer",
  "verifier",
  "triage",
  "advisor",
] as const;

export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const WorkerReceiptFrontmatterSchema = z.object({
  run_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  outcome: z.enum(["completed", "need_decision"]),
  input_ref: z.string().min(1),
  output_ref: z.string().min(1),
  changed_paths: z.array(z.string()),
  accept_result: z.enum(["pass", "fail", "skipped"]),
  is_bugfix: z.boolean().default(false),
  complexity_escalate: z.boolean().default(false),
});
export type WorkerReceiptFrontmatter = z.infer<typeof WorkerReceiptFrontmatterSchema>;

export const REVIEW_FINDING_SEVERITIES = ["P0", "P1", "P2"] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export const ReviewFindingItemSchema = z.object({
  id: z.string().trim().min(1).optional(),
  severity: z.enum(REVIEW_FINDING_SEVERITIES).default("P1"),
  title: z.string().trim().min(1),
  location: z.string().trim().min(1).optional(),
  detail: z.string().trim().min(1).optional(),
});
export type ReviewFindingItem = z.infer<typeof ReviewFindingItemSchema>;

export const ReviewerReceiptFrontmatterSchema = z.object({
  run_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  reviewed_ref: z.string().min(1),
  verdict: z.enum(["pass", "changes_requested"]),
  p0: z.number().int().nonnegative(),
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
  findings: z.array(ReviewFindingItemSchema).optional(),
});
export type ReviewerReceiptFrontmatter = z.infer<typeof ReviewerReceiptFrontmatterSchema>;

export const VerifierScenarioResultSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["pass", "fail", "skipped"]),
  note: z.string().optional(),
  evidence_files: z.array(z.string().min(1)).optional(),
});
export type VerifierScenarioResult = z.infer<typeof VerifierScenarioResultSchema>;

export const VerifierReceiptFrontmatterSchema = z
  .object({
    run_id: z.string().min(1),
    contract_version: z.number().int().positive(),
    verified_ref: z.string().min(1),
    verdict: z.enum(["pass", "fail"]),
    passed_scenarios: z.number().int().nonnegative(),
    failed_scenarios: z.number().int().nonnegative(),
    entry_mode: z.enum(VERIFIER_ENTRY_MODES).optional(),
    evidence_files: z.array(z.string().min(1)).optional(),
    scenarios: z.array(VerifierScenarioResultSchema).optional(),
    console_errors_count: z.number().int().nonnegative().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.verdict === "pass" && v.failed_scenarios > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verdict=pass is mutually exclusive with failed_scenarios > 0",
        path: ["failed_scenarios"],
      });
    }
    if (
      v.verdict === "pass" &&
      v.scenarios !== undefined &&
      v.scenarios.some((s) => s.status === "fail")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verdict=pass is mutually exclusive with failed scenario items",
        path: ["scenarios"],
      });
    }
  });
export type VerifierReceiptFrontmatter = z.infer<typeof VerifierReceiptFrontmatterSchema>;

export const TriageReceiptFrontmatterSchema = z.object({
  run_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  recommendation: z.enum(["retry", "escalate_advisor", "ask_human"]),
  summary: z.string().min(1),
});
export type TriageReceiptFrontmatter = z.infer<typeof TriageReceiptFrontmatterSchema>;

export const AdvisorReceiptFrontmatterSchema = z.object({
  run_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  outcome: z.enum(["resolved", "need_decision"]),
  chosen_approach: z.string().min(1),
  decision_kind: z
    .enum(["plan", "technical_ambiguity", "review_deadlock", "stuck_recovery"])
    .optional(),
  requires_contract_change: z.boolean().default(false),
  requires_scope_expansion: z.boolean().default(false),
  requires_human_approval: z.boolean().default(false),
  target_stage: z.enum(["implement", "review"]).optional(),
});
export type AdvisorReceiptFrontmatter = z.infer<typeof AdvisorReceiptFrontmatterSchema>;

export interface ParsedFrontmatterMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatterMarkdown(raw: string): ParsedFrontmatterMarkdown {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    throw new Error("Missing YAML frontmatter delimited by ---");
  }
  const yamlText = match[1] ?? "";
  const body = match[2] ?? "";
  const parsed: unknown = parseYaml(yamlText);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YAML frontmatter must be a mapping object");
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    body,
  };
}

export function serializeFrontmatterMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlBlock = stringifyYaml(frontmatter).trimEnd();
  const normalizedBody = body.startsWith("\n") ? body.slice(1) : body;
  return `---\n${yamlBlock}\n---\n${normalizedBody}`;
}

const REQUIRED_SECTIONS: Record<ReceiptKind, readonly string[]> = {
  worker: ["改动说明", "验证命令与真实输出", "未完成或待决问题"],
  reviewer: ["结论", "缺陷清单", "测试真实性与复现核查"],
  verifier: ["验收场景明细"],
  triage: ["异常事实", "研判结论"],
  advisor: ["技术取舍", "授权裁决"],
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSectionBody(markdownBody: string, heading: string): string | null {
  const pattern = new RegExp(
    `^#{1,3}[ \\t]+${escapeRegExp(heading)}(?:[ \\t:(（][^\\r\\n]*)?(?=\\r?\\n|$)`,
    "m",
  );
  const match = pattern.exec(markdownBody);
  if (!match) return null;
  const afterHeading = markdownBody.slice(match.index + match[0].length);
  const nextHeading = /^#{1,3}[ \t]+/m.exec(afterHeading);
  const slice = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  return slice.trim();
}

export type ReceiptValidationResult<T> =
  | { ok: true; frontmatter: T; body: string }
  | { ok: false; errors: string[] };

const SCHEMA_BY_KIND = {
  worker: WorkerReceiptFrontmatterSchema,
  reviewer: ReviewerReceiptFrontmatterSchema,
  verifier: VerifierReceiptFrontmatterSchema,
  triage: TriageReceiptFrontmatterSchema,
  advisor: AdvisorReceiptFrontmatterSchema,
} as const;

export type ReceiptFrontmatterMap = {
  worker: WorkerReceiptFrontmatter;
  reviewer: ReviewerReceiptFrontmatter;
  verifier: VerifierReceiptFrontmatter;
  triage: TriageReceiptFrontmatter;
  advisor: AdvisorReceiptFrontmatter;
};

export function parseAndValidateReceipt<K extends ReceiptKind>(
  kind: K,
  rawMarkdown: string,
): ReceiptValidationResult<ReceiptFrontmatterMap[K]> {
  let parsed: ParsedFrontmatterMarkdown;
  try {
    parsed = parseFrontmatterMarkdown(rawMarkdown);
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  const schema = SCHEMA_BY_KIND[kind];
  const result = schema.safeParse(parsed.frontmatter);
  const errors: string[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      const pathStr = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      errors.push(`${pathStr}: ${issue.message}`);
    }
  }

  for (const section of REQUIRED_SECTIONS[kind]) {
    if (extractSectionBody(parsed.body, section) === null) {
      errors.push(`Missing required Markdown section: ${section}`);
    }
  }

  if (kind === "worker" && result.success) {
    const wf = result.data as WorkerReceiptFrontmatter;
    if (wf.is_bugfix) {
      const repro = extractSectionBody(parsed.body, "修前复现证据");
      if (repro === null || repro.length === 0) {
        errors.push("Bugfix worker receipt requires non-empty section: 修前复现证据");
      }
    }
  }

  if (errors.length > 0 || !result.success) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    frontmatter: result.data as ReceiptFrontmatterMap[K],
    body: parsed.body,
  };
}

export interface NormalizedReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  title: string;
  location?: string;
  detail?: string;
}

const MAX_REVIEW_FINDINGS = 50;
const EMPTY_FINDING_PLACEHOLDER_RE =
  /^(?:[-*+]\s*)?(?:无|暂无|none|n\/a|无缺陷|未发现缺陷|no\s+findings)[。.\s]*$/i;
const FINDING_BULLET_START_RE = /^(?:[-*+]|\d+[.)]|#{3})\s+(.+)$/;
const LEADING_SEVERITY_TAG_RE =
  /^(?:[[(【*]*(P[012])[\])】*]*[\s:：\-–—]*)+/i;
const INLINE_SEVERITY_TAG_RE = /[[(【\b](P[012])[\])】\b]/i;
const INLINE_BACKTICK_PATH_RE = /`([^`\s]*[/.][^`\s]*)`/;

function toSeverityUpper(raw: string): ReviewFindingSeverity {
  const up = raw.toUpperCase();
  if (up === "P0" || up === "P1" || up === "P2") {
    return up;
  }
  return "P1";
}

function normalizeFindingBulletText(
  firstLine: string,
  extraLines: readonly string[],
  fallbackSeverity: ReviewFindingSeverity,
): Omit<NormalizedReviewFinding, "id"> | null {
  const combinedRaw = firstLine.trim();
  if (!combinedRaw || EMPTY_FINDING_PLACEHOLDER_RE.test(combinedRaw)) {
    return null;
  }

  let severity = fallbackSeverity;
  let title = combinedRaw;

  const leadingMatch = LEADING_SEVERITY_TAG_RE.exec(title);
  if (leadingMatch && leadingMatch[1]) {
    severity = toSeverityUpper(leadingMatch[1]);
    title = title.slice(leadingMatch[0].length).trim();
  } else {
    const inlineMatch = INLINE_SEVERITY_TAG_RE.exec(title);
    if (inlineMatch && inlineMatch[1]) {
      severity = toSeverityUpper(inlineMatch[1]);
    }
  }

  if (!title || EMPTY_FINDING_PLACEHOLDER_RE.test(title)) {
    return null;
  }

  const allText = [combinedRaw, ...extraLines].join("\n");
  const pathMatch = INLINE_BACKTICK_PATH_RE.exec(allText);
  const location = pathMatch?.[1]?.trim();

  const cleanedDetailLines = extraLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const detail =
    cleanedDetailLines.length > 0 ? cleanedDetailLines.join("\n") : undefined;

  return {
    severity,
    title,
    ...(location ? { location } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Extracts normalized reviewer findings from a reviewer `RECEIPT.md`:
 * prefers structured `frontmatter.findings` when present and non-empty,
 * otherwise parses bullets/headings under `## 缺陷清单` cleanly.
 */
export function extractReviewFindingsFromReceipt(
  rawReceipt: string,
): NormalizedReviewFinding[] {
  if (!rawReceipt || rawReceipt.trim().length === 0) {
    return [];
  }

  let parsed: ParsedFrontmatterMarkdown;
  try {
    parsed = parseFrontmatterMarkdown(rawReceipt);
  } catch {
    return [];
  }

  if (Array.isArray(parsed.frontmatter.findings)) {
    const parsedFindings = z
      .array(ReviewFindingItemSchema)
      .safeParse(parsed.frontmatter.findings);
    if (parsedFindings.success && parsedFindings.data.length > 0) {
      return parsedFindings.data.slice(0, MAX_REVIEW_FINDINGS).map((item, idx) => ({
        id: item.id?.trim() || `rf-${idx + 1}`,
        severity: item.severity,
        title: item.title.trim(),
        ...(item.location ? { location: item.location.trim() } : {}),
        ...(item.detail ? { detail: item.detail.trim() } : {}),
      }));
    }
  }

  const sectionBody = extractSectionBody(parsed.body, "缺陷清单");
  if (!sectionBody || EMPTY_FINDING_PLACEHOLDER_RE.test(sectionBody)) {
    return [];
  }

  const fm = parsed.frontmatter;
  const p0 = typeof fm.p0 === "number" ? fm.p0 : 0;
  const p1 = typeof fm.p1 === "number" ? fm.p1 : 0;
  const p2 = typeof fm.p2 === "number" ? fm.p2 : 0;
  const fallbackSeverity: ReviewFindingSeverity =
    p0 > 0 && p1 === 0 && p2 === 0
      ? "P0"
      : p2 > 0 && p0 === 0 && p1 === 0
        ? "P2"
        : "P1";

  const lines = sectionBody.split(/\r?\n/);
  const blocks: Array<{ head: string; continuation: string[] }> = [];

  for (const rawLine of lines) {
    const trimmedRight = rawLine.replace(/\s+$/, "");
    if (!trimmedRight.trim()) {
      continue;
    }
    const isIndented = /^\s{2,}/.test(rawLine) || rawLine.startsWith("\t");
    const bulletMatch = !isIndented ? FINDING_BULLET_START_RE.exec(trimmedRight) : null;
    if (bulletMatch && bulletMatch[1]) {
      blocks.push({ head: bulletMatch[1], continuation: [] });
      continue;
    }
    if (blocks.length > 0) {
      blocks[blocks.length - 1]!.continuation.push(trimmedRight);
    } else {
      blocks.push({ head: trimmedRight.trim(), continuation: [] });
    }
  }

  const findings: NormalizedReviewFinding[] = [];
  for (const blk of blocks) {
    if (findings.length >= MAX_REVIEW_FINDINGS) {
      break;
    }
    const normalized = normalizeFindingBulletText(
      blk.head,
      blk.continuation,
      fallbackSeverity,
    );
    if (!normalized) {
      continue;
    }
    findings.push({
      id: `rf-${findings.length + 1}`,
      ...normalized,
    });
  }

  return findings;
}
