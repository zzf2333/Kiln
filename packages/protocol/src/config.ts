import { z } from "zod";
import {
  DEFAULT_LOCAL_PORT,
  DEFAULT_REMOTE_PORT,
  PRIORITIES,
  REASONING_EFFORTS,
  REMOTE_NOTIFICATION_CHANNELS,
  ROLE_IDS,
  SHA256_HEX_RE,
  type Priority,
  type ReasoningEffort,
  type RemoteNotificationChannel,
  type RoleId,
} from "./constants.js";

export {
  DEFAULT_LOCAL_PORT,
  DEFAULT_REMOTE_PORT,
  REASONING_EFFORTS,
  REMOTE_NOTIFICATION_CHANNELS,
  ROLE_IDS,
  SHA256_HEX_RE,
  type ReasoningEffort,
  type RemoteNotificationChannel,
  type RoleId,
};

export const RoleIdSchema = z.enum(ROLE_IDS);

export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);

export const RoleFallbackSchema = z.object({
  agent: z.string().min(1),
  model: z.string().min(1),
  backend_id: z.string().min(1).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
});
export type RoleFallback = z.infer<typeof RoleFallbackSchema>;

export const RoleAssignmentSchema = z.object({
  agent: z.string().min(1),
  model: z.string().min(1),
  backend_id: z.string().min(1).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  fallback: RoleFallbackSchema.optional(),
  avoid_same_model_as: RoleIdSchema.optional(),
  allow_full_access_fallback: z.boolean().default(false),
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export const RolesMapSchema = z
  .object({
    intake: RoleAssignmentSchema.optional(),
    worker: RoleAssignmentSchema.optional(),
    reviewer: RoleAssignmentSchema.optional(),
    verifier: RoleAssignmentSchema.optional(),
    triage: RoleAssignmentSchema.optional(),
    advisor: RoleAssignmentSchema.optional(),
    resolver: RoleAssignmentSchema.optional(),
  })
  .strict();

export const RolesConfigSchema = z.object({
  schema_version: z.literal(1),
  heterogeneous_review: z.boolean().default(true),
  roles: RolesMapSchema,
});
export type RolesConfig = z.infer<typeof RolesConfigSchema>;

export const LimitsConfigSchema = z.object({
  schema_version: z.literal(1),
  max_concurrent_slots: z.number().int().min(1).default(5),
  p0_extra_slot: z.boolean().default(true),
  max_waiting_wip: z.number().int().min(1).default(5),
  retries_per_stage: z.number().int().min(0).default(2),
  review_rounds: z.number().int().min(0).default(2),
  advisor_calls: z.number().int().min(0).default(1),
  max_card_tokens: z.number().int().min(1).default(250_000),
});
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;

export const ModelPricingSchema = z.object({
  in: z.number().finite().nonnegative(),
  cached: z.number().finite().nonnegative(),
  out: z.number().finite().nonnegative(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const PRICING_SYNC_SOURCES = ["models.dev", "litellm", "builtin"] as const;
export type PricingSyncSource = (typeof PRICING_SYNC_SOURCES)[number];
export const PricingSyncSourceSchema = z.enum(PRICING_SYNC_SOURCES);

export const PricingSyncMetaSchema = z.object({
  source: PricingSyncSourceSchema,
  synced_at: z.string().min(1),
});
export type PricingSyncMeta = z.infer<typeof PricingSyncMetaSchema>;

export const PricingConfigSchema = z.object({
  schema_version: z.literal(1),
  models: z.record(z.string().min(1), ModelPricingSchema),
  custom_models: z.array(z.string().min(1)).optional(),
  sync: PricingSyncMetaSchema.optional(),
});
export type PricingConfig = z.infer<typeof PricingConfigSchema>;

interface ParsedHttpUrlLike {
  protocol: string;
  hostname: string;
  search: string;
  hash: string;
}

type GlobalUrlCtor = new (input: string) => ParsedHttpUrlLike;

function parseHttpOrHttpsUrl(raw: string): ParsedHttpUrlLike | null {
  const UrlCtor = (globalThis as { URL?: GlobalUrlCtor }).URL;
  if (typeof UrlCtor === "function") {
    try {
      const parsed = new UrlCtor(raw);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.hostname.length > 0
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
  const fallbackMatch = /^(https?:)\/\/([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i.exec(raw);
  if (!fallbackMatch) {
    return null;
  }
  return {
    protocol: fallbackMatch[1]!.toLowerCase(),
    hostname: fallbackMatch[2]!,
    search: fallbackMatch[4] ?? "",
    hash: fallbackMatch[5] ?? "",
  };
}

function isValidHttpOrHttpsUrl(raw: string): boolean {
  return parseHttpOrHttpsUrl(raw) !== null;
}

export const PublicRemoteUrlSchema = z
  .string()
  .trim()
  .refine(isValidHttpOrHttpsUrl, {
    message: "public_url must be a valid https:// or http:// URL",
  })
  .refine(
    (raw) => {
      const parsed = parseHttpOrHttpsUrl(raw);
      return parsed !== null && parsed.search === "" && parsed.hash === "";
    },
    {
      message: "public_url must not contain query parameters or URL fragments",
    },
  );

export const RemoteNotificationChannelSchema = z.enum(REMOTE_NOTIFICATION_CHANNELS);

const RemoteNotificationPrioritySchema = z.enum(PRIORITIES);

const DEFAULT_NOTIFICATION_CONFIG = {
  enabled: false,
  channel: "webhook" as RemoteNotificationChannel,
  url: "",
  priorities: ["P0", "P1"] as Priority[],
};

export const RemoteNotificationsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    channel: RemoteNotificationChannelSchema.default("webhook"),
    url: z
      .string()
      .trim()
      .default("")
      .refine((v) => v === "" || isValidHttpOrHttpsUrl(v), {
        message: "notifications.url must be empty or a valid https:// or http:// URL",
      }),
    secret: z.string().min(1).optional(),
    priorities: z
      .array(RemoteNotificationPrioritySchema)
      .default(["P0", "P1"])
      .transform((arr) => Array.from(new Set(arr))),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.enabled && cfg.url.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "notifications.url is required when notifications are enabled",
        path: ["url"],
      });
    }
  });
export type RemoteNotificationsConfig = z.infer<typeof RemoteNotificationsConfigSchema>;

export const RemoteConfigSchema = z
  .object({
    schema_version: z.literal(1),
    enabled: z.boolean().default(false),
    remote_port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .refine((port) => port !== DEFAULT_LOCAL_PORT, {
        message: `remote_port must differ from default local port (${DEFAULT_LOCAL_PORT})`,
      })
      .default(DEFAULT_REMOTE_PORT),
    public_url: PublicRemoteUrlSchema.optional(),
    keep_awake_on_ac: z.boolean().default(false),
    notifications: RemoteNotificationsConfigSchema.default(() => ({
      ...DEFAULT_NOTIFICATION_CONFIG,
      priorities: [...DEFAULT_NOTIFICATION_CONFIG.priorities],
    })),
  })
  .strict();
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export function createDefaultRemoteConfig(): RemoteConfig {
  return RemoteConfigSchema.parse({ schema_version: 1 });
}

export const PairedDeviceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    token_sha256: z
      .string()
      .regex(SHA256_HEX_RE, "token_sha256 must be a 64-char lowercase hex SHA-256 hash"),
    created_at: z.string().min(1),
    last_seen_at: z.string().min(1),
    last_user_agent: z.string().min(1).optional(),
    revoked_at: z.string().min(1).optional(),
  })
  .strict();
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

export const PublicPairedDeviceSchema = PairedDeviceSchema.omit({
  token_sha256: true,
});
export type PublicPairedDevice = z.infer<typeof PublicPairedDeviceSchema>;

export const DevicesConfigSchema = z
  .object({
    schema_version: z.literal(1),
    devices: z.array(PairedDeviceSchema).default([]),
  })
  .strict();
export type DevicesConfig = z.infer<typeof DevicesConfigSchema>;
