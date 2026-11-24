import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  DecisionOptionSchema,
  PendingDecisionSchema,
  getImplementAgentMode,
  getVerifyGateCheckMode,
  parseFrontmatterMarkdown,
  serializeFrontmatterMarkdown,
  type AcceptEntryKind,
  type AcceptServiceStatus,
  type AdvisorRequest,
  type DecisionOption,
  type PendingDecision,
  type RoleId,
  type StageId,
  type StateEvent,
  type SteerNote,
  type TaskCard,
  type VerifierCapability,
} from "@kiln/protocol";
import type { KilnStore } from "../store/index.js";
import { selectActiveLedgerEntriesForHandoff } from "./improvements.js";
import { readOptionalText } from "./pending-decisions.js";

/**
 * Projects durable `steered` events from `state.ndjson` into UI/handoff `SteerNote[]`.
 */
export function extractActiveSteerNotes(
  events: readonly StateEvent[],
  contractVersion?: number,
): SteerNote[] {
  const notes: SteerNote[] = [];
  for (const ev of events) {
    if (ev.type !== "steered") {
      continue;
    }
    if (contractVersion !== undefined && ev.contract_version !== contractVersion) {
      continue;
    }
    notes.push({
      id: ev.steer_id,
      at: ev.at,
      message: ev.message,
      interrupt: ev.interrupt,
      contract_version: ev.contract_version,
      ...(ev.stage !== undefined ? { stage: ev.stage } : {}),
    });
  }
  return notes;
}

export function extractSection(markdownBody: string, heading: string): string {
  const pattern = new RegExp(`^#{1,3}[ \\t]+${heading}(?:[ \\t:(（][^\\r\\n]*)?(?=\\r?\\n|$)`, "m");
  const match = pattern.exec(markdownBody);
  if (!match) return "";
  const after = markdownBody.slice(match.index + match[0].length);
  const next = /^#{1,3}[ \t]+/m.exec(after);
  return (next ? after.slice(0, next.index) : after).trim();
}

export function buildReceiptTemplateSection(params: {
  role: RoleId;
  workspaceMode: TaskCard["workspace_mode"];
}): string {
  const { role, workspaceMode } = params;
  const fallbackRef = workspaceMode === "git_worktree" ? "HEAD" : workspaceMode;
  const staticRunIdPlaceholder = "<REPLACE_WITH_RUN_ID>";
  const staticInputRefPlaceholder = workspaceMode === "git_worktree" ? "HEAD" : fallbackRef;

  let templateMarkdown: string;
  let fieldNotes: string[];

  switch (role) {
    case "worker": {
      templateMarkdown = serializeFrontmatterMarkdown(
        {
          run_id: staticRunIdPlaceholder,
          contract_version: 1,
          outcome: "completed",
          input_ref: staticInputRefPlaceholder,
          output_ref: "<产物路径或提交Hash>",
          changed_paths: ["<改动文件相对路径>"],
          accept_result: "pass",
          is_bugfix: false,
          complexity_escalate: false,
        },
        [
          "## 改动说明",
          "<简要说明本次修改内容>",
          "",
          "## 验证命令与真实输出",
          "<粘贴真实执行的验收命令与输出摘要>",
          "",
          "## 未完成或待决问题",
          "无",
          "",
        ].join("\n"),
      );
      fieldNotes = [
        "- `run_id` / `contract_version`: 提交时务必替换为末尾「本轮执行指令」给出的真实值",
        "- `outcome`: 仅允许 `completed` | `need_decision`",
        "- `accept_result`: 仅允许 `pass` | `fail` | `skipped`",
        "- `changed_paths`: 字符串数组（相对路径，或 `host_scoped` 下的绝对白名单路径）",
        "- `is_bugfix`: 布尔值；若为 `true`，必须额外包含非空的 `## 修前复现证据` 二级标题章节",
      ];
      break;
    }
    case "reviewer": {
      templateMarkdown = serializeFrontmatterMarkdown(
        {
          run_id: staticRunIdPlaceholder,
          contract_version: 1,
          reviewed_ref: staticInputRefPlaceholder,
          verdict: "pass",
          p0: 0,
          p1: 0,
          p2: 0,
        },
        [
          "## 结论",
          "<审查总结与放行/退回结论>",
          "",
          "## 缺陷清单",
          "无",
          "",
          "## 测试真实性与复现核查",
          "<核查验收命令与测试是否真实有效>",
          "",
        ].join("\n"),
      );
      fieldNotes = [
        "- `run_id` / `contract_version`: 提交时务必替换为末尾「本轮执行指令」给出的真实值",
        "- `verdict`: 仅允许 `pass` | `changes_requested`",
        "- **重要**：`p0`、`p1`、`p2` 必须为非负整数（如 `0`、`1`），**绝不能写成数组 `[]`**；具体问题明细请写在 `## 缺陷清单` 正文中",
        '- 可选结构化字段 `findings`: 数组项 `{ severity: "P0"|"P1"|"P2", title, location?, detail? }`（仍须保留整型 `p0/p1/p2` 与正文 `## 缺陷清单`）',
        "- `reviewed_ref`: 被审查的提交 Hash 或工作区产物引用（非空字符串）",
      ];
      break;
    }
    case "verifier": {
      templateMarkdown = serializeFrontmatterMarkdown(
        {
          run_id: staticRunIdPlaceholder,
          contract_version: 1,
          verified_ref: staticInputRefPlaceholder,
          verdict: "pass",
          entry_mode: "browser",
          passed_scenarios: 1,
          failed_scenarios: 0,
          console_errors_count: 0,
          evidence_files: ["evidence/scenario-1.png"],
          scenarios: [
            {
              name: "主流程真实操作验收",
              status: "pass",
              note: "<简述实际触发的动作与页面/终端反馈>",
              evidence_files: ["evidence/scenario-1.png"],
            },
          ],
        },
        [
          "## 验收场景明细",
          "- 场景 1：<逐项记录真实输入、动作、观测到的状态变更与视觉/终端结果>",
          "",
        ].join("\n"),
      );
      fieldNotes = [
        "- `run_id` / `contract_version`: 提交时务必替换为末尾「本轮执行指令」给出的真实值",
        "- `verdict`: 仅允许 `pass` | `fail`（与 `failed_scenarios > 0` 或任意失败场景互斥）",
        "- `entry_mode`: 推荐明确声明 `browser` | `desktop_gui` | `cli` | `artifact`",
        "- `passed_scenarios`、`failed_scenarios`: 必须为非负整数",
        "- `evidence_files` / `scenarios`: 列出真实生成的截图与日志相对路径（必须落盘于本轮 `evidence/` 目录且真实非空；严禁伪造扩展名或跨目录路径）",
        "- `verified_ref`: 被验收对象引用（非空字符串）",
      ];
      break;
    }
    case "triage": {
      templateMarkdown = serializeFrontmatterMarkdown(
        {
          run_id: staticRunIdPlaceholder,
          contract_version: 1,
          recommendation: "retry",
          summary: "<一句异常研判摘要>",
        },
        [
          "## 异常事实",
          "<列出观察到的错误日志、状态与失败证据>",
          "",
          "## 研判结论",
          "<给出根因判断与推荐动作>",
          "",
        ].join("\n"),
      );
      fieldNotes = [
        "- `run_id` / `contract_version`: 提交时务必替换为末尾「本轮执行指令」给出的真实值",
        "- `recommendation`: 仅允许 `retry` | `escalate_advisor` | `ask_human`",
        "- `summary`: 非空字符串摘要",
      ];
      break;
    }
    case "advisor": {
      templateMarkdown = serializeFrontmatterMarkdown(
        {
          run_id: staticRunIdPlaceholder,
          contract_version: 1,
          outcome: "resolved",
          chosen_approach: "<选定技术方案>",
        },
        [
          "## 技术取舍",
          "<说明备选方案对比与选型依据>",
          "",
          "## 授权裁决",
          "<明确后续实施方向与边界>",
          "",
        ].join("\n"),
      );
      fieldNotes = [
        "- `run_id` / `contract_version`: 提交时务必替换为末尾「本轮执行指令」给出的真实值",
        "- `outcome`: 仅允许 `resolved` | `need_decision`",
        "- `chosen_approach`: 非空字符串",
        "- `decision_kind` / `target_stage`: 可选；`target_stage` 仅限 `implement` | `review`",
        "- `requires_contract_change` / `requires_scope_expansion` / `requires_human_approval`: 布尔值（默认 `false`；任一为 `true` 将触发内核护栏转交人类批准）",
      ];
      break;
    }
    default:
      return "";
  }

  return [
    `## 阶段回执格式要求`,
    `请严格按以下 \`${role}\` 角色模板提交回执（YAML frontmatter 与必需二级标题缺一不可；格式校验失败将返回 \`400 invalid_receipt\` 且不会消耗当前阶段租约，可按报错修正后同回合重提）：`,
    ...fieldNotes,
    ``,
    "```markdown",
    templateMarkdown.trimEnd(),
    "```",
  ].join("\n");
}

export interface HandoffPayload {
  stablePrefix: string;
  dynamicTail: string;
  fullMarkdown: string;
}

export interface AcceptEnvHandoffContext {
  entryKind: AcceptEntryKind;
  requiredCapability?: VerifierCapability;
  primaryUrl?: string;
  services?: AcceptServiceStatus[];
  observeHttp?: boolean;
  entryHint?: string;
  evidenceDir: string;
}

export interface BuildHandoffParams {
  store: KilnStore;
  card: TaskCard;
  runId: string;
  runDirName: string;
  stage: StageId;
  round: number;
  role: RoleId;
  cwd: string;
  inputRef?: string;
  mcpEnabled: boolean;
  advisorReq?: AdvisorRequest | null;
  rosterRoleId?: string;
  stepLabel?: string;
  customInstructions?: string;
  escalatedFrom?: string;
  escalatedDiffStat?: string;
  deliverConflictNote?: string;
  previousFailureSummary?: string | null;
  previousReviewSummary?: string | null;
  previousAcceptSummary?: string | null;
  acceptEnvContext?: AcceptEnvHandoffContext | null;
}

function buildLayer0WorkspaceSafetyNote(card: TaskCard, role: RoleId, stage: StageId): string {
  const isReadOnlyStageOrRole =
    role !== "worker" ||
    stage === "plan" ||
    stage === "research" ||
    stage === "review" ||
    stage === "triage" ||
    stage === "advise" ||
    stage === "accept";
  if (isReadOnlyStageOrRole) {
    return `当前为严格只读核查模式：工作区位于下文指定路径，严禁修改源码、写暂存文件或执行 git commit、git merge 或 git push。`;
  }

  const isHostTwoPhase =
    card.workspace_mode === "host_scoped" &&
    (getImplementAgentMode(card) === "dry_run_only" ||
      getVerifyGateCheckMode(card) === "staged_only");

  if (isHostTwoPhase) {
    return `当前为 host_op 两阶段确定性执行（Phase 1 · dry_run_only）：只能把待写入/待执行的脚本、配置文件等产物放入下文指定沙盒暂存目录 staged/，并在回执 changed_paths 中列出对应的宿主机目标绝对路径，严禁直接修改宿主机目标或运行直接改动宿主机的正式命令！Phase 1 门禁采用 staged_only（不会预先运行宿主机正式 accept_cmd），完成暂存与 dry-run 自检后请直接提交 outcome: completed（accept_result 可填 skipped 或 pass），严禁提出 action: return_external。后续落盘审批、交付命令执行与最终 accept_cmd 验真将由 Kiln 内核在 deliver 阶段原子完成。`;
  }
  if (card.workspace_mode === "host_scoped") {
    return `当前为 host_scoped 模式：只能把待写文件写入下文指定沙盒暂存目录 staged/，并在回执 changed_paths 中列出对应的宿主机目标绝对路径，严禁直接修改宿主机目标文件！提交 outcome: completed 后将由 Kiln 内核向用户发起落盘审批并原子写入，严禁使用或提出 action: return_external。`;
  }
  if (card.workspace_mode === "git_worktree") {
    return `当前为 git_worktree 模式：你只需编辑下文指定工作区内 scope 允许的文件并运行验收命令，严禁在受限沙箱里执行 git commit、git merge 或 git push；通过门禁后将由 kilnd 内核统一提交并合入。`;
  }
  return `当前为 scratch_dir 模式：仅可在下文指定的独立产物目录内写入产物并如实在 changed_paths 中声明相对路径。`;
}

function buildStageCognitiveDirective(params: {
  stage: StageId;
  card: TaskCard;
  cwd: string;
  rosterRoleId?: string;
  hasResearchDoc?: boolean;
}): string {
  const { stage, card, cwd, rosterRoleId, hasResearchDoc } = params;
  if (stage === "research") {
    return [
      `### 阶段认知与自由度模式 · 前置调研阶段 (research · advisor) · 高密度代码地图`,
      `- 当前正在只读分析目标工作区 ${cwd} 与《产品方案》(BRIEF.md)。`,
      `- 鼓励广度查证代码现状、调用链、依赖边界与风险前提，**只报告客观事实与精确文件/符号索引，不拍板产品或最终架构方案**，严禁直接修改源码或暂存文件。`,
      `- 请在回执正文按固定 4 段结构输出高密度调研结论（供下游方案/PM 直接使用）：`,
      `  1. \`## 项目环境与运行基线\``,
      `  2. \`## 相关文件与精确符号\`（文件路径 + 符号/行号 + 一句话职责）`,
      `  3. \`## 现有调用链与不变量\``,
      `  4. \`## 已核查风险与可用验收命令\``,
      `- 完成后提交 advisor 角色回执（outcome: resolved）；若必须改契约/扩 scope/人类审批，请在 frontmatter 置位 requires_* 字段或提交 outcome: need_decision。`,
    ].join("\n");
  }
  if (stage === "plan") {
    const planGranularityNote =
      card.track === "L1"
        ? `- 当前为 L1 轻量任务：直接收敛给出唯一清晰、可执行的实施方案即可，不要无故发散多套重方案。`
        : `- 当前为 ${card.track} 复杂任务：严守立项阶段已确认的产品方向（不得推翻 BRIEF）；请先在内部技术层面对比 **2–3 条可行实现路线** 的利弊与风险，再收敛为唯一可执行的 \`PLAN.md\`，并明确写出**前置验收场景**与 **\`Re-plan if\` 停手重规划条件**。`;
    const reconReuseNote = hasResearchDoc
      ? `- **上游已提供 \`RESEARCH.md\` 代码地图**：请先以调研结论为事实底图做架构权衡与方案设计，仅对关键不变量或存疑文件做定点核查，避免重复全仓 grep 扫描。`
      : "";
    return [
      `### 阶段认知与自由度模式：方案设计模式（plan · 只读）`,
      `- 当前正在只读分析目标工作区 ${cwd}、BRIEF.md 与调研结论。`,
      ...(reconReuseNote ? [reconReuseNote] : []),
      planGranularityNote,
      `- 严禁直接修改源码或暂存文件；完成后提交 advisor 角色回执（outcome: resolved）；若必须改契约/扩 scope/人类审批，请在 frontmatter 置位 requires_* 字段或提交 outcome: need_decision。`,
    ].join("\n");
  }
  if (stage === "advise") {
    return `### 阶段认知与自由度模式：顾问裁决模式（advise · 只读）\n- 当前正在只读分析目标工作区 ${cwd}、产品方案、历史裁决与触发上下文。\n- 严禁直接修改源码或暂存文件；严禁擅自更改交付目标、扩大 contract.scope 或越过人类红线。\n- 请在已授权契约内给出明确可执行的单一选型建议并提交 outcome: resolved（可通过 target_stage 指定回到 implement 或 review）；若判定必须修改契约（requires_contract_change: true）、扩大 scope（requires_scope_expansion: true）或需人类批准红线副作用（requires_human_approval: true），请如实在 frontmatter 标明或提交 outcome: need_decision，由内核转交本人拍板。`;
  }
  if (stage === "verify") {
    return `### 阶段认知与自由度模式：独立测试增强（verify · ${rosterRoleId ?? "tester"}）\n- 工作区位于 ${cwd}。请聚焦补充或核查测试覆盖与边界用例，严禁改动 contract.scope 之外文件、严禁篡改冻结测试文件、严禁跳过真实验证。\n- 完成后提交 worker 角色回执，Kiln 内核仍将统一重跑确定性验收门禁（accept_cmd）与范围/冻结校验。`;
  }
  if (stage === "deliver") {
    return `### 阶段认知与自由度模式：合并交付准备（deliver · ${rosterRoleId ?? "deliverer"}）\n- 工作区位于 ${cwd}。你仅可在隔离工作树内完成提交整理或合并前冲突预检，严禁在工作树内执行 git push 或修改主仓库。\n- 完成后提交 worker 角色回执，最终合并、审批与交付落盘由 Kiln 内核确定性执行。`;
  }
  if (stage === "review") {
    return `### 阶段认知与自由度模式：独立对抗审查（review · 只读冷隔离）\n- 请从独立挑刺视角审查改动是否严格满足 BRIEF 与交付契约、是否存在隐蔽边界缺陷/并发竞态以及测试是否真实有效。\n- 严禁修改工作区文件，提交 reviewer 角色回执。`;
  }
  if (stage === "accept") {
    return `### 阶段认知与自由度模式：真实用户黑盒验收（accept · 只读黑盒）\n- 请从真实用户入口严格按 BRIEF 场景与边界逐项验证交付产物与体验，严禁修改源码，提交 verifier 角色回执。`;
  }
  if (stage === "triage") {
    return `### 阶段认知与自由度模式：异常研判（triage · 只读）\n- 请基于失败事实与磁盘日志判定根因并给出 retry / escalate_advisor / ask_human 建议，严禁修改工作区文件，提交 triage 角色回执。`;
  }
  return `### 阶段认知与自由度模式：严格收敛执行（implement）\n- 请严格遵循定稿方案与交付契约做最小完整落地，严禁越过 \`contract.scope\` 或自行扩大需求边界；若触发方案中的 \`Re-plan if\` 条件或发现不可逾越前提，请立即通过 \`need_decision\` 上报而非盲目强改。`;
}

/**
 * Builds a prefix-cache-friendly 4-layer HANDOFF payload:
 * Layer 0 (cross-task static safety + static receipt schema)
 * -> Layer 1 (space ledger)
 * -> Layer 2 (task-frozen contract, paths, stage-projected artifacts, attachments, append-only decisions)
 * -> Dynamic Boundary -> Layer 3 (per-run metadata, stage cognitive directive, failure/review deltas, steer).
 */
export function buildHandoffPayload(params: BuildHandoffParams): HandoffPayload {
  const {
    store,
    card,
    runId,
    runDirName,
    stage,
    round,
    role,
    cwd,
    inputRef,
    mcpEnabled,
    advisorReq,
    rosterRoleId,
    stepLabel,
    customInstructions,
    escalatedFrom,
    escalatedDiffStat,
    deliverConflictNote,
    previousFailureSummary,
    previousReviewSummary,
    previousAcceptSummary,
    acceptEnvContext,
  } = params;

  const brief = readOptionalText(store.paths.briefMd(card.id)) ?? "";
  const researchDoc =
    stage !== "research" ? (readOptionalText(store.paths.researchMd(card.id)) ?? "") : "";
  const planDoc =
    stage !== "plan" && stage !== "research"
      ? (readOptionalText(store.paths.planMd(card.id)) ?? "")
      : "";
  const decisions = readOptionalText(store.paths.decisionsMd(card.id)) ?? "";
  const ledger = store.readLedger(card.space);
  const activeLedgerEntries = ledger ? selectActiveLedgerEntriesForHandoff(ledger.entries) : [];
  const ledgerText =
    activeLedgerEntries.length > 0
      ? activeLedgerEntries.map((e) => `- ${e.rule}`).join("\n")
      : "(无)";

  const steerNotes = extractActiveSteerNotes(store.readStateEvents(card.id), card.contract_version);

  const advisorRoutingHint =
    role === "worker" || role === "reviewer"
      ? `- 若遇到纯技术选型、架构/数据结构取舍或界面排版歧义（不改变产品目标、外部行为、\`contract.scope\` 与人类红线），请将 \`category\` 设为 \`technical_ambiguity\`（或 \`design_tradeoff\` / \`layout_ambiguity\`），内核将优先交由技术顾问决策；若涉及改需求目标、扩范围或高风险外部动作，请使用对应人类审批类别直接交由用户拍板。`
      : "";

  // Layer 0: cross-task static protocol & receipt schema (zero per-task/per-run volatile fields)
  const genericProtocolNote = mcpEnabled
    ? [
        `请使用 kiln-mcp 工具（wb_get_context / wb_read_ledger / wb_submit_receipt / wb_ask_decision）提交阶段产物。`,
        ...(advisorRoutingHint ? [advisorRoutingHint] : []),
      ].join("\n")
    : [
        `当前执行环境未注入 MCP，请严格遵守文件降级协议：`,
        `- 将阶段回执写入下文「本轮执行指令」指定的 RECEIPT.md 路径。`,
        `- 若遇到阻塞需要裁决，请在回执 frontmatter 填写 outcome: need_decision、category、question 与 options，并在正文 "## 未完成或待决问题" 写明详情。`,
        ...(advisorRoutingHint ? [advisorRoutingHint] : []),
      ].join("\n");

  const receiptTemplateSection = buildReceiptTemplateSection({
    role,
    workspaceMode: card.workspace_mode,
  });

  const sortedAttachments = [...(card.attachments ?? [])].sort((a, b) =>
    a.rel_path.localeCompare(b.rel_path),
  );

  // Stage context projection (progressive disclosure against Context Rot)
  const artifactSections: string[] = [];
  if (brief) {
    artifactSections.push(`## 立项说明 (BRIEF)\n${brief}`);
  }
  if (researchDoc) {
    if (stage === "implement" && planDoc.trim().length > 0) {
      artifactSections.push(
        `## 调研结论 (RESEARCH.md 指针)\n- 调研结论已收敛至下方 \`PLAN.md\`，如需核查原始代码地图请按需读取：${store.paths.researchMd(card.id)}`,
      );
    } else if (stage !== "accept") {
      artifactSections.push(`## 调研结论 (RESEARCH.md)\n${researchDoc}`);
    }
  }
  if (planDoc) {
    if (stage === "accept") {
      artifactSections.push(
        `## 技术实施方案 (PLAN.md 指针)\n- 真实验收应保持用户视角黑盒核查；如需对照方案详情可按需读取：${store.paths.planMd(card.id)}`,
      );
    } else {
      artifactSections.push(`## 技术实施方案 (PLAN.md)\n${planDoc}`);
    }
  }

  const workspacePathLine =
    card.workspace_mode === "host_scoped"
      ? `- 沙盒暂存目录 (stagedDir): ${store.paths.stagedDir(card.id)}`
      : `- 工作区路径 (cwd): ${cwd}`;

  const stablePrefix = [
    `## 安全与协议要求`,
    buildLayer0WorkspaceSafetyNote(card, role, stage),
    genericProtocolNote,
    ...(customInstructions && customInstructions.trim().length > 0
      ? [``, `## 槽位专属指令 (${stepLabel ?? rosterRoleId ?? role})`, customInstructions.trim()]
      : stepLabel && stepLabel.trim().length > 0
        ? [``, `## 当前步骤 (${stepLabel.trim()})`]
        : []),
    ``,
    ...(receiptTemplateSection ? [receiptTemplateSection, ``] : []),
    `## 空间决策账本 (${card.space})`,
    ledgerText,
    ``,
    `## 交付契约`,
    `- task_id: ${card.id}`,
    `- contract_version: ${card.contract_version}`,
    `- workspace_mode: ${card.workspace_mode}`,
    workspacePathLine,
    `- 目标: ${card.contract.goal}`,
    `- 终点: ${card.contract.end}`,
    `- 验收命令: \`${card.contract.accept_cmd}\``,
    `- 可改范围: ${card.contract.scope.join(", ")}`,
    ``,
    ...(artifactSections.length > 0 ? [...artifactSections, ``] : []),
    ...(sortedAttachments.length > 0
      ? [
          `## 任务附件 (${sortedAttachments.length})`,
          ...sortedAttachments.map((att) => {
            const diskName = path.posix.basename(att.rel_path.replace(/\\/g, "/"));
            return `- ${att.filename} (${att.mime_type}) -> ${store.paths.taskAttachmentFile(card.id, diskName)}`;
          }),
          ``,
        ]
      : []),
    ...(decisions ? [`## 历史裁决 (decisions)`, decisions, ``] : []),
  ].join("\n");

  const advisorContextSection = advisorReq
    ? [
        `## 触发顾问的待决与异常上下文`,
        `- 触发原因: ${advisorReq.trigger} (${advisorReq.reason})`,
        `- 来源阶段: ${advisorReq.source_stage}${advisorReq.source_role ? ` · ${advisorReq.source_role}` : ""} (${advisorReq.source_run_id})`,
        `- 问题类别: ${advisorReq.category}`,
        ...(advisorReq.failure_fingerprint
          ? [
              `- 连续同错指纹: ${advisorReq.failure_fingerprint}（连续 ${advisorReq.consecutive_failures ?? 1} 次）`,
            ]
          : []),
        `- 问题描述: ${advisorReq.question}`,
        ...(advisorReq.options.length > 0
          ? [
              `- 原候选选项:\n${advisorReq.options
                .map((o) => `  - [${o.id}] ${o.label} (action=${o.action})`)
                .join("\n")}`,
            ]
          : []),
      ].join("\n")
    : "";

  const steerSection =
    steerNotes.length > 0
      ? [
          `## 运行中补充纠偏指令（Steer，未变更契约）`,
          `以下为用户在任务执行期间补充的纠偏提示，请在不违反 \`contract.scope\`、验收命令与人类红线的前提下优先遵循：`,
          ...steerNotes.map((n) => `- [${n.at}${n.interrupt ? " · 已中断重跑" : ""}] ${n.message}`),
        ].join("\n")
      : "";

  const failureDeltaSection =
    previousFailureSummary && previousFailureSummary.trim().length > 0
      ? [`## 上轮门禁失败摘要`, previousFailureSummary.trim()].join("\n")
      : "";

  const reviewDeltaSection =
    previousReviewSummary && previousReviewSummary.trim().length > 0
      ? [`## 上轮审查退回摘要`, previousReviewSummary.trim()].join("\n")
      : "";

  const acceptDeltaSection =
    previousAcceptSummary && previousAcceptSummary.trim().length > 0
      ? [`## 上轮真实验收失败现场`, previousAcceptSummary.trim()].join("\n")
      : "";

  const spaceAcceptScenarios =
    stage === "accept" ? (store.readSpace(card.space)?.accept_scenarios ?? []) : [];
  const spaceAcceptScenariosSection =
    stage === "accept" && spaceAcceptScenarios.length > 0
      ? [
          `## 空间常驻验收场景（历史复盘防回归，必须逐一核查）`,
          ...spaceAcceptScenarios.map((sc, idx) => `- 回归场景 ${idx + 1}: ${sc}`),
        ].join("\n")
      : "";

  const acceptEnvSection =
    stage === "accept" && acceptEnvContext
      ? [
          `## 被测环境与防假验收要求 (${acceptEnvContext.entryKind})`,
          `- 证据落盘目录 (evidenceDir): \`${acceptEnvContext.evidenceDir}\`（请将截图等真实产物保存在此目录，并在回执中使用 \`evidence/<文件名>\` 相对路径声明）`,
          ...(acceptEnvContext.requiredCapability
            ? [`- 要求验收能力: \`${acceptEnvContext.requiredCapability}\``]
            : []),
          ...(acceptEnvContext.primaryUrl
            ? [`- 主被测访问地址 (accept_url): ${acceptEnvContext.primaryUrl}`]
            : []),
          ...(acceptEnvContext.entryHint ? [`- 入口提示: ${acceptEnvContext.entryHint}`] : []),
          ...(acceptEnvContext.services && acceptEnvContext.services.length > 0
            ? [
                `- 已拉起被测服务：`,
                ...acceptEnvContext.services.map(
                  (svc) =>
                    `  - \`${svc.name}\` [${svc.status}]${svc.url ? ` → ${svc.url}` : svc.port ? ` (port ${svc.port})` : ""}${svc.log_file ? ` · log: ${svc.log_file}` : ""}`,
                ),
              ]
            : []),
          ...(acceptEnvContext.observeHttp
            ? [
                `- **透明流量观测已开启**：内核通过上方代理地址观测真实 HTTP/WS 请求；若报告 \`pass\` 但未产生任何真实请求或缺少真实视觉截图，门禁将直接拦截。`,
              ]
            : []),
          `- **严格只读红线**：严禁修改被测仓库源码；若发现功能/界面缺陷，请如实提交 \`verdict: fail\` 并附失败场景与证据路径交回下游修复。`,
        ].join("\n")
      : "";

  const escalationDeltaSection = escalatedFrom
    ? [
        `## 模型升档接盘摘要 (由 ${escalatedFrom} 升档至 ${rosterRoleId ?? role})`,
        `- 上游便宜/快修槽位 \`${escalatedFrom}\` 触发了确定性升档条件，现已强制冷启并切至当前主力槽位接盘。`,
        `- 请先核查下方已有改动与门禁报错；正确部分可直接沿用，若发现思路偏差请果断局部推翻重构。`,
        ...(escalatedDiffStat && escalatedDiffStat.trim().length > 0
          ? ["```", escalatedDiffStat.trim(), "```"]
          : []),
      ].join("\n")
    : "";

  const deliverConflictSection =
    deliverConflictNote && deliverConflictNote.trim().length > 0
      ? [`## 合并冲突按需处理指令`, deliverConflictNote.trim()].join("\n")
      : "";

  const dynamicTail = [
    `# 本轮执行指令 (${stage} · round ${round})`,
    `- task_id: ${card.id}`,
    `- run_id: ${runId}`,
    `- role: ${role}`,
    ...(rosterRoleId ? [`- roster_role: ${rosterRoleId}`] : []),
    `- contract_version: ${card.contract_version}`,
    ...(inputRef ? [`- input_ref: ${inputRef}`] : []),
    ...(!mcpEnabled ? [`- 本轮回执写入路径：${store.paths.receiptMd(card.id, runDirName)}`] : []),
    `- 提交回执时请将 frontmatter 中的 \`run_id\` 设为 \`${runId}\`、\`contract_version\` 设为 \`${card.contract_version}\`。`,
    ``,
    buildStageCognitiveDirective({
      stage,
      card,
      cwd,
      rosterRoleId,
      hasResearchDoc: researchDoc.trim().length > 0,
    }),
    ``,
    ...(advisorContextSection ? [advisorContextSection, ``] : []),
    ...(escalationDeltaSection ? [escalationDeltaSection, ``] : []),
    ...(deliverConflictSection ? [deliverConflictSection, ``] : []),
    ...(acceptEnvSection ? [acceptEnvSection, ``] : []),
    ...(spaceAcceptScenariosSection ? [spaceAcceptScenariosSection, ``] : []),
    ...(acceptDeltaSection ? [acceptDeltaSection, ``] : []),
    ...(failureDeltaSection ? [failureDeltaSection, ``] : []),
    ...(reviewDeltaSection ? [reviewDeltaSection, ``] : []),
    ...(steerSection ? [steerSection, ``] : []),
  ].join("\n");

  const fullMarkdown = `${stablePrefix}\n---\n\n${dynamicTail}`;
  return {
    stablePrefix,
    dynamicTail,
    fullMarkdown,
  };
}

export function buildHandoffMarkdown(params: BuildHandoffParams): string {
  return buildHandoffPayload(params).fullMarkdown;
}

export function extractDecisionFromNeedDecisionReceipt(
  rawReceipt: string,
  taskId: string,
  runId: string,
  contractVersion: number,
  body: string,
): PendingDecision {
  const parsedFm = parseFrontmatterMarkdown(rawReceipt).frontmatter;
  const issueSection = extractSection(body, "未完成或待决问题") || extractSection(body, "待决问题");

  const question =
    typeof parsedFm.question === "string" && parsedFm.question.trim().length > 0
      ? parsedFm.question.trim()
      : issueSection
          .split(/\r?\n/)
          .find((l) => l.trim().length > 0)
          ?.trim() || `任务 "${taskId}" 在执行过程中提出待决问题，请确认继续方案`;

  const reason =
    typeof parsedFm.reason === "string" && parsedFm.reason.trim().length > 0
      ? parsedFm.reason.trim()
      : "worker_need_decision";

  const category =
    typeof parsedFm.category === "string" && parsedFm.category.trim().length > 0
      ? parsedFm.category.trim()
      : "worker_decision";

  let options: DecisionOption[] | null = null;
  if (Array.isArray(parsedFm.options)) {
    const parsedOpts = z.array(DecisionOptionSchema).min(1).safeParse(parsedFm.options);
    if (parsedOpts.success) {
      options = parsedOpts.data;
    }
  }

  if (!options) {
    const parsedFromBullets: DecisionOption[] = [];
    for (const line of body.split(/\r?\n/)) {
      const m =
        /^[-*]\s+\[([^\]]+)\]\s+(.+?)(?:\s+\(action:\s*(resume|return_external|finish|cancel)\))?$/i.exec(
          line.trim(),
        );
      if (m) {
        parsedFromBullets.push(
          DecisionOptionSchema.parse({
            id: m[1]!.trim(),
            label: m[2]!.trim(),
            action: (m[3]?.toLowerCase() ?? "resume") as DecisionOption["action"],
            recommended: parsedFromBullets.length === 0,
          }),
        );
      }
    }
    if (parsedFromBullets.length > 0) {
      options = parsedFromBullets;
    }
  }

  let strippedReturnExternal = false;
  if (options) {
    const filtered = options.filter((opt) => opt.action !== "return_external");
    if (filtered.length !== options.length) {
      strippedReturnExternal = true;
      options = filtered;
    }
  }

  if (!options || options.length === 0) {
    options = [
      DecisionOptionSchema.parse({
        id: "opt-resume",
        label: "确认澄清并继续推进当前阶段",
        action: "resume",
        target_stage: "implement",
        recommended: true,
      }),
      DecisionOptionSchema.parse({
        id: "opt-cancel",
        label: "取消任务",
        action: "cancel",
        recommended: false,
      }),
    ];
  } else if (strippedReturnExternal) {
    if (!options.some((opt) => opt.action === "resume")) {
      options.unshift(
        DecisionOptionSchema.parse({
          id: "opt-resume",
          label: "确认澄清并继续推进当前阶段",
          action: "resume",
          target_stage: "implement",
          recommended: !options.some((opt) => opt.recommended),
        }),
      );
    }
    if (!options.some((opt) => opt.action === "cancel")) {
      options.push(
        DecisionOptionSchema.parse({
          id: "opt-cancel",
          label: "取消任务",
          action: "cancel",
          recommended: false,
        }),
      );
    }
  }

  const effectiveQuestion = strippedReturnExternal
    ? `${question}\n\n（注：执行阶段不支持自动转入外部等待，已由内核移除不合法的 return_external 选项）`
    : question;

  return PendingDecisionSchema.parse({
    id: `dec-${randomUUID().slice(0, 8)}`,
    task_id: taskId,
    run_id: runId,
    contract_version: contractVersion,
    reason,
    category,
    question: effectiveQuestion,
    options,
    created_at: new Date().toISOString(),
  });
}
