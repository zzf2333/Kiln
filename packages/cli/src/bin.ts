#!/usr/bin/env node
import { runCli } from "./commands.js";

async function main(): Promise<void> {
  const foregroundAc = new AbortController();
  const onSignal = (): void => {
    foregroundAc.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const result = await runCli(process.argv.slice(2), {
      stdout: process.stdout,
      stderr: process.stderr,
      foregroundSignal: foregroundAc.signal,
    });
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
