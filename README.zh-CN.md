[English](README.md) | [简体中文](README.zh-CN.md)

# Kiln

> **Agents are fuel; the workflow is the engine.**
>
> 面向个人多项目与本机日常任务的本地优先（Local-First）自主开发工作台。后台按确定性协议与门禁自动推进，人只负责立项契约与关键红线拍板。

---

## 核心设计理念

1. **零 Token 确定性内核（Deterministic Kernel）**：调度、SQLite 租约抢占、可改范围校验、冻结测试哈希核对与验收命令重跑全部由常驻纯代码守护进程（`kilnd`）执行，不让多 Agent 互相套娃聊天空耗额度。
2. **只认硬门禁，不信自述（Verify, Never Trust）**：执行者提交回执后，必须在隔离环境通过真实 `accept_cmd` 与异构模型独立审查（Reviewer 自动避开实施所用模型）；冻结测试文件被改动时强制升轨审查。
3. **耗材化底座与模型（Swappable Agents & Backends）**：通过自有 `ExecutionBackend` 窄接口包装底层执行底座（V1 统一采用 Paseo TS SDK，随 Paseo 演进平滑覆盖 Codex / Pi / `agy acp`），7 类角色在设置页随时热换 Agent 与模型，工作流与决策账本（Ledger）永久留在本地 `~/.kiln/`。
4. **全场景四工作区隔离**：原生支持代码仓库（`git_worktree` + APFS 写时复制）、本机配置修改（`host_scoped` 两阶段沙盒暂存 + 路径锁 + SHA256 防覆盖回滚）、无项目调研（`scratch_dir`）与外部协作跟进（`external_only`）。
5. **一核多端驻守形态**：单一本地守护进程（默认 `127.0.0.1:4310`）同时驱动桌面/手机自适应 Web 看板、`kiln` / `kl` CLI、受限 MCP 工具桥（`kiln-mcp`）以及规划中的 macOS 顶部菜单栏原生外壳；所有消耗统一按官方 API 标价透明折算。

---

## 仓库结构

| 路径 | 说明 |
| :--- | :--- |
| [`packages/protocol`](packages/protocol/package.json) | **纯数据契约层**：全链路 Zod Schema、`card.yaml` / 回执 / 配置解析、标价费用公式与浏览器入口（`@kiln/protocol/web`） |
| [`packages/kernel`](packages/kernel/package.json) | **`kilnd` 守护进程核心**：状态机、调度器、验真门禁、可重建存储、HTTP+SSE 与执行底座抽象 |
| [`packages/mcp`](packages/mcp/package.json) | **`kiln-mcp` 工具服务**：受限 `stdio` MCP 服务，通过 `0600` Unix Socket 与 `KILN_RUN_TOKEN` 调用 `kilnd` |
| [`packages/cli`](packages/cli/package.json) | **`kiln` / `kl` CLI**：守护进程启停、状态查询、草稿/审批命令、环境自检及系统服务管理 |
| [`apps/web`](apps/web/package.json) | **Web 工作台**：桌面与移动端（`<= 820px`）自适应 Preact 前端，编译产出至 `packages/kernel/public/` |
| [`apps/desktop`](apps/desktop/README.md) | **桌面菜单栏薄壳**：Tauri v2 托盘薄壳、按需销毁 `WKWebView` 窗口及零外部依赖 `model.rs` 核心 |
| [`scripts/`](scripts/install.sh) | **安装脚本与自测**：纯 POSIX [`install.sh`](scripts/install.sh) 与零依赖测试脚本 [`test-install.sh`](scripts/test-install.sh) |
| [`packaging/`](packaging/README.md) | **发版打包模板**：Homebrew [Formula](packaging/homebrew/kiln.rb)、[Cask](packaging/homebrew/kiln-app.rb) 与发版前核对清单 |
| [`.github/workflows/`](.github/workflows/ci.yml) | **CI/Release 工作流**：跨平台 [`ci.yml`](.github/workflows/ci.yml)（`ubuntu-latest` / `macos-latest`）与 [`release.yml`](.github/workflows/release.yml) |

---

## 安装方式

> **发版前置说明**：仓库内部库仍标记 `"private": true`，`packages/cli` 现以 **`0.0.1`** 作为首个预发布验证版（**`0.1.0`** 预留给首个正式对外发布版本）。下方公开分发渠道将在对应版本推包与 Release 完成后激活（详见 [`packaging/README.md`](packaging/README.md)）；当前也可通过[源码构建与验证](#源码构建与验证)本地安装。

### 1. 一键安装脚本（macOS / Linux）

依赖 **Node.js `>= 22.0.0`** 与 **npm**；绝不篡改 `~/.zshrc` / `~/.bashrc`，也绝不静默注册开机自启服务：

```sh
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh
```

常用参数（详见 [`scripts/install.sh`](scripts/install.sh)）：

```sh
# 仅预览将执行的 npm 命令与配置，不落盘修改
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --dry-run

# 指定版本与自定义安装前缀
curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --version 0.0.1 --prefix "$HOME/.local"
```

### 2. npm 全局安装

```sh
npm install -g @zzf2333/kiln
```

### 3. Homebrew Tap（macOS / Linux）

```sh
# CLI（提供 kiln / kl 命令）
brew install zzf2333/tap/kiln

# macOS 顶部菜单栏应用（随 M3 签名公证后发布）
brew install --cask zzf2333/tap/kiln-app
```

### 源码构建与验证

> 环境要求：`Node >= 22.0.0`、`pnpm >= 9.0.0`

```sh
pnpm install       # 安装 Monorepo 全部工作区依赖
pnpm build         # 构建所有子包（含 apps/web 产物写入 packages/kernel/public/）
pnpm typecheck     # 全仓 TypeScript 类型检查
pnpm test          # 运行全部非 Socket 单元测试与集成测试
pnpm test:socket   # 运行 Unix Socket / 回环 TCP 连通冒烟测试
```

本地验证安装脚本、Homebrew 模板与桌面核心单测：

```sh
sh -n scripts/install.sh && sh scripts/test-install.sh
ruby -c packaging/homebrew/kiln.rb && ruby -c packaging/homebrew/kiln-app.rb
rustc -D warnings --test apps/desktop/src-tauri/src/model.rs -o /tmp/kiln-desktop-model-test && /tmp/kiln-desktop-model-test && rm -f /tmp/kiln-desktop-model-test
```

---

## 快速开始

```sh
kiln doctor                     # 检查 Node >= 22、Git、APFS 克隆、kilnd、Paseo 与服务状态
kiln up                         # 幂等启动本地后台守护进程 kilnd（默认 127.0.0.1:4310，默认注册 PaseoBackend）
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
| `kiln draft "<idea>" [--id <id>] [--space <id>] [--priority <P0\|P1\|P2\|P3>] [--track <L1\|L2>] [--mode <git_worktree\|host_scoped\|scratch_dir>] [--port <port>] [--host <host>]` | 创建任务草稿卡 |
| `kiln decide [task-id] [--option <id>] [--decision <id>] [--rationale <text>] [--apply-ledger] [--port <port>] [--host <host>]` | 列出或提交待决人工拍板 |
| `kiln doctor [--port <port>] [--host <host>] [--json]` | 检查 Node、Git、APFS 克隆能力、`kilnd` 连通性、Paseo Agent 发现（非必填项）与服务状态 |
| `kiln service <install\|uninstall\|status> [--platform <darwin\|linux>] [--label <label>] [--service-name <name>]` | 显式安装、卸载或查询操作系统自启服务 |
| `kiln uninstall [--purge-data] [--platform <darwin\|linux>]` | 停止守护进程、清理服务并检测残余 worktree（加 `--purge-data` 删除 `~/.kiln`） |
| `kiln -h, --help` / `kiln -v, --version` / `kiln help` | 显示帮助或 CLI 版本号（`0.0.1`） |

---

## 实施路线图

- [x] **M0 · 技术探针验证**：已完成底层 Agent 能力、权限策略与用量格式实测锁定。
- [x] **M1 · 协议与无头内核**：完成 `packages/protocol`、`kernel`、`mcp`、`cli` 与并发竞态 / 删库重建测试集。
- [x] **M2 · MVP 工作台闭环**：已通过基于真实 Paseo（`codex` + `pi`）、真实独立 `stdio kiln-mcp` 与 Playwright Chrome 桌面端（`1440×900`）/ 移动端（`390×844` `<= 820px`）的 `S1`–`S8` 全部 8 场景真机端到端复验收与删库重建 100% 一致校验。
- [ ] **M3 · 桌面常驻与开源发布（进行中）**：已合入 `apps/desktop` Tauri v2 骨架（`cargo check`、`cargo test`、`cargo build --release` 与纯 `std` 核心单测均已通过，`tauri build` `.app`/`.dmg` 打包与 GUI 真机运行待验证）、CI/Release 工作流、POSIX 安装脚本、对齐 `io.kiln.desktop` 的 Homebrew/npm 模板，并完成 `@zzf2333/kiln` 独立公开 npm 打包与隔离 `npm install -g` 实测（当前切为 `0.0.1` 初始预发布版，预留 `0.1.0` 作为首个正式对外版本）；待 `v0.0.1` 发布与 macOS `.dmg` 签名公证。
- [ ] **M4 · Post-MVP 演进**：复盘模块、多切片串行合并队列、执行台泳道、Tailscale/Passkey 推送与大需求循环（Epic Loop）。

---

## License

[Apache-2.0](LICENSE)
