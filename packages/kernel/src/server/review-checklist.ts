import fs from "node:fs";
import {
  AcceptVerificationReportSchema,
  ChecklistItemSchema,
  RunMetaSchema,
  TaskChecklistDispositionsFileSchema,
  extractReviewFindingsFromReceipt,
  parseAndValidateReceipt,
  type ChecklistDispositionRecord,
  type ChecklistItem,
  type ResolveTaskChecklistRequest,
} from "@kiln/protocol";
import {
  KilnStore,
  assertSafeSegment,
  readYamlOptional,
  writeFileAtomic,
  writeYamlAtomic,
} from "../store/index.js";
import { readOptionalText } from "./pending-decisions.js";

/**
 * Returns `true` for high-severity review findings (`P0`/`P1`) or failed accept scenarios.
 */
export function isBlockingChecklistItem(item: ChecklistItem): boolean {
  if (item.source === "review") {
    return item.severity === "P0" || item.severity === "P1";
  }
  return item.severity === "fail";
}

/**
 * Reads persisted human checklist dispositions from `tasks/<id>/checklist-dispositions.yaml`.
 */
export function readTaskChecklistDispositions(
  store: KilnStore,
  taskId: string,
): Map<string, ChecklistDispositionRecord> {
  const file = readYamlOptional(
    store.paths.checklistDispositionsYaml(taskId),
    TaskChecklistDispositionsFileSchema,
  );
  const map = new Map<string, ChecklistDispositionRecord>();
  if (!file) {
    return map;
  }
  for (const rec of file.records) {
    map.set(rec.item_id, rec);
  }
  return map;
}

/**
 * Extracts structured review findings (from latest `review` run) and accept scenarios
 * (from latest `accept` run) and overlays persisted human dispositions.
 */
export function buildTaskReviewChecklist(store: KilnStore, taskId: string): ChecklistItem[] {
  const runsDir = store.paths.runsDir(taskId);
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const dirNames = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => assertSafeSegment(entry.name, "runDirName"))
    .sort((a, b) => a.localeCompare(b));

  let latestReview: {
    dirName: string;
    runId?: string;
    contractVersion?: number;
    receipt: string;
  } | null = null;
  let latestAccept: {
    dirName: string;
    runId?: string;
    contractVersion?: number;
    acceptReport: ReturnType<typeof AcceptVerificationReportSchema.parse> | null;
    receipt: string | null;
  } | null = null;

  for (const dirName of dirNames) {
    const meta = readYamlOptional(store.paths.runYaml(taskId, dirName), RunMetaSchema);
    const isReviewStage = meta?.stage === "review" || dirName.endsWith("-review");
    const isAcceptStage = meta?.stage === "accept" || dirName.endsWith("-accept");

    if (isReviewStage) {
      const receipt = readOptionalText(store.paths.receiptMd(taskId, dirName));
      if (receipt && receipt.trim().length > 0) {
        latestReview = {
          dirName,
          ...(meta?.run_id ? { runId: meta.run_id } : {}),
          ...(meta?.contract_version ? { contractVersion: meta.contract_version } : {}),
          receipt,
        };
      }
    }

    if (isAcceptStage) {
      const acceptReport = readYamlOptional(
        store.paths.runAcceptReportYaml(taskId, dirName),
        AcceptVerificationReportSchema,
      );
      const receipt = readOptionalText(store.paths.receiptMd(taskId, dirName));
      if (acceptReport || (receipt && receipt.trim().length > 0)) {
        latestAccept = {
          dirName,
          ...(meta?.run_id ? { runId: meta.run_id } : {}),
          ...(meta?.contract_version ? { contractVersion: meta.contract_version } : {}),
          acceptReport,
          receipt,
        };
      }
    }
  }

  const dispositions = readTaskChecklistDispositions(store, taskId);
  const items: ChecklistItem[] = [];

  if (latestReview) {
    const findings = extractReviewFindingsFromReceipt(latestReview.receipt);
    for (const f of findings) {
      const itemId = `${latestReview.dirName}:${f.id}`;
      const disp = dispositions.get(itemId);
      items.push(
        ChecklistItemSchema.parse({
          id: itemId,
          run_dir: latestReview.dirName,
          ...(latestReview.runId ? { run_id: latestReview.runId } : {}),
          source: "review",
          severity: f.severity,
          title: f.title,
          ...(f.location ? { location: f.location } : {}),
          ...(f.detail ? { detail: f.detail } : {}),
          ...(latestReview.contractVersion
            ? { contract_version: latestReview.contractVersion }
            : {}),
          ...(disp
            ? {
                disposition: disp.disposition,
                ...(disp.rationale ? { rationale: disp.rationale } : {}),
                decided_at: disp.decided_at,
              }
            : {}),
        }),
      );
    }
  }

  if (latestAccept) {
    let scenarios = latestAccept.acceptReport?.scenarios ?? [];
    if (scenarios.length === 0 && latestAccept.receipt) {
      const parsedVerifier = parseAndValidateReceipt("verifier", latestAccept.receipt);
      if (parsedVerifier.ok && parsedVerifier.frontmatter.scenarios) {
        scenarios = parsedVerifier.frontmatter.scenarios;
      }
    }

    scenarios.forEach((sc, idx) => {
      const itemId = `${latestAccept!.dirName}:sc-${idx + 1}`;
      const disp = dispositions.get(itemId);
      items.push(
        ChecklistItemSchema.parse({
          id: itemId,
          run_dir: latestAccept!.dirName,
          ...(latestAccept!.runId ? { run_id: latestAccept!.runId } : {}),
          source: "accept",
          severity: sc.status,
          title: sc.name,
          ...(sc.note && sc.note.trim().length > 0 ? { detail: sc.note.trim() } : {}),
          ...(sc.evidence_files && sc.evidence_files.length > 0
            ? { evidence_files: sc.evidence_files }
            : {}),
          ...(latestAccept!.contractVersion
            ? { contract_version: latestAccept!.contractVersion }
            : {}),
          ...(disp
            ? {
                disposition: disp.disposition,
                ...(disp.rationale ? { rationale: disp.rationale } : {}),
                decided_at: disp.decided_at,
              }
            : {}),
        }),
      );
    });
  }

  return items;
}

export interface PersistedChecklistBatch {
  records: ChecklistDispositionRecord[];
  reworkEntries: Array<{ item: ChecklistItem; rationale?: string }>;
  waiveEntries: Array<{ item: ChecklistItem; rationale: string }>;
}

/**
 * Atomically merges checklist dispositions into `checklist-dispositions.yaml`
 * and appends a human-readable audit log entry into `decisions.md`.
 */
export function persistChecklistDispositions(
  store: KilnStore,
  params: {
    taskId: string;
    contractVersion: number;
    checklist: readonly ChecklistItem[];
    requestedItems: ResolveTaskChecklistRequest["items"];
    extraNote?: string;
    now?: string;
  },
): PersistedChecklistBatch {
  const { taskId, contractVersion, checklist, requestedItems, extraNote } = params;
  const timestamp = params.now ?? new Date().toISOString();
  const byId = new Map(checklist.map((item) => [item.id, item]));
  const existingMap = readTaskChecklistDispositions(store, taskId);

  const reworkEntries: Array<{ item: ChecklistItem; rationale?: string }> = [];
  const waiveEntries: Array<{ item: ChecklistItem; rationale: string }> = [];

  for (const req of requestedItems) {
    const target = byId.get(req.item_id);
    if (!target) {
      continue;
    }
    const cleanRationale = req.rationale?.trim();
    const record: ChecklistDispositionRecord = {
      item_id: target.id,
      run_dir: target.run_dir,
      source: target.source,
      disposition: req.disposition,
      ...(cleanRationale && cleanRationale.length > 0 ? { rationale: cleanRationale } : {}),
      decided_at: timestamp,
      contract_version: contractVersion,
    };
    existingMap.set(target.id, record);

    if (req.disposition === "rework") {
      reworkEntries.push({
        item: target,
        ...(cleanRationale ? { rationale: cleanRationale } : {}),
      });
    } else {
      waiveEntries.push({
        item: target,
        rationale: cleanRationale ?? "",
      });
    }
  }

  const mergedRecords = Array.from(existingMap.values());
  writeYamlAtomic(
    store.paths.checklistDispositionsYaml(taskId),
    {
      schema_version: 1,
      task_id: taskId,
      updated_at: timestamp,
      records: mergedRecords,
    },
    TaskChecklistDispositionsFileSchema,
  );

  const lines: string[] = [
    `## [checklist] 审查/验收清单裁决 (${timestamp} · 契约 v${contractVersion})`,
    `- 裁决人：human`,
  ];
  if (reworkEntries.length > 0) {
    lines.push(`- 打回修复 (${reworkEntries.length}):`);
    for (const entry of reworkEntries) {
      lines.push(
        `  - [${entry.item.severity}] ${entry.item.title}${entry.item.location ? ` (${entry.item.location})` : ""}${entry.rationale ? ` —— 说明：${entry.rationale}` : ""}`,
      );
    }
  }
  if (waiveEntries.length > 0) {
    lines.push(`- 确认豁免 (${waiveEntries.length}):`);
    for (const entry of waiveEntries) {
      lines.push(
        `  - [${entry.item.severity}] ${entry.item.title}${entry.item.location ? ` (${entry.item.location})` : ""} —— 理由：${entry.rationale}`,
      );
    }
  }
  if (extraNote && extraNote.trim().length > 0) {
    lines.push(`- 补充说明：${extraNote.trim()}`);
  }

  const decisionsPath = store.paths.decisionsMd(taskId);
  const existingDecisions = readOptionalText(decisionsPath) ?? "";
  const entryMd = lines.join("\n");
  const nextDecisions =
    existingDecisions.trim().length > 0
      ? `${existingDecisions.trimEnd()}\n\n${entryMd}\n`
      : `${entryMd}\n`;
  writeFileAtomic(decisionsPath, nextDecisions);

  return {
    records: mergedRecords,
    reworkEntries,
    waiveEntries,
  };
}

/**
 * Formats a concise Chinese `steered` rework instruction for `implement`
 * detailing items rejected for rework and explicitly waived items.
 */
export function buildChecklistReworkMessage(params: {
  reworkEntries: Array<{ item: ChecklistItem; rationale?: string }>;
  waiveEntries: Array<{ item: ChecklistItem; rationale: string }>;
  extraNote?: string;
}): string {
  const sections: string[] = [
    `请根据人工审定后的审查与验收清单进行针对性修复（勿改动已确认豁免的问题）：`,
  ];

  if (params.reworkEntries.length > 0) {
    sections.push("", "### 必须打回修复条目");
    for (const { item, rationale } of params.reworkEntries) {
      const loc = item.location ? ` [${item.location}]` : "";
      const note = rationale ? `（批注：${rationale}）` : "";
      const detail = item.detail ? ` — ${item.detail}` : "";
      sections.push(`- [${item.source}/${item.severity}] ${item.title}${loc}${detail}${note}`);
    }
  }

  if (params.waiveEntries.length > 0) {
    sections.push("", "### 已确认豁免条目（无需修改）");
    for (const { item, rationale } of params.waiveEntries) {
      sections.push(`- [${item.source}/${item.severity}] ${item.title}（豁免理由：${rationale}）`);
    }
  }

  if (params.extraNote && params.extraNote.trim().length > 0) {
    sections.push("", `### 补充要求`, params.extraNote.trim());
  }

  return sections.join("\n");
}
