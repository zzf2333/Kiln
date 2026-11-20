import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  McpToolNameSchema,
  RoleForbiddenErrorSchema,
  WbAskDecisionInputSchema,
  WbGetContextInputSchema,
  WbListTasksInputSchema,
  WbPlanInputSchema,
  WbProposeLedgerInputSchema,
  WbReadLedgerInputSchema,
  WbSubmitReceiptInputSchema,
  type McpToolName,
  type RoleForbiddenError,
} from "@kiln/protocol";

export const MCP_TOOL_INPUT_SCHEMAS = {
  wb_get_context: WbGetContextInputSchema,
  wb_list_tasks: WbListTasksInputSchema,
  wb_read_ledger: WbReadLedgerInputSchema,
  wb_plan: WbPlanInputSchema,
  wb_ask_decision: WbAskDecisionInputSchema,
  wb_submit_receipt: WbSubmitReceiptInputSchema,
  wb_propose_ledger: WbProposeLedgerInputSchema,
} as const satisfies Record<McpToolName, z.ZodTypeAny>;

export type KilnRpcTransport = (req: {
  method: "POST";
  path: string;
  headers: Record<string, string>;
  rawBody: string;
}) => Promise<{ status: number; body: unknown }>;

export interface KilnSocketRpcClientOptions {
  token: string;
  socketPath?: string;
  transport?: KilnRpcTransport;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractErrorCode(status: number, payload: unknown): string {
  if (isPlainRecord(payload)) {
    if (typeof payload.code === "string" && payload.code.length > 0) {
      return payload.code;
    }
    if (typeof payload.error === "string" && payload.error.length > 0) {
      return payload.error;
    }
  }
  return `http_${status}`;
}

function extractErrorMessage(status: number, code: string, payload: unknown): string {
  if (isPlainRecord(payload) && typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }
  return `Kiln RPC request failed with status ${status} (${code})`;
}

/**
 * Structured error thrown when kilnd UDS RPC returns a non-2xx HTTP status.
 */
export class KilnRpcError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    const code = extractErrorCode(status, payload);
    const message = extractErrorMessage(status, code, payload);
    super(message);
    this.name = "KilnRpcError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/**
 * Type guard verifying a 403 `role_forbidden` error returned by kilnd against `RoleForbiddenErrorSchema`.
 */
export function isRoleForbiddenError(
  err: unknown,
): err is KilnRpcError & {
  status: 403;
  code: "role_forbidden";
  payload: RoleForbiddenError;
} {
  return (
    err instanceof KilnRpcError &&
    err.status === 403 &&
    RoleForbiddenErrorSchema.safeParse(err.payload).success
  );
}

/**
 * Returns true when `ipcPath` targets a Windows Named Pipe (`\\.\pipe\...` or `\\?\pipe\...`).
 */
export function isWindowsNamedPipe(ipcPath: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(ipcPath);
}

function normalizeHomeForPipeHash(kilnHome: string): string {
  if (/^[A-Za-z]:[\\/]/.test(kilnHome) || kilnHome.startsWith("\\\\")) {
    return path.win32.resolve(kilnHome);
  }
  return path.resolve(kilnHome);
}

/**
 * Resolves the default local RPC IPC endpoint for `kilnHome`:
 * - POSIX (`darwin`/`linux`): `<kilnHome>/run/kilnd.sock`
 * - Windows (`win32`): `\\.\pipe\kiln-rpc-<sha256(resolvedHome.toLowerCase()).slice(0, 16)>`
 */
export function resolveDefaultIpcPath(
  kilnHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const normalizedHome = normalizeHomeForPipeHash(kilnHome);
    const homeHash = crypto
      .createHash("sha256")
      .update(normalizedHome.toLowerCase())
      .digest("hex")
      .slice(0, 16);
    return `\\\\.\\pipe\\kiln-rpc-${homeHash}`;
  }
  return path.join(path.resolve(kilnHome), "run", "kilnd.sock");
}

/**
 * Resolves the kilnd local IPC path (Unix Domain Socket on POSIX or Named Pipe on Windows)
 * using explicit path, `KILN_SOCK_PATH`, `KILN_HOME`, or `~/.kiln` in precedence order.
 */
export function resolveKilnSocketPath(
  explicitSocketPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (explicitSocketPath !== undefined) {
    const trimmed = explicitSocketPath.trim();
    if (trimmed.length === 0) {
      throw new Error("socketPath must be a non-empty string when provided");
    }
    return trimmed;
  }

  const sockOverride = env.KILN_SOCK_PATH?.trim();
  if (sockOverride && sockOverride.length > 0) {
    return sockOverride;
  }

  const kilnHome = env.KILN_HOME?.trim();
  if (kilnHome && kilnHome.length > 0) {
    return resolveDefaultIpcPath(kilnHome, platform);
  }

  return resolveDefaultIpcPath(path.join(os.homedir(), ".kiln"), platform);
}

function createUnixSocketTransport(socketPath: string): KilnRpcTransport {
  return async (req) => {
    const byteLength = Buffer.byteLength(req.rawBody, "utf8");

    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error): void => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const httpReq = http.request(
        {
          socketPath,
          path: req.path,
          method: req.method,
          headers: {
            Host: "kilnd.local",
            ...req.headers,
            "Content-Length": String(byteLength),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
          });
          res.on("error", (err) => fail(err));
          res.on("end", () => {
            if (settled) return;
            settled = true;
            const status = res.statusCode ?? 0;
            const rawText = Buffer.concat(chunks).toString("utf8");
            if (rawText.trim().length === 0) {
              resolve({ status, body: {} });
              return;
            }
            try {
              const parsed = JSON.parse(rawText) as unknown;
              resolve({ status, body: parsed });
            } catch {
              if (status >= 200 && status < 300) {
                reject(new Error(`Invalid JSON response from kilnd RPC endpoint ${req.path}`));
                return;
              }
              resolve({ status, body: { message: rawText } });
            }
          });
        },
      );

      httpReq.on("error", (err) => fail(err));
      httpReq.write(req.rawBody, "utf8");
      httpReq.end();
    });
  };
}

/**
 * RPC client communicating exclusively with kilnd over its Unix Domain Socket (`kilnd.sock`)
 * using signed `KILN_RUN_TOKEN` bearer authentication.
 */
export class KilnSocketRpcClient {
  readonly socketPath: string;
  private readonly token: string;
  private readonly transport: KilnRpcTransport;

  constructor(options: KilnSocketRpcClientOptions) {
    if (typeof options.token !== "string" || options.token.trim().length === 0) {
      throw new Error("KilnSocketRpcClient requires a non-empty KILN_RUN_TOKEN");
    }
    this.token = options.token.trim();
    this.socketPath = resolveKilnSocketPath(options.socketPath);
    this.transport = options.transport ?? createUnixSocketTransport(this.socketPath);
  }

  /**
   * Validates the tool name and payload locally against `@kiln/protocol` schemas,
   * then forwards the signed RPC request to `/rpc/mcp/:tool`.
   */
  async callTool<T extends McpToolName>(tool: T, input: unknown): Promise<unknown> {
    const validatedTool = McpToolNameSchema.parse(tool);
    const schema = MCP_TOOL_INPUT_SCHEMAS[validatedTool];
    const candidate =
      input === undefined && (validatedTool === "wb_get_context" || validatedTool === "wb_list_tasks")
        ? {}
        : input;
    const parsedInput = schema.parse(candidate);
    const rawBody = JSON.stringify(parsedInput);

    const response = await this.transport({
      method: "POST",
      path: `/rpc/mcp/${validatedTool}`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      rawBody,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new KilnRpcError(response.status, response.body);
    }

    return response.body;
  }
}
