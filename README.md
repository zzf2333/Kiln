[English](README.md) | [简体中文](README.zh-CN.md)

# Kiln

> **Agents are fuel; the workflow is the engine.**
>
> A local-first autonomous developer workbench for managing multiple coding repositories and everyday host tasks. A deterministic background daemon advances work through explicit contracts and verification gates while you stay in control of project scoping and critical decisions.

---

## Core Design Principles

1. **Deterministic Zero-Token Kernel (`kilnd`)**: Scheduling, SQLite lease acquisition, editable-scope validation, frozen-test hash checks, and acceptance-command reruns are executed deterministically in code—never by burning tokens on agent-to-agent chatter.
2. **Verify, Never Trust**: Agent self-reports are never accepted as proof of completion. Every handoff must pass real `accept_cmd` execution in isolation plus heterogeneous-model review (the reviewer avoids the implementation model, and any frozen-test modification triggers escalation).
3. **Swappable Agents & Backends**: Execution engines sit behind a narrow `ExecutionBackend` interface (V1 uses the Paseo TS SDK to cover Codex, Pi, and `agy acp`). All 7 workflow roles can hot-swap agents and models in settings while workflows and the decision ledger stay locally in `~/.kiln/`.
4. **Four Isolated Workspace Modes**: Native support for code repositories (`git_worktree` + APFS copy-on-write on macOS), host configuration changes (`host_scoped` two-phase staging + path locks + SHA256 rollback guards), standalone research (`scratch_dir`), and external follow-ups (`external_only`).
5. **One Core, Multiple Surfaces**: A single zero-dependency daemon (`127.0.0.1:4310` local, optional authenticated `127.0.0.1:4311` remote) powers the `kiln` / `kl` single-binary CLI, the embedded desktop/mobile Web workbench (PWA), the internal stdio MCP tool bridge (`kiln __mcp`), and the macOS/Windows Tauri v2 Sidecar tray app—with token usage normalized transparently against official API pricing.

---

## Repository Structure

| Path | Description |
| :--- | :--- |
| [`packages/protocol`](packages/protocol/package.json) | **Pure Data Contracts**: End-to-end Zod schemas, `card.yaml` / receipt / config parsing, pricing formulas, and browser bundle (`@kiln/protocol/web`) |
| [`packages/kernel`](packages/kernel/package.json) | **`kilnd` Daemon Core**: State machine, scheduler, verification gates, zero-native SQLite (`bun:sqlite` / `node:sqlite`) store, dual-port HTTP+SSE API, embedded static asset server, and `ExecutionBackend` adapters |
| [`packages/mcp`](packages/mcp/package.json) | **`kiln-mcp` Tool Server**: Restricted `stdio` MCP server (also embedded as `kiln __mcp`) communicating with `kilnd` over POSIX `0600` Unix socket or Windows Named Pipe + `KILN_RUN_TOKEN` |
| [`packages/cli`](packages/cli/package.json) | **`kiln` / `kl` CLI**: Daemon lifecycle, status inspection, draft/decision/space/remote workflows, diagnostics, and opt-in OS startup services (macOS / Linux / Windows) |
| [`apps/web`](apps/web/package.json) | **Web Workbench**: Preact adaptive UI for desktop and mobile (`<= 820px`), compiled into `packages/kernel/public/` and embedded into standalone binaries |
| [`apps/desktop`](apps/desktop/README.md) | **Desktop Tray Shell (macOS & Windows)**: Tauri v2 Sidecar tray app (`CREATE_NO_WINDOW` on Windows, on-demand WebView destruction, CLI link installer, and pure-`std` `model.rs` core) |
| [`scripts/`](scripts/install.sh) | **Installers & Binary Builder**: Zero-Node [`install.sh`](scripts/install.sh), Windows [`install.ps1`](scripts/install.ps1), [`test-install.sh`](scripts/test-install.sh), and Bun compiler [`build-binary.mjs`](scripts/build-binary.mjs) |
| [`packaging/`](packaging/README.md) | **Release Templates**: Prebuilt-binary Homebrew [Formula](packaging/homebrew/Formula/kiln.rb), macOS [Cask](packaging/homebrew/Casks/kiln-app.rb), and release checklist |
| [`.github/workflows/`](.github/workflows/ci.yml) | **Automation**: 3-OS [`ci.yml`](.github/workflows/ci.yml) (`ubuntu-latest`, `macos-latest`, `windows-latest`) and 3-OS binary + desktop Sidecar [`release.yml`](.github/workflows/release.yml) |

---

## Installation

> **Pre-release notice**: Current pre-release manifests target **`0.0.2`** (`0.1.0` is reserved for the first formal public release). Prebuilt GitHub Release binaries, desktop installers, and Homebrew tap checksums activate once the corresponding GitHub Release tag is published (see [`packaging/README.md`](packaging/README.md)); until then, you can [Build from Source](#build-from-source) or compile a local standalone binary with `pnpm build:binary`.

### 1. Standalone Binary Installer — macOS / Linux (Zero Node.js Required)

Downloads the prebuilt single binary from GitHub Releases, verifies `SHA256SUMS`, and installs `kiln` + symlink `kl` into `~/.local/bin` (zero Node.js/npm requirement; never modifies `~/.zshrc` / `~/.bashrc` or registers background startup services):

```sh
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh
```

Useful installer options (see [`scripts/install.sh`](scripts/install.sh)):

```sh
# Preview planned binary URL, checksum plan, and install path without writing to disk
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --dry-run

# Pin a version or custom prefix (<prefix>/bin)
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --version 0.1.0 --prefix "$HOME/.local"
```

### 2. Standalone Binary Installer — Windows x64 (Zero Node.js / Zero UAC)

Downloads `kiln-v<ver>-windows-x64.exe`, verifies `SHA256SUMS`, and installs `kiln.exe` + `kl.cmd` into `%LOCALAPPDATA%\Kiln\bin` without administrator privileges or automatic startup entries:

```powershell
irm https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.ps1 | iex
```

Dry-run / custom version or prefix (see [`scripts/install.ps1`](scripts/install.ps1)):

```powershell
./scripts/install.ps1 -DryRun -Version 0.1.0 -Prefix "$env:LOCALAPPDATA\Kiln"
```

### 3. Desktop App with Bundled Sidecar (macOS `.dmg` / Windows NSIS `.exe`)

Download the platform desktop bundle from GitHub Releases (bundles the self-contained `kiln` / `kiln.exe` sidecar directly—no Node.js installation needed, and includes a tray menu action to link `kiln` / `kl` for terminal use):

- **macOS**: `Kiln-v<ver>-darwin-arm64.dmg` / `Kiln-v<ver>-darwin-x64.dmg` (or Homebrew Cask once notarized)
- **Windows x64**: `Kiln-v<ver>-windows-x64-setup.exe` (current-user NSIS installer, zero UAC, hidden console sidecar)

### 4. Homebrew Tap (macOS / Linux, Zero Node.js)

```sh
# Prebuilt standalone CLI (`kiln` / `kl`)
brew install zzf2333/tap/kiln

# macOS menu bar app (once signed & notarized DMG is published)
brew install --cask zzf2333/tap/kiln-app
```

### Build from Source

> Requirements: `Node >= 22.0.0`, `pnpm >= 9.0.0` (add `Bun >= 1.4` for standalone single-binary compilation; `Rust / Cargo` for Tauri desktop builds)

```sh
pnpm install       # Install all monorepo workspace dependencies
pnpm build         # Build protocol, kernel, mcp, cli, and apps/web into packages/kernel/public/
pnpm typecheck     # Run workspace-wide TypeScript type checking
pnpm test          # Run unit and integration test suites
pnpm test:socket   # Run Unix socket / Named Pipe and loopback TCP smoke tests
pnpm build:binary -- --target host   # Compile standalone single binary with embedded Web UI
```

Validate installer, Homebrew templates, and desktop core unit tests locally:

```sh
sh -n scripts/install.sh && sh scripts/test-install.sh
ruby -c packaging/homebrew/Formula/kiln.rb && ruby -c packaging/homebrew/Casks/kiln-app.rb
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
rustc -D warnings --test apps/desktop/src-tauri/src/model.rs -o /tmp/kiln-desktop-model-test && /tmp/kiln-desktop-model-test && rm -f /tmp/kiln-desktop-model-test
```

---

## Quick Start

```sh
kiln doctor                     # Verify Node >= 22, Git, APFS clone, kilnd, Paseo, and service status
kiln up                         # Start local kilnd daemon in the background (127.0.0.1:4310, PaseoBackend on by default)
kiln space add .                # Register the current Git repository as a project space
kiln open                       # Open the local Web workbench in your default browser
kiln draft "Add OAuth PKCE"     # Create a task draft card
kiln status                     # Inspect running tasks, pending decisions, drafts, and usage
kiln decide                     # List or resolve pending human decisions
kiln down                       # Stop the managed kilnd daemon
```

Optional login auto-start (strictly opt-in) and clean removal:

```sh
kiln service install            # Register macOS LaunchAgent or Linux systemd user service
kiln service status             # Check OS startup service registration
kiln uninstall                  # Stop daemon, remove service, inspect worktrees (preserves ~/.kiln by default)
```

---

## CLI Reference (`kiln` / `kl`)

| Command | Description |
| :--- | :--- |
| `kiln up [--port <port>] [--host <host>] [--foreground] [--paseo-url <url>] [--no-paseo]` | Start `kilnd` idempotently (defaults to `127.0.0.1:4310` with `PaseoBackend` registered; override via `--paseo-url`/`PASEO_URL`/`PASEO_PASSWORD` or skip via `--no-paseo`/`KILN_DISABLE_PASEO=1`; `--foreground` runs attached) |
| `kiln down` | Stop the managed `kilnd` daemon cleanly |
| `kiln open [--port <port>] [--host <host>]` | Open the Kiln Web workbench in the system browser |
| `kiln status [--port <port>] [--host <host>] [--json]` | Display tasks, running count, pending decisions, drafts, and usage |
| `kiln space <list\|add [path]\|rm <id>> [--id <id>] [--name <name>] [--branch <branch>] [--accept-cmd <cmd>] [--copy-untracked <csv>] [--clone-deps <csv>] [--port <port>] [--host <host>] [--json]` | List, register/inspect a local Git repository (`add` defaults to current directory), or remove an idle project space |
| `kiln draft "<idea>" [--id <id>] [--space <id>] [--priority <P0\|P1\|P2\|P3>] [--track <L1\|L2>] [--mode <git_worktree\|host_scoped\|scratch_dir>] [--port <port>] [--host <host>]` | Create a new draft card |
| `kiln decide [task-id] [--option <id>] [--decision <id>] [--rationale <text>] [--apply-ledger] [--port <port>] [--host <host>]` | List or submit pending approval decisions |
| `kiln doctor [--port <port>] [--host <host>] [--json]` | Check Node, Git, APFS clone support, `kilnd` reachability, Paseo agent discovery (`required: false`), and startup service state |
| `kiln service <install\|uninstall\|status> [--platform <darwin\|linux>] [--label <label>] [--service-name <name>]` | Explicitly install, remove, or inspect the OS background service |
| `kiln uninstall [--purge-data] [--platform <darwin\|linux>]` | Stop daemon, remove startup service, inspect worktrees (add `--purge-data` to delete `~/.kiln`) |
| `kiln -h, --help` / `kiln -v, --version` / `kiln help` | Print CLI help or version (`0.0.2`) |

---

## Roadmap

- [x] **M0 · Technical Probe Verification**: Verified underlying agent capabilities, permission policies, and token/cost accounting formats.
- [x] **M1 · Protocol & Headless Kernel**: Completed `packages/protocol`, `kernel`, `mcp`, `cli`, and concurrency race / store-rebuild test suites.
- [x] **M2 · MVP Workbench Loop**: Passed all 8 real-machine E2E scenarios (`S1`–`S8`) against live Paseo (`codex` + `pi`), real `stdio` `kiln-mcp`, and Playwright Chrome acceptance across desktop (`1440×900`) and mobile (`390×844` `<= 820px`) viewports (with SQLite rebuild parity verified).
- [ ] **M3 / M3.5 · Desktop Sidecar, Standalone Distribution & Remote Access V1 (In Progress)**: Zero-dependency single-binary CLI (`bun:sqlite`/`node:sqlite`, `kiln __mcp`, embedded Web UI + PWA), macOS `.dmg` & Windows NSIS `.exe` Tauri v2 Sidecar apps, dual-port fail-closed remote mobile access (`:4310` local / `:4311` authenticated), Bark/ntfy/Webhook push, and 3-OS CI/Release pipeline validated (`0.0.2` pre-release; `0.1.0` reserved for signed/notarized formal release).
- [ ] **M4 · Post-MVP Evolution**: Retrospectives, serialized multi-slice merge queue, execution swimlanes, Tailscale/Passkey push notifications, and Epic Loop.

---

## License

[Apache-2.0](LICENSE)
