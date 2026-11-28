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
const runtimeBinDir = path.join(runtimeDir, "bin");
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

const posixLauncher = [
  "#!/bin/sh",
  "set -eu",
  'SOURCE="$0"',
  'while [ -L "$SOURCE" ]; do',
  '  DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"',
  '  TARGET="$(readlink "$SOURCE")"',
  '  case "$TARGET" in',
  '    /*) SOURCE="$TARGET" ;;',
  '    *) SOURCE="$DIR/$TARGET" ;;',
  "  esac",
  "done",
  'BIN_DIR="$(CDPATH= cd -- "$(dirname -- "$SOURCE")" && pwd)"',
  'RUNTIME_DIR="$(CDPATH= cd -- "$BIN_DIR/.." && pwd)"',
  'BUNDLE_ROOT="$(CDPATH= cd -- "$RUNTIME_DIR/../.." && pwd)"',
  'if [ -x "$BUNDLE_ROOT/MacOS/Kiln" ]; then',
  '  ELECTRON_BIN="$BUNDLE_ROOT/MacOS/Kiln"',
  'elif [ -x "$BUNDLE_ROOT/Kiln" ]; then',
  '  ELECTRON_BIN="$BUNDLE_ROOT/Kiln"',
  "else",
  '  echo "kiln: unable to locate Kiln Electron executable near $BUNDLE_ROOT" >&2',
  "  exit 1",
  "fi",
  'exec env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" "$RUNTIME_DIR/kiln-cli.mjs" "$@"',
  "",
].join("\n");

const windowsLauncher = [
  "@echo off",
  "setlocal",
  'for %%I in ("%~dp0..") do set "RUNTIME_DIR=%%~fI"',
  'for %%I in ("%RUNTIME_DIR%\\..\\..") do set "BUNDLE_ROOT=%%~fI"',
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%BUNDLE_ROOT%\\Kiln.exe" "%RUNTIME_DIR%\\kiln-cli.mjs" %*',
  "",
].join("\r\n");

fs.rmSync(runtimeBinDir, { recursive: true, force: true });
fs.mkdirSync(runtimeBinDir, { recursive: true });
for (const name of ["kiln", "kl"]) {
  const dest = path.join(runtimeBinDir, name);
  fs.writeFileSync(dest, posixLauncher, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(dest, 0o755);
}
for (const name of ["kiln.cmd", "kl.cmd"]) {
  fs.writeFileSync(path.join(runtimeBinDir, name), windowsLauncher, { encoding: "utf8" });
}
