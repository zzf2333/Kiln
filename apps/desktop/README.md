# `@kiln/desktop`

Kiln 桌面端（Tauri v2 菜单栏/系统托盘薄壳 + 内置 `kiln` / `kiln.exe` Sidecar + 按需创建/销毁 WebView 窗口，覆盖 macOS `.dmg` 与 Windows NSIS `.exe`）。

## 职责与边界

- **纯薄壳定位（零内核业务）**：所有状态机、任务调度、账本、门禁与 WebUI 均由本地守护进程 `kilnd`（默认 `http://127.0.0.1:4310`）提供；Rust 侧仅通过 `GET /api/health`、`GET /api/bootstrap`、`GET /api/events`（SSE）与 `kiln` CLI（`kiln up` / `kiln down`）交互。
- **零外部依赖 Sidecar 查找优先级**：`KILN_BIN` 环境变量覆盖 > 同目录内置 Sidecar（macOS `Kiln.app/Contents/MacOS/kiln`、Windows `<install_dir>\kiln.exe`）> `PATH` 与标准安装/版本管理器目录回退；Windows 后台调用附加 `CREATE_NO_WINDOW`（`0x08000000`）防止控制台黑框闪烁。
- **终端命令一键链接（零静默改配置）**：菜单项「安装 kiln 终端命令」在 macOS/Linux 下将 `~/.local/bin/kiln` 与 `~/.local/bin/kl` 软链指向内置 Sidecar（绝不静默编辑 `~/.zshrc`/`~/.bashrc`），在 Windows 下写入免 UAC 的 `%LOCALAPPDATA%\Kiln\bin\kiln.cmd` 与 `kl.cmd`。
- **启动零常驻窗口 & 关窗即销毁**：
  - `tauri.conf.json` 中 `app.windows` 为 `[]`，macOS 上设置 `ActivationPolicy::Accessory`，启动后仅驻留菜单栏，不占 Dock。
  - 点击托盘「打开工作台」或按下全局快捷键 `CommandOrControl+Shift+K`（macOS `⌘⇧K` / Windows `Ctrl+Shift+K`）时按需创建 `main` WebView 窗口；关闭窗口时 `CloseRequested` 触发 `destroy()` 直接销毁 WebView 释放内存，而非隐藏驻留。
- **零开机自启**：不注册任何系统登录启动项或后台常驻服务；如需后台托管 `kilnd`，请显式通过 CLI 运行 `kiln service install`。
- **严格回环地址校验**：HTTP 请求与 WebView 导航均经 `model.rs` 校验，仅允许 `http://127.0.0.1[:port]` 与 `http://localhost[:port]`（拒绝 userinfo `@`、非回环域名、`https://`、`file://`、`javascript:` 与非法端口）。

## Sidecar 打包叠加配置

基础配置 `src-tauri/tauri.conf.json` 刻意不包含 `bundle.externalBin`，确保 `cargo check` / `cargo test` 在未预编译二进制的仓库环境中随时通过。打包带 Sidecar 的完整桌面安装包时，先准备对应目标二进制再叠加 `src-tauri/tauri.sidecar.conf.json`：

```bash
pnpm build
node scripts/build-binary.mjs --target host --stage-sidecar
npx -y @tauri-apps/cli@2 build --config apps/desktop/src-tauri/tauri.sidecar.conf.json
```

## 目录结构

```text
apps/desktop/
├── package.json                     # 无 npm 依赖，仅声明显式 Rust/Tauri 脚本
├── README.md
└── src-tauri/
    ├── Cargo.toml                   # Tauri v2 最小依赖配置
    ├── build.rs                     # tauri_build::build()
    ├── tauri.conf.json              # windows=[], 收紧 CSP, bundle 图标配置
    ├── capabilities/
    │   └── default.json             # 最小 core:default 权限集
    ├── icons/                       # 离线生成的 PNG / ICNS 应用与托盘图标
    └── src/
        ├── model.rs                 # 零第三方依赖纯 std 核心逻辑与单元测试
        ├── daemon_client.rs         # 回环 TCP HTTP/1.1 + SSE 客户端与 kiln CLI 封装
        ├── window_manager.rs        # 按需创建/聚焦主窗、导航白名单与关窗销毁策略
        ├── tray.rs                  # 菜单栏托盘图标、动态标题/Tooltip 与菜单事件
        ├── lib.rs                   # Tauri 组装、Accessory 模式、全局快捷键与后台刷新
        └── main.rs                  # 桌面入口
```

## 分层验证

### 1. 离线核心单测（仅需 `rustc`，无需网络或 Cargo crate 缓存）

`src-tauri/src/model.rs` 100% 仅依赖 Rust 标准库（`std`），覆盖回环 URL 安全校验、`/api/health` 与 `/api/bootstrap` JSON 解析、SSE 事件块解析、托盘互斥状态格式化及关窗销毁策略测试：

```bash
pnpm --filter @kiln/desktop test:rust:core
# 若环境使用自定义 rustc 路径（如 ~/.cargo/bin/rustc）：
/Users/saonian/.cargo/bin/rustc --test apps/desktop/src-tauri/src/model.rs -o /tmp/kiln-desktop-model-test && /tmp/kiln-desktop-model-test && rm -f /tmp/kiln-desktop-model-test
```

### 2. 完整 Tauri 构建与检查（需联网拉取 crates.io 依赖与 Tauri CLI）

在具备 crates.io 缓存或外网环境下执行完整检查与打包：

```bash
pnpm --filter @kiln/desktop check:rust   # cargo check --manifest-path src-tauri/Cargo.toml
pnpm --filter @kiln/desktop test:rust    # cargo test --manifest-path src-tauri/Cargo.toml
pnpm --filter @kiln/desktop tauri:dev    # 启动本地开发调试
pnpm --filter @kiln/desktop tauri:build  # 打包桌面应用产物
```
