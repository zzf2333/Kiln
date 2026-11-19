#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runStdioMcpServer } from "./server.js";

export {
  runStdioMcpServer,
  type RunStdioMcpServerOptions,
  type RunningMcpServer,
} from "./server.js";

/**
 * CLI entrypoint for `kiln-mcp`: fails fast when `KILN_RUN_TOKEN` is missing/blank
 * and handles SIGINT/SIGTERM graceful shutdown over stdio.
 */
export async function main(): Promise<void> {
  let handle: Awaited<ReturnType<typeof runStdioMcpServer>>;
  try {
    handle = await runStdioMcpServer(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`kiln-mcp: ${message}\n`);
    process.exit(1);
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    try {
      await handle.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`kiln-mcp shutdown error (${signal}): ${message}\n`);
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };

  const onSigint = (): void => {
    void shutdown("SIGINT");
  };
  const onSigterm = (): void => {
    void shutdown("SIGTERM");
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
}

function isExecutedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

if (isExecutedAsCli()) {
  void main();
}
