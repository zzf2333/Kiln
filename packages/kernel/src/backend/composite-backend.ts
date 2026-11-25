import {
  createDefaultProvidersConfig,
  type BackendCapabilities,
  type PricingConfig,
  type ProviderAdapterKind,
  type ProviderEntry,
  type ProvidersConfig,
  type ProviderRuntimeStatus,
  type RunEvent,
  type SessionRef,
} from "@kiln/protocol";
import type { UsageTurnRow } from "../store/sqlite.js";
import { AcpBackend } from "./acp/index.js";
import { ClaudeDirectBackend } from "./claude-direct.js";
import { CodexAppServerBackend } from "./codex-app-server.js";
import { PaseoBackend } from "./paseo/index.js";
import { PiRpcBackend } from "./pi-rpc.js";
import { ProviderHealthTracker } from "./provider-health.js";
import { buildAgentCliEnv, probeCliBinary, type ProbeCliBinaryOptions } from "./stdio-rpc.js";
import type {
  ApprovalHandler,
  BackendAgentDescriptor,
  BackendModelDescriptor,
  BackendRunSpec,
  ProviderProbeSnapshot,
  ProviderTelemetryBackend,
  SessionProbeResult,
} from "./types.js";

const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

export type AdapterFactoryFn = (
  entry: ProviderEntry,
  healthTracker: ProviderHealthTracker,
) => ProviderTelemetryBackend;

export interface CompositeBackendOptions {
  backendId?: string;
  kilnHome?: string;
  initialConfig?: ProvidersConfig;
  healthTracker?: ProviderHealthTracker;
  adapterFactories?: Partial<Record<ProviderAdapterKind, AdapterFactoryFn>>;
  onProviderStatusChanged?: (status: ProviderRuntimeStatus) => void;
  getUsageContext?: () => { localTurns: readonly UsageTurnRow[]; pricing: PricingConfig | null };
  queryTimeoutMs?: number;
}

export interface TestProviderResult {
  status: ProviderRuntimeStatus;
  modelsCount: number;
  capabilities?: BackendCapabilities;
}

interface ChildBinding {
  entry: ProviderEntry;
  configKey: string;
  adapter: ProviderTelemetryBackend;
  unsubApproval: () => void;
}

interface WrappedSessionRecord {
  providerId: string;
  adapter: ProviderTelemetryBackend;
  wrappedRef: SessionRef;
  childRef: SessionRef;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return await promise;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function stableProviderConfigKey(entry: ProviderEntry): string {
  const sortedEnv = Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    id: entry.id,
    label: entry.label,
    adapter: entry.adapter,
    enabled: entry.enabled,
    command: entry.command ?? null,
    args: entry.args,
    env: sortedEnv,
    custom_models: entry.custom_models,
    usage_rule: entry.usage_rule ?? null,
    quota: entry.quota ?? null,
    paseo_url: entry.paseo_url ?? null,
  });
}

export interface DetectProvidersOptions {
  healthTracker?: ProviderHealthTracker;
  probeFn?: (command: string, options?: ProbeCliBinaryOptions) => ReturnType<typeof probeCliBinary>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Probes host availability for all configured non-Paseo providers and returns an updated
 * `ProvidersConfig` with `enabled` synced to whether each CLI is installed on the host.
 */
export async function detectProvidersConfigOnHost(
  config: ProvidersConfig,
  options: DetectProvidersOptions = {},
): Promise<ProvidersConfig> {
  const probeFn = options.probeFn ?? probeCliBinary;
  const tracker = options.healthTracker;
  const nextProviders = await Promise.all(
    config.providers.map(async (entry) => {
      if (entry.adapter === "paseo") {
        if (!entry.enabled) {
          tracker?.setAvailability(entry.id, {
            available: false,
            detail: "Paseo 历史兼容桥接已关闭",
          });
        }
        return {
          ...entry,
          args: [...entry.args],
          env: { ...entry.env },
          custom_models: [...entry.custom_models],
        };
      }

      const cmd = entry.command?.trim() || entry.id;
      const env = buildAgentCliEnv(entry.env, undefined, options.env);
      const probed = await probeFn(cmd, { env });
      if (probed.available) {
        tracker?.setAvailability(entry.id, {
          available: true,
          version: probed.version,
        });
      } else {
        tracker?.setAvailability(entry.id, {
          available: false,
          version: null,
          detail: probed.detail ?? `Command "${cmd}" not found`,
        });
      }
      return {
        ...entry,
        enabled: probed.available,
        args: [...entry.args],
        env: { ...entry.env },
        custom_models: [...entry.custom_models],
      };
    }),
  );

  return {
    schema_version: 1,
    providers: nextProviders,
  };
}

function createDefaultAdapter(
  entry: ProviderEntry,
  healthTracker: ProviderHealthTracker,
  kilnHome?: string,
): ProviderTelemetryBackend {
  switch (entry.adapter) {
    case "codex_app_server":
      return new CodexAppServerBackend({
        provider: entry,
        healthTracker,
        ...(kilnHome !== undefined ? { kilnHome } : {}),
      });
    case "pi_rpc":
      return new PiRpcBackend({ provider: entry, healthTracker });
    case "acp":
      return new AcpBackend({ provider: entry, healthTracker });
    case "claude_direct":
      return new ClaudeDirectBackend({ provider: entry, healthTracker });
    case "paseo":
      return new PaseoBackend({
        backendId: entry.id,
        ...(entry.paseo_url ? { url: entry.paseo_url } : {}),
      });
  }
}

/**
 * Multi-CLI / ACP orchestrating backend that routes agent runs to per-provider
 * adapters (`AcpBackend`, `CodexAppServerBackend`, `PiRpcBackend`, `ClaudeDirectBackend`,
 * or optional `PaseoBackend`) and aggregates approvals, cooldowns, and honest telemetry.
 */
export class CompositeBackend implements ProviderTelemetryBackend {
  readonly backendId: string;
  readonly healthTracker: ProviderHealthTracker;

  private readonly adapterFactories: Partial<Record<ProviderAdapterKind, AdapterFactoryFn>>;
  private readonly onProviderStatusChanged: ((status: ProviderRuntimeStatus) => void) | undefined;
  private readonly getUsageContext:
    | (() => { localTurns: readonly UsageTurnRow[]; pricing: PricingConfig | null })
    | undefined;
  private readonly queryTimeoutMs: number;
  private readonly kilnHome: string | undefined;

  private config: ProvidersConfig;
  private readonly children = new Map<string, ChildBinding>();
  private readonly sessions = new Map<string, WrappedSessionRecord>();
  private readonly childKeyToWrappedId = new Map<string, string>();
  private readonly approvalHandlers = new Set<ApprovalHandler>();
  private readonly pendingApprovals = new Map<
    string,
    { adapter: ProviderTelemetryBackend; childApprovalId: string }
  >();
  private disposed = false;

  constructor(options: CompositeBackendOptions = {}) {
    this.backendId = options.backendId ?? "composite";
    this.healthTracker = options.healthTracker ?? new ProviderHealthTracker();
    this.adapterFactories = options.adapterFactories ?? {};
    this.onProviderStatusChanged = options.onProviderStatusChanged;
    this.getUsageContext = options.getUsageContext;
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.kilnHome = options.kilnHome;
    this.config = options.initialConfig ?? createDefaultProvidersConfig();

    this.applyProvidersConfigSync(this.config, []);
  }

  getProvidersConfig(): ProvidersConfig {
    return this.config;
  }

  async syncFromConfig(nextConfig: ProvidersConfig): Promise<void> {
    this.assertNotDisposed();
    const toDispose: ProviderTelemetryBackend[] = [];
    this.applyProvidersConfigSync(nextConfig, toDispose);
    if (toDispose.length > 0) {
      await Promise.allSettled(toDispose.map((a) => Promise.resolve(a.dispose?.())));
    }
  }

  private applyProvidersConfigSync(
    nextConfig: ProvidersConfig,
    toDispose: ProviderTelemetryBackend[],
  ): void {
    this.config = nextConfig;
    const enabledEntries = nextConfig.providers.filter((p) => p.enabled);
    const nextIds = new Set(enabledEntries.map((p) => p.id));

    for (const [id, binding] of this.children) {
      if (!nextIds.has(id)) {
        binding.unsubApproval();
        this.children.delete(id);
        toDispose.push(binding.adapter);
      }
    }

    for (const entry of enabledEntries) {
      const nextKey = stableProviderConfigKey(entry);
      const existing = this.children.get(entry.id);
      if (existing && existing.configKey === nextKey) {
        continue;
      }
      if (existing) {
        existing.unsubApproval();
        this.children.delete(entry.id);
        toDispose.push(existing.adapter);
      }

      const customFactory = this.adapterFactories[entry.adapter];
      const adapter = customFactory
        ? customFactory(entry, this.healthTracker)
        : createDefaultAdapter(entry, this.healthTracker, this.kilnHome);
      const unsubApproval = adapter.onApproval((req) => {
        const wrappedSessionId =
          this.childKeyToWrappedId.get(`${entry.id}:${req.sessionRef.sessionId}`) ??
          `${entry.id}:${req.sessionRef.sessionId}`;
        const existingRec = this.sessions.get(wrappedSessionId);
        const wrappedSessionRef: SessionRef = existingRec
          ? existingRec.wrappedRef
          : {
              backendId: this.backendId,
              sessionId: wrappedSessionId,
              meta: {
                ...(req.sessionRef.meta ?? {}),
                providerId: entry.id,
              },
            };

        const wrappedApprovalId = `${entry.id}:${req.id}`;
        this.pendingApprovals.set(wrappedApprovalId, {
          adapter,
          childApprovalId: req.id,
        });

        const forwardedReq = {
          ...req,
          id: wrappedApprovalId,
          sessionRef: wrappedSessionRef,
        };
        for (const handler of this.approvalHandlers) {
          void Promise.resolve(handler(forwardedReq)).catch(() => {});
        }
      });

      this.children.set(entry.id, {
        entry,
        configKey: nextKey,
        adapter,
        unsubApproval,
      });
    }
  }

  async listAgents(): Promise<BackendAgentDescriptor[]> {
    this.assertNotDisposed();
    const results: BackendAgentDescriptor[] = [];

    await Promise.all(
      Array.from(this.children.values()).map(async ({ entry, adapter }) => {
        try {
          const agents = await withTimeout(
            adapter.listAgents(),
            this.queryTimeoutMs,
            `listAgents(${entry.id})`,
          );
          if (agents.length === 0) {
            return;
          }
          for (const agent of agents) {
            results.push({
              ...agent,
              id: agents.length === 1 ? entry.id : agent.id,
              label: agents.length === 1 ? entry.label : agent.label,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.healthTracker.setAvailability(entry.id, {
            available: false,
            detail: msg,
          });
        }
      }),
    );

    return results;
  }

  async listModels(agent: string): Promise<BackendModelDescriptor[]> {
    this.assertNotDisposed();
    const binding = this.requireBindingForAgent(agent);
    return await binding.adapter.listModels(agent);
  }

  async refreshProviders(): Promise<void> {
    this.assertNotDisposed();
    await Promise.allSettled(
      Array.from(this.children.values()).map(async ({ entry, adapter }) => {
        if (typeof adapter.refreshProviders === "function") {
          await withTimeout(
            adapter.refreshProviders(),
            Math.max(this.queryTimeoutMs, 10_000),
            `refreshProviders(${entry.id})`,
          );
        }
      }),
    );
  }

  async capabilities(agent: string): Promise<BackendCapabilities> {
    this.assertNotDisposed();
    const binding = this.requireBindingForAgent(agent);
    return await binding.adapter.capabilities(agent);
  }

  async start(runSpec: BackendRunSpec): Promise<SessionRef> {
    this.assertNotDisposed();
    const binding = this.requireBindingForAgent(runSpec.agent);
    const childRef = await binding.adapter.start(runSpec);
    const wrappedSessionId = `${binding.entry.id}:${childRef.sessionId}`;
    const wrappedRef: SessionRef = {
      backendId: this.backendId,
      sessionId: wrappedSessionId,
      meta: {
        ...(childRef.meta ?? {}),
        providerId: binding.entry.id,
        childBackendId: childRef.backendId,
      },
    };

    const record: WrappedSessionRecord = {
      providerId: binding.entry.id,
      adapter: binding.adapter,
      wrappedRef,
      childRef,
    };
    this.sessions.set(wrappedSessionId, record);
    this.childKeyToWrappedId.set(`${binding.entry.id}:${childRef.sessionId}`, wrappedSessionId);

    return {
      backendId: wrappedRef.backendId,
      sessionId: wrappedRef.sessionId,
      meta: wrappedRef.meta ? { ...wrappedRef.meta } : undefined,
    };
  }

  async send(sessionRef: SessionRef, message: string): Promise<void> {
    this.assertNotDisposed();
    const resolved = this.resolveChildSession(sessionRef);
    await resolved.adapter.send(resolved.childRef, message);
  }

  events(sessionRef: SessionRef): AsyncIterable<RunEvent> {
    const resolved = this.resolveChildSession(sessionRef);
    const healthTracker = this.healthTracker;
    const binding = this.children.get(resolved.providerId);
    const buildStatus = () => (binding ? this.buildStatusForEntry(binding.entry) : null);
    const emitStatus = this.onProviderStatusChanged;

    return (async function* () {
      for await (const ev of resolved.adapter.events(resolved.childRef)) {
        if (ev.kind === "rate_limited") {
          healthTracker.recordRateLimit(ev.provider, {
            ...(ev.retryAfterSec !== undefined ? { retryAfterSec: ev.retryAfterSec } : {}),
            ...(ev.until !== undefined ? { until: ev.until } : {}),
            ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
          });
          const status = buildStatus();
          if (status) {
            emitStatus?.(status);
          }
        }
        if (ev.kind === "approval") {
          yield {
            ...ev,
            id: `${resolved.providerId}:${ev.id}`,
          };
          continue;
        }
        yield ev;
      }
    })();
  }

  onApproval(handler: ApprovalHandler): () => void {
    this.approvalHandlers.add(handler);
    return () => {
      this.approvalHandlers.delete(handler);
    };
  }

  async answer(approvalId: string, allow: boolean, message?: string): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error(`Unknown or already resolved composite approval "${approvalId}"`);
    }
    this.pendingApprovals.delete(approvalId);
    await pending.adapter.answer(pending.childApprovalId, allow, message);
  }

  async cancel(sessionRef: SessionRef): Promise<void> {
    const resolved = this.resolveChildSession(sessionRef);
    await resolved.adapter.cancel(resolved.childRef);
  }

  async probe(sessionRef: SessionRef): Promise<SessionProbeResult> {
    const resolved = this.resolveChildSession(sessionRef);
    return await resolved.adapter.probe(resolved.childRef);
  }

  async liveViewUrl(sessionRef: SessionRef): Promise<string | null> {
    const resolved = this.resolveChildSession(sessionRef);
    return await resolved.adapter.liveViewUrl(resolved.childRef);
  }

  async listProviderUsage(): Promise<unknown[]> {
    this.assertNotDisposed();
    const out: unknown[] = [];
    for (const { entry, adapter } of this.children.values()) {
      if (typeof adapter.listProviderUsage === "function") {
        try {
          const items = await adapter.listProviderUsage();
          out.push(...items);
          continue;
        } catch {
          // Best effort
        }
      }
      if (typeof adapter.readNativeQuota === "function") {
        try {
          const quota = await adapter.readNativeQuota();
          if (quota) {
            this.healthTracker.setNativeQuota(entry.id, quota);
            out.push({
              providerId: entry.id,
              agent: entry.id,
              label: quota.source,
              usedPercent: quota.used_percent,
              ...(quota.resets_at ? { resetsAt: quota.resets_at } : {}),
              ...(quota.plan_type ? { planLabel: quota.plan_type } : {}),
            });
          }
        } catch {
          // Best effort
        }
      }
    }
    return out;
  }

  async testProvider(providerId: string): Promise<TestProviderResult> {
    this.assertNotDisposed();
    const entry = this.config.providers.find((p) => p.id === providerId);
    if (!entry) {
      throw new Error(`Unknown provider "${providerId}"`);
    }

    const binding = this.children.get(providerId);
    if (!entry.enabled || !binding) {
      this.healthTracker.setAvailability(providerId, {
        available: false,
        detail: "Provider is disabled",
      });
      const status = this.buildStatusForEntry(entry);
      return { status, modelsCount: 0 };
    }

    let snap: ProviderProbeSnapshot;
    if (typeof binding.adapter.probeProvider === "function") {
      snap = await binding.adapter.probeProvider();
    } else {
      try {
        const [agents, models] = await Promise.all([
          binding.adapter.listAgents(),
          binding.adapter.listModels(entry.id),
        ]);
        const caps = agents[0]?.capabilities;
        const available = agents.length > 0;
        this.healthTracker.setAvailability(providerId, {
          available,
          ...(available ? {} : { detail: "No agents discovered" }),
        });
        snap = {
          available,
          modelsCount: models.length,
          ...(caps ? { capabilities: caps } : {}),
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.healthTracker.setAvailability(providerId, { available: false, detail });
        snap = { available: false, detail, modelsCount: 0 };
      }
    }

    const status = this.buildStatusForEntry(entry);
    return {
      status,
      modelsCount: snap.modelsCount ?? 0,
      ...(snap.capabilities ? { capabilities: snap.capabilities } : {}),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const bindings = Array.from(this.children.values());
    this.children.clear();
    this.sessions.clear();
    this.childKeyToWrappedId.clear();
    this.pendingApprovals.clear();
    this.approvalHandlers.clear();

    for (const b of bindings) {
      b.unsubApproval();
    }
    await Promise.allSettled(bindings.map((b) => Promise.resolve(b.adapter.dispose?.())));
  }

  private buildStatusForEntry(entry: ProviderEntry): ProviderRuntimeStatus {
    const ctx = this.getUsageContext?.() ?? { localTurns: [], pricing: null };
    return this.healthTracker.buildRuntimeStatus(entry, ctx.localTurns, ctx.pricing);
  }

  private requireBindingForAgent(agent: string): ChildBinding {
    const direct = this.children.get(agent);
    if (direct) {
      return direct;
    }
    throw new Error(`No enabled provider adapter registered for agent "${agent}"`);
  }

  private resolveChildSession(sessionRef: SessionRef): WrappedSessionRecord {
    if (sessionRef.backendId !== this.backendId) {
      throw new Error(
        `Session backendId mismatch: expected "${this.backendId}", got "${sessionRef.backendId}"`,
      );
    }

    const existing = this.sessions.get(sessionRef.sessionId);
    if (existing) {
      return existing;
    }

    const colonIdx = sessionRef.sessionId.indexOf(":");
    const providerId =
      sessionRef.meta?.providerId?.trim() ||
      (colonIdx > 0 ? sessionRef.sessionId.slice(0, colonIdx) : "");
    const childSessionId =
      colonIdx > 0 ? sessionRef.sessionId.slice(colonIdx + 1) : sessionRef.sessionId;
    const binding = providerId ? this.children.get(providerId) : undefined;
    if (!binding) {
      throw new Error(`Unknown composite session "${sessionRef.sessionId}"`);
    }

    return {
      providerId,
      adapter: binding.adapter,
      wrappedRef: sessionRef,
      childRef: {
        backendId: sessionRef.meta?.childBackendId ?? binding.adapter.backendId,
        sessionId: childSessionId,
        ...(sessionRef.meta ? { meta: { ...sessionRef.meta } } : {}),
      },
    };
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`CompositeBackend "${this.backendId}" has been disposed`);
    }
  }
}
