import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  PendingDecisionSchema,
  getDeliverCommandPolicy,
  type PendingDecision,
  type StageId,
  type StateEvent,
  type TaskCard,
  type TaskStatus,
} from "@kiln/protocol";
import {
  applyApprovedHostScopedChanges,
  cleanupGitWorktree,
  cleanupTaskCheckpoints,
  readHostBackupManifest,
  runIsolatedCommand,
} from "../gate/index.js";
import type { DispatchPlan } from "../scheduler/index.js";
import type { KilnStore } from "../store/index.js";
import { MAX_REFINERY_AUTO_REWORKS, countRefineryAutoReworks } from "./merge-queue.js";
import { runGitCommand } from "./orchestrator-git.js";

export interface DeliverRunGuard {
  runId: string;
  contractVersion: number;
}

export interface DeliverContext {
  taskId: string;
  card: TaskCard;
  worktreePath: string | null;
  store: KilnStore;
}

export type DeliverOutcome =
  | { status: "done"; deliverRef?: string }
  | { status: "external"; detail?: string }
  | { status: "waiting"; decision: PendingDecision };

export type DeliverHandler = (ctx: DeliverContext) => Promise<DeliverOutcome> | DeliverOutcome;

export interface DeliverExecutionContext {
  store: KilnStore;
  deliverHandler: DeliverHandler | undefined;
  getGitWorktreeDir: (taskId: string) => string;
  isRunStillCurrent: (
    taskId: string,
    expectedRunId: string,
    expectedContractVersion: number,
  ) => boolean;
  syncCaffeinate: () => void;
  transitionTaskToWaiting: (
    taskId: string,
    decision: PendingDecision,
    expected?: DeliverRunGuard,
  ) => boolean;
  completeTaskDelivery: (
    taskId: string,
    deliverRef?: string,
    expected?: DeliverRunGuard,
  ) => boolean;
  runTrackedStageOperation: (
    taskId: string,
    runId: string,
    fn: (signal: AbortSignal) => Promise<void>,
  ) => Promise<void>;
  publishTaskUpdated: (
    taskId: string,
    patch: {
      status?: TaskStatus;
      stage?: StageId;
      round?: number;
      contractVersion?: number;
    },
  ) => void;
  shouldRunDelivererAgent: (plan: DispatchPlan) => boolean;
  canRunOnConflictDeliverer: (plan: DispatchPlan) => boolean;
  dispatchOnConflictDeliverer: (
    plan: DispatchPlan,
    conflict: { baseRef: string; mergeError: string },
  ) => Promise<void>;
  withSpaceMergeLock: <T>(repoPath: string, fn: () => Promise<T>) => Promise<T>;
  reworkDeliverFailure: (
    plan: DispatchPlan,
    input: { steerId: string; message: string },
    expected: DeliverRunGuard,
  ) => Promise<void>;
  dispatchAgentStageRun: (plan: DispatchPlan) => Promise<void>;
  wake: () => Promise<void>;
}

export function hasApprovedDeliverDecision(
  events: readonly StateEvent[],
  waitingReason: string,
): boolean {
  let lastWaitingIdx = -1;
  let lastImplIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (lastWaitingIdx === -1 && ev.type === "waiting" && ev.reason === waitingReason) {
      lastWaitingIdx = i;
    }
    if (lastImplIdx === -1 && ev.type === "running" && ev.stage === "implement") {
      lastImplIdx = i;
    }
    if (lastWaitingIdx !== -1 && lastImplIdx !== -1) {
      break;
    }
  }
  if (lastWaitingIdx === -1 || lastWaitingIdx < lastImplIdx) {
    return false;
  }
  for (let i = lastWaitingIdx + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type === "decided" && ev.action === "resume" && ev.target_stage === "deliver") {
      return true;
    }
  }
  return false;
}

/**
 * Executes the deterministic `deliver` stage (host_scoped two-phase atomic apply & rollback,
 * deliver approval gates, custom deliverHandler, git_worktree merge_main / open_pr / run_cmd),
 * or dispatches a `deliverer` pre-merge preparation agent run first when configured.
 */
export async function executeDeliverStage(
  ctx: DeliverExecutionContext,
  plan: DispatchPlan,
): Promise<void> {
  if (ctx.shouldRunDelivererAgent(plan)) {
    await ctx.dispatchAgentStageRun(plan);
    return;
  }

  const now = new Date().toISOString();
  const deliverRunId = `run-${plan.taskId}-deliver-r${plan.round}-v${plan.contractVersion}`;
  const deliverGuard: DeliverRunGuard = {
    runId: deliverRunId,
    contractVersion: plan.contractVersion,
  };

  ctx.store.appendStateEvent(plan.taskId, {
    type: "running",
    at: now,
    stage: "deliver",
    ...(plan.stepIndex !== null ? { step_index: plan.stepIndex } : {}),
    round: plan.round,
    run_id: deliverRunId,
  });
  ctx.syncCaffeinate();
  ctx.publishTaskUpdated(plan.taskId, {
    status: "running",
    stage: "deliver",
    round: plan.round,
    contractVersion: plan.contractVersion,
  });

  await ctx.runTrackedStageOperation(plan.taskId, deliverRunId, async (signal) => {
    if (signal.aborted || !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)) {
      ctx.syncCaffeinate();
      return;
    }

    const card = ctx.store.readTaskCard(plan.taskId);
    const deliverPolicy = getDeliverCommandPolicy(card);
    const worktreePath =
      card.workspace_mode === "git_worktree" ? ctx.getGitWorktreeDir(plan.taskId) : null;
    let deliverRef = worktreePath ?? ctx.store.paths.workspaceDir(plan.taskId);
    let hostAppliedWithVerify = false;

    if (card.workspace_mode === "host_scoped") {
      let hostDeliverRef = "host_scoped_completed";
      const manifestPath = ctx.store.paths.backupManifest(plan.taskId);
      const existingManifest = fs.existsSync(manifestPath)
        ? readHostBackupManifest(ctx.store, plan.taskId)
        : null;

      if (existingManifest?.status === "staged_awaiting_approval") {
        const events = ctx.store.readStateEvents(plan.taskId);
        const approved =
          hasApprovedDeliverDecision(events, "host_scoped_approval") ||
          hasApprovedDeliverDecision(events, "deliver_approval");

        if (!approved) {
          const targetList = existingManifest.files
            .map(
              (f) =>
                `${f.target_canonical_path}${
                  f.staged_sha256 ? ` (sha256:${f.staged_sha256.slice(7, 19)})` : ""
                }`,
            )
            .join(", ");
          const deliverCmdNote =
            card.contract.deliver.mode === "run_cmd" && card.contract.deliver.cmd
              ? `\n- 落盘后执行交付命令: \`${card.contract.deliver.cmd}\``
              : "";
          const acceptGateNote = deliverPolicy.finalAcceptGate
            ? `\n- 最终宿主机验收命令: \`${card.contract.accept_cmd}\``
            : "";
          const decision = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            contract_version: card.contract_version,
            reason: "host_scoped_approval",
            category: "host_scoped_apply",
            question: `本机任务 "${card.title}" 已生成暂存修改并备份原文件，批准原子写入并执行吗？\n- 目标路径: ${targetList}${deliverCmdNote}${acceptGateNote}`,
            options: [
              {
                id: "opt-apply-host",
                label: "批准落盘写入宿主机并执行校验",
                action: "resume",
                target_stage: "deliver",
                recommended: true,
              },
              {
                id: "opt-rework-staged",
                label: "退回调整暂存清单/脚本（附修改意见）",
                action: "resume",
                target_stage: "implement",
                recommended: false,
              },
              {
                id: "opt-finish-staged",
                label: "仅保留暂存补丁，不写本机直接完成",
                action: "finish",
                recommended: false,
              },
              {
                id: "opt-cancel",
                label: "取消任务",
                action: "cancel",
                recommended: false,
              },
            ],
            created_at: new Date().toISOString(),
          });
          ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
          return;
        }

        const applyRes = await applyApprovedHostScopedChanges(ctx.store, {
          taskId: plan.taskId,
          approved: true,
          ...(card.contract.deliver.mode === "run_cmd" && card.contract.deliver.cmd
            ? { postApplyCmd: card.contract.deliver.cmd }
            : {}),
          verifyCmd: card.contract.accept_cmd,
          signal,
        });
        if (
          signal.aborted ||
          !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
        ) {
          ctx.syncCaffeinate();
          return;
        }
        if (!applyRes.ok) {
          const failureDetail =
            applyRes.reason === "staged_hash_mismatch"
              ? "暂存区文件 SHA-256 校验与待批快照不一致，已拦截写入宿主机"
              : applyRes.reason === "deliver_cmd_failed_rolled_back"
                ? `交付命令执行失败（exit=${applyRes.postApplyResult.exitCode}），已自动回滚宿主机文件`
                : applyRes.reason === "verify_failed_rolled_back"
                  ? `最终验收失败（exit=${applyRes.verifyResult.exitCode}），已自动回滚宿主机文件`
                  : `本机落盘未完成 (${applyRes.reason})，已安全保护或回滚`;
          const decision = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            contract_version: card.contract_version,
            reason: `host_apply_${applyRes.reason}`,
            category: "host_scoped_apply_error",
            question: `${failureDetail}，请选择下一步操作。`,
            options: [
              {
                id: "opt-reimplement",
                label: "退回实施重新生成暂存",
                action: "resume",
                target_stage: "implement",
                recommended: true,
              },
              {
                id: "opt-cancel",
                label: "取消任务",
                action: "cancel",
                recommended: false,
              },
            ],
            created_at: new Date().toISOString(),
          });
          ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
          return;
        }

        hostAppliedWithVerify = true;
        hostDeliverRef = applyRes.manifest.files.map((f) => f.target_canonical_path).join(", ");
        deliverRef = hostDeliverRef;
        ctx.completeTaskDelivery(plan.taskId, deliverRef, deliverGuard);
        return;
      }

      if (existingManifest?.status === "applied") {
        hostDeliverRef = existingManifest.files.map((f) => f.target_canonical_path).join(", ");
        hostAppliedWithVerify = true;
      }

      deliverRef = hostDeliverRef;
      if (card.contract.deliver.mode !== "run_cmd") {
        if (deliverPolicy.finalAcceptGate && !hostAppliedWithVerify) {
          const events = ctx.store.readStateEvents(plan.taskId);
          const approved =
            hasApprovedDeliverDecision(events, "deliver_approval") ||
            hasApprovedDeliverDecision(events, "host_scoped_approval");
          if (!approved) {
            const decision = PendingDecisionSchema.parse({
              id: `dec-${randomUUID().slice(0, 8)}`,
              task_id: plan.taskId,
              contract_version: card.contract_version,
              reason: "deliver_approval",
              category: "deliver_approval",
              question: `本机任务 "${card.title}" 待执行最终宿主机验收命令 \`${card.contract.accept_cmd}\`，是否批准执行？`,
              options: [
                {
                  id: "opt-approve-deliver",
                  label: "批准执行交付与宿主机验收",
                  action: "resume",
                  target_stage: "deliver",
                  recommended: true,
                },
                {
                  id: "opt-reimplement",
                  label: "退回实施阶段修改",
                  action: "resume",
                  target_stage: "implement",
                  recommended: false,
                },
                {
                  id: "opt-cancel",
                  label: "取消任务",
                  action: "cancel",
                  recommended: false,
                },
              ],
              created_at: new Date().toISOString(),
            });
            ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
            return;
          }

          const finalCwd = fs.existsSync(ctx.store.paths.workspaceDir(plan.taskId))
            ? ctx.store.paths.workspaceDir(plan.taskId)
            : ctx.store.paths.taskDir(plan.taskId);
          const finalAccept = await runIsolatedCommand(card.contract.accept_cmd, {
            cwd: finalCwd,
            signal,
          });
          if (
            signal.aborted ||
            !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
          ) {
            ctx.syncCaffeinate();
            return;
          }
          if (finalAccept.exitCode !== 0 || finalAccept.timedOut) {
            const decision = PendingDecisionSchema.parse({
              id: `dec-${randomUUID().slice(0, 8)}`,
              task_id: plan.taskId,
              contract_version: card.contract_version,
              reason: "deliver_final_accept_failed",
              category: "deliver_approval",
              question: `最终宿主机验收命令失败 (exit=${finalAccept.exitCode}, timedOut=${finalAccept.timedOut})，请选择处理方式。`,
              options: [
                {
                  id: "opt-reimplement",
                  label: "退回实施阶段修复",
                  action: "resume",
                  target_stage: "implement",
                  recommended: true,
                },
                {
                  id: "opt-cancel",
                  label: "取消任务",
                  action: "cancel",
                  recommended: false,
                },
              ],
              created_at: new Date().toISOString(),
            });
            ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
            return;
          }
        }
        ctx.completeTaskDelivery(plan.taskId, deliverRef, deliverGuard);
        return;
      }
    }

    if (
      !ctx.deliverHandler &&
      card.workspace_mode !== "host_scoped" &&
      deliverPolicy.requiresDeliverApproval
    ) {
      const isOpenPrAsk =
        card.workspace_mode === "git_worktree" &&
        card.contract.deliver.mode === "open_pr" &&
        card.contract.external_actions === "ask";
      if (!isOpenPrAsk) {
        const events = ctx.store.readStateEvents(plan.taskId);
        const alreadyApproved =
          hasApprovedDeliverDecision(events, "deliver_approval") ||
          hasApprovedDeliverDecision(events, "external_action_approval");
        if (!alreadyApproved) {
          const cmdDesc =
            card.contract.deliver.mode === "run_cmd" && card.contract.deliver.cmd
              ? `\n- 交付命令: \`${card.contract.deliver.cmd}\``
              : "";
          const decision = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            contract_version: card.contract_version,
            reason: "deliver_approval",
            category: "deliver_approval",
            question: `任务 "${card.title}" 已完成前置验证，准备进入交付（mode=${card.contract.deliver.mode}），是否批准交付？${cmdDesc}`,
            options: [
              {
                id: "opt-approve-deliver",
                label: "批准执行交付",
                action: "resume",
                target_stage: "deliver",
                recommended: true,
              },
              {
                id: "opt-rework",
                label: "退回实施阶段调整",
                action: "resume",
                target_stage: "implement",
                recommended: false,
              },
              {
                id: "opt-cancel",
                label: "取消任务",
                action: "cancel",
                recommended: false,
              },
            ],
            created_at: new Date().toISOString(),
          });
          ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
          return;
        }
      }
    }

    if (ctx.deliverHandler) {
      const outcome = await ctx.deliverHandler({
        taskId: plan.taskId,
        card,
        worktreePath,
        store: ctx.store,
      });
      if (
        signal.aborted ||
        !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
      ) {
        ctx.syncCaffeinate();
        return;
      }
      if (outcome.status === "waiting") {
        ctx.transitionTaskToWaiting(plan.taskId, outcome.decision, deliverGuard);
        return;
      }
      if (outcome.status === "external") {
        const extState = ctx.store.appendStateEvent(plan.taskId, {
          type: "external",
          at: new Date().toISOString(),
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        });
        ctx.syncCaffeinate();
        ctx.publishTaskUpdated(plan.taskId, {
          status: extState.status,
          stage: "deliver",
          contractVersion: extState.contractVersion,
        });
        void ctx.wake();
        return;
      }
      ctx.completeTaskDelivery(plan.taskId, outcome.deliverRef, deliverGuard);
      return;
    }

    if (card.workspace_mode === "git_worktree" && worktreePath && fs.existsSync(worktreePath)) {
      const space = ctx.store.readSpace(card.space);
      if (card.contract.deliver.mode === "merge_main" && space?.repo_path) {
        const statusOut = (
          await runGitCommand(["-C", worktreePath, "status", "--porcelain"])
        ).trim();
        const headCommit = (await runGitCommand(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
        if (
          signal.aborted ||
          !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
        ) {
          ctx.syncCaffeinate();
          return;
        }
        deliverRef = headCommit;

        if (statusOut.length > 0) {
          const decision = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            contract_version: card.contract_version,
            reason: "worktree_dirty_before_merge",
            category: "deliver_merge_blocked",
            question: `工作树分支 kiln/${plan.taskId} 存在未提交改动，无法执行 merge_main，请先处理未提交变更后再重试合并。`,
            options: [
              {
                id: "opt-reimplement",
                label: "退回实施提交或清理工作树",
                action: "resume",
                target_stage: "implement",
                recommended: true,
              },
              {
                id: "opt-retry-deliver",
                label: "已在本地处理，重试合并主分支",
                action: "resume",
                target_stage: "deliver",
                recommended: false,
              },
              {
                id: "opt-finish",
                label: "保留工作树分支并直接标记完成",
                action: "finish",
                recommended: false,
              },
            ],
            created_at: new Date().toISOString(),
          });
          ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
          return;
        }

        const parentWorktreePath = card.parent !== null ? ctx.getGitWorktreeDir(card.parent) : null;
        const parentSpawnedChild =
          card.parent !== null &&
          parentWorktreePath !== null &&
          fs.existsSync(parentWorktreePath) &&
          (() => {
            try {
              const parentCard = ctx.store.readTaskCard(card.parent!);
              const parentEvents = ctx.store.readStateEvents(card.parent!);
              return parentEvents.some(
                (ev) =>
                  ev.type === "subtasks_spawned" &&
                  ev.contract_version === parentCard.contract_version &&
                  ev.child_task_ids.includes(plan.taskId),
              );
            } catch {
              return false;
            }
          })();
        const baseRef = parentSpawnedChild ? `kiln/${card.parent}` : space.default_branch;
        const mergeTargetDir = parentSpawnedChild ? parentWorktreePath! : space.repo_path!;
        const mergeTargetLabel = parentSpawnedChild ? "父任务工作树" : "主仓库";
        const mergeOutcome = await ctx.withSpaceMergeLock(
          space.repo_path,
          async (): Promise<{
            handled: boolean;
            deliverRef?: string;
          }> => {
            if (
              signal.aborted ||
              !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
            ) {
              ctx.syncCaffeinate();
              return { handled: true };
            }

            const aheadInLock = Number(
              (
                await runGitCommand([
                  "-C",
                  mergeTargetDir,
                  "rev-list",
                  "--count",
                  `${baseRef}..kiln/${plan.taskId}`,
                ]).catch(() => "0")
              ).trim(),
            );
            if (aheadInLock <= 0) {
              return { handled: false };
            }

            const currentMainBranch = (
              await runGitCommand([
                "-C",
                mergeTargetDir,
                "rev-parse",
                "--abbrev-ref",
                "HEAD",
              ]).catch(() => "")
            ).trim();
            const mainStatus = (
              await runGitCommand(["-C", mergeTargetDir, "status", "--porcelain"])
            ).trim();
            if (
              signal.aborted ||
              !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
            ) {
              ctx.syncCaffeinate();
              return { handled: true };
            }
            if (mainStatus.length > 0 || currentMainBranch !== baseRef) {
              const reasons: string[] = [];
              if (mainStatus.length > 0) {
                reasons.push(`${mergeTargetLabel}存在未提交改动`);
              }
              if (currentMainBranch !== baseRef) {
                reasons.push(
                  `${mergeTargetLabel}当前位于 "${currentMainBranch || "unknown"}" 而非 "${baseRef}"`,
                );
              }
              const decision = PendingDecisionSchema.parse({
                id: `dec-${randomUUID().slice(0, 8)}`,
                task_id: plan.taskId,
                contract_version: card.contract_version,
                reason: parentSpawnedChild
                  ? "parent_worktree_not_ready_for_merge"
                  : "main_repo_not_ready_for_merge",
                category: "deliver_merge_blocked",
                question: `分支 kiln/${plan.taskId} 尚有 ${aheadInLock} 个提交未合并至 ${baseRef}，但${reasons.join("且")}，已保留 worktree 等待处理。`,
                options: [
                  {
                    id: "opt-retry-deliver",
                    label: `${mergeTargetLabel}就绪后重试合并`,
                    action: "resume",
                    target_stage: "deliver",
                    recommended: true,
                  },
                  {
                    id: "opt-finish",
                    label: "跳过合并直接标记完成（保留工作树）",
                    action: "finish",
                    recommended: false,
                  },
                ],
                created_at: new Date().toISOString(),
              });
              ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
              return { handled: true };
            }

            const handleMergeConflict = async (msg: string): Promise<{ handled: true }> => {
              if (ctx.canRunOnConflictDeliverer(plan)) {
                await ctx.dispatchOnConflictDeliverer(plan, {
                  baseRef,
                  mergeError: msg,
                });
                return { handled: true };
              }
              const priorAutoReworks = countRefineryAutoReworks(
                ctx.store.readStateEvents(plan.taskId),
                card.contract_version,
              );
              if (priorAutoReworks < MAX_REFINERY_AUTO_REWORKS) {
                await ctx.reworkDeliverFailure(
                  plan,
                  {
                    steerId: `refinery-conflict-${randomUUID().slice(0, 8)}`,
                    message: `[Refinery 串行合并冲突] 分支 kiln/${plan.taskId} 在基于最新 ${baseRef} 变基或合入时发生冲突：${msg}。请在工作树合并最新 ${baseRef} 解决冲突并重跑验收后重新交付。`,
                  },
                  deliverGuard,
                );
                return { handled: true };
              }
              const decision = PendingDecisionSchema.parse({
                id: `dec-${randomUUID().slice(0, 8)}`,
                task_id: plan.taskId,
                contract_version: card.contract_version,
                reason: "merge_conflict",
                category: "deliver_merge_conflict",
                question: `本地合并分支 kiln/${plan.taskId} 到 ${baseRef} 时冲突（${msg}），已达自动返工上限，请人工处理或选择继续方式。`,
                options: [
                  {
                    id: "opt-reimplement",
                    label: "退回实施解决冲突",
                    action: "resume",
                    target_stage: "implement",
                    recommended: true,
                  },
                  {
                    id: "opt-finish",
                    label: "保留工作区分支并直接标记完成",
                    action: "finish",
                    recommended: false,
                  },
                ],
                created_at: new Date().toISOString(),
              });
              ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
              return { handled: true };
            };

            const behindCount = Number(
              (
                await runGitCommand([
                  "-C",
                  mergeTargetDir,
                  "rev-list",
                  "--count",
                  `kiln/${plan.taskId}..${baseRef}`,
                ]).catch(() => "0")
              ).trim(),
            );

            if (behindCount > 0) {
              try {
                await runGitCommand(["-C", worktreePath, "rebase", baseRef]);
              } catch (rebaseErr) {
                await runGitCommand(["-C", worktreePath, "rebase", "--abort"]).catch(() => {});
                const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
                return await handleMergeConflict(msg);
              }

              const postAccept = await runIsolatedCommand(card.contract.accept_cmd, {
                cwd: worktreePath,
                signal,
              });
              if (
                signal.aborted ||
                !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
              ) {
                ctx.syncCaffeinate();
                return { handled: true };
              }
              if (postAccept.exitCode !== 0 || postAccept.timedOut) {
                const priorAutoReworks = countRefineryAutoReworks(
                  ctx.store.readStateEvents(plan.taskId),
                  card.contract_version,
                );
                if (priorAutoReworks < MAX_REFINERY_AUTO_REWORKS) {
                  await ctx.reworkDeliverFailure(
                    plan,
                    {
                      steerId: `refinery-accept-${randomUUID().slice(0, 8)}`,
                      message: `[Refinery 合并前联合验收失败] 分支 kiln/${plan.taskId} 已成功 rebase 到最新 ${baseRef}，但重跑验收命令 \`${card.contract.accept_cmd}\` 失败 (exit=${postAccept.exitCode}, timedOut=${postAccept.timedOut})。请结合最新代码修复回归问题并重新通过验收。`,
                    },
                    deliverGuard,
                  );
                  return { handled: true };
                }
                const decision = PendingDecisionSchema.parse({
                  id: `dec-${randomUUID().slice(0, 8)}`,
                  task_id: plan.taskId,
                  contract_version: card.contract_version,
                  reason: "refinery_accept_failed",
                  category: "deliver_merge_blocked",
                  question: `分支 kiln/${plan.taskId} 在 rebase 至最新 ${baseRef} 后重跑验收命令 \`${card.contract.accept_cmd}\` 仍然失败 (exit=${postAccept.exitCode}, timedOut=${postAccept.timedOut})，${mergeTargetLabel}未被写入，请选择后续操作。`,
                  options: [
                    {
                      id: "opt-reimplement",
                      label: "退回实施阶段修复",
                      action: "resume",
                      target_stage: "implement",
                      recommended: true,
                    },
                    {
                      id: "opt-cancel",
                      label: "取消任务",
                      action: "cancel",
                      recommended: false,
                    },
                  ],
                  created_at: new Date().toISOString(),
                });
                ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
                return { handled: true };
              }
            }

            try {
              try {
                await runGitCommand([
                  "-C",
                  mergeTargetDir,
                  "merge",
                  "--ff-only",
                  `kiln/${plan.taskId}`,
                ]);
              } catch {
                await runGitCommand([
                  "-C",
                  mergeTargetDir,
                  "merge",
                  "--no-edit",
                  `kiln/${plan.taskId}`,
                ]);
              }
              const nextRef = (
                await runGitCommand(["-C", mergeTargetDir, "rev-parse", "HEAD"])
              ).trim();
              return { handled: false, deliverRef: nextRef };
            } catch (mergeErr) {
              await runGitCommand(["-C", mergeTargetDir, "merge", "--abort"]).catch(() => {});
              const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
              return await handleMergeConflict(msg);
            }
          },
        );

        if (mergeOutcome.handled) {
          return;
        }
        if (mergeOutcome.deliverRef !== undefined) {
          deliverRef = mergeOutcome.deliverRef;
        }
      } else if (card.contract.deliver.mode === "open_pr") {
        const events = ctx.store.readStateEvents(plan.taskId);
        const approvedPr = hasApprovedDeliverDecision(events, "external_action_approval");
        if (!approvedPr && card.contract.external_actions === "ask") {
          const decision = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            contract_version: card.contract_version,
            reason: "external_action_approval",
            category: "external_deliver_pr",
            question: `分支 kiln/${plan.taskId} 已通过验真与审查，是否批准创建外部 PR 或转入外部等待？`,
            options: [
              {
                id: "opt-return-external",
                label: "已提交外部 PR，转入外部等待",
                action: "return_external",
                recommended: true,
              },
              {
                id: "opt-finish",
                label: "直接标记完成",
                action: "finish",
                recommended: false,
              },
            ],
            created_at: new Date().toISOString(),
          });
          ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
          return;
        }
      }
    }

    if (card.contract.deliver.mode === "run_cmd" && card.contract.deliver.cmd) {
      const cmdCwd =
        card.workspace_mode === "git_worktree"
          ? worktreePath
          : ctx.store.paths.workspaceDir(plan.taskId);
      if (!cmdCwd || !fs.existsSync(cmdCwd) || !fs.statSync(cmdCwd).isDirectory()) {
        throw new Error(
          `Delivery command working directory does not exist for task "${plan.taskId}": ${String(cmdCwd)}`,
        );
      }

      const events = ctx.store.readStateEvents(plan.taskId);
      const approvedCmd =
        hasApprovedDeliverDecision(events, "external_action_approval") ||
        hasApprovedDeliverDecision(events, "deliver_approval");
      if (!approvedCmd && card.contract.external_actions === "ask") {
        const decision = PendingDecisionSchema.parse({
          id: `dec-${randomUUID().slice(0, 8)}`,
          task_id: plan.taskId,
          contract_version: card.contract_version,
          reason: "external_action_approval",
          category: "external_deliver_cmd",
          question: `交付动作需要执行外部命令 \`${card.contract.deliver.cmd}\`，是否批准执行？`,
          options: [
            {
              id: "opt-run-deliver-cmd",
              label: "批准执行交付命令",
              action: "resume",
              target_stage: "deliver",
              recommended: true,
            },
            {
              id: "opt-finish-manual",
              label: "跳过命令并直接完成",
              action: "finish",
              recommended: false,
            },
          ],
          created_at: new Date().toISOString(),
        });
        ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
        return;
      }

      const cmdRes = await runIsolatedCommand(card.contract.deliver.cmd, {
        cwd: cmdCwd,
        signal,
      });
      if (
        signal.aborted ||
        !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
      ) {
        ctx.syncCaffeinate();
        return;
      }
      if (cmdRes.exitCode !== 0 || cmdRes.timedOut) {
        throw new Error(
          `Delivery command failed (exit=${cmdRes.exitCode}, timedOut=${cmdRes.timedOut})`,
        );
      }

      if (deliverPolicy.finalAcceptGate && !hostAppliedWithVerify) {
        const finalAccept = await runIsolatedCommand(card.contract.accept_cmd, {
          cwd: cmdCwd,
          signal,
        });
        if (
          signal.aborted ||
          !ctx.isRunStillCurrent(plan.taskId, deliverRunId, plan.contractVersion)
        ) {
          ctx.syncCaffeinate();
          return;
        }
        if (finalAccept.exitCode !== 0 || finalAccept.timedOut) {
          const decision = PendingDecisionSchema.parse({
            id: `dec-${randomUUID().slice(0, 8)}`,
            task_id: plan.taskId,
            contract_version: card.contract_version,
            reason: "deliver_final_accept_failed",
            category: "deliver_approval",
            question: `交付命令已执行，但最终验收命令失败 (exit=${finalAccept.exitCode}, timedOut=${finalAccept.timedOut})，请选择下一步处理。`,
            options: [
              {
                id: "opt-reimplement",
                label: "退回实施阶段修复",
                action: "resume",
                target_stage: "implement",
                recommended: true,
              },
              {
                id: "opt-cancel",
                label: "取消任务",
                action: "cancel",
                recommended: false,
              },
            ],
            created_at: new Date().toISOString(),
          });
          ctx.transitionTaskToWaiting(plan.taskId, decision, deliverGuard);
          return;
        }
      }
    }

    const delivered = ctx.completeTaskDelivery(plan.taskId, deliverRef, deliverGuard);

    if (delivered && card.workspace_mode === "git_worktree" && worktreePath) {
      const space = ctx.store.readSpace(card.space);
      if (space?.repo_path) {
        const cleaned = await cleanupGitWorktree({
          repoPath: space.repo_path,
          worktreePath,
          taskStatus: "done",
          gatePassed: true,
          awaitingHumanReview: false,
        }).catch(() => null);
        if (cleaned?.deleted) {
          await cleanupTaskCheckpoints(space.repo_path, plan.taskId).catch(() => {});
        }
      }
    }
  });
}
