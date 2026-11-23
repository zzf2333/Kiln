import { Popover } from "radix-ui";
import { useMemo, useState } from "react";
import {
  isReadOnlyRosterPermission,
  type RosterConfig,
  type RosterPermission,
  type WorkflowAgentStage,
  type WorkspaceMode,
} from "@kiln/protocol/web";
import type { ProviderRuntimeStatus } from "../api/types";
import { ProviderAvatar } from "./ProviderAvatar";

export interface RosterRolePickerProps {
  stage: WorkflowAgentStage;
  workspaceMode: WorkspaceMode;
  selectedRoleId?: string;
  roster: RosterConfig;
  providerStatuses: ProviderRuntimeStatus[];
  disabled?: boolean;
  onSelect: (rosterRoleId: string | undefined) => void;
}

const PERM_BADGE: Record<RosterPermission, { label: string; cls: string }> = {
  read_only: { label: "严格只读", cls: "perm-ro" },
  read_only_draft: { label: "只读 + 草稿", cls: "perm-ro" },
  workspace_write: { label: "受限可写", cls: "perm-rw" },
  host_staged: { label: "本机两阶段暂存", cls: "perm-host" },
  accept_entry: { label: "入口验收", cls: "perm-accept" },
  kernel_gate: { label: "0 Token 内核", cls: "perm-kernel" },
};

export function RosterRolePicker({
  stage,
  workspaceMode,
  selectedRoleId,
  roster,
  providerStatuses,
  disabled = false,
  onSelect,
}: RosterRolePickerProps) {
  const [open, setOpen] = useState(false);

  const eligibleEntries = useMemo(() => {
    return Object.entries(roster.roster)
      .filter(([, entry]) => {
        if (!entry.enabled) return false;
        const allowedStages = [entry.stage, ...(entry.secondary_stages ?? [])];
        if (!allowedStages.includes(stage)) return false;
        if (stage === "implement" && isReadOnlyRosterPermission(entry.perm)) {
          return false;
        }
        if (
          stage === "implement" &&
          entry.perm === "host_staged" &&
          workspaceMode !== "host_scoped"
        ) {
          return false;
        }
        if (stage === "review" && entry.perm === "workspace_write") {
          return false;
        }
        return true;
      })
      .map(([id, entry]) => ({ id, entry }));
  }, [roster.roster, stage, workspaceMode]);

  const currentEntry = selectedRoleId ? roster.roster[selectedRoleId] : undefined;
  const triggerProvider =
    currentEntry?.mode === "kernel"
      ? "kernel"
      : currentEntry?.primary?.provider ?? "pm";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="btn btn-sm roster-trigger"
          disabled={disabled}
          aria-label={`选择 ${stage} 阶段执行角色`}
        >
          <ProviderAvatar providerId={triggerProvider} />
          <span>{currentEntry ? currentEntry.name : "默认指派"}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="roster-pop"
          align="end"
          sideOffset={4}
          aria-label={`${stage} 可选阵容角色`}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            setOpen(false);
          }}
        >
          <div className="roster-pop-head">
            <span>选择「{stage}」阶段执行角色</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                onSelect(undefined);
                setOpen(false);
              }}
            >
              恢复默认
            </button>
          </div>
          {eligibleEntries.length === 0 ? (
            <p className="muted" style={{ fontSize: "12px", padding: "8px" }}>
              当前权限约束下暂无可选启用角色
            </p>
          ) : (
            <div className="roster-pop-list" role="listbox" aria-label="安全过滤后的角色">
              {eligibleEntries.map(({ id, entry }) => {
                const isSelected = id === selectedRoleId;
                const permMeta = PERM_BADGE[entry.perm];
                const provId =
                  entry.mode === "kernel"
                    ? "kernel"
                    : entry.primary?.provider ?? "pm";
                const provStatus = entry.primary
                  ? providerStatuses.find((p) => p.provider_id === entry.primary?.provider)
                  : undefined;
                const isCooling = provStatus?.status === "cooldown";
                return (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`roster-pop-item ${isSelected ? "is-sel" : ""}`}
                    onClick={() => {
                      onSelect(id);
                      setOpen(false);
                    }}
                  >
                    <div className="roster-pop-top">
                      <ProviderAvatar providerId={provId} />
                      <b>{entry.name}</b>
                      <span className={`perm ${permMeta.cls}`}>{permMeta.label}</span>
                      {entry.primary ? (
                        <span className="mono muted">
                          {entry.primary.provider}/{entry.primary.model}
                        </span>
                      ) : null}
                      {isCooling ? <span className="chip chip-ask">冷却中</span> : null}
                    </div>
                    <div className="roster-pop-traits">{entry.traits}</div>
                  </button>
                );
              })}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
