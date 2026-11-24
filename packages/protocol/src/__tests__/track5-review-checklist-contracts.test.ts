import { describe, expect, it } from "vitest";
import {
  ResolveTaskChecklistRequestSchema,
  ReviewerReceiptFrontmatterSchema,
  extractReviewFindingsFromReceipt,
} from "../index.js";

describe("Track 5 [B12.4] review checklist contracts", () => {
  it("parses structured frontmatter findings and preserves p0/p1/p2 integer compatibility", () => {
    const raw = `---
run_id: r-rev-1
contract_version: 2
reviewed_ref: abc1234
verdict: changes_requested
p0: 1
p1: 1
p2: 0
findings:
  - id: f-auth
    severity: P0
    title: Missing CSRF check on /api/tasks/decide
    location: packages/kernel/src/server/http-api.ts:2610
    detail: Reject missing Origin header
  - severity: P1
    title: Unhandled null task detail
---
## 结论
Requires fixes

## 缺陷清单
- See structured findings

## 测试真实性与复现核查
Checked manually.
`;

    const fm = ReviewerReceiptFrontmatterSchema.parse({
      run_id: "r-rev-1",
      contract_version: 2,
      reviewed_ref: "abc1234",
      verdict: "changes_requested",
      p0: 1,
      p1: 1,
      p2: 0,
      findings: [
        {
          id: "f-auth",
          severity: "P0",
          title: "Missing CSRF check on /api/tasks/decide",
          location: "packages/kernel/src/server/http-api.ts:2610",
          detail: "Reject missing Origin header",
        },
        {
          severity: "P1",
          title: "Unhandled null task detail",
        },
      ],
    });
    expect(fm.findings).toHaveLength(2);

    const extracted = extractReviewFindingsFromReceipt(raw);
    expect(extracted).toEqual([
      {
        id: "f-auth",
        severity: "P0",
        title: "Missing CSRF check on /api/tasks/decide",
        location: "packages/kernel/src/server/http-api.ts:2610",
        detail: "Reject missing Origin header",
      },
      {
        id: "rf-2",
        severity: "P1",
        title: "Unhandled null task detail",
      },
    ]);
  });

  it("extracts findings from legacy Markdown 缺陷清单 and handles empty placeholder", () => {
    const legacy = `---
run_id: r-rev-2
contract_version: 1
reviewed_ref: HEAD
verdict: changes_requested
p0: 0
p1: 1
p2: 1
---
## 结论
Changes requested

## 缺陷清单
- [P0] \`packages/kernel/src/store/kiln-store.ts\` Missing lock on writeYaml
  Affects concurrent task creation
2. [P2] Minor typo in \`apps/web/src/views/DetailView.tsx\`

## 测试真实性与复现核查
Verified tests.
`;
    const items = extractReviewFindingsFromReceipt(legacy);
    expect(items).toEqual([
      {
        id: "rf-1",
        severity: "P0",
        title: "`packages/kernel/src/store/kiln-store.ts` Missing lock on writeYaml",
        location: "packages/kernel/src/store/kiln-store.ts",
        detail: "Affects concurrent task creation",
      },
      {
        id: "rf-2",
        severity: "P2",
        title: "Minor typo in `apps/web/src/views/DetailView.tsx`",
        location: "apps/web/src/views/DetailView.tsx",
      },
    ]);

    const cleanReceipt = `---
run_id: r-rev-3
contract_version: 1
reviewed_ref: HEAD
verdict: pass
p0: 0
p1: 0
p2: 0
---
## 结论
Pass

## 缺陷清单
无

## 测试真实性与复现核查
All tests pass.
`;
    expect(extractReviewFindingsFromReceipt(cleanReceipt)).toEqual([]);
  });

  it("requires non-empty rationale when waiving a checklist item", () => {
    const missingRationale = ResolveTaskChecklistRequestSchema.safeParse({
      items: [{ item_id: "002-review:rf-1", disposition: "waive", rationale: "   " }],
    });
    expect(missingRationale.success).toBe(false);

    const valid = ResolveTaskChecklistRequestSchema.parse({
      items: [
        { item_id: "002-review:rf-1", disposition: "waive", rationale: "False positive on Windows" },
        { item_id: "003-accept:sc-1", disposition: "rework" },
      ],
      advance_after_waive: false,
    });
    expect(valid.items).toHaveLength(2);
    expect(valid.interrupt).toBe(false);
  });
});
