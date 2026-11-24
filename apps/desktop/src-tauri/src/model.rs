use std::env;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};

pub const DEFAULT_KILND_URL: &str = "http://127.0.0.1:4310";
pub const MAIN_WINDOW_LABEL: &str = "main";
pub const KILN_BIN_NAME_POSIX: &str = "kiln";
pub const KILN_BIN_NAME_WINDOWS: &str = "kiln.exe";
pub const DESKTOP_APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_JSON_DEPTH: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KilnHealth {
    pub ok: bool,
    #[allow(dead_code)]
    pub pid: Option<u64>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KilnLiveRatesTotals {
    pub cost_usd: f64,
    pub tok_per_sec: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KilnBootstrapSummary {
    pub running_count: u64,
    pub pending_decision_count: usize,
    pub task_count: usize,
    pub totals: KilnLiveRatesTotals,
}

/// Pending or failed background `kiln up` action triggered from the tray menu.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum StartActionState {
    #[default]
    Idle,
    Starting,
    Failed(String),
}

/// Mutually exclusive state for the tray "install CLI command" menu action.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum CliInstallActionState {
    #[default]
    Idle,
    Installed {
        bin_dir: String,
        in_path: bool,
    },
    Failed(String),
}

/// Mutually exclusive desktop tray states projected from `kilnd` health & bootstrap data.
#[derive(Debug, Clone, PartialEq)]
pub enum TrayDisplayState {
    Offline {
        reason: Option<String>,
    },
    Starting,
    StartFailed {
        error: String,
    },
    Idle {
        cost_usd: f64,
        task_count: usize,
    },
    Running {
        running_count: u64,
        tok_per_sec: f64,
        cost_usd: f64,
    },
    WaitingDecision {
        pending_decisions: usize,
        running_count: u64,
        tok_per_sec: f64,
        cost_usd: f64,
    },
}

impl TrayDisplayState {
    pub fn from_bootstrap(summary: &KilnBootstrapSummary) -> Self {
        if summary.pending_decision_count > 0 {
            Self::WaitingDecision {
                pending_decisions: summary.pending_decision_count,
                running_count: summary.running_count,
                tok_per_sec: sanitize_non_negative(summary.totals.tok_per_sec),
                cost_usd: sanitize_non_negative(summary.totals.cost_usd),
            }
        } else if summary.running_count > 0 {
            Self::Running {
                running_count: summary.running_count,
                tok_per_sec: sanitize_non_negative(summary.totals.tok_per_sec),
                cost_usd: sanitize_non_negative(summary.totals.cost_usd),
            }
        } else {
            Self::Idle {
                cost_usd: sanitize_non_negative(summary.totals.cost_usd),
                task_count: summary.task_count,
            }
        }
    }

    pub fn from_probe(
        health: Result<&KilnHealth, &str>,
        bootstrap: Option<&KilnBootstrapSummary>,
    ) -> Self {
        match health {
            Err(reason) => Self::Offline {
                reason: non_empty_trimmed(reason),
            },
            Ok(h) if !h.ok => Self::Offline {
                reason: Some("kilnd ok=false".to_string()),
            },
            Ok(_) => match bootstrap {
                Some(summary) => Self::from_bootstrap(summary),
                None => Self::Idle {
                    cost_usd: 0.0,
                    task_count: 0,
                },
            },
        }
    }

    pub fn is_online(&self) -> bool {
        matches!(
            self,
            Self::Idle { .. } | Self::Running { .. } | Self::WaitingDecision { .. }
        )
    }

    /// Applies the transient menu-driven start action only while `kilnd` remains offline.
    pub fn apply_start_action(self, action: &StartActionState) -> Self {
        if self.is_online() {
            return self;
        }
        match action {
            StartActionState::Idle => self,
            StartActionState::Starting => Self::Starting,
            StartActionState::Failed(err) => Self::StartFailed { error: err.clone() },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEventFrame {
    pub id: Option<String>,
    #[allow(dead_code)]
    pub event: Option<String>,
    #[allow(dead_code)]
    pub data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowClosePolicy {
    Destroy,
    #[allow(dead_code)]
    Hide,
}

/// Main workbench WebView must be destroyed on close so WKWebView memory is reclaimed.
pub fn close_policy_for_window(label: &str) -> WindowClosePolicy {
    match label {
        MAIN_WINDOW_LABEL => WindowClosePolicy::Destroy,
        _ => WindowClosePolicy::Destroy,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupWindowAction {
    OpenImmediately,
    AutoStartThenOpen,
}

/// Decides whether startup/open-workbench can show the window right away or must first start `kilnd`.
pub fn decide_startup_window_action(kilnd_online: bool) -> StartupWindowAction {
    if kilnd_online {
        StartupWindowAction::OpenImmediately
    } else {
        StartupWindowAction::AutoStartThenOpen
    }
}

/// Keeps the desktop shell alive when the last WebView window is destroyed (`code == None`),
/// while allowing programmatic `app.exit(...)` shutdowns (`code == Some(_)`) or explicit quit.
pub fn should_prevent_exit(exit_code: Option<i32>, allow_exit: bool) -> bool {
    exit_code.is_none() && !allow_exit
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkbenchRoute {
    Board,
    Intake,
    Inbox,
    Lineup,
    Ledger,
    Usage,
    Settings,
}

impl WorkbenchRoute {
    pub const fn hash_fragment(self) -> &'static str {
        match self {
            Self::Board => "view=board",
            Self::Intake => "view=intake",
            Self::Inbox => "view=inbox",
            Self::Lineup => "view=lineup",
            Self::Ledger => "view=ledger",
            Self::Usage => "view=usage",
            Self::Settings => "view=settings",
        }
    }
}

pub fn build_workbench_url(origin: &NormalizedKilndUrl, route: Option<WorkbenchRoute>) -> String {
    match route {
        None => origin.base_url.clone(),
        Some(r) => format!("{}/#{}", origin.base_url, r.hash_fragment()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedKilndUrl {
    pub host: String,
    pub port: u16,
    pub base_url: String,
}

impl NormalizedKilndUrl {
    #[allow(dead_code)]
    pub fn endpoint_url(&self, path: &str) -> String {
        if path.starts_with('/') {
            format!("{}{}", self.base_url, path)
        } else {
            format!("{}/{}", self.base_url, path)
        }
    }

    pub fn tcp_host_port(&self) -> (&str, u16) {
        (self.host.as_str(), self.port)
    }

    pub fn host_header(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlValidationError {
    Empty,
    ControlOrWhitespace,
    UnsupportedScheme,
    UserinfoNotAllowed,
    InvalidAuthority,
    NonLoopbackHost,
    InvalidPort,
    UnexpectedPathOrSuffix,
}

impl fmt::Display for UrlValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("kilnd URL must not be empty"),
            Self::ControlOrWhitespace => {
                f.write_str("kilnd URL must not contain whitespace or control characters")
            }
            Self::UnsupportedScheme => f.write_str("kilnd URL must use http:// scheme"),
            Self::UserinfoNotAllowed => f.write_str("kilnd URL must not contain userinfo (@)"),
            Self::InvalidAuthority => f.write_str("kilnd URL contains an invalid authority"),
            Self::NonLoopbackHost => {
                f.write_str("kilnd URL host must be strictly 127.0.0.1 or localhost")
            }
            Self::InvalidPort => f.write_str("kilnd URL port must be an integer between 1 and 65535"),
            Self::UnexpectedPathOrSuffix => {
                f.write_str("kilnd base URL must not include path segments, query, or fragment")
            }
        }
    }
}

impl Error for UrlValidationError {}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedAuthority {
    host: String,
    port: u16,
    has_explicit_port: bool,
}

fn check_raw_url_common(raw: &str) -> Result<&str, UrlValidationError> {
    if raw.is_empty() {
        return Err(UrlValidationError::Empty);
    }
    if raw.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err(UrlValidationError::ControlOrWhitespace);
    }
    if raw.contains('\\') {
        return Err(UrlValidationError::InvalidAuthority);
    }
    let Some(prefix) = raw.get(..7) else {
        return Err(UrlValidationError::UnsupportedScheme);
    };
    if !prefix.eq_ignore_ascii_case("http://") {
        return Err(UrlValidationError::UnsupportedScheme);
    }
    Ok(&raw[7..])
}

fn split_authority_and_suffix(rest: &str) -> (&str, &str) {
    match rest.find(['/', '?', '#']) {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    }
}

fn parse_loopback_authority(authority: &str) -> Result<ParsedAuthority, UrlValidationError> {
    if authority.is_empty() {
        return Err(UrlValidationError::InvalidAuthority);
    }
    if authority.contains('@') {
        return Err(UrlValidationError::UserinfoNotAllowed);
    }
    if authority.starts_with('[') || authority.ends_with(']') {
        return Err(UrlValidationError::NonLoopbackHost);
    }

    let mut parts = authority.split(':');
    let host_raw = parts.next().unwrap_or("");
    let port_raw = parts.next();
    if parts.next().is_some() {
        return Err(UrlValidationError::InvalidAuthority);
    }
    if host_raw.is_empty() {
        return Err(UrlValidationError::InvalidAuthority);
    }

    let host_lower = host_raw.to_ascii_lowercase();
    if host_lower != "127.0.0.1" && host_lower != "localhost" {
        return Err(UrlValidationError::NonLoopbackHost);
    }

    let (port, has_explicit_port) = match port_raw {
        None => (80_u16, false),
        Some(port_str) => {
            if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
                return Err(UrlValidationError::InvalidPort);
            }
            let parsed = port_str
                .parse::<u16>()
                .map_err(|_| UrlValidationError::InvalidPort)?;
            if parsed == 0 {
                return Err(UrlValidationError::InvalidPort);
            }
            (parsed, true)
        }
    };

    Ok(ParsedAuthority {
        host: host_lower,
        port,
        has_explicit_port,
    })
}

/// Validates a `kilnd` base URL: strictly `http://127.0.0.1[:port][/]` or `http://localhost[:port][/]`.
pub fn validate_kilnd_url(raw: &str) -> Result<NormalizedKilndUrl, UrlValidationError> {
    let rest = check_raw_url_common(raw)?;
    let (authority, suffix) = split_authority_and_suffix(rest);
    if !suffix.is_empty() && suffix != "/" {
        return Err(UrlValidationError::UnexpectedPathOrSuffix);
    }

    let parsed = parse_loopback_authority(authority)?;
    let base_url = if parsed.has_explicit_port {
        format!("http://{}:{}", parsed.host, parsed.port)
    } else {
        format!("http://{}", parsed.host)
    };

    Ok(NormalizedKilndUrl {
        host: parsed.host,
        port: parsed.port,
        base_url,
    })
}

#[allow(dead_code)]
pub fn is_allowed_kilnd_url(raw: &str) -> bool {
    validate_kilnd_url(raw).is_ok()
}

/// Validates in-WebView navigation targets against the allowed loopback `kilnd` origin.
pub fn is_allowed_navigation_url(raw: &str, allowed_origin: &NormalizedKilndUrl) -> bool {
    let Ok(rest) = check_raw_url_common(raw) else {
        return false;
    };
    let (authority, _suffix) = split_authority_and_suffix(rest);
    let Ok(parsed) = parse_loopback_authority(authority) else {
        return false;
    };
    parsed.host == allowed_origin.host && parsed.port == allowed_origin.port
}

/// Maps raw CLI / spawn failures to concise, actionable Chinese menu status text.
pub fn summarize_start_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("unable to locate") && lower.contains("kiln") {
        return "未找到 kiln CLI，请先安装 @zzf2333/kiln".to_string();
    }
    if lower.contains("kiln_bin points to missing file") {
        return "KILN_BIN 指向的文件不存在".to_string();
    }
    if lower.contains("env: node:")
        || lower.contains("node: no such file")
        || lower.contains("cannot find node")
    {
        return "未找到 Node.js (>=22)，请先安装 Node.js".to_string();
    }

    let first_line = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let stripped = first_line
        .strip_prefix("kiln up failed:")
        .map(str::trim)
        .unwrap_or(first_line);
    let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return "未知启动错误".to_string();
    }
    if collapsed.chars().count() > 72 {
        let truncated: String = collapsed.chars().take(71).collect();
        return format!("{truncated}…");
    }
    collapsed
}

pub fn format_tray_title(state: &TrayDisplayState) -> String {
    match state {
        TrayDisplayState::Offline { .. } => "离线".to_string(),
        TrayDisplayState::Starting => "启动中…".to_string(),
        TrayDisplayState::StartFailed { .. } => "启动失败".to_string(),
        TrayDisplayState::Idle { .. } => String::new(),
        TrayDisplayState::Running {
            running_count,
            tok_per_sec,
            ..
        } => {
            let rate = sanitize_non_negative(*tok_per_sec);
            if rate >= 1.0 {
                format!("{running_count} 运行 · {rate:.0} tok/s")
            } else {
                format!("{running_count} 运行")
            }
        }
        TrayDisplayState::WaitingDecision {
            pending_decisions,
            running_count,
            ..
        } => {
            if *running_count > 0 {
                format!("{pending_decisions} 待决 · {running_count} 运行")
            } else {
                format!("{pending_decisions} 待决")
            }
        }
    }
}

pub fn format_tray_tooltip(state: &TrayDisplayState, kilnd_url: &str) -> String {
    match state {
        TrayDisplayState::Offline { reason } => match reason {
            Some(detail) if !detail.trim().is_empty() => {
                format!("Kiln · kilnd 未运行（{}）— {kilnd_url}", detail.trim())
            }
            _ => format!("Kiln · kilnd 离线 — {kilnd_url}"),
        },
        TrayDisplayState::Starting => format!("Kiln · 正在启动 kilnd… — {kilnd_url}"),
        TrayDisplayState::StartFailed { error } => format!(
            "Kiln · 启动 kilnd 失败（{}）— {kilnd_url}",
            summarize_start_error(error)
        ),
        TrayDisplayState::Idle {
            cost_usd,
            task_count,
        } => format!(
            "Kiln · 待机（任务 {task_count} 个 · 累计 ${:.2}）— {kilnd_url}",
            sanitize_non_negative(*cost_usd)
        ),
        TrayDisplayState::Running {
            running_count,
            tok_per_sec,
            cost_usd,
        } => format!(
            "Kiln · 运行中：{running_count} 个任务 · {:.1} tok/s · 累计 ${:.2}",
            sanitize_non_negative(*tok_per_sec),
            sanitize_non_negative(*cost_usd)
        ),
        TrayDisplayState::WaitingDecision {
            pending_decisions,
            running_count,
            tok_per_sec,
            cost_usd,
        } => format!(
            "Kiln · 待决拍板：{pending_decisions} 项 · 运行中 {running_count} 个 · {:.1} tok/s · 累计 ${:.2}",
            sanitize_non_negative(*tok_per_sec),
            sanitize_non_negative(*cost_usd)
        ),
    }
}

pub fn format_tray_header(app_version: &str, daemon_version: Option<&str>) -> String {
    format!(
        "Kiln 工作台 · {}",
        format_tray_version_tag(app_version, daemon_version)
    )
}

pub fn format_tray_menu_status(state: &TrayDisplayState) -> String {
    match state {
        TrayDisplayState::Offline { .. } => "后台引擎未运行".to_string(),
        TrayDisplayState::Starting => "正在启动后台引擎…".to_string(),
        TrayDisplayState::StartFailed { error } => {
            format!("后台引擎启动失败：{}", summarize_start_error(error))
        }
        TrayDisplayState::Idle {
            cost_usd,
            task_count,
        } => format!(
            "待机 · {task_count} 个任务 · 累计 ${:.2}",
            sanitize_non_negative(*cost_usd)
        ),
        TrayDisplayState::Running {
            running_count,
            tok_per_sec,
            cost_usd,
        } => format!(
            "运行中 · {running_count} 个任务 · {:.0} tok/s · ${:.2}",
            sanitize_non_negative(*tok_per_sec),
            sanitize_non_negative(*cost_usd)
        ),
        TrayDisplayState::WaitingDecision {
            pending_decisions,
            running_count,
            cost_usd,
            ..
        } => {
            let cost = sanitize_non_negative(*cost_usd);
            if *running_count > 0 {
                format!("{pending_decisions} 项待决 · {running_count} 个运行中 · ${cost:.2}")
            } else {
                format!("{pending_decisions} 项待决 · ${cost:.2}")
            }
        }
    }
}

pub fn format_inbox_menu_label(state: &TrayDisplayState) -> String {
    match state {
        TrayDisplayState::WaitingDecision {
            pending_decisions, ..
        } if *pending_decisions > 0 => format!("等你决定（{pending_decisions}）"),
        _ => "等你决定".to_string(),
    }
}

pub fn format_engine_submenu_label(state: &TrayDisplayState) -> &'static str {
    match state {
        TrayDisplayState::Offline { .. } => "后台引擎（未运行）",
        TrayDisplayState::Starting => "后台引擎（启动中…）",
        TrayDisplayState::StartFailed { .. } => "后台引擎（启动失败）",
        TrayDisplayState::Idle { .. }
        | TrayDisplayState::Running { .. }
        | TrayDisplayState::WaitingDecision { .. } => "后台引擎（运行中）",
    }
}

pub fn format_tray_version_tag(app_version: &str, daemon_version: Option<&str>) -> String {
    let clean_app = app_version.trim().trim_start_matches('v');
    let app_label = if clean_app.is_empty() {
        "unknown"
    } else {
        clean_app
    };
    match daemon_version
        .map(|v| v.trim().trim_start_matches('v'))
        .filter(|v| !v.is_empty())
    {
        Some(daemon) if daemon != app_label => format!("App v{app_label} / kilnd v{daemon}"),
        _ => format!("v{app_label}"),
    }
}

#[allow(dead_code)]
pub fn format_tray_menu_status_with_version(
    state: &TrayDisplayState,
    app_version: &str,
    daemon_version: Option<&str>,
) -> String {
    format!(
        "{} · {}",
        format_tray_menu_status(state),
        format_tray_version_tag(app_version, daemon_version)
    )
}

pub fn format_tray_tooltip_with_version(
    state: &TrayDisplayState,
    kilnd_url: &str,
    app_version: &str,
    daemon_version: Option<&str>,
) -> String {
    let base = format_tray_tooltip(state, kilnd_url);
    let tag = format_tray_version_tag(app_version, daemon_version);
    if let Some(rest) = base.strip_prefix("Kiln · ") {
        format!("Kiln {tag} · {rest}")
    } else {
        format!("{base} · {tag}")
    }
}

pub fn format_start_menu_label(state: &TrayDisplayState) -> &'static str {
    match state {
        TrayDisplayState::Starting => "正在启动 kilnd…",
        TrayDisplayState::StartFailed { .. } => "重试启动 kilnd",
        _ => "启动 kilnd",
    }
}

pub fn is_start_menu_enabled(state: &TrayDisplayState) -> bool {
    matches!(
        state,
        TrayDisplayState::Offline { .. } | TrayDisplayState::StartFailed { .. }
    )
}

pub fn format_install_cli_menu_label(state: &CliInstallActionState) -> String {
    match state {
        CliInstallActionState::Idle => "安装 kiln 终端命令".to_string(),
        CliInstallActionState::Installed { bin_dir, in_path } => {
            if *in_path {
                format!("已安装 kiln 终端命令（{bin_dir}）")
            } else {
                format!("已安装 kiln 终端命令（请将 {bin_dir} 加入 PATH）")
            }
        }
        CliInstallActionState::Failed(err) => {
            format!("安装终端命令失败（{}）", summarize_start_error(err))
        }
    }
}

pub fn platform_kiln_binary_name(is_windows: bool) -> &'static str {
    if is_windows {
        KILN_BIN_NAME_WINDOWS
    } else {
        KILN_BIN_NAME_POSIX
    }
}

pub fn platform_kiln_binary_names(is_windows: bool) -> &'static [&'static str] {
    if is_windows {
        &["kiln.exe", "kiln.cmd"]
    } else {
        &["kiln"]
    }
}

/// Resolves the sibling sidecar path next to the desktop executable (`kiln` on POSIX, `kiln.exe` on Windows).
/// Returns `None` if the desktop executable itself shares the sidecar filename to avoid self-recursion.
pub fn sidecar_candidate_path(current_exe: Option<&Path>, is_windows: bool) -> Option<PathBuf> {
    let exe = current_exe?;
    let dir = exe.parent()?;
    if dir.as_os_str().is_empty() {
        return None;
    }
    let sidecar_name = platform_kiln_binary_name(is_windows);
    if let Some(exe_name) = exe.file_name().and_then(|n| n.to_str()) {
        let same_name = if is_windows {
            exe_name.eq_ignore_ascii_case(sidecar_name)
        } else {
            exe_name == sidecar_name
        };
        if same_name {
            return None;
        }
    }
    Some(dir.join(sidecar_name))
}

/// Ordered user-level CLI install directories searched on Windows without requiring UAC.
pub fn windows_kiln_search_dirs(
    local_app_data: Option<&Path>,
    home_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(local) = local_app_data {
        if !local.as_os_str().is_empty() {
            push_unique_dir(&mut dirs, local.join("Kiln").join("bin"));
        }
    }
    if let Some(home) = home_dir {
        if !home.as_os_str().is_empty() {
            push_unique_dir(&mut dirs, home.join("AppData").join("Local").join("Kiln").join("bin"));
            push_unique_dir(&mut dirs, home.join(".local").join("bin"));
            push_unique_dir(&mut dirs, home.join("AppData").join("Roaming").join("npm"));
        }
    }
    dirs
}

/// Renders a user-local Windows `.cmd` shim invoking the sidecar binary cleanly without UAC.
/// Uses `call` when delegating to another `.cmd`/`.bat` file so exit codes propagate properly.
#[allow(dead_code)]
pub fn render_windows_cli_shim(target_exe: &Path) -> Result<String, String> {
    let raw = target_exe
        .to_str()
        .ok_or_else(|| "sidecar path is not valid UTF-8".to_string())?;
    if raw.trim().is_empty() {
        return Err("sidecar path must not be empty".to_string());
    }
    if raw.bytes().any(|b| b < 0x20 || b == 0x7f || b == b'"') {
        return Err("sidecar path contains forbidden control or quote characters".to_string());
    }
    let escaped = raw.replace('%', "%%");
    let lower = raw.to_ascii_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        Ok(format!("@echo off\r\ncall \"{escaped}\" %*\r\n"))
    } else {
        Ok(format!("@echo off\r\n\"{escaped}\" %*\r\n"))
    }
}

fn normalize_dir_for_path_compare(dir: &Path, case_insensitive: bool) -> String {
    let s = dir.to_string_lossy();
    let trimmed = s.trim_end_matches(['/', '\\']);
    let effective = if trimmed.is_empty() { s.as_ref() } else { trimmed };
    if case_insensitive {
        effective.to_ascii_lowercase()
    } else {
        effective.to_string()
    }
}

pub fn path_contains_dir(
    path_env: Option<&OsStr>,
    target_dir: &Path,
    case_insensitive: bool,
) -> bool {
    let Some(raw) = path_env else {
        return false;
    };
    let needle = normalize_dir_for_path_compare(target_dir, case_insensitive);
    env::split_paths(raw).any(|entry| {
        !entry.as_os_str().is_empty()
            && normalize_dir_for_path_compare(&entry, case_insensitive) == needle
    })
}

const SYSTEM_PATH_DIRS: &[&str] = &["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

fn push_unique_dir(out: &mut Vec<PathBuf>, dir: PathBuf) {
    if !dir.as_os_str().is_empty() && !out.contains(&dir) {
        out.push(dir);
    }
}

fn is_system_path_dir(dir: &Path) -> bool {
    SYSTEM_PATH_DIRS.iter().any(|sys| dir == Path::new(sys))
}

/// Parses directory names such as `24.20.0`, `v22.19`, or `24.0.0-rc.1` for descending version sort.
pub fn parse_semver_key(name: &str) -> Option<(u64, u64, u64)> {
    let trimmed = name.trim();
    let without_v = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
    let core = without_v.split('-').next().unwrap_or("");
    if core.is_empty() {
        return None;
    }

    let mut parts = core.split('.');
    let major = parse_numeric_part(parts.next()?)?;
    let minor = match parts.next() {
        Some(p) => parse_numeric_part(p)?,
        None => 0,
    };
    let patch = match parts.next() {
        Some(p) => parse_numeric_part(p)?,
        None => 0,
    };
    if parts.next().is_some() {
        return None;
    }

    Some((major, minor, patch))
}

fn parse_numeric_part(part: &str) -> Option<u64> {
    if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    part.parse::<u64>().ok()
}

/// Ordered search directories for locating the `kiln` CLI outside the caller's shell `PATH`.
pub fn standard_kiln_search_dirs(
    home_dir: Option<&Path>,
    versioned_node_bins: &[PathBuf],
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    push_unique_dir(&mut dirs, PathBuf::from("/opt/homebrew/bin"));
    push_unique_dir(&mut dirs, PathBuf::from("/usr/local/bin"));

    if let Some(home) = home_dir {
        if !home.as_os_str().is_empty() {
            for rel in [
                ".local/bin",
                ".npm-global/bin",
                ".volta/bin",
                ".asdf/shims",
                "Library/pnpm",
                ".local/share/pnpm",
                ".local/share/mise/installs/node/global/bin",
                ".local/share/mise/installs/node/lts/bin",
                ".local/share/mise/installs/node/latest/bin",
                ".local/share/mise/shims",
                ".nvm/current/bin",
                ".fnm/current/bin",
            ] {
                push_unique_dir(&mut dirs, home.join(rel));
            }
        }
    }

    for dir in versioned_node_bins {
        push_unique_dir(&mut dirs, dir.clone());
    }

    dirs
}

/// Builds an enriched child `PATH` list so Finder-launched apps can resolve `#!/usr/bin/env node` and local agent CLIs.
pub fn build_child_command_path_dirs(
    bin_dir: Option<&Path>,
    current_path: Option<&OsStr>,
    home_dir: Option<&Path>,
    versioned_node_bins: &[PathBuf],
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(dir) = bin_dir {
        push_unique_dir(&mut dirs, dir.to_path_buf());
    }

    let existing_entries: Vec<PathBuf> = current_path
        .map(|raw| env::split_paths(raw).filter(|p| !p.as_os_str().is_empty()).collect())
        .unwrap_or_default();

    for dir in &existing_entries {
        if !is_system_path_dir(dir) {
            push_unique_dir(&mut dirs, dir.clone());
        }
    }

    if let Some(home) = home_dir {
        if !home.as_os_str().is_empty() {
            for rel in [
                ".local/share/mise/installs/node/global/bin",
                ".local/share/mise/installs/node/lts/bin",
                ".local/share/mise/installs/node/latest/bin",
                ".local/share/mise/shims",
                ".volta/bin",
                ".asdf/shims",
                ".nvm/current/bin",
                ".fnm/current/bin",
            ] {
                push_unique_dir(&mut dirs, home.join(rel));
            }
        }
    }

    for dir in versioned_node_bins {
        push_unique_dir(&mut dirs, dir.clone());
    }

    if let Some(home) = home_dir {
        if !home.as_os_str().is_empty() {
            for rel in [".npm-global/bin", "Library/pnpm", ".local/share/pnpm", ".local/bin"] {
                push_unique_dir(&mut dirs, home.join(rel));
            }
        }
    }

    for dir in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/opt/homebrew/opt/node@22/bin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/local/opt/node@22/bin",
    ] {
        push_unique_dir(&mut dirs, PathBuf::from(dir));
    }

    for dir in existing_entries {
        push_unique_dir(&mut dirs, dir);
    }

    for sys in SYSTEM_PATH_DIRS {
        push_unique_dir(&mut dirs, PathBuf::from(sys));
    }

    dirs
}

pub fn join_path_dirs(dirs: &[PathBuf]) -> Option<OsString> {
    let non_empty: Vec<&Path> = dirs
        .iter()
        .map(PathBuf::as_path)
        .filter(|p| !p.as_os_str().is_empty())
        .collect();
    if non_empty.is_empty() {
        return None;
    }
    env::join_paths(non_empty).ok()
}

/// Parses a single SSE event block separated by an empty line (`\n\n` or `\r\n\r\n`).
pub fn parse_sse_event_block(block: &str) -> Option<SseEventFrame> {
    let mut id: Option<String> = None;
    let mut event: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();

    for raw_line in block.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((k, v)) => (k, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "id" => {
                if !value.contains('\0') {
                    id = Some(value.to_string());
                }
            }
            "event" => {
                event = if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                };
            }
            "data" => {
                data_lines.push(value);
            }
            _ => {}
        }
    }

    if data_lines.is_empty() {
        return None;
    }

    Some(SseEventFrame {
        id,
        event,
        data: data_lines.join("\n"),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsonParseError {
    Syntax(String),
    InvalidStructure(&'static str),
    DepthExceeded,
}

impl fmt::Display for JsonParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax(msg) => write!(f, "JSON syntax error: {msg}"),
            Self::InvalidStructure(msg) => write!(f, "JSON schema mismatch: {msg}"),
            Self::DepthExceeded => f.write_str("JSON nesting depth exceeded limit"),
        }
    }
}

impl Error for JsonParseError {}

#[derive(Debug, Clone, PartialEq)]
enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

impl JsonValue {
    fn as_object(&self) -> Option<&[(String, JsonValue)]> {
        match self {
            Self::Object(entries) => Some(entries),
            _ => None,
        }
    }

    fn as_array(&self) -> Option<&[JsonValue]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }

    fn as_u64(&self) -> Option<u64> {
        let n = self.as_f64()?;
        if n >= 0.0 && n.fract() == 0.0 && n < 18_446_744_073_709_551_616.0 {
            Some(n as u64)
        } else {
            None
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn get(&self, key: &str) -> Option<&JsonValue> {
        let entries = self.as_object()?;
        entries
            .iter()
            .rfind(|(k, _)| k == key)
            .map(|(_, val)| val)
    }
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            bytes: input.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while let Some(&b) = self.bytes.get(self.pos) {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn next_byte(&mut self) -> Option<u8> {
        let b = self.bytes.get(self.pos).copied()?;
        self.pos += 1;
        Some(b)
    }

    fn parse_root(&mut self) -> Result<JsonValue, JsonParseError> {
        self.skip_ws();
        let value = self.parse_value(0)?;
        self.skip_ws();
        if self.pos != self.bytes.len() {
            return Err(JsonParseError::Syntax(format!(
                "trailing bytes at offset {}",
                self.pos
            )));
        }
        Ok(value)
    }

    fn parse_value(&mut self, depth: usize) -> Result<JsonValue, JsonParseError> {
        if depth > MAX_JSON_DEPTH {
            return Err(JsonParseError::DepthExceeded);
        }
        self.skip_ws();
        let Some(b) = self.peek() else {
            return Err(JsonParseError::Syntax("unexpected end of input".to_string()));
        };
        match b {
            b'{' => self.parse_object(depth + 1),
            b'[' => self.parse_array(depth + 1),
            b'"' => self.parse_string().map(JsonValue::String),
            b't' => {
                self.expect_bytes(b"true")?;
                Ok(JsonValue::Bool(true))
            }
            b'f' => {
                self.expect_bytes(b"false")?;
                Ok(JsonValue::Bool(false))
            }
            b'n' => {
                self.expect_bytes(b"null")?;
                Ok(JsonValue::Null)
            }
            b'-' | b'0'..=b'9' => self.parse_number().map(JsonValue::Number),
            other => Err(JsonParseError::Syntax(format!(
                "unexpected byte 0x{other:02x} at offset {}",
                self.pos
            ))),
        }
    }

    fn expect_bytes(&mut self, expected: &[u8]) -> Result<(), JsonParseError> {
        let end = self.pos + expected.len();
        if self.bytes.get(self.pos..end) == Some(expected) {
            self.pos = end;
            Ok(())
        } else {
            Err(JsonParseError::Syntax(format!(
                "invalid literal at offset {}",
                self.pos
            )))
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<JsonValue, JsonParseError> {
        self.next_byte(); // '{'
        self.skip_ws();
        let mut entries = Vec::new();
        if self.peek() == Some(b'}') {
            self.next_byte();
            return Ok(JsonValue::Object(entries));
        }

        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(JsonParseError::Syntax(format!(
                    "expected object string key at offset {}",
                    self.pos
                )));
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.next_byte() != Some(b':') {
                return Err(JsonParseError::Syntax(format!(
                    "expected ':' after key at offset {}",
                    self.pos
                )));
            }
            let val = self.parse_value(depth)?;
            entries.push((key, val));
            self.skip_ws();
            match self.next_byte() {
                Some(b',') => continue,
                Some(b'}') => return Ok(JsonValue::Object(entries)),
                _ => {
                    return Err(JsonParseError::Syntax(format!(
                        "expected ',' or '}}' at offset {}",
                        self.pos
                    )));
                }
            }
        }
    }

    fn parse_array(&mut self, depth: usize) -> Result<JsonValue, JsonParseError> {
        self.next_byte(); // '['
        self.skip_ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.next_byte();
            return Ok(JsonValue::Array(items));
        }

        loop {
            let val = self.parse_value(depth)?;
            items.push(val);
            self.skip_ws();
            match self.next_byte() {
                Some(b',') => continue,
                Some(b']') => return Ok(JsonValue::Array(items)),
                _ => {
                    return Err(JsonParseError::Syntax(format!(
                        "expected ',' or ']' at offset {}",
                        self.pos
                    )));
                }
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, JsonParseError> {
        self.next_byte(); // opening '"'
        let mut out = String::new();
        loop {
            let start = self.pos;
            while let Some(&b) = self.bytes.get(self.pos) {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            if self.pos > start {
                let slice = std::str::from_utf8(&self.bytes[start..self.pos])
                    .map_err(|_| JsonParseError::Syntax("invalid UTF-8 in string".to_string()))?;
                out.push_str(slice);
            }
            let Some(b) = self.next_byte() else {
                return Err(JsonParseError::Syntax("unterminated string".to_string()));
            };
            match b {
                b'"' => return Ok(out),
                b'\\' => {
                    let esc = self.next_byte().ok_or_else(|| {
                        JsonParseError::Syntax("unterminated string escape".to_string())
                    })?;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let code = self.parse_hex4()?;
                            if (0xD800..=0xDBFF).contains(&code) {
                                if self.bytes.get(self.pos..self.pos + 2) == Some(b"\\u") {
                                    self.pos += 2;
                                    let low = self.parse_hex4()?;
                                    if (0xDC00..=0xDFFF).contains(&low) {
                                        let combined = 0x10000
                                            + (((code as u32 - 0xD800) << 10)
                                                | (low as u32 - 0xDC00));
                                        let ch = char::from_u32(combined).ok_or_else(|| {
                                            JsonParseError::Syntax(
                                                "invalid unicode scalar".to_string(),
                                            )
                                        })?;
                                        out.push(ch);
                                        continue;
                                    }
                                }
                                return Err(JsonParseError::Syntax(
                                    "unpaired UTF-16 surrogate".to_string(),
                                ));
                            }
                            let ch = char::from_u32(code as u32).ok_or_else(|| {
                                JsonParseError::Syntax("invalid unicode escape".to_string())
                            })?;
                            out.push(ch);
                        }
                        _ => {
                            return Err(JsonParseError::Syntax(format!(
                                "invalid string escape \\{}",
                                esc as char
                            )));
                        }
                    }
                }
                _ => {
                    return Err(JsonParseError::Syntax(
                        "unescaped control character in string".to_string(),
                    ));
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u16, JsonParseError> {
        let slice = self
            .bytes
            .get(self.pos..self.pos + 4)
            .ok_or_else(|| JsonParseError::Syntax("incomplete \\u escape".to_string()))?;
        self.pos += 4;
        let hex = std::str::from_utf8(slice)
            .map_err(|_| JsonParseError::Syntax("invalid \\u escape bytes".to_string()))?;
        u16::from_str_radix(hex, 16)
            .map_err(|_| JsonParseError::Syntax("invalid hex digits in \\u escape".to_string()))
    }

    fn parse_number(&mut self) -> Result<f64, JsonParseError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(JsonParseError::Syntax(
                        "leading zero in JSON number".to_string(),
                    ));
                }
            }
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => {
                return Err(JsonParseError::Syntax("invalid JSON number".to_string()));
            }
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(JsonParseError::Syntax(
                    "expected digit after decimal point".to_string(),
                ));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(JsonParseError::Syntax(
                    "expected exponent digits in number".to_string(),
                ));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let num_str = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| JsonParseError::Syntax("invalid UTF-8 in number".to_string()))?;
        let val = num_str
            .parse::<f64>()
            .map_err(|_| JsonParseError::Syntax("number overflow".to_string()))?;
        if !val.is_finite() {
            return Err(JsonParseError::Syntax("non-finite JSON number".to_string()));
        }
        Ok(val)
    }
}

pub fn parse_health_json(body: &str) -> Result<KilnHealth, JsonParseError> {
    let root = JsonParser::new(body).parse_root()?;
    if root.as_object().is_none() {
        return Err(JsonParseError::InvalidStructure("health root must be object"));
    }

    let ok = root
        .get("ok")
        .and_then(JsonValue::as_bool)
        .ok_or(JsonParseError::InvalidStructure("health.ok must be boolean"))?;

    let pid = match root.get("pid") {
        None | Some(JsonValue::Null) => None,
        Some(v) => Some(
            v.as_u64()
                .ok_or(JsonParseError::InvalidStructure("health.pid must be u64"))?,
        ),
    };

    let version = match root.get("version") {
        None | Some(JsonValue::Null) => None,
        Some(v) => Some(
            v.as_str()
                .ok_or(JsonParseError::InvalidStructure(
                    "health.version must be string",
                ))?
                .to_string(),
        ),
    };

    Ok(KilnHealth { ok, pid, version })
}

pub fn parse_bootstrap_summary_json(body: &str) -> Result<KilnBootstrapSummary, JsonParseError> {
    let root = JsonParser::new(body).parse_root()?;
    if root.as_object().is_none() {
        return Err(JsonParseError::InvalidStructure(
            "bootstrap root must be object",
        ));
    }

    let running_count = root
        .get("runningCount")
        .and_then(JsonValue::as_u64)
        .ok_or(JsonParseError::InvalidStructure(
            "bootstrap.runningCount must be non-negative integer",
        ))?;

    let pending_decision_count = root
        .get("pendingDecisions")
        .and_then(JsonValue::as_array)
        .map(<[JsonValue]>::len)
        .ok_or(JsonParseError::InvalidStructure(
            "bootstrap.pendingDecisions must be array",
        ))?;

    let task_count = match root.get("tasks") {
        None | Some(JsonValue::Null) => 0,
        Some(v) => v
            .as_array()
            .map(<[JsonValue]>::len)
            .ok_or(JsonParseError::InvalidStructure(
                "bootstrap.tasks must be array",
            ))?,
    };

    let totals = match root.get("liveRates") {
        None | Some(JsonValue::Null) => KilnLiveRatesTotals {
            cost_usd: 0.0,
            tok_per_sec: 0.0,
        },
        Some(live_rates) => {
            if live_rates.as_object().is_none() {
                return Err(JsonParseError::InvalidStructure(
                    "bootstrap.liveRates must be object",
                ));
            }
            match live_rates.get("totals") {
                None | Some(JsonValue::Null) => KilnLiveRatesTotals {
                    cost_usd: 0.0,
                    tok_per_sec: 0.0,
                },
                Some(totals_val) => {
                    if totals_val.as_object().is_none() {
                        return Err(JsonParseError::InvalidStructure(
                            "bootstrap.liveRates.totals must be object",
                        ));
                    }
                    let cost_usd = parse_optional_non_negative_f64(
                        totals_val.get("costUsd"),
                        "bootstrap.liveRates.totals.costUsd must be number",
                    )?;
                    let tok_per_sec = parse_optional_non_negative_f64(
                        totals_val.get("tokPerSec"),
                        "bootstrap.liveRates.totals.tokPerSec must be number",
                    )?;
                    KilnLiveRatesTotals {
                        cost_usd,
                        tok_per_sec,
                    }
                }
            }
        }
    };

    Ok(KilnBootstrapSummary {
        running_count,
        pending_decision_count,
        task_count,
        totals,
    })
}

fn parse_optional_non_negative_f64(
    val: Option<&JsonValue>,
    err_msg: &'static str,
) -> Result<f64, JsonParseError> {
    match val {
        None | Some(JsonValue::Null) => Ok(0.0),
        Some(v) => v
            .as_f64()
            .map(sanitize_non_negative)
            .ok_or(JsonParseError::InvalidStructure(err_msg)),
    }
}

fn sanitize_non_negative(v: f64) -> f64 {
    if v.is_finite() && v >= 0.0 {
        v
    } else {
        0.0
    }
}

fn non_empty_trimmed(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_allowed_loopback_urls_and_normalizes() {
        let u1 = validate_kilnd_url(DEFAULT_KILND_URL).expect("default url");
        assert_eq!(u1.host, "127.0.0.1");
        assert_eq!(u1.port, 4310);
        assert_eq!(u1.base_url, "http://127.0.0.1:4310");
        assert_eq!(u1.endpoint_url("/api/health"), "http://127.0.0.1:4310/api/health");
        assert_eq!(u1.endpoint_url("api/bootstrap"), "http://127.0.0.1:4310/api/bootstrap");
        assert_eq!(u1.tcp_host_port(), ("127.0.0.1", 4310));
        assert_eq!(u1.host_header(), "127.0.0.1:4310");

        let u2 = validate_kilnd_url("HTTP://LocalHost:4310/").expect("localhost with trailing slash");
        assert_eq!(u2.host, "localhost");
        assert_eq!(u2.port, 4310);
        assert_eq!(u2.base_url, "http://localhost:4310");

        let u3 = validate_kilnd_url("http://127.0.0.1").expect("default port 80");
        assert_eq!(u3.port, 80);
        assert_eq!(u3.base_url, "http://127.0.0.1");

        let u4 = validate_kilnd_url("http://localhost:65535").expect("max port");
        assert_eq!(u4.port, 65535);
        assert!(is_allowed_kilnd_url("http://localhost:1"));
    }

    #[test]
    fn rejects_non_loopback_schemes_userinfo_and_bad_ports() {
        let rejected = [
            ("", UrlValidationError::Empty),
            ("   ", UrlValidationError::ControlOrWhitespace),
            ("http://127.0.0.1:4310\n", UrlValidationError::ControlOrWhitespace),
            ("https://127.0.0.1:4310", UrlValidationError::UnsupportedScheme),
            ("file:///etc/passwd", UrlValidationError::UnsupportedScheme),
            ("javascript:alert(1)", UrlValidationError::UnsupportedScheme),
            ("127.0.0.1:4310", UrlValidationError::UnsupportedScheme),
            ("http://user@127.0.0.1:4310", UrlValidationError::UserinfoNotAllowed),
            ("http://127.0.0.1:4310@evil.com", UrlValidationError::UserinfoNotAllowed),
            ("http://localhost.evil.com:4310", UrlValidationError::NonLoopbackHost),
            ("http://127.0.0.2:4310", UrlValidationError::NonLoopbackHost),
            ("http://0.0.0.0:4310", UrlValidationError::NonLoopbackHost),
            ("http://[::1]:4310", UrlValidationError::NonLoopbackHost),
            ("http://127.0.0.1:0", UrlValidationError::InvalidPort),
            ("http://127.0.0.1:65536", UrlValidationError::InvalidPort),
            ("http://127.0.0.1:abc", UrlValidationError::InvalidPort),
            ("http://127.0.0.1:", UrlValidationError::InvalidPort),
            ("http://127.0.0.1:4310/tasks", UrlValidationError::UnexpectedPathOrSuffix),
            ("http://127.0.0.1:4310?next=evil", UrlValidationError::UnexpectedPathOrSuffix),
            ("http://127.0.0.1:4310\\@evil.com", UrlValidationError::InvalidAuthority),
        ];

        for (raw, expected_err) in rejected {
            let err = validate_kilnd_url(raw).expect_err(raw);
            assert_eq!(err, expected_err, "unexpected error for {raw}: {err}");
            assert!(!err.to_string().is_empty());
            assert!(!is_allowed_kilnd_url(raw));
        }
    }

    #[test]
    fn navigation_guard_enforces_exact_loopback_origin() {
        let origin = validate_kilnd_url("http://127.0.0.1:4310").unwrap();
        assert!(is_allowed_navigation_url("http://127.0.0.1:4310", &origin));
        assert!(is_allowed_navigation_url("http://127.0.0.1:4310/tasks/t-1?view=board#top", &origin));
        assert!(!is_allowed_navigation_url("http://127.0.0.1:9999/", &origin));
        assert!(!is_allowed_navigation_url("http://localhost:4310/", &origin));
        assert!(!is_allowed_navigation_url("https://127.0.0.1:4310/", &origin));
        assert!(!is_allowed_navigation_url("http://127.0.0.1:4310\\@evil.com", &origin));
        assert!(!is_allowed_navigation_url("http://localhost.evil.com:4310/", &origin));
        assert!(!is_allowed_navigation_url("javascript:alert(1)", &origin));
    }

    #[test]
    fn parses_health_json_and_rejects_invalid_shapes() {
        let ok = parse_health_json(r#"{"ok":true,"pid":4242,"version":"0.1.0"}"#).unwrap();
        assert_eq!(
            ok,
            KilnHealth {
                ok: true,
                pid: Some(4242),
                version: Some("0.1.0".to_string()),
            }
        );

        let minimal = parse_health_json(r#"{"ok":false,"pid":null,"version":null}"#).unwrap();
        assert!(!minimal.ok);
        assert_eq!(minimal.pid, None);
        assert_eq!(minimal.version, None);

        assert!(parse_health_json(r#"{}"#).is_err());
        assert!(parse_health_json(r#"{"ok":"yes"}"#).is_err());
        assert!(parse_health_json(r#"{"ok":true,"pid":-1}"#).is_err());
        assert!(parse_health_json(r#"[]"#).is_err());
        assert!(parse_health_json(r#"{"ok":true} trailing"#).is_err());
    }

    #[test]
    fn parses_bootstrap_summary_with_nested_strings_and_arrays() {
        let payload = r#"{
            "tasks": [
                {
                    "id": "t-1",
                    "title": "Fix \"runningCount\" & \\escaped\\ quotes \u0041 \uD83D\uDE80",
                    "cost_usd": 99.9
                },
                { "id": "t-2" }
            ],
            "pendingDecisions": [
                {
                    "id": "dec-1",
                    "options": ["approve", "reject"],
                    "meta": { "nested": [1, 2, 3] }
                }
            ],
            "liveRates": {
                "rates": { "t-1": 42.5 },
                "totals": {
                    "costUsd": 1.25e0,
                    "tokPerSec": 48.75
                }
            },
            "usage": { "costUsd": 88.88 },
            "runningCount": 2
        }"#;

        let summary = parse_bootstrap_summary_json(payload).unwrap();
        assert_eq!(summary.running_count, 2);
        assert_eq!(summary.pending_decision_count, 1);
        assert_eq!(summary.task_count, 2);
        assert!((summary.totals.cost_usd - 1.25).abs() < 1e-9);
        assert!((summary.totals.tok_per_sec - 48.75).abs() < 1e-9);

        let no_rates = parse_bootstrap_summary_json(r#"{"runningCount":0,"pendingDecisions":[]}"#).unwrap();
        assert_eq!(no_rates.task_count, 0);
        assert_eq!(no_rates.totals.cost_usd, 0.0);

        assert!(parse_bootstrap_summary_json(r#"{}"#).is_err());
        assert!(parse_bootstrap_summary_json(r#"{"runningCount":"2","pendingDecisions":[]}"#).is_err());
        assert!(parse_bootstrap_summary_json(r#"{"runningCount":1,"pendingDecisions":{}}"#).is_err());
        assert!(parse_bootstrap_summary_json(r#"{"runningCount":1,"pendingDecisions":[],"liveRates":{"totals":{"costUsd":"bad"}}}"#).is_err());
    }

    #[test]
    fn rejects_deeply_nested_or_malformed_json() {
        let deep = "[".repeat(MAX_JSON_DEPTH + 2) + &"]".repeat(MAX_JSON_DEPTH + 2);
        let err = parse_bootstrap_summary_json(&deep).unwrap_err();
        assert_eq!(err, JsonParseError::DepthExceeded);
        assert!(!err.to_string().is_empty());

        assert!(parse_health_json(r#"{"ok":01}"#).is_err());
        assert!(parse_health_json("{\"ok\":\"\n\"}").is_err());
    }

    #[test]
    fn parses_sse_blocks_with_comments_ids_and_multiline_data() {
        assert_eq!(parse_sse_event_block(": heartbeat\n\n"), None);
        assert_eq!(parse_sse_event_block("id: 7\nevent: ping\n"), None);

        let block = ": keepalive\r\nid: 42\r\nevent: task.updated\r\ndata: {\"id\":\"t-1\",\r\ndata:  \"status\":\"running\"}\r\nretry: 3000\r\n";
        let frame = parse_sse_event_block(block).expect("valid sse frame");
        assert_eq!(
            frame,
            SseEventFrame {
                id: Some("42".to_string()),
                event: Some("task.updated".to_string()),
                data: "{\"id\":\"t-1\",\n \"status\":\"running\"}".to_string(),
            }
        );

        let no_space = parse_sse_event_block("event:\ndata:plain").unwrap();
        assert_eq!(no_space.event, None);
        assert_eq!(no_space.data, "plain");
    }

    #[test]
    fn formats_tray_states_and_enforces_destroy_close_policy() {
        assert_eq!(close_policy_for_window(MAIN_WINDOW_LABEL), WindowClosePolicy::Destroy);
        assert_eq!(close_policy_for_window("other"), WindowClosePolicy::Destroy);
        assert_ne!(WindowClosePolicy::Destroy, WindowClosePolicy::Hide);

        let offline = TrayDisplayState::from_probe(Err("connection refused"), None);
        assert!(!offline.is_online());
        assert_eq!(format_tray_title(&offline), "离线");
        assert!(format_tray_tooltip(&offline, DEFAULT_KILND_URL).contains("connection refused"));
        assert_eq!(format_tray_menu_status(&offline), "后台引擎未运行");
        assert_eq!(format_inbox_menu_label(&offline), "等你决定");
        assert_eq!(format_engine_submenu_label(&offline), "后台引擎（未运行）");

        let unhealthy = TrayDisplayState::from_probe(
            Ok(&KilnHealth {
                ok: false,
                pid: None,
                version: None,
            }),
            None,
        );
        assert!(!unhealthy.is_online());

        let healthy_no_bootstrap = TrayDisplayState::from_probe(
            Ok(&KilnHealth {
                ok: true,
                pid: Some(1),
                version: Some("0.1.0".to_string()),
            }),
            None,
        );
        assert!(healthy_no_bootstrap.is_online());
        assert_eq!(format_tray_title(&healthy_no_bootstrap), "");
        assert_eq!(
            format_engine_submenu_label(&healthy_no_bootstrap),
            "后台引擎（运行中）"
        );

        let idle = TrayDisplayState::from_bootstrap(&KilnBootstrapSummary {
            running_count: 0,
            pending_decision_count: 0,
            task_count: 3,
            totals: KilnLiveRatesTotals {
                cost_usd: 0.42,
                tok_per_sec: 0.0,
            },
        });
        assert!(idle.is_online());
        assert_eq!(format_tray_title(&idle), "");
        assert!(format_tray_tooltip(&idle, DEFAULT_KILND_URL).contains("任务 3 个"));
        assert_eq!(format_tray_menu_status(&idle), "待机 · 3 个任务 · 累计 $0.42");

        let running = TrayDisplayState::from_bootstrap(&KilnBootstrapSummary {
            running_count: 2,
            pending_decision_count: 0,
            task_count: 5,
            totals: KilnLiveRatesTotals {
                cost_usd: 1.5,
                tok_per_sec: 48.4,
            },
        });
        assert_eq!(format_tray_title(&running), "2 运行 · 48 tok/s");
        assert!(format_tray_tooltip(&running, DEFAULT_KILND_URL).contains("48.4 tok/s"));
        assert_eq!(
            format_tray_menu_status(&running),
            "运行中 · 2 个任务 · 48 tok/s · $1.50"
        );

        let running_quiet = TrayDisplayState::Running {
            running_count: 1,
            tok_per_sec: 0.2,
            cost_usd: 0.1,
        };
        assert_eq!(format_tray_title(&running_quiet), "1 运行");

        let waiting = TrayDisplayState::from_bootstrap(&KilnBootstrapSummary {
            running_count: 1,
            pending_decision_count: 2,
            task_count: 5,
            totals: KilnLiveRatesTotals {
                cost_usd: 2.1,
                tok_per_sec: 15.0,
            },
        });
        assert_eq!(format_tray_title(&waiting), "2 待决 · 1 运行");
        assert!(format_tray_tooltip(&waiting, DEFAULT_KILND_URL).contains("待决拍板：2 项"));
        assert_eq!(
            format_tray_menu_status(&waiting),
            "2 项待决 · 1 个运行中 · $2.10"
        );
        assert_eq!(format_inbox_menu_label(&waiting), "等你决定（2）");

        let waiting_only = TrayDisplayState::WaitingDecision {
            pending_decisions: 1,
            running_count: 0,
            tok_per_sec: 0.0,
            cost_usd: 0.0,
        };
        assert_eq!(format_tray_title(&waiting_only), "1 待决");
        assert_eq!(format_tray_menu_status(&waiting_only), "1 项待决 · $0.00");
        assert_eq!(format_inbox_menu_label(&waiting_only), "等你决定（1）");
    }

    #[test]
    fn applies_start_action_and_formats_starting_and_failed_states() {
        let base_offline = TrayDisplayState::Offline {
            reason: Some("connection refused".to_string()),
        };

        let idle_applied = base_offline.clone().apply_start_action(&StartActionState::Idle);
        assert_eq!(idle_applied, base_offline);
        assert!(is_start_menu_enabled(&idle_applied));
        assert_eq!(format_start_menu_label(&idle_applied), "启动 kilnd");

        let starting = base_offline
            .clone()
            .apply_start_action(&StartActionState::Starting);
        assert_eq!(starting, TrayDisplayState::Starting);
        assert!(!starting.is_online());
        assert!(!is_start_menu_enabled(&starting));
        assert_eq!(format_tray_title(&starting), "启动中…");
        assert_eq!(format_tray_menu_status(&starting), "正在启动后台引擎…");
        assert_eq!(format_engine_submenu_label(&starting), "后台引擎（启动中…）");
        assert_eq!(format_start_menu_label(&starting), "正在启动 kilnd…");
        assert!(format_tray_tooltip(&starting, DEFAULT_KILND_URL).contains("正在启动 kilnd"));

        let missing_cli = "unable to locate `kiln` CLI binary in PATH or standard install directories".to_string();
        let failed = base_offline.apply_start_action(&StartActionState::Failed(missing_cli));
        assert!(!failed.is_online());
        assert!(is_start_menu_enabled(&failed));
        assert_eq!(format_tray_title(&failed), "启动失败");
        assert_eq!(format_start_menu_label(&failed), "重试启动 kilnd");
        assert_eq!(
            format_engine_submenu_label(&failed),
            "后台引擎（启动失败）"
        );
        assert_eq!(
            format_tray_menu_status(&failed),
            "后台引擎启动失败：未找到 kiln CLI，请先安装 @zzf2333/kiln"
        );
        assert!(
            format_tray_tooltip(&failed, DEFAULT_KILND_URL)
                .contains("未找到 kiln CLI，请先安装 @zzf2333/kiln")
        );

        let online_idle = TrayDisplayState::Idle {
            cost_usd: 0.0,
            task_count: 0,
        };
        let online_after_err = online_idle
            .clone()
            .apply_start_action(&StartActionState::Failed("boom".to_string()));
        assert_eq!(online_after_err, online_idle);
        assert!(!is_start_menu_enabled(&online_idle));
        assert_eq!(format_start_menu_label(&online_idle), "启动 kilnd");

        assert_eq!(
            summarize_start_error("KILN_BIN points to missing file: /nope/kiln"),
            "KILN_BIN 指向的文件不存在"
        );
        assert_eq!(
            summarize_start_error("kiln up failed: env: node: No such file or directory"),
            "未找到 Node.js (>=22)，请先安装 Node.js"
        );
        assert_eq!(summarize_start_error("   \n  "), "未知启动错误");
        assert_eq!(
            summarize_start_error("kiln up failed:    permission\t denied  \nsecond line"),
            "permission denied"
        );
        let long_raw = format!("kiln up failed: {}", "a".repeat(90));
        let summarized = summarize_start_error(&long_raw);
        assert_eq!(summarized.chars().count(), 72);
        assert!(summarized.ends_with('…'));
    }

    #[test]
    fn builds_enriched_child_path_for_bare_finder_env() {
        let home = Path::new("/Users/tester");
        let bin_dir = Path::new("/Users/tester/.local/bin");
        let versioned = vec![PathBuf::from(
            "/Users/tester/.local/share/mise/installs/node/24.20.0/bin",
        )];
        let bare_finder_path =
            env::join_paths(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).expect("join bare PATH");
        let dirs = build_child_command_path_dirs(
            Some(bin_dir),
            Some(bare_finder_path.as_os_str()),
            Some(home),
            &versioned,
        );

        assert_eq!(dirs[0], bin_dir);
        let mise_global = PathBuf::from("/Users/tester/.local/share/mise/installs/node/global/bin");
        let mise_ver = PathBuf::from("/Users/tester/.local/share/mise/installs/node/24.20.0/bin");
        let brew_node22 = PathBuf::from("/opt/homebrew/opt/node@22/bin");
        let usr_bin = PathBuf::from("/usr/bin");

        assert!(dirs.contains(&mise_global));
        assert!(dirs.contains(&mise_ver));
        assert!(dirs.contains(&brew_node22));
        assert!(dirs.contains(&PathBuf::from("/usr/local/opt/node@22/bin")));

        let pos_bin = dirs.iter().position(|d| d == bin_dir).unwrap();
        let pos_global = dirs.iter().position(|d| d == &mise_global).unwrap();
        let pos_brew = dirs.iter().position(|d| d == &brew_node22).unwrap();
        let pos_usr = dirs.iter().position(|d| d == &usr_bin).unwrap();
        assert!(pos_bin < pos_global);
        assert!(pos_global < pos_brew);
        assert!(pos_brew < pos_usr);

        // Deduplicated
        assert_eq!(dirs.iter().filter(|d| *d == &usr_bin).count(), 1);
        assert_eq!(dirs.iter().filter(|d| *d == bin_dir).count(), 1);

        // Custom terminal entries preserve priority ahead of mise/homebrew fallbacks
        let custom_path = env::join_paths(["/custom/node/bin", "/usr/bin", "/bin"])
            .expect("join custom PATH");
        let custom_dirs = build_child_command_path_dirs(
            Some(bin_dir),
            Some(custom_path.as_os_str()),
            Some(home),
            &versioned,
        );
        let pos_custom = custom_dirs
            .iter()
            .position(|d| d == Path::new("/custom/node/bin"))
            .unwrap();
        let pos_mise = custom_dirs
            .iter()
            .position(|d| d == &mise_global)
            .unwrap();
        assert!(pos_custom < pos_mise);

        let joined = join_path_dirs(&custom_dirs).expect("non-empty PATH");
        assert!(!joined.is_empty());
        assert_eq!(join_path_dirs(&[]), None);
    }

    #[test]
    fn parses_semver_keys_and_orders_standard_kiln_search_dirs() {
        assert_eq!(parse_semver_key("24.20.0"), Some((24, 20, 0)));
        assert_eq!(parse_semver_key("v22.19.1"), Some((22, 19, 1)));
        assert_eq!(parse_semver_key("V20.11"), Some((20, 11, 0)));
        assert_eq!(parse_semver_key("24"), Some((24, 0, 0)));
        assert_eq!(parse_semver_key("24.0.0-rc.1"), Some((24, 0, 0)));
        assert_eq!(parse_semver_key("global"), None);
        assert_eq!(parse_semver_key("lts"), None);
        assert_eq!(parse_semver_key("latest"), None);
        assert_eq!(parse_semver_key("1.2.3.4"), None);
        assert_eq!(parse_semver_key(""), None);

        let home = Path::new("/Users/tester");
        let dirs = standard_kiln_search_dirs(
            Some(home),
            &[
                PathBuf::from("/Users/tester/.local/share/mise/installs/node/24.20.0/bin"),
                PathBuf::from("/Users/tester/.local/share/mise/installs/node/global/bin"),
            ],
        );
        let global_pos = dirs
            .iter()
            .position(|d| {
                d == Path::new("/Users/tester/.local/share/mise/installs/node/global/bin")
            })
            .unwrap();
        let shims_pos = dirs
            .iter()
            .position(|d| d == Path::new("/Users/tester/.local/share/mise/shims"))
            .unwrap();
        assert!(global_pos < shims_pos);
        assert_eq!(
            dirs.iter()
                .filter(|d| *d == Path::new("/Users/tester/.local/share/mise/installs/node/global/bin"))
                .count(),
            1
        );
    }

    #[test]
    fn resolves_platform_sidecar_paths_windows_shims_and_cli_install_labels() {
        assert_eq!(platform_kiln_binary_name(false), "kiln");
        assert_eq!(platform_kiln_binary_name(true), "kiln.exe");
        assert_eq!(platform_kiln_binary_names(false), &["kiln"]);
        assert_eq!(platform_kiln_binary_names(true), &["kiln.exe", "kiln.cmd"]);

        let mac_exe = Path::new("/Applications/Kiln.app/Contents/MacOS/kiln-desktop");
        assert_eq!(
            sidecar_candidate_path(Some(mac_exe), false),
            Some(PathBuf::from("/Applications/Kiln.app/Contents/MacOS/kiln"))
        );

        let win_exe = Path::new("/Users/tester/AppData/Local/Kiln/kiln-desktop.exe");
        assert_eq!(
            sidecar_candidate_path(Some(win_exe), true),
            Some(PathBuf::from("/Users/tester/AppData/Local/Kiln/kiln.exe"))
        );
        // Guard: if main exe shares sidecar name (case-insensitively on Windows), refuse self-recursion
        assert_eq!(
            sidecar_candidate_path(Some(Path::new("/Users/tester/AppData/Local/Kiln/Kiln.exe")), true),
            None
        );
        assert_eq!(sidecar_candidate_path(None, false), None);

        let win_dirs = windows_kiln_search_dirs(
            Some(Path::new("/Users/tester/AppData/Local")),
            Some(Path::new("/Users/tester")),
        );
        assert_eq!(
            win_dirs[0],
            PathBuf::from("/Users/tester/AppData/Local/Kiln/bin")
        );
        assert!(win_dirs.contains(&PathBuf::from("/Users/tester/.local/bin")));

        let shim = render_windows_cli_shim(Path::new(r"C:\Users\A B\AppData\Local\Kiln\kiln.exe"))
            .expect("valid windows path renders shim");
        assert_eq!(
            shim,
            "@echo off\r\n\"C:\\Users\\A B\\AppData\\Local\\Kiln\\kiln.exe\" %*\r\n"
        );
        let shim_pct = render_windows_cli_shim(Path::new(r"C:\Users\100%dev\Kiln\kiln.exe"))
            .expect("percent sign in path should be escaped for cmd.exe");
        assert_eq!(
            shim_pct,
            "@echo off\r\n\"C:\\Users\\100%%dev\\Kiln\\kiln.exe\" %*\r\n"
        );
        let shim_cmd = render_windows_cli_shim(Path::new(r"C:\Users\dev\Kiln\kiln.cmd"))
            .expect("cmd target should use call");
        assert_eq!(
            shim_cmd,
            "@echo off\r\ncall \"C:\\Users\\dev\\Kiln\\kiln.cmd\" %*\r\n"
        );
        assert!(render_windows_cli_shim(Path::new("C:\\bad\npath\\kiln.exe")).is_err());
        assert!(render_windows_cli_shim(Path::new("C:\\bad\"quote\\kiln.exe")).is_err());

        let contains_path = env::join_paths([
            "/usr/bin",
            "/Users/tester/.local/bin/",
            "/bin",
        ])
        .expect("join PATH with target");
        assert!(path_contains_dir(
            Some(contains_path.as_os_str()),
            Path::new("/Users/tester/.local/bin"),
            false
        ));
        assert!(path_contains_dir(
            Some(contains_path.as_os_str()),
            Path::new("/USERS/tester/.local/BIN"),
            true
        ));
        assert!(!path_contains_dir(
            Some(contains_path.as_os_str()),
            Path::new("/USERS/tester/.local/BIN"),
            false
        ));
        let missing_path = env::join_paths(["/usr/bin", "/bin"]).expect("join bare PATH");
        assert!(!path_contains_dir(
            Some(missing_path.as_os_str()),
            Path::new("/Users/tester/.local/bin"),
            false
        ));

        assert_eq!(
            format_install_cli_menu_label(&CliInstallActionState::Idle),
            "安装 kiln 终端命令"
        );
        assert_eq!(
            format_install_cli_menu_label(&CliInstallActionState::Installed {
                bin_dir: "~/.local/bin".to_string(),
                in_path: true,
            }),
            "已安装 kiln 终端命令（~/.local/bin）"
        );
        assert_eq!(
            format_install_cli_menu_label(&CliInstallActionState::Installed {
                bin_dir: "~/.local/bin".to_string(),
                in_path: false,
            }),
            "已安装 kiln 终端命令（请将 ~/.local/bin 加入 PATH）"
        );
        assert!(
            format_install_cli_menu_label(&CliInstallActionState::Failed(
                "permission denied".to_string()
            ))
            .contains("permission denied")
        );
    }

    #[test]
    fn formats_tray_version_tags_and_mismatch_warnings() {
        let idle = TrayDisplayState::Idle {
            cost_usd: 0.42,
            task_count: 3,
        };
        assert_eq!(format_tray_version_tag("0.0.3", None), "v0.0.3");
        assert_eq!(format_tray_version_tag("0.0.3", Some("v0.0.3")), "v0.0.3");
        assert_eq!(
            format_tray_version_tag("0.0.3", Some("0.0.2")),
            "App v0.0.3 / kilnd v0.0.2"
        );
        assert_eq!(
            format_tray_header("0.0.4", Some("0.0.4")),
            "Kiln 工作台 · v0.0.4"
        );
        assert_eq!(
            format_tray_header("0.0.4", Some("0.0.3")),
            "Kiln 工作台 · App v0.0.4 / kilnd v0.0.3"
        );
        assert_eq!(
            format_tray_menu_status_with_version(&idle, "0.0.3", Some("0.0.3")),
            "待机 · 3 个任务 · 累计 $0.42 · v0.0.3"
        );
        assert_eq!(
            format_tray_tooltip_with_version(&idle, DEFAULT_KILND_URL, "0.0.3", Some("0.0.2")),
            "Kiln App v0.0.3 / kilnd v0.0.2 · 待机（任务 3 个 · 累计 $0.42）— http://127.0.0.1:4310"
        );
    }

    #[test]
    fn builds_safe_loopback_workbench_urls_for_all_routes() {
        let origin = validate_kilnd_url(DEFAULT_KILND_URL).expect("valid default origin");
        assert_eq!(build_workbench_url(&origin, None), "http://127.0.0.1:4310");

        let routes = [
            (WorkbenchRoute::Board, "http://127.0.0.1:4310/#view=board"),
            (WorkbenchRoute::Intake, "http://127.0.0.1:4310/#view=intake"),
            (WorkbenchRoute::Inbox, "http://127.0.0.1:4310/#view=inbox"),
            (WorkbenchRoute::Lineup, "http://127.0.0.1:4310/#view=lineup"),
            (WorkbenchRoute::Ledger, "http://127.0.0.1:4310/#view=ledger"),
            (WorkbenchRoute::Usage, "http://127.0.0.1:4310/#view=usage"),
            (WorkbenchRoute::Settings, "http://127.0.0.1:4310/#view=settings"),
        ];
        for (route, expected) in routes {
            let url = build_workbench_url(&origin, Some(route));
            assert_eq!(url, expected);
            assert!(is_allowed_navigation_url(&url, &origin));
        }
    }

    #[test]
    fn decides_startup_window_and_exit_prevention_policies() {
        assert_eq!(
            decide_startup_window_action(true),
            StartupWindowAction::OpenImmediately
        );
        assert_eq!(
            decide_startup_window_action(false),
            StartupWindowAction::AutoStartThenOpen
        );

        assert!(should_prevent_exit(None, false));
        assert!(!should_prevent_exit(None, true));
        assert!(!should_prevent_exit(Some(0), false));
        assert!(!should_prevent_exit(Some(1), true));
    }
}
