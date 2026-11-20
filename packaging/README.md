# Kiln Release & Packaging Checklist

This directory holds Homebrew distribution templates ([`kiln.rb`](homebrew/kiln.rb) and [`kiln-app.rb`](homebrew/kiln-app.rb)) that complement [`scripts/install.sh`](../scripts/install.sh) and [`.github/workflows/release.yml`](../.github/workflows/release.yml).

> **Current repository state (`0.0.1`)**: Current development and initial pre-release artifacts target **`0.0.1`** (`v0.0.1`), reserving **`0.1.0`** for the first formal external release. `packages/cli` is configured as the standalone public package `@zzf2333/kiln` (`"publishConfig": { "access": "public" }`, internal `@kiln/*` bundled into `dist/` & `mcp/dist/`, Web UI assets staged into `public/`, verified via isolated `npm install -g`), while internal monorepo packages (`packages/protocol`, `packages/kernel`, `packages/mcp`, `apps/web`, `apps/desktop`) remain `"private": true`. Complete the release-time secrets, tag, and Homebrew checksum steps below when cutting a release.

## 1. Pre-Release Package Readiness

1. **Standalone `@zzf2333/kiln` packaging (Completed)**:
   - `packages/cli/package.json` publishes `@zzf2333/kiln` (`"publishConfig": { "access": "public" }`, `"bin": { "kiln": "./dist/bin.js", "kl": "./dist/bin.js", "kiln-mcp": "./mcp/dist/bin.js" }`) with zero `workspace:*` runtime `dependencies` (only external npm deps including `better-sqlite3`).
   - `packages/cli/tsup.config.ts` bundles `@kiln/*` modules into `dist/` and `mcp/dist/` (resolving internal `@kiln/*` types), and `packages/cli/scripts/stage-assets.mjs` copies `packages/kernel/public/`, `README.md`, and `LICENSE` for `"files"`.
2. **Bundle Web UI static assets (`packages/kernel/public/` -> `packages/cli/public/`)**:
   - Running `pnpm build` compiles `apps/web` into `packages/kernel/public/` and automatically stages `packages/cli/public/` so installed `@zzf2333/kiln` serves the Web workbench out of the box.
3. **Version alignment**:
   - When bumping versions, update `version` consistently across `packages/protocol/package.json`, `packages/kernel/package.json`, `packages/mcp/package.json`, `packages/cli/package.json`, `apps/web/package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`, plus runtime version defaults `CLI_VERSION` (`packages/cli/src/commands.ts`), `KERNEL_VERSION` (`packages/kernel/src/index.ts`), `DEFAULT_SERVER_VERSION` (`packages/kernel/src/server/daemon.ts`), `packages/kernel/src/server/http-api.ts`, and `packages/mcp/src/server.ts`, and update `packaging/homebrew/kiln.rb` / `packaging/homebrew/kiln-app.rb` (then run `cargo check` and `pnpm build` so `Cargo.lock` and staged CLI assets stay in sync).

## 2. Repository Secrets & Signing Credentials

Configure the following GitHub Actions secrets before expecting unattended publishing:

| Secret | Required For | Notes |
| :--- | :--- | :--- |
| `NPM_TOKEN` | Automated npm publish of `@zzf2333/kiln` | Granular npm Automation token with write access to `@zzf2333`. Without it, `release.yml` skips npm publish cleanly instead of failing. |
| `APPLE_CERTIFICATE` | Signing `Kiln.app` & `.dmg` | Base64-encoded Developer ID Application `.p12` certificate (required before enabling macOS Cask distribution). |
| `APPLE_CERTIFICATE_PASSWORD` | Unlocking signing certificate | Password for `APPLE_CERTIFICATE`. |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` | Apple notarization (`xcrun notarytool`) | Required so macOS Gatekeeper accepts `Kiln.app` without quarantine warnings. |

## 3. Release Execution Flow

1. **Dry-run verification**:
   - Trigger `.github/workflows/release.yml` via `workflow_dispatch` (`dry_run: true`) to validate `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:socket`, `scripts/test-install.sh`, tarball creation, and `SHA256SUMS` output without uploading assets or publishing to npm.
2. **Tag & release**:
   - Push a `vX.Y.Z` tag (for example `v0.0.1` for the initial pre-release or `v0.1.0` for the first formal release).
   - `.github/workflows/release.yml` verifies tag-to-package version parity, creates tarballs + `SHA256SUMS`, publishes the GitHub Release, and publishes `@zzf2333/kiln` if `NPM_TOKEN` is present and manifests are public.
3. **Backfill Homebrew Tap (`zzf2333/homebrew-tap`)**:
   - Copy the real `sha256` from `SHA256SUMS` (or `shasum -a 256 <tarball>`) into `packaging/homebrew/kiln.rb` (replacing the `0000...` placeholder and updating `url` if needed).
   - Once a signed and notarized `Kiln-<version>-universal.dmg` is attached to the GitHub Release, backfill its real `sha256` into `packaging/homebrew/kiln-app.rb`.
   - Sync both files into `zzf2333/homebrew-tap` and run `brew audit --strict` + `brew test` on macOS.

## 4. Local Template Validation

```sh
sh -n scripts/install.sh
sh scripts/test-install.sh
ruby -c packaging/homebrew/kiln.rb
ruby -c packaging/homebrew/kiln-app.rb
```

## 5. Installation Safety Guarantees

- `scripts/install.sh`, `packaging/homebrew/kiln.rb`, and `packaging/homebrew/kiln-app.rb` **never** create `~/Library/LaunchAgents`, `~/.config/systemd` units, `crontab` entries, or modify `~/.zshrc` / `~/.bashrc`.
- Background daemon startup at login remains strictly opt-in via `kiln service install`.
