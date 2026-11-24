import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "../..");

const kernelPublicDir = path.join(repoRoot, "packages", "kernel", "public");
const kernelIndexHtml = path.join(kernelPublicDir, "index.html");
const runtimeDir = path.join(desktopDir, "runtime");
const runtimePublicDir = path.join(runtimeDir, "public");
const runtimeCli = path.join(runtimeDir, "kiln-cli.mjs");
const runtimeMcp = path.join(runtimeDir, "kiln-mcp.mjs");

for (const [label, filePath] of [
  ["built Web UI entry (packages/kernel/public/index.html)", kernelIndexHtml],
  ["compiled Electron CLI runtime (apps/desktop/runtime/kiln-cli.mjs)", runtimeCli],
  ["compiled Electron MCP runtime (apps/desktop/runtime/kiln-mcp.mjs)", runtimeMcp],
]) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required ${label} at ${filePath}. Run workspace builds first.`);
  }
}

fs.rmSync(runtimePublicDir, { recursive: true, force: true });
fs.cpSync(kernelPublicDir, runtimePublicDir, { recursive: true });
