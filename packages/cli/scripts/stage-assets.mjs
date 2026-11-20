import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cliDir, "../..");

const kernelPublicDir = path.resolve(cliDir, "../kernel/public");
const kernelIndexHtml = path.join(kernelPublicDir, "index.html");
const targetPublicDir = path.join(cliDir, "public");
const cliBin = path.join(cliDir, "dist/bin.js");
const mcpBin = path.join(cliDir, "mcp/dist/bin.js");
const rootReadme = path.join(repoRoot, "README.md");
const rootLicense = path.join(repoRoot, "LICENSE");

for (const [label, filePath] of [
  ["built Web UI entry (packages/kernel/public/index.html)", kernelIndexHtml],
  ["compiled CLI entrypoint (packages/cli/dist/bin.js)", cliBin],
  ["compiled MCP entrypoint (packages/cli/mcp/dist/bin.js)", mcpBin],
  ["root README.md", rootReadme],
  ["root LICENSE", rootLicense],
]) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required ${label} at ${filePath}. Run workspace builds first.`);
  }
}

fs.rmSync(targetPublicDir, { recursive: true, force: true });
fs.cpSync(kernelPublicDir, targetPublicDir, { recursive: true });
fs.copyFileSync(rootReadme, path.join(cliDir, "README.md"));
fs.copyFileSync(rootLicense, path.join(cliDir, "LICENSE"));

if (process.platform !== "win32") {
  fs.chmodSync(cliBin, 0o755);
  fs.chmodSync(mcpBin, 0o755);
}
