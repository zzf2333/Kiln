import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type {
  RemoteConfig,
  RoleId,
  RunMeta,
  RunTokenClaims,
  TailscaleStatusResponse,
} from "@kiln/protocol";
import { BackendRegistry } from "../backend/index.js";
import { TaskStateMachine } from "../state/index.js";
import { KilnStore, type AcquireStageLeaseResult } from "../store/index.js";
import { CaffeinateController } from "./caffeinate.js";
import {
  KilnChatEngine,
  type ChatResponder,
  type McpCommandSpec,
} from "./chat.js";
import { ServerHttpError } from "./errors.js";
import {
  createHttpApiApp,
  type HttpApiDependencies,
  type RemoteRuntimeStatus,
} from "./http-api.js";
import {
  McpRpcServer,
  type McpRpcHttpRequest,
  type McpRpcHttpResponse,
} from "./mcp-rpc.js";
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
import {
  inspectTailscaleStatus,
  type TailscaleExecFileFn,
} from "./remote-tailscale.js";
import { SseHub } from "./sse.js";
import { signRunToken, verifyRunToken } from "./token.js";

export const DEFAULT_KILND_HOST = "127.0.0.1";
export const DEFAULT_KILND_PORT = 4310;
export const DEFAULT_SERVER_VERSION = "0.0.1";
const HTTP_CLOSE_GRACE_MS = 350;

export interface KilndServerOptions {
  kilnHome?: string;
  store?: KilnStore;
  stateMachine?: TaskStateMachine;
  backendRegistry?: BackendRegistry;
  sseHub?: SseHub;
  caffeinate?: CaffeinateController;
  remoteAuth?: RemoteAuthManager;
  remoteNotifier?: RemoteNotifier;
  host?: string;
  port?: number;
  /** Optional override for the remote HTTP listener port (e.g., `0` for ephemeral port in tests). */
  remotePort?: number;
  socketPath?: string;
  tokenSecret?: string | Buffer;
  version?: string;
  maxRpcBodyBytes?: number;
  enableOrchestrator?: boolean;
  publicDir?: string | null;
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
  readonly sseHub: SseHub;
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
  private readonly mcpRpcServer: McpRpcServer;
  private readonly unsubscribeNotify: () => void;

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
    this.sseHub = options.sseHub ?? new SseHub();
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
        ...(options.notifyFetchImpl !== undefined
          ? { fetchImpl: options.notifyFetchImpl }
          : {}),
        ...(options.notifyTimeoutMs !== undefined
          ? { timeoutMs: options.notifyTimeoutMs }
          : {}),
      });
    this.pendingDecisions = new PendingDecisionStore(this.store);
    this.enableOrchestrator = options.enableOrchestrator ?? false;

    this.host = options.host ?? DEFAULT_KILND_HOST;
    this.requestedPort = options.port ?? DEFAULT_KILND_PORT;
    this.requestedRemotePort = options.remotePort;
    this.socketPath = options.socketPath ?? this.store.paths.kilndSock;
    this.tokenSecret = normalizeTokenSecret(options.tokenSecret);

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
      sseHub: this.sseHub,
      caffeinate: this.caffeinate,
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
      ...(options.chatResponder !== undefined
        ? { chatResponder: options.chatResponder }
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
      ...(options.deliverHandler !== undefined
        ? { deliverHandler: options.deliverHandler }
        : {}),
      ...(options.approvalHandler !== undefined
        ? { approvalHandler: options.approvalHandler }
        : {}),
      ...(options.rateLimitCooldownMs !== undefined
        ? { rateLimitCooldownMs: options.rateLimitCooldownMs }
        : {}),
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
      rateTracker: this.rateTracker,
      chatEngine: this.chatEngine,
      remoteAuth: this.remoteAuth,
      remoteNotifier: this.remoteNotifier,
      getLocalPort: () => this.activeAddress?.port ?? this.requestedPort,
      getRemoteRuntimeStatus: () => this.getRemoteRuntimeStatus(),
      onRemoteConfigUpdated: (nextConfig) => this.applyRemoteConfig(nextConfig),
      inspectTailscale,
      ...(options.publicDir !== undefined ? { publicDir: options.publicDir } : {}),
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
      onTaskCancelled: async (taskId) => {
        await this.orchestrator.abortActiveRun(taskId);
        void this.orchestrator.wake();
      },
      onBeforeDecisionApply: async (taskId) => {
        await this.orchestrator.abortActiveRun(taskId);
      },
      onSettingsUpdated: (section) => {
        if (section === "roles" || section === "limits") {
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
      maxBodyBytes: options.maxRpcBodyBytes,
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
        },
        () => {
          if (settled) return;
          settled = true;
          createdServer?.removeListener("error", onError);
          resolve(createdServer!);
        },
      );
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
      this.caffeinate.setRemoteKeepAwakeOnAc(
        nextConfig.enabled && nextConfig.keep_awake_on_ac,
      );
    };

    const nextPromise = this.remoteConfigQueue.then(run, run);
    this.remoteConfigQueue = nextPromise.catch(() => {});
    return await nextPromise;
  }

  /**
   * Hydrates disk-persisted pending decisions, syncs caffeinate state, and starts
   * the `0600` Unix Domain Socket RPC server, the local loopback HTTP+SSE server,
   * and (only when `remote.enabled === true`) the authenticated remote HTTP+SSE server.
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
    this.caffeinate.setRemoteKeepAwakeOnAc(
      remoteConfig.enabled && remoteConfig.keep_awake_on_ac,
    );
    this.syncCaffeinate();

    await this.mcpRpcServer.start();

    let localBound: { server: ServerType; port: number; baseUrl: string };
    try {
      localBound = await this.bindHttpApp(this.app, this.requestedPort);
    } catch (err) {
      this.caffeinate.stop();
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

    const leaseResult = this.store.persistRunBeforeDispatch(
      runMeta,
      runDirName,
      handoffMarkdown,
    );
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
