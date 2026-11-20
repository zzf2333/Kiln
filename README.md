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

## 仓库结构

| 路径 | 说明 |
| :--- | :--- |
| `packages/protocol` | **纯数据契约层**：全链路 Zod Schema、`card.yaml` / 回执 / 配置解析与标价费用公式 |
| `packages/kernel` | **`kilnd` 守护进程核心**：状态机、调度器、验真门禁、可重建存储、HTTP+SSE 与执行底座抽象 |
| `packages/mcp` | **`kiln-mcp` 工具服务**：受限 `stdio` MCP 服务，通过 `0600` Unix Socket 与 `KILN_RUN_TOKEN` 调用 `kilnd` |
| `packages/cli` | **`kiln` CLI**：守护进程启停、状态查询、草稿/审批命令及系统服务管理 |
| `apps/web` | **Web 工作台**：桌面与移动端（`<= 820px`）自适应前端 |

---

## 快速开始与验证命令

> 环境要求：`Node >= 22 LTS`、`pnpm >= 9`

```bash
pnpm install       # 安装 Monorepo 全部工作区依赖
pnpm build         # 构建所有子包（含 apps/web 前端产物）
pnpm typecheck     # 全仓 TypeScript 类型检查
pnpm test          # 运行全部非 Socket 单元测试与集成测试
pnpm test:socket   # 运行 Unix Socket / 回环 TCP 连通冒烟测试
```

---

## 实施路线图

- [x] **M0 · 技术探针验证**：已完成底层 Agent 能力、权限策略与用量格式实测锁定。
- [x] **M1 · 协议与无头内核**：完成 `packages/protocol`、`kernel`、`mcp`、`cli` 与并发竞态 / 删库重建测试集。
- [ ] **M2 · MVP 工作台闭环**：推进 `PaseoBackend`、`apps/web` 桌面/手机看板与真机端到端联调验收。
- [ ] **M3 · 桌面常驻与开源发布**：封装 `apps/desktop`（Tauri v2 菜单栏 + 按需释放窗口），打通 npm 与 Homebrew 分发流水线。
- [ ] **M4 · Post-MVP 演进**：复盘模块、多切片串行合并队列、执行台泳道、Tailscale/Passkey 推送与大需求循环（Epic Loop）。

---

## License

[Apache-2.0](./LICENSE)
