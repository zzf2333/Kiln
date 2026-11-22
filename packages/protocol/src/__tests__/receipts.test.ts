import { describe, expect, it } from "vitest";
import {
  ADVISOR_ELIGIBLE_DECISION_CATEGORIES,
  AdvisorReceiptFrontmatterSchema,
  AdvisorRequestSchema,
  isAdvisorEligibleDecisionCategory,
  parseAndValidateReceipt,
  parseFrontmatterMarkdown,
  serializeFrontmatterMarkdown,
} from "../index.js";

describe("receipts frontmatter and validation", () => {
  it("round-trips frontmatter markdown cleanly", () => {
    const raw = serializeFrontmatterMarkdown(
      { run_id: "r-1", contract_version: 2, verdict: "pass", p0: 0, p1: 0, p2: 0 },
      "\n### 结论\n通过\n",
    );
    const parsed = parseFrontmatterMarkdown(raw);
    expect(parsed.frontmatter.run_id).toBe("r-1");
    expect(parsed.frontmatter.contract_version).toBe(2);
    expect(parsed.body).toContain("### 结论");
  });

  it("validates reviewer, verifier, triage, and advisor receipts with CJK headings", () => {
    const reviewerMd = serializeFrontmatterMarkdown(
      {
        run_id: "r-10",
        contract_version: 1,
        reviewed_ref: "abc123",
        verdict: "pass",
        p0: 0,
        p1: 0,
        p2: 1,
      },
      `### 结论
无阻断缺陷

### 缺陷清单
- [P2] minor wording

### 测试真实性与复现核查
- 已核查真实单测
`,
    );
    const rev = parseAndValidateReceipt("reviewer", reviewerMd);
    expect(rev.ok).toBe(true);

    const verifierMd = serializeFrontmatterMarkdown(
      {
        run_id: "r-11",
        contract_version: 1,
        verified_ref: "abc123",
        verdict: "pass",
        passed_scenarios: 3,
        failed_scenarios: 0,
      },
      `### 验收场景明细
1. 场景一通过
`,
    );
    expect(parseAndValidateReceipt("verifier", verifierMd).ok).toBe(true);

    const triageMd = serializeFrontmatterMarkdown(
      {
        run_id: "r-12",
        contract_version: 1,
        recommendation: "escalate_advisor",
        summary: "Need architecture tie-break",
      },
      `### 异常事实
两次重试相同失败

### 研判结论
建议叫 advisor
`,
    );
    expect(parseAndValidateReceipt("triage", triageMd).ok).toBe(true);

    const advisorMd = serializeFrontmatterMarkdown(
      {
        run_id: "r-13",
        contract_version: 1,
        outcome: "resolved",
        chosen_approach: "Use WAL synchronous transaction",
      },
      `### 技术取舍
对比两方案

### 授权裁决
采用单事务更新
`,
    );
    expect(parseAndValidateReceipt("advisor", advisorMd).ok).toBe(true);
  });

  it("enforces non-empty 修前复现证据 when worker receipt is a bugfix", () => {
    const baseFrontmatter = {
      run_id: "r-20",
      contract_version: 1,
      outcome: "completed",
      input_ref: "sha-in",
      output_ref: "sha-out",
      changed_paths: ["src/a.ts"],
      accept_result: "pass",
      is_bugfix: true,
    };

    const missingRepro = serializeFrontmatterMarkdown(
      baseFrontmatter,
      `### 改动说明
修好了

### 验证命令与真实输出
pnpm test -> pass

### 未完成或待决问题
无
`,
    );
    const failMissing = parseAndValidateReceipt("worker", missingRepro);
    expect(failMissing.ok).toBe(false);
    if (!failMissing.ok) {
      expect(failMissing.errors.some((e) => e.includes("修前复现证据"))).toBe(true);
    }

    const emptyRepro = serializeFrontmatterMarkdown(
      baseFrontmatter,
      `### 修前复现证据

### 改动说明
修好了

### 验证命令与真实输出
pnpm test -> pass

### 未完成或待决问题
无
`,
    );
    expect(parseAndValidateReceipt("worker", emptyRepro).ok).toBe(false);

    const validBugfix = serializeFrontmatterMarkdown(
      baseFrontmatter,
      `### 修前复现证据
修前运行 vitest 报 TypeError

### 改动说明
补空值守卫

### 验证命令与真实输出
pnpm test -> pass

### 未完成或待决问题
无
`,
    );
    expect(parseAndValidateReceipt("worker", validBugfix).ok).toBe(true);
  });

  it("rejects missing frontmatter fields or invalid verdict", () => {
    const badReviewer = `---
run_id: r-10
verdict: maybe
---

### 结论
不完整
`;
    const res = parseAndValidateReceipt("reviewer", badReviewer);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("supports legacy and extended AdvisorReceiptFrontmatter fields, AdvisorRequestSchema, and advisor category allowlist", () => {
    const legacy = AdvisorReceiptFrontmatterSchema.parse({
      run_id: "r-adv-1",
      contract_version: 1,
      outcome: "resolved",
      chosen_approach: "Plan A",
    });
    expect(legacy.requires_contract_change).toBe(false);
    expect(legacy.requires_scope_expansion).toBe(false);
    expect(legacy.requires_human_approval).toBe(false);
    expect(legacy.decision_kind).toBeUndefined();
    expect(legacy.target_stage).toBeUndefined();

    const extendedMd = serializeFrontmatterMarkdown(
      {
        run_id: "r-adv-2",
        contract_version: 2,
        outcome: "resolved",
        chosen_approach: "Use single SQLite transaction",
        decision_kind: "technical_ambiguity",
        requires_contract_change: false,
        requires_scope_expansion: true,
        requires_human_approval: false,
        target_stage: "review",
      },
      `## 技术取舍
对比事务粒度和锁争用。

## 授权裁决
需扩写另一目录，升级人类确认。
`,
    );
    const parsedExtended = parseAndValidateReceipt("advisor", extendedMd);
    expect(parsedExtended.ok).toBe(true);
    if (parsedExtended.ok) {
      expect(parsedExtended.frontmatter.decision_kind).toBe("technical_ambiguity");
      expect(parsedExtended.frontmatter.requires_scope_expansion).toBe(true);
      expect(parsedExtended.frontmatter.target_stage).toBe("review");
    }

    const req = AdvisorRequestSchema.parse({
      schema_version: 1,
      contract_version: 1,
      trigger: "technical_ambiguity",
      source_stage: "implement",
      source_run_id: "run-1",
      source_role: "worker",
      category: "technical_ambiguity",
      reason: "worker_ambiguity",
      question: "Should state persist in YAML or SQLite?",
      created_at: "2026-11-22T08:00:00.000Z",
    });
    expect(req.options).toEqual([]);

    for (const cat of ADVISOR_ELIGIBLE_DECISION_CATEGORIES) {
      expect(isAdvisorEligibleDecisionCategory(cat)).toBe(true);
      expect(isAdvisorEligibleDecisionCategory(`  ${cat.toUpperCase()} `)).toBe(true);
    }
    expect(isAdvisorEligibleDecisionCategory("scope_clarification")).toBe(false);
    expect(isAdvisorEligibleDecisionCategory("frozen_test_escalation")).toBe(false);
    expect(isAdvisorEligibleDecisionCategory("external_action")).toBe(false);
    expect(isAdvisorEligibleDecisionCategory("unknown_custom_reason")).toBe(false);
  });
});
