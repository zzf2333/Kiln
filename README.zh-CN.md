[English](README.md) | [简体中文](README.zh-CN.md)

# Kiln

> **Agents are fuel; the workflow is the engine.**
>
> **面向多 Agent · 多订阅开发者的本地优先（Local-First）流程编排与看板自动推进工作台。**
> 把你手里的多种 AI Agent 与模型订阅一次编排进最适合自己的开发流水线，由确定性内核按契约与硬门禁后台自动推进，人只负责配好阵容、定目标拍板与查看真实验收。

---

## 为什么选择 Kiln？

大多数 AI 编码工具把工作模式框在「人开一个对话窗口、手选一个 Agent + 一个模型从头聊到尾」。当你同时拥有 Codex、Claude、Gemini、Pi、OpenCode 或 Antigravity（`agy`）等多份订阅时，不同订阅在不同阶段各有所长——Kiln 把它们整合成一条协同流水线：

| 维度             | 传统单会话 AI 终端                                         | **Kiln**                                                                                                                   |
| :--------------- | :--------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| **工作隐喻**     | **多窗口会话控制台**：每个任务都要人盯着过程并反复提醒规矩 | **多 Agent · 多订阅自动化交付工作台**：立项确认后，看板后台按蓝图全自动推进到交付                                          |
| **订阅利用**     | 多个订阅互相孤立，额度分布不均、限流时只能人工切窗口       | **17 角色常备阵容池 + PM 点将**：按擅长分工（研究/架构/主力开发/快修/异构审查/真实验收/复盘），遇 `429` 自动切备选订阅接棒 |
| **流程纪律**     | 靠提示词祈祷模型自觉，换个任务重来一遍                     | **确定性内核 + 硬门禁**：单事务租约、可改范围校验、冻结测试防篡改升轨、`accept_cmd` 重跑与顾问防越权护栏                   |
| **防跑偏与省钱** | 动辄长会话反复重吃上下文、反复返工烧额度                   | **4 层前缀稳定缓存 + 认知分级**：`implement` 热会话续跑、低成本侦察 + `fast_fix` 试跑遇阻再升档、异构高智商审查            |
| **底层接入**     | 强绑定单一闭源客户端或第三方守护进程                       | **开放 `CompositeBackend`**：自建标准 ACP 核心 + `codex app-server` / `pi --mode rpc` / `claude stream-json` 直连          |

---

## 核心特色与产品能力

### 1. 多 CLI 开放接入与 17 角色常备阵容池

- **`CompositeBackend` 开放适配矩阵**：同时覆盖标准 ACP（`agy acp`、`gemini --experimental-acp`、`opencode acp`、`claude-agent-acp`、`codex-acp`、任意自定义 `--acp`）与原生直连（`codex app-server`、`pi --mode rpc`、`claude stream-json`），并向后兼容 Paseo；只读角色在底层会权限降级并叠加内核工作树防篡改兜底。
- **单一阵容池 + PM 自主点将**：内置 **17 名常备角色**（9 核心：`立项 PM`、`调研侦察`、`架构方案`、`技术顾问`、`主力开发`、`快修开发`、`异构审查`、`真实验收`、`任务复盘`；4 专长：`前端视觉精修`、`疑难排障专家`、`本机运维安全`、`文档变更同步`；4 内核协同：`独立测试`、`合并交付`、`异常研判`、`讨论对话`，另支持自定义专长）。PM 根据任务复杂度与实时限流冷却，按需点将并给出排兵理由；人一眼确认或微调单棒即可开工。

### 2. 缓存最大化与认知分级省钱引擎

- **4 层前缀稳定 `HANDOFF.md`**：按变更频率由低到高分层（静态规则/模板 → 空间账本 → 冻结契约与定稿 `BRIEF`/`PLAN` → 本轮动态尾巴），配合按阶段渐进投影减少上下文腐烂。
- **`implement` 热会话复用（`WarmSessionPool`）**：同任务门禁/审查返工优先经 `backend.send()` 续用原会话仅喂增量，命中高上下文水位（`>= 60%`）、连续复用上限（`>= 3`）或同错指纹时自动冷重启清脑；审查/验收/顾问保持强制全新冷启动。
- **认知分级与异构防撞**：先用低成本侦察补齐代码地图，有定稿 `PLAN.md` 时首选 `fast_fix` 试跑、受阻自动升档 `main_dev`；启用异构审查时优先同时避开实施与方案模型家族。

### 3. 确定性内核、真实验收与无人值守闭环

- **可组合蓝图与四工作区隔离**：内置 `quick`、`host_op`、`standard_dev`、`full_delivery` 四套预设及自定义蓝图，覆盖 `git_worktree`（APFS 克隆）、`host_scoped`（两阶段 `staged/` 暂存 + 单次人类审批 + SHA256 防篡改与失败回滚）、`scratch_dir` 与 `external_only`。
- **真实验收环境托管与防假门禁**：支持在隔离工作树内按需拉起单/多进程被测服务（`accept_entry` + 动态端口互连 + 流量代理观测 + 视觉截图证据校验），Kiln 不内置浏览器驱动，但会用内核门禁守住「只读验收」与「真实证据」。
- **防跑偏详情页与阶段 Checkpoint**：详情页置顶展示每次执行的「输入 → 核心对齐摘要 → 输出」、4 项硬门禁灯、`Agent · Session` 标识与本机一键直达 **`原生 TUI`**（`codex resume` / `pi --session` / `claude --resume` / `opencode --session`）；每次写阶段自动生成隐藏 Git Checkpoint（`refs/kiln/checkpoints/...`），支持一键无痛回滚。
- **无人值守稳健性与任务后复盘**：内置 **Witness** 心跳停滞巡检、**Refinery** 多切片串行合并队列、空间脚本（`setup`/`dev`/`test`/`lint`/`deliver`）流式抽屉与本机端口探测、GitHub Issue 一键导入及 PR CI/评论按需回流、结构化审查缺陷清单，以及任务结束后的 **RETRO** 复盘进化飞轮（有界经验记忆上限 20 条，人工批准后生效并支持一键回滚）。

### 4. 5 字段正交计费、USD 预算熔断与诚实额度

- **精确核算**：按 `uncachedIn / cacheRead / cacheWrite / output / reasoning` 五字段独立计费并核算**扣除缓存写溢价后的净节省**；实时上下文窗口水位（`usage_update`）与计费账本严格解耦。
- **后台单价自动同步与 USD 熔断**：自动扫描配置与历史记录从 `~/.pi/agent/models.json`、`models.dev`、`LiteLLM` 同步 5 字段单价与窗口上限；支持单任务与全局日/月 USD 金额软预警与硬暂停；仅对原生公开余量的订阅展示官方额度百分比，其余订阅诚实显示本机统计，绝不编造进度条。

### 5. 一核多端本地优先与隧道无关远程访问

- **Electron 桌面端 · 单文件 CLI · 自适应 PWA**：单一 `kilnd` 驱动 Electron 托盘壳（按需创建/销毁 `BrowserWindow` 释放渲染内存、`Cmd/Ctrl+Shift+K` 呼出）、零依赖单文件 CLI，以及桌面/手机自适应双主题 Web 工作台（石墨冷灰深色 / 冷白浅色 + 窑火铜强调色）。
- **Fail-Closed 双端口远程访问**：本地 `:4310` 校验回环 Host/Origin 并拒收反向代理头；远程 `:4311` 默认关闭、开启后**零回环免登**且全量校验 `kiln_session` Cookie；搭配 `tailscale serve`、Cloudflare Tunnel 或任意 HTTPS 反代即可用手机扫码 `#pair=` 安全访问，并支持 Bark / ntfy / Webhook P0/P1 推送与仅交流电防休眠保活。

---

## 安装方式

> **版本状态说明**：当前源码与本地构建指向预发布版本 **`0.0.5`**（包含完整 V3 多订阅编排及 `v0.0.6` Vite+ / TypeScript 7 / Electron 架构迁移；**`0.1.0`** 预留给完成代码签名与公证后的首个正式对外版本）。各通道安装包会在发布对应 Release Tag 后激活，当前也可随时通过「源码构建」在本地打包或运行。

### 方式 1：Electron 桌面应用（macOS `.dmg` / Windows NSIS `.exe`，零前置依赖）

从 GitHub Releases 下载对应平台安装包（内置 Electron Node 运行时直接运行捆绑的 `kiln-runtime/{kiln-cli.mjs,kiln-mcp.mjs,public/}`，无需本机预装 Node.js / Bun，并在托盘菜单内置「安装 `kiln` 终端命令」入口）：

- **macOS**：`Kiln-v<ver>-darwin-arm64.dmg` / `Kiln-v<ver>-darwin-x64.dmg`
- **Windows x64**：`Kiln-v<ver>-windows-x64-setup.exe`（当前用户级安装，无需管理员 UAC）

### 方式 2：零依赖单文件 CLI 一键脚本

- **macOS / Linux**：从 GitHub Releases 下载预编译单文件并经 `SHA256SUMS` 校验，原子安装 `kiln` 与 `kl` 到 `~/.local/bin`（不修改 shell profile、不静默装自启）：
  ```sh
  curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh
  # 仅预览下载 URL 与校验计划：
  curl -fsSL https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.sh | sh -s -- --dry-run
  ```
- **Windows x64（PowerShell，免 UAC）**：安装 `kiln.exe` 与 `kl.cmd` 到 `%LOCALAPPDATA%\Kiln\bin`：
  ```powershell
  irm https://raw.githubusercontent.com/zzf2333/Kiln/main/scripts/install.ps1 | iex
  ```

### 方式 3：Homebrew Tap（macOS / Linux）

```sh
brew install zzf2333/tap/kiln            # 零 Node 单文件 CLI（kiln / kl）
brew install --cask zzf2333/tap/kiln-app # macOS 菜单栏桌面应用（公证 DMG 发布后启用）
```

### 方式 4：源码构建与本地开发

> 环境要求：`Node >= 22.0.0`、`pnpm >= 9.0.0`（仅编译独立单文件二进制时另需 `Bun >= 1.4`）。

```sh
pnpm install       # 安装 Monorepo 全部工作区依赖（零 C++ 原生编译）
pnpm check         # Oxfmt 格式检查 + Oxlint (typeAware/typeCheck) + tsrs 类型校验
pnpm build         # 构建全部分包、Web 工作台与 Electron runtime/
pnpm typecheck     # 全仓 TypeScript 7 类型检查
pnpm test          # 运行全部 53 组（430 条）非 Socket 单元与集成测试
pnpm test:socket   # 运行 4 组（9 条）真实 Socket / 双端口 / accept_entry 冒烟测试
```

按需打包本地产物：

```sh
pnpm build:binary -- --target host                                        # 编译当前平台单文件 CLI 二进制
pnpm --filter @kiln/desktop dev                                           # 启动本地 Electron 桌面开发调试
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @kiln/desktop pack:mac    # 本地打包未签名 macOS .dmg（先 pnpm build）
pnpm --filter @kiln/desktop pack:win                                      # 打包 Windows 用户级 NSIS .exe
sh -n scripts/install.sh && sh scripts/test-install.sh                    # 验证安装脚本回归
ruby -c packaging/homebrew/Formula/kiln.rb && ruby -c packaging/homebrew/Casks/kiln-app.rb
```

---

## 快速上手与日常使用

### 5 分钟跑起来

1. **启动工作台**：直接打开 `Kiln.app`（常驻系统托盘，按 `⌘⇧K` / `Ctrl+Shift+K` 呼出窗口），或在终端执行：
   ```sh
   kiln doctor       # 自检 Node、Git、APFS 克隆、kilnd 与本机 CLI/ACP 探测状态
   kiln up           # 启动后台守护进程（默认 127.0.0.1:4310）
   kiln space add .  # 探测当前 Git 仓库（分支、脚本、默认验收命令）并登记为项目空间
   kiln open         # 在浏览器打开 Kiln Web 工作台
   ```
2. **接入订阅与配置阵容**：
   - 进入 **设置 → Providers**：核对已探测到的本机订阅工具（`codex`、`pi`、`agy`、`claude`、`gemini`、`opencode` 等），按需登记自定义模型或环境变量；
   - 进入 **编排与阵容**：为你想启用的角色绑定主订阅与 `[1 → 2 → 3]` 备选链，查看各角色权限标签与特性。
3. **提需求并自动推进**：
   - 在界面按 `N` 打开「新需求」，粘贴截图/报错或从 **GitHub Issue 一键导入**；PM 会先只读摸底仓库与脚本，再用极简选项收敛边界、自主从常备池点将并给出排兵理由，或按需拆出带依赖顺序的多张卡片；
   - 确认开工后，**看板四列**按流程蓝图自动推进；详情页可实时查看 `BRIEF.md`、`PLAN.md`、输入→输出总览、门禁证据、隐式 Checkpoint 回滚与一键拉起 **`原生 TUI`** 排障。
4. **不在电脑前？安全远程访问**：
   ```sh
   kiln remote enable --keep-awake-ac --public-url https://your-tailnet.ts.net
   tailscale serve --bg http://127.0.0.1:4311
   kiln remote pair   # 输出一次性配对码与仅用 #pair= 片段的手机扫码链接
   ```

### 常用 CLI 命令速查（`kiln` / 短别名 `kl`）

| 命令                                                                                                                                    | 用途说明                                                                                                  |
| :-------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `kiln up [--port <port>] [--host <host>] [--foreground] [--kiln-home <dir>] [--paseo-url <url>] [--no-paseo]`                           | 幂等启动 `kilnd` 守护进程                                                                                 |
| `kiln down`                                                                                                                             | 优先经本地 IPC `POST /rpc/shutdown` 优雅停止托管中的 `kilnd`                                              |
| `kiln open [--port <port>] [--host <host>]`                                                                                             | 在系统默认浏览器打开工作台                                                                                |
| `kiln status [--port <port>] [--host <host>] [--json]`                                                                                  | 查看在跑任务、待决事项、草稿与费用快照                                                                    |
| `kiln space <list\|add [path]\|rm <id>> [...]`                                                                                          | 列出、自动探测登记或移除项目空间                                                                          |
| `kiln draft "<idea>" [--space <id>] [--priority <P0\|P1\|P2\|P3>] [--track <L1\|L2>] [--mode <git_worktree\|host_scoped\|scratch_dir>]` | 终端速记丢入任务草稿卡                                                                                    |
| `kiln decide [task-id] [--option <id>] [--decision <id>] [--rationale <text>] [--apply-ledger]`                                         | 在终端查看或拍板待决决策                                                                                  |
| `kiln remote <status\|enable\|disable\|pair\|devices\|revoke\|tailscale> [...]`                                                         | 管理 `:4311` 远程访问开关、配对挑战、设备列表与即时吊销                                                   |
| `kiln doctor [--json]`                                                                                                                  | 巡检运行环境、Git/APFS、Agent 探测与服务状态                                                              |
| `kiln service <install\|uninstall\|status>`                                                                                             | 显式安装或清理系统用户级开机自启（macOS `LaunchAgent` / Linux `systemd --user` / Windows `HKCU\...\Run`） |
| `kiln uninstall [--purge-data]`                                                                                                         | 停止服务、清除自启并巡检工作树（默认保留 `~/.kiln` 数据，加 `--purge-data` 一并清理）                     |
| `kiln -h, --help` / `kiln -v, --version`                                                                                                | 打印帮助或当前版本号（`0.0.5`）                                                                           |

---

## 仓库结构与安全边界

| 路径                                                  | 职责                                                                                                                                                                                                |
| :---------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/protocol`](packages/protocol/package.json) | **纯数据契约**：全链路 Zod Schema、`17` 角色阵容、可组合蓝图、5 字段定价与 `@kiln/protocol/web` 浏览器包                                                                                            |
| [`packages/kernel`](packages/kernel/package.json)     | **`kilnd` 守护进程核心**：状态机、TTL 亲和调度、门禁与 `accept_entry`、内置 SQLite 双适配器、`CompositeBackend`、双端口 Hono HTTP/SSE、RETRO / 预算 / Witness / Refinery / GitHub 桥接与 `open-tui` |
| [`packages/mcp`](packages/mcp/package.json)           | **`kiln-mcp` 工具服务**：受 `KILN_RUN_TOKEN` 与角色白名单限权的 7 工具 `stdio` 服务（内置于 `kiln __mcp` 与 Electron `kiln-mcp.mjs`）                                                               |
| [`packages/cli`](packages/cli/package.json)           | **`kiln` / `kl` CLI**：进程管理、空间/草稿/拍板/远程命令行、自检与显式用户级系统服务管理                                                                                                            |
| [`apps/web`](apps/web/package.json)                   | **Web 与 PWA 工作台**：React 19 + Tailwind CSS v4 + Radix UI（10 大视图 + `<= 820px` 移动端适配），构建至 `packages/kernel/public/`                                                                 |
| [`apps/desktop`](apps/desktop/README.md)              | **Electron 桌面常驻壳**：托盘常驻、按需创建/销毁 `BrowserWindow`、方案 E1 内置 Node 运行时与 `electron-builder` 打包                                                                                |
| [`scripts/`](scripts/install.sh)                      | **分发与探针脚本**：单文件编译 [`build-binary.mjs`](scripts/build-binary.mjs)、POSIX [`install.sh`](scripts/install.sh)、Windows [`install.ps1`](scripts/install.ps1) 与实测探针集                  |
| [`packaging/`](packaging/README.md)                   | **发版模板与清单**：Homebrew Formula / Cask 与发布核对文档                                                                                                                                          |
| [`.github/workflows/`](.github/workflows/ci.yml)      | **3-OS 自动化**：`ubuntu` / `macos` / `windows` 三端 CI（含 `pnpm lint` / `pnpm fmt:check`）与 Release 打包流水线                                                                                   |

**本地安全承诺**：`~/.kiln/` 为唯一数据目录，删除派生 SQLite 索引可从磁盘无损重建；首次安装绝不静默修改 shell profile 或注册开机自启；`host_scoped` 强制两阶段暂存与哈希防覆盖回滚；远程 `:4311` 对 `127.0.0.1` 同样不免登。

---

## License

[Apache-2.0](LICENSE)
