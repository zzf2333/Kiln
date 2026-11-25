# Kiln Release & Packaging Checklist

This directory holds Homebrew distribution templates ([`Formula/kiln.rb`](homebrew/Formula/kiln.rb) and [`Casks/kiln-app.rb`](homebrew/Casks/kiln-app.rb)) that complement the standalone installers ([`scripts/install.sh`](../scripts/install.sh), [`scripts/install.ps1`](../scripts/install.ps1)), standalone binary compiler ([`scripts/build-binary.mjs`](../scripts/build-binary.mjs)), and 3-OS release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)).

> **Current repository state (`0.0.6`)**: Current development and pre-release artifacts target **`0.0.6`** (`v0.0.6`), reserving **`0.1.0`** for the first formal external release. Kiln compiles to a zero-dependency standalone CLI binary (`bun build --compile` with embedded Web UI assets and internal `kiln __mcp` stdio bridge) for macOS (`darwin-arm64`, `darwin-x64`), Windows (`windows-x64.exe`), and Linux (`linux-x64`), and ships an Electron desktop workbench (`Kiln.app` `.dmg` / Windows NSIS `.exe`) reusing Electron's built-in Node runtime (`ELECTRON_RUN_AS_NODE=1`) over bundled `kiln-runtime/{kiln-cli.mjs,kiln-mcp.mjs,public/}`.

## 1. Pre-Release Package Readiness

1. **Zero-dependency standalone binary (`scripts/build-binary.mjs`)**:
   - Uses runtime built-in SQLite (`bun:sqlite` in compiled binaries / `node:sqlite` in Node >= 22 dev/test builds) with zero native C++ addons.
   - Embeds compiled `packages/kernel/public/` assets (including `index.html`, JS/CSS bundles, icons, and `manifest.webmanifest`) directly inside the binary and serves them automatically when no disk `public/` directory is present.
   - Exposes hidden `kiln __mcp` in-process stdio MCP bridge invoked as `[process.execPath, "__mcp"]` in compiled mode.
   - Build locally:
     ```sh
     pnpm build
     pnpm build:binary -- --target host
     # Optional: cross-compile Windows x64 standalone CLI binary
     node scripts/build-binary.mjs --target windows-x64
     ```
2. **Electron Desktop Workbench (`apps/desktop/`)**:
   - `pnpm build` builds `apps/desktop/dist/main.js` and stages `apps/desktop/runtime/{kiln-cli.mjs,kiln-mcp.mjs,public/}` via `apps/desktop/scripts/stage-runtime.mjs`.
   - `electron-builder` packages `apps/desktop/runtime/` as `Contents/Resources/kiln-runtime` (macOS `.dmg`) or `resources/kiln-runtime` (Windows user-level NSIS `.exe` with `perMachine: false`).
   - `apps/desktop/runtime/`, `apps/desktop/release/`, and `release-artifacts/` are `.gitignore`d and must never be committed to Git.
3. **Version alignment**:
   - When bumping versions, update `version` consistently across `packages/protocol/package.json`, `packages/kernel/package.json`, `packages/mcp/package.json`, `packages/cli/package.json`, `apps/web/package.json`, `apps/desktop/package.json`, plus runtime version defaults `CLI_VERSION` (`packages/cli/src/commands.ts`), `KERNEL_VERSION` (`packages/kernel/src/index.ts`), `DEFAULT_SERVER_VERSION` (`packages/kernel/src/server/daemon.ts`), `packages/kernel/src/server/http-api.ts`, and `packages/mcp/src/server.ts`, and update `packaging/homebrew/Formula/kiln.rb` / `packaging/homebrew/Casks/kiln-app.rb`.

## 2. Repository Secrets & Signing Credentials

Configure the following GitHub Actions secrets before expecting signed public desktop releases:

| Secret                                          | Required For                                                           | Notes                                                                                                                        |
| :---------------------------------------------- | :--------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`                             | Signing `Kiln.app` & `.dmg` (`CSC_LINK`)                               | Base64-encoded Developer ID Application `.p12` certificate.                                                                  |
| `APPLE_CERTIFICATE_PASSWORD`                    | Unlocking signing certificate (`CSC_KEY_PASSWORD`)                     | Password for `APPLE_CERTIFICATE`.                                                                                            |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_PASSWORD` | Apple notarization (`APPLE_APP_SPECIFIC_PASSWORD` in electron-builder) | Required so macOS Gatekeeper accepts `Kiln.app` without quarantine warnings.                                                 |
| Windows Authenticode certificate                | Signing `Kiln.exe` and NSIS setup `.exe`                               | Configure `win.signtoolOptions` / CSC credentials in `electron-builder` before public Windows SmartScreen-free distribution. |

## 3. Release Execution Flow

1. **Dry-run verification**:
   - Trigger `.github/workflows/release.yml` via `workflow_dispatch` (`dry_run: true`) to validate workspace version parity, `pnpm check`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:socket`, `scripts/test-install.sh`, 3-OS standalone binary builds + native smoke tests, macOS + Windows Electron bundles, and `SHA256SUMS` output without publishing a GitHub Release.
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
