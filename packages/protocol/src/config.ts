import { z } from "zod";
import {
  BUILTIN_ROSTER_ROLE_IDS,
  COST_SOURCES,
  DEFAULT_LOCAL_PORT,
  DEFAULT_REMOTE_PORT,
  PRIORITIES,
  PROVIDER_ADAPTER_KINDS,
  PROVIDER_USAGE_SCOPES,
  REASONING_EFFORTS,
  REMOTE_NOTIFICATION_CHANNELS,
  ROLE_IDS,
  ROSTER_EXECUTION_MODES,
  ROSTER_GROUPS,
  ROSTER_PERMISSIONS,
  SHA256_HEX_RE,
  STAGE_IDS,
  type BuiltinRosterRoleId,
  type CostSource,
  type Priority,
  type ProviderAdapterKind,
  type ProviderUsageScope,
  type ReasoningEffort,
  type RemoteNotificationChannel,
  type RoleId,
  type RosterExecutionMode,
  type RosterGroup,
  type RosterPermission,
  type StageId,
} from "./constants.js";

export {
  BUILTIN_ROSTER_ROLE_IDS,
  COST_SOURCES,
  DEFAULT_LOCAL_PORT,
  DEFAULT_REMOTE_PORT,
  PROVIDER_ADAPTER_KINDS,
  PROVIDER_USAGE_SCOPES,
  REASONING_EFFORTS,
  REMOTE_NOTIFICATION_CHANNELS,
  ROLE_IDS,
  ROSTER_EXECUTION_MODES,
  ROSTER_GROUPS,
  ROSTER_PERMISSIONS,
  SHA256_HEX_RE,
  type BuiltinRosterRoleId,
  type CostSource,
  type ProviderAdapterKind,
  type ProviderUsageScope,
  type ReasoningEffort,
  type RemoteNotificationChannel,
  type RoleId,
  type RosterExecutionMode,
  type RosterGroup,
  type RosterPermission,
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
  cache_write: z.number().finite().nonnegative().optional(),
  out: z.number().finite().nonnegative(),
  context_window: z.number().int().positive().optional(),
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

export const PROVIDER_OR_ROLE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export const ProviderAdapterKindSchema = z.enum(PROVIDER_ADAPTER_KINDS);
export const ProviderUsageScopeSchema = z.enum(PROVIDER_USAGE_SCOPES);

export const ProviderUsageRuleSchema = z
  .object({
    scope: ProviderUsageScopeSchema.default("per_turn"),
    input_includes_cache: z.boolean().default(false),
    reasoning_included_in_output: z.boolean().default(true),
  })
  .strict();
export type ProviderUsageRule = z.infer<typeof ProviderUsageRuleSchema>;

export const ProviderQuotaPolicySchema = z
  .object({
    soft_daily_usd: z.number().finite().positive().optional(),
    soft_weekly_usd: z.number().finite().positive().optional(),
    soft_monthly_usd: z.number().finite().positive().optional(),
  })
  .strict();
export type ProviderQuotaPolicy = z.infer<typeof ProviderQuotaPolicySchema>;

export const ProviderEntrySchema = z
  .object({
    id: z
      .string()
      .regex(
        PROVIDER_OR_ROLE_ID_RE,
        "id must be 1-48 chars matching ^[a-z0-9][a-z0-9_-]{0,47}$",
      ),
    label: z.string().min(1),
    adapter: ProviderAdapterKindSchema,
    enabled: z.boolean().default(true),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string().min(1), z.string()).default({}),
    custom_models: z.array(z.string().min(1)).default([]),
    usage_rule: ProviderUsageRuleSchema.optional(),
    quota: ProviderQuotaPolicySchema.optional(),
    paseo_url: z.string().min(1).optional(),
  })
  .strict();
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

export const ProvidersConfigSchema = z
  .object({
    schema_version: z.literal(1),
    providers: z.array(ProviderEntrySchema).default([]),
  })
  .strict();
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

export function createDefaultProvidersConfig(): ProvidersConfig {
  return ProvidersConfigSchema.parse({
    schema_version: 1,
    providers: [
      {
        id: "codex",
        label: "Codex CLI",
        adapter: "codex_app_server",
        command: "codex",
        args: ["app-server"],
        usage_rule: {
          scope: "cumulative_thread",
          input_includes_cache: true,
          reasoning_included_in_output: true,
        },
      },
      {
        id: "pi",
        label: "Pi Coding Agent",
        adapter: "pi_rpc",
        command: "pi",
        args: ["--mode", "rpc"],
        usage_rule: {
          scope: "per_message",
          input_includes_cache: false,
          reasoning_included_in_output: true,
        },
      },
      {
        id: "agy",
        label: "Antigravity CLI",
        adapter: "acp",
        command: "agy",
        args: ["acp", "--stdio", "--disable-telemetry"],
        usage_rule: {
          scope: "per_turn",
          input_includes_cache: false,
          reasoning_included_in_output: true,
        },
      },
      {
        id: "claude",
        label: "Claude Code",
        adapter: "claude_direct",
        command: "claude",
        args: ["-p", "--output-format", "stream-json", "--input-format", "stream-json"],
        usage_rule: {
          scope: "per_turn",
          input_includes_cache: false,
          reasoning_included_in_output: true,
        },
      },
      {
        id: "gemini",
        label: "Gemini CLI",
        adapter: "acp",
        command: "gemini",
        args: ["--experimental-acp"],
      },
      {
        id: "opencode",
        label: "OpenCode",
        adapter: "acp",
        command: "opencode",
        args: ["acp"],
      },
      {
        id: "paseo",
        label: "Paseo (Legacy Bridge)",
        adapter: "paseo",
        enabled: false,
      },
    ],
  });
}

export const RosterGroupSchema = z.enum(ROSTER_GROUPS);
export const RosterPermissionSchema = z.enum(ROSTER_PERMISSIONS);
export const RosterExecutionModeSchema = z.enum(ROSTER_EXECUTION_MODES);
const RosterStageIdSchema = z.enum(STAGE_IDS);

export const RosterModelBindingSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    backend_id: z.string().min(1).optional(),
    effort: ReasoningEffortSchema.optional(),
  })
  .strict();
export type RosterModelBinding = z.infer<typeof RosterModelBindingSchema>;

export const PmOrchestrationPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    allow_auto_tester: z.boolean().default(true),
    prefer_unthrottled: z.boolean().default(true),
    require_review_for_core: z.boolean().default(true),
  })
  .strict();
export type PmOrchestrationPolicy = z.infer<typeof PmOrchestrationPolicySchema>;

export const RosterEntrySchema = z
  .object({
    group: RosterGroupSchema,
    enabled: z.boolean(),
    name: z.string().min(1),
    stage: RosterStageIdSchema,
    secondary_stages: z.array(RosterStageIdSchema).default([]),
    perm: RosterPermissionSchema,
    traits: z.string().min(1),
    mode: RosterExecutionModeSchema.default("agent"),
    primary: RosterModelBindingSchema.optional(),
    fallbacks: z.array(RosterModelBindingSchema).default([]),
    avoid_same_as: RosterStageIdSchema.optional(),
    allow_full_access_fallback: z.boolean().default(false),
    builtin: z.boolean().default(false),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.mode === "agent" && entry.enabled && !entry.primary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enabled agent-mode roster entry requires a primary model binding",
        path: ["primary"],
      });
    }
  });
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const RosterConfigSchema = z
  .object({
    schema_version: z.literal(2),
    heterogeneous_review: z.boolean().default(true),
    pm_orchestration: PmOrchestrationPolicySchema.default({
      enabled: true,
      allow_auto_tester: true,
      prefer_unthrottled: true,
      require_review_for_core: true,
    }),
    roster: z.record(
      z
        .string()
        .regex(
          PROVIDER_OR_ROLE_ID_RE,
          "roster key must match ^[a-z0-9][a-z0-9_-]{0,47}$",
        ),
      RosterEntrySchema,
    ),
  })
  .strict();
export type RosterConfig = z.infer<typeof RosterConfigSchema>;

const DEFAULT_ROSTER_SEED: Record<
  BuiltinRosterRoleId,
  Omit<RosterEntry, "fallbacks" | "allow_full_access_fallback"> & {
    secondary_stages?: StageId[];
  }
> = {
  pm: {
    group: "core",
    enabled: false,
    name: "立项 PM",
    stage: "intake",
    secondary_stages: [],
    perm: "read_only_draft",
    traits: "需求摸底、收敛分叉、拆片评估与按各 Agent 名称及特性自主排兵点将",
    mode: "agent",
    builtin: true,
  },
  researcher: {
    group: "core",
    enabled: false,
    name: "调研侦察",
    stage: "research",
    secondary_stages: [],
    perm: "read_only",
    traits: "跨文件广度摸底、文档查证、三方探针与选型对比（严格只读）",
    mode: "agent",
    builtin: true,
  },
  architect: {
    group: "core",
    enabled: false,
    name: "架构方案",
    stage: "plan",
    secondary_stages: ["advise"],
    perm: "read_only",
    traits: "事前疑难拆解出 PLAN.md，事中兼任技术顾问裁决技术分歧与停滞破局",
    mode: "agent",
    builtin: true,
  },
  main_dev: {
    group: "core",
    enabled: false,
    name: "主力开发",
    stage: "implement",
    secondary_stages: [],
    perm: "workspace_write",
    traits: "复杂功能、跨文件重构与核心状态机实现，推理严谨稳定",
    mode: "agent",
    builtin: true,
  },
  fast_fix: {
    group: "core",
    enabled: false,
    name: "快修开发",
    stage: "implement",
    secondary_stages: [],
    perm: "workspace_write",
    traits: "低风险单点微调、文案细节修改与小修，极速低成本",
    mode: "agent",
    builtin: true,
  },
  reviewer: {
    group: "core",
    enabled: false,
    name: "异构审查",
    stage: "review",
    secondary_stages: [],
    perm: "read_only",
    traits: "全新上下文只读固定提交与回归拦截，强制避开当前实施者模型家族",
    mode: "agent",
    avoid_same_as: "implement",
    builtin: true,
  },
  verifier: {
    group: "core",
    enabled: false,
    name: "真实验收",
    stage: "accept",
    secondary_stages: [],
    perm: "accept_entry",
    traits: "从真实浏览器/CLI/产物走端到端验收场景，核查交互体验与输出质量",
    mode: "agent",
    builtin: true,
  },
  frontend_ui: {
    group: "specialist",
    enabled: false,
    name: "前端视觉精修",
    stage: "implement",
    secondary_stages: [],
    perm: "workspace_write",
    traits: "擅长视觉层次、CSS 响应式布局、微动效与去 AI 味精修",
    mode: "agent",
    builtin: true,
  },
  debugger: {
    group: "specialist",
    enabled: false,
    name: "疑难排障专家",
    stage: "research",
    secondary_stages: [],
    perm: "read_only",
    traits: "专攻偶发 Bug、并发竞态与性能剖析；先复现取证锁定根因",
    mode: "agent",
    builtin: true,
  },
  ops_sec: {
    group: "specialist",
    enabled: false,
    name: "本机运维安全",
    stage: "implement",
    secondary_stages: [],
    perm: "host_staged",
    traits: "擅长 Shell、系统配置清理与最小改动，严守 host_scoped 仅写沙盒 staged/",
    mode: "agent",
    builtin: true,
  },
  doc_writer: {
    group: "specialist",
    enabled: false,
    name: "文档变更同步",
    stage: "implement",
    secondary_stages: [],
    perm: "workspace_write",
    traits: "专注同步更新 README、设计文档与变更说明，措辞克制准确",
    mode: "agent",
    builtin: true,
  },
  tester: {
    group: "kernel",
    enabled: true,
    name: "独立测试",
    stage: "verify",
    secondary_stages: [],
    perm: "kernel_gate",
    traits: "默认确定性内核 0 Token 跑冻结门禁；高并发或缺单测时可切 Agent 补用例",
    mode: "kernel",
    builtin: true,
  },
  deliverer: {
    group: "kernel",
    enabled: true,
    name: "合并交付",
    stage: "deliver",
    secondary_stages: [],
    perm: "kernel_gate",
    traits: "默认内核 0 Token 执行 merge_main 或两阶段原子落盘；复杂冲突可切 Agent",
    mode: "kernel",
    builtin: true,
  },
  triage: {
    group: "kernel",
    enabled: false,
    name: "异常研判",
    stage: "triage",
    secondary_stages: [],
    perm: "read_only",
    traits: "核查失败与阻塞事实，决定重试、调优或升级（内核协同位）",
    mode: "agent",
    builtin: true,
  },
  resolver: {
    group: "kernel",
    enabled: false,
    name: "讨论对话",
    stage: "intake",
    secondary_stages: ["advise"],
    perm: "read_only_draft",
    traits: "载入全卡上下文陪人处理待决问题（内核协同位）",
    mode: "agent",
    builtin: true,
  },
};

export function createDefaultBuiltinRosterMetadata(): Record<BuiltinRosterRoleId, RosterEntry> {
  const out = {} as Record<BuiltinRosterRoleId, RosterEntry>;
  for (const id of BUILTIN_ROSTER_ROLE_IDS) {
    out[id] = RosterEntrySchema.parse({
      ...DEFAULT_ROSTER_SEED[id],
      secondary_stages: [...(DEFAULT_ROSTER_SEED[id].secondary_stages ?? [])],
      fallbacks: [],
      allow_full_access_fallback: false,
    });
  }
  return out;
}

const LEGACY_TO_ROSTER_KEY: Readonly<Record<RoleId, BuiltinRosterRoleId>> = {
  intake: "pm",
  worker: "main_dev",
  advisor: "architect",
  reviewer: "reviewer",
  verifier: "verifier",
  triage: "triage",
  resolver: "resolver",
};

function toRosterBinding(assignment: RoleAssignment | RoleFallback): RosterModelBinding {
  return {
    provider: assignment.agent,
    model: assignment.model,
    ...(assignment.backend_id ? { backend_id: assignment.backend_id } : {}),
    ...(assignment.reasoning_effort ? { effort: assignment.reasoning_effort } : {}),
  };
}

function toLegacyAssignment(entry: RosterEntry, avoidSameAs?: RoleId): RoleAssignment | undefined {
  if (!entry.primary) {
    return undefined;
  }
  const fb = entry.fallbacks[0];
  return RoleAssignmentSchema.parse({
    agent: entry.primary.provider,
    model: entry.primary.model,
    ...(entry.primary.backend_id ? { backend_id: entry.primary.backend_id } : {}),
    ...(entry.primary.effort ? { reasoning_effort: entry.primary.effort } : {}),
    ...(fb
      ? {
          fallback: {
            agent: fb.provider,
            model: fb.model,
            ...(fb.backend_id ? { backend_id: fb.backend_id } : {}),
            ...(fb.effort ? { reasoning_effort: fb.effort } : {}),
          },
        }
      : {}),
    ...(avoidSameAs ? { avoid_same_model_as: avoidSameAs } : {}),
    allow_full_access_fallback: entry.allow_full_access_fallback,
  });
}

/**
 * Upgrades `v0.0.4` 7-role `roles.yaml` into `v0.0.5` `roster.yaml` without losing bindings.
 */
export function migrateRolesConfigToRoster(rolesConfig: RolesConfig): RosterConfig {
  const roster = createDefaultBuiltinRosterMetadata() as Record<string, RosterEntry>;

  for (const roleId of ROLE_IDS) {
    const legacy = rolesConfig.roles[roleId];
    if (!legacy) continue;
    const targetId = LEGACY_TO_ROSTER_KEY[roleId];
    const base = roster[targetId]!;
    roster[targetId] = RosterEntrySchema.parse({
      ...base,
      enabled: true,
      mode: "agent",
      primary: toRosterBinding(legacy),
      fallbacks: legacy.fallback ? [toRosterBinding(legacy.fallback)] : [],
      allow_full_access_fallback: legacy.allow_full_access_fallback,
    });
  }

  return RosterConfigSchema.parse({
    schema_version: 2,
    heterogeneous_review: rolesConfig.heterogeneous_review,
    pm_orchestration: {},
    roster,
  });
}

/**
 * Projects `v0.0.5` `roster.yaml` back into legacy 7-role `RolesConfig` for backward compatibility.
 */
export function deriveLegacyRolesConfigFromRoster(rosterConfig: RosterConfig): RolesConfig {
  const roles: Partial<Record<RoleId, RoleAssignment>> = {};
  for (const roleId of ROLE_IDS) {
    const rosterKey = LEGACY_TO_ROSTER_KEY[roleId];
    const entry = rosterConfig.roster[rosterKey];
    if (!entry || !entry.enabled) continue;
    const mapped = toLegacyAssignment(entry, roleId === "reviewer" ? "worker" : undefined);
    if (mapped) {
      roles[roleId] = mapped;
    }
  }
  return RolesConfigSchema.parse({
    schema_version: 1,
    heterogeneous_review: rosterConfig.heterogeneous_review,
    roles,
  });
}
