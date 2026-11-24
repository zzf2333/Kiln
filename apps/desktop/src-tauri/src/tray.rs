use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

use crate::daemon_client::{
    install_cli_command, open_in_default_browser, run_kiln_down, spawn_kiln_up,
};
#[cfg(target_os = "macos")]
use crate::model::format_tray_title;
use crate::model::{
    format_engine_submenu_label, format_inbox_menu_label, format_install_cli_menu_label,
    format_start_menu_label, format_tray_header, format_tray_menu_status,
    format_tray_tooltip_with_version, is_start_menu_enabled, CliInstallActionState,
    NormalizedKilndUrl, TrayDisplayState, WorkbenchRoute, DESKTOP_APP_VERSION,
};
use crate::window_manager::destroy_main_window;
use crate::RefreshCoordinator;

pub const TRAY_ID: &str = "kiln-tray";

const MENU_HEADER: &str = "header";
const MENU_STATUS: &str = "status";
const MENU_OPEN_WORKBENCH: &str = "open_workbench";
const MENU_GO_INTAKE: &str = "go_intake";
const MENU_GO_BOARD: &str = "go_board";
const MENU_GO_LINEUP: &str = "go_lineup";
const MENU_GO_INBOX: &str = "go_inbox";
const MENU_GO_LEDGER: &str = "go_ledger";
const MENU_GO_USAGE: &str = "go_usage";
const MENU_GO_SETTINGS: &str = "go_settings";

const MENU_ENGINE_SUBMENU: &str = "engine_submenu";
const MENU_ENGINE_NODE: &str = "engine_node";
const MENU_REFRESH: &str = "refresh";
const MENU_START_KILND: &str = "start_kilnd";
const MENU_RESTART_KILND: &str = "restart_kilnd";
const MENU_OPEN_BROWSER: &str = "open_browser";
const MENU_INSTALL_CLI: &str = "install_cli";
const MENU_QUIT_DESKTOP_ONLY: &str = "quit_tray_only";
const MENU_STOP_KILND_AND_QUIT: &str = "stop_kilnd_and_quit";

struct TrayMenuHandles<R: Runtime> {
    kilnd_url: NormalizedKilndUrl,
    header_item: MenuItem<R>,
    status_item: MenuItem<R>,
    inbox_item: MenuItem<R>,
    engine_submenu: Submenu<R>,
    start_item: MenuItem<R>,
    restart_item: MenuItem<R>,
    install_cli_item: MenuItem<R>,
    stop_and_quit_item: MenuItem<R>,
}

pub fn setup_tray<R: Runtime>(
    app: &AppHandle<R>,
    kilnd_url: NormalizedKilndUrl,
) -> tauri::Result<()> {
    let initial_state = TrayDisplayState::Offline { reason: None };

    let header_item = MenuItemBuilder::with_id(
        MENU_HEADER,
        format_tray_header(DESKTOP_APP_VERSION, None),
    )
    .enabled(false)
    .build(app)?;
    let status_item = MenuItemBuilder::with_id(
        MENU_STATUS,
        format_tray_menu_status(&initial_state),
    )
    .enabled(false)
    .build(app)?;

    let open_workbench_item = MenuItemBuilder::with_id(MENU_OPEN_WORKBENCH, "打开工作台")
        .accelerator("CmdOrCtrl+Shift+K")
        .build(app)?;
    let new_task_item = MenuItemBuilder::with_id(MENU_GO_INTAKE, "新建需求")
        .build(app)?;
    let inbox_item = MenuItemBuilder::with_id(
        MENU_GO_INBOX,
        format_inbox_menu_label(&initial_state),
    )
    .build(app)?;
    let lineup_item = MenuItemBuilder::with_id(MENU_GO_LINEUP, "编排与阵容").build(app)?;
    let usage_item = MenuItemBuilder::with_id(MENU_GO_USAGE, "用量与费用").build(app)?;
    let settings_item = MenuItemBuilder::with_id(MENU_GO_SETTINGS, "设置…").build(app)?;

    let node_text = format!("节点：{}:{}", kilnd_url.host, kilnd_url.port);
    let engine_node_item = MenuItemBuilder::with_id(MENU_ENGINE_NODE, node_text)
        .enabled(false)
        .build(app)?;
    let refresh_item = MenuItemBuilder::with_id(MENU_REFRESH, "刷新状态").build(app)?;
    let start_item = MenuItemBuilder::with_id(MENU_START_KILND, "启动 kilnd")
        .enabled(true)
        .build(app)?;
    let restart_item = MenuItemBuilder::with_id(MENU_RESTART_KILND, "重启 kilnd")
        .enabled(false)
        .build(app)?;
    let open_browser_item =
        MenuItemBuilder::with_id(MENU_OPEN_BROWSER, "在默认浏览器打开").build(app)?;
    let install_cli_item = MenuItemBuilder::with_id(
        MENU_INSTALL_CLI,
        format_install_cli_menu_label(&CliInstallActionState::Idle),
    )
    .build(app)?;

    let engine_submenu = SubmenuBuilder::with_id(
        app,
        MENU_ENGINE_SUBMENU,
        format_engine_submenu_label(&initial_state),
    )
    .item(&engine_node_item)
    .item(&refresh_item)
    .item(&start_item)
    .item(&restart_item)
    .separator()
    .item(&open_browser_item)
    .item(&install_cli_item)
    .build()?;

    let quit_desktop_only_item =
        MenuItemBuilder::with_id(MENU_QUIT_DESKTOP_ONLY, "退出桌面端（保持后台推进）")
            .build(app)?;
    let stop_and_quit_item =
        MenuItemBuilder::with_id(MENU_STOP_KILND_AND_QUIT, "停止后台引擎并完全退出")
            .enabled(false)
            .build(app)?;

    let sep_overview = PredefinedMenuItem::separator(app)?;
    let sep_routes = PredefinedMenuItem::separator(app)?;
    let sep_engine = PredefinedMenuItem::separator(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &header_item,
            &status_item,
            &sep_overview,
            &open_workbench_item,
            &new_task_item,
            &inbox_item,
            &lineup_item,
            &usage_item,
            &settings_item,
            &sep_routes,
            &engine_submenu,
            &sep_engine,
            &quit_desktop_only_item,
            &stop_and_quit_item,
        ])
        .build()?;

    app.manage(TrayMenuHandles {
        kilnd_url: kilnd_url.clone(),
        header_item,
        status_item,
        inbox_item,
        engine_submenu,
        start_item,
        restart_item,
        install_cli_item,
        stop_and_quit_item,
    });

    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip(format_tray_tooltip_with_version(
            &initial_state,
            &kilnd_url.base_url,
            DESKTOP_APP_VERSION,
            None,
        ));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title(format_tray_title(&initial_state))
        .icon_as_template(true);

    let _tray = builder.build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn setup_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let about_meta = AboutMetadata {
        name: Some("Kiln".to_string()),
        version: Some(DESKTOP_APP_VERSION.to_string()),
        comments: Some("多 Agent · 多订阅流程编排与看板自动推进工作台".to_string()),
        ..Default::default()
    };

    let kil_settings = MenuItemBuilder::with_id(MENU_GO_SETTINGS, "设置…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let kil_quit = MenuItemBuilder::with_id(MENU_QUIT_DESKTOP_ONLY, "退出 Kiln")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let kil_stop_quit =
        MenuItemBuilder::with_id(MENU_STOP_KILND_AND_QUIT, "停止后台引擎并完全退出")
            .accelerator("Alt+CmdOrCtrl+Q")
            .build(app)?;

    let app_submenu = SubmenuBuilder::new(app, "Kiln")
        .about(Some(about_meta))
        .separator()
        .item(&kil_settings)
        .separator()
        .hide_with_text("隐藏 Kiln")
        .hide_others_with_text("隐藏其他")
        .show_all_with_text("全部显示")
        .separator()
        .item(&kil_quit)
        .item(&kil_stop_quit)
        .build()?;

    let wb_intake = MenuItemBuilder::with_id(MENU_GO_INTAKE, "新建需求")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let wb_board = MenuItemBuilder::with_id(MENU_GO_BOARD, "总览看板")
        .accelerator("CmdOrCtrl+1")
        .build(app)?;
    let wb_lineup = MenuItemBuilder::with_id(MENU_GO_LINEUP, "编排与阵容")
        .accelerator("CmdOrCtrl+2")
        .build(app)?;
    let wb_inbox = MenuItemBuilder::with_id(MENU_GO_INBOX, "等你决定")
        .accelerator("CmdOrCtrl+3")
        .build(app)?;
    let wb_ledger = MenuItemBuilder::with_id(MENU_GO_LEDGER, "决策账本")
        .accelerator("CmdOrCtrl+4")
        .build(app)?;
    let wb_usage = MenuItemBuilder::with_id(MENU_GO_USAGE, "用量与费用")
        .accelerator("CmdOrCtrl+5")
        .build(app)?;
    let wb_browser = MenuItemBuilder::with_id(MENU_OPEN_BROWSER, "在默认浏览器打开").build(app)?;
    let wb_close = PredefinedMenuItem::close_window(app, Some("关闭窗口"))?;

    let workbench_submenu = SubmenuBuilder::new(app, "工作台")
        .item(&wb_intake)
        .separator()
        .item(&wb_board)
        .item(&wb_lineup)
        .item(&wb_inbox)
        .item(&wb_ledger)
        .item(&wb_usage)
        .separator()
        .item(&wb_browser)
        .item(&wb_close)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "编辑")
        .undo_with_text("撤销")
        .redo_with_text("重做")
        .separator()
        .cut_with_text("剪切")
        .copy_with_text("拷贝")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "窗口")
        .minimize_with_text("最小化")
        .maximize_with_text("缩放")
        .separator()
        .fullscreen_with_text("进入全屏幕")
        .separator()
        .bring_all_to_front_with_text("前置全部窗口")
        .build()?;

    let app_menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&workbench_submenu)
        .item(&edit_submenu)
        .item(&window_submenu)
        .build()?;

    app.set_menu(app_menu)?;
    Ok(())
}

pub fn update_tray_display<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayDisplayState,
    daemon_version: Option<&str>,
) {
    let Some(handles) = app.try_state::<TrayMenuHandles<R>>() else {
        return;
    };

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(format_tray_title(state)));
        let _ = tray.set_tooltip(Some(format_tray_tooltip_with_version(
            state,
            &handles.kilnd_url.base_url,
            DESKTOP_APP_VERSION,
            daemon_version,
        )));
    }

    let online = state.is_online();
    let _ = handles
        .header_item
        .set_text(format_tray_header(DESKTOP_APP_VERSION, daemon_version));
    let _ = handles
        .status_item
        .set_text(format_tray_menu_status(state));
    let _ = handles
        .inbox_item
        .set_text(format_inbox_menu_label(state));
    let _ = handles
        .engine_submenu
        .set_text(format_engine_submenu_label(state));
    let _ = handles.start_item.set_text(format_start_menu_label(state));
    let _ = handles.start_item.set_enabled(is_start_menu_enabled(state));
    let _ = handles.restart_item.set_enabled(online);
    let _ = handles.stop_and_quit_item.set_enabled(online);
}

fn update_install_cli_menu<R: Runtime>(app: &AppHandle<R>, state: &CliInstallActionState) {
    let Some(handles) = app.try_state::<TrayMenuHandles<R>>() else {
        return;
    };
    let _ = handles
        .install_cli_item
        .set_text(format_install_cli_menu_label(state));
}

pub fn handle_menu_event<R: Runtime>(
    app: &AppHandle<R>,
    menu_id: &str,
    kilnd_url: &NormalizedKilndUrl,
    coordinator: &Arc<RefreshCoordinator>,
    allow_exit: &Arc<AtomicBool>,
) {
    match menu_id {
        MENU_OPEN_WORKBENCH => {
            crate::ensure_kilnd_and_open_window(app, kilnd_url, coordinator, None);
        }
        MENU_GO_BOARD => {
            crate::ensure_kilnd_and_open_window(
                app,
                kilnd_url,
                coordinator,
                Some(WorkbenchRoute::Board),
            );
        }
        MENU_GO_INTAKE => {
            crate::ensure_kilnd_and_open_window(
                app,
                kilnd_url,
                coordinator,
                Some(WorkbenchRoute::Intake),
            );
        }
        MENU_GO_LINEUP => {
            crate::ensure_kilnd_and_open_window(
                app,
                kilnd_url,
                coordinator,
                Some(WorkbenchRoute::Lineup),
            );
        }
        MENU_GO_INBOX => {
            crate::ensure_kilnd_and_open_window(
                app,
                kilnd_url,
                coordinator,
                Some(WorkbenchRoute::Inbox),
            );
        }
        MENU_GO_LEDGER => {
            crate::ensure_kilnd_and_open_window(
                app,
                kilnd_url,
                coordinator,
                Some(WorkbenchRoute::Ledger),
            );
        }
        MENU_GO_USAGE => {
            crate::ensure_kilnd_and_open_window(
                app,
                kilnd_url,
                coordinator,
                Some(WorkbenchRoute::Usage),
            );
        }
        MENU_GO_SETTINGS => {
            crate::ensure_kilnd_and_open_window(
                app,
                kilnd_url,
                coordinator,
                Some(WorkbenchRoute::Settings),
            );
        }
        MENU_OPEN_BROWSER => {
            if let Err(err) = open_in_default_browser(kilnd_url) {
                eprintln!("kiln-desktop: failed to open browser: {err}");
            }
        }
        MENU_REFRESH => {
            coordinator.trigger_refresh();
        }
        MENU_START_KILND => {
            if !coordinator.begin_start_kilnd() {
                return;
            }
            let url = kilnd_url.clone();
            let coord = Arc::clone(coordinator);
            std::thread::spawn(move || {
                let outcome = spawn_kiln_up(&url).map(|_| ());
                if let Err(ref err) = outcome {
                    eprintln!("kiln-desktop: {err}");
                }
                coord.finish_start_kilnd(outcome);
            });
        }
        MENU_RESTART_KILND => {
            if !coordinator.begin_start_kilnd() {
                return;
            }
            let url = kilnd_url.clone();
            let coord = Arc::clone(coordinator);
            std::thread::spawn(move || {
                if let Err(err) = run_kiln_down() {
                    eprintln!("kiln-desktop: warning during restart stop: {err}");
                }
                let outcome = spawn_kiln_up(&url).map(|_| ());
                if let Err(ref err) = outcome {
                    eprintln!("kiln-desktop: {err}");
                }
                coord.finish_start_kilnd(outcome);
            });
        }
        MENU_INSTALL_CLI => {
            let app_handle = app.clone();
            std::thread::spawn(move || {
                let next_state = match install_cli_command() {
                    Ok(outcome) => {
                        eprintln!(
                            "kiln-desktop: installed kiln/kl commands into {} -> {} (in_path={})",
                            outcome.bin_dir.display(),
                            outcome.target_bin.display(),
                            outcome.in_path
                        );
                        CliInstallActionState::Installed {
                            bin_dir: outcome.display_bin_dir,
                            in_path: outcome.in_path,
                        }
                    }
                    Err(err) => {
                        eprintln!("kiln-desktop: install CLI command failed: {err}");
                        CliInstallActionState::Failed(err)
                    }
                };
                update_install_cli_menu(&app_handle, &next_state);
            });
        }
        MENU_QUIT_DESKTOP_ONLY => {
            destroy_main_window(app);
            coordinator.request_shutdown();
            allow_exit.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        MENU_STOP_KILND_AND_QUIT => {
            destroy_main_window(app);
            let app_handle = app.clone();
            let coord = Arc::clone(coordinator);
            let exit_flag = Arc::clone(allow_exit);
            std::thread::spawn(move || {
                if let Err(err) = run_kiln_down() {
                    eprintln!("kiln-desktop: {err}");
                }
                coord.request_shutdown();
                exit_flag.store(true, Ordering::SeqCst);
                app_handle.exit(0);
            });
        }
        _ => {}
    }
}
