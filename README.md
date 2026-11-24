[English](README.md) | [简体中文](README.zh-CN.md)

# Kiln

> **Agents are fuel; the workflow is the engine.**
>
> **A local-first, multi-agent, multi-subscription workflow orchestration and autonomous Kanban workbench.**
> Wire the AI CLIs and model subscriptions you already pay for into a single deterministic pipeline—Kiln runs the board, verifies outputs against real gates in the background, and only interrupts you for scoping, approvals, and real acceptance.

---

## Why Kiln?

Most AI coding tools trap you inside a "one conversation window, one manually picked agent + model" loop. If you hold subscriptions across Codex, Claude, Gemini, Pi, OpenCode, or Antigravity (`agy`), each tool shines at a different step—Kiln orchestrates them together:

| Dimension                        | Single-Session AI Terminals                                                       | **Kiln**                                                                                                                                                                                          |
| :------------------------------- | :-------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Core Metaphor**                | **Multi-tab chat console**: you babysit one thread and repeat rules on every task | **Multi-agent, multi-subscription delivery workbench**: confirm the goal once and let the Kanban kernel drive stages to delivery                                                                  |
| **Subscription Utilization**     | Subscriptions sit in separate windows; hitting a rate limit stalls your flow      | **17-role Roster Lineup + PM assignment**: match specialists to stages (recon, architecture, main dev, fast fix, heterogeneous review, acceptance, retro) with automatic fallback chains on `429` |
| **Workflow Rigor**               | Relies on prompts and manual vigilance                                            | **Deterministic kernel + hard gates**: single-transaction stage leases, scope checks, frozen-test tampering escalation, `accept_cmd` re-runs, and advisor authority guardrails                    |
| **Anti-Drift & Cost Efficiency** | Long threads re-ingest full context and burn tokens on repeated rework            | **4-layer prefix-stable caching + cognitive tiering**: warm `implement` session reuse, cheap recon + `fast_fix` before `main_dev` escalation, and independent cold review                         |
| **Runtime Coupling**             | Locked to one vendor wrapper or external daemon                                   | **Open `CompositeBackend`**: built-in standard ACP core + direct adapters for `codex app-server`, `pi --mode rpc`, and `claude stream-json`                                                       |

---

## Key Features & Capabilities

### 1. Open Multi-CLI Adapters & 17-Role Roster Lineup

- **`CompositeBackend` Adapter Matrix**: Supports standard ACP (`agy acp`, `gemini --experimental-acp`, `opencode acp`, `claude-agent-acp`, `codex-acp`, and custom `--acp` binaries) alongside direct native adapters (`codex app-server`, `pi --mode rpc`, `claude stream-json`), with optional Paseo compatibility. Read-only roles enforce permission downscoping plus kernel worktree tamper guards.
- **Single Roster Pool + PM On-Demand Assignment**: Ships with **17 built-in roles** (9 core: `pm`, `researcher`, `architect`, `advisor`, `main_dev`, `fast_fix`, `reviewer`, `verifier`, `retro`; 4 specialists: `frontend_ui`, `debugger`, `ops_sec`, `doc_writer`; 4 kernel helpers: `tester`, `deliverer`, `triage`, `resolver`; plus custom roles). `pm` reads only enabled roles, inspects live cooldowns, picks the right subset with a clear rationale, and lets you confirm in one glance.

### 2. Prompt-Cache Maximization & Cognitive Tiering

- **4-Layer Prefix-Stable `HANDOFF.md`**: Orders sections strictly from least volatile to most volatile (static rules/templates → space ledger → frozen contract & `BRIEF`/`PLAN` → dynamic run tail) with per-stage progressive projection to limit context rot.
- **Warm `implement` Session Pool (`WarmSessionPool`)**: Rework after gate or review failures resumes via `backend.send()` with incremental diffs only; automatically forces a fresh cold start at `>= 60%` context usage, `>= 3` consecutive reuses, or `>= 2` identical gate failure fingerprints. `reviewer`, `verifier`, `advisor`, `research`, and `plan` always run cold.
- **Cognitive Tiering & Heterogeneous Review**: Uses economical recon (`researcher`) before planning (`advisor`/`architect`), starts well-planned implementations on `fast_fix` with automatic escalation to `main_dev`, and avoids the same model family used for `implement` / `plan` during `review`.

### 3. Deterministic Kernel, Real Acceptance & Unattended Resilience

- **Composable Blueprints & Four Workspace Modes**: Built-in `quick`, `host_op`, `standard_dev`, and `full_delivery` presets plus `custom` blueprints across `git_worktree` (APFS copy-on-write), `host_scoped` (two-phase `staged/` with single human approval, SHA-256 verification & rollback), `scratch_dir`, and `external_only`.
- **Managed `accept_entry` Environments & Visual Evidence Gates**: Spawns isolated single/multi-process test environments inside the worktree with dynamic ports, transparent observer proxies, and magic-byte/screenshot evidence validation—without bundling a browser driver inside Kiln.
- **Anti-Drift Task Details & Implicit Checkpoints**: Every step displays an `Input → Alignment Summary → Output` timeline, 4 deterministic gate lights, `Agent · Session` badges, and a local one-click **`Open Native TUI`** launcher (`codex resume`, `pi --session`, `claude --resume`, `opencode --session`). Write stages automatically record hidden Git refs (`refs/kiln/checkpoints/...`) for one-click rollback.
- **Unattended Operations & Post-Task `RETRO`**: Includes a **Witness** stall watchdog, **Refinery** serial merge queue, streaming project script drawer (`setup`/`dev`/`test`/`lint`/`deliver`) with local port detection, one-click GitHub Issue import + on-demand PR CI/review feedback loops, structured review defect checklists, and a bounded **RETRO** learning engine (`MAX_ACTIVE_LEDGER_INJECT = 20`) with human-approved, rollback-safe proposals.

### 4. 5-Field Orthogonal Billing, USD Budget Circuit Breakers & Honest Quotas

- **Orthogonal `RunUsage` V2**: Separately accounts for `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, and `reasoningTokens`, computing **net cache savings after write premiums**. Live context-window meters (`usage_update`) stay strictly isolated from billing tables.
- **Zero-Config Pricing Sync & USD Limits**: Automatically syncs 5-field rates and context limits from `~/.pi/agent/models.json`, `models.dev`, and `LiteLLM`; enforces per-task and daily/monthly USD soft warnings & hard pauses; displays official quota bars only where providers natively expose them (`codex`) and local usage elsewhere without fabricating progress bars.

### 5. Local-First Multi-Surface Delivery & Tunnel-Agnostic Remote Access

- **Electron Desktop · Standalone CLI · Responsive PWA**: One `kilnd` daemon powers an **Electron tray app** (destroys `BrowserWindow` on close to free renderer RAM; `Cmd/Ctrl+Shift+K` quick toggle), a zero-dependency single-binary CLI, and a Graphite + Kiln Copper light/dark Web workbench (`<= 820px` mobile PWA ready).
- **Fail-Closed Dual-Port Remote Access**: Local `127.0.0.1:4310` validates loopback `Host`/`Origin` and rejects reverse-proxy headers (`403 remote_port_required`); remote `127.0.0.1:4311` is off by default and enforces `HttpOnly` `kiln_session` cookies even on loopback (`tailscale serve`, Cloudflare Tunnel, or HTTPS reverse proxies), with `#pair=` QR onboarding, instant SSE revocation, Bark/ntfy/Webhook P0/P1 push, and AC-only sleep prevention.

---

## Installation

> **Pre-release Notice**: Current manifests target pre-release **`0.0.5`** (which includes full V3 multi-CLI orchestration plus `v0.0.6` `Vite+` / `TypeScript 7` / Electron E1 runtime migration; **`0.1.0`** is reserved for the first signed & notarized public release). Release binaries and installers activate when a corresponding GitHub Release tag is published; until then, you can build or package locally from source.

### 1. Electron Desktop App (macOS `.dmg` / Windows NSIS `.exe`, Zero Prerequisites)

Download the platform desktop installer from GitHub Releases. Using Electron Scheme E1 (`ELECTRON_RUN_AS_NODE=1`), it runs the bundled `kiln-runtime/{kiln-cli.mjs,kiln-mcp.mjs,public/}` via Electron's built-in Node—no Node.js or Bun installation required, with a tray action to install `kiln` / `kl` terminal wrappers:

- **macOS**: `Kiln-v<ver>-darwin-arm64.dmg` / `Kiln-v<ver>-darwin-x64.dmg`
- **Windows x64**: `Kiln-v<ver>-windows-x64-setup.exe` (current-user NSIS installer, zero UAC)

### 2. Zero-Dependency Standalone CLI Scripts

- **macOS / Linux**: Verifies `SHA256SUMS` from GitHub Releases and installs `kiln` + `kl` into `~/.local/bin` (never modifies shell profiles or auto-start entries):
  ```sh
  curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh
  # Preview planned URLs and checksums without writing files:
  curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --dry-run
  ```
- **Windows x64 (PowerShell, no UAC)**: Installs `kiln.exe` and `kl.cmd` into `%LOCALAPPDATA%\Kiln\bin`:
  ```powershell
  irm https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.ps1 | iex
  ```

### 3. Homebrew Tap (macOS / Linux)

```sh
brew install zzf2333/tap/kiln            # Standalone CLI binary (kiln / kl)
brew install --cask zzf2333/tap/kiln-app # macOS menu bar app (once signed & notarized DMG is published)
```

### 4. Build from Source

> Requirements: `Node >= 22.0.0`, `pnpm >= 9.0.0` (add `Bun >= 1.4` only if compiling standalone CLI binaries).

```sh
pnpm install       # Install monorepo dependencies (zero C++ native builds)
pnpm check         # Oxfmt format check + Oxlint (typeAware/typeCheck) + tsrs
pnpm build         # Build all packages, Web UI, and Electron runtime/
pnpm typecheck     # Workspace-wide TypeScript 7 type checking
pnpm test          # Run 53 non-socket unit/integration test suites (430 tests)
pnpm test:socket   # Run 4 real UDS / dual-port / accept_entry smoke suites (9 tests)
```

Optional packaging & template validation:

```sh
pnpm build:binary -- --target host                                        # Compile host standalone CLI binary
pnpm --filter @kiln/desktop dev                                           # Launch local Electron desktop dev build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @kiln/desktop pack:mac    # Package unsigned macOS .dmg (run pnpm build first)
pnpm --filter @kiln/desktop pack:win                                      # Package Windows user-level NSIS .exe
sh -n scripts/install.sh && sh scripts/test-install.sh                    # Validate POSIX installer checks
ruby -c packaging/homebrew/Formula/kiln.rb && ruby -c packaging/homebrew/Casks/kiln-app.rb
```

---

## Quick Start & Daily Workflow

### Up and Running in 5 Minutes

1. **Start Kiln**: Launch `Kiln.app` (`Cmd/Ctrl+Shift+K` toggles the window from the tray), or run in your terminal:
   ```sh
   kiln doctor       # Verify Node, Git, APFS clone support, kilnd, and local CLI/ACP providers
   kiln up           # Start local kilnd daemon (127.0.0.1:4310)
   kiln space add .  # Auto-detect the current Git repo, scripts, and accept command
   kiln open         # Open the Web workbench in your default browser
   ```
2. **Configure Providers & Lineup**:
   - Visit **Settings → Providers** to inspect auto-detected CLIs (`codex`, `pi`, `agy`, `claude`, `gemini`, `opencode`) and add custom models or env overrides;
   - Visit **Lineup** to assign primary + `[1 → 2 → 3]` fallback subscriptions per role.
3. **Create a Task & Let the Board Run**:
   - Press `N` in the UI to open **New Task**, paste error screenshots, or import a **GitHub Issue** in one click; `pm` explores read-only first, narrows edge cases, assigns the best roles from the roster with a rationale, or splits into dependency-linked cards;
   - Once started, track progress across the 4-column **Board** and inspect `BRIEF.md`, `PLAN.md`, step-by-step `Input → Summary → Output`, gate lights, checkpoint rollbacks, and **`Open Native TUI`** in task details.
4. **Control Remotely from Mobile**:
   ```sh
   kiln remote enable --keep-awake-ac --public-url https://your-tailnet.ts.net
   tailscale serve --bg http://127.0.0.1:4311
   kiln remote pair   # Generates a one-time pairing code & #pair= link for mobile PWA
   ```

### CLI Command Reference (`kiln` / `kl`)

| Command                                                                                                                                 | Description                                                                                                  |
| :-------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `kiln up [--port <port>] [--host <host>] [--foreground] [--kiln-home <dir>] [--paseo-url <url>] [--no-paseo]`                           | Idempotently start the `kilnd` daemon                                                                        |
| `kiln down`                                                                                                                             | Gracefully stop the managed `kilnd` daemon via local IPC `POST /rpc/shutdown`                                |
| `kiln open [--port <port>] [--host <host>]`                                                                                             | Open the Kiln Web workbench in your default browser                                                          |
| `kiln status [--port <port>] [--host <host>] [--json]`                                                                                  | Print active tasks, pending decisions, drafts, and usage snapshot                                            |
| `kiln space <list\|add [path]\|rm <id>> [...]`                                                                                          | List, auto-detect & register, or remove project spaces                                                       |
| `kiln draft "<idea>" [--space <id>] [--priority <P0\|P1\|P2\|P3>] [--track <L1\|L2>] [--mode <git_worktree\|host_scoped\|scratch_dir>]` | Quickly drop a draft task card from the terminal                                                             |
| `kiln decide [task-id] [--option <id>] [--decision <id>] [--rationale <text>] [--apply-ledger]`                                         | List or submit pending human decisions                                                                       |
| `kiln remote <status\|enable\|disable\|pair\|devices\|revoke\|tailscale> [...]`                                                         | Manage the `:4311` remote port, pairing tokens, devices, and revocation                                      |
| `kiln doctor [--json]`                                                                                                                  | Inspect runtime, Git/APFS, discovered Agents, and daemon/service health                                      |
| `kiln service <install\|uninstall\|status>`                                                                                             | Explicitly install or remove user-level OS login service (`LaunchAgent` / `systemd --user` / `HKCU\...\Run`) |
| `kiln uninstall [--purge-data]`                                                                                                         | Stop `kilnd`, remove OS startup entry, inspect worktrees (keeps `~/.kiln` unless `--purge-data`)             |
| `kiln -h, --help` / `kiln -v, --version`                                                                                                | Show CLI help or version (`0.0.5`)                                                                           |

---

## Repository Structure & Local Safety

| Path                                                  | Description                                                                                                                                                                                                                                        |
| :---------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/protocol`](packages/protocol/package.json) | **Pure Data Contracts**: End-to-end Zod schemas, 17-role roster definitions, composable blueprints, 5-field pricing, and `@kiln/protocol/web`                                                                                                      |
| [`packages/kernel`](packages/kernel/package.json)     | **`kilnd` Daemon Core**: State machine, TTL-affinity scheduler, verification gates & `accept_entry`, dual built-in SQLite adapter, `CompositeBackend`, dual-port Hono HTTP/SSE, `RETRO` / budget / Witness / Refinery / GitHub bridge & `open-tui` |
| [`packages/mcp`](packages/mcp/package.json)           | **`kiln-mcp` Tool Server**: Role-restricted 7-tool `stdio` MCP server (`kiln __mcp` in compiled CLI / `kiln-mcp.mjs` in Electron)                                                                                                                  |
| [`packages/cli`](packages/cli/package.json)           | **`kiln` / `kl` CLI**: Daemon lifecycle, space/draft/decision/remote workflows, diagnostics, and opt-in OS services                                                                                                                                |
| [`apps/web`](apps/web/package.json)                   | **Web & PWA Workbench**: React 19 + Tailwind CSS v4 + Radix UI across 10 views and `<= 820px` mobile layouts, built to `packages/kernel/public/`                                                                                                   |
| [`apps/desktop`](apps/desktop/README.md)              | **Electron Desktop Shell**: Tray residency, on-demand `BrowserWindow` lifecycle, Scheme E1 built-in Node runtime, and `electron-builder` packaging                                                                                                 |
| [`scripts/`](scripts/install.sh)                      | **Installers & Probes**: [`build-binary.mjs`](scripts/build-binary.mjs), POSIX [`install.sh`](scripts/install.sh), Windows [`install.ps1`](scripts/install.ps1), and verification probes                                                           |
| [`packaging/`](packaging/README.md)                   | **Release Templates**: Homebrew Formula/Cask templates and release checklist                                                                                                                                                                       |
| [`.github/workflows/`](.github/workflows/ci.yml)      | **3-OS Automation**: Linux / macOS / Windows CI (including `pnpm lint` & `pnpm fmt:check`) and Release workflows                                                                                                                                   |

**Local Safety Guarantees**: `~/.kiln/` files are the single source of truth (`index.sqlite` can be rebuilt cleanly from disk); installers never silently alter shell profiles or register startup items; `host_scoped` changes use two-phase staging with SHA-256 rollback protection; `:4311` remote access never exempts loopback connections from session auth.

---

## License

[Apache-2.0](LICENSE)
