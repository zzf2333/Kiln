import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DevicesConfigSchema,
  RemoteConfigSchema,
  RolesConfigSchema,
  createDefaultRemoteConfig,
} from "../config.js";
import { RunEventSchema, SseEventSchema } from "../events.js";
import * as webExports from "../web.js";

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

  it("validates RemoteConfigSchema & DevicesConfigSchema defaults, constraints, and web exports", () => {
    const defaults = createDefaultRemoteConfig();
    expect(defaults).toEqual({
      schema_version: 1,
      enabled: false,
      remote_port: 4311,
      keep_awake_on_ac: false,
      notifications: {
        enabled: false,
        channel: "webhook",
        url: "",
        priorities: ["P0", "P1"],
      },
    });

    const fullRemote = RemoteConfigSchema.parse({
      schema_version: 1,
      enabled: true,
      remote_port: 4411,
      public_url: "https://kiln-mac.tail123.ts.net",
      keep_awake_on_ac: true,
      notifications: {
        enabled: true,
        channel: "bark",
        url: "https://api.day.app/my-key",
        secret: "top-secret",
        priorities: ["P0", "P1", "P0"],
      },
    });
    expect(fullRemote.notifications.priorities).toEqual(["P0", "P1"]);

    // remote_port must differ from default local port 4310
    expect(
      RemoteConfigSchema.safeParse({
        schema_version: 1,
        remote_port: 4310,
      }).success,
    ).toBe(false);

    // public_url must be valid http(s) without query or fragment
    expect(
      RemoteConfigSchema.safeParse({
        schema_version: 1,
        public_url: "javascript:alert(1)",
      }).success,
    ).toBe(false);
    expect(
      RemoteConfigSchema.safeParse({
        schema_version: 1,
        public_url: "https://kiln.ts.net/#pair=abc",
      }).success,
    ).toBe(false);

    // notifications.enabled requires non-empty valid URL
    expect(
      RemoteConfigSchema.safeParse({
        schema_version: 1,
        notifications: {
          enabled: true,
          channel: "ntfy",
          url: "",
        },
      }).success,
    ).toBe(false);

    // DevicesConfigSchema strictly enforces 64-hex SHA-256 and rejects plaintext token field
    const validHash = "a".repeat(64);
    const parsedDevices = DevicesConfigSchema.parse({
      schema_version: 1,
      devices: [
        {
          id: "dev-1",
          label: "iPhone 16",
          token_sha256: validHash,
          created_at: "2026-11-20T00:00:00.000Z",
          last_seen_at: "2026-11-20T00:01:00.000Z",
          last_user_agent: "Safari",
        },
      ],
    });
    expect(parsedDevices.devices).toHaveLength(1);

    expect(
      DevicesConfigSchema.safeParse({
        schema_version: 1,
        devices: [
          {
            id: "dev-bad",
            label: "Bad",
            token_sha256: "not-a-sha256",
            created_at: "2026-11-20T00:00:00.000Z",
            last_seen_at: "2026-11-20T00:01:00.000Z",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      DevicesConfigSchema.safeParse({
        schema_version: 1,
        devices: [
          {
            id: "dev-plaintext",
            label: "Bad",
            token: "plaintext-forbidden",
            token_sha256: validHash,
            created_at: "2026-11-20T00:00:00.000Z",
            last_seen_at: "2026-11-20T00:01:00.000Z",
          },
        ],
      }).success,
    ).toBe(false);

    // Verify browser-safe @kiln/protocol/web exports stay zero-Zod while exposing constants & types
    expect(webExports.DEFAULT_REMOTE_PORT).toBe(4311);
    expect(webExports.DEFAULT_LOCAL_PORT).toBe(4310);
    expect(webExports.REMOTE_NOTIFICATION_CHANNELS).toEqual(["bark", "ntfy", "webhook"]);
    expect(webExports.DEFAULT_REMOTE_NOTIFICATION_PRIORITIES).toEqual(["P0", "P1"]);
    expect(webExports.SHA256_HEX_RE.test(validHash)).toBe(true);
    const typedRemote: webExports.RemoteConfig = fullRemote;
    const typedDevices: webExports.DevicesConfig = parsedDevices;
    const typedPairReq: webExports.PairCompleteRequest = { code: "123456" };
    expect(typedRemote.remote_port).toBe(4411);
    expect(typedDevices.devices).toHaveLength(1);
    expect(typedPairReq.code).toBe("123456");
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
