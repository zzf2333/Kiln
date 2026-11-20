import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KilndServer } from "@kiln/kernel";
import {
  requestDaemonGracefulShutdown,
  resolveKilnPidPath,
  resolveKilnShutdownTokenPath,
  runCli,
} from "../index.js";

describe("@kiln/cli OS local IPC graceful shutdown smoke suite", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("stops a live foreground `kiln up --foreground` daemon over real UDS/Named Pipe via /rpc/shutdown", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-cli-sock-shutdown-"));
    tempDirs.push(root);
    const kilnHome = path.join(root, "kh");

    const fgAc = new AbortController();
    let resolveServer!: (srv: KilndServer) => void;
    const serverReady = new Promise<KilndServer>((resolve) => {
      resolveServer = resolve;
    });

    const fgPromise = runCli(["up", "--foreground", "--port", "0", "--no-paseo"], {
      kilnHome,
      isDaemonRunning: () => false,
      foregroundSignal: fgAc.signal,
      onForegroundServer: (srv) => resolveServer(srv),
    });

    const fgServer = await serverReady;
    try {
      const tokenFile = resolveKilnShutdownTokenPath(kilnHome);
      const pidFile = resolveKilnPidPath(kilnHome);
      expect(fs.existsSync(tokenFile)).toBe(true);
      expect(fs.existsSync(pidFile)).toBe(true);

      const token = fs.readFileSync(tokenFile, "utf8").trim();
      expect(
        await requestDaemonGracefulShutdown({
          socketPath: fgServer.socketPath,
          shutdownToken: "wrong-token",
        }),
      ).toBe(false);

      expect(
        await requestDaemonGracefulShutdown({
          socketPath: fgServer.socketPath,
          shutdownToken: token,
        }),
      ).toBe(true);

      const fgExit = await fgPromise;
      expect(fgExit.exitCode).toBe(0);
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(tokenFile)).toBe(false);
    } finally {
      fgAc.abort();
      await fgPromise.catch(() => {});
    }
  });
});
