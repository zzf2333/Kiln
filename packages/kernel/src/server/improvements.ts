import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  GateReportSchema,
  AcceptVerificationReportSchema,
  ImprovementProposalSchema,
  ImprovementProposalsFileSchema,
  LedgerFileSchema,
  MAX_ACTIVE_LEDGER_INJECT,
  PolicyChangeRecordSchema,
  RosterConfigSchema,
  RunMetaSchema,
  SpaceConfigSchema,
  TaskCardSchema,
  type ImprovementProposal,
  type ImprovementTargetKind,
  type LedgerEntry,
  type PolicyChangeRecord,
  type PolicyMetricWindow,
  type RosterConfig,
  type SpaceConfig,
  parseAndValidateReceipt,
} from "@kiln/protocol";
import {
  KilnStore,
  ensureDir,
  readNdjsonValidated,
  readYamlOptional,
  writeFileAtomic,
  writeYamlAtomic,
} from "../store/index.js";
import { computeUsageSnapshot, readOptionalText } from "./pending-decisions.js";

export interface RoleModelEfficiencyStat {
  roster_role: string;
  agent: string;
  model: string;
  run_count: number;
  pass_rate: number;
  escalation_rate: number;
  cache_hit_rate: number;
  avg_cost_usd: number;
}

export interface WorkflowPresetEfficiencyStat {
  preset: string;
  metrics: PolicyMetricWindow;
}

export interface SpaceEfficiencyStat {
  space_id: string;
  space_name: string;
  metrics: PolicyMetricWindow;
}

export interface OrchestrationAnalytics {
  generated_at: string;
  overall: PolicyMetricWindow;
  by_space: SpaceEfficiencyStat[];
  by_role_model: RoleModelEfficiencyStat[];
  by_workflow_preset: WorkflowPresetEfficiencyStat[];
}

export interface PolicyChangeEvaluation extends PolicyChangeRecord {
  after_metrics: PolicyMetricWindow;
  regression_alert: boolean;
  regression_reasons: string[];
}

export type CandidateProposalInput = Omit<
  ImprovementProposal,
  "id" | "status" | "created_at" | "decided_at" | "policy_change_id"
>;

const FORBIDDEN_CHEATING_RE =
  /(disable_verify|skip_verify|bypass_gate|weaken_accept|disable_scope|ignore_scope|observe_http\s*[:=]\s*false|heterogeneous_review\s*[:=]\s*false|allow_full_access_fallback\s*[:=]\s*true|accept_cmd\s*[:=]\s*["']?true)/i;

/**
 * Selects bounded active ledger rules for Layer 1 HANDOFF & PM prompts,
 * filtering archived rules and ranking by hit_count desc then newest first.
 */
export function selectActiveLedgerEntriesForHandoff(
  entries: readonly LedgerEntry[],
  maxCount = MAX_ACTIVE_LEDGER_INJECT,
): LedgerEntry[] {
  const active = entries.filter((e) => (e.status ?? "active") !== "archived");
  return [...active]
    .sort((a, b) => {
      const hitDiff = (b.hit_count ?? 0) - (a.hit_count ?? 0);
      if (hitDiff !== 0) return hitDiff;
      return b.created_at.localeCompare(a.created_at);
    })
    .slice(0, maxCount);
}

/**
 * Rejects any self-optimization proposal that weakens deterministic verification,
 * scope containment, or heterogeneous review (`REVIEW.md` & Track 4 anti-cheating rule).
 */
export function assertProposalNotCheating(
  proposal: Pick<CandidateProposalInput, "target_kind" | "title" | "rationale" | "payload">,
): void {
  const serialized = `${proposal.title}\n${proposal.rationale}\n${JSON.stringify(proposal.payload)}`;
  if (FORBIDDEN_CHEATING_RE.test(serialized)) {
    throw new Error(
      `Rejected unsafe optimization proposal "${proposal.title}": disabling or weakening verification gates is forbidden`,
    );
  }
  if (proposal.target_kind === "roster_policy") {
    const patch = proposal.payload as Record<string, unknown>;
    const pmPatch =
      patch.pm_orchestration_patch && typeof patch.pm_orchestration_patch === "object"
        ? (patch.pm_orchestration_patch as Record<string, unknown>)
        : null;
    if (
      patch.heterogeneous_review === false ||
      pmPatch?.heterogeneous_review === false
    ) {
      throw new Error("Rejected proposal: disabling heterogeneous_review is forbidden");
    }
    if (
      patch.allow_full_access_fallback === true ||
      pmPatch?.allow_full_access_fallback === true
    ) {
      throw new Error("Rejected proposal: enabling allow_full_access_fallback is forbidden");
    }
  }
}

export function readImprovementProposals(store: KilnStore): ImprovementProposal[] {
  const file = readYamlOptional(
    store.paths.improvementProposalsYaml,
    ImprovementProposalsFileSchema,
  );
  return file ? file.proposals : [];
}

function writeImprovementProposals(
  store: KilnStore,
  proposals: readonly ImprovementProposal[],
): void {
  ensureDir(store.paths.improvementsDir);
  writeYamlAtomic(
    store.paths.improvementProposalsYaml,
    { schema_version: 1, proposals: [...proposals] },
    ImprovementProposalsFileSchema,
  );
}

function proposalDedupeKey(p: {
  target_kind: ImprovementTargetKind;
  space?: string;
  roster_role?: string;
  title: string;
}): string {
  return [
    p.target_kind,
    p.space ?? "",
    p.roster_role ?? "",
    p.title.trim().toLowerCase(),
  ].join("|");
}

/**
 * Inserts candidate improvement proposals while deduplicating pending proposals
 * on `(target_kind, space, roster_role, title)` so repeated scans remain idempotent.
 */
export function upsertImprovementProposals(
  store: KilnStore,
  candidates: readonly CandidateProposalInput[],
): ImprovementProposal[] {
  const existing = readImprovementProposals(store);
  const pendingByKey = new Map<string, number>();
  existing.forEach((p, idx) => {
    if (p.status === "pending") {
      pendingByKey.set(proposalDedupeKey(p), idx);
    }
  });

  const result = [...existing];
  const touched: ImprovementProposal[] = [];
  const now = new Date().toISOString();

  for (const cand of candidates) {
    assertProposalNotCheating(cand);
    const key = proposalDedupeKey(cand);
    const existingIdx = pendingByKey.get(key);
    if (existingIdx !== undefined) {
      const cur = result[existingIdx]!;
      const mergedEvidence = Array.from(
        new Set([...cur.evidence_task_ids, ...(cand.evidence_task_ids ?? [])]),
      );
      const updated = ImprovementProposalSchema.parse({
        ...cur,
        rationale: cand.rationale,
        expected_impact: cand.expected_impact,
        evidence_task_ids: mergedEvidence,
        payload: cand.payload,
      });
      result[existingIdx] = updated;
      touched.push(updated);
    } else {
      const created = ImprovementProposalSchema.parse({
        ...cand,
        id: `prop-${randomUUID().slice(0, 8)}`,
        status: "pending",
        created_at: now,
      });
      pendingByKey.set(key, result.length);
      result.push(created);
      touched.push(created);
    }
  }

  writeImprovementProposals(store, result);
  return touched;
}

function tokenizeRuleText(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
  const tokens = new Set<string>();
  for (const part of normalized.split(/\s+/)) {
    if (!part) continue;
    tokens.add(part);
    // Add CJK 2-char bigrams for semantic overlap on Chinese rules without spaces
    if (/[\u4e00-\u9fff]/.test(part) && part.length >= 2) {
      for (let i = 0; i < part.length - 1; i += 1) {
        tokens.add(part.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Scans all space ledgers for near-duplicate active rules (`space_ledger_merge`)
 * and cold zero-hit rules overflowing `MAX_ACTIVE_LEDGER_INJECT` (`space_ledger_archive`).
 */
export function analyzeLedgerHygiene(store: KilnStore): CandidateProposalInput[] {
  const out: CandidateProposalInput[] = [];
  if (!fs.existsSync(store.paths.ledgerDir)) {
    return out;
  }

  const files = fs
    .readdirSync(store.paths.ledgerDir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".yaml"));

  for (const file of files) {
    const spaceId = file.name.slice(0, -".yaml".length);
    const ledger = store.readLedger(spaceId);
    if (!ledger) continue;
    const active = ledger.entries.filter((e) => (e.status ?? "active") !== "archived");
    if (active.length === 0) continue;

    // 1. Detect near-duplicate active pairs
    const tokenized = active.map((e) => ({
      entry: e,
      tokens: tokenizeRuleText(e.prevention_rule ?? e.rule),
    }));
    const pairedIds = new Set<string>();
    for (let i = 0; i < tokenized.length; i += 1) {
      for (let j = i + 1; j < tokenized.length; j += 1) {
        const a = tokenized[i]!;
        const b = tokenized[j]!;
        if (pairedIds.has(a.entry.id) || pairedIds.has(b.entry.id)) continue;
        const sim = jaccardSimilarity(a.tokens, b.tokens);
        if (sim >= 0.65) {
          pairedIds.add(a.entry.id);
          pairedIds.add(b.entry.id);
          const keepPrimary =
            (b.entry.hit_count ?? 0) > (a.entry.hit_count ?? 0) ? b.entry : a.entry;
          const secondary = keepPrimary.id === a.entry.id ? b.entry : a.entry;
          out.push({
            source: "ledger_hygiene",
            target_kind: "space_ledger_merge",
            space: spaceId,
            title: `合并空间 ${spaceId} 的重复账本规则 (${keepPrimary.id} + ${secondary.id})`,
            rationale: `检测到两条规则文本相似度 ${(sim * 100).toFixed(0)}%：「${a.entry.rule}」与「${b.entry.rule}」，合并可节省 Layer 1 缓存上下文。`,
            expected_impact: "减少 1 条重复规则，压缩 Layer 1 前缀噪声",
            evidence_task_ids: Array.from(
              new Set([keepPrimary.source_task_id, secondary.source_task_id]),
            ),
            payload: {
              source_ids: [keepPrimary.id, secondary.id],
              merged_rule: keepPrimary.rule,
            },
          });
        }
      }
    }

    // 2. Detect overflow stale rules when active count exceeds MAX_ACTIVE_LEDGER_INJECT
    if (active.length > MAX_ACTIVE_LEDGER_INJECT) {
      const overflowCount = active.length - MAX_ACTIVE_LEDGER_INJECT;
      const staleCandidates = [...active]
        .filter((e) => (e.hit_count ?? 0) === 0 && !pairedIds.has(e.id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, overflowCount);
      if (staleCandidates.length > 0) {
        out.push({
          source: "ledger_hygiene",
          target_kind: "space_ledger_archive",
          space: spaceId,
          title: `归档空间 ${spaceId} 超限零命中旧规则 (${staleCandidates.length} 条)`,
          rationale: `当前活跃规则共 ${active.length} 条（超过上限 ${MAX_ACTIVE_LEDGER_INJECT} 条），建议归档最旧零命中规则以防 Layer 1 上下文腐烂。`,
          expected_impact: `将活跃规则收敛至 ${MAX_ACTIVE_LEDGER_INJECT} 条以内`,
          evidence_task_ids: staleCandidates.map((e) => e.source_task_id),
          payload: {
            entry_ids: staleCandidates.map((e) => e.id),
          },
        });
      }
    }
  }

  return out;
}

interface TaskStatRecord {
  taskId: string;
  space: string;
  preset: string;
  finishedAt: string;
  firstPass: boolean;
  reworkRounds: number;
  escalated: boolean;
  acceptRan: boolean;
  acceptCaughtDefect: boolean;
  cacheHitRate: number;
  costUsd: number;
}

function summarizeMetricWindow(records: readonly TaskStatRecord[]): PolicyMetricWindow {
  if (records.length === 0) {
    return {
      task_count: 0,
      first_pass_rate: 0,
      avg_rework_rounds: 0,
      cache_hit_rate: 0,
      median_cost_usd: 0,
      p90_cost_usd: 0,
      accept_defect_catch_rate: 0,
    };
  }
  const n = records.length;
  const firstPassCount = records.filter((r) => r.firstPass).length;
  const totalRework = records.reduce((acc, r) => acc + r.reworkRounds, 0);
  const avgCache = records.reduce((acc, r) => acc + r.cacheHitRate, 0) / n;
  const sortedCosts = records.map((r) => r.costUsd).sort((a, b) => a - b);
  const mid = Math.floor(sortedCosts.length / 2);
  const medianCost =
    sortedCosts.length % 2 === 1
      ? sortedCosts[mid]!
      : (sortedCosts[mid - 1]! + sortedCosts[mid]!) / 2;
  const p90Idx = Math.min(sortedCosts.length - 1, Math.floor(sortedCosts.length * 0.9));
  const p90Cost = sortedCosts[p90Idx]!;
  const acceptRan = records.filter((r) => r.acceptRan);
  const acceptCaught = acceptRan.filter((r) => r.acceptCaughtDefect).length;

  return {
    task_count: n,
    first_pass_rate: Number((firstPassCount / n).toFixed(4)),
    avg_rework_rounds: Number((totalRework / n).toFixed(2)),
    cache_hit_rate: Number(avgCache.toFixed(4)),
    median_cost_usd: Number(medianCost.toFixed(4)),
    p90_cost_usd: Number(p90Cost.toFixed(4)),
    accept_defect_catch_rate:
      acceptRan.length > 0 ? Number((acceptCaught / acceptRan.length).toFixed(4)) : 0,
  };
}

function collectFinishedTaskStats(
  store: KilnStore,
  filter?: { space?: string; afterIso?: string },
): {
  taskStats: TaskStatRecord[];
  roleModelBuckets: Map<
    string,
    {
      roster_role: string;
      agent: string;
      model: string;
      runs: number;
      passedRuns: number;
      escalations: number;
      cacheRates: number[];
      costs: number[];
    }
  >;
} {
  const pricing = store.readConfig("pricing");
  const allTasks = store.listTasks(filter?.space ? { space: filter.space } : undefined);
  const taskStats: TaskStatRecord[] = [];
  const roleModelBuckets = new Map<
    string,
    {
      roster_role: string;
      agent: string;
      model: string;
      runs: number;
      passedRuns: number;
      escalations: number;
      cacheRates: number[];
      costs: number[];
    }
  >();

  for (const row of allTasks) {
    if (row.status !== "done" && row.status !== "cancelled") {
      continue;
    }
    const card = readYamlOptional(store.paths.cardYaml(row.id), TaskCardSchema);
    if (!card) continue;
    const events = store.readStateEvents(row.id);
    const terminalEvent = [...events]
      .reverse()
      .find((e) => e.type === "done" || e.type === "cancelled");
    const finishedAt = terminalEvent?.at ?? card.updated_at;
    if (filter?.afterIso && finishedAt <= filter.afterIso) {
      continue;
    }

    const runsDir = store.paths.runsDir(card.id);
    const runDirs = fs.existsSync(runsDir)
      ? fs
          .readdirSync(runsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort()
      : [];

    const usageTurns = store.listUsageTurns({ taskId: card.id });
    const usageSnap = computeUsageSnapshot(usageTurns, pricing);
    const totalIn = usageSnap.inputTokens + usageSnap.cachedInputTokens;
    const taskCacheRate = totalIn > 0 ? usageSnap.cachedInputTokens / totalIn : 0;

    let implCount = 0;
    let reviewRejects = 0;
    let verifyFailures = 0;
    let acceptRan = false;
    let acceptCaughtDefect = false;
    let escalated = false;

    for (const dir of runDirs) {
      const meta = readYamlOptional(store.paths.runYaml(card.id, dir), RunMetaSchema);
      if (!meta) continue;
      if (meta.escalated_from) escalated = true;

      let runPassed = true;
      if (meta.stage === "implement") {
        implCount += 1;
        const gate = readYamlOptional(store.paths.gateYaml(card.id, dir), GateReportSchema);
        if (
          gate &&
          (!gate.schema_ok ||
            !gate.scope_ok ||
            gate.artifacts_ok === false ||
            gate.accept_exit_code !== 0)
        ) {
          runPassed = false;
          verifyFailures += 1;
        }
      } else if (meta.stage === "review") {
        const raw = readOptionalText(store.paths.receiptMd(card.id, dir));
        const parsed = raw ? parseAndValidateReceipt("reviewer", raw) : null;
        if (parsed?.ok && parsed.frontmatter.verdict === "changes_requested") {
          runPassed = false;
          reviewRejects += 1;
        }
      } else if (meta.stage === "accept") {
        acceptRan = true;
        const rep = readYamlOptional(
          store.paths.runAcceptReportYaml(card.id, dir),
          AcceptVerificationReportSchema,
        );
        if (rep && (!rep.gate_ok || rep.verdict !== "pass")) {
          runPassed = false;
          acceptCaughtDefect = true;
        }
      }

      const rosterKey = meta.roster_role ?? meta.role;
      const bucketKey = `${rosterKey}|${meta.agent}|${meta.model}`;
      let bucket = roleModelBuckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          roster_role: rosterKey,
          agent: meta.agent,
          model: meta.model,
          runs: 0,
          passedRuns: 0,
          escalations: 0,
          cacheRates: [],
          costs: [],
        };
        roleModelBuckets.set(bucketKey, bucket);
      }
      bucket.runs += 1;
      if (runPassed) bucket.passedRuns += 1;
      if (meta.escalated_from) bucket.escalations += 1;

      const runTurns = usageTurns.filter((u) => u.run_id === meta.run_id);
      if (runTurns.length > 0) {
        const runUsage = computeUsageSnapshot(runTurns, pricing);
        const rIn = runUsage.inputTokens + runUsage.cachedInputTokens;
        bucket.cacheRates.push(rIn > 0 ? runUsage.cachedInputTokens / rIn : 0);
        bucket.costs.push(runUsage.costUsd);
      }
    }

    const reworkRounds = Math.max(0, implCount - 1) + reviewRejects;
    const firstPass =
      row.status === "done" &&
      reworkRounds === 0 &&
      verifyFailures === 0 &&
      !acceptCaughtDefect &&
      !escalated;

    taskStats.push({
      taskId: card.id,
      space: card.space,
      preset: card.workflow?.preset ?? (card.track === "L1" ? "quick" : "standard_dev"),
      finishedAt,
      firstPass,
      reworkRounds,
      escalated,
      acceptRan,
      acceptCaughtDefect,
      cacheHitRate: taskCacheRate,
      costUsd: usageSnap.costUsd,
    });
  }

  return { taskStats, roleModelBuckets };
}

/**
 * 0-Token cross-task orchestration analytics across finished tasks.
 */
export function computeOrchestrationAnalytics(store: KilnStore): OrchestrationAnalytics {
  const { taskStats, roleModelBuckets } = collectFinishedTaskStats(store);

  const bySpaceMap = new Map<string, TaskStatRecord[]>();
  const byPresetMap = new Map<string, TaskStatRecord[]>();
  for (const st of taskStats) {
    if (!bySpaceMap.has(st.space)) bySpaceMap.set(st.space, []);
    bySpaceMap.get(st.space)!.push(st);
    if (!byPresetMap.has(st.preset)) byPresetMap.set(st.preset, []);
    byPresetMap.get(st.preset)!.push(st);
  }

  const by_space: SpaceEfficiencyStat[] = Array.from(bySpaceMap.entries()).map(
    ([spaceId, recs]) => ({
      space_id: spaceId,
      space_name: store.readSpace(spaceId)?.name ?? spaceId,
      metrics: summarizeMetricWindow(recs),
    }),
  );

  const by_workflow_preset: WorkflowPresetEfficiencyStat[] = Array.from(
    byPresetMap.entries(),
  ).map(([preset, recs]) => ({
    preset,
    metrics: summarizeMetricWindow(recs),
  }));

  const by_role_model: RoleModelEfficiencyStat[] = Array.from(
    roleModelBuckets.values(),
  )
    .map((b) => ({
      roster_role: b.roster_role,
      agent: b.agent,
      model: b.model,
      run_count: b.runs,
      pass_rate: Number((b.passedRuns / b.runs).toFixed(4)),
      escalation_rate: Number((b.escalations / b.runs).toFixed(4)),
      cache_hit_rate:
        b.cacheRates.length > 0
          ? Number(
              (b.cacheRates.reduce((a, v) => a + v, 0) / b.cacheRates.length).toFixed(4),
            )
          : 0,
      avg_cost_usd:
        b.costs.length > 0
          ? Number((b.costs.reduce((a, v) => a + v, 0) / b.costs.length).toFixed(4))
          : 0,
    }))
    .sort((a, b) => b.run_count - a.run_count);

  return {
    generated_at: new Date().toISOString(),
    overall: summarizeMetricWindow(taskStats),
    by_space,
    by_role_model,
    by_workflow_preset,
  };
}

/**
 * Generates data-driven orchestration & ledger hygiene proposals across finished tasks.
 */
export function generateAnalyticsProposals(store: KilnStore): ImprovementProposal[] {
  const candidates: CandidateProposalInput[] = [...analyzeLedgerHygiene(store)];
  const { taskStats } = collectFinishedTaskStats(store);

  // 1. Detect frequent fast_fix -> main_dev escalation across finished tasks
  const escalatedTasks = taskStats.filter((t) => t.escalated);
  const roster = store.readEffectiveRosterConfig();
  if (
    taskStats.length >= 3 &&
    escalatedTasks.length >= 2 &&
    escalatedTasks.length / taskStats.length >= 0.5 &&
    roster.pm_orchestration.plan_prefers_fast_exec !== false
  ) {
    candidates.push({
      source: "analytics",
      target_kind: "roster_policy",
      roster_role: "fast_fix",
      title: "降低快修槽位默认抢跑比例（高升档率优化）",
      rationale: `最近 ${taskStats.length} 个已完成任务中有 ${escalatedTasks.length} 个（${Math.round((escalatedTasks.length / taskStats.length) * 100)}%）触发了快修失败后升档至主力开发，建议关闭 plan_prefers_fast_exec，让含 PLAN 任务直接由主力开发一棒过。`,
      expected_impact: "减少快修试错返工轮次与重复门禁开销",
      evidence_task_ids: escalatedTasks.slice(0, 6).map((t) => t.taskId),
      payload: {
        pm_orchestration_patch: {
          plan_prefers_fast_exec: false,
        },
      },
    });
  }

  // 2. Detect spaces where quick preset suffers high rework -> suggest standard_dev default
  const bySpace = new Map<string, TaskStatRecord[]>();
  for (const st of taskStats) {
    if (!bySpace.has(st.space)) bySpace.set(st.space, []);
    bySpace.get(st.space)!.push(st);
  }
  for (const [spaceId, recs] of bySpace.entries()) {
    const quickRecs = recs.filter((r) => r.preset === "quick");
    if (quickRecs.length >= 3) {
      const avgRework =
        quickRecs.reduce((acc, r) => acc + r.reworkRounds, 0) / quickRecs.length;
      const spaceCfg = store.readSpace(spaceId);
      if (
        spaceCfg &&
        avgRework >= 1.5 &&
        spaceCfg.default_workflow_preset !== "standard_dev"
      ) {
        candidates.push({
          source: "analytics",
          target_kind: "space_default_workflow",
          space: spaceId,
          title: `将空间 ${spaceCfg.name} 默认蓝图提升为 standard_dev`,
          rationale: `该空间最近 ${quickRecs.length} 次走 quick 流程平均返工 ${avgRework.toFixed(1)} 轮，引入标准审查环可提前拦住回归。`,
          expected_impact: "提高一次通过率，降低后期返工成本",
          evidence_task_ids: quickRecs.slice(0, 5).map((r) => r.taskId),
          payload: {
            default_workflow_preset: "standard_dev",
          },
        });
      }
    }
  }

  if (candidates.length === 0) {
    return [];
  }
  return upsertImprovementProposals(store, candidates);
}

function appendPolicyChangeRecord(store: KilnStore, record: PolicyChangeRecord): void {
  ensureDir(store.paths.improvementsDir);
  const parsed = PolicyChangeRecordSchema.parse(record);
  const existing = fs.existsSync(store.paths.policyHistoryNdjson)
    ? fs.readFileSync(store.paths.policyHistoryNdjson, "utf8")
    : "";
  writeFileAtomic(
    store.paths.policyHistoryNdjson,
    `${existing}${JSON.stringify(parsed)}\n`,
  );
}

export function readPolicyHistory(store: KilnStore): PolicyChangeRecord[] {
  return readNdjsonValidated(store.paths.policyHistoryNdjson, PolicyChangeRecordSchema);
}

/**
 * Evaluates Before / After metric windows for every applied policy change and flags
 * negative optimizations (`regression_alert: true`) for one-click rollback.
 */
export function listPolicyHistoryWithEvaluation(
  store: KilnStore,
): PolicyChangeEvaluation[] {
  const history = readPolicyHistory(store);
  return history
    .map((rec) => {
      const { taskStats } = collectFinishedTaskStats(store, {
        ...(rec.space ? { space: rec.space } : {}),
        afterIso: rec.applied_at,
      });
      const afterMetrics = summarizeMetricWindow(taskStats);
      const reasons: string[] = [];
      if (!rec.rolled_back_at && afterMetrics.task_count >= 3 && rec.before_metrics.task_count > 0) {
        if (afterMetrics.first_pass_rate < rec.before_metrics.first_pass_rate - 0.15) {
          reasons.push(
            `一次通过率从 ${(rec.before_metrics.first_pass_rate * 100).toFixed(0)}% 降至 ${(afterMetrics.first_pass_rate * 100).toFixed(0)}%`,
          );
        }
        if (afterMetrics.avg_rework_rounds > rec.before_metrics.avg_rework_rounds + 0.5) {
          reasons.push(
            `平均返工从 ${rec.before_metrics.avg_rework_rounds.toFixed(1)} 增至 ${afterMetrics.avg_rework_rounds.toFixed(1)} 轮`,
          );
        }
        if (
          rec.before_metrics.median_cost_usd > 0 &&
          afterMetrics.median_cost_usd > rec.before_metrics.median_cost_usd * 1.3
        ) {
          reasons.push(
            `中位单卡费用上涨超过 30% ($${rec.before_metrics.median_cost_usd.toFixed(3)} -> $${afterMetrics.median_cost_usd.toFixed(3)})`,
          );
        }
      }
      return {
        ...rec,
        after_metrics: afterMetrics,
        regression_alert: reasons.length > 0,
        regression_reasons: reasons,
      };
    })
    .reverse();
}

/**
 * Approves a pending improvement proposal: validates anti-cheating guardrails,
 * snapshots target state & before-metrics, atomically mutates the target YAML,
 * and records an immutable policy change entry for Before/After comparison & rollback.
 */
export function approveImprovementProposal(
  store: KilnStore,
  proposalId: string,
): {
  proposal: ImprovementProposal;
  change: PolicyChangeRecord;
  updatedRoster: boolean;
} {
  const proposals = readImprovementProposals(store);
  const idx = proposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    throw new Error(`Improvement proposal "${proposalId}" not found`);
  }
  const proposal = proposals[idx]!;
  if (proposal.status !== "pending") {
    throw new Error(`Improvement proposal "${proposalId}" is already ${proposal.status}`);
  }
  assertProposalNotCheating(proposal);

  const now = new Date().toISOString();
  const { taskStats } = collectFinishedTaskStats(
    store,
    proposal.space ? { space: proposal.space } : undefined,
  );
  const beforeMetrics = summarizeMetricWindow(taskStats);

  let targetRef = "";
  let beforeSnapshot: unknown = null;
  let afterSnapshot: unknown = null;
  let updatedRoster = false;

  const ensureSpace = (spaceId: string): SpaceConfig => {
    const existing = store.readSpace(spaceId);
    if (!existing) {
      throw new Error(`Target space "${spaceId}" does not exist`);
    }
    return existing;
  };

  switch (proposal.target_kind) {
    case "space_ledger": {
      const spaceId = proposal.space ?? "local";
      const cur = store.readLedger(spaceId) ?? {
        schema_version: 1 as const,
        space: spaceId,
        entries: [],
      };
      beforeSnapshot = cur;
      targetRef = spaceId;
      const ruleText = String(proposal.payload.rule ?? proposal.title).trim();
      const newEntry: LedgerEntry = {
        id: `led-${randomUUID().slice(0, 8)}`,
        space: spaceId,
        rule: ruleText,
        source_task_id: proposal.evidence_task_ids[0] ?? "retro",
        created_at: now,
        ...(typeof proposal.payload.failure_mode === "string"
          ? { failure_mode: proposal.payload.failure_mode }
          : {}),
        ...(typeof proposal.payload.detection_signal === "string"
          ? { detection_signal: proposal.payload.detection_signal }
          : {}),
        ...(typeof proposal.payload.prevention_rule === "string"
          ? { prevention_rule: proposal.payload.prevention_rule }
          : {}),
        ...(Array.isArray(proposal.payload.scope_tags)
          ? { scope_tags: proposal.payload.scope_tags.map(String) }
          : {}),
        evidence_task_ids: proposal.evidence_task_ids,
        hit_count: 0,
        status: "active",
      };
      const next = LedgerFileSchema.parse({
        schema_version: 1,
        space: spaceId,
        entries: [...cur.entries, newEntry],
      });
      store.writeLedger(next);
      afterSnapshot = next;
      break;
    }

    case "space_ledger_merge": {
      const spaceId = proposal.space ?? "local";
      const cur = store.readLedger(spaceId);
      if (!cur) throw new Error(`Ledger for space "${spaceId}" does not exist`);
      beforeSnapshot = cur;
      targetRef = spaceId;
      const sourceIds = Array.isArray(proposal.payload.source_ids)
        ? proposal.payload.source_ids.map(String)
        : [];
      const mergedRule = String(proposal.payload.merged_rule ?? proposal.title).trim();
      const mergedFromEntries = cur.entries.filter((e) => sourceIds.includes(e.id));
      const totalHits = mergedFromEntries.reduce((acc, e) => acc + (e.hit_count ?? 0), 0);
      const filteredEntries = cur.entries.map((e) =>
        sourceIds.includes(e.id) ? { ...e, status: "archived" as const } : e,
      );
      const mergedEntry: LedgerEntry = {
        id: `led-${randomUUID().slice(0, 8)}`,
        space: spaceId,
        rule: mergedRule,
        source_task_id: mergedFromEntries[0]?.source_task_id ?? proposal.evidence_task_ids[0] ?? "retro",
        created_at: now,
        merged_from: sourceIds,
        evidence_task_ids: proposal.evidence_task_ids,
        hit_count: totalHits,
        status: "active",
      };
      const next = LedgerFileSchema.parse({
        schema_version: 1,
        space: spaceId,
        entries: [...filteredEntries, mergedEntry],
      });
      store.writeLedger(next);
      afterSnapshot = next;
      break;
    }

    case "space_ledger_archive": {
      const spaceId = proposal.space ?? "local";
      const cur = store.readLedger(spaceId);
      if (!cur) throw new Error(`Ledger for space "${spaceId}" does not exist`);
      beforeSnapshot = cur;
      targetRef = spaceId;
      const entryIds = new Set(
        Array.isArray(proposal.payload.entry_ids)
          ? proposal.payload.entry_ids.map(String)
          : [],
      );
      const next = LedgerFileSchema.parse({
        schema_version: 1,
        space: spaceId,
        entries: cur.entries.map((e) =>
          entryIds.has(e.id) ? { ...e, status: "archived" as const } : e,
        ),
      });
      store.writeLedger(next);
      afterSnapshot = next;
      break;
    }

    case "space_intake_checklist": {
      const spaceId = proposal.space;
      if (!spaceId) throw new Error("space_intake_checklist requires proposal.space");
      const cur = ensureSpace(spaceId);
      beforeSnapshot = cur;
      targetRef = spaceId;
      const items = Array.isArray(proposal.payload.items)
        ? proposal.payload.items.map(String).filter((s) => s.trim().length > 0)
        : typeof proposal.payload.item === "string"
          ? [proposal.payload.item.trim()]
          : [proposal.title];
      const merged = Array.from(new Set([...(cur.intake_checklist ?? []), ...items]));
      const next = SpaceConfigSchema.parse({ ...cur, intake_checklist: merged });
      store.writeSpace(next);
      afterSnapshot = next;
      break;
    }

    case "space_accept_scenario": {
      const spaceId = proposal.space;
      if (!spaceId) throw new Error("space_accept_scenario requires proposal.space");
      const cur = ensureSpace(spaceId);
      beforeSnapshot = cur;
      targetRef = spaceId;
      const items = Array.isArray(proposal.payload.scenarios)
        ? proposal.payload.scenarios.map(String).filter((s) => s.trim().length > 0)
        : typeof proposal.payload.scenario === "string"
          ? [proposal.payload.scenario.trim()]
          : [proposal.title];
      const merged = Array.from(new Set([...(cur.accept_scenarios ?? []), ...items]));
      const next = SpaceConfigSchema.parse({ ...cur, accept_scenarios: merged });
      store.writeSpace(next);
      afterSnapshot = next;
      break;
    }

    case "space_default_workflow": {
      const spaceId = proposal.space;
      if (!spaceId) throw new Error("space_default_workflow requires proposal.space");
      const cur = ensureSpace(spaceId);
      beforeSnapshot = cur;
      targetRef = spaceId;
      const preset = String(proposal.payload.default_workflow_preset ?? "standard_dev");
      const next = SpaceConfigSchema.parse({
        ...cur,
        default_workflow_preset: preset,
      });
      store.writeSpace(next);
      afterSnapshot = next;
      break;
    }

    case "roster_custom_instructions": {
      const roleId = proposal.roster_role ?? String(proposal.payload.roster_role ?? "reviewer");
      const cur = store.readEffectiveRosterConfig();
      const targetEntry = cur.roster[roleId];
      if (!targetEntry) throw new Error(`Roster role "${roleId}" not found`);
      beforeSnapshot = cur;
      targetRef = roleId;
      const extraNote = String(proposal.payload.instruction ?? proposal.rationale).trim();
      const combined = targetEntry.custom_instructions
        ? `${targetEntry.custom_instructions}\n- ${extraNote}`
        : `- ${extraNote}`;
      const next = RosterConfigSchema.parse({
        ...cur,
        roster: {
          ...cur.roster,
          [roleId]: {
            ...targetEntry,
            custom_instructions: combined.slice(0, 4000),
          },
        },
      });
      store.writeConfig("roster", next);
      afterSnapshot = next;
      updatedRoster = true;
      break;
    }

    case "roster_policy": {
      const cur = store.readEffectiveRosterConfig();
      beforeSnapshot = cur;
      targetRef = proposal.roster_role ?? "pm_orchestration";
      const pmPatch =
        proposal.payload.pm_orchestration_patch &&
        typeof proposal.payload.pm_orchestration_patch === "object"
          ? (proposal.payload.pm_orchestration_patch as Partial<RosterConfig["pm_orchestration"]>)
          : undefined;
      const next: RosterConfig = RosterConfigSchema.parse({
        ...cur,
        ...(pmPatch
          ? {
              pm_orchestration: {
                ...cur.pm_orchestration,
                ...(typeof pmPatch.plan_prefers_fast_exec === "boolean"
                  ? { plan_prefers_fast_exec: pmPatch.plan_prefers_fast_exec }
                  : {}),
                ...(typeof pmPatch.require_review_for_core === "boolean"
                  ? { require_review_for_core: pmPatch.require_review_for_core }
                  : {}),
                ...(typeof pmPatch.intake_auto_recon === "boolean"
                  ? { intake_auto_recon: pmPatch.intake_auto_recon }
                  : {}),
              },
            }
          : {}),
      });
      store.writeConfig("roster", next);
      afterSnapshot = next;
      updatedRoster = true;
      break;
    }
  }

  const change: PolicyChangeRecord = PolicyChangeRecordSchema.parse({
    schema_version: 1,
    id: `chg-${randomUUID().slice(0, 8)}`,
    proposal_id: proposal.id,
    target_kind: proposal.target_kind,
    target_ref: targetRef,
    ...(proposal.space !== undefined ? { space: proposal.space } : {}),
    summary: proposal.title,
    applied_at: now,
    before_snapshot: beforeSnapshot,
    after_snapshot: afterSnapshot,
    before_metrics: beforeMetrics,
  });
  appendPolicyChangeRecord(store, change);

  const updatedProposal: ImprovementProposal = ImprovementProposalSchema.parse({
    ...proposal,
    status: "approved",
    decided_at: now,
    policy_change_id: change.id,
  });
  const nextProposals = [...proposals];
  nextProposals[idx] = updatedProposal;
  writeImprovementProposals(store, nextProposals);

  return { proposal: updatedProposal, change, updatedRoster };
}

export function dismissImprovementProposal(
  store: KilnStore,
  proposalId: string,
): ImprovementProposal {
  const proposals = readImprovementProposals(store);
  const idx = proposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    throw new Error(`Improvement proposal "${proposalId}" not found`);
  }
  const cur = proposals[idx]!;
  if (cur.status !== "pending") {
    throw new Error(`Improvement proposal "${proposalId}" is already ${cur.status}`);
  }
  const updated = ImprovementProposalSchema.parse({
    ...cur,
    status: "dismissed",
    decided_at: new Date().toISOString(),
  });
  const next = [...proposals];
  next[idx] = updated;
  writeImprovementProposals(store, next);
  return updated;
}

/**
 * One-click rollback restoring the exact YAML snapshot captured prior to a policy change.
 */
export function rollbackPolicyChange(
  store: KilnStore,
  changeId: string,
): { change: PolicyChangeRecord; updatedRoster: boolean } {
  const history = readPolicyHistory(store);
  const idx = history.findIndex((r) => r.id === changeId);
  if (idx === -1) {
    throw new Error(`Policy change "${changeId}" not found`);
  }
  const rec = history[idx]!;
  if (rec.rolled_back_at) {
    throw new Error(`Policy change "${changeId}" has already been rolled back`);
  }

  let updatedRoster = false;
  switch (rec.target_kind) {
    case "space_ledger":
    case "space_ledger_merge":
    case "space_ledger_archive": {
      const parsed = LedgerFileSchema.parse(rec.before_snapshot);
      store.writeLedger(parsed);
      break;
    }
    case "space_intake_checklist":
    case "space_accept_scenario":
    case "space_default_workflow": {
      const parsed = SpaceConfigSchema.parse(rec.before_snapshot);
      store.writeSpace(parsed);
      break;
    }
    case "roster_custom_instructions":
    case "roster_policy": {
      const parsed = RosterConfigSchema.parse(rec.before_snapshot);
      store.writeConfig("roster", parsed);
      updatedRoster = true;
      break;
    }
  }

  const rolledBack = PolicyChangeRecordSchema.parse({
    ...rec,
    rolled_back_at: new Date().toISOString(),
  });
  const nextHistory = [...history];
  nextHistory[idx] = rolledBack;
  ensureDir(store.paths.improvementsDir);
  writeFileAtomic(
    store.paths.policyHistoryNdjson,
    `${nextHistory.map((item) => JSON.stringify(item)).join("\n")}\n`,
  );

  return { change: rolledBack, updatedRoster };
}
