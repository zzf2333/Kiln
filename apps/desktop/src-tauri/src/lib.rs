mod daemon_client;
mod model;
mod tray;
mod window_manager;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::daemon_client::{resolve_kilnd_url, spawn_kiln_up, KilndClient, SsePollResult};
use crate::model::{
    decide_startup_window_action, should_prevent_exit, NormalizedKilndUrl, StartActionState,
    StartupWindowAction, TrayDisplayState, WorkbenchRoute, MAIN_WINDOW_LABEL,
};
#[cfg(target_os = "macos")]
use crate::tray::setup_app_menu;
use crate::tray::{handle_menu_event, setup_tray, update_tray_display};
use crate::window_manager::open_or_focus_main_window;

const OFFLINE_POLL_INTERVAL: Duration = Duration::from_secs(3);
const SSE_POLL_SLICE: Duration = Duration::from_millis(800);
const SSE_HEALTH_HEARTBEAT_TICKS: u32 = 12;
const GLOBAL_WORKBENCH_SHORTCUT: &str = "CommandOrControl+Shift+K";

#[derive(Default)]
struct CoordinatorState {
    epoch: u64,
    shutdown: bool,
    start_action: StartActionState,
}

pub struct RefreshCoordinator {
    state: Mutex<CoordinatorState>,
    wake: Condvar,
}

impl RefreshCoordinator {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(CoordinatorState::default()),
            wake: Condvar::new(),
        }
    }

    pub fn trigger_refresh(&self) {
        if let Ok(mut guard) = self.state.lock() {
            guard.epoch = guard.epoch.wrapping_add(1);
            self.wake.notify_all();
        }
    }

    pub fn begin_start_kilnd(&self) -> bool {
        if let Ok(mut guard) = self.state.lock() {
            if matches!(guard.start_action, StartActionState::Starting) {
                return false;
            }
            guard.start_action = StartActionState::Starting;
            guard.epoch = guard.epoch.wrapping_add(1);
            self.wake.notify_all();
            return true;
        }
        false
    }

    pub fn finish_start_kilnd(&self, result: Result<(), String>) {
        if let Ok(mut guard) = self.state.lock() {
            guard.start_action = match result {
                Ok(()) => StartActionState::Idle,
                Err(err) => StartActionState::Failed(err),
            };
            guard.epoch = guard.epoch.wrapping_add(1);
            self.wake.notify_all();
        }
    }

    pub fn clear_start_action(&self) {
        if let Ok(mut guard) = self.state.lock() {
            if !matches!(guard.start_action, StartActionState::Idle) {
                guard.start_action = StartActionState::Idle;
            }
        }
    }

    pub fn start_action(&self) -> StartActionState {
        self.state
            .lock()
            .map(|g| g.start_action.clone())
            .unwrap_or_default()
    }

    pub fn request_shutdown(&self) {
        if let Ok(mut guard) = self.state.lock() {
            guard.shutdown = true;
            self.wake.notify_all();
        }
    }

    fn snapshot(&self) -> (u64, bool) {
        self.state
            .lock()
            .map(|g| (g.epoch, g.shutdown))
            .unwrap_or((0, true))
    }

    fn wait_for_change(&self, seen_epoch: u64, timeout: Duration) -> (u64, bool) {
        let Ok(guard) = self.state.lock() else {
            return (seen_epoch, true);
        };
        if guard.shutdown || guard.epoch != seen_epoch {
            return (guard.epoch, guard.shutdown);
        }
        let Ok((after, _)) = self
            .wake
            .wait_timeout_while(guard, timeout, |s| !s.shutdown && s.epoch == seen_epoch)
        else {
            return (seen_epoch, true);
        };
        (after.epoch, after.shutdown)
    }
}

fn spawn_status_worker<R: Runtime>(
    app: AppHandle<R>,
    kilnd_url: NormalizedKilndUrl,
    coordinator: Arc<RefreshCoordinator>,
) {
    std::thread::Builder::new()
        .name("kilnd-tray-refresh".to_string())
        .spawn(move || {
            let client = KilndClient::new(kilnd_url);
            let mut last_state: Option<TrayDisplayState> = None;
            let mut last_version: Option<String> = None;
            let mut last_event_id: Option<String> = None;
            let (mut seen_epoch, mut shutdown) = coordinator.snapshot();

            while !shutdown {
                let (raw_state, daemon_version) = client.probe_tray_snapshot();
                let current_state = if raw_state.is_online() {
                    coordinator.clear_start_action();
                    raw_state
                } else {
                    raw_state.apply_start_action(&coordinator.start_action())
                };
                if last_state.as_ref() != Some(&current_state) || last_version != daemon_version {
                    update_tray_display(&app, &current_state, daemon_version.as_deref());
                    last_state = Some(current_state.clone());
                    last_version = daemon_version.clone();
                }

                if current_state.is_online() {
                    if let Ok(mut sse) = client.open_sse_stream(last_event_id.as_deref()) {
                        let mut idle_ticks: u32 = 0;
                        let mut pending_sse_refresh = false;
                        let mut last_refresh = Instant::now();

                        loop {
                            let (epoch, is_shutdown) = coordinator.snapshot();
                            if is_shutdown {
                                shutdown = true;
                                break;
                            }
                            if epoch != seen_epoch {
                                seen_epoch = epoch;
                                break;
                            }

                            match sse.next_event(SSE_POLL_SLICE) {
                                SsePollResult::Event(frame) => {
                                    idle_ticks = 0;
                                    pending_sse_refresh = true;
                                    if let Some(id) = frame.id {
                                        last_event_id = Some(id);
                                    }
                                    if last_refresh.elapsed() >= Duration::from_millis(250) {
                                        pending_sse_refresh = false;
                                        let (refreshed, refreshed_version) = client.probe_tray_snapshot();
                                        last_refresh = Instant::now();
                                        if last_state.as_ref() != Some(&refreshed)
                                            || last_version != refreshed_version
                                        {
                                            update_tray_display(
                                                &app,
                                                &refreshed,
                                                refreshed_version.as_deref(),
                                            );
                                            last_state = Some(refreshed);
                                            last_version = refreshed_version;
                                        }
                                        if !last_state
                                            .as_ref()
                                            .map(TrayDisplayState::is_online)
                                            .unwrap_or(false)
                                        {
                                            break;
                                        }
                                    }
                                }
                                SsePollResult::Timeout => {
                                    if pending_sse_refresh {
                                        pending_sse_refresh = false;
                                        let (refreshed, refreshed_version) = client.probe_tray_snapshot();
                                        last_refresh = Instant::now();
                                        if last_state.as_ref() != Some(&refreshed)
                                            || last_version != refreshed_version
                                        {
                                            update_tray_display(
                                                &app,
                                                &refreshed,
                                                refreshed_version.as_deref(),
                                            );
                                            last_state = Some(refreshed);
                                            last_version = refreshed_version;
                                        }
                                        if !last_state
                                            .as_ref()
                                            .map(TrayDisplayState::is_online)
                                            .unwrap_or(false)
                                        {
                                            break;
                                        }
                                        continue;
                                    }
                                    idle_ticks = idle_ticks.saturating_add(1);
                                    if idle_ticks >= SSE_HEALTH_HEARTBEAT_TICKS {
                                        idle_ticks = 0;
                                        if client.fetch_health().is_err() {
                                            break;
                                        }
                                    }
                                }
                                SsePollResult::Closed(reason) => {
                                    eprintln!("kiln-desktop: {reason}");
                                    break;
                                }
                            }
                        }
                        continue;
                    }
                }

                let (next_epoch, next_shutdown) =
                    coordinator.wait_for_change(seen_epoch, OFFLINE_POLL_INTERVAL);
                seen_epoch = next_epoch;
                shutdown = next_shutdown;
            }
        })
        .expect("failed to spawn kilnd tray status thread");
}

pub(crate) fn ensure_kilnd_and_open_window<R: Runtime>(
    app: &AppHandle<R>,
    kilnd_url: &NormalizedKilndUrl,
    coordinator: &Arc<RefreshCoordinator>,
    route: Option<WorkbenchRoute>,
) {
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_some() {
        if let Err(err) = open_or_focus_main_window(app, &kilnd_url.base_url, route) {
            eprintln!("kiln-desktop: failed to focus workbench window: {err}");
        }
        return;
    }

    let url = kilnd_url.clone();
    let coord = Arc::clone(coordinator);
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let online = KilndClient::new(url.clone()).fetch_health().is_ok();
        match decide_startup_window_action(online) {
            StartupWindowAction::OpenImmediately => {
                let handle_for_main = app_handle.clone();
                let base_url = url.base_url;
                if let Err(err) = app_handle.run_on_main_thread(move || {
                    if let Err(open_err) =
                        open_or_focus_main_window(&handle_for_main, &base_url, route)
                    {
                        eprintln!("kiln-desktop: failed to open workbench window: {open_err}");
                    }
                }) {
                    eprintln!(
                        "kiln-desktop: failed to dispatch window open to main thread: {err}"
                    );
                }
            }
            StartupWindowAction::AutoStartThenOpen => {
                if !coord.begin_start_kilnd() {
                    return;
                }
                let outcome = spawn_kiln_up(&url).map(|_| ());
                let succeeded = outcome.is_ok();
                if let Err(ref err) = outcome {
                    eprintln!("kiln-desktop: {err}");
                }
                coord.finish_start_kilnd(outcome);
                if succeeded {
                    let handle_for_main = app_handle.clone();
                    let base_url = url.base_url;
                    if let Err(err) = app_handle.run_on_main_thread(move || {
                        if let Err(open_err) =
                            open_or_focus_main_window(&handle_for_main, &base_url, route)
                        {
                            eprintln!(
                                "kiln-desktop: failed to open workbench window after autostart: {open_err}"
                            );
                        }
                    }) {
                        eprintln!(
                            "kiln-desktop: failed to dispatch window open to main thread: {err}"
                        );
                    }
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let kilnd_url = match resolve_kilnd_url() {
        Ok(url) => url,
        Err(err) => {
            eprintln!("kiln-desktop: {err}");
            std::process::exit(2);
        }
    };

    let coordinator = Arc::new(RefreshCoordinator::new());
    let allow_exit = Arc::new(AtomicBool::new(false));

    let coordinator_for_setup = Arc::clone(&coordinator);
    let allow_exit_for_setup = Arc::clone(&allow_exit);
    let kilnd_url_for_setup = kilnd_url.clone();
    #[cfg(target_os = "macos")]
    let kilnd_url_for_reopen = kilnd_url.clone();
    #[cfg(target_os = "macos")]
    let coordinator_for_reopen = Arc::clone(&coordinator);

    let app = tauri::Builder::default()
        .setup(move |app| {
            let url_for_shortcut = kilnd_url_for_setup.clone();
            let coordinator_for_shortcut = Arc::clone(&coordinator_for_setup);
            #[cfg(desktop)]
            {
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app_handle, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                ensure_kilnd_and_open_window(
                                    app_handle,
                                    &url_for_shortcut,
                                    &coordinator_for_shortcut,
                                    None,
                                );
                            }
                        })
                        .build(),
                )?;

                if let Err(err) = app.global_shortcut().register(GLOBAL_WORKBENCH_SHORTCUT) {
                    eprintln!(
                        "kiln-desktop: failed to register global shortcut {GLOBAL_WORKBENCH_SHORTCUT}: {err}"
                    );
                }
            }

            #[cfg(target_os = "macos")]
            setup_app_menu(app.handle())?;

            setup_tray(app.handle(), kilnd_url_for_setup.clone())?;

            let url_for_menu = kilnd_url_for_setup.clone();
            let coordinator_for_menu = Arc::clone(&coordinator_for_setup);
            let allow_exit_for_menu = Arc::clone(&allow_exit_for_setup);
            app.on_menu_event(move |app_handle, event| {
                handle_menu_event(
                    app_handle,
                    event.id().as_ref(),
                    &url_for_menu,
                    &coordinator_for_menu,
                    &allow_exit_for_menu,
                );
            });

            spawn_status_worker(
                app.handle().clone(),
                kilnd_url_for_setup.clone(),
                Arc::clone(&coordinator_for_setup),
            );

            ensure_kilnd_and_open_window(
                app.handle(),
                &kilnd_url_for_setup,
                &coordinator_for_setup,
                None,
            );

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Kiln desktop application");

    app.run(move |app_handle, event| {
        #[cfg(not(target_os = "macos"))]
        let _ = &app_handle;

        match event {
            RunEvent::ExitRequested { code, api, .. } => {
                if should_prevent_exit(code, allow_exit.load(Ordering::SeqCst)) {
                    api.prevent_exit();
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                ensure_kilnd_and_open_window(
                    app_handle,
                    &kilnd_url_for_reopen,
                    &coordinator_for_reopen,
                    None,
                );
            }
            RunEvent::Exit => {
                coordinator.request_shutdown();
            }
            _ => {}
        }
    });
}
