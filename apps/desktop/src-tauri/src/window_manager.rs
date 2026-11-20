use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::model::{
    close_policy_for_window, is_allowed_navigation_url, validate_kilnd_url, WindowClosePolicy,
    MAIN_WINDOW_LABEL,
};

pub fn open_or_focus_main_window<R: Runtime>(
    app: &AppHandle<R>,
    raw_url: &str,
) -> Result<(), String> {
    let validated = validate_kilnd_url(raw_url)
        .map_err(|err| format!("blocked non-loopback kilnd URL ({raw_url}): {err}"))?;

    if let Some(existing) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let target_url = Url::parse(&validated.base_url)
        .map_err(|err| format!("failed to parse validated kilnd URL: {err}"))?;
    let allowed_origin = validated;

    let window = WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW_LABEL,
        WebviewUrl::External(target_url),
    )
    .title("Kiln")
    .inner_size(1200.0, 800.0)
    .min_inner_size(390.0, 600.0)
    .resizable(true)
    .center()
    .on_navigation(move |nav_url| is_allowed_navigation_url(nav_url.as_str(), &allowed_origin))
    .build()
    .map_err(|err| format!("failed to open Kiln workbench window: {err}"))?;

    let window_for_events = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            match close_policy_for_window(MAIN_WINDOW_LABEL) {
                WindowClosePolicy::Destroy => {
                    api.prevent_close();
                    if let Err(err) = window_for_events.destroy() {
                        eprintln!("kiln-desktop: failed to destroy main window: {err}");
                    }
                }
                WindowClosePolicy::Hide => {
                    api.prevent_close();
                    let _ = window_for_events.hide();
                }
            }
        }
    });

    let _ = window.set_focus();
    Ok(())
}

pub fn destroy_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(err) = window.destroy() {
            eprintln!("kiln-desktop: failed to destroy main window on exit: {err}");
        }
    }
}
