import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RoleForbiddenErrorSchema } from "@kiln/protocol";
import {
  KilnRpcError,
  KilnSocketRpcClient,
  createKilnMcpServer,
  isRoleForbiddenError,
  isWindowsNamedPipe,
  resolveDefaultIpcPath,
  sendNamedPipeHttpRequest,
} from "../index.js";

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

describe("@kiln/mcp OS Unix Domain Socket smoke suite (requires unsandboxed connect)", () => {
  const tempDirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const srv = servers.pop()!;
      srv.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        srv.close((err) => (err ? reject(err) : resolve()));
      });
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("connects KilnSocketRpcClient and MCP server over real local IPC (UDS / Named Pipe) with Host header", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-mcp-"));
    tempDirs.push(dir);
    const socketPath =
      process.platform === "win32"
        ? resolveDefaultIpcPath(dir, "win32")
        : path.join(dir, "kilnd.sock");
    const seenHosts: Array<string | undefined> = [];

    const server = http.createServer(async (req, res) => {
      seenHosts.push(req.headers.host);
      const rawBody = await readRequestBody(req);
      const auth = req.headers.authorization;
      if (auth !== "Bearer tok-live-socket") {
        const body = JSON.stringify({ error: "unauthorized", message: "Invalid token" });
        res.writeHead(401, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (req.method === "POST" && req.url === "/rpc/mcp/wb_plan") {
        const forbidden = RoleForbiddenErrorSchema.parse({
          code: "role_forbidden",
          role: "worker",
          tool: "wb_plan",
          message: 'Role "worker" is not allowed to invoke "wb_plan"',
        });
        const body = JSON.stringify(forbidden);
        res.writeHead(403, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (req.method === "POST" && req.url === "/rpc/mcp/wb_get_context") {
        const body = JSON.stringify({
          ok: true,
          taskId: "t-sock-smoke",
          receivedBody: JSON.parse(rawBody || "{}"),
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      const notFound = JSON.stringify({ error: "not_found", message: "Route not found" });
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(notFound),
      });
      res.end(notFound);
    });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        if (!isWindowsNamedPipe(socketPath) && process.platform !== "win32") {
          fs.chmodSync(socketPath, 0o600);
        }
        resolve();
      });
    });

    const rpcClient = new KilnSocketRpcClient({
      token: "tok-live-socket",
      socketPath,
    });

    const ctx = (await rpcClient.callTool("wb_get_context", {})) as {
      ok: boolean;
      taskId: string;
    };
    expect(ctx.ok).toBe(true);
    expect(ctx.taskId).toBe("t-sock-smoke");
    expect(seenHosts[0]).toBe("kilnd.local");

    let forbiddenErr: unknown;
    try {
      await rpcClient.callTool("wb_plan", {
        mode: "upsert_draft",
        draft_id: "d-sock-1",
      });
    } catch (err) {
      forbiddenErr = err;
    }
    expect(forbiddenErr).toBeInstanceOf(KilnRpcError);
    expect(isRoleForbiddenError(forbiddenErr)).toBe(true);

    const mcpServer = createKilnMcpServer({ client: rpcClient });
    const mcpClient = new Client({ name: "socket-smoke-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const mcpCtx = await mcpClient.callTool({ name: "wb_get_context", arguments: {} });
      expect(mcpCtx.isError).toBeFalsy();
      const ctxContent = "content" in mcpCtx && Array.isArray(mcpCtx.content) ? mcpCtx.content : [];
      const textItem = ctxContent[0];
      expect(textItem?.type).toBe("text");
      if (textItem?.type === "text" && typeof textItem.text === "string") {
        expect(JSON.parse(textItem.text)).toEqual({
          ok: true,
          taskId: "t-sock-smoke",
          receivedBody: {},
        });
      }

      const mcpForbidden = await mcpClient.callTool({
        name: "wb_plan",
        arguments: { mode: "upsert_draft", draft_id: "d-sock-1" },
      });
      expect(mcpForbidden.isError).toBe(true);
      const errContent =
        "content" in mcpForbidden && Array.isArray(mcpForbidden.content)
          ? mcpForbidden.content
          : [];
      const errItem = errContent[0];
      expect(errItem?.type).toBe("text");
      if (errItem?.type === "text" && typeof errItem.text === "string") {
        expect(errItem.text).toContain("role_forbidden");
      }
    } finally {
      await Promise.all([mcpClient.close(), mcpServer.close()]);
    }
  });

  it("executes sendNamedPipeHttpRequest over node:net handling Content-Length, chunked framing, Host header, and 403", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-mcp-net-"));
    tempDirs.push(dir);
    const socketPath =
      process.platform === "win32"
        ? resolveDefaultIpcPath(dir, "win32")
        : path.join(dir, "kilnd-net.sock");
    const seenHosts: Array<string | undefined> = [];

    const server = http.createServer(async (req, res) => {
      seenHosts.push(req.headers.host);
      await readRequestBody(req);
      if (req.headers.authorization !== "Bearer tok-net-client") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.url === "/rpc/mcp/wb_plan") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            RoleForbiddenErrorSchema.parse({
              code: "role_forbidden",
              role: "worker",
              tool: "wb_plan",
              message: 'Role "worker" is not allowed to invoke "wb_plan"',
            }),
          ),
        );
        return;
      }
      // Deliberately omit Content-Length so Node uses Transfer-Encoding: chunked
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"ok":true,');
      res.end('"chunked":true}');
    });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const okRes = await sendNamedPipeHttpRequest(socketPath, {
      method: "POST",
      path: "/rpc/mcp/wb_get_context",
      headers: {
        Authorization: "Bearer tok-net-client",
        "Content-Type": "application/json",
      },
      rawBody: "{}",
    });
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({ ok: true, chunked: true });
    expect(seenHosts[0]).toBe("kilnd.local");

    const forbiddenRes = await sendNamedPipeHttpRequest(socketPath, {
      method: "POST",
      path: "/rpc/mcp/wb_plan",
      headers: {
        Authorization: "Bearer tok-net-client",
        "Content-Type": "application/json",
      },
      rawBody: "{}",
    });
    expect(forbiddenRes.status).toBe(403);
    expect(RoleForbiddenErrorSchema.parse(forbiddenRes.body).code).toBe("role_forbidden");
  });
});
