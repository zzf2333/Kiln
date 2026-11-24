# Kiln Release & Packaging Checklist

This directory holds Homebrew distribution templates ([`Formula/kiln.rb`](homebrew/Formula/kiln.rb) and [`Casks/kiln-app.rb`](homebrew/Casks/kiln-app.rb)) that complement the standalone installers ([`scripts/install.sh`](../scripts/install.sh), [`scripts/install.ps1`](../scripts/install.ps1)), standalone binary compiler ([`scripts/build-binary.mjs`](../scripts/build-binary.mjs)), and 3-OS release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)).

> **Current repository state (`0.0.5`)**: Current development and pre-release artifacts target **`0.0.5`** (`v0.0.5`), reserving **`0.1.0`** for the first formal external release. Kiln compiles to a zero-dependency standalone executable (`bun build --compile` with embedded Web UI assets and internal `kiln __mcp` stdio bridge) for macOS (`darwin-arm64`, `darwin-x64`), Windows (`windows-x64.exe`), and Linux (`linux-x64`), and bundles that binary as a Tauri v2 Sidecar inside macOS `.dmg` and Windows NSIS `.exe` desktop apps.

## 1. Pre-Release Package Readiness

1. **Zero-dependency standalone binary (`scripts/build-binary.mjs`)**:
   - Uses runtime built-in SQLite (`bun:sqlite` in compiled binaries / `node:sqlite` in Node >= 22 dev/test builds) with zero native C++ addons.
   - Embeds compiled `packages/kernel/public/` assets (including `index.html`, JS/CSS bundles, icons, and `manifest.webmanifest`) directly inside the binary and serves them automatically when no disk `public/` directory is present.
   - Exposes hidden `kiln __mcp` in-process stdio MCP bridge invoked as `[process.execPath, "__mcp"]` in compiled mode.
   - Build locally:
     ```sh
     pnpm build
     pnpm build:binary -- --target host
     # Optional: cross-compile Windows x64 or stage Tauri sidecar
     node scripts/build-binary.mjs --target windows-x64
     node scripts/build-binary.mjs --target host --stage-sidecar
     ```
2. **Tauri v2 Desktop Sidecar (`apps/desktop/`)**:
   - `apps/desktop/src-tauri/tauri.conf.json` stays free of `externalBin` so `cargo check` / `cargo test` always pass without prebuilt binaries.
   - `apps/desktop/src-tauri/tauri.sidecar.conf.json` overlays `bundle.externalBin: ["binaries/kiln"]` and user-level Windows NSIS (`installMode: "currentUser"`, `webviewInstallMode: "downloadBootstrapper"`).
   - `apps/desktop/src-tauri/binaries/` and `release-artifacts/` are `.gitignore`d and must never be committed to Git.
3. **Version alignment**:
   - When bumping versions, update `version` consistently across `packages/protocol/package.json`, `packages/kernel/package.json`, `packages/mcp/package.json`, `packages/cli/package.json`, `apps/web/package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`, plus runtime version defaults `CLI_VERSION` (`packages/cli/src/commands.ts`), `KERNEL_VERSION` (`packages/kernel/src/index.ts`), `DEFAULT_SERVER_VERSION` (`packages/kernel/src/server/daemon.ts`), `packages/kernel/src/server/http-api.ts`, and `packages/mcp/src/server.ts`, and update `packaging/homebrew/Formula/kiln.rb` / `packaging/homebrew/Casks/kiln-app.rb`.

## 2. Repository Secrets & Signing Credentials

Configure the following GitHub Actions secrets before expecting signed public desktop releases:

| Secret | Required For | Notes |
| :--- | :--- | :--- |
| `APPLE_CERTIFICATE` | Signing `Kiln.app` (including `Contents/MacOS/kiln` sidecar) & `.dmg` | Base64-encoded Developer ID Application `.p12` certificate. |
| `APPLE_CERTIFICATE_PASSWORD` | Unlocking signing certificate | Password for `APPLE_CERTIFICATE`. |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_PASSWORD` | Apple notarization (`xcrun notarytool`) | Required so macOS Gatekeeper accepts `Kiln.app` without quarantine warnings (`APPLE_PASSWORD` holds the Apple app-specific password read by Tauri v2). |
| Windows Authenticode certificate | Signing `Kiln.exe`, `kiln.exe` sidecar, and NSIS setup `.exe` | Configure `bundle.windows.signCommand` before public Windows SmartScreen-free distribution. |

## 3. Release Execution Flow

1. **Dry-run verification**:
   - Trigger `.github/workflows/release.yml` via `workflow_dispatch` (`dry_run: true`) to validate workspace version parity (including `tauri.conf.json` and `Cargo.toml`), `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:socket`, `scripts/test-install.sh`, 3-OS standalone binary builds + native smoke tests, macOS + Windows Tauri sidecar bundles, and `SHA256SUMS` output without publishing a GitHub Release.
2. **Tag & release**:
   - Push a `vX.Y.Z` tag (for example `v0.1.0` for the first formal release).
   - `.github/workflows/release.yml` publishes all standalone binaries (`darwin-arm64`, `darwin-x64`, `windows-x64.exe`, `linux-x64`), macOS `.dmg` & Windows NSIS `.exe` desktop bundles, and unified `SHA256SUMS` to GitHub Releases.
3. **Backfill Homebrew Tap (`zzf2333/homebrew-tap`)**:
   - Copy the real `sha256` digests for `kiln-v<ver>-darwin-arm64`, `kiln-v<ver>-darwin-x64`, and `kiln-v<ver>-linux-x64` from `SHA256SUMS` into `packaging/homebrew/Formula/kiln.rb`.
   - Once signed and notarized macOS DMGs are attached to the GitHub Release, backfill the real `sha256` into `packaging/homebrew/Casks/kiln-app.rb`.
   - Sync both files into `zzf2333/homebrew-tap` and run `brew audit --strict` + `brew test` on macOS.

## 4. Local Template Validation

```sh
sh -n scripts/install.sh
sh scripts/test-install.sh
ruby -c packaging/homebrew/Formula/kiln.rb
ruby -c packaging/homebrew/Casks/kiln-app.rb
```

## 5. Installation Safety Guarantees

- `scripts/install.sh`, `scripts/install.ps1`, `packaging/homebrew/Formula/kiln.rb`, and `packaging/homebrew/Casks/kiln-app.rb` **never** create `~/Library/LaunchAgents`, `~/.config/systemd` units, Windows `HKCU\...\Run` startup entries, `crontab` entries, or silently modify `~/.zshrc` / `~/.bashrc` / PowerShell `$PROFILE`.
- Background daemon startup at login remains strictly opt-in via `kiln service install`, and requires zero UAC / administrator privileges on Windows.
