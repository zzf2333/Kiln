import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { RoleId, RunMeta, RunTokenClaims } from "@kiln/protocol";
import { BackendRegistry } from "../backend/index.js";
import { TaskStateMachine } from "../state/index.js";
import { KilnStore, writeFileAtomic, type AcquireStageLeaseResult } from "../store/index.js";
import { CaffeinateController } from "./caffeinate.js";
import {
  KilnChatEngine,
  type ChatResponder,
  type McpCommandSpec,
} from "./chat.js";
import { createHttpApiApp } from "./http-api.js";
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
  host?: string;
  port?: number;
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
  shutdownToken?: string;
  onShutdownRequested?: () => Promise<void> | void;
}

export interface KilndServerAddress {
  port: number;
  baseUrl: string;
  socketPath: string;
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
  readonly pendingDecisions: PendingDecisionStore;
  readonly rateTracker: LiveRateTracker;
  readonly chatEngine: KilnChatEngine;
  readonly orchestrator: KilnOrchestrator;
  readonly enableOrchestrator: boolean;
  readonly app: Hono;
  readonly host: string;
  readonly requestedPort: number;
  readonly socketPath: string;

  private readonly ownsStore: boolean;
  private readonly ownsBackendRegistry: boolean;
  private readonly tokenSecret: Buffer;
  private readonly pinnedShutdownToken: string | undefined;
  private readonly mcpRpcServer: McpRpcServer;

  private activeShutdownToken: string | null = null;
  private httpServer: ServerType | null = null;
  private activeAddress: KilndServerAddress | null = null;

  constructor(options: KilndServerOptions = {}) {
    this.ownsStore = options.store === undefined;
    this.ownsBackendRegistry = options.backendRegistry === undefined;

    this.store = options.store ?? new KilnStore({ kilnHome: options.kilnHome });
    this.stateMachine = options.stateMachine ?? new TaskStateMachine(this.store);
    this.backendRegistry = options.backendRegistry ?? new BackendRegistry();
    this.sseHub = options.sseHub ?? new SseHub();
    this.caffeinate = options.caffeinate ?? new CaffeinateController();
    this.pendingDecisions = new PendingDecisionStore(this.store);
    this.enableOrchestrator = options.enableOrchestrator ?? false;

    this.host = options.host ?? DEFAULT_KILND_HOST;
    this.requestedPort = options.port ?? DEFAULT_KILND_PORT;
    this.socketPath = options.socketPath ?? this.store.paths.kilndSock;
    this.tokenSecret = normalizeTokenSecret(options.tokenSecret);
    this.pinnedShutdownToken = options.shutdownToken;

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

    this.app = createHttpApiApp({
      store: this.store,
      stateMachine: this.stateMachine,
      sseHub: this.sseHub,
      pendingDecisions: this.pendingDecisions,
      caffeinate: this.caffeinate,
      backendRegistry: this.backendRegistry,
      rateTracker: this.rateTracker,
      chatEngine: this.chatEngine,
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
    });
  }

  get address(): KilndServerAddress | null {
    return this.activeAddress ? { ...this.activeAddress } : null;
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
   * the `0600` shutdown control token, and starts both the local IPC RPC server and
   * the loopback HTTP+SSE server.
   */
  async start(): Promise<KilndServerAddress> {
    if (this.activeAddress) {
      return { ...this.activeAddress };
    }

    this.pendingDecisions.hydrateFromDisk();
    if (this.enableOrchestrator) {
      await this.orchestrator.reconcileOnStart();
    }
    this.syncCaffeinate();

    const instanceShutdownToken =
      this.pinnedShutdownToken ?? crypto.randomBytes(32).toString("hex");
    this.activeShutdownToken = instanceShutdownToken;
    this.mcpRpcServer.setShutdownToken(instanceShutdownToken);

    await this.mcpRpcServer.start();
    try {
      writeFileAtomic(
        this.store.paths.shutdownTokenFile,
        `${instanceShutdownToken}\n`,
        { mode: 0o600 },
      );
    } catch (err) {
      this.removeShutdownTokenFileIfOwned();
      await this.mcpRpcServer.stop();
      throw err;
    }

    let server: ServerType;
    try {
      server = await new Promise<ServerType>((resolve, reject) => {
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
            fetch: this.app.fetch,
            hostname: this.host,
            port: this.requestedPort,
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
    } catch (err) {
      this.removeShutdownTokenFileIfOwned();
      await this.mcpRpcServer.stop();
      throw err;
    }

    const rawAddr = server.address() as AddressInfo | string | null;
    if (!rawAddr || typeof rawAddr === "string") {
      server.close();
      this.removeShutdownTokenFileIfOwned();
      await this.mcpRpcServer.stop();
      throw new Error("KilndServer HTTP server failed to bind a TCP port");
    }

    this.httpServer = server;
    this.activeAddress = {
      port: rawAddr.port,
      baseUrl: `http://${this.host}:${rawAddr.port}`,
      socketPath: this.socketPath,
    };

    if (this.enableOrchestrator) {
      await this.orchestrator.start();
    }

    return { ...this.activeAddress };
  }

  /**
   * Stops orchestrator, rate tracker, caffeinate, closes all active SSE streams,
   * tears down HTTP & UDS listeners, and closes daemon-owned backend/store handles.
   */
  async stop(): Promise<void> {
    await this.orchestrator.stop();
    this.rateTracker.stop();
    this.caffeinate.stop();
    this.sseHub.closeAll();

    const server = this.httpServer;
    this.httpServer = null;
    this.activeAddress = null;

    if (server) {
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
