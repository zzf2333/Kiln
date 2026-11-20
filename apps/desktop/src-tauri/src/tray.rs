use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

use crate::daemon_client::{open_in_default_browser, run_kiln_down, spawn_kiln_up};
use crate::model::{
    format_start_menu_label, format_tray_menu_status, format_tray_title, format_tray_tooltip,
    is_start_menu_enabled, NormalizedKilndUrl, TrayDisplayState,
};
use crate::window_manager::{destroy_main_window, open_or_focus_main_window};
use crate::RefreshCoordinator;

pub const TRAY_ID: &str = "kiln-tray";

const MENU_STATUS: &str = "status";
const MENU_OPEN_WORKBENCH: &str = "open_workbench";
const MENU_OPEN_BROWSER: &str = "open_browser";
const MENU_REFRESH: &str = "refresh";
const MENU_START_KILND: &str = "start_kilnd";
const MENU_QUIT_TRAY_ONLY: &str = "quit_tray_only";
const MENU_STOP_KILND_AND_QUIT: &str = "stop_kilnd_and_quit";

struct TrayMenuHandles<R: Runtime> {
    kilnd_url: NormalizedKilndUrl,
    status_item: MenuItem<R>,
    start_item: MenuItem<R>,
    stop_and_quit_item: MenuItem<R>,
}

pub fn setup_tray<R: Runtime>(
    app: &AppHandle<R>,
    kilnd_url: NormalizedKilndUrl,
    coordinator: Arc<RefreshCoordinator>,
    allow_exit: Arc<AtomicBool>,
) -> tauri::Result<()> {
    let initial_state = TrayDisplayState::Offline { reason: None };

    let status_item = MenuItemBuilder::with_id(MENU_STATUS, format_tray_menu_status(&initial_state))
        .enabled(false)
        .build(app)?;
    let open_workbench_item = MenuItemBuilder::with_id(MENU_OPEN_WORKBENCH, "打开工作台")
        .accelerator("CmdOrCtrl+Shift+K")
        .build(app)?;
    let open_browser_item =
        MenuItemBuilder::with_id(MENU_OPEN_BROWSER, "在默认浏览器打开").build(app)?;
    let refresh_item = MenuItemBuilder::with_id(MENU_REFRESH, "刷新状态").build(app)?;
    let start_item = MenuItemBuilder::with_id(MENU_START_KILND, "启动 kilnd")
        .enabled(true)
        .build(app)?;
    let quit_tray_only_item =
        MenuItemBuilder::with_id(MENU_QUIT_TRAY_ONLY, "退出菜单栏（保持 kilnd 运行）")
            .build(app)?;
    let stop_and_quit_item = MenuItemBuilder::with_id(MENU_STOP_KILND_AND_QUIT, "停止 kilnd 并退出")
        .enabled(false)
        .build(app)?;

    let sep_top = PredefinedMenuItem::separator(app)?;
    let sep_mid = PredefinedMenuItem::separator(app)?;
    let sep_bottom = PredefinedMenuItem::separator(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &status_item,
            &sep_top,
            &open_workbench_item,
            &open_browser_item,
            &sep_mid,
            &refresh_item,
            &start_item,
            &sep_bottom,
            &quit_tray_only_item,
            &stop_and_quit_item,
        ])
        .build()?;

    app.manage(TrayMenuHandles {
        kilnd_url: kilnd_url.clone(),
        status_item,
        start_item,
        stop_and_quit_item,
    });

    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let url_for_events = kilnd_url;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .title(format_tray_title(&initial_state))
        .tooltip(format_tray_tooltip(
            &initial_state,
            &url_for_events.base_url,
        ))
        .on_menu_event(move |app_handle, event| {
            handle_menu_event(
                app_handle,
                event.id().as_ref(),
                &url_for_events,
                &coordinator,
                &allow_exit,
            );
        });

    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);

    let _tray = builder.build(app)?;
    Ok(())
}

pub fn update_tray_display<R: Runtime>(app: &AppHandle<R>, state: &TrayDisplayState) {
    let Some(handles) = app.try_state::<TrayMenuHandles<R>>() else {
        return;
    };

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(format_tray_title(state)));
        let _ = tray.set_tooltip(Some(format_tray_tooltip(
            state,
            &handles.kilnd_url.base_url,
        )));
    }

    let online = state.is_online();
    let _ = handles.status_item.set_text(format_tray_menu_status(state));
    let _ = handles.start_item.set_text(format_start_menu_label(state));
    let _ = handles.start_item.set_enabled(is_start_menu_enabled(state));
    let _ = handles.stop_and_quit_item.set_enabled(online);
}

fn handle_menu_event<R: Runtime>(
    app: &AppHandle<R>,
    menu_id: &str,
    kilnd_url: &NormalizedKilndUrl,
    coordinator: &Arc<RefreshCoordinator>,
    allow_exit: &Arc<AtomicBool>,
) {
    match menu_id {
        MENU_OPEN_WORKBENCH => {
            if let Err(err) = open_or_focus_main_window(app, &kilnd_url.base_url) {
                eprintln!("kiln-desktop: failed to open workbench window: {err}");
            }
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
        MENU_QUIT_TRAY_ONLY => {
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
