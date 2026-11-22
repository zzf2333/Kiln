import type { StageId, TaskStatus, Track, WorkflowBlueprint } from "@kiln/protocol/web";
import { getPipelineStages, heatOf, stageMeta } from "../state/format";
import { FlameCanvas } from "./FlameCanvas";

export interface MiniRailProps {
  track: Track;
  workflow?: WorkflowBlueprint;
  status: TaskStatus;
  activeStage: StageId | null;
  rate?: number;
}

const STAGE_RANK: Partial<Record<StageId, number>> = {
  intake: 0,
  plan: 1,
  implement: 2,
  verify: 3,
  review: 4,
  accept: 5,
  deliver: 6,
};

export function MiniRail({ track, workflow, status, activeStage, rate }: MiniRailProps) {
  const stages = getPipelineStages(track, false, workflow);
  const activeRank = activeStage ? (STAGE_RANK[activeStage] ?? 2) : 0;

  return (
    <div class="rail">
      {stages.map((st) => {
        const meta = stageMeta(st);
        const rank = STAGE_RANK[st] ?? 0;

        let cls = "";
        let isLive = false;

        if (status === "done") {
          cls = "is-done";
        } else if (st === "intake") {
          cls = "is-done";
        } else if (activeStage === st) {
          if (status === "running") {
            cls = "is-live fire";
            isLive = true;
          } else if (status === "waiting") {
            cls = "is-blocked";
          } else if (status === "paused") {
            cls = "is-paused-manual";
          } else if (status === "external") {
            cls = "is-done";
          }
        } else if (
          activeStage &&
          (activeStage === "triage" || activeStage === "advise") &&
          st === "implement"
        ) {
          cls =
            status === "waiting"
              ? "is-blocked"
              : status === "paused"
                ? "is-paused-manual"
                : status === "running"
                  ? "is-live fire"
                  : "is-done";
          isLive = status === "running";
        } else if (activeStage && rank < activeRank) {
          cls = "is-done";
        }

        return (
          <span
            key={st}
            class={`rail-seg ${cls}`}
            style={{ "--c": `var(${meta.colorVar})` } as Record<string, string>}
            title={meta.label}
          >
            {isLive ? <FlameCanvas size="sm" heat={heatOf(rate)} /> : null}
          </span>
        );
      })}
    </div>
  );
}
