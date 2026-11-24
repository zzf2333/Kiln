import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  AcceptVerificationReportSchema,
  GateReportSchema,
  RetroAttributionSchema,
  RunMetaSchema,
  TaskRetroReportSchema,
  parseAndValidateReceipt,
  type ImprovementProposal,
  type RetroAttribution,
  type RunEvent,
  type TaskRetroMetrics,
  type TaskRetroReport,
} from "@kiln/protocol";
import {
  KilnStore,
  deriveTaskStatus,
  readYamlOptional,
  writeFileAtomic,
  writeYamlAtomic,
} from "../store/index.js";
import type { BackendRegistry } from "../backend/registry.js";
import { resolveRosterStageAssignment } from "../scheduler/role-resolver.js";
import {
  assertProposalNotCheating,
  upsertImprovementProposals,
  type CandidateProposalInput,
} from "./improvements.js";
import { computeUsageSnapshot, readOptionalText } from "./pending-decisions.js";

function renderRetroMarkdown(report: TaskRetroReport): string {
  const m = report.metrics;
  const lines = [
    `# 任务复盘报告 · ${report.task_id}`,
    ``,
    `- **终态**: ${report.terminal_status} (${report.mode === "ai_enriched" ? "0-Token 扫描 + AI 深度归因" : "0-Token 事实提取"})`,
    `- **高信号判定**: ${report.high_signal ? `是 (${report.signals.join(", ")})` : "否（顺滑通过）"}`,
    `- **关键指标**: 执行轮次=${m.total_runs} · 返工=${m.rework_rounds} · 门禁重试=${m.retries_count} · 审查打回=${m.review_rejections} · 验收失败=${m.accept_failures} · 升档=${m.escalations_count} · Steer=${m.steer_count} · 缓存命中=${(m.cache_hit_rate * 100).toFixed(1)}% · 费用=$${m.total_cost_usd.toFixed(4)}`,
    ``,
    `## 核心结论`,
    report.summary,
    ``,
  ];

  if (report.attributions.length > 0) {
    lines.push(`## 5 维根因归因`);
    for (const attr of report.attributions) {
      lines.push(
        `- **[${attr.category}]** (最早可在 \`${attr.earliest_preventable_stage}\` 拦截)：${attr.summary} — 证据：${attr.evidence}`,
      );
    }
    lines.push(``);
  }

  if (report.proposal_ids.length > 0) {
    lines.push(`## 关联改进提案 (${report.proposal_ids.length})`);
    lines.push(`- 已入提案收件箱等待审批：${report.proposal_ids.join(", ")}`);
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Performs 0-Token deterministic post-task fact extraction across all persisted
 * runs, gates, acceptance reports, steering events, and usage turns.
 * Writes `RETRO.yaml` + `RETRO.md` atomically and enqueues high-signal improvement proposals.
 */
export function extractDeterministicTaskRetro(
  store: KilnStore,
  taskId: string,
): TaskRetroReport {
  const card = store.readTaskCard(taskId);
  const events = store.readStateEvents(taskId);
  const derived = deriveTaskStatus(card, events);
  const terminalStatus: "done" | "cancelled" =
    derived.status === "cancelled" ? "cancelled" : "done";

  const runsDir = store.paths.runsDir(taskId);
  const runDirs = fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort()
    : [];

  let implCount = 0;
  let retriesCount = 0;
  let reviewRejections = 0;
  let acceptFailures = 0;
  let escalationsCount = 0;
  const outOfScopeCounts = new Map<string, number>();
  const failedAcceptNotes: string[] = [];

  for (const dir of runDirs) {
    const meta = readYamlOptional(store.paths.runYaml(taskId, dir), RunMetaSchema);
    if (!meta) continue;
    if (meta.escalated_from) {
      escalationsCount += 1;
    }
    if (meta.stage === "implement") {
      implCount += 1;
    }
    if (meta.stage === "implement" || meta.stage === "verify") {
      const gate = readYamlOptional(store.paths.gateYaml(taskId, dir), GateReportSchema);
      if (
        gate &&
        (!gate.schema_ok ||
          !gate.scope_ok ||
          gate.artifacts_ok === false ||
          gate.accept_exit_code !== 0)
      ) {
        retriesCount += 1;
        for (const p of gate.out_of_scope_paths) {
          outOfScopeCounts.set(p, (outOfScopeCounts.get(p) ?? 0) + 1);
        }
      }
    } else if (meta.stage === "review") {
      const raw = readOptionalText(store.paths.receiptMd(taskId, dir));
      const parsed = raw ? parseAndValidateReceipt("reviewer", raw) : null;
      if (parsed?.ok && parsed.frontmatter.verdict === "changes_requested") {
        reviewRejections += 1;
      }
    } else if (meta.stage === "accept") {
      const rep = readYamlOptional(
        store.paths.runAcceptReportYaml(taskId, dir),
        AcceptVerificationReportSchema,
      );
      if (rep && (!rep.gate_ok || rep.verdict !== "pass")) {
        acceptFailures += 1;
        for (const sc of rep.scenarios) {
          if (sc.status === "fail") {
            failedAcceptNotes.push(`${sc.name}${sc.note ? `: ${sc.note}` : ""}`);
          }
        }
        for (const err of rep.rejection_reasons) {
          failedAcceptNotes.push(err);
        }
      }
    }
  }

  const trackEscalatedToL2 = events.some((e) => e.type === "track_escalated");
  const steerEvents = events.filter((e) => e.type === "steered");
  const steerCount = steerEvents.length;
  const contractUpdates = events.filter((e) => e.type === "contract_updated").length;

  const usageTurns = store.listUsageTurns({ taskId });
  const pricing = store.readConfig("pricing");
  const usageSnap = computeUsageSnapshot(usageTurns, pricing);
  const totalIn = usageSnap.inputTokens + usageSnap.cachedInputTokens;
  const cacheHitRate =
    totalIn > 0 ? Number((usageSnap.cachedInputTokens / totalIn).toFixed(4)) : 0;

  const reworkRounds = Math.max(0, implCount - 1) + reviewRejections;
  const firstPass =
    terminalStatus === "done" &&
    reworkRounds === 0 &&
    retriesCount === 0 &&
    acceptFailures === 0 &&
    escalationsCount === 0;

  const signals: string[] = [];
  if (retriesCount >= 2) signals.push(`retries=${retriesCount}`);
  if (escalationsCount >= 1) signals.push(`escalations=${escalationsCount}`);
  if (trackEscalatedToL2) signals.push("track_escalated_to_l2");
  if (reviewRejections >= 1) signals.push(`review_rejections=${reviewRejections}`);
  if (acceptFailures >= 1) signals.push(`accept_failures=${acceptFailures}`);
  if (steerCount >= 1) signals.push(`steered=${steerCount}`);
  if (contractUpdates >= 1) signals.push(`contract_updated=${contractUpdates}`);
  if (terminalStatus === "cancelled") signals.push("cancelled");

  const highSignal = signals.length > 0;

  const attributions: RetroAttribution[] = [];
  const candidateProposals: CandidateProposalInput[] = [];

  if (steerCount > 0 || contractUpdates > 0) {
    const steerMsgs = steerEvents
      .map((e) => (e.type === "steered" ? e.message : ""))
      .filter(Boolean)
      .slice(0, 3);
    attributions.push({
      category: "intake_contract",
      earliest_preventable_stage: "intake",
      summary: `任务运行中发生 ${steerCount} 次人工纠偏 / ${contractUpdates} 次契约变更，说明立项追问时遗漏了前置约束。`,
      evidence: steerMsgs.join("；") || `contract_updates=${contractUpdates}`,
    });
    if (card.space !== "local") {
      candidateProposals.push({
        source: "retro",
        target_kind: "space_intake_checklist",
        space: card.space,
        title: `立项核对补充：确认任务「${card.title}」相关边界条件`,
        rationale: `任务 ${card.id} 因中途纠偏/改契约产生额外返工（${steerMsgs.join("；") || "契约调整"}），将该检查项加入空间立项核对清单可前置防呆。`,
        expected_impact: "减少后期中断纠偏与契约重算造成的缓存失效",
        evidence_task_ids: [card.id],
        payload: {
          items: [
            steerMsgs[0]
              ? `立项前明确确认：${steerMsgs[0].slice(0, 120)}`
              : `立项前核查同类任务「${card.title}」的目标、边界与验收条件`,
          ],
        },
      });
    }
  }

  if (escalationsCount > 0) {
    attributions.push({
      category: "model_fit",
      earliest_preventable_stage: "plan",
      summary: `实施阶段触发 ${escalationsCount} 次模型升档，廉价槽位未能独立通过门禁。`,
      evidence: `retries=${retriesCount}, escalations=${escalationsCount}`,
    });
  }

  if (outOfScopeCounts.size > 0) {
    const topPaths = Array.from(outOfScopeCounts.keys()).slice(0, 4).join(", ");
    attributions.push({
      category: "space_rule",
      earliest_preventable_stage: "implement",
      summary: `执行期间改动越过 contract.scope，导致门禁拦截返工。`,
      evidence: `out_of_scope: ${topPaths}`,
    });
    candidateProposals.push({
      source: "retro",
      target_kind: "space_ledger",
      space: card.space,
      title: `规范约束：修改任务时禁止改动无关路径 (${topPaths})`,
      rationale: `任务 ${card.id} 在门禁阶段被检出越界路径 ${topPaths}，写入空间账本可在 Layer 1 提前提醒所有角色。`,
      expected_impact: "避免 scope_ok 门禁失败导致的无效返工轮次",
      evidence_task_ids: [card.id],
      payload: {
        rule: `严格限定改动范围，避免顺手修改未授权路径（历史踩坑参考：${topPaths}）`,
        failure_mode: "out_of_scope_edit",
        prevention_rule: `涉及 ${topPaths} 时必须在立项明确列入 scope`,
      },
    });
  }

  if (acceptFailures > 0) {
    const detail = failedAcceptNotes.slice(0, 3).join("；") || "真实验收未通过";
    attributions.push({
      category: "recon_plan",
      earliest_preventable_stage: "accept",
      summary: `真实验收阶段拦截了 ${acceptFailures} 次缺陷或假验收（${detail}）。`,
      evidence: detail,
    });
    if (card.space !== "local" && failedAcceptNotes.length > 0) {
      candidateProposals.push({
        source: "retro",
        target_kind: "space_accept_scenario",
        space: card.space,
        title: `常驻验收场景：回归核查 ${failedAcceptNotes[0]!.slice(0, 60)}`,
        rationale: `任务 ${card.id} 在真实验收阶段暴露出问题「${detail}」，建议固化为空间常驻验收场景以防回归。`,
        expected_impact: "后续所有变更自动复测该真实场景，避免同类线上问题复发",
        evidence_task_ids: [card.id],
        payload: {
          scenarios: [failedAcceptNotes[0]!],
        },
      });
    }
  }

  if (reviewRejections > 0 && attributions.length === 0) {
    attributions.push({
      category: "recon_plan",
      earliest_preventable_stage: "plan",
      summary: `独立审查打回 ${reviewRejections} 次，方案边界或实现完整性存在遗漏。`,
      evidence: `review_rejections=${reviewRejections}`,
    });
  }

  if (runDirs.length >= 3 && cacheHitRate < 0.2 && totalIn > 0) {
    attributions.push({
      category: "context_cache",
      earliest_preventable_stage: "implement",
      summary: `多轮执行下缓存命中率仅 ${(cacheHitRate * 100).toFixed(1)}%，热会话或前缀稳定度待优化。`,
      evidence: `runs=${runDirs.length}, cache_hit_rate=${(cacheHitRate * 100).toFixed(1)}%`,
    });
  }

  const metrics: TaskRetroMetrics = {
    total_runs: runDirs.length,
    rework_rounds: reworkRounds,
    retries_count: retriesCount,
    review_rejections: reviewRejections,
    accept_failures: acceptFailures,
    escalations_count: escalationsCount,
    track_escalated_to_l2: trackEscalatedToL2,
    steer_count: steerCount,
    contract_updates: contractUpdates,
    first_pass: firstPass,
    cache_hit_rate: cacheHitRate,
    total_cost_usd: Number(usageSnap.costUsd.toFixed(6)),
  };

  const savedProposals: ImprovementProposal[] =
    candidateProposals.length > 0
      ? upsertImprovementProposals(store, candidateProposals)
      : [];

  const existingRetro = readYamlOptional(store.paths.retroYaml(taskId), TaskRetroReportSchema);
  const summary = highSignal
    ? `检测到 ${signals.length} 个高信号事件（${signals.join("、")}），已完成结构化根因提取并生成 ${savedProposals.length} 条改进提案。`
    : `任务一次顺滑通过（${runDirs.length} 次执行，缓存命中 ${(cacheHitRate * 100).toFixed(1)}%），无需额外 AI 复盘。`;

  const report = TaskRetroReportSchema.parse({
    schema_version: 1,
    task_id: taskId,
    space: card.space,
    terminal_status: terminalStatus,
    mode: existingRetro?.mode === "ai_enriched" ? "ai_enriched" : "deterministic",
    high_signal: highSignal,
    signals,
    metrics,
    attributions:
      existingRetro?.mode === "ai_enriched" && existingRetro.attributions.length > 0
        ? existingRetro.attributions
        : attributions,
    summary:
      existingRetro?.mode === "ai_enriched" ? existingRetro.summary : summary,
    proposal_ids: Array.from(
      new Set([...(existingRetro?.proposal_ids ?? []), ...savedProposals.map((p) => p.id)]),
    ),
    generated_at: new Date().toISOString(),
    ...(existingRetro?.retro_run_id ? { retro_run_id: existingRetro.retro_run_id } : {}),
  });

  writeYamlAtomic(store.paths.retroYaml(taskId), report, TaskRetroReportSchema);
  writeFileAtomic(store.paths.retroMd(taskId), renderRetroMarkdown(report));
  return report;
}

function parseRetroJsonBlock(
  replyText: string,
): {
  summary?: string;
  attributions?: RetroAttribution[];
  proposals?: CandidateProposalInput[];
} | null {
  const match = /```kiln-retro-json\s*([\s\S]*?)```/i.exec(replyText);
  if (!match || !match[1]) {
    return null;
  }
  try {
    const raw = JSON.parse(match[1]) as {
      summary?: unknown;
      attributions?: unknown[];
      proposals?: unknown[];
    };
    const attributions: RetroAttribution[] = [];
    if (Array.isArray(raw.attributions)) {
      for (const item of raw.attributions) {
        const parsed = RetroAttributionSchema.safeParse(item);
        if (parsed.success) attributions.push(parsed.data);
      }
    }
    const proposals: CandidateProposalInput[] = [];
    if (Array.isArray(raw.proposals)) {
      for (const item of raw.proposals) {
        if (!item || typeof item !== "object") continue;
        const p = item as Record<string, unknown>;
        if (typeof p.target_kind !== "string" || typeof p.title !== "string") continue;
        const cand: CandidateProposalInput = {
          source: "retro",
          target_kind: p.target_kind as CandidateProposalInput["target_kind"],
          ...(typeof p.space === "string" ? { space: p.space } : {}),
          ...(typeof p.roster_role === "string" ? { roster_role: p.roster_role } : {}),
          title: p.title,
          rationale: typeof p.rationale === "string" ? p.rationale : p.title,
          expected_impact:
            typeof p.expected_impact === "string" ? p.expected_impact : "降低未来返工与成本",
          evidence_task_ids: Array.isArray(p.evidence_task_ids)
            ? p.evidence_task_ids.map(String)
            : [],
          payload:
            p.payload && typeof p.payload === "object"
              ? (p.payload as Record<string, unknown>)
              : {},
        };
        try {
          assertProposalNotCheating(cand);
          proposals.push(cand);
        } catch {
          // Skip cheating proposals fail-closed
        }
      }
    }
    return {
      ...(typeof raw.summary === "string" && raw.summary.trim().length > 0
        ? { summary: raw.summary.trim() }
        : {}),
      ...(attributions.length > 0 ? { attributions } : {}),
      ...(proposals.length > 0 ? { proposals } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Runs a strictly read-only, fresh-context AI post-mortem via the derived `retro`
 * slot (inheriting `advisor -> pm` when not overridden). Enriches `RETRO.yaml` + `RETRO.md`
 * and submits deduped proposals without mutating source trees or `state_events.ndjson`.
 */
export async function runAiTaskRetro(input: {
  store: KilnStore;
  backendRegistry: BackendRegistry;
  taskId: string;
}): Promise<TaskRetroReport> {
  const { store, backendRegistry, taskId } = input;
  const baseReport = extractDeterministicTaskRetro(store, taskId);
  const card = store.readTaskCard(taskId);
  const roster = store.readEffectiveRosterConfig();

  let effectiveAssignment: ReturnType<typeof resolveRosterStageAssignment> = null;
  try {
    effectiveAssignment = roster.roster.retro?.enabled
      ? resolveRosterStageAssignment(roster, "advise", "advisor", { rosterRoleId: "retro" })
      : resolveRosterStageAssignment(roster, "advise", "advisor") ??
        resolveRosterStageAssignment(roster, "intake", "intake");
  } catch {
    effectiveAssignment = null;
  }

  if (!effectiveAssignment) {
    return baseReport;
  }

  let backend =
    effectiveAssignment.backendId && backendRegistry.has(effectiveAssignment.backendId)
      ? backendRegistry.get(effectiveAssignment.backendId)
      : undefined;
  if (!backend) {
    for (const cand of backendRegistry.list()) {
      const agents = await cand.listAgents().catch(() => []);
      if (agents.some((a) => a.id === effectiveAssignment.agent)) {
        backend = cand;
        break;
      }
    }
  }
  if (!backend) {
    return baseReport;
  }

  const retroRunId = `retro-${taskId}-${randomUUID().slice(0, 6)}`;
  const prompt = [
    `# Kiln 只读任务复盘任务 (${taskId})`,
    `请严格只读分析下列任务事实，**禁止修改任何代码或 state_events.ndjson**，给出最深层根因与可执行改进建议（若无额外发现也可精炼摘要）。`,
    ``,
    `- 任务: ${card.title} (${card.id}) · 空间: ${card.space} · 轨道: ${card.track} · 终态: ${baseReport.terminal_status}`,
    `- 信号: ${baseReport.signals.join(", ") || "无明显异常"}`,
    `- 客观指标: ${JSON.stringify(baseReport.metrics)}`,
    `- 初筛归因: ${JSON.stringify(baseReport.attributions)}`,
    ``,
    `请输出简明中文分析，并在末尾可选附带一段严格 JSON 代码块 \`\`\`kiln-retro-json ... \`\`\`（包含 summary、attributions[] 与 proposals[]；严禁提议放宽 accept_cmd/scope/verify）。`,
  ].join("\n");

  const cwd = store.paths.taskDir(taskId);
  const sessionRef = await backend.start({
    runId: retroRunId,
    taskId,
    role: "advisor",
    agent: effectiveAssignment.agent,
    model: effectiveAssignment.model,
    ...(effectiveAssignment.reasoningEffort !== undefined
      ? { reasoningEffort: effectiveAssignment.reasoningEffort }
      : {}),
    cwd,
    prompt,
    freshContext: true,
    allowFullAccessFallback: effectiveAssignment.allowFullAccessFallback,
    readOnly: true,
  });

  const messages: string[] = [];
  const deltas: string[] = [];
  for await (const ev of backend.events(sessionRef) as AsyncIterable<RunEvent>) {
    if (ev.kind === "message") {
      if (ev.delta) deltas.push(ev.text);
      else if (ev.text.trim().length > 0) messages.push(ev.text);
    } else if (ev.kind === "exit") {
      break;
    }
  }

  const replyText = (deltas.length > 0 ? deltas.join("") : messages.join("\n")).trim();
  const parsedBlock = parseRetroJsonBlock(replyText);

  let extraProposals: ImprovementProposal[] = [];
  if (parsedBlock?.proposals && parsedBlock.proposals.length > 0) {
    const normalized = parsedBlock.proposals.map((p) => ({
      ...p,
      space: p.space ?? card.space,
      evidence_task_ids:
        p.evidence_task_ids.length > 0 ? p.evidence_task_ids : [card.id],
    }));
    extraProposals = upsertImprovementProposals(store, normalized);
  }

  const enriched = TaskRetroReportSchema.parse({
    ...baseReport,
    mode: "ai_enriched",
    retro_run_id: retroRunId,
    summary:
      parsedBlock?.summary ??
      (replyText.length > 0 ? replyText.replace(/```kiln-retro-json[\s\S]*?```/gi, "").trim().slice(0, 1200) : baseReport.summary),
    attributions:
      parsedBlock?.attributions && parsedBlock.attributions.length > 0
        ? parsedBlock.attributions
        : baseReport.attributions,
    proposal_ids: Array.from(
      new Set([...baseReport.proposal_ids, ...extraProposals.map((p) => p.id)]),
    ),
    generated_at: new Date().toISOString(),
  });

  writeYamlAtomic(store.paths.retroYaml(taskId), enriched, TaskRetroReportSchema);
  writeFileAtomic(store.paths.retroMd(taskId), renderRetroMarkdown(enriched));
  return enriched;
}
