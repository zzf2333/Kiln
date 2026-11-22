import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

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

export const ReviewerReceiptFrontmatterSchema = z.object({
  run_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  reviewed_ref: z.string().min(1),
  verdict: z.enum(["pass", "changes_requested"]),
  p0: z.number().int().nonnegative(),
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
});
export type ReviewerReceiptFrontmatter = z.infer<typeof ReviewerReceiptFrontmatterSchema>;

export const VerifierReceiptFrontmatterSchema = z.object({
  run_id: z.string().min(1),
  contract_version: z.number().int().positive(),
  verified_ref: z.string().min(1),
  verdict: z.enum(["pass", "fail"]),
  passed_scenarios: z.number().int().nonnegative(),
  failed_scenarios: z.number().int().nonnegative(),
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
