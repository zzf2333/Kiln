import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import {
  MCP_TOOL_NAMES,
  McpToolNameSchema,
  WbPlanInputSchema,
  type McpToolName,
} from "@kiln/protocol";
import {
  KilnRpcError,
  KilnSocketRpcClient,
  MCP_TOOL_INPUT_SCHEMAS,
  resolveKilnSocketPath,
  type KilnRpcTransport,
} from "./client.js";

export interface KilnMcpToolCaller {
  callTool<T extends McpToolName>(tool: T, input: unknown): Promise<unknown>;
}

export interface CreateKilnMcpServerOptions {
  client: KilnMcpToolCaller;
  name?: string;
  version?: string;
}

export interface RunStdioMcpServerOptions {
  socketPath?: string;
  rpcTransport?: KilnRpcTransport;
  mcpTransport?: Transport;
  name?: string;
  version?: string;
}

export interface RunningMcpServer {
  client: KilnSocketRpcClient;
  server: Server;
  transport: Transport;
  close: () => Promise<void>;
}

const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  wb_get_context:
    "Read current task contract, contract_version, brief, derived state, space config, active run/lease, and pending decision.",
  wb_list_tasks:
    "Read-only list of tasks and associated space configurations, optionally filtered by space or status.",
  wb_read_ledger: "Read long-term engineering constraint entries from the space ledger.",
  wb_plan:
    "Create or update a task draft (upsert_draft), commit a formal task card (commit_card), commit split dependent cards (commit_split_cards), bump contract_version with affected stages (update_contract), or update a waiting task's pending decision options/instructions (update_decision).",
  wb_ask_decision:
    "Suspend execution into waiting state and submit a structured pending decision with explicit action options.",
  wb_submit_receipt:
    "Submit stage execution receipt or judgment conclusion markdown; kilnd validates active lease and contract_version atomically.",
  wb_propose_ledger:
    "Propose a long-term engineering constraint rule for a space, pending human confirmation before ledger persistence.",
};

type ToolInputSchema = Tool["inputSchema"];

function stripDollarSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

/**
 * Converts `@kiln/protocol` Zod tool schemas into MCP-compliant `Tool.inputSchema` objects.
 * `WbPlanInputSchema` is a `z.discriminatedUnion`, so we preserve its `anyOf` branch
 * constraints while exposing top-level `type: "object"` and merged `properties` required
 * by MCP `ToolSchema`.
 */
function buildToolInputSchema(tool: McpToolName): ToolInputSchema {
  if (tool === "wb_plan") {
    const rawPlanUnion = (
      "_def" in WbPlanInputSchema && "schema" in WbPlanInputSchema._def
        ? WbPlanInputSchema._def.schema
        : WbPlanInputSchema
    ) as z.ZodTypeAny & { options: readonly z.ZodTypeAny[] };
    const unionJson = stripDollarSchema(
      toJsonSchemaCompat(rawPlanUnion, {
        strictUnions: true,
        pipeStrategy: "input",
      }),
    );
    const mergedProperties: Record<string, object> = {};
    for (const option of rawPlanUnion.options) {
      const optJson = toJsonSchemaCompat(option, {
        strictUnions: true,
        pipeStrategy: "input",
      });
      if (optJson.properties && typeof optJson.properties === "object") {
        Object.assign(mergedProperties, optJson.properties as Record<string, object>);
      }
    }
    mergedProperties.mode = {
      type: "string",
      enum: [
        "upsert_draft",
        "commit_card",
        "update_contract",
        "update_decision",
        "commit_split_cards",
      ],
    };

    const normalizedAnyOf = Array.isArray(unionJson.anyOf)
      ? unionJson.anyOf.map((branch) => {
          if (branch && typeof branch === "object" && !Array.isArray(branch)) {
            const { additionalProperties: _ap, ...rest } = branch as Record<string, unknown>;
            return rest;
          }
          return branch;
        })
      : unionJson.anyOf;

    return {
      type: "object",
      properties: mergedProperties,
      required: ["mode"],
      additionalProperties: false,
      anyOf: normalizedAnyOf,
    };
  }

  const converted = stripDollarSchema(
    toJsonSchemaCompat(MCP_TOOL_INPUT_SCHEMAS[tool], {
      strictUnions: true,
      pipeStrategy: "input",
    }),
  );
  return converted as ToolInputSchema;
}

export const KILN_MCP_TOOLS: readonly Tool[] = MCP_TOOL_NAMES.map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: buildToolInputSchema(name),
}));

function buildErrorResult(payload: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function formatToolError(tool: McpToolName, err: unknown): CallToolResult {
  if (err instanceof ZodError) {
    return buildErrorResult({
      error: "validation_error",
      tool,
      message: err.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
      issues: err.issues,
    });
  }

  if (err instanceof KilnRpcError) {
    const basePayload =
      err.payload && typeof err.payload === "object" && !Array.isArray(err.payload)
        ? (err.payload as Record<string, unknown>)
        : { payload: err.payload };
    return buildErrorResult({
      ...basePayload,
      status: err.status,
      code: err.code,
      message: err.message,
    });
  }

  return buildErrorResult({
    error: "rpc_transport_error",
    tool,
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Creates an MCP `Server` exposing strictly the 7 whitelisted `MCP_TOOL_NAMES` tools
 * and delegating execution to `KilnSocketRpcClient`.
 */
export function createKilnMcpServer(options: CreateKilnMcpServerOptions): Server {
  const server = new Server(
    {
      name: options.name ?? "kiln-mcp",
      version: options.version ?? "0.0.8",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...KILN_MCP_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const rawName = request.params.name;
    const parsedTool = McpToolNameSchema.safeParse(rawName);
    if (!parsedTool.success) {
      return buildErrorResult({
        error: "unknown_tool",
        tool: rawName,
        message: `Unknown MCP tool "${rawName}"`,
      });
    }

    const tool = parsedTool.data;
    const rawArgs = request.params.arguments ?? {};
    const sanitizedArgs =
      typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
        ? (({ toolSummary: _toolSummary, ...rest }) => rest)(rawArgs as Record<string, unknown>)
        : rawArgs;

    try {
      const validatedArgs = MCP_TOOL_INPUT_SCHEMAS[tool].parse(sanitizedArgs);
      const result = await options.client.callTool(tool, validatedArgs);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return formatToolError(tool, err);
    }
  });

  return server;
}

/**
 * Validates `KILN_RUN_TOKEN`, creates a `KilnSocketRpcClient`, and attaches the 7-tool
 * MCP server to `StdioServerTransport` (or an injected transport for tests).
 */
export async function runStdioMcpServer(
  env: NodeJS.ProcessEnv = process.env,
  options: RunStdioMcpServerOptions = {},
): Promise<RunningMcpServer> {
  const rawToken = env.KILN_RUN_TOKEN;
  if (typeof rawToken !== "string" || rawToken.trim().length === 0) {
    throw new Error("KILN_RUN_TOKEN environment variable is required and must be non-empty");
  }

  const socketPath = resolveKilnSocketPath(options.socketPath, env);
  const client = new KilnSocketRpcClient({
    token: rawToken,
    socketPath,
    transport: options.rpcTransport,
  });
  const server = createKilnMcpServer({
    client,
    name: options.name,
    version: options.version,
  });
  const transport = options.mcpTransport ?? new StdioServerTransport();
  await server.connect(transport);

  let closed = false;
  return {
    client,
    server,
    transport,
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
    },
  };
}
