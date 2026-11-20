# Kiln Release & Packaging Checklist

This directory holds Homebrew distribution templates ([`kiln.rb`](homebrew/kiln.rb) and [`kiln-app.rb`](homebrew/kiln-app.rb)) that complement [`scripts/install.sh`](../scripts/install.sh) and [`.github/workflows/release.yml`](../.github/workflows/release.yml).

> **Current repository state (`0.1.0`)**: All workspace packages currently carry `"private": true` and internal `@kiln/*` names with `workspace:*` references. The automated workflows and Homebrew files here are release-ready templates; complete the checklist below before cutting the first public release.

## 1. Pre-Release Package Readiness

1. **Publishable npm naming & visibility**:
   - Switch target package manifests from `"private": true` to public publishable configuration (`"private": false` or removing `"private"`, plus `"publishConfig": { "access": "public" }`).
   - Align the public CLI package name to `@zzf2333/kiln` (with `"bin": { "kiln": ..., "kl": ... }`).
   - Eliminate raw `workspace:*` dependencies from the published `@zzf2333/kiln` manifest — either publish scoped workspace dependencies (`@zzf2333/kiln-protocol`, `@zzf2333/kiln-kernel`) alongside `@zzf2333/kiln` with matching semver, or bundle internal JS modules while keeping native `better-sqlite3` as a runtime dependency.
2. **Bundle Web UI static assets (`packages/kernel/public/`)**:
   - Run `pnpm build` so `apps/web` builds into `packages/kernel/public/`.
   - Ensure the published package's `"files"` allowlist includes both compiled `dist/` outputs and `packages/kernel/public/` static assets so `kilnd` serves the Web workbench out of the box.
3. **Version alignment**:
   - Bump `version` consistently across `packages/protocol/package.json`, `packages/kernel/package.json`, `packages/mcp/package.json`, `packages/cli/package.json`, `apps/web/package.json`, and `CLI_VERSION` in `packages/cli/src/commands.ts`.

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
   - Push a `vX.Y.Z` tag (for example `v0.1.0`).
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
