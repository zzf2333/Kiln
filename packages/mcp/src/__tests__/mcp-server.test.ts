import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ZodError } from "zod";
import { MCP_TOOL_NAMES, RoleForbiddenErrorSchema } from "@kiln/protocol";
import {
  KilnRpcError,
  KilnSocketRpcClient,
  createKilnMcpServer,
  isRoleForbiddenError,
  isWindowsNamedPipe,
  resolveDefaultIpcPath,
  resolveKilnSocketPath,
  type KilnRpcTransport,
} from "../index.js";
import { runStdioMcpServer as runFromBin } from "../bin.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = path.join(PACKAGE_ROOT, "src");

interface CapturedRpcRequest {
  method: "POST";
  path: string;
  headers: Record<string, string>;
  rawBody: string;
  parsedBody: unknown;
}

function collectNonTestSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...collectNonTestSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function getFirstTextContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = "content" in result && Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`Expected text content in MCP tool result, got: ${JSON.stringify(result)}`);
  }
  return first.text;
}

async function connectMcpPair(options: {
  token: string;
  transport: KilnRpcTransport;
}): Promise<{
  mcpClient: Client;
  rpcClient: KilnSocketRpcClient;
  close: () => Promise<void>;
}> {
  const rpcClient = new KilnSocketRpcClient({
    token: options.token,
    socketPath: "/tmp/kiln-inmemory-test.sock",
    transport: options.transport,
  });
  const mcpServer = createKilnMcpServer({ client: rpcClient });
  const mcpClient = new Client({ name: "kiln-mcp-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

  return {
    mcpClient,
    rpcClient,
    close: async () => {
      await Promise.all([mcpClient.close(), mcpServer.close()]);
    },
  };
}

describe("@kiln/mcp server & client", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("enforces strict static dependency isolation (zero kernel/sqlite references)", () => {
    const sourceFiles = collectNonTestSourceFiles(SRC_ROOT);
    expect(sourceFiles.length).toBeGreaterThanOrEqual(4);

    const forbiddenPatterns = [
      "@kiln/kernel",
      "better-sqlite3",
      "bun:sqlite",
      "node:sqlite",
      "index.sqlite",
      "kiln-store",
      "tasks_index",
      "stage_leases",
    ];

    for (const filePath of sourceFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(content, `${path.relative(PACKAGE_ROOT, filePath)} must not reference ${pattern}`).not.toContain(
          pattern,
        );
      }
    }

    const pkgJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkgJson.dependencies?.["@kiln/kernel"]).toBeUndefined();
    expect(pkgJson.dependencies?.["better-sqlite3"]).toBeUndefined();
    expect(pkgJson.devDependencies?.["@kiln/kernel"]).toBeUndefined();
    expect(pkgJson.devDependencies?.["better-sqlite3"]).toBeUndefined();
  });

  it("resolves socketPath precedence and validates token/socketPath inputs", () => {
    expect(() => new KilnSocketRpcClient({ token: "" })).toThrow(/KILN_RUN_TOKEN/);
    expect(() => new KilnSocketRpcClient({ token: "   " })).toThrow(/KILN_RUN_TOKEN/);
    expect(() => resolveKilnSocketPath("   ", {})).toThrow(/socketPath/);

    expect(
      resolveKilnSocketPath("/custom/override.sock", {
        KILN_SOCK_PATH: "/env/sock.sock",
        KILN_HOME: "/env/home",
      }),
    ).toBe("/custom/override.sock");

    expect(
      resolveKilnSocketPath(undefined, {
        KILN_SOCK_PATH: "/env/sock.sock",
        KILN_HOME: "/env/home",
      }),
    ).toBe("/env/sock.sock");

    expect(
      resolveKilnSocketPath(undefined, {
        KILN_HOME: "/env/home",
      }, "darwin"),
    ).toBe(path.join(path.resolve("/env/home"), "run", "kilnd.sock"));

    expect(resolveKilnSocketPath(undefined, {}, "linux")).toBe(
      path.join(path.resolve(os.homedir(), ".kiln"), "run", "kilnd.sock"),
    );

    const winPipe = resolveKilnSocketPath(
      undefined,
      { KILN_HOME: "C:\\Users\\Alice\\.kiln" },
      "win32",
    );
    expect(isWindowsNamedPipe(winPipe)).toBe(true);
    expect(winPipe).toBe(resolveDefaultIpcPath("c:/users/alice/.kiln/", "win32"));

    expect(
      resolveKilnSocketPath(undefined, {
        KILN_HOME: "/env/home",
      }),
    ).toBe(resolveDefaultIpcPath("/env/home"));

    expect(resolveKilnSocketPath(undefined, {})).toBe(
      resolveDefaultIpcPath(path.join(os.homedir(), ".kiln")),
    );
  });

  it("exposes strictly the 7 MCP_TOOL_NAMES tools with valid object schemas", async () => {
    const pair = await connectMcpPair({
      token: "tok-list-check",
      transport: async () => ({ status: 200, body: { ok: true } }),
    });
    cleanups.push(pair.close);

    const listed = await pair.mcpClient.listTools();
    const toolNames = listed.tools.map((t) => t.name);

    expect(toolNames).toEqual([...MCP_TOOL_NAMES]);
    expect(toolNames).toHaveLength(7);

    for (const forbidden of ["merge", "push", "publish", "delete_branch", "close_task", "git_push"]) {
      expect(toolNames).not.toContain(forbidden);
    }

    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe("object");
    }

    const wbPlanTool = listed.tools.find((t) => t.name === "wb_plan");
    expect(wbPlanTool).toBeDefined();
    expect(wbPlanTool?.inputSchema.required).toContain("mode");
    expect(wbPlanTool?.inputSchema.properties).toHaveProperty("mode");
    expect(wbPlanTool?.inputSchema.properties).toHaveProperty("contract");
    expect(wbPlanTool?.inputSchema.properties).toHaveProperty("brief_markdown");
    expect(wbPlanTool?.inputSchema.properties).toHaveProperty("open_questions");
    expect(Array.isArray(wbPlanTool?.inputSchema.anyOf)).toBe(true);
    expect((wbPlanTool?.inputSchema.anyOf as unknown[]).length).toBe(4);
    const modeProp = wbPlanTool?.inputSchema.properties?.mode as { enum?: string[] } | undefined;
    expect(modeProp?.enum).toContain("commit_split_cards");
  });

  it("forwards all 7 valid tool calls with Bearer KILN_RUN_TOKEN to /rpc/mcp/:tool", async () => {
    const token = "hmac-run-token-v1.payload.sig";
    const captured: CapturedRpcRequest[] = [];

    const pair = await connectMcpPair({
      token,
      transport: async (req) => {
        const parsedBody = JSON.parse(req.rawBody) as unknown;
        captured.push({ ...req, parsedBody });
        return {
          status: 200,
          body: {
            ok: true,
            endpoint: req.path,
            echo: parsedBody,
          },
        };
      },
    });
    cleanups.push(pair.close);

    const validPayloads: Array<{
      name: (typeof MCP_TOOL_NAMES)[number];
      args: Record<string, unknown> | undefined;
      expectedBody: Record<string, unknown>;
    }> = [
      {
        name: "wb_get_context",
        args: undefined,
        expectedBody: {},
      },
      {
        name: "wb_list_tasks",
        args: { space: "kiln", status: "queued" },
        expectedBody: { space: "kiln", status: "queued" },
      },
      {
        name: "wb_read_ledger",
        args: { space: "kiln" },
        expectedBody: { space: "kiln" },
      },
      {
        name: "wb_plan",
        args: {
          mode: "upsert_draft",
          draft_id: "draft-1",
          title: "Implement MCP server",
          space: "kiln",
          priority: "P1",
          open_questions: ["确认超时阈值"],
          brief_markdown: "## 1. 目标与用户场景\n完善 MCP 工具链",
        },
        expectedBody: {
          mode: "upsert_draft",
          draft_id: "draft-1",
          title: "Implement MCP server",
          space: "kiln",
          priority: "P1",
          open_questions: ["确认超时阈值"],
          brief_markdown: "## 1. 目标与用户场景\n完善 MCP 工具链",
        },
      },
      {
        name: "wb_plan",
        args: {
          mode: "commit_card",
          title: "MCP commit card",
          space: "kiln",
          workspace_mode: "git_worktree",
          contract: {
            goal: "Build MCP server",
            end: "All tests pass",
            accept_cmd: "pnpm --filter @kiln/mcp test",
            accept_files_hash: "sha256:abc123",
            scope: ["packages/mcp/**"],
            deliver: { mode: "manual", cmd: null },
          },
          brief_markdown: "# Brief",
        },
        expectedBody: {
          mode: "commit_card",
          title: "MCP commit card",
          space: "kiln",
          priority: "P2",
          track: "L2",
          workspace_mode: "git_worktree",
          parent: null,
          depends_on: [],
          contract: {
            goal: "Build MCP server",
            end: "All tests pass",
            accept_cmd: "pnpm --filter @kiln/mcp test",
            accept_files_hash: "sha256:abc123",
            scope: ["packages/mcp/**"],
            deliver: { mode: "manual", cmd: null },
            human_accept: false,
            external_actions: "ask",
          },
          brief_markdown: "# Brief",
        },
      },
      {
        name: "wb_plan",
        args: {
          mode: "update_contract",
          task_id: "t-123",
          contract: { goal: "Updated goal" },
          affected_stages: ["implement", "verify"],
          rationale: "Clarified scope",
        },
        expectedBody: {
          mode: "update_contract",
          task_id: "t-123",
          contract: { goal: "Updated goal" },
          affected_stages: ["implement", "verify"],
          rationale: "Clarified scope",
        },
      },
      {
        name: "wb_ask_decision",
        args: {
          category: "scope_ambiguity",
          reason: "Need API choice",
          question: "Use Server or McpServer?",
          options: [
            {
              id: "opt-server",
              label: "Use low-level Server",
              action: "resume",
              target_stage: "implement",
              recommended: true,
            },
          ],
        },
        expectedBody: {
          category: "scope_ambiguity",
          reason: "Need API choice",
          question: "Use Server or McpServer?",
          options: [
            {
              id: "opt-server",
              label: "Use low-level Server",
              action: "resume",
              target_stage: "implement",
              recommended: true,
            },
          ],
        },
      },
      {
        name: "wb_submit_receipt",
        args: {
          markdown: "---\noutcome: pass\n---\nAll checks green.",
        },
        expectedBody: {
          markdown: "---\noutcome: pass\n---\nAll checks green.",
        },
      },
      {
        name: "wb_propose_ledger",
        args: {
          space: "kiln",
          rule: "Always validate discriminated unions via top-level object JSON Schema",
          rationale: "Avoid empty inputSchema stripping in MCP clients",
        },
        expectedBody: {
          space: "kiln",
          rule: "Always validate discriminated unions via top-level object JSON Schema",
          rationale: "Avoid empty inputSchema stripping in MCP clients",
        },
      },
    ];

    for (const testCase of validPayloads) {
      const result = await pair.mcpClient.callTool({
        name: testCase.name,
        ...(testCase.args !== undefined ? { arguments: testCase.args } : {}),
      });

      expect(result.isError).toBeFalsy();
      const parsedText = JSON.parse(getFirstTextContent(result)) as {
        ok: boolean;
        endpoint: string;
        echo: unknown;
      };
      expect(parsedText.ok).toBe(true);
      expect(parsedText.endpoint).toBe(`/rpc/mcp/${testCase.name}`);
      expect(parsedText.echo).toEqual(testCase.expectedBody);
    }

    expect(captured).toHaveLength(validPayloads.length);
    for (const req of captured) {
      expect(req.method).toBe("POST");
      expect(req.headers.Authorization).toBe(`Bearer ${token}`);
      expect(req.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("blocks invalid wb_plan and unknown tools client-side without invoking RPC", async () => {
    let rpcCount = 0;
    const pair = await connectMcpPair({
      token: "tok-validation",
      transport: async () => {
        rpcCount += 1;
        return { status: 200, body: { ok: true } };
      },
    });
    cleanups.push(pair.close);

    await expect(
      pair.rpcClient.callTool("wb_plan", {
        mode: "commit_card",
        title: "missing contract and brief",
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(rpcCount).toBe(0);

    const invalidPlanResult = await pair.mcpClient.callTool({
      name: "wb_plan",
      arguments: {
        mode: "commit_card",
        title: "missing required fields",
      },
    });
    expect(invalidPlanResult.isError).toBe(true);
    const invalidPlanPayload = JSON.parse(getFirstTextContent(invalidPlanResult)) as {
      error: string;
      tool: string;
      issues: unknown[];
    };
    expect(invalidPlanPayload.error).toBe("validation_error");
    expect(invalidPlanPayload.tool).toBe("wb_plan");
    expect(invalidPlanPayload.issues.length).toBeGreaterThan(0);
    expect(rpcCount).toBe(0);

    const unknownToolResult = await pair.mcpClient.callTool({
      name: "merge_main",
      arguments: {},
    });
    expect(unknownToolResult.isError).toBe(true);
    const unknownPayload = JSON.parse(getFirstTextContent(unknownToolResult)) as {
      error: string;
      tool: string;
    };
    expect(unknownPayload.error).toBe("unknown_tool");
    expect(unknownPayload.tool).toBe("merge_main");
    expect(rpcCount).toBe(0);

    const cyclicSplit = await pair.mcpClient.callTool({
      name: "wb_plan",
      arguments: {
        mode: "commit_split_cards",
        cards: [
          {
            temp_id: "a",
            title: "Card A",
            space: "local",
            workspace_mode: "scratch_dir",
            depends_on_temp_ids: ["b"],
            contract: {
              goal: "g",
              end: "out.txt",
              accept_cmd: "test -f out.txt",
              accept_files_hash: "deadbeef",
              scope: ["out.txt"],
              deliver: { mode: "manual" },
            },
            brief_markdown: "A",
          },
          {
            temp_id: "b",
            title: "Card B",
            space: "local",
            workspace_mode: "scratch_dir",
            depends_on_temp_ids: ["a"],
            contract: {
              goal: "g2",
              end: "out2.txt",
              accept_cmd: "test -f out2.txt",
              accept_files_hash: "deadbeef",
              scope: ["out2.txt"],
              deliver: { mode: "manual" },
            },
            brief_markdown: "B",
          },
        ],
      },
    });
    expect(cyclicSplit.isError).toBe(true);
    expect(rpcCount).toBe(0);
  });

  it("preserves 403 role_forbidden via KilnRpcError, isRoleForbiddenError, and MCP isError", async () => {
    const forbiddenBody = RoleForbiddenErrorSchema.parse({
      code: "role_forbidden",
      role: "worker",
      tool: "wb_plan",
      message: 'Role "worker" is not allowed to invoke "wb_plan"',
    });

    const pair = await connectMcpPair({
      token: "tok-worker",
      transport: async (req) => {
        if (req.path === "/rpc/mcp/wb_plan") {
          return { status: 403, body: forbiddenBody };
        }
        return { status: 200, body: { ok: true } };
      },
    });
    cleanups.push(pair.close);

    let caught: unknown;
    try {
      await pair.rpcClient.callTool("wb_plan", {
        mode: "upsert_draft",
        draft_id: "d-worker-forbidden",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(KilnRpcError);
    expect(isRoleForbiddenError(caught)).toBe(true);
    if (isRoleForbiddenError(caught)) {
      expect(caught.status).toBe(403);
      expect(caught.code).toBe("role_forbidden");
      expect(caught.payload.role).toBe("worker");
      expect(caught.payload.tool).toBe("wb_plan");
    }

    expect(
      isRoleForbiddenError(
        new KilnRpcError(403, { error: "task_scope_forbidden", message: "Wrong task" }),
      ),
    ).toBe(false);
    expect(isRoleForbiddenError(new Error("plain error"))).toBe(false);

    const mcpResult = await pair.mcpClient.callTool({
      name: "wb_plan",
      arguments: {
        mode: "upsert_draft",
        draft_id: "d-worker-forbidden",
      },
    });
    expect(mcpResult.isError).toBe(true);
    const text = getFirstTextContent(mcpResult);
    expect(text).toContain("role_forbidden");
    const parsedError = JSON.parse(text) as {
      status: number;
      code: string;
      role: string;
      tool: string;
      message: string;
    };
    expect(parsedError.status).toBe(403);
    expect(parsedError.code).toBe("role_forbidden");
    expect(parsedError.role).toBe("worker");
    expect(parsedError.tool).toBe("wb_plan");

    // Server remains healthy after error
    const okResult = await pair.mcpClient.callTool({ name: "wb_get_context", arguments: {} });
    expect(okResult.isError).toBeFalsy();
  });

  it("handles RPC transport failures gracefully without crashing MCP server", async () => {
    let failNext = true;
    const pair = await connectMcpPair({
      token: "tok-transient",
      transport: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("connect ECONNREFUSED kilnd.sock");
        }
        return { status: 200, body: { ok: true, recovered: true } };
      },
    });
    cleanups.push(pair.close);

    const errResult = await pair.mcpClient.callTool({
      name: "wb_get_context",
      arguments: {},
    });
    expect(errResult.isError).toBe(true);
    const parsedErr = JSON.parse(getFirstTextContent(errResult)) as {
      error: string;
      message: string;
    };
    expect(parsedErr.error).toBe("rpc_transport_error");
    expect(parsedErr.message).toContain("ECONNREFUSED");

    const okResult = await pair.mcpClient.callTool({
      name: "wb_get_context",
      arguments: {},
    });
    expect(okResult.isError).toBeFalsy();
    expect(JSON.parse(getFirstTextContent(okResult))).toEqual({ ok: true, recovered: true });
  });

  it("fails fast in runStdioMcpServer when KILN_RUN_TOKEN is missing or blank, and runs cleanly when present", async () => {
    await expect(runFromBin({})).rejects.toThrow(/KILN_RUN_TOKEN/);
    await expect(runFromBin({ KILN_RUN_TOKEN: "   \t\n " })).rejects.toThrow(/KILN_RUN_TOKEN/);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = await runFromBin(
      {
        KILN_RUN_TOKEN: "tok-bin-stdio",
        KILN_HOME: "/tmp/kiln-mcp-env-home",
      },
      {
        mcpTransport: serverTransport,
        rpcTransport: async (req) => ({
          status: 200,
          body: { ok: true, auth: req.headers.Authorization },
        }),
      },
    );
    cleanups.push(handle.close);

    expect(handle.client.socketPath).toBe(resolveDefaultIpcPath("/tmp/kiln-mcp-env-home"));

    const mcpClient = new Client({ name: "bin-test-client", version: "0.1.0" });
    await mcpClient.connect(clientTransport);
    cleanups.push(async () => {
      await mcpClient.close();
    });

    const res = await mcpClient.callTool({ name: "wb_get_context", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(getFirstTextContent(res))).toEqual({
      ok: true,
      auth: "Bearer tok-bin-stdio",
    });
  });
});
