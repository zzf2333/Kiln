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
5. **一核多端驻守形态**：单一本地守护进程同时驱动 macOS 顶部菜单栏、按需释放内存的原生桌面窗口、桌面/手机自适应 Web 看板与 `kiln` CLI；所有消耗统一按官方 API 标价透明折算。

---

## 仓库目录与文档导航

当前阶段：**架构、协议与多端交互原型已审查闭环定稿**，准备进入 `M0`（底座探针验证）与 `M1`（无头内核实现）。

| 路径 | 说明 |
| :--- | :--- |
| [`docs/workflow-and-protocol.md`](./docs/workflow-and-protocol.md) | **工作流与业务协议总设计书（V2.2 定稿）**：任务模型、6+1 状态机、三级升级链、人类红线、角色配置、`kiln-mcp` 7 工具、阶段模版与 MVP 验收标准 |
| [`docs/architecture-and-engineering.md`](./docs/architecture-and-engineering.md) | **产品形态与技术工程开发文档**：一核多端常驻形态、TypeScript + Node 22 + Hono(SSE) + SQLite + Tauri v2 技术栈、Monorepo 边界、通信协议、SQLite DDL、CLI 与分发方案 |
| [`docs/reviews/v2-design-audit.md`](./docs/reviews/v2-design-audit.md) | **架构与原型独立审查闭环记录**：施工前针对状态机、数据契约、本机安全及移动端交互的两轮完整审查与修复台账 |
| [`prototype/index.html`](./prototype/index.html) | **交互式前端原型（桌面 + 移动端自适应）**：零外部依赖单文件原型，含总览看板、粒子火焰甘特时间轴、三栏产物阅读器、立项/讨论对话、API 标价用量统计与完整设置页 |

### 本地预览交互原型

直接在浏览器打开 [`prototype/index.html`](./prototype/index.html)（macOS 终端可执行 `open prototype/index.html`），支持快捷键 `N`（新需求）、`⌘K`（命令面板）、`Esc`（返回）及手机窄屏（`<= 820px`）自适应预览。

---

## 实施路线图

- [x] **M0 · 技术探针验证**：已完成 V1–V6、V9 实测与退路锁定（详见 [`scripts/probes/RESULTS.md`](./scripts/probes/RESULTS.md)；全员已统一走 Paseo，`agy` 将随 Paseo 下版 `agy acp` 接入，V7 已取消）。
- [ ] **M1 · 协议与无头内核**：完成 `packages/protocol`、`kernel`、`mcp`、`cli` 及 `FakeBackend` 并发竞态与崩溃重建测试集。
- [ ] **M2 · MVP 工作台闭环**：接入 `PaseoBackend`，上线 `apps/web` 桌面与手机自适应看板。
- [ ] **M3 · 桌面常驻与开源发布**：封装 `apps/desktop`（Tauri v2 菜单栏 + 按需释放窗口），打通 npm 与 Homebrew 分发流水线。
- [ ] **M4 · Post-MVP 演进**：复盘模块、多切片串行合并队列、执行台泳道、Tailscale/Passkey 推送与大需求循环（Epic Loop）。

---

## License

[Apache-2.0](./LICENSE)
