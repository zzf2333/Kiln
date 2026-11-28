# `@kiln/desktop` — Kiln 桌面常驻壳（Electron）

Kiln 桌面客户端基于 Electron 构建，定位为「常驻系统托盘 + 按需创建/销毁 `BrowserWindow` + `kilnd` 生命周期看护」：

- **默认无窗常驻**：
  - `main.ts` 启动后仅常驻系统托盘（macOS 上执行 `app.dock.hide()`，仅驻留菜单栏，不占 Dock）。
  - 注册全局快捷键 `CommandOrControl+Shift+K` 打开/聚焦主窗口，以及原生通知（决策 / 卡住触发并支持点击回跳 `/?task=<id>`）。
  - 关闭主窗口时直接 `destroy` `BrowserWindow`（仅在无窗口时释放独立渲染进程内存），托盘与后台 `kilnd` 继续运行。
- **方案 E1 内置 Node 运行时**：
  - `pnpm build` 先由 `vp pack` 编译 `dist/main.js`，再由 `scripts/stage-runtime.mjs` 将单文件自包含 JS 运行时 `kiln-cli.mjs`、`kiln-mcp.mjs`、可重定位 CLI 启动脚本 `bin/{kiln,kl,kiln.cmd,kl.cmd}` 与编译后的 Web UI `public/` 写入 `runtime/`。
  - `electron-builder` 将 `runtime/` 打包到应用资源目录 `kiln-runtime/`（macOS 为 `Contents/Resources/kiln-runtime`，Windows 为 `resources/kiln-runtime`）。
  - 桌面端和 CLI/MCP 子进程通过 `ELECTRON_RUN_AS_NODE=1` 直接复用 Electron 内置 Node 运行上述脚本，无需额外安装 Node.js 或 Bun，也无独立原生二进制 Sidecar。
- **安全边界**：
  - 严格校验 `KILND_URL` 必须为 `http://127.0.0.1` / `http://localhost` / `http://[::1]` 回环地址，非法地址启动前即以退出码 `2` 优雅退出。
  - 仅开启 `BrowserWindow` 的 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，并通过 `will-navigate` / `setWindowOpenHandler` 拦截所有非同源回环跳转，外部链接转发至 `shell.openExternal`。
  - 菜单栏/托盘内嵌 `安装 kiln 终端命令`：macOS / Linux 在 `~/.local/bin/{kiln,kl}` 原子符号链接至包内可重定位启动脚本 `kiln-runtime/bin/{kiln,kl}`（支持非捆绑态包装回退与同路径防自覆盖校验）；Windows 在 `%LOCALAPPDATA%\kiln\bin` 生成 `kiln.cmd` 与 `kl.cmd`。

## 目录结构

```text
apps/desktop/
├── assets/                   # 应用图标与托盘模板图标（icon.icns / icon.ico / tray-template*.png）
├── scripts/
│   └── stage-runtime.mjs     # 打包 runtime/{kiln-cli.mjs, kiln-mcp.mjs, bin/, public/}
├── src/
│   ├── main.ts               # Electron 主进程入口（单实例锁、全局快捷键、SSE、托盘、通知）
│   ├── model.ts              # URL 校验、JSON/SSE 解析、托盘文案与状态机等纯逻辑
│   ├── daemon-client.ts      # kilnd HTTP/SSE 客户端、运行时解析与 CLI 包装脚本安装
│   ├── window-manager.ts     # BrowserWindow 按需创建、销毁与回环导航守卫
│   ├── tray.ts               # 菜单栏/系统托盘菜单组装与状态更新
│   └── __tests__/
│       └── desktop.test.ts   # Vitest 单元测试（URL 守卫、SSE 解析、E1 路径解析与 CLI 包装器）
├── electron-builder.yml      # macOS (.dmg) 与 Windows (user-level NSIS .exe) 打包配置
├── tsconfig.json
├── vite.config.ts            # vp pack 编译 dist/main.js
└── package.json
```

## 常用命令

```sh
pnpm --filter @kiln/desktop build      # 编译 dist/main.js 并生成 runtime/
pnpm --filter @kiln/desktop typecheck  # TypeScript 类型检查
pnpm --filter @kiln/desktop test       # 运行 Electron 桌面核心单元测试（Vitest）
pnpm --filter @kiln/desktop dev        # 构建并启动本地 Electron 开发调试
pnpm --filter @kiln/desktop pack:dir   # 生成未压缩的应用目录产物验证结构
pnpm --filter @kiln/desktop pack:mac   # 打包 macOS .dmg（macOS 环境）
pnpm --filter @kiln/desktop pack:win   # 打包 Windows 用户级 NSIS .exe
```
