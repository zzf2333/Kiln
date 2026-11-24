import net from "node:net";
import { ServerHttpError, mapDomainError } from "./errors.js";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CHUNK_LINE_BYTES = 128;
const DEFAULT_IPC_IDLE_TIMEOUT_MS = 10_000;

export type IpcTransportMode = "auto" | "http" | "net";

export interface NetHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface NetHttpResponse {
  status: number;
  body: unknown;
  afterFlush?: () => void;
}

export interface CreateNetHttpServerOptions {
  maxBodyBytes: number;
  idleTimeoutMs?: number;
  onRequest: (req: NetHttpRequest) => Promise<NetHttpResponse> | NetHttpResponse;
}

export interface NetHttpServerHandle {
  server: net.Server;
  closeAllConnections: () => void;
}

export interface SendNetHttpRequestOptions {
  socketPath: string;
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  rawBody?: string;
  timeoutMs?: number;
}

export interface NetHttpClientResponse {
  status: number;
  headers: Record<string, string>;
  rawBody: string;
}

const HTTP_STATUS_REASONS: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  502: "Bad Gateway",
};

function resolveReasonPhrase(status: number): string {
  return HTTP_STATUS_REASONS[status] ?? (status >= 200 && status < 300 ? "OK" : "Error");
}

function assertNoCrLf(value: string, label: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Invalid ${label}: control characters are not allowed`);
  }
}

interface ParsedHeadersBlock {
  startLine: string;
  headers: Record<string, string>;
  contentLength: number | null;
  chunked: boolean;
}

function parseHeadersBlock(
  headerText: string,
  options: { maxBodyBytes?: number; rejectDuplicateDifferingContentLength?: boolean } = {},
): ParsedHeadersBlock {
  const lines = headerText.split("\r\n");
  const startLine = lines[0] ?? "";
  const headers: Record<string, string> = {};
  let contentLength: number | null = null;
  let hasTransferEncoding = false;
  let chunked = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) {
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) {
      throw new ServerHttpError(400, {
        error: "invalid_request",
        message: "Malformed HTTP header line",
      });
    }
    const rawName = line.slice(0, colonIdx);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(rawName)) {
      throw new ServerHttpError(400, {
        error: "invalid_request",
        message: `Invalid HTTP header name "${rawName}"`,
      });
    }
    const name = rawName.toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (name === "content-length") {
      if (!/^\d+$/.test(value)) {
        throw new ServerHttpError(400, {
          error: "invalid_request",
          message: "Invalid Content-Length header",
        });
      }
      const parsedLen = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(parsedLen) || parsedLen < 0) {
        throw new ServerHttpError(400, {
          error: "invalid_request",
          message: "Invalid Content-Length header",
        });
      }
      if (
        options.rejectDuplicateDifferingContentLength !== false &&
        contentLength !== null &&
        contentLength !== parsedLen
      ) {
        throw new ServerHttpError(400, {
          error: "invalid_request",
          message: "Conflicting Content-Length headers",
        });
      }
      contentLength = parsedLen;
      headers[name] = value;
      continue;
    }

    if (name === "transfer-encoding") {
      hasTransferEncoding = true;
      const tokens = value
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
      if (tokens.length !== 1 || tokens[0] !== "chunked") {
        throw new ServerHttpError(400, {
          error: "invalid_request",
          message: `Unsupported Transfer-Encoding "${value}"`,
        });
      }
      chunked = true;
      headers[name] = value;
      continue;
    }

    headers[name] = headers[name] !== undefined ? `${headers[name]}, ${value}` : value;
  }

  if (hasTransferEncoding && contentLength !== null) {
    throw new ServerHttpError(400, {
      error: "invalid_request",
      message: "Transfer-Encoding and Content-Length cannot both be specified",
    });
  }

  if (
    options.maxBodyBytes !== undefined &&
    contentLength !== null &&
    contentLength > options.maxBodyBytes
  ) {
    throw new ServerHttpError(413, {
      error: "payload_too_large",
      message: `Request body exceeds ${options.maxBodyBytes} bytes`,
    });
  }

  return { startLine, headers, contentLength, chunked };
}

class IncrementalChunkedDecoder {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;
  private phase: "size" | "data" | "trailers" | "done" = "size";
  private currentChunkSize = 0;
  private trailerBytes = 0;

  constructor(private readonly maxBodyBytes: number | null) {}

  feed(data: Buffer): Buffer | null {
    if (data.length > 0) {
      this.pending = this.pending.length === 0 ? data : Buffer.concat([this.pending, data]);
    }

    while (true) {
      if (this.phase === "done") {
        return Buffer.concat(this.chunks, this.totalBytes);
      }

      if (this.phase === "size") {
        const lineEnd = this.pending.indexOf("\r\n");
        if (lineEnd === -1) {
          if (this.pending.length > MAX_CHUNK_LINE_BYTES) {
            throw new ServerHttpError(400, {
              error: "invalid_request",
              message: "Chunk size line exceeds limit",
            });
          }
          return null;
        }
        if (lineEnd > MAX_CHUNK_LINE_BYTES) {
          throw new ServerHttpError(400, {
            error: "invalid_request",
            message: "Chunk size line exceeds limit",
          });
        }
        const rawLine = this.pending.subarray(0, lineEnd).toString("latin1");
        const semiIdx = rawLine.indexOf(";");
        const hexPart = (semiIdx >= 0 ? rawLine.slice(0, semiIdx) : rawLine).trim();
        if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
          throw new ServerHttpError(400, {
            error: "invalid_request",
            message: "Malformed HTTP chunk size",
          });
        }
        const chunkSize = Number.parseInt(hexPart, 16);
        if (!Number.isSafeInteger(chunkSize) || chunkSize < 0) {
          throw new ServerHttpError(400, {
            error: "invalid_request",
            message: "Invalid HTTP chunk size",
          });
        }
        this.pending = this.pending.subarray(lineEnd + 2);
        if (chunkSize === 0) {
          this.phase = "trailers";
          continue;
        }
        if (this.maxBodyBytes !== null && this.totalBytes + chunkSize > this.maxBodyBytes) {
          throw new ServerHttpError(413, {
            error: "payload_too_large",
            message: `Request body exceeds ${this.maxBodyBytes} bytes`,
          });
        }
        this.currentChunkSize = chunkSize;
        this.phase = "data";
        continue;
      }

      if (this.phase === "data") {
        if (this.pending.length < this.currentChunkSize + 2) {
          return null;
        }
        if (
          this.pending[this.currentChunkSize] !== 0x0d ||
          this.pending[this.currentChunkSize + 1] !== 0x0a
        ) {
          throw new ServerHttpError(400, {
            error: "invalid_request",
            message: "Malformed HTTP chunk terminator",
          });
        }
        const slice = this.pending.subarray(0, this.currentChunkSize);
        this.chunks.push(slice);
        this.totalBytes += slice.length;
        this.pending = this.pending.subarray(this.currentChunkSize + 2);
        this.currentChunkSize = 0;
        this.phase = "size";
        continue;
      }

      // phase === "trailers"
      const lineEnd = this.pending.indexOf("\r\n");
      if (lineEnd === -1) {
        if (this.trailerBytes + this.pending.length > MAX_HEADER_BYTES) {
          throw new ServerHttpError(400, {
            error: "invalid_request",
            message: "HTTP chunk trailers exceed limit",
          });
        }
        return null;
      }
      this.trailerBytes += lineEnd + 2;
      if (this.trailerBytes > MAX_HEADER_BYTES) {
        throw new ServerHttpError(400, {
          error: "invalid_request",
          message: "HTTP chunk trailers exceed limit",
        });
      }
      this.pending = this.pending.subarray(lineEnd + 2);
      if (lineEnd === 0) {
        this.phase = "done";
        return Buffer.concat(this.chunks, this.totalBytes);
      }
    }
  }
}

function serializeHttpJsonResponse(statusCode: number, body: unknown): Buffer {
  const payload = JSON.stringify(body ?? {});
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const header = [
    `HTTP/1.1 ${statusCode} ${resolveReasonPhrase(statusCode)}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${payloadBytes}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(header, "latin1"), Buffer.from(payload, "utf8")]);
}

function parseHttpRequestLine(startLine: string): { method: string; url: string } {
  const parts = startLine.split(" ");
  if (parts.length !== 3) {
    throw new ServerHttpError(400, {
      error: "invalid_request",
      message: "Malformed HTTP request line",
    });
  }
  const [method, url, version] = parts as [string, string, string];
  if (
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method) ||
    url.length === 0 ||
    !/^HTTP\/1\.[01]$/i.test(version)
  ) {
    throw new ServerHttpError(400, {
      error: "invalid_request",
      message: "Malformed HTTP request line",
    });
  }
  return { method, url };
}

/**
 * Creates a bounded HTTP/1.1 server backed by `node:net` instead of `node:http`.
 * Required for Windows Named Pipes under Bun standalone binaries (`oven-sh/bun` #24682),
 * where `http.createServer().listen("\\\\.\\pipe\\...")` throws `ENOENT` while
 * `net.createServer().listen(...)` binds and serves cleanly.
 */
export function createNetHttpServer(options: CreateNetHttpServerOptions): NetHttpServerHandle {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IPC_IDLE_TIMEOUT_MS;
  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => {
      activeSockets.delete(socket);
    });
    socket.on("error", () => {
      // Abrupt peer resets are isolated per connection.
    });
    socket.setTimeout(idleTimeoutMs, () => {
      socket.destroy();
    });

    let responded = false;
    let requestSettled = false;
    let headBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let parsedMeta: {
      method: string;
      url: string;
      headers: Record<string, string>;
      contentLength: number | null;
      chunked: boolean;
    } | null = null;
    const fixedBodyChunks: Buffer[] = [];
    let fixedBodyBytes = 0;
    let chunkDecoder: IncrementalChunkedDecoder | null = null;

    const writeErrorAndClose = (statusCode: number, body: unknown): void => {
      if (responded) {
        return;
      }
      responded = true;
      requestSettled = true;
      if (!socket.destroyed && socket.writable) {
        socket.end(serializeHttpJsonResponse(statusCode, body));
      } else {
        socket.destroy();
      }
    };

    const completeRequest = async (rawBodyBuffer: Buffer): Promise<void> => {
      if (requestSettled || !parsedMeta) {
        return;
      }
      requestSettled = true;
      socket.pause();
      try {
        const res = await options.onRequest({
          method: parsedMeta.method,
          url: parsedMeta.url,
          headers: parsedMeta.headers,
          rawBody: rawBodyBuffer.toString("utf8"),
        });
        if (responded) {
          return;
        }
        responded = true;
        const wireBuf = serializeHttpJsonResponse(res.status, res.body);
        if (!socket.destroyed && socket.writable) {
          socket.end(wireBuf, () => {
            res.afterFlush?.();
          });
        } else {
          res.afterFlush?.();
        }
      } catch (err) {
        const mapped = mapDomainError(err);
        writeErrorAndClose(mapped.statusCode, mapped.payload);
      }
    };

    const consumeBodySegment = (segment: Buffer): void => {
      if (!parsedMeta || requestSettled) {
        return;
      }
      if (parsedMeta.chunked) {
        if (!chunkDecoder) {
          chunkDecoder = new IncrementalChunkedDecoder(options.maxBodyBytes);
        }
        const decoded = chunkDecoder.feed(segment);
        if (decoded !== null) {
          void completeRequest(decoded);
        }
        return;
      }

      const expected = parsedMeta.contentLength ?? 0;
      if (expected === 0) {
        void completeRequest(Buffer.alloc(0));
        return;
      }
      if (segment.length > 0) {
        fixedBodyChunks.push(segment);
        fixedBodyBytes += segment.length;
        if (fixedBodyBytes > options.maxBodyBytes) {
          throw new ServerHttpError(413, {
            error: "payload_too_large",
            message: `Request body exceeds ${options.maxBodyBytes} bytes`,
          });
        }
      }
      if (fixedBodyBytes >= expected) {
        const combined = Buffer.concat(fixedBodyChunks, fixedBodyBytes).subarray(0, expected);
        void completeRequest(combined);
      }
    };

    socket.on("data", (chunk: Buffer | string) => {
      if (requestSettled) {
        return;
      }
      const chunkBuf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      try {
        if (!parsedMeta) {
          headBuf = headBuf.length === 0 ? chunkBuf : Buffer.concat([headBuf, chunkBuf]);
          const headerEnd = headBuf.indexOf("\r\n\r\n");
          if (headerEnd === -1) {
            if (headBuf.length > MAX_HEADER_BYTES) {
              writeErrorAndClose(431, {
                error: "header_too_large",
                message: `HTTP request headers exceed ${MAX_HEADER_BYTES} bytes`,
              });
            }
            return;
          }
          if (headerEnd > MAX_HEADER_BYTES) {
            writeErrorAndClose(431, {
              error: "header_too_large",
              message: `HTTP request headers exceed ${MAX_HEADER_BYTES} bytes`,
            });
            return;
          }

          const headerText = headBuf.subarray(0, headerEnd).toString("latin1");
          const parsedHead = parseHeadersBlock(headerText, {
            maxBodyBytes: options.maxBodyBytes,
            rejectDuplicateDifferingContentLength: true,
          });
          const reqLine = parseHttpRequestLine(parsedHead.startLine);
          parsedMeta = {
            method: reqLine.method,
            url: reqLine.url,
            headers: parsedHead.headers,
            contentLength: parsedHead.contentLength,
            chunked: parsedHead.chunked,
          };

          const remainder = headBuf.subarray(headerEnd + 4);
          headBuf = Buffer.alloc(0);
          consumeBodySegment(remainder);
          return;
        }

        consumeBodySegment(chunkBuf);
      } catch (err) {
        const mapped = mapDomainError(err);
        writeErrorAndClose(mapped.statusCode, mapped.payload);
      }
    });
  });

  return {
    server,
    closeAllConnections: () => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
    },
  };
}

/**
 * Sends a single HTTP/1.1 request over a `node:net` local IPC stream (POSIX UDS or Windows Named Pipe).
 * Compatible with both Node.js and Bun standalone executables on Windows.
 */
export async function sendNetHttpRequest(
  options: SendNetHttpRequestOptions,
): Promise<NetHttpClientResponse> {
  assertNoCrLf(options.method, "HTTP method");
  assertNoCrLf(options.path, "HTTP path");

  const bodyText = options.rawBody ?? "";
  const bodyBuf = Buffer.from(bodyText, "utf8");
  const headerMap = new Map<string, string>();
  headerMap.set("Host", "kilnd.local");
  headerMap.set("Connection", "close");

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (value === undefined) {
        continue;
      }
      assertNoCrLf(key, "header name");
      assertNoCrLf(value, `header value for "${key}"`);
      if (key.toLowerCase() === "content-length" || key.toLowerCase() === "transfer-encoding") {
        continue;
      }
      headerMap.set(key, value);
    }
  }
  headerMap.set("Content-Length", String(bodyBuf.length));

  const requestLines = [`${options.method} ${options.path} HTTP/1.1`];
  for (const [key, value] of headerMap.entries()) {
    requestLines.push(`${key}: ${value}`);
  }
  requestLines.push("", "");
  const wireHead = Buffer.from(requestLines.join("\r\n"), "latin1");
  const wirePayload = bodyBuf.length > 0 ? Buffer.concat([wireHead, bodyBuf]) : wireHead;

  return await new Promise<NetHttpClientResponse>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let settled = false;
    let rawBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let parsedHeaderEnd = -1;
    let status = 0;
    let parsedHeaders: Record<string, string> = {};
    let expectedContentLength: number | null = null;
    let isChunked = false;
    let chunkDecoder: IncrementalChunkedDecoder | null = null;

    const finishSuccess = (rawBody: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({ status, headers: parsedHeaders, rawBody });
    };

    const finishError = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(err);
    };

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      socket.setTimeout(options.timeoutMs, () => {
        finishError(new Error(`IPC HTTP request timed out after ${options.timeoutMs}ms`));
      });
    }

    socket.once("connect", () => {
      socket.write(wirePayload);
    });

    socket.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const chunkBuf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      rawBuf = rawBuf.length === 0 ? chunkBuf : Buffer.concat([rawBuf, chunkBuf]);

      if (parsedHeaderEnd === -1) {
        const headerEnd = rawBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (rawBuf.length > MAX_HEADER_BYTES) {
            finishError(new Error("IPC HTTP response headers exceed maximum size"));
          }
          return;
        }
        try {
          const headText = rawBuf.subarray(0, headerEnd).toString("latin1");
          const parsedHead = parseHeadersBlock(headText, {
            rejectDuplicateDifferingContentLength: true,
          });
          const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s.*)?$/i.exec(parsedHead.startLine);
          if (!statusMatch || !statusMatch[1]) {
            finishError(new Error(`Invalid IPC HTTP status line: "${parsedHead.startLine}"`));
            return;
          }
          status = Number.parseInt(statusMatch[1], 10);
          parsedHeaders = parsedHead.headers;
          expectedContentLength = parsedHead.contentLength;
          isChunked = parsedHead.chunked;
          parsedHeaderEnd = headerEnd;
        } catch (err) {
          finishError(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        const remainder = rawBuf.subarray(parsedHeaderEnd + 4);
        rawBuf = Buffer.alloc(0);
        if (isChunked) {
          chunkDecoder = new IncrementalChunkedDecoder(null);
          try {
            const decoded = chunkDecoder.feed(remainder);
            if (decoded !== null) {
              finishSuccess(decoded.toString("utf8"));
            }
          } catch (err) {
            finishError(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }
        rawBuf = remainder;
      } else if (isChunked && chunkDecoder) {
        try {
          const decoded = chunkDecoder.feed(chunkBuf);
          rawBuf = Buffer.alloc(0);
          if (decoded !== null) {
            finishSuccess(decoded.toString("utf8"));
          }
        } catch (err) {
          finishError(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }

      if (!isChunked && expectedContentLength !== null && rawBuf.length >= expectedContentLength) {
        finishSuccess(rawBuf.subarray(0, expectedContentLength).toString("utf8"));
      }
    });

    socket.on("end", () => {
      if (settled) {
        return;
      }
      if (parsedHeaderEnd === -1) {
        finishError(new Error("IPC HTTP connection ended before headers were received"));
        return;
      }
      if (isChunked) {
        finishError(new Error("IPC HTTP connection ended before chunked response completed"));
        return;
      }
      if (expectedContentLength !== null && rawBuf.length < expectedContentLength) {
        finishError(new Error("IPC HTTP response truncated before Content-Length completed"));
        return;
      }
      finishSuccess(
        expectedContentLength !== null
          ? rawBuf.subarray(0, expectedContentLength).toString("utf8")
          : rawBuf.toString("utf8"),
      );
    });

    socket.on("close", (hadError) => {
      if (!settled && !hadError) {
        finishError(new Error("IPC HTTP connection closed unexpectedly"));
      }
    });

    socket.on("error", (err) => {
      finishError(err);
    });
  });
}
