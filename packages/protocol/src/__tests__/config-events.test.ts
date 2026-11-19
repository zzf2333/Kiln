import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RolesConfigSchema } from "../config.js";
import { RunEventSchema, SseEventSchema } from "../events.js";

describe("config, events, and zero-node-dependency invariant", () => {
  it("validates 7 roles config and defaults allow_full_access_fallback to false", () => {
    const cfg = RolesConfigSchema.parse({
      schema_version: 1,
      roles: {
        intake: { agent: "codex", model: "gpt-6.2-sol" },
        worker: {
          agent: "pi",
          model: "magpie/group/work",
          fallback: { agent: "codex", model: "gpt-6.2-sol" },
        },
        reviewer: {
          agent: "codex",
          model: "gpt-6.2-astra",
          avoid_same_model_as: "worker",
        },
      },
    });
    expect(cfg.heterogeneous_review).toBe(true);
    expect(cfg.roles.worker?.allow_full_access_fallback).toBe(false);
  });

  it("rejects unknown role keys and RunEvent usage with cached > input", () => {
    const unknownRole = RolesConfigSchema.safeParse({
      schema_version: 1,
      roles: { pm: { agent: "codex", model: "gpt-6.2-sol" } },
    });
    expect(unknownRole.success).toBe(false);

    const badUsageEvent = RunEventSchema.safeParse({
      kind: "usage",
      at: "2026-11-19T12:00:00.000Z",
      turnId: "t-1",
      agent: "pi",
      model: "magpie/group/fast",
      inputTokens: 100,
      cachedInputTokens: 200,
      outputTokens: 20,
    });
    expect(badUsageEvent.success).toBe(false);

    const sse = SseEventSchema.parse({
      seq: 1,
      type: "rate.tick",
      rates: { "t-118": 142 },
      totals: { costUsd: 1.25, tokPerSec: 142 },
    });
    expect(sse.type).toBe("rate.tick");
  });

  it("contains zero node:* imports in packages/protocol/src source modules", () => {
    const srcDir = path.resolve(import.meta.dirname, "..");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(path.join(srcDir, file), "utf8");
      expect(content).not.toMatch(/from\s+["']node:/);
      expect(content).not.toContain("@getpaseo/client");
    }
  });
});
