mod daemon_client;
mod model;
mod tray;
mod window_manager;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, RunEvent, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::daemon_client::{resolve_kilnd_url, KilndClient, SsePollResult};
use crate::model::{NormalizedKilndUrl, StartActionState, TrayDisplayState};
use crate::tray::{setup_tray, update_tray_display};
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
            let mut last_event_id: Option<String> = None;
            let (mut seen_epoch, mut shutdown) = coordinator.snapshot();

            while !shutdown {
                let raw_state = client.probe_tray_state();
                let current_state = if raw_state.is_online() {
                    coordinator.clear_start_action();
                    raw_state
                } else {
                    raw_state.apply_start_action(&coordinator.start_action())
                };
                if last_state.as_ref() != Some(&current_state) {
                    update_tray_display(&app, &current_state);
                    last_state = Some(current_state.clone());
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
                                        let refreshed = client.probe_tray_state();
                                        last_refresh = Instant::now();
                                        if last_state.as_ref() != Some(&refreshed) {
                                            update_tray_display(&app, &refreshed);
                                            last_state = Some(refreshed);
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
                                        let refreshed = client.probe_tray_state();
                                        last_refresh = Instant::now();
                                        if last_state.as_ref() != Some(&refreshed) {
                                            update_tray_display(&app, &refreshed);
                                            last_state = Some(refreshed);
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

    let app = tauri::Builder::default()
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let url_for_shortcut = kilnd_url.base_url.clone();
            #[cfg(desktop)]
            {
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app_handle, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                if let Err(err) =
                                    open_or_focus_main_window(app_handle, &url_for_shortcut)
                                {
                                    eprintln!(
                                        "kiln-desktop: failed to open workbench on shortcut: {err}"
                                    );
                                }
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

            setup_tray(
                app.handle(),
                kilnd_url.clone(),
                Arc::clone(&coordinator_for_setup),
                Arc::clone(&allow_exit_for_setup),
            )?;

            spawn_status_worker(
                app.handle().clone(),
                kilnd_url,
                Arc::clone(&coordinator_for_setup),
            );

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Kiln desktop application");

    app.run(move |_app_handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if !allow_exit.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            coordinator.request_shutdown();
        }
        _ => {}
    });
}
