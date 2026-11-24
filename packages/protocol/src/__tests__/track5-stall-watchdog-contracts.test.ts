import { describe, expect, it } from "vitest";
import {
  AdvisorRequestSchema,
  LimitsConfigSchema,
  RunEventSchema,
} from "../index.js";

describe("Track 5 [B12.1] Run heartbeat stall watchdog protocol contracts", () => {
  it("validates LimitsConfig.stall_timeout_sec boundaries (0 disables watchdog, 1..86400 enables, rejects invalid)", () => {
    const defaultCfg = LimitsConfigSchema.parse({ schema_version: 1 });
    expect(defaultCfg.stall_timeout_sec).toBeUndefined();

    const disabledCfg = LimitsConfigSchema.parse({
      schema_version: 1,
      stall_timeout_sec: 0,
    });
    expect(disabledCfg.stall_timeout_sec).toBe(0);

    const enabledCfg = LimitsConfigSchema.parse({
      schema_version: 1,
      stall_timeout_sec: 300,
    });
    expect(enabledCfg.stall_timeout_sec).toBe(300);

    expect(() =>
      LimitsConfigSchema.parse({ schema_version: 1, stall_timeout_sec: -1 }),
    ).toThrow();
    expect(() =>
      LimitsConfigSchema.parse({ schema_version: 1, stall_timeout_sec: 86_401 }),
    ).toThrow();
  });

  it("validates RunEvent stall_warning and AdvisorRequest run_stalled trigger", () => {
    const softWarn = RunEventSchema.parse({
      kind: "stall_warning",
      at: "2026-11-24T04:20:00Z",
      phase: "soft_warning",
      silentSec: 605,
      probeAlive: true,
      probeStatus: "running",
      action: "warn",
      detail: "Slow model thinking",
    });
    expect(softWarn.kind).toBe("stall_warning");
    if (softWarn.kind === "stall_warning") {
      expect(softWarn.phase).toBe("soft_warning");
      expect(softWarn.silentSec).toBe(605);
    }

    const aborted = RunEventSchema.parse({
      kind: "stall_warning",
      at: "2026-11-24T04:40:00Z",
      phase: "aborted",
      silentSec: 1205,
      probeAlive: false,
      probeStatus: "closed",
      action: "invoke_advisor",
    });
    expect(aborted.kind).toBe("stall_warning");

    const req = AdvisorRequestSchema.parse({
      contract_version: 1,
      trigger: "run_stalled",
      source_stage: "implement",
      source_run_id: "r-stalled-1",
      source_role: "worker",
      category: "run_stalled",
      reason: "Hard stall timeout reached",
      question: "Investigate stall",
      consecutive_failures: 2,
      created_at: "2026-11-24T04:40:00Z",
    });
    expect(req.trigger).toBe("run_stalled");
  });
});
