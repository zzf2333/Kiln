import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultProvidersConfig, type ProvidersConfig, type RunEvent } from "@kiln/protocol";
import { verifyBackendContract } from "./contract.suite.js";
import { AcpBackend } from "../acp/index.js";
import { ClaudeDirectBackend } from "../claude-direct.js";
import {
  CodexAppServerBackend,
  prepareIsolatedCodexHome,
  resolveIsolatedCodexHome,
} from "../codex-app-server.js";
import { CompositeBackend } from "../composite-backend.js";
import { PiRpcBackend } from "../pi-rpc.js";
import { ProviderHealthTracker } from "../provider-health.js";
import { StdioRpcProcess, buildAgentCliEnv } from "../stdio-rpc.js";
import { FullAccessOnlyProviderError, type ExecutionBackend } from "../types.js";

let fixtureDir = "";
let codexScript = "";
let piScript = "";
let acpScript = "";
let acpFullAccessOnlyScript = "";
let claudeScript = "";

async function collectAllEvents(
  backend: ExecutionBackend,
  sessionRef: Awaited<ReturnType<ExecutionBackend["start"]>>,
) {
  const out: RunEvent[] = [];
  for await (const ev of backend.events(sessionRef)) {
    out.push(ev);
  }
  return out;
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-multi-cli-fixtures-"));
  codexScript = path.join(fixtureDir, "codex-fake.mjs");
  piScript = path.join(fixtureDir, "pi-fake.mjs");
  acpScript = path.join(fixtureDir, "acp-fake.mjs");
  acpFullAccessOnlyScript = path.join(fixtureDir, "acp-fullaccess-fake.mjs");
  claudeScript = path.join(fixtureDir, "claude-fake.mjs");

  fs.writeFileSync(
    codexScript,
    `
import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.170.0-test");
  process.exit(0);
}

let buf = "";
let turnCount = 0;
let cumIn = 0;
let cumCached = 0;
let cumOut = 0;
let cumReasoning = 0;
let activeTurn = null;
const logFile = process.env.TEST_CODEX_LOG;
const pendingServerReq = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function appendLog(rec) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify(rec) + "\\n");
}

appendLog({
  type: "env",
  CODEX_HOME: process.env.CODEX_HOME ?? null,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
  KILN_RUN_TOKEN: process.env.KILN_RUN_TOKEN ?? null,
  GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? null,
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (true) {
    const idx = buf.indexOf("\\n");
    if (idx === -1) break;
    const line = buf.slice(0, idx).replace(/\\r$/, "").trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);

    if ("id" in msg && ("result" in msg || "error" in msg) && !msg.method) {
      const resolver = pendingServerReq.get(msg.id);
      if (resolver) {
        pendingServerReq.delete(msg.id);
        resolver(msg.result);
      }
      continue;
    }

    if (msg.method === "initialize") {
      send({ id: msg.id, result: { userAgent: "codex-fake/0.170.0" } });
    } else if (msg.method === "model/list") {
      send({
        id: msg.id,
        result: {
          data: [
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
              defaultReasoningEffort: "low",
            },
          ],
        },
      });
    } else if (msg.method === "account/rateLimits/read") {
      send({
        id: msg.id,
        result: {
          rateLimits: {
            limitId: "codex",
            planType: "prolite",
            primary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1800000000 },
          },
        },
      });
    } else if (msg.method === "thread/start") {
      appendLog({ type: "thread_start", params: msg.params });
      const rolloutPath = process.env.CODEX_HOME
        ? path.join(process.env.CODEX_HOME, "sessions", "rollout-thread-codex-1.jsonl")
        : undefined;
      send({
        id: msg.id,
        result: {
          thread: {
            id: "thread-codex-1",
            ...(rolloutPath ? { path: rolloutPath } : {}),
          },
        },
      });
    } else if (msg.method === "turn/start") {
      turnCount += 1;
      const turnId = "turn-" + turnCount;
      const promptText = String(msg.params?.input?.[0]?.text ?? "");
      appendLog({ type: "turn_start", params: msg.params });
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: "turn/started", params: { threadId: msg.params.threadId, turn: { id: turnId } } });

      if (promptText.includes("HANG_FOR_CANCEL")) {
        activeTurn = turnId;
        send({ method: "item/agentMessage/delta", params: { delta: "working..." } });
        continue;
      }

      if (promptText.includes("TRIGGER_RATE_LIMIT")) {
        send({
          method: "turn/completed",
          params: {
            threadId: msg.params.threadId,
            turn: { id: turnId, status: "failed", error: { message: "429 rate limit exceeded, retry-after: 12s" } },
          },
        });
        continue;
      }

      if (promptText.includes("ELICIT_MOUNTED_MCP")) {
        const reqId = 900 + turnCount;
        pendingServerReq.set(reqId, (result) => {
          appendLog({ type: "elicitation_res", serverName: "kiln", result });
          cumIn += 300;
          cumCached += 100;
          cumOut += 40;
          cumReasoning += 10;
          send({
            method: "thread/tokenUsage/updated",
            params: {
              modelContextWindow: 200000,
              last: { totalTokens: 340 },
              total: {
                inputTokens: cumIn,
                cachedInputTokens: cumCached,
                cacheWriteInputTokens: 0,
                outputTokens: cumOut,
                reasoningOutputTokens: cumReasoning,
              },
            },
          });
          send({ method: "item/agentMessage/delta", params: { delta: "mcp elicitation:" + result.action } });
          send({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: turnId, status: "completed" } } });
        });
        send({
          id: reqId,
          method: "mcpServer/elicitation/request",
          params: { serverName: "kiln", message: "allow wb_get_context" },
        });
        continue;
      }

      if (promptText.includes("TRIGGER_APPROVAL")) {
        const reqId = 700 + turnCount;
        pendingServerReq.set(reqId, (result) => {
          appendLog({ type: "approval_res", result });
          if (result?.decision === "accept" || result?.decision === "approve") {
            send({ method: "item/completed", params: { item: { id: "fc-1", type: "fileChange", path: "allowed.txt" } } });
            send({ method: "item/agentMessage/delta", params: { delta: "approved" } });
          } else {
            send({ method: "item/agentMessage/delta", params: { delta: "denied" } });
          }
          cumIn += 200;
          cumCached += 50;
          cumOut += 25;
          send({
            method: "thread/tokenUsage/updated",
            params: {
              modelContextWindow: 200000,
              last: { totalTokens: 225 },
              total: {
                inputTokens: cumIn,
                cachedInputTokens: cumCached,
                cacheWriteInputTokens: 0,
                outputTokens: cumOut,
                reasoningOutputTokens: 0,
              },
            },
          });
          send({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: turnId, status: "completed" } } });
        });
        send({
          id: reqId,
          method: "item/commandExecution/requestApproval",
          params: { command: "rm -rf outside.txt" },
        });
        continue;
      }

      send({ method: "item/started", params: { item: { id: "t-1", type: "mcpToolCall", server: "kiln", tool: "wb_get_context" } } });
      send({ method: "item/agentMessage/delta", params: { delta: "ok:" + turnCount } });
      cumIn += 1000;
      cumCached += 400;
      cumOut += 150;
      cumReasoning += 30;
      send({
        method: "thread/tokenUsage/updated",
        params: {
          modelContextWindow: 200000,
          last: { totalTokens: 1150 },
          total: {
            inputTokens: cumIn,
            cachedInputTokens: cumCached,
            cacheWriteInputTokens: 0,
            outputTokens: cumOut,
            reasoningOutputTokens: cumReasoning,
          },
        },
      });
      send({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: turnId, status: "completed" } } });
    } else if (msg.method === "turn/interrupt") {
      const tid = msg.params?.turnId ?? activeTurn ?? "turn-1";
      send({ id: msg.id, result: {} });
      send({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: tid, status: "interrupted" } } });
    }
  }
});
`,
    "utf8",
  );

  fs.writeFileSync(
    piScript,
    `
import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("--version")) {
  console.log("pi 1.6.0-test");
  process.exit(0);
}

const logFile = process.env.TEST_PI_LOG;
if (logFile) {
  fs.appendFileSync(logFile, JSON.stringify({ type: "argv", argv: process.argv.slice(2) }) + "\\n");
}

let buf = "";
let turnNum = 0;
let activeAbortable = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (true) {
    const idx = buf.indexOf("\\n");
    if (idx === -1) break;
    const line = buf.slice(0, idx).replace(/\\r$/, "").trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);

    if (msg.type === "get_available_models") {
      send({
        id: msg.id,
        type: "response",
        success: true,
        data: {
          models: [
            { provider: "magpie", id: "group/fast", name: "Magpie Fast", reasoning: true, contextWindow: 200000 },
          ],
        },
      });
    } else if (msg.type === "get_state") {
      send({
        id: msg.id,
        type: "response",
        success: true,
        data: {
          sessionId: "pi-sess-42",
          sessionFile: path.join(process.cwd(), "pi-session.jsonl"),
        },
      });
    } else if (msg.type === "prompt") {
      turnNum += 1;
      const text = String(msg.message ?? "");
      send({ id: msg.id, type: "response", success: true, data: {} });

      if (text.includes("HANG_FOR_CANCEL")) {
        activeAbortable = true;
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pi working" } });
        continue;
      }

      if (text.includes("TRIGGER_RATE_LIMIT")) {
        send({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "429 too many requests (Retry-After: 9s)",
            usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          },
        });
        send({ type: "agent_end", messages: [] });
        continue;
      }

      send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
      send({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "pi turn " + turnNum } });
      send({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 100, cacheRead: 200, cacheWrite: 50, output: 30, reasoning: 10, cost: { total: 0.01 } },
        },
      });
      send({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 40, cacheRead: 300, cacheWrite: 0, output: 20, reasoning: 5, cost: { total: 0.005 } },
        },
      });
      send({ type: "agent_end", messages: [] });
    } else if (msg.type === "get_session_stats") {
      send({
        id: msg.id,
        type: "response",
        success: true,
        data: { contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 } },
      });
    } else if (msg.type === "abort") {
      send({ id: msg.id, type: "response", success: true, data: {} });
      if (activeAbortable) {
        activeAbortable = false;
        send({ type: "agent_end", messages: [] });
      }
    }
  }
});
`,
    "utf8",
  );

  const acpTemplate = (fullAccessOnly: boolean) => `
import fs from "node:fs";

if (process.argv.includes("--version")) {
  console.log("agy 1.5.14-test");
  process.exit(0);
}

let buf = "";
let nextReqId = 500;
let activePromptRpcId = null;
const pendingClientReq = new Map();
const logFile = process.env.TEST_ACP_LOG;

function send(obj) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
}

function appendLog(rec) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify(rec) + "\\n");
}

function requestClient(method, params) {
  const id = nextReqId++;
  return new Promise((resolve, reject) => {
    pendingClientReq.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  while (true) {
    const idx = buf.indexOf("\\n");
    if (idx === -1) break;
    const line = buf.slice(0, idx).replace(/\\r$/, "").trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);

    if ("id" in msg && ("result" in msg || "error" in msg) && !msg.method) {
      const pending = pendingClientReq.get(msg.id);
      if (pending) {
        pendingClientReq.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      continue;
    }

    if (msg.method === "initialize") {
      send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp", version: "1.5.14" },
          agentCapabilities: { promptCapabilities: { image: true } },
        },
      });
    } else if (msg.method === "session/new") {
      appendLog({ type: "session_new", params: msg.params });
      const modes = ${
        fullAccessOnly
          ? '[{ id: "full-access", name: "Full Access (unrestricted)" }]'
          : '[{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }]'
      };
      send({
        id: msg.id,
        result: {
          sessionId: "acp-native-1",
          modes: { currentModeId: modes[0].id, availableModes: modes },
          models: {
            currentModelId: "gemini-3-flash",
            availableModels: [{ modelId: "gemini-3-flash", name: "Gemini 3 Flash" }],
          },
        },
      });
    } else if (msg.method === "session/set_mode") {
      appendLog({ type: "set_mode", params: msg.params });
      send({ id: msg.id, result: {} });
    } else if (msg.method === "session/set_model") {
      send({ id: msg.id, result: {} });
    } else if (msg.method === "session/cancel") {
      if (activePromptRpcId !== null) {
        const pid = activePromptRpcId;
        activePromptRpcId = null;
        send({ id: pid, result: { stopReason: "cancelled" } });
      }
    } else if (msg.method === "session/prompt") {
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
      if (promptText.includes("HANG_FOR_CANCEL")) {
        activePromptRpcId = msg.id;
        send({
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "running..." } },
          },
        });
        continue;
      }

      if (promptText.includes("READ_FILE_TEST")) {
        let insideContent = "";
        let traversalRejected = false;
        try {
          const r1 = await requestClient("fs/read_text_file", {
            sessionId: msg.params.sessionId,
            path: "inside.txt",
          });
          insideContent = r1.content;
        } catch (e) {
          insideContent = "ERR:" + e.message;
        }
        try {
          await requestClient("fs/read_text_file", {
            sessionId: msg.params.sessionId,
            path: "../outside-secret.txt",
          });
        } catch {
          traversalRejected = true;
        }
        appendLog({ type: "read_file_test", insideContent, traversalRejected });
        send({
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: insideContent } },
          },
        });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        continue;
      }

      if (promptText.includes("TRIGGER_SNAKE_WRITE_APPROVAL")) {
        const permRes = await requestClient("session/request_permission", {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: "tc-snake", kind: "other", title: "write_file", locations: [{ path: "src/app.ts" }] },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        appendLog({ type: "snake_perm_res", permRes });
        send({
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "snake:" + (permRes?.outcome?.optionId ?? "none") } },
          },
        });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        continue;
      }

      if (promptText.includes("TRIGGER_CAMEL_WRITE_APPROVAL")) {
        const permRes = await requestClient("session/request_permission", {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: "tc-camel", kind: "other", title: "writeFile", locations: [{ path: "src/app.ts" }] },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        appendLog({ type: "camel_perm_res", permRes });
        send({
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "camel:" + (permRes?.outcome?.optionId ?? "none") } },
          },
        });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        continue;
      }

      if (promptText.includes("TRIGGER_KIND_WRITE_PATH_TITLE")) {
        const permRes = await requestClient("session/request_permission", {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: "tc-kind-write", kind: "write_file", title: "src/app.ts", locations: [{ path: "src/app.ts" }] },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        appendLog({ type: "kindwrite_perm_res", permRes });
        send({
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "kindwrite:" + (permRes?.outcome?.optionId ?? "none") } },
          },
        });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        continue;
      }

      if (promptText.includes("TRIGGER_NESTED_SYMLINK_ESCAPE")) {
        const permRes = await requestClient("session/request_permission", {
          sessionId: msg.params.sessionId,
          toolCall: {
            toolCallId: "tc-symlink",
            kind: "write",
            title: "write_file",
            locations: [{ path: "symlink-escape/missing-dir/new-file.txt" }],
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        appendLog({ type: "symlink_perm_res", permRes });
        send({
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "symlink:" + (permRes?.outcome?.optionId ?? "none") } },
          },
        });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        continue;
      }

      if (promptText.includes("TRIGGER_APPROVAL")) {
        const permRes = await requestClient("session/request_permission", {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: "tc-1", kind: "edit", title: "edit outside file", locations: [{ path: "src/app.ts" }] },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        appendLog({ type: "perm_res", permRes });
        if (permRes?.outcome?.optionId === "allow") {
          send({
            method: "session/update",
            params: {
              sessionId: msg.params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tc-1",
                kind: "edit",
                status: "completed",
                locations: [{ path: "src/app.ts" }],
              },
            },
          });
          send({
            method: "session/update",
            params: {
              sessionId: msg.params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "write allowed" } },
            },
          });
        } else {
          send({
            method: "session/update",
            params: {
              sessionId: msg.params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "write denied" } },
            },
          });
        }
        send({
          id: msg.id,
          result: {
            stopReason: "end_turn",
            usage: { inputTokens: 100, cachedReadTokens: 200, cachedWriteTokens: 0, outputTokens: 20, thoughtTokens: 5 },
          },
        });
        continue;
      }

      if (promptText.includes("TRIGGER_RATE_LIMIT")) {
        send({ id: msg.id, error: { code: -32000, message: "429 rate limit exceeded, retry-after: 15s" } });
        continue;
      }

      send({
        method: "session/update",
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } },
      });
      send({
        method: "session/update",
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tc-read", title: "read", kind: "read" } },
      });
      send({
        method: "session/update",
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "usage_update", used: 4096, size: 100000 } },
      });
      send({
        method: "session/update",
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp ok" } } },
      });
      send({
        id: msg.id,
        result: {
          stopReason: "end_turn",
          usage: {
            inputTokens: 1200,
            cachedReadTokens: 3000,
            cachedWriteTokens: 100,
            outputTokens: 250,
            thoughtTokens: 50,
          },
        },
      });
    }
  }
});
`;

  fs.writeFileSync(acpScript, acpTemplate(false), "utf8");
  fs.writeFileSync(acpFullAccessOnlyScript, acpTemplate(true), "utf8");

  fs.writeFileSync(
    claudeScript,
    `
import fs from "node:fs";

if (process.argv.includes("--version")) {
  console.log("2.1.0 (Claude Code test)");
  process.exit(0);
}

const logFile = process.env.TEST_CLAUDE_LOG;
const mcpIdx = process.argv.indexOf("--mcp-config");
const mcpConfigPath = mcpIdx !== -1 ? process.argv[mcpIdx + 1] : null;
if (logFile) {
  fs.appendFileSync(
    logFile,
    JSON.stringify({
      type: "spawn",
      argv: process.argv.slice(2),
      mcpConfigPath,
      mcpConfigExists: mcpConfigPath ? fs.existsSync(mcpConfigPath) : false,
    }) + "\\n",
  );
}

let buf = "";
let turn = 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (true) {
    const idx = buf.indexOf("\\n");
    if (idx === -1) break;
    const line = buf.slice(0, idx).replace(/\\r$/, "").trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.type === "user") {
      turn += 1;
      const text = String(msg.message?.content ?? "");
      send({ type: "system", subtype: "init", session_id: "claude-native-77" });

      if (text.includes("HANG_FOR_CANCEL")) {
        send({ type: "assistant", message: { content: [{ type: "text", text: "claude waiting..." }] } });
        continue;
      }

      if (text.includes("TRIGGER_RATE_LIMIT")) {
        send({
          type: "result",
          is_error: true,
          session_id: "claude-native-77",
          result: "429 rate limit exceeded, Retry-After: 8s",
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
        });
        continue;
      }

      send({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "tool_use", name: "Edit", input: { file_path: "src/index.ts" } },
            { type: "text", text: "claude turn " + turn },
          ],
        },
      });
      send({
        type: "result",
        is_error: false,
        session_id: "claude-native-77",
        total_cost_usd: 0.042,
        usage: {
          input_tokens: 500,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 400,
          output_tokens: 120,
        },
      });
    }
  }
});
`,
    "utf8",
  );
});

afterAll(() => {
  if (fixtureDir) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function makeTempWs(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeProvidersConfig(): ProvidersConfig {
  const base = createDefaultProvidersConfig();
  return {
    schema_version: 1,
    providers: base.providers
      .filter((p) => p.adapter !== "paseo")
      .map((p) => {
        if (p.id === "codex") {
          return {
            ...p,
            command: process.execPath,
            args: [codexScript],
            env: { OPENAI_API_KEY: "sk-test-codex-key" },
          };
        }
        if (p.id === "pi") {
          return {
            ...p,
            command: process.execPath,
            args: [piScript, "--mode", "rpc"],
          };
        }
        if (p.id === "agy") {
          return {
            ...p,
            command: process.execPath,
            args: [acpScript],
          };
        }
        if (p.id === "claude") {
          return {
            ...p,
            command: process.execPath,
            args: [
              claudeScript,
              "-p",
              "--output-format",
              "stream-json",
              "--input-format",
              "stream-json",
            ],
          };
        }
        return { ...p, enabled: false };
      }),
  };
}

describe("v0.0.5 Multi-CLI & ACP Backends + CompositeBackend", () => {
  verifyBackendContract("CodexAppServerBackend", () => {
    const cwd = makeTempWs("kiln-codex-contract-");
    const backend = new CodexAppServerBackend({
      provider: {
        id: "codex",
        label: "Codex",
        adapter: "codex_app_server",
        enabled: true,
        command: process.execPath,
        args: [codexScript],
        env: {},
        custom_models: [],
      },
      cancelTimeoutMs: 1_500,
    });
    return {
      backend,
      createStreamingRun: () => ({
        runId: "r-codex-1",
        taskId: "t-1",
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "hello",
        freshContext: false,
      }),
      createCancellableRun: () => ({
        runId: "r-codex-cancel",
        taskId: "t-1",
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "HANG_FOR_CANCEL",
        freshContext: false,
      }),
      createApprovalRun: () => ({
        runId: "r-codex-appr",
        taskId: "t-1",
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "TRIGGER_APPROVAL",
        freshContext: false,
      }),
      createMultiTurnRun: () => ({
        runSpec: {
          runId: "r-codex-multi",
          taskId: "t-1",
          role: "worker",
          agent: "codex",
          model: "gpt-5.4",
          cwd,
          prompt: "turn one",
          freshContext: false,
        },
        followUpMessage: "turn two",
      }),
      cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
    };
  });

  verifyBackendContract("AcpBackend", () => {
    const cwd = makeTempWs("kiln-acp-contract-");
    const backend = new AcpBackend({
      provider: {
        id: "agy",
        label: "Antigravity CLI",
        adapter: "acp",
        enabled: true,
        command: process.execPath,
        args: [acpScript],
        env: {},
        custom_models: [],
      },
      cancelTimeoutMs: 1_500,
    });
    return {
      backend,
      createStreamingRun: () => ({
        runId: "r-acp-1",
        taskId: "t-2",
        role: "worker",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "hello",
        freshContext: false,
      }),
      createCancellableRun: () => ({
        runId: "r-acp-cancel",
        taskId: "t-2",
        role: "worker",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "HANG_FOR_CANCEL",
        freshContext: false,
      }),
      createApprovalRun: () => ({
        runId: "r-acp-appr",
        taskId: "t-2",
        role: "worker",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "TRIGGER_APPROVAL",
        freshContext: false,
      }),
      createMultiTurnRun: () => ({
        runSpec: {
          runId: "r-acp-multi",
          taskId: "t-2",
          role: "worker",
          agent: "agy",
          model: "gemini-3-flash",
          cwd,
          prompt: "turn one",
          freshContext: false,
        },
        followUpMessage: "turn two",
      }),
      cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
    };
  });

  verifyBackendContract("CompositeBackend", () => {
    const cwd = makeTempWs("kiln-comp-contract-");
    const backend = new CompositeBackend({
      initialConfig: makeProvidersConfig(),
      queryTimeoutMs: 4_000,
    });
    return {
      backend,
      createStreamingRun: () => ({
        runId: "r-comp-1",
        taskId: "t-3",
        role: "worker",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "hello",
        freshContext: false,
      }),
      createCancellableRun: () => ({
        runId: "r-comp-cancel",
        taskId: "t-3",
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "HANG_FOR_CANCEL",
        freshContext: false,
      }),
      createApprovalRun: () => ({
        runId: "r-comp-appr",
        taskId: "t-3",
        role: "worker",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "TRIGGER_APPROVAL",
        freshContext: false,
      }),
      createMultiTurnRun: () => ({
        runSpec: {
          runId: "r-comp-multi",
          taskId: "t-3",
          role: "worker",
          agent: "codex",
          model: "gpt-5.4",
          cwd,
          prompt: "turn one",
          freshContext: false,
        },
        followUpMessage: "turn two",
      }),
      cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
    };
  });

  it("buildAgentCliEnv keeps API keys while stripping KILN_RUN_TOKEN", () => {
    const env = buildAgentCliEnv(
      { OPENAI_API_KEY: "sk-123", KILN_RUN_TOKEN: "should-strip" },
      { ANTHROPIC_API_KEY: "ant-456" },
      { PATH: "/usr/bin", KILN_RUN_TOKEN: "parent-token" },
    );
    expect(env.OPENAI_API_KEY).toBe("sk-123");
    expect(env.ANTHROPIC_API_KEY).toBe("ant-456");
    expect(env.KILN_RUN_TOKEN).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("CodexAppServerBackend enforces granular MCP whitelist, readOnly sandbox, ephemeral:false, native quota & cumulative delta usage", async () => {
    const cwd = makeTempWs("kiln-codex-detail-");
    const logFile = path.join(cwd, "codex.log");
    const health = new ProviderHealthTracker();
    const backend = new CodexAppServerBackend({
      provider: {
        id: "codex",
        label: "Codex CLI",
        adapter: "codex_app_server",
        enabled: true,
        command: process.execPath,
        args: [codexScript],
        env: { OPENAI_API_KEY: "sk-secret", TEST_CODEX_LOG: logFile },
        custom_models: ["custom/codex-fine"],
      },
      healthTracker: health,
    });

    try {
      const probe = await backend.probeProvider();
      expect(probe.available).toBe(true);
      expect(probe.nativeQuota).toMatchObject({
        source: "codex",
        used_percent: 22,
        window_duration_mins: 10080,
        plan_type: "prolite",
      });
      const models = await backend.listModels("codex");
      expect(models.map((m) => m.id)).toEqual(["gpt-5.4", "custom/codex-fine"]);

      // Mounted MCP elicitation auto-accepted; readOnly role sets ephemeral:false and declines write approvals
      const ref1 = await backend.start({
        runId: "r1",
        taskId: "t1",
        role: "reviewer",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "ELICIT_MOUNTED_MCP",
        freshContext: true,
        env: { KILN_RUN_TOKEN: "leak-attempt" },
        mcpServers: [
          {
            name: "kiln",
            command: process.execPath,
            args: ["mcp.js"],
            env: { KILN_RUN_TOKEN: "hmac-token-ok" },
          },
        ],
      });
      const ev1 = await collectAllEvents(backend, ref1);
      expect(
        ev1.some((e) => e.kind === "session_bound" && e.providerSessionId === "thread-codex-1"),
      ).toBe(true);
      expect(ev1.some((e) => e.kind === "context_window" && e.usedTokens === 340)).toBe(true);
      expect(
        ev1.some((e) => e.kind === "message" && e.text.includes("mcp elicitation:accept")),
      ).toBe(true);
      const u1 = ev1.find((e): e is Extract<RunEvent, { kind: "usage" }> => e.kind === "usage");
      expect(u1).toMatchObject({
        uncachedInputTokens: 200,
        cacheReadTokens: 100,
        outputTokens: 40,
        reasoningTokens: 10,
      });

      // Second turn checks cumulative delta & rate-limit cooldown
      await backend.send(ref1, "TRIGGER_RATE_LIMIT");
      const ev2 = await collectAllEvents(backend, ref1);
      expect(ev2.some((e) => e.kind === "rate_limited" && e.retryAfterSec === 12)).toBe(true);
      expect(health.isInCooldown("codex")).toBe(true);

      const logs = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const envLog = logs.find((l) => l.type === "env");
      expect(envLog).toMatchObject({
        OPENAI_API_KEY: "sk-secret",
        KILN_RUN_TOKEN: null,
        GIT_TERMINAL_PROMPT: "0",
      });
      const threadLog = logs.find((l) => l.type === "thread_start") as {
        params: Record<string, unknown>;
      };
      expect(threadLog.params.ephemeral).toBe(false);
      expect(threadLog.params.sandbox).toBe("read-only");
      expect(
        (threadLog.params.approvalPolicy as { granular?: { mcp_elicitations?: boolean } }).granular
          ?.mcp_elicitations,
      ).toBe(true);
    } finally {
      await backend.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("PiRpcBackend enforces read-only --tools allowlist, accumulates per-message usage, captures sessionFile & cancels cleanly", async () => {
    const cwd = makeTempWs("kiln-pi-detail-");
    const logFile = path.join(cwd, "pi.log");
    const health = new ProviderHealthTracker();
    const backend = new PiRpcBackend({
      provider: {
        id: "pi",
        label: "Pi",
        adapter: "pi_rpc",
        enabled: true,
        command: process.execPath,
        args: [piScript, "--mode", "rpc"],
        env: { TEST_PI_LOG: logFile },
        custom_models: ["custom/pi-local"],
      },
      healthTracker: health,
      cancelTimeoutMs: 1_500,
    });

    try {
      const agents = await backend.listAgents();
      expect(agents[0]?.modes).toEqual([]);
      const models = await backend.listModels("pi");
      expect(models.map((m) => m.id)).toEqual(["group/fast", "custom/pi-local"]);

      const ref = await backend.start({
        runId: "r-pi-1",
        taskId: "t-pi",
        role: "advisor",
        agent: "pi",
        model: "magpie/group/fast",
        reasoningEffort: "low",
        cwd,
        prompt: "inspect codebase",
        freshContext: true,
      });

      const events = await collectAllEvents(backend, ref);
      const bound = events.find(
        (e): e is Extract<RunEvent, { kind: "session_bound" }> => e.kind === "session_bound",
      );
      expect(bound?.providerSessionId).toBe("pi-sess-42");
      expect(bound?.providerSessionPath).toBe(path.join(fs.realpathSync(cwd), "pi-session.jsonl"));

      const ctxEv = events.find(
        (e): e is Extract<RunEvent, { kind: "context_window" }> => e.kind === "context_window",
      );
      expect(ctxEv).toMatchObject({ usedTokens: 12000, contextWindowTokens: 200000, percent: 6 });

      const usage = events.find(
        (e): e is Extract<RunEvent, { kind: "usage" }> => e.kind === "usage",
      );
      expect(usage).toMatchObject({
        uncachedInputTokens: 140,
        cacheReadTokens: 500,
        cacheWriteTokens: 50,
        outputTokens: 50,
        reasoningTokens: 15,
        providerCostUsd: 0.015,
        costSource: "provider_reported",
      });
      expect(events.at(-1)?.kind).toBe("exit");

      // Rate-limited turn
      await backend.send(ref, "TRIGGER_RATE_LIMIT");
      const rlEvents = await collectAllEvents(backend, ref);
      expect(rlEvents.some((e) => e.kind === "rate_limited" && e.retryAfterSec === 9)).toBe(true);
      expect(health.isInCooldown("pi")).toBe(true);

      // Cancel turn
      const refCancel = await backend.start({
        runId: "r-pi-cancel",
        taskId: "t-pi",
        role: "worker",
        agent: "pi",
        model: "magpie/group/fast",
        cwd,
        prompt: "HANG_FOR_CANCEL",
        freshContext: false,
      });
      const collecting = collectAllEvents(backend, refCancel);
      await backend.cancel(refCancel);
      const cancelEvents = await collecting;
      expect(cancelEvents.at(-1)).toMatchObject({ kind: "exit", reason: "cancelled" });

      const argvLogs = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { argv: string[] });
      // argvLogs[0] was probe (--no-session), argvLogs[1] is researcher read-only session
      expect(argvLogs[1]!.argv).toEqual(
        expect.arrayContaining([
          "--provider",
          "magpie",
          "--model",
          "group/fast",
          "--thinking",
          "low",
          "--tools",
          "read,grep,find,ls",
          "--no-mcp",
        ]),
      );
    } finally {
      await backend.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("AcpBackend blocks traversal in fs/read_text_file, decouples usage_update from usage, rejects full-access-only, and denies readonly writes", async () => {
    const parent = makeTempWs("kiln-acp-sec-");
    const cwd = path.join(parent, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "inside.txt"), "INSIDE_OK", "utf8");
    fs.writeFileSync(path.join(parent, "outside-secret.txt"), "TOP_SECRET", "utf8");
    const logFile = path.join(parent, "acp.log");

    const backend = new AcpBackend({
      provider: {
        id: "agy",
        label: "Antigravity CLI",
        adapter: "acp",
        enabled: true,
        command: process.execPath,
        args: [acpScript],
        env: { TEST_ACP_LOG: logFile },
        custom_models: [],
      },
    });

    const fullAccessBackend = new AcpBackend({
      provider: {
        id: "agy-fa",
        label: "FullAccess Only",
        adapter: "acp",
        enabled: true,
        command: process.execPath,
        args: [acpFullAccessOnlyScript],
        env: {},
        custom_models: [],
      },
    });

    try {
      // 1. fs/read_text_file cwd confinement
      const refRead = await backend.start({
        runId: "r-read",
        taskId: "t-sec",
        role: "reviewer",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "READ_FILE_TEST",
        freshContext: true,
      });
      const readEvents = await collectAllEvents(backend, refRead);
      expect(readEvents.some((e) => e.kind === "message" && e.text === "INSIDE_OK")).toBe(true);

      // 2. usage_update -> context_window ONLY, PromptResponse.usage -> single usage
      const refUsage = await backend.start({
        runId: "r-usage",
        taskId: "t-sec",
        role: "reviewer",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "normal run",
        freshContext: true,
      });
      const usageEvents = await collectAllEvents(backend, refUsage);
      expect(usageEvents.filter((e) => e.kind === "usage")).toHaveLength(1);
      expect(usageEvents.find((e) => e.kind === "usage")).toMatchObject({
        uncachedInputTokens: 1200,
        cacheReadTokens: 3000,
        cacheWriteTokens: 100,
        outputTokens: 250,
        reasoningTokens: 50,
      });
      expect(usageEvents.find((e) => e.kind === "context_window")).toMatchObject({
        usedTokens: 4096,
        contextWindowTokens: 100000,
      });

      // 3. Read-only role unconditionally denies write permission even if handler tries allow
      const allowAllUnsub = backend.onApproval(async (req) => {
        await backend.answer(req.id, true);
      });
      const refRo = await backend.start({
        runId: "r-ro-deny",
        taskId: "t-sec",
        role: "reviewer",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "TRIGGER_APPROVAL",
        freshContext: true,
      });
      const roEvents = await collectAllEvents(backend, refRo);
      allowAllUnsub();
      expect(roEvents.some((e) => e.kind === "message" && e.text.includes("write denied"))).toBe(
        true,
      );

      // 4. FullAccessOnlyProviderError thrown on full-access-only non-readonly start
      await expect(
        fullAccessBackend.start({
          runId: "r-fa",
          taskId: "t-fa",
          role: "worker",
          agent: "agy-fa",
          model: "default",
          cwd,
          prompt: "hello",
          freshContext: false,
        }),
      ).rejects.toThrow(FullAccessOnlyProviderError);

      const logs = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const readLog = logs.find((l) => l.type === "read_file_test");
      expect(readLog).toMatchObject({ insideContent: "INSIDE_OK", traversalRejected: true });
      const modeLogs = logs.filter((l) => l.type === "set_mode") as Array<{
        params: { modeId: string };
      }>;
      expect(modeLogs[0]?.params.modeId).toBe("plan");
    } finally {
      await backend.dispose();
      await fullAccessBackend.dispose();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("ClaudeDirectBackend supports --permission-mode plan/acceptEdits, cleans up temp --mcp-config, multi-turn & usage", async () => {
    const cwd = makeTempWs("kiln-claude-detail-");
    const logFile = path.join(cwd, "claude.log");
    const backend = new ClaudeDirectBackend({
      provider: {
        id: "claude",
        label: "Claude Code",
        adapter: "claude_direct",
        enabled: true,
        command: process.execPath,
        args: [
          claudeScript,
          "-p",
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
        ],
        env: { TEST_CLAUDE_LOG: logFile },
        custom_models: [],
      },
      cancelTimeoutMs: 1_500,
    });

    try {
      const ref = await backend.start({
        runId: "r-cl-1",
        taskId: "t-cl",
        role: "advisor",
        agent: "claude",
        model: "claude-sonnet-4-6",
        cwd,
        prompt: "advise me",
        freshContext: true,
        mcpServers: [
          {
            name: "kiln",
            command: process.execPath,
            args: ["mcp.js"],
            env: { KILN_RUN_TOKEN: "tok-1" },
          },
        ],
      });

      const ev1 = await collectAllEvents(backend, ref);
      expect(
        ev1.some((e) => e.kind === "session_bound" && e.providerSessionId === "claude-native-77"),
      ).toBe(true);
      expect(ev1.find((e) => e.kind === "usage")).toMatchObject({
        uncachedInputTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 400,
        outputTokens: 120,
        providerCostUsd: 0.042,
        costSource: "provider_reported",
      });

      await backend.send(ref, "follow up");
      const ev2 = await collectAllEvents(backend, ref);
      expect(ev2.some((e) => e.kind === "message" && e.text.includes("claude turn 2"))).toBe(true);

      const spawnLog = JSON.parse(fs.readFileSync(logFile, "utf8").trim().split("\n")[0]!) as {
        argv: string[];
        mcpConfigPath: string;
        mcpConfigExists: boolean;
      };
      expect(spawnLog.argv).toContain("plan");
      expect(spawnLog.mcpConfigExists).toBe(true);

      await backend.dispose();
      expect(fs.existsSync(spawnLog.mcpConfigPath)).toBe(false);
    } finally {
      await backend.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("CompositeBackend handles multi-provider routing, rate_limited telemetry, testProvider, and syncFromConfig", async () => {
    const cwd = makeTempWs("kiln-comp-extra-");
    const statusEvents: string[] = [];
    const health = new ProviderHealthTracker();
    const initialCfg = makeProvidersConfig();
    const backend = new CompositeBackend({
      initialConfig: initialCfg,
      healthTracker: health,
      onProviderStatusChanged: (st) => {
        statusEvents.push(`${st.provider_id}:${st.status}`);
      },
    });

    try {
      const agents = await backend.listAgents();
      expect(agents.map((a) => a.id).sort()).toEqual(["agy", "claude", "codex", "pi"]);

      const tested = await backend.testProvider("codex");
      expect(tested.status.status).toBe("ready");
      expect(tested.modelsCount).toBe(1);
      // testProvider itself must NOT trigger onProviderStatusChanged (deduped in daemon/http-api)
      expect(statusEvents).toEqual([]);

      // Trigger rate_limited via ACP child and verify healthTracker + onProviderStatusChanged fire
      const ref = await backend.start({
        runId: "r-rl",
        taskId: "t-rl",
        role: "worker",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "TRIGGER_RATE_LIMIT",
        freshContext: false,
      });
      const events = await collectAllEvents(backend, ref);
      expect(events.some((e) => e.kind === "rate_limited")).toBe(true);
      expect(health.isInCooldown("agy")).toBe(true);
      expect(statusEvents).toContain("agy:cooldown");

      // Hot-reload syncFromConfig disabling pi
      const updatedCfg: ProvidersConfig = {
        schema_version: 1,
        providers: initialCfg.providers.map((p) => (p.id === "pi" ? { ...p, enabled: false } : p)),
      };
      await backend.syncFromConfig(updatedCfg);
      const afterAgents = await backend.listAgents();
      expect(afterAgents.some((a) => a.id === "pi")).toBe(false);
    } finally {
      await backend.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies adapter default usage_rule for custom provider IDs without explicit usage_rule", async () => {
    const cwd = makeTempWs("kiln-custom-codex-rule-");
    const backend = new CodexAppServerBackend({
      provider: {
        id: "codex-work",
        label: "Codex Work Subscription",
        adapter: "codex_app_server",
        enabled: true,
        command: process.execPath,
        args: [codexScript],
        env: {},
        custom_models: [],
      },
    });

    try {
      const ref = await backend.start({
        runId: "r-cw-1",
        taskId: "t-cw",
        role: "worker",
        agent: "codex-work",
        model: "gpt-5.4",
        cwd,
        prompt: "first turn",
        freshContext: false,
      });
      const ev1 = await collectAllEvents(backend, ref);
      const u1 = ev1.find((e) => e.kind === "usage");
      expect(u1).toMatchObject({
        uncachedInputTokens: 600, // 1000 - 400 cached under codex rule
        cacheReadTokens: 400,
        outputTokens: 150,
        reasoningTokens: 30,
      });

      await backend.send(ref, "second turn");
      const ev2 = await collectAllEvents(backend, ref);
      const u2 = ev2.find((e) => e.kind === "usage");
      // Cumulative thread rule subtracts previous turn totals instead of double-counting
      expect(u2).toMatchObject({
        uncachedInputTokens: 600,
        cacheReadTokens: 400,
        outputTokens: 150,
        reasoningTokens: 30,
      });
    } finally {
      await backend.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects ACP snake_case write_file on read-only role and flags nested missing symlink outside_scope", async () => {
    const outer = makeTempWs("kiln-acp-outer-");
    const cwd = path.join(outer, "ws");
    const outsideTarget = path.join(outer, "outside");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(outsideTarget, { recursive: true });
    fs.symlinkSync(outsideTarget, path.join(cwd, "symlink-escape"));

    const seenActions: string[] = [];
    const backend = new AcpBackend({
      provider: {
        id: "agy",
        label: "Antigravity CLI",
        adapter: "acp",
        enabled: true,
        command: process.execPath,
        args: [acpScript],
        env: {},
        custom_models: [],
      },
    });
    backend.onApproval(async (req) => {
      seenActions.push(req.action);
      await backend.answer(req.id, req.action !== "outside_scope");
    });

    try {
      const roRef = await backend.start({
        runId: "r-acp-snake",
        taskId: "t-snake",
        role: "reviewer",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "TRIGGER_SNAKE_WRITE_APPROVAL",
        freshContext: true,
      });
      const roEvents = await collectAllEvents(backend, roRef);
      const roAppr = roEvents.find((e) => e.kind === "approval");
      expect(roAppr).toMatchObject({ action: "file_write" });
      expect(roEvents.some((e) => e.kind === "message" && e.text.includes("snake:reject"))).toBe(
        true,
      );

      const roCamelRef = await backend.start({
        runId: "r-acp-camel",
        taskId: "t-camel",
        role: "reviewer",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "TRIGGER_CAMEL_WRITE_APPROVAL",
        freshContext: true,
      });
      const roCamelEvents = await collectAllEvents(backend, roCamelRef);
      expect(roCamelEvents.find((e) => e.kind === "approval")).toMatchObject({
        action: "file_write",
      });
      expect(
        roCamelEvents.some((e) => e.kind === "message" && e.text.includes("camel:reject")),
      ).toBe(true);

      const roKindRef = await backend.start({
        runId: "r-acp-kind-write",
        taskId: "t-kind-write",
        role: "reviewer",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "TRIGGER_KIND_WRITE_PATH_TITLE",
        freshContext: true,
      });
      const roKindEvents = await collectAllEvents(backend, roKindRef);
      expect(roKindEvents.find((e) => e.kind === "approval")).toMatchObject({
        action: "file_write",
      });
      expect(
        roKindEvents.some((e) => e.kind === "message" && e.text.includes("kindwrite:reject")),
      ).toBe(true);

      const wrRef = await backend.start({
        runId: "r-acp-symlink",
        taskId: "t-symlink",
        role: "worker",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "TRIGGER_NESTED_SYMLINK_ESCAPE",
        freshContext: false,
      });
      const wrEvents = await collectAllEvents(backend, wrRef);
      expect(wrEvents.find((e) => e.kind === "approval")).toMatchObject({
        action: "outside_scope",
      });
      expect(seenActions).toContain("outside_scope");
      expect(wrEvents.some((e) => e.kind === "message" && e.text.includes("symlink:reject"))).toBe(
        true,
      );
    } finally {
      await backend.dispose();
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it("cleans up Claude temp --mcp-config immediately upon cancel() before dispose()", async () => {
    const cwd = makeTempWs("kiln-claude-cancel-");
    const logFile = path.join(cwd, "claude.log");
    const backend = new ClaudeDirectBackend({
      provider: {
        id: "claude",
        label: "Claude Code",
        adapter: "claude_direct",
        enabled: true,
        command: process.execPath,
        args: [
          claudeScript,
          "-p",
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
        ],
        env: { TEST_CLAUDE_LOG: logFile },
        custom_models: [],
      },
      cancelTimeoutMs: 500,
    });

    try {
      const ref = await backend.start({
        runId: "r-cl-cancel",
        taskId: "t-cl-cancel",
        role: "worker",
        agent: "claude",
        model: "claude-sonnet-4-6",
        cwd,
        prompt: "HANG_FOR_CANCEL",
        freshContext: false,
        mcpServers: [
          {
            name: "kiln",
            command: process.execPath,
            args: ["mcp.js"],
            env: { KILN_RUN_TOKEN: "tok-cancel" },
          },
        ],
      });

      const iter = backend.events(ref)[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.done).toBe(false);

      const spawnLog = JSON.parse(fs.readFileSync(logFile, "utf8").trim().split("\n")[0]!) as {
        mcpConfigPath: string;
        mcpConfigExists: boolean;
      };
      expect(spawnLog.mcpConfigExists).toBe(true);
      expect(fs.existsSync(spawnLog.mcpConfigPath)).toBe(true);

      await backend.cancel(ref);
      expect(fs.existsSync(spawnLog.mcpConfigPath)).toBe(false);
      const probed = await backend.probe(ref);
      expect(probed.status).toBe("closed");

      while (!(await iter.next()).done) {
        // Drain cancelled exit event
      }
    } finally {
      await backend.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("handles broken child stdin EPIPE cleanly in StdioRpcProcess without crashing", async () => {
    const cwd = makeTempWs("kiln-stdio-epipe-");
    const proc = new StdioRpcProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(0), 20);"],
      cwd,
    });

    try {
      await new Promise((r) => setTimeout(r, 40));
      // Emit EPIPE/error directly on child.stdin or write after destruction; must not crash.
      proc.child.stdin?.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      await proc.close(200);
      expect(proc.isAlive).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("degrades probeProvider cleanly when spawned ACP child emits error event", async () => {
    const backend = new AcpBackend({
      provider: {
        id: "agy",
        label: "Antigravity CLI",
        adapter: "acp",
        enabled: true,
        command: process.execPath,
        args: [acpScript],
        env: {},
        custom_models: [],
      },
      spawnFn: () => {
        const fakeChild = new EventEmitter() as unknown as ChildProcess;
        Object.assign(fakeChild, {
          pid: 999999,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        });
        queueMicrotask(() => {
          fakeChild.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
        });
        return fakeChild;
      },
    });

    try {
      const snap = await backend.probeProvider();
      expect(snap.available).toBe(false);
      expect(snap.detail).toContain("EACCES");
    } finally {
      await backend.dispose();
    }
  });

  it("emits non-zero thinking char counts on ACP agent_thought_chunk and Claude thinking blocks", async () => {
    const cwd = makeTempWs("kiln-thinking-chars-");
    const composite = new CompositeBackend({
      initialConfig: makeProvidersConfig(),
      queryTimeoutMs: 4_000,
    });
    try {
      const acpRef = await composite.start({
        runId: "r-think-acp",
        taskId: "t-think-1",
        role: "worker",
        agent: "agy",
        model: "gemini-3-flash",
        cwd,
        prompt: "hello",
        freshContext: false,
      });
      const acpEvents = await collectAllEvents(composite, acpRef);
      const acpThinking = acpEvents.find(
        (e): e is Extract<RunEvent, { kind: "thinking" }> => e.kind === "thinking",
      );
      expect(acpThinking?.chars).toBe("thinking".length);

      const claudeRef = await composite.start({
        runId: "r-think-claude",
        taskId: "t-think-2",
        role: "worker",
        agent: "claude",
        model: "claude-sonnet",
        cwd,
        prompt: "hello",
        freshContext: false,
      });
      const claudeEvents = await collectAllEvents(composite, claudeRef);
      const claudeThinking = claudeEvents.find(
        (e): e is Extract<RunEvent, { kind: "thinking" }> => e.kind === "thinking",
      );
      expect(claudeThinking?.chars).toBe("pondering".length);
    } finally {
      await composite.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prepareIsolatedCodexHome mirrors shared auth/config/skills only, prunes stale links, and preserves fresher auth.json", () => {
    const tmpRoot = makeTempWs("kiln-codex-home-iso-");
    const kilnHome = path.join(tmpRoot, "kiln-home");
    const sourceHome = path.join(tmpRoot, "user-codex");
    fs.mkdirSync(sourceHome, { recursive: true });

    try {
      fs.writeFileSync(path.join(sourceHome, "auth.json"), '{"token":"src-old"}', { mode: 0o600 });
      fs.writeFileSync(path.join(sourceHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");
      fs.writeFileSync(path.join(sourceHome, "instructions.md"), "# rules\n", "utf8");
      fs.mkdirSync(path.join(sourceHome, "skills", "demo"), { recursive: true });
      fs.writeFileSync(path.join(sourceHome, "skills", "demo", "SKILL.md"), "# skill", "utf8");
      fs.mkdirSync(path.join(sourceHome, "agents"), { recursive: true });

      // Conversation history & SQLite state in user's ~/.codex MUST NEVER be mirrored
      fs.mkdirSync(path.join(sourceHome, "sessions", "2026"), { recursive: true });
      fs.writeFileSync(path.join(sourceHome, "history.jsonl"), '{"msg":"private"}\n', "utf8");
      fs.writeFileSync(path.join(sourceHome, "session_index.jsonl"), "{}\n", "utf8");
      fs.writeFileSync(path.join(sourceHome, "state_5.sqlite"), "sqlite", "utf8");
      fs.writeFileSync(path.join(sourceHome, "thread_history_1.sqlite"), "sqlite", "utf8");
      fs.writeFileSync(path.join(sourceHome, ".codex-global-state.json"), "{}", "utf8");

      const isolated = prepareIsolatedCodexHome(kilnHome, { sourceCodexHome: sourceHome });
      expect(isolated).toBe(resolveIsolatedCodexHome(kilnHome));

      expect(fs.existsSync(path.join(isolated, "auth.json"))).toBe(true);
      expect(fs.existsSync(path.join(isolated, "config.toml"))).toBe(true);
      expect(fs.existsSync(path.join(isolated, "instructions.md"))).toBe(true);
      expect(fs.existsSync(path.join(isolated, "skills", "demo", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(isolated, "agents"))).toBe(true);

      expect(fs.existsSync(path.join(isolated, "sessions"))).toBe(false);
      expect(fs.existsSync(path.join(isolated, "history.jsonl"))).toBe(false);
      expect(fs.existsSync(path.join(isolated, "session_index.jsonl"))).toBe(false);
      expect(fs.existsSync(path.join(isolated, "state_5.sqlite"))).toBe(false);
      expect(fs.existsSync(path.join(isolated, "thread_history_1.sqlite"))).toBe(false);
      expect(fs.existsSync(path.join(isolated, ".codex-global-state.json"))).toBe(false);

      // Simulate OAuth refresh replacing symlink with a fresher regular auth.json in isolated home
      fs.rmSync(path.join(isolated, "auth.json"), { force: true });
      fs.writeFileSync(path.join(isolated, "auth.json"), '{"token":"refreshed-newer"}', {
        mode: 0o600,
      });
      const nowSec = Date.now() / 1000;
      fs.utimesSync(path.join(sourceHome, "auth.json"), nowSec - 60, nowSec - 60);
      fs.utimesSync(path.join(isolated, "auth.json"), nowSec + 10, nowSec + 10);

      // Delete instructions.md from sourceHome -> stale symlink in isolated must be pruned
      fs.rmSync(path.join(sourceHome, "instructions.md"));
      prepareIsolatedCodexHome(kilnHome, { sourceCodexHome: sourceHome });

      expect(fs.readFileSync(path.join(isolated, "auth.json"), "utf8")).toBe(
        '{"token":"refreshed-newer"}',
      );
      expect(fs.existsSync(path.join(isolated, "instructions.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("CodexAppServerBackend & CompositeBackend inject isolated CODEX_HOME, record codexHome & providerSessionPath, and honor explicit override", async () => {
    const tmpRoot = makeTempWs("kiln-codex-iso-run-");
    const kilnHome = path.join(tmpRoot, "kiln-home");
    const sourceHome = path.join(tmpRoot, "source-codex");
    const explicitHome = path.join(tmpRoot, "explicit-codex");
    const cwd = path.join(tmpRoot, "ws");
    const logFile = path.join(tmpRoot, "codex.log");
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.mkdirSync(explicitHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(sourceHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const backend = new CodexAppServerBackend({
      provider: {
        id: "codex",
        label: "Codex",
        adapter: "codex_app_server",
        enabled: true,
        command: process.execPath,
        args: [codexScript],
        env: { TEST_CODEX_LOG: logFile },
        custom_models: [],
      },
      kilnHome,
      sourceCodexHome: sourceHome,
    });

    const composite = new CompositeBackend({
      kilnHome,
      initialConfig: {
        schema_version: 1,
        providers: [
          {
            id: "codex",
            label: "Codex",
            adapter: "codex_app_server",
            enabled: true,
            command: process.execPath,
            args: [codexScript],
            env: { TEST_CODEX_LOG: logFile },
            custom_models: [],
          },
        ],
      },
    });

    const overrideBackend = new CodexAppServerBackend({
      provider: {
        id: "codex",
        label: "Codex",
        adapter: "codex_app_server",
        enabled: true,
        command: process.execPath,
        args: [codexScript],
        env: { TEST_CODEX_LOG: logFile, CODEX_HOME: explicitHome },
        custom_models: [],
      },
      kilnHome,
      sourceCodexHome: sourceHome,
    });

    try {
      const expectedIso = resolveIsolatedCodexHome(kilnHome);

      await backend.probeProvider();
      const ref1 = await backend.start({
        runId: "r-iso-1",
        taskId: "t-iso-1",
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "hello",
        freshContext: true,
      });
      const ev1 = await collectAllEvents(backend, ref1);
      const bound1 = ev1.find(
        (e): e is Extract<RunEvent, { kind: "session_bound" }> => e.kind === "session_bound",
      );
      expect(ref1.meta?.codexHome).toBe(expectedIso);
      expect(ref1.meta?.providerSessionPath).toBe(
        path.join(expectedIso, "sessions", "rollout-thread-codex-1.jsonl"),
      );
      expect(bound1?.providerSessionPath).toBe(
        path.join(expectedIso, "sessions", "rollout-thread-codex-1.jsonl"),
      );

      const compositeRef = await composite.start({
        runId: "r-iso-2",
        taskId: "t-iso-2",
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "hello",
        freshContext: true,
      });
      await collectAllEvents(composite, compositeRef);
      expect(compositeRef.meta?.codexHome).toBe(expectedIso);

      const overrideRef = await overrideBackend.start({
        runId: "r-iso-3",
        taskId: "t-iso-3",
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "hello",
        freshContext: true,
      });
      await collectAllEvents(overrideBackend, overrideRef);
      expect(overrideRef.meta?.codexHome).toBe(explicitHome);

      const envLogs = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.type === "env");
      expect(envLogs[0]?.CODEX_HOME).toBe(expectedIso);
      expect(envLogs[1]?.CODEX_HOME).toBe(expectedIso);
      expect(envLogs[2]?.CODEX_HOME).toBe(expectedIso);
      expect(envLogs[3]?.CODEX_HOME).toBe(explicitHome);
    } finally {
      await backend.dispose();
      await composite.dispose();
      await overrideBackend.dispose();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("CodexAppServerBackend records modeId='workspace-write' for worker and 'read-only' for read-only roles", async () => {
    const cwd = makeTempWs("kiln-codex-modes-");
    const logFile = path.join(cwd, "codex.log");
    const backend = new CodexAppServerBackend({
      provider: {
        id: "codex",
        label: "Codex CLI",
        adapter: "codex_app_server",
        enabled: true,
        command: process.execPath,
        args: [codexScript],
        env: { TEST_CODEX_LOG: logFile },
        custom_models: [],
      },
    });

    try {
      const workerRef = await backend.start({
        runId: "r-mode-w",
        taskId: "t-mode-w",
        role: "worker",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "hello",
        freshContext: true,
      });
      await collectAllEvents(backend, workerRef);
      expect(workerRef.meta?.modeId).toBe("workspace-write");

      const reviewerRef = await backend.start({
        runId: "r-mode-r",
        taskId: "t-mode-r",
        role: "reviewer",
        agent: "codex",
        model: "gpt-5.4",
        cwd,
        prompt: "review",
        freshContext: true,
      });
      await collectAllEvents(backend, reviewerRef);
      expect(reviewerRef.meta?.modeId).toBe("read-only");
    } finally {
      await backend.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
