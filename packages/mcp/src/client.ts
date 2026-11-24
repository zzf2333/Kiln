import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
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
export function isRoleForbiddenError(err: unknown): err is KilnRpcError & {
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

function parseRpcHttpJsonBody(
  reqPath: string,
  status: number,
  rawText: string,
): { status: number; body: unknown } {
  if (rawText.trim().length === 0) {
    return { status, body: {} };
  }
  try {
    return { status, body: JSON.parse(rawText) as unknown };
  } catch {
    if (status >= 200 && status < 300) {
      throw new Error(`Invalid JSON response from kilnd RPC endpoint ${reqPath}`);
    }
    return { status, body: { message: rawText } };
  }
}

function decodeChunkedResponseBuffer(buf: Buffer): { done: true; body: Buffer } | { done: false } {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let offset = 0;

  while (true) {
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      return { done: false };
    }
    const rawLine = buf.subarray(offset, lineEnd).toString("latin1");
    const semiIdx = rawLine.indexOf(";");
    const hexPart = (semiIdx >= 0 ? rawLine.slice(0, semiIdx) : rawLine).trim();
    if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
      throw new Error("Invalid chunked response framing from kilnd RPC");
    }
    const chunkSize = Number.parseInt(hexPart, 16);
    offset = lineEnd + 2;
    if (chunkSize === 0) {
      while (true) {
        const trailerEnd = buf.indexOf("\r\n", offset);
        if (trailerEnd === -1) {
          return { done: false };
        }
        const empty = trailerEnd === offset;
        offset = trailerEnd + 2;
        if (empty) {
          return { done: true, body: Buffer.concat(chunks, totalBytes) };
        }
      }
    }
    if (buf.length < offset + chunkSize + 2) {
      return { done: false };
    }
    if (buf[offset + chunkSize] !== 0x0d || buf[offset + chunkSize + 1] !== 0x0a) {
      throw new Error("Invalid chunked response terminator from kilnd RPC");
    }
    const slice = buf.subarray(offset, offset + chunkSize);
    chunks.push(slice);
    totalBytes += slice.length;
    offset += chunkSize + 2;
  }
}

/**
 * Sends a single HTTP/1.1 RPC request over a `node:net` local IPC stream (required for
 * Windows Named Pipes under Bun standalone executables, and compatible with POSIX UDS).
 */
export async function sendNamedPipeHttpRequest(
  socketPath: string,
  req: {
    method: "POST";
    path: string;
    headers: Record<string, string>;
    rawBody: string;
  },
): Promise<{ status: number; body: unknown }> {
  if (/[\r\n\0]/.test(req.method) || /[\r\n\0]/.test(req.path)) {
    throw new Error("Invalid HTTP request method or path");
  }
  const bodyBuf = Buffer.from(req.rawBody, "utf8");
  const headerLines = [
    `${req.method} ${req.path} HTTP/1.1`,
    "Host: kilnd.local",
    "Connection: close",
  ];
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key.toLowerCase() === "host" ||
      key.toLowerCase() === "content-length" ||
      key.toLowerCase() === "connection"
    ) {
      continue;
    }
    if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(value)) {
      throw new Error(`Invalid HTTP header "${key}"`);
    }
    headerLines.push(`${key}: ${value}`);
  }
  headerLines.push(`Content-Length: ${bodyBuf.length}`, "", "");
  const headBuf = Buffer.from(headerLines.join("\r\n"), "latin1");
  const wire = bodyBuf.length > 0 ? Buffer.concat([headBuf, bodyBuf]) : headBuf;

  return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let rawBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let headerEnd = -1;
    let status = 0;
    let contentLength: number | null = null;
    let isChunked = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const complete = (rawText: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      try {
        resolve(parseRpcHttpJsonBody(req.path, status, rawText));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    socket.once("connect", () => {
      socket.write(wire);
    });

    socket.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const chunkBuf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      rawBuf = rawBuf.length === 0 ? chunkBuf : Buffer.concat([rawBuf, chunkBuf]);

      if (headerEnd === -1) {
        const idx = rawBuf.indexOf("\r\n\r\n");
        if (idx === -1) {
          if (rawBuf.length > 16 * 1024) {
            fail(new Error("RPC HTTP response headers exceed maximum size"));
          }
          return;
        }
        const headLines = rawBuf.subarray(0, idx).toString("latin1").split("\r\n");
        const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s.*)?$/i.exec(headLines[0] ?? "");
        if (!statusMatch || !statusMatch[1]) {
          fail(new Error(`Invalid kilnd RPC HTTP response status line`));
          return;
        }
        status = Number.parseInt(statusMatch[1], 10);
        for (let i = 1; i < headLines.length; i++) {
          const line = headLines[i]!;
          const colon = line.indexOf(":");
          if (colon <= 0) continue;
          const name = line.slice(0, colon).trim().toLowerCase();
          const val = line.slice(colon + 1).trim();
          if (name === "content-length" && /^\d+$/.test(val)) {
            contentLength = Number.parseInt(val, 10);
          } else if (name === "transfer-encoding" && val.toLowerCase().includes("chunked")) {
            isChunked = true;
          }
        }
        headerEnd = idx;
        rawBuf = rawBuf.subarray(idx + 4);
      }

      if (isChunked) {
        try {
          const decoded = decodeChunkedResponseBuffer(rawBuf);
          if (decoded.done) {
            complete(decoded.body.toString("utf8"));
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }

      if (contentLength !== null && rawBuf.length >= contentLength) {
        complete(rawBuf.subarray(0, contentLength).toString("utf8"));
      }
    });

    socket.on("end", () => {
      if (settled) return;
      if (headerEnd === -1) {
        fail(new Error("kilnd RPC connection ended before HTTP headers were received"));
        return;
      }
      if (isChunked) {
        fail(new Error("kilnd RPC connection ended before chunked response completed"));
        return;
      }
      if (contentLength !== null && rawBuf.length < contentLength) {
        fail(new Error("kilnd RPC response truncated before Content-Length completed"));
        return;
      }
      complete(
        contentLength !== null
          ? rawBuf.subarray(0, contentLength).toString("utf8")
          : rawBuf.toString("utf8"),
      );
    });

    socket.on("error", (err) => fail(err));
  });
}

function createUnixSocketTransport(socketPath: string): KilnRpcTransport {
  if (isWindowsNamedPipe(socketPath)) {
    return (req) => sendNamedPipeHttpRequest(socketPath, req);
  }

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
            try {
              resolve(parseRpcHttpJsonBody(req.path, status, rawText));
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
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
      input === undefined &&
      (validatedTool === "wb_get_context" || validatedTool === "wb_list_tasks")
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
