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
5. **One Core, Multiple Surfaces**: A single local daemon (`127.0.0.1:4310` by default) powers the `kiln` / `kl` CLI, the adaptive desktop/mobile Web workbench, the restricted stdio MCP tool bridge (`kiln-mcp`), and the planned macOS menu bar app—with token usage normalized transparently against official API pricing.

---

## Repository Structure

| Path | Description |
| :--- | :--- |
| [`packages/protocol`](packages/protocol/package.json) | **Pure Data Contracts**: End-to-end Zod schemas, `card.yaml` / receipt / config parsing, pricing formulas, and browser bundle (`@kiln/protocol/web`) |
| [`packages/kernel`](packages/kernel/package.json) | **`kilnd` Daemon Core**: State machine, scheduler, verification gates, rebuildable SQLite/filesystem store, HTTP+SSE API, and `ExecutionBackend` adapters |
| [`packages/mcp`](packages/mcp/package.json) | **`kiln-mcp` Tool Server**: Restricted `stdio` MCP server communicating with `kilnd` over `0600` Unix socket + `KILN_RUN_TOKEN` |
| [`packages/cli`](packages/cli/package.json) | **`kiln` / `kl` CLI**: Daemon lifecycle, status inspection, draft/decision workflows, diagnostics, and opt-in OS startup services |
| [`apps/web`](apps/web/package.json) | **Web Workbench**: Preact adaptive UI for desktop and mobile (`<= 820px`), compiled into `packages/kernel/public/` |
| [`apps/desktop`](apps/desktop/README.md) | **Desktop Menu Bar Shell**: Tauri v2 tray shell with on-demand `WKWebView` destruction and pure-`std` `model.rs` core |
| [`scripts/`](scripts/install.sh) | **Installer & Tests**: POSIX [`install.sh`](scripts/install.sh) and dependency-free [`test-install.sh`](scripts/test-install.sh) |
| [`packaging/`](packaging/README.md) | **Release Templates**: Homebrew [Formula](packaging/homebrew/kiln.rb), [Cask](packaging/homebrew/kiln-app.rb), and pre-release checklist |
| [`.github/workflows/`](.github/workflows/ci.yml) | **Automation**: Cross-platform [`ci.yml`](.github/workflows/ci.yml) (`ubuntu-latest`, `macos-latest`) and [`release.yml`](.github/workflows/release.yml) |

---

## Installation

> **Pre-release notice**: Workspace manifests are currently marked `"private": true` at `0.1.0` while M2 end-to-end acceptance and M3 packaging prep are finalized. Public npm and Homebrew channels below activate once the first public release is cut (see [`packaging/README.md`](packaging/README.md)). Until then, use [Build from Source](#build-from-source).

### 1. One-Line Install Script (macOS / Linux)

Requires **Node.js `>= 22.0.0`** and **npm**. Never modifies `~/.zshrc` / `~/.bashrc` or registers background startup services:

```sh
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh
```

Useful installer options (see [`scripts/install.sh`](scripts/install.sh)):

```sh
# Preview exact npm command without writing to disk
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --dry-run

# Pin a version or custom global prefix
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --version 0.1.0 --prefix "$HOME/.local"
```

### 2. npm (Global CLI)

```sh
npm install -g @zzf2333/kiln
```

### 3. Homebrew Tap (macOS / Linux)

```sh
# CLI (`kiln` / `kl`)
brew install zzf2333/tap/kiln

# macOS menu bar app (planned for M3 release)
brew install --cask zzf2333/tap/kiln-app
```

### Build from Source

> Requirements: `Node >= 22.0.0`, `pnpm >= 9.0.0`

```sh
pnpm install       # Install all monorepo workspace dependencies
pnpm build         # Build protocol, kernel, mcp, cli, and apps/web into packages/kernel/public/
pnpm typecheck     # Run workspace-wide TypeScript type checking
pnpm test          # Run unit and integration test suites
pnpm test:socket   # Run Unix socket and loopback TCP smoke tests
```

Validate installer, Homebrew templates, and desktop core unit tests locally:

```sh
sh -n scripts/install.sh && sh scripts/test-install.sh
ruby -c packaging/homebrew/kiln.rb && ruby -c packaging/homebrew/kiln-app.rb
rustc -D warnings --test apps/desktop/src-tauri/src/model.rs -o /tmp/kiln-desktop-model-test && /tmp/kiln-desktop-model-test && rm -f /tmp/kiln-desktop-model-test
```

---

## Quick Start

```sh
kiln doctor                     # Verify Node >= 22, Git, APFS clone, kilnd, Paseo, and service status
kiln up                         # Start local kilnd daemon in the background (127.0.0.1:4310, PaseoBackend on by default)
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
| `kiln draft "<idea>" [--id <id>] [--space <id>] [--priority <P0\|P1\|P2\|P3>] [--track <L1\|L2>] [--mode <git_worktree\|host_scoped\|scratch_dir>] [--port <port>] [--host <host>]` | Create a new draft card |
| `kiln decide [task-id] [--option <id>] [--decision <id>] [--rationale <text>] [--apply-ledger] [--port <port>] [--host <host>]` | List or submit pending approval decisions |
| `kiln doctor [--port <port>] [--host <host>] [--json]` | Check Node, Git, APFS clone support, `kilnd` reachability, Paseo agent discovery (`required: false`), and startup service state |
| `kiln service <install\|uninstall\|status> [--platform <darwin\|linux>] [--label <label>] [--service-name <name>]` | Explicitly install, remove, or inspect the OS background service |
| `kiln uninstall [--purge-data] [--platform <darwin\|linux>]` | Stop daemon, remove startup service, inspect worktrees (add `--purge-data` to delete `~/.kiln`) |
| `kiln -h, --help` / `kiln -v, --version` / `kiln help` | Print CLI help or version (`0.1.0`) |

---

## Roadmap

- [x] **M0 · Technical Probe Verification**: Verified underlying agent capabilities, permission policies, and token/cost accounting formats.
- [x] **M1 · Protocol & Headless Kernel**: Completed `packages/protocol`, `kernel`, `mcp`, `cli`, and concurrency race / store-rebuild test suites.
- [ ] **M2 · MVP Workbench Loop**: Core execution loop, fix slices (`PaseoBackend` wiring, orchestrator, API/gate/SSE, `apps/web`), and non-destructive `kilnd` + live Paseo smoke tests passed; pending full 8-scenario real-machine E2E and Playwright (`<= 820px`) browser acceptance.
- [ ] **M3 · Desktop Menu Bar & Open-Source Release (In Progress)**: Landed the `apps/desktop` Tauri v2 skeleton (`cargo check`, `cargo test`, and pure-`std` `model.rs` tests passing; `tauri build` bundle and interactive GUI runtime pending), CI/Release workflows, POSIX installer, and Homebrew/npm templates; pending public package prep and Apple signing credentials.
- [ ] **M4 · Post-MVP Evolution**: Retrospectives, serialized multi-slice merge queue, execution swimlanes, Tailscale/Passkey push notifications, and Epic Loop.

---

## License

[Apache-2.0](LICENSE)
