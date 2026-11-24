[English](README.md) | [简体中文](README.zh-CN.md)

# Kiln

> **Agents are fuel; the workflow is the engine.**
>
> 面向个人多项目与本机日常任务的本地优先（Local-First）自主开发工作台。后台按确定性协议与门禁自动推进，人只负责立项契约与关键红线拍板。

---

## 核心设计理念

1. **零 Token 确定性内核（Deterministic Kernel）**：可组合工作流蓝图引擎（内置 `quick`、`host_op`、`standard_dev`、`full_delivery` 四套预设及自定义 `agent / gate / command / approval` 节点与有界 `loop` 环）、调度抢占、SQLite 租约锁、可改范围校验、冻结测试哈希核对、两阶段 `host_op`（`staged_only` + `staged_sha256` 校验与失败自动回滚）及验收命令重跑全部由常驻纯代码守护进程（`kilnd`）执行，不让多 Agent 互相套娃聊天空耗额度。
2. **只认硬门禁，不信自述（Verify, Never Trust）**：执行者提交回执后，必须在隔离环境通过真实 `accept_cmd` 与异构模型独立审查（Reviewer 自动避开实施所用模型）；冻结测试文件被改动时强制升轨审查。技术路线歧义与连续 `stuck_threshold` 同错停滞优先交由全新上下文顾问（`advisor`，产出 `PLAN.md` 并受四重防越权护栏约束），人类红线（扩范围、改契约、外部副作用）仍严格留给人工拍板。
3. **耗材化底座与模型（Swappable Agents & Backends）**：通过自有 `ExecutionBackend` 窄接口包装底层执行底座（V1 统一采用 Paseo TS SDK，随 Paseo 演进平滑覆盖 Codex / Pi / `agy acp`），7 类角色在设置页随时热换 Agent 与模型，工作流与决策账本（Ledger）永久留在本地 `~/.kiln/`。
4. **全场景四工作区隔离**：原生支持代码仓库（`git_worktree` + APFS 写时复制）、本机配置修改（`host_scoped` 两阶段沙盒暂存 + 路径锁 + SHA256 防覆盖回滚）、无项目调研（`scratch_dir`）与外部协作跟进（`external_only`）。
5. **一核多端驻守形态**：单一零依赖本地守护进程（默认本地 `127.0.0.1:4310`，可选默认关闭的认证远程口 `127.0.0.1:4311`）同时驱动内嵌 Web 工作台（桌面 + 移动端 PWA，详情页提供 `Agent · Session` 输入/输出总览卡片及仅本机 `:4310` 可用的原生 TUI 跳转 `codex resume` / `pi --session` / `claude --resume` / `opencode --session`，`:4311` 远程端返 `403 local_only_endpoint`）、单文件 `kiln` / `kl` CLI、内置 MCP 工具桥（`kiln __mcp`）以及 macOS / Windows Tauri v2 Sidecar 托盘应用；所有消耗统一按官方 API 标价透明折算。

---

## 仓库结构

| 路径 | 说明 |
| :--- | :--- |
| [`packages/protocol`](packages/protocol/package.json) | **纯数据契约层**：全链路 Zod Schema、可组合工作流蓝图契约（`workflow-core.ts` / `workflow.ts`）、顾问决策结构、`card.yaml` / 回执 / 配置解析、标价费用公式与浏览器入口（`@kiln/protocol/web`） |
| [`packages/kernel`](packages/kernel/package.json) | **`kilnd` 守护进程核心**：可组合蓝图编排器与状态机、调度器、验真门禁与两阶段 `host_op` 暂存、零原生依赖 SQLite（`bun:sqlite` / `node:sqlite`）存储、双端口 HTTP+SSE、原生 TUI 启动器（`tui-launcher.ts`）、内嵌静态资源服务与执行底座抽象 |
| [`packages/mcp`](packages/mcp/package.json) | **`kiln-mcp` 工具服务**：受限 `stdio` MCP 服务（同时内置为 `kiln __mcp`），通过 POSIX `0600` Unix Socket 或 Windows Named Pipe + `KILN_RUN_TOKEN` 调用 `kilnd` |
| [`packages/cli`](packages/cli/package.json) | **`kiln` / `kl` CLI**：守护进程启停、状态查询、草稿/审批/空间/远程管理命令、环境自检及跨平台系统服务管理（macOS / Linux / Windows） |
| [`apps/web`](apps/web/package.json) | **Web 工作台**：桌面与移动端（`<= 820px`）自适应 React 19 + Tailwind CSS v4 + Radix UI 前端，编译产出至 `packages/kernel/public/` 并内嵌进单文件二进制 |
| [`apps/desktop`](apps/desktop/README.md) | **跨平台桌面托盘薄壳（macOS / Windows）**：Tauri v2 Sidecar 托盘壳（Windows `CREATE_NO_WINDOW` 无黑框、按需销毁 WebView、终端命令一键链接及纯 `std` `model.rs` 核心） |
| [`scripts/`](scripts/install.sh) | **零依赖安装脚本与单文件编译**：POSIX [`install.sh`](scripts/install.sh)、Windows [`install.ps1`](scripts/install.ps1)、[`test-install.sh`](scripts/test-install.sh) 与 Bun 单文件编译 [`build-binary.mjs`](scripts/build-binary.mjs) |
| [`packaging/`](packaging/README.md) | **发版打包模板**：预编译二进制 Homebrew [Formula](packaging/homebrew/Formula/kiln.rb)、macOS [Cask](packaging/homebrew/Casks/kiln-app.rb) 与发版核对清单 |
| [`.github/workflows/`](.github/workflows/ci.yml) | **CI/Release 工作流**：3-OS [`ci.yml`](.github/workflows/ci.yml)（`ubuntu-latest` / `macos-latest` / `windows-latest`）与 3-OS 单文件 + 桌面 Sidecar [`release.yml`](.github/workflows/release.yml) |

---

## 安装方式

> **发版前置说明**：当前预发布清单指向 **`0.0.5`**（**`0.1.0`** 预留给首个正式对外发布版本）。下方 GitHub Release 预编译二进制、桌面安装包与 Homebrew Tap 校验和将在对应 Release Tag 发布后激活（详见 [`packaging/README.md`](packaging/README.md)）；当前也可通过[源码构建与验证](#源码构建与验证)或 `pnpm build:binary` 本地编译单文件。

### 1. 一键安装脚本 — macOS / Linux（零 Node.js 依赖）

直接从 GitHub Releases 下载预编译单文件二进制并校验 `SHA256SUMS`，安装 `kiln` 及软链 `kl` 到 `~/.local/bin`；无需 Node.js / npm，绝不篡改 `~/.zshrc` / `~/.bashrc`，也绝不静默注册开机自启服务：

```sh
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh
```

常用参数（详见 [`scripts/install.sh`](scripts/install.sh)）：

```sh
# 仅预览下载 URL、校验计划与安装路径，不落盘修改
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --dry-run

# 指定版本与自定义安装前缀（安装至 <prefix>/bin）
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --version 0.1.0 --prefix "$HOME/.local"
```

### 2. 一键安装脚本 — Windows x64（零 Node.js / 免 UAC）

从 GitHub Releases 下载 `kiln-v<ver>-windows-x64.exe` 并经 `SHA256SUMS` 校验，安装 `kiln.exe` 与 `kl.cmd` 到 `%LOCALAPPDATA%\Kiln\bin`；无需管理员权限，不改注册表自启或 PowerShell `$PROFILE`：

```powershell
irm https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.ps1 | iex
```

演练 / 指定版本或前缀（详见 [`scripts/install.ps1`](scripts/install.ps1)）：

```powershell
./scripts/install.ps1 -DryRun -Version 0.1.0 -Prefix "$env:LOCALAPPDATA\Kiln"
```

### 3. 内置 Sidecar 桌面应用（macOS `.dmg` / Windows NSIS `.exe`）

从 GitHub Releases 下载桌面安装包（内置独立 `kiln` / `kiln.exe` Sidecar，免装 Node.js，托盘菜单内置「安装 kiln 终端命令」入口）：

- **macOS**：`Kiln-v<ver>-darwin-arm64.dmg` / `Kiln-v<ver>-darwin-x64.dmg`（公证后同步 Homebrew Cask）
- **Windows x64**：`Kiln-v<ver>-windows-x64-setup.exe`（当前用户级 NSIS 安装包，免 UAC，后台静默无黑框）

### 4. Homebrew Tap（macOS / Linux，零 Node.js 依赖）

```sh
# 预编译单文件 CLI（提供 kiln / kl 命令）
brew install zzf2333/tap/kiln

# macOS 顶部菜单栏应用（随签名公证 DMG 发布后启用）
brew install --cask zzf2333/tap/kiln-app
```

### 源码构建与验证

> 环境要求：`Node >= 22.0.0`、`pnpm >= 9.0.0`（单文件二进制编译需 `Bun >= 1.4`；桌面端打包需 `Rust / Cargo`）

```sh
pnpm install       # 安装 Monorepo 全部工作区依赖
pnpm build         # 构建所有子包（含 apps/web 产物写入 packages/kernel/public/）
pnpm typecheck     # 全仓 TypeScript 类型检查
pnpm test          # 运行全部非 Socket 单元测试与集成测试
pnpm test:socket   # 运行 Unix Socket / Named Pipe 与回环 TCP 连通冒烟测试
pnpm build:binary -- --target host   # 编译内嵌 Web UI 的单文件二进制
```

本地验证安装脚本、Homebrew 模板与桌面端单测：

```sh
sh -n scripts/install.sh && sh scripts/test-install.sh
ruby -c packaging/homebrew/Formula/kiln.rb && ruby -c packaging/homebrew/Casks/kiln-app.rb
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
rustc -D warnings --test apps/desktop/src-tauri/src/model.rs -o /tmp/kiln-desktop-model-test && /tmp/kiln-desktop-model-test && rm -f /tmp/kiln-desktop-model-test
```

---

## 快速开始

```sh
kiln doctor                     # 检查 Node >= 22、Git、APFS 克隆、kilnd、Paseo 与服务状态
kiln up                         # 幂等启动本地后台守护进程 kilnd（默认 127.0.0.1:4310，默认注册 PaseoBackend）
kiln space add .                # 将当前目录 Git 仓库识别并登记为项目空间
kiln open                       # 在默认浏览器打开 Web 工作台
kiln draft "接入 OAuth PKCE"     # 创建任务草稿卡
kiln status                     # 查看任务列表、运行计数、待决拍板、草稿与用量
kiln decide                     # 查看或提交待决人工拍板
kiln down                       # 停止托管的 kilnd 守护进程
```

可选显式开机自启与干净卸载：

```sh
kiln service install            # 显式注册 macOS LaunchAgent 或 Linux systemd 用户服务
kiln service status             # 查看系统服务注册状态
kiln uninstall                  # 停止守护进程、移除系统服务并巡检 worktree（默认保留 ~/.kiln）
```

---

## CLI 命令参考（`kiln` / `kl`）

| 命令 | 说明 |
| :--- | :--- |
| `kiln up [--port <port>] [--host <host>] [--foreground] [--paseo-url <url>] [--no-paseo]` | 幂等启动 `kilnd`（默认 `127.0.0.1:4310` 并注册 `PaseoBackend`；可用 `--paseo-url`/`PASEO_URL`/`PASEO_PASSWORD` 覆盖，或 `--no-paseo`/`KILN_DISABLE_PASEO=1` 禁用；`--foreground` 前台运行） |
| `kiln down` | 停止托管的 `kilnd` 守护进程 |
| `kiln open [--port <port>] [--host <host>]` | 在系统默认浏览器打开 Kiln Web 工作台 |
| `kiln status [--port <port>] [--host <host>] [--json]` | 输出任务状态、运行数、待决拍板、草稿与用量快照 |
| `kiln space <list\|add [path]\|rm <id>> [--id <id>] [--name <name>] [--branch <branch>] [--accept-cmd <cmd>] [--copy-untracked <csv>] [--clone-deps <csv>] [--port <port>] [--host <host>] [--json]` | 列出项目空间、自动探测并登记本地 Git 仓库（`add` 默认当前目录），或删除无活跃任务的空间 |
| `kiln draft "<idea>" [--id <id>] [--space <id>] [--priority <P0\|P1\|P2\|P3>] [--track <L1\|L2>] [--mode <git_worktree\|host_scoped\|scratch_dir>] [--port <port>] [--host <host>]` | 创建任务草稿卡 |
| `kiln decide [task-id] [--option <id>] [--decision <id>] [--rationale <text>] [--apply-ledger] [--port <port>] [--host <host>]` | 列出或提交待决人工拍板 |
| `kiln remote <status\|enable\|disable\|pair\|devices\|revoke\|tailscale> [...]` | 管理 `:4311` 远程访问开关、一次性配对码/链接、已配对设备、即时吊销与 Tailscale 状态 |
| `kiln doctor [--port <port>] [--host <host>] [--json]` | 检查 Node、Git、APFS 克隆能力、`kilnd` 连通性、Paseo Agent 发现（非必填项）与服务状态 |
| `kiln service <install\|uninstall\|status> [--platform <darwin\|linux>] [--label <label>] [--service-name <name>]` | 显式安装、卸载或查询操作系统自启服务 |
| `kiln uninstall [--purge-data] [--platform <darwin\|linux>]` | 停止守护进程、清理服务并检测残余 worktree（加 `--purge-data` 删除 `~/.kiln`） |
| `kiln -h, --help` / `kiln -v, --version` / `kiln help` | 显示帮助或 CLI 版本号（`0.0.5`） |

---

## 实施路线图

- [x] **M0 · 技术探针验证**：已完成底层 Agent 能力、权限策略与用量格式实测锁定。
- [x] **M1 · 协议与无头内核**：完成 `packages/protocol`、`kernel`、`mcp`、`cli` 与并发竞态 / 删库重建测试集。
- [x] **M2 · MVP 工作台闭环**：已通过基于真实 Paseo（`codex` + `pi`）、真实独立 `stdio kiln-mcp` 与 Playwright Chrome 桌面端（`1440×900`）/ 移动端（`390×844` `<= 820px`）的 `S1`–`S8` 全部 8 场景真机端到端复验收与删库重建 100% 一致校验。
- [ ] **M3 / M3.5 · 桌面 Sidecar、零依赖分发与远程移动访问 V1（进行中）**：已完成零原生内置 SQLite（`bun:sqlite` / `node:sqlite`）、`kiln __mcp` 与内嵌 Web/PWA 的单文件分发、macOS `.dmg` / Windows NSIS `.exe` Tauri v2 Sidecar 打包、双端口 Fail-Closed 远程移动访问（`:4310` 本地 / `:4311` 认证）、Bark/ntfy/Webhook 推送与三端 CI/Release 流水线（`0.0.5` 预发布落地 `CompositeBackend` 多 CLI / ACP 适配与 16 角色「编排阵容」中心、5 字段正交用量与 USD 预算熔断、Prefix Cache 分层与 `implement` 热会话复用、探索→方案→廉价执行自动升档→双重异构审查、多进程 `accept_entry` 真实验收证据门禁、任务后 `RETRO` 复盘进化飞轮、GitHub Issue/PR 闭环、Witness 停滞巡检、Refinery 串行合并队列、脚本端口探测及结构化审查缺陷清单；`0.1.0` 预留给签名公证后的首个正式对外版本）。
- [ ] **M4 · Post-MVP 演进**：`parallel` 节点内并行与子流编排、执行台泳道、跨节点远程 `kilnd` 聚合、多模型 A/B 对比出稿、Passkey/Face ID 推送及大需求循环（Epic Loop）。

---

## License

[Apache-2.0](LICENSE)
