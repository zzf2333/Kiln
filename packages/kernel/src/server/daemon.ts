import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type {
  DiscoverSpacesResponse,
  OpenRunTuiResponse,
  PickDirectoryResponse,
  ProviderRuntimeStatus,
  ProvidersConfig,
  RemoteConfig,
  RoleId,
  RunMeta,
  RunTokenClaims,
  SyncPricingRequest,
  SyncPricingResponse,
  TailscaleStatusResponse,
} from "@kiln/protocol";
import {
  BackendRegistry,
  CompositeBackend,
  ProviderHealthTracker,
  detectProvidersConfigOnHost,
  probeCliBinary,
  type TestProviderResult,
} from "../backend/index.js";
import { TaskStateMachine } from "../state/index.js";
import { KilnStore, writeFileAtomic, type AcquireStageLeaseResult } from "../store/index.js";
import { CaffeinateController } from "./caffeinate.js";
import { KilnChatEngine, type ChatResponder, type McpCommandSpec } from "./chat.js";
import { ServerHttpError } from "./errors.js";
import {
  createHttpApiApp,
  type HttpApiDependencies,
  type RemoteRuntimeStatus,
} from "./http-api.js";
import type { IpcTransportMode } from "./ipc-http.js";
import { McpRpcServer, type McpRpcHttpRequest, type McpRpcHttpResponse } from "./mcp-rpc.js";
import {
  KilnOrchestrator,
  type DeliverHandler,
  type OrchestratorApprovalHandler,
} from "./orchestrator.js";
import {
  computeUsageSnapshot,
  countRunningLeafTasks,
  PendingDecisionStore,
} from "./pending-decisions.js";
import { LiveRateTracker } from "./rate-tracker.js";
import { RemoteAuthManager } from "./remote-auth.js";
import { RemoteNotifier } from "./remote-notify.js";
import { inspectTailscaleStatus, type TailscaleExecFileFn } from "./remote-tailscale.js";
import { syncModelPricing as syncModelPricingImpl } from "./pricing-sync.js";
import type { PrDeliverExecFn } from "./pr-deliver.js";
import { KilnScriptRunner } from "./script-runner.js";
import { SseHub } from "./sse.js";
import type { AcceptEnvStarterFn } from "./accept-env.js";
import type { EmbeddedStaticAssets } from "./static-files.js";
import { signRunToken, verifyRunToken } from "./token.js";

export const DEFAULT_KILND_HOST = "127.0.0.1";
export const DEFAULT_KILND_PORT = 4310;
export const DEFAULT_SERVER_VERSION = "0.0.6";
const HTTP_CLOSE_GRACE_MS = 350;

export interface KilndServerOptions {
  kilnHome?: string;
  store?: KilnStore;
  stateMachine?: TaskStateMachine;
  backendRegistry?: BackendRegistry;
  providerHealth?: ProviderHealthTracker;
  sseHub?: SseHub;
  caffeinate?: CaffeinateController;
  remoteAuth?: RemoteAuthManager;
  remoteNotifier?: RemoteNotifier;
  host?: string;
  port?: number;
  /** Optional override for the remote HTTP listener port (e.g., `0` for ephemeral port in tests). */
  remotePort?: number;
  socketPath?: string;
  ipcTransportMode?: IpcTransportMode;
  tokenSecret?: string | Buffer;
  version?: string;
  acceptEnvStarter?: AcceptEnvStarterFn;
  maxRpcBodyBytes?: number;
  enableOrchestrator?: boolean;
  publicDir?: string | null;
  embeddedPublicAssets?: EmbeddedStaticAssets | null;
  deliverHandler?: DeliverHandler;
  approvalHandler?: OrchestratorApprovalHandler;
  mcpServerCommand?: McpCommandSpec;
  chatResponder?: ChatResponder;
  rateWindowMs?: number;
  rateTickIntervalMs?: number;
  backendQueryTimeoutMs?: number;
  rateLimitCooldownMs?: number;
  notifyFetchImpl?: typeof fetch;
  notifyTimeoutMs?: number;
  tailscaleExecFile?: TailscaleExecFileFn;
  remoteAuthNow?: () => number;
  shutdownToken?: string;
  onShutdownRequested?: () => Promise<void> | void;
  discoverSpaces?: () => Promise<DiscoverSpacesResponse>;
  pickDirectory?: () => Promise<PickDirectoryResponse>;
  revealPath?: (targetPath: string) => Promise<{ ok: true; path: string }>;
  openRunTui?: (input: { taskId: string; runDir: string }) => Promise<OpenRunTuiResponse>;
  pricingFetchImpl?: typeof fetch;
  pricingCacheTtlMs?: number;
  pricingFetchTimeoutMs?: number;
  syncPricing?: (input: SyncPricingRequest) => Promise<SyncPricingResponse>;
  extensionsHomeDir?: string;
  scriptRunner?: KilnScriptRunner;
  prDeliverExec?: PrDeliverExecFn;
  stallCheckIntervalMs?: number;
  orchestratorNowMs?: () => number;
}

export interface KilndServerAddress {
  port: number;
  baseUrl: string;
  socketPath: string;
  remotePort?: number;
  remoteBaseUrl?: string;
}

export interface KilndRemoteAddress {
  port: number;
  baseUrl: string;
}

export interface IssueRunTokenInput {
  taskId: string;
  runId: string;
  role: RoleId;
  contractVersion: number;
  sessionKey?: string;
  iat?: number;
  exp?: number;
  ttlSeconds?: number;
}

function normalizeTokenSecret(secret?: string | Buffer): Buffer {
  if (secret === undefined) {
    return crypto.randomBytes(32);
  }
  const buf = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (buf.length === 0) {
    throw new Error("KilndServer tokenSecret must be non-empty when provided");
  }
  return buf;
}

/**
 * Main Kiln local-first daemon hosting:
 * - HTTP REST + SSE server bound to `127.0.0.1` (`4310` by default)
 * - Unix Domain Socket MCP RPC server (`kilnd.sock`, mode `0600`)
 * - Disk-backed `PendingDecisionStore`, `SseHub`, and dynamic macOS `CaffeinateController`
 */
export class KilndServer {
  readonly store: KilnStore;
  readonly stateMachine: TaskStateMachine;
  readonly backendRegistry: BackendRegistry;
  readonly providerHealth: ProviderHealthTracker;
  readonly sseHub: SseHub;
  readonly scriptRunner: KilnScriptRunner;
  readonly caffeinate: CaffeinateController;
  readonly remoteAuth: RemoteAuthManager;
  readonly remoteNotifier: RemoteNotifier;
  readonly pendingDecisions: PendingDecisionStore;
  readonly rateTracker: LiveRateTracker;
  readonly chatEngine: KilnChatEngine;
  readonly orchestrator: KilnOrchestrator;
  readonly enableOrchestrator: boolean;
  readonly app: Hono;
  readonly remoteApp: Hono;
  readonly host: string;
  readonly requestedPort: number;
  readonly requestedRemotePort: number | undefined;
  readonly socketPath: string;

  private readonly ownsStore: boolean;
  private readonly ownsBackendRegistry: boolean;
  private readonly tokenSecret: Buffer;
  private readonly pinnedShutdownToken: string | undefined;
  private readonly mcpRpcServer: McpRpcServer;
  private readonly unsubscribeNotify: () => void;
  private readonly customSyncPricing:
    | ((input: SyncPricingRequest) => Promise<SyncPricingResponse>)
    | undefined;
  private readonly pricingFetchImpl: typeof fetch | undefined;
  private readonly pricingCacheTtlMs: number | undefined;
  private readonly pricingFetchTimeoutMs: number | undefined;
  private readonly extensionsHomeDir: string | undefined;

  private activeShutdownToken: string | null = null;
  private httpServer: ServerType | null = null;
  private activeAddress: KilndServerAddress | null = null;
  private remoteHttpServer: ServerType | null = null;
  private activeRemoteAddress: KilndRemoteAddress | null = null;
  private remoteConfigQueue: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(options: KilndServerOptions = {}) {
    this.ownsStore = options.store === undefined;
    this.ownsBackendRegistry = options.backendRegistry === undefined;

    this.store = options.store ?? new KilnStore({ kilnHome: options.kilnHome });
    this.stateMachine = options.stateMachine ?? new TaskStateMachine(this.store);
    this.backendRegistry = options.backendRegistry ?? new BackendRegistry();
    this.providerHealth = options.providerHealth ?? new ProviderHealthTracker();
    this.sseHub = options.sseHub ?? new SseHub();
    this.scriptRunner =
      options.scriptRunner ?? new KilnScriptRunner({ store: this.store, sseHub: this.sseHub });
    this.caffeinate = options.caffeinate ?? new CaffeinateController();
    this.remoteAuth =
      options.remoteAuth ??
      new RemoteAuthManager({
        store: this.store,
        sseHub: this.sseHub,
        ...(options.remoteAuthNow !== undefined ? { now: options.remoteAuthNow } : {}),
      });
    this.remoteNotifier =
      options.remoteNotifier ??
      new RemoteNotifier({
        store: this.store,
        ...(options.notifyFetchImpl !== undefined ? { fetchImpl: options.notifyFetchImpl } : {}),
        ...(options.notifyTimeoutMs !== undefined ? { timeoutMs: options.notifyTimeoutMs } : {}),
      });
    this.pendingDecisions = new PendingDecisionStore(this.store);
    this.enableOrchestrator = options.enableOrchestrator ?? false;

    this.host = options.host ?? DEFAULT_KILND_HOST;
    this.requestedPort = options.port ?? DEFAULT_KILND_PORT;
    this.requestedRemotePort = options.remotePort;
    this.socketPath = options.socketPath ?? this.store.paths.kilndSock;
    this.tokenSecret = normalizeTokenSecret(options.tokenSecret);
    this.pinnedShutdownToken = options.shutdownToken;
    this.customSyncPricing = options.syncPricing;
    this.pricingFetchImpl = options.pricingFetchImpl;
    this.pricingCacheTtlMs = options.pricingCacheTtlMs;
    this.pricingFetchTimeoutMs = options.pricingFetchTimeoutMs;
    this.extensionsHomeDir = options.extensionsHomeDir;

    this.unsubscribeNotify = this.sseHub.subscribe((event) => {
      if (event.type === "decision.requested") {
        void this.remoteNotifier.notifyDecisionRequested({
          taskId: event.taskId,
          priority: event.priority,
          question: event.question,
        });
      }
    });

    this.rateTracker = new LiveRateTracker({
      ...(options.rateWindowMs !== undefined ? { windowMs: options.rateWindowMs } : {}),
      ...(options.rateTickIntervalMs !== undefined
        ? { tickIntervalMs: options.rateTickIntervalMs }
        : {}),
      getCostUsd: () => {
        const pricing = this.store.readConfig("pricing");
        return computeUsageSnapshot(this.store.listUsageTurns(), pricing).costUsd;
      },
      onTick: (payload) => {
        this.sseHub.publish({
          type: "rate.tick",
          rates: payload.rates,
          totals: payload.totals,
        });
      },
    });

    const issueToken = (input: IssueRunTokenInput) => this.issueRunToken(input);

    this.chatEngine = new KilnChatEngine({
      store: this.store,
      backendRegistry: this.backendRegistry,
      pendingDecisions: this.pendingDecisions,
      stateMachine: this.stateMachine,
      providerHealth: this.providerHealth,
      sseHub: this.sseHub,
      caffeinate: this.caffeinate,
      rateTracker: this.rateTracker,
      socketPath: this.socketPath,
      issueRunToken: issueToken,
      onContractUpdated: (taskId) => {
        void (async () => {
          await this.orchestrator.abortActiveRun(taskId);
          await this.orchestrator.wake();
        })();
      },
      ...(options.mcpServerCommand !== undefined
        ? { mcpServerCommand: options.mcpServerCommand }
        : {}),
      ...(options.chatResponder !== undefined ? { chatResponder: options.chatResponder } : {}),
      ...(options.extensionsHomeDir !== undefined
        ? { extensionsHomeDir: options.extensionsHomeDir }
        : {}),
    });

    this.orchestrator = new KilnOrchestrator({
      store: this.store,
      stateMachine: this.stateMachine,
      backendRegistry: this.backendRegistry,
      pendingDecisions: this.pendingDecisions,
      sseHub: this.sseHub,
      caffeinate: this.caffeinate,
      rateTracker: this.rateTracker,
      socketPath: this.socketPath,
      issueRunToken: issueToken,
      ...(options.mcpServerCommand !== undefined
        ? { mcpServerCommand: options.mcpServerCommand }
        : {}),
      ...(options.deliverHandler !== undefined ? { deliverHandler: options.deliverHandler } : {}),
      ...(options.approvalHandler !== undefined
        ? { approvalHandler: options.approvalHandler }
        : {}),
      ...(options.rateLimitCooldownMs !== undefined
        ? { rateLimitCooldownMs: options.rateLimitCooldownMs }
        : {}),
      providerHealth: this.providerHealth,
      scriptRunner: this.scriptRunner,
      remoteNotifier: this.remoteNotifier,
      ...(options.acceptEnvStarter !== undefined
        ? { acceptEnvStarter: options.acceptEnvStarter }
        : {}),
      ...(options.stallCheckIntervalMs !== undefined
        ? { stallCheckIntervalMs: options.stallCheckIntervalMs }
        : {}),
      ...(options.orchestratorNowMs !== undefined ? { nowMs: options.orchestratorNowMs } : {}),
    });

    const inspectTailscale = (remotePort: number): Promise<TailscaleStatusResponse> =>
      inspectTailscaleStatus({
        remotePort,
        ...(options.tailscaleExecFile !== undefined
          ? { execFileImpl: options.tailscaleExecFile }
          : {}),
      });

    const sharedHttpDeps: HttpApiDependencies = {
      store: this.store,
      stateMachine: this.stateMachine,
      sseHub: this.sseHub,
      pendingDecisions: this.pendingDecisions,
      caffeinate: this.caffeinate,
      backendRegistry: this.backendRegistry,
      providerHealth: this.providerHealth,
      testProvider: (providerId) => this.testProvider(providerId),
      detectProviders: () => this.detectProviders(),
      rateTracker: this.rateTracker,
      chatEngine: this.chatEngine,
      scriptRunner: this.scriptRunner,
      ...(options.prDeliverExec !== undefined ? { prDeliverExec: options.prDeliverExec } : {}),
      remoteAuth: this.remoteAuth,
      remoteNotifier: this.remoteNotifier,
      getLocalPort: () => this.activeAddress?.port ?? this.requestedPort,
      getRemoteRuntimeStatus: () => this.getRemoteRuntimeStatus(),
      onRemoteConfigUpdated: (nextConfig) => this.applyRemoteConfig(nextConfig),
      inspectTailscale,
      ...(options.discoverSpaces !== undefined ? { discoverSpaces: options.discoverSpaces } : {}),
      ...(options.pickDirectory !== undefined ? { pickDirectory: options.pickDirectory } : {}),
      ...(options.revealPath !== undefined ? { revealPath: options.revealPath } : {}),
      ...(options.openRunTui !== undefined ? { openRunTui: options.openRunTui } : {}),
      ...(options.extensionsHomeDir !== undefined
        ? { extensionsHomeDir: options.extensionsHomeDir }
        : {}),
      syncPricing: (input) => this.syncModelPricing(input),
      ...(options.publicDir !== undefined ? { publicDir: options.publicDir } : {}),
      ...(options.embeddedPublicAssets !== undefined
        ? { embeddedPublicAssets: options.embeddedPublicAssets }
        : {}),
      ...(options.backendQueryTimeoutMs !== undefined
        ? { backendQueryTimeoutMs: options.backendQueryTimeoutMs }
        : {}),
      onTaskQueued: () => {
        void this.orchestrator.wake();
      },
      onTaskPaused: async (taskId) => {
        await this.orchestrator.abortActiveRun(taskId);
        void this.orchestrator.wake();
      },
      onTaskSteered: (taskId, input) => this.orchestrator.steerTask(taskId, input),
      onTaskCancelled: async (taskId) => {
        await this.orchestrator.abortActiveRun(taskId);
        this.orchestrator.handleTaskTerminatedRetro(taskId);
        void this.orchestrator.wake();
      },
      onTaskDeleted: async (taskId, card) => {
        await this.orchestrator.cleanupDeletedTask(taskId, card);
      },
      triggerTaskRetro: (taskId, useAi) => this.orchestrator.triggerTaskRetro(taskId, { useAi }),
      onBeforeDecisionApply: async (taskId) => {
        await this.orchestrator.abortActiveRun(taskId);
      },
      onApproveSubtaskSplit: async (taskId, decisionId, opts) => {
        await this.orchestrator.approvePendingSubtaskSplit(taskId, decisionId, opts);
      },
      getActiveAcceptEnv: (taskId) => this.orchestrator.getActiveAcceptEnvSnapshot(taskId),
      onSettingsUpdated: async (section) => {
        if (section === "roles" || section === "roster") {
          void this.orchestrator.wake();
          if (
            fs.existsSync(this.store.paths.pricingCacheFile) ||
            this.pricingFetchImpl !== undefined
          ) {
            void this.syncModelPricing({ force: false }).catch(() => undefined);
          }
        } else if (section === "providers") {
          const nextProviders = this.store.readEffectiveProvidersConfig();
          for (const backend of this.backendRegistry.list()) {
            if (backend instanceof CompositeBackend) {
              await backend.syncFromConfig(nextProviders);
            }
          }
          void this.orchestrator.wake();
          if (
            fs.existsSync(this.store.paths.pricingCacheFile) ||
            this.pricingFetchImpl !== undefined
          ) {
            void this.syncModelPricing({ force: false }).catch(() => undefined);
          }
        } else if (section === "limits") {
          void this.orchestrator.wake();
        } else if (
          section === "pricing" &&
          this.enableOrchestrator &&
          this.rateTracker.snapshot().tokPerSec > 0
        ) {
          this.rateTracker.emitTick();
        }
      },
      version: options.version ?? DEFAULT_SERVER_VERSION,
    };

    this.app = createHttpApiApp({
      ...sharedHttpDeps,
      listenerMode: "local",
    });

    this.remoteApp = createHttpApiApp({
      ...sharedHttpDeps,
      listenerMode: "remote",
    });

    this.mcpRpcServer = new McpRpcServer({
      store: this.store,
      stateMachine: this.stateMachine,
      sseHub: this.sseHub,
      pendingDecisions: this.pendingDecisions,
      caffeinate: this.caffeinate,
      tokenSecret: this.tokenSecret,
      socketPath: this.socketPath,
      ...(options.ipcTransportMode !== undefined
        ? { transportMode: options.ipcTransportMode }
        : {}),
      maxBodyBytes: options.maxRpcBodyBytes,
      shutdownToken: this.pinnedShutdownToken,
      onShutdownRequested: options.onShutdownRequested ?? (() => this.stop()),
      onTaskQueued: () => {
        void this.orchestrator.wake();
      },
      onContractUpdated: (taskId) => {
        void (async () => {
          await this.orchestrator.abortActiveRun(taskId);
          await this.orchestrator.wake();
        })();
      },
      onDecisionRequested: (taskId) => {
        void (async () => {
          await this.orchestrator.abortActiveRun(taskId);
          await this.orchestrator.wake();
        })();
      },
      onTechnicalDecisionForAdvisor: (params) =>
        this.orchestrator.tryRouteTechnicalDecisionToAdvisor(params),
    });
  }

  get address(): KilndServerAddress | null {
    if (!this.activeAddress) {
      return null;
    }
    return {
      ...this.activeAddress,
      ...(this.activeRemoteAddress
        ? {
            remotePort: this.activeRemoteAddress.port,
            remoteBaseUrl: this.activeRemoteAddress.baseUrl,
          }
        : {}),
    };
  }

  get remoteAddress(): KilndRemoteAddress | null {
    return this.activeRemoteAddress ? { ...this.activeRemoteAddress } : null;
  }

  getRemoteRuntimeStatus(): RemoteRuntimeStatus {
    return this.activeRemoteAddress
      ? {
          listening: true,
          port: this.activeRemoteAddress.port,
          baseUrl: this.activeRemoteAddress.baseUrl,
        }
      : {
          listening: false,
          port: null,
          baseUrl: null,
        };
  }

  private async bindHttpApp(
    app: Hono,
    port: number,
  ): Promise<{ server: ServerType; port: number; baseUrl: string }> {
    const server = await new Promise<ServerType>((resolve, reject) => {
      let settled = false;
      let createdServer: ServerType | null = null;

      const onError = (err: Error): void => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      createdServer = serve(
        {
          fetch: app.fetch,
          hostname: this.host,
          port,
          overrideGlobalObjects: false,
        },
        () => {
          if (settled) return;
          settled = true;
          createdServer?.removeListener("error", onError);
          resolve(createdServer!);
        },
      );
      if ("requestTimeout" in createdServer) {
        (createdServer as http.Server).requestTimeout = 0;
      }
      createdServer.once("error", onError);
    });

    const rawAddr = server.address() as AddressInfo | string | null;
    if (!rawAddr || typeof rawAddr === "string") {
      server.close();
      throw new Error("KilndServer HTTP server failed to bind a TCP port");
    }

    return {
      server,
      port: rawAddr.port,
      baseUrl: `http://${this.host}:${rawAddr.port}`,
    };
  }

  private async closeHttpServer(server: ServerType): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let forceCloseTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (err?: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (forceCloseTimer !== null) {
          clearTimeout(forceCloseTimer);
          forceCloseTimer = null;
        }
        if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(err);
        } else {
          resolve();
        }
      };

      try {
        server.close((err) => {
          finish(err);
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      if (!settled) {
        const closableServer = server as ServerType & {
          closeIdleConnections?: () => void;
          closeAllConnections?: () => void;
        };
        if (
          server instanceof http.Server ||
          typeof closableServer.closeIdleConnections === "function"
        ) {
          closableServer.closeIdleConnections?.();
        }
        if (
          !settled &&
          (server instanceof http.Server ||
            typeof closableServer.closeAllConnections === "function")
        ) {
          forceCloseTimer = setTimeout(() => {
            forceCloseTimer = null;
            closableServer.closeAllConnections?.();
          }, HTTP_CLOSE_GRACE_MS);
          forceCloseTimer.unref?.();
        }
      }
    });
  }

  private async ensureRemoteHttpServer(targetPort: number): Promise<void> {
    if (this.stopping || this.httpServer === null) {
      return;
    }

    const localPort = this.activeAddress?.port ?? this.requestedPort;
    if (targetPort > 0 && localPort > 0 && targetPort === localPort) {
      throw new ServerHttpError(400, {
        error: "remote_port_conflict",
        localPort,
        remotePort: targetPort,
        message: `remote_port (${targetPort}) must differ from active local port (${localPort})`,
      });
    }

    if (this.remoteHttpServer && this.activeRemoteAddress) {
      if (targetPort === 0 || this.activeRemoteAddress.port === targetPort) {
        return;
      }
    }

    let bound: { server: ServerType; port: number; baseUrl: string };
    try {
      bound = await this.bindHttpApp(this.remoteApp, targetPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ServerHttpError(409, {
        error: "remote_port_bind_failed",
        remotePort: targetPort,
        message: `Failed to bind remote listener on ${this.host}:${targetPort}: ${msg}`,
      });
    }

    // Re-check lifecycle after async bind to prevent leaking a late-bound listener if stop() ran concurrently.
    if (this.stopping || this.httpServer === null) {
      await this.closeHttpServer(bound.server);
      return;
    }

    const previousServer = this.remoteHttpServer;
    this.remoteHttpServer = bound.server;
    this.activeRemoteAddress = {
      port: bound.port,
      baseUrl: bound.baseUrl,
    };

    if (previousServer) {
      this.sseHub.closeAllRemote();
      await this.closeHttpServer(previousServer);
    }
  }

  private async stopRemoteHttpServer(): Promise<void> {
    this.sseHub.closeAllRemote();
    const server = this.remoteHttpServer;
    this.remoteHttpServer = null;
    this.activeRemoteAddress = null;
    if (server) {
      await this.closeHttpServer(server);
    }
  }

  /**
   * Atomically validates and applies updated `remote.yaml` settings, dynamically
   * starting/stopping/re-binding the `:4311` remote listener and syncing AC keep-awake.
   */
  async applyRemoteConfig(nextConfig: RemoteConfig): Promise<void> {
    const run = async (): Promise<void> => {
      const localPort = this.activeAddress?.port ?? this.requestedPort;
      if (localPort > 0 && nextConfig.remote_port === localPort) {
        throw new ServerHttpError(400, {
          error: "remote_port_conflict",
          localPort,
          remotePort: nextConfig.remote_port,
          message: `remote_port (${nextConfig.remote_port}) must differ from local port (${localPort})`,
        });
      }

      if (this.httpServer !== null && !this.stopping) {
        if (nextConfig.enabled) {
          const targetPort = this.requestedRemotePort ?? nextConfig.remote_port;
          await this.ensureRemoteHttpServer(targetPort);
        } else {
          await this.stopRemoteHttpServer();
        }
      }

      if (this.stopping) {
        return;
      }

      this.store.writeConfig("remote", nextConfig);
      this.caffeinate.setRemoteKeepAwakeOnAc(nextConfig.enabled && nextConfig.keep_awake_on_ac);
    };

    const nextPromise = this.remoteConfigQueue.then(run, run);
    this.remoteConfigQueue = nextPromise.catch(() => {});
    return await nextPromise;
  }

  get shutdownToken(): string | null {
    return this.activeShutdownToken ?? this.pinnedShutdownToken ?? null;
  }

  private removeShutdownTokenFileIfOwned(): void {
    const token = this.activeShutdownToken;
    this.activeShutdownToken = null;
    this.mcpRpcServer.setShutdownToken(this.pinnedShutdownToken);
    if (!token) {
      return;
    }
    const tokenPath = this.store.paths.shutdownTokenFile;
    try {
      const current = fs.readFileSync(tokenPath, "utf8").trim();
      if (current === token) {
        fs.rmSync(tokenPath, { force: true });
      }
    } catch {
      // File may already have been cleaned up externally.
    }
  }

  /**
   * Hydrates disk-persisted pending decisions, syncs sleep prevention state, writes
   * the `0600` shutdown control token, and starts the local IPC RPC server, the local
   * loopback HTTP+SSE server, and (only when `remote.enabled === true`) the
   * authenticated remote HTTP+SSE server.
   */
  async start(): Promise<KilndServerAddress> {
    if (this.activeAddress) {
      return this.address!;
    }
    this.stopping = false;

    this.pendingDecisions.hydrateFromDisk();
    if (this.enableOrchestrator) {
      await this.orchestrator.reconcileOnStart();
    }
    const remoteConfig = this.remoteAuth.readRemoteConfig();
    this.caffeinate.setRemoteKeepAwakeOnAc(remoteConfig.enabled && remoteConfig.keep_awake_on_ac);
    this.syncCaffeinate();

    const instanceShutdownToken =
      this.pinnedShutdownToken ?? crypto.randomBytes(32).toString("hex");
    this.activeShutdownToken = instanceShutdownToken;
    this.mcpRpcServer.setShutdownToken(instanceShutdownToken);

    try {
      await this.mcpRpcServer.start();
    } catch (err) {
      this.caffeinate.stop();
      this.removeShutdownTokenFileIfOwned();
      throw err;
    }

    try {
      writeFileAtomic(this.store.paths.shutdownTokenFile, `${instanceShutdownToken}\n`, {
        mode: 0o600,
      });
    } catch (err) {
      this.caffeinate.stop();
      this.removeShutdownTokenFileIfOwned();
      await this.mcpRpcServer.stop();
      throw err;
    }

    let localBound: { server: ServerType; port: number; baseUrl: string };
    try {
      localBound = await this.bindHttpApp(this.app, this.requestedPort);
    } catch (err) {
      this.caffeinate.stop();
      this.removeShutdownTokenFileIfOwned();
      await this.mcpRpcServer.stop();
      throw err;
    }

    this.httpServer = localBound.server;
    this.activeAddress = {
      port: localBound.port,
      baseUrl: localBound.baseUrl,
      socketPath: this.socketPath,
    };

    if (remoteConfig.enabled) {
      const targetRemotePort = this.requestedRemotePort ?? remoteConfig.remote_port;
      try {
        await this.ensureRemoteHttpServer(targetRemotePort);
      } catch (err) {
        const localSrv = this.httpServer;
        this.httpServer = null;
        this.activeAddress = null;
        if (localSrv) {
          await this.closeHttpServer(localSrv);
        }
        this.caffeinate.stop();
        this.removeShutdownTokenFileIfOwned();
        await this.mcpRpcServer.stop();
        throw err;
      }
    }

    if (this.enableOrchestrator) {
      await this.orchestrator.start();
    }

    return this.address!;
  }

  /**
   * Stops orchestrator, rate tracker, caffeinate, closes all active SSE streams,
   * tears down local + remote HTTP & UDS listeners, and closes daemon-owned handles.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.remoteConfigQueue;
    this.unsubscribeNotify();
    await this.orchestrator.stop();
    await this.scriptRunner.stopAll();
    this.rateTracker.stop();
    this.caffeinate.stop();
    this.sseHub.closeAll();

    await this.stopRemoteHttpServer();

    const server = this.httpServer;
    this.httpServer = null;
    this.activeAddress = null;

    if (server) {
      await this.closeHttpServer(server);
    }

    this.removeShutdownTokenFileIfOwned();
    await this.mcpRpcServer.stop();

    if (this.ownsBackendRegistry) {
      await this.backendRegistry.disposeAll();
    }
    if (this.ownsStore) {
      this.store.close();
    }
  }

  /**
   * Signs an ephemeral HMAC-SHA256 `KILN_RUN_TOKEN` bound to task/run/role/contractVersion.
   */
  issueRunToken(input: IssueRunTokenInput): string {
    const iat = input.iat ?? Math.floor(Date.now() / 1000);
    const ttl = input.ttlSeconds ?? 3600;
    const exp = input.exp ?? iat + ttl;
    return signRunToken(
      {
        taskId: input.taskId,
        runId: input.runId,
        role: input.role,
        contractVersion: input.contractVersion,
        ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
        iat,
        exp,
      },
      this.tokenSecret,
    );
  }

  /**
   * Verifies a `KILN_RUN_TOKEN` against this server's HMAC secret.
   */
  verifyRunToken(token: string, nowMs?: number): RunTokenClaims {
    return verifyRunToken(token, this.tokenSecret, nowMs);
  }

  /**
   * Invokes the daemon MCP RPC dispatcher in-process using the exact same auth,
   * role-allowlist, and handler pipeline bound to `kilnd.sock`.
   */
  async invokeMcpRpc(input: McpRpcHttpRequest): Promise<McpRpcHttpResponse> {
    return await this.mcpRpcServer.dispatchHttpRequest(input);
  }

  /**
   * Recomputes the current running leaf task count and synchronizes `CaffeinateController`.
   */
  syncCaffeinate(): number {
    const count = countRunningLeafTasks(this.store);
    this.caffeinate.syncRunningCount(count);
    return count;
  }

  /**
   * Probes an agent provider (`POST /api/providers/:id/test`), updates `ProviderHealthTracker`,
   * emits a `provider.status` SSE event, and returns sanitized runtime telemetry.
   */
  async testProvider(providerId: string): Promise<TestProviderResult> {
    const providersConfig = this.store.readEffectiveProvidersConfig();
    const entry = providersConfig.providers.find((p) => p.id === providerId);
    if (!entry) {
      throw new ServerHttpError(404, {
        error: "provider_not_found",
        providerId,
        message: `Provider "${providerId}" is not configured`,
      });
    }

    let result: TestProviderResult | null = null;
    for (const backend of this.backendRegistry.list()) {
      if (backend instanceof CompositeBackend) {
        result = await backend.testProvider(providerId);
        break;
      }
    }

    if (!result) {
      if (!entry.enabled) {
        this.providerHealth.setAvailability(entry.id, {
          available: false,
          detail: "Provider is disabled",
        });
      } else if (entry.adapter === "paseo") {
        const connected = this.backendRegistry.has(entry.id) || this.backendRegistry.has("paseo");
        this.providerHealth.setAvailability(entry.id, {
          available: connected,
          ...(connected ? {} : { detail: "Paseo bridge backend not connected" }),
        });
      } else {
        const command = entry.command?.trim() || entry.id;
        const probed = await probeCliBinary(command, {
          env: { ...process.env, ...entry.env },
        });
        this.providerHealth.setAvailability(entry.id, {
          available: probed.available,
          version: probed.version,
          ...(probed.detail ? { detail: probed.detail } : {}),
        });
      }

      const status = this.providerHealth.buildRuntimeStatus(
        entry,
        this.store.listUsageTurns(),
        this.store.readConfig("pricing"),
      );
      result = { status, modelsCount: 0 };
    }

    this.sseHub.publish({
      type: "provider.status",
      providerId: result.status.provider_id,
      status: result.status.status,
      ...(result.status.cooldown_until ? { cooldownUntil: result.status.cooldown_until } : {}),
      ...(result.status.detail ? { detail: result.status.detail } : {}),
      at: new Date().toISOString(),
    });

    return result;
  }

  /**
   * Probes all configured non-Paseo CLIs on the host (`POST /api/providers/detect`),
   * automatically sets `enabled` to match host availability, persists `config/providers.yaml`,
   * syncs `CompositeBackend`, and emits `provider.status` SSE updates.
   */
  async detectProviders(): Promise<{
    data: ProvidersConfig;
    providers: ProviderRuntimeStatus[];
  }> {
    const current = this.store.readEffectiveProvidersConfig();
    const nextConfig = await detectProvidersConfigOnHost(current, {
      healthTracker: this.providerHealth,
    });
    this.store.writeConfig("providers", nextConfig);
    for (const backend of this.backendRegistry.list()) {
      if (backend instanceof CompositeBackend) {
        await backend.syncFromConfig(nextConfig);
        await backend.refreshProviders();
      }
    }
    const turns = this.store.listUsageTurns();
    const pricing = this.store.readConfig("pricing");
    const providers = nextConfig.providers.map((entry) =>
      this.providerHealth.buildRuntimeStatus(entry, turns, pricing),
    );
    const nowIso = new Date().toISOString();
    for (const st of providers) {
      this.sseHub.publish({
        type: "provider.status",
        providerId: st.provider_id,
        status: st.status,
        ...(st.cooldown_until ? { cooldownUntil: st.cooldown_until } : {}),
        ...(st.detail ? { detail: st.detail } : {}),
        at: nowIso,
      });
    }
    void this.orchestrator.wake();
    return { data: nextConfig, providers };
  }

  /**
   * Synchronizes `config/pricing.yaml` from public price catalogs (`models.dev` / `litellm`)
   * or the built-in offline baseline while keeping user custom overrides intact.
   */
  async syncModelPricing(input: SyncPricingRequest = {}): Promise<SyncPricingResponse> {
    if (this.customSyncPricing) {
      return await this.customSyncPricing(input);
    }
    return await syncModelPricingImpl({
      store: this.store,
      backendRegistry: this.backendRegistry,
      request: input,
      ...(this.extensionsHomeDir !== undefined ? { homeDir: this.extensionsHomeDir } : {}),
      ...(this.pricingFetchImpl !== undefined ? { fetchImpl: this.pricingFetchImpl } : {}),
      ...(this.pricingCacheTtlMs !== undefined ? { cacheTtlMs: this.pricingCacheTtlMs } : {}),
      ...(this.pricingFetchTimeoutMs !== undefined
        ? { timeoutMs: this.pricingFetchTimeoutMs }
        : {}),
    });
  }

  /**
   * Persists `RUN.yaml` and acquires the single SQLite stage lease, enforcing `input_ref`
   * for `git_worktree` tasks as required by `gate-runner`.
   */
  persistRunForDispatch(
    runMeta: RunMeta,
    runDirName: string,
    handoffMarkdown?: string,
  ): AcquireStageLeaseResult {
    const card = this.store.readTaskCard(runMeta.task_id);
    if (card.workspace_mode === "git_worktree" && !runMeta.input_ref) {
      throw new Error(
        `git_worktree run "${runMeta.run_id}" for task "${runMeta.task_id}" requires RUN.yaml input_ref`,
      );
    }

    const leaseResult = this.store.persistRunBeforeDispatch(runMeta, runDirName, handoffMarkdown);
    if (leaseResult.acquired) {
      this.syncCaffeinate();
      this.sseHub.publish({
        type: "task.updated",
        taskId: runMeta.task_id,
        patch: {
          status: "running",
          stage: runMeta.stage,
          round: runMeta.round,
          contractVersion: runMeta.contract_version,
        },
      });
    }
    return leaseResult;
  }
}
