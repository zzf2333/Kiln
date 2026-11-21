use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::model::{
    build_child_command_path_dirs, join_path_dirs, parse_bootstrap_summary_json, parse_health_json,
    parse_semver_key, parse_sse_event_block, path_contains_dir, platform_kiln_binary_names,
    render_windows_cli_shim, sidecar_candidate_path, standard_kiln_search_dirs, validate_kilnd_url,
    windows_kiln_search_dirs, KilnBootstrapSummary, KilnHealth, NormalizedKilndUrl, SseEventFrame,
    TrayDisplayState, DEFAULT_KILND_URL,
};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const IO_TIMEOUT: Duration = Duration::from_millis(2500);
const MAX_HTTP_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 32 * 1024;

pub fn resolve_kilnd_url() -> Result<NormalizedKilndUrl, String> {
    let raw = match env::var("KILND_URL") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT_KILND_URL.to_string(),
    };
    validate_kilnd_url(&raw).map_err(|err| format!("invalid KILND_URL ({raw}): {err}"))
}

#[derive(Debug, Clone)]
pub struct KilndClient {
    url: NormalizedKilndUrl,
}

pub enum SsePollResult {
    Event(SseEventFrame),
    Timeout,
    Closed(String),
}

pub struct SseConnection {
    stream: TcpStream,
    chunked: bool,
    chunk_remaining: Option<usize>,
    raw_buf: Vec<u8>,
    body_buf: Vec<u8>,
    eof: bool,
}

impl SseConnection {
    pub fn next_event(&mut self, read_timeout: Duration) -> SsePollResult {
        let _ = self.stream.set_read_timeout(Some(read_timeout));

        loop {
            if let Some(block_str) = self.take_next_sse_block() {
                if let Some(frame) = parse_sse_event_block(&block_str) {
                    return SsePollResult::Event(frame);
                }
                continue;
            }

            if self.eof {
                return SsePollResult::Closed("SSE stream closed by kilnd".to_string());
            }

            let mut tmp = [0_u8; 4096];
            match self.stream.read(&mut tmp) {
                Ok(0) => {
                    self.eof = true;
                    if let Err(err) = self.drain_raw_into_body() {
                        return SsePollResult::Closed(err);
                    }
                    if let Some(block_str) = self.take_remaining_sse_block() {
                        if let Some(frame) = parse_sse_event_block(&block_str) {
                            return SsePollResult::Event(frame);
                        }
                    }
                    return SsePollResult::Closed("SSE connection closed".to_string());
                }
                Ok(n) => {
                    self.raw_buf.extend_from_slice(&tmp[..n]);
                    if self.raw_buf.len() > MAX_HTTP_RESPONSE_BYTES {
                        return SsePollResult::Closed("SSE buffer limit exceeded".to_string());
                    }
                    if let Err(err) = self.drain_raw_into_body() {
                        return SsePollResult::Closed(err);
                    }
                }
                Err(err)
                    if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return SsePollResult::Timeout;
                }
                Err(err) => {
                    return SsePollResult::Closed(format!("SSE read error: {err}"));
                }
            }
        }
    }

    fn drain_raw_into_body(&mut self) -> Result<(), String> {
        if !self.chunked {
            self.body_buf.append(&mut self.raw_buf);
            return Ok(());
        }

        loop {
            match self.chunk_remaining {
                Some(0) => {
                    if self.raw_buf.len() < 2 {
                        break;
                    }
                    if &self.raw_buf[..2] != b"\r\n" {
                        return Err("malformed chunk terminator in SSE stream".to_string());
                    }
                    self.raw_buf.drain(..2);
                    self.chunk_remaining = None;
                }
                Some(rem) => {
                    if self.raw_buf.is_empty() {
                        break;
                    }
                    let take = rem.min(self.raw_buf.len());
                    self.body_buf.extend(self.raw_buf.drain(..take));
                    self.chunk_remaining = Some(rem - take);
                }
                None => {
                    let Some(crlf_pos) = find_subslice(&self.raw_buf, b"\r\n") else {
                        break;
                    };
                    let size_line = std::str::from_utf8(&self.raw_buf[..crlf_pos])
                        .map_err(|_| "invalid UTF-8 in chunk size".to_string())?;
                    let hex_part = size_line.split(';').next().unwrap_or("").trim();
                    let chunk_len = usize::from_str_radix(hex_part, 16)
                        .map_err(|_| format!("invalid HTTP chunk size: {hex_part}"))?;
                    self.raw_buf.drain(..crlf_pos + 2);
                    if chunk_len == 0 {
                        self.eof = true;
                        break;
                    }
                    self.chunk_remaining = Some(chunk_len);
                }
            }
        }

        Ok(())
    }

    fn take_next_sse_block(&mut self) -> Option<String> {
        let lf_pos = find_subslice(&self.body_buf, b"\n\n");
        let crlf_pos = find_subslice(&self.body_buf, b"\r\n\r\n");

        let (idx, sep_len) = match (lf_pos, crlf_pos) {
            (Some(a), Some(b)) if a < b => (a, 2),
            (Some(_), Some(b)) => (b, 4),
            (Some(a), None) => (a, 2),
            (None, Some(b)) => (b, 4),
            (None, None) => return None,
        };

        let block_bytes: Vec<u8> = self.body_buf.drain(..idx).collect();
        self.body_buf.drain(..sep_len);
        Some(String::from_utf8_lossy(&block_bytes).into_owned())
    }

    fn take_remaining_sse_block(&mut self) -> Option<String> {
        if self.body_buf.is_empty() {
            return None;
        }
        let block_bytes = std::mem::take(&mut self.body_buf);
        Some(String::from_utf8_lossy(&block_bytes).into_owned())
    }
}

impl KilndClient {
    pub fn new(url: NormalizedKilndUrl) -> Self {
        Self { url }
    }

    pub fn fetch_health(&self) -> Result<KilnHealth, String> {
        let body = self.http_get_body("/api/health")?;
        parse_health_json(&body).map_err(|err| format!("failed to parse /api/health: {err}"))
    }

    pub fn fetch_bootstrap(&self) -> Result<KilnBootstrapSummary, String> {
        let body = self.http_get_body("/api/bootstrap")?;
        parse_bootstrap_summary_json(&body)
            .map_err(|err| format!("failed to parse /api/bootstrap: {err}"))
    }

    pub fn probe_tray_state(&self) -> TrayDisplayState {
        match self.fetch_health() {
            Err(err) => TrayDisplayState::from_probe(Err(&err), None),
            Ok(health) => {
                if !health.ok {
                    return TrayDisplayState::from_probe(Ok(&health), None);
                }
                let summary = match self.fetch_bootstrap() {
                    Ok(summary) => Some(summary),
                    Err(err) => {
                        eprintln!("kiln-desktop: /api/bootstrap probe failed: {err}");
                        None
                    }
                };
                TrayDisplayState::from_probe(Ok(&health), summary.as_ref())
            }
        }
    }

    pub fn open_sse_stream(&self, last_event_id: Option<&str>) -> Result<SseConnection, String> {
        let validated = validate_kilnd_url(&self.url.base_url)
            .map_err(|err| format!("blocked non-loopback kilnd URL: {err}"))?;
        let mut stream = connect_loopback(&validated, CONNECT_TIMEOUT, IO_TIMEOUT)?;

        let mut req = format!(
            "GET /api/events HTTP/1.1\r\nHost: {}\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n",
            validated.host_header()
        );
        if let Some(id) = last_event_id {
            if !id.is_empty() && !id.contains(['\r', '\n']) {
                req.push_str(&format!("Last-Event-ID: {id}\r\n"));
            }
        }
        req.push_str("\r\n");

        stream
            .write_all(req.as_bytes())
            .map_err(|err| format!("failed to send SSE request: {err}"))?;

        let (header_str, leftover) = read_http_headers(&mut stream)?;
        let status_code = parse_http_status(&header_str)?;
        if !(200..300).contains(&status_code) {
            return Err(format!("GET /api/events returned HTTP {status_code}"));
        }

        let chunked = has_chunked_encoding(&header_str);
        let (raw_buf, body_buf) = if chunked {
            (leftover, Vec::new())
        } else {
            (Vec::new(), leftover)
        };
        let mut conn = SseConnection {
            stream,
            chunked,
            chunk_remaining: None,
            raw_buf,
            body_buf,
            eof: false,
        };
        if chunked {
            conn.drain_raw_into_body()?;
        }
        Ok(conn)
    }

    fn http_get_body(&self, path: &str) -> Result<String, String> {
        let validated = validate_kilnd_url(&self.url.base_url)
            .map_err(|err| format!("blocked non-loopback kilnd URL: {err}"))?;
        let mut stream = connect_loopback(&validated, CONNECT_TIMEOUT, IO_TIMEOUT)?;

        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            validated.host_header()
        );
        stream
            .write_all(req.as_bytes())
            .map_err(|err| format!("failed to send GET {path}: {err}"))?;

        let mut response = Vec::new();
        let mut buf = [0_u8; 8192];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if response.len() + n > MAX_HTTP_RESPONSE_BYTES {
                        return Err(format!("GET {path} response exceeded size limit"));
                    }
                    response.extend_from_slice(&buf[..n]);
                }
                Err(err) => {
                    return Err(format!("GET {path} failed: {err}"));
                }
            }
        }

        let (header_end, sep_len) = find_header_end(&response)
            .ok_or_else(|| format!("GET {path} returned incomplete HTTP headers"))?;
        let header_str = std::str::from_utf8(&response[..header_end])
            .map_err(|_| format!("GET {path} headers are not valid UTF-8"))?;
        let status = parse_http_status(header_str)?;
        if !(200..300).contains(&status) {
            return Err(format!("GET {path} returned HTTP {status}"));
        }

        let raw_body = &response[header_end + sep_len..];
        let body_bytes = if has_chunked_encoding(header_str) {
            decode_chunked_body(raw_body)?
        } else {
            raw_body.to_vec()
        };

        String::from_utf8(body_bytes)
            .map_err(|_| format!("GET {path} response body is not valid UTF-8"))
    }
}

#[cfg(windows)]
fn configure_background_command(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_background_command(_cmd: &mut Command) {}

fn resolve_user_home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

pub fn spawn_kiln_up(url: &NormalizedKilndUrl) -> Result<String, String> {
    let validated = validate_kilnd_url(&url.base_url)
        .map_err(|err| format!("refusing kiln up on invalid URL: {err}"))?;
    let bin = resolve_kiln_binary()?;
    let mut cmd = Command::new(&bin);
    cmd.args([
        "up",
        "--host",
        &validated.host,
        "--port",
        &validated.port.to_string(),
    ]);
    configure_background_command(&mut cmd);
    apply_enriched_child_path(&mut cmd, &bin);
    let output = cmd
        .output()
        .map_err(|err| format!("failed to execute {} up: {err}", bin.display()))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        Err(format!("kiln up failed: {detail}"))
    }
}

pub fn run_kiln_down() -> Result<String, String> {
    let bin = resolve_kiln_binary()?;
    let mut cmd = Command::new(&bin);
    cmd.arg("down");
    configure_background_command(&mut cmd);
    apply_enriched_child_path(&mut cmd, &bin);
    let output = cmd
        .output()
        .map_err(|err| format!("failed to execute {} down: {err}", bin.display()))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        Err(format!("kiln down failed: {detail}"))
    }
}

fn apply_enriched_child_path(cmd: &mut Command, bin: &Path) {
    let current_path = env::var_os("PATH");
    let home_dir = resolve_user_home_dir();
    #[cfg(windows)]
    {
        let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let mut dirs = Vec::new();
        if let Some(bin_parent) = bin.parent().filter(|p| !p.as_os_str().is_empty()) {
            dirs.push(bin_parent.to_path_buf());
        }
        for dir in windows_kiln_search_dirs(local_app_data.as_deref(), home_dir.as_deref()) {
            if dir.is_dir() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        if let Some(raw_path) = current_path.as_deref() {
            for dir in env::split_paths(raw_path) {
                if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
                    dirs.push(dir);
                }
            }
        }
        if let Some(child_path) = join_path_dirs(&dirs) {
            cmd.env("PATH", child_path);
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(child_path) =
            build_kiln_child_path(bin, current_path.as_deref(), home_dir.as_deref())
        {
            cmd.env("PATH", child_path);
        }
    }
}

pub fn open_in_default_browser(url: &NormalizedKilndUrl) -> Result<(), String> {
    let validated = validate_kilnd_url(&url.base_url)
        .map_err(|err| format!("refusing to open non-loopback URL: {err}"))?;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&validated.base_url)
            .spawn()
            .map_err(|err| format!("failed to launch browser via open: {err}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&validated.base_url)
            .spawn()
            .map_err(|err| format!("failed to launch browser via xdg-open: {err}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&validated.base_url)
            .spawn()
            .map_err(|err| format!("failed to launch browser via explorer: {err}"))?;
        return Ok(());
    }
}

fn connect_loopback(
    url: &NormalizedKilndUrl,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> Result<TcpStream, String> {
    let addrs: Vec<SocketAddr> = url
        .tcp_host_port()
        .to_socket_addrs()
        .map_err(|err| format!("failed to resolve loopback address {}: {err}", url.base_url))?
        .filter(|addr| addr.ip().is_loopback())
        .collect();

    let Some(first_addr) = addrs.first() else {
        return Err(format!("no loopback socket address resolved for {}", url.base_url));
    };

    let mut last_err = None;
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, connect_timeout) {
            Ok(stream) => {
                let _ = stream.set_read_timeout(Some(io_timeout));
                let _ = stream.set_write_timeout(Some(io_timeout));
                return Ok(stream);
            }
            Err(err) => last_err = Some(err),
        }
    }

    Err(match last_err {
        Some(err) => format!("failed to connect to {first_addr}: {err}"),
        None => format!("failed to connect to {}", url.base_url),
    })
}

fn read_http_headers(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 1024];
    loop {
        if let Some((end, sep_len)) = find_header_end(&buf) {
            let header_str = std::str::from_utf8(&buf[..end])
                .map_err(|_| "HTTP response headers are not valid UTF-8".to_string())?
                .to_string();
            let leftover = buf[end + sep_len..].to_vec();
            return Ok((header_str, leftover));
        }
        if buf.len() >= MAX_HTTP_HEADER_BYTES {
            return Err("HTTP response headers exceeded limit".to_string());
        }
        match stream.read(&mut tmp) {
            Ok(0) => return Err("unexpected EOF while reading HTTP headers".to_string()),
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(err) => return Err(format!("failed reading HTTP headers: {err}")),
        }
    }
}

fn find_header_end(buf: &[u8]) -> Option<(usize, usize)> {
    let crlf = find_subslice(buf, b"\r\n\r\n");
    let lf = find_subslice(buf, b"\n\n");
    match (crlf, lf) {
        (Some(a), Some(b)) if a < b => Some((a, 4)),
        (Some(_), Some(b)) => Some((b, 2)),
        (Some(a), None) => Some((a, 4)),
        (None, Some(b)) => Some((b, 2)),
        (None, None) => None,
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_http_status(headers: &str) -> Result<u16, String> {
    let first_line = headers
        .lines()
        .next()
        .ok_or_else(|| "empty HTTP response".to_string())?;
    let mut parts = first_line.split_whitespace();
    let proto = parts.next().unwrap_or("");
    if !proto.starts_with("HTTP/") {
        return Err(format!("invalid HTTP status line: {first_line}"));
    }
    let code_str = parts
        .next()
        .ok_or_else(|| format!("missing HTTP status code in: {first_line}"))?;
    code_str
        .parse::<u16>()
        .map_err(|_| format!("invalid HTTP status code: {code_str}"))
}

fn has_chunked_encoding(headers: &str) -> bool {
    headers.lines().skip(1).any(|line| {
        if let Some((name, value)) = line.split_once(':') {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
        } else {
            false
        }
    })
}

fn decode_chunked_body(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut pos = 0;
    let mut out = Vec::new();
    loop {
        let Some(rel_end) = find_subslice(&raw[pos..], b"\r\n") else {
            return Err("incomplete chunk header in HTTP body".to_string());
        };
        let size_line = std::str::from_utf8(&raw[pos..pos + rel_end])
            .map_err(|_| "invalid UTF-8 in HTTP chunk size".to_string())?;
        let hex_len = size_line.split(';').next().unwrap_or("").trim();
        let len = usize::from_str_radix(hex_len, 16)
            .map_err(|_| format!("invalid HTTP chunk length: {hex_len}"))?;
        pos += rel_end + 2;
        if len == 0 {
            return Ok(out);
        }
        let end = pos + len;
        if end + 2 > raw.len() {
            return Err("truncated HTTP chunk payload".to_string());
        }
        out.extend_from_slice(&raw[pos..end]);
        if &raw[end..end + 2] != b"\r\n" {
            return Err("missing CRLF after HTTP chunk payload".to_string());
        }
        pos = end + 2;
    }
}

fn collect_versioned_node_bins(home_dir: Option<&Path>) -> Vec<PathBuf> {
    let Some(home) = home_dir.filter(|p| !p.as_os_str().is_empty()) else {
        return Vec::new();
    };

    let roots = [
        (".local/share/mise/installs/node", "bin"),
        (".nvm/versions/node", "bin"),
        (".fnm/node-versions", "installation/bin"),
        ("Library/Application Support/fnm/node-versions", "installation/bin"),
    ];

    let mut versioned: Vec<((u64, u64, u64), PathBuf)> = Vec::new();
    for (root_rel, bin_rel) in roots {
        let root_dir = home.join(root_rel);
        let Ok(entries) = fs::read_dir(root_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            let Some(ver_key) = parse_semver_key(name_str) else {
                continue;
            };
            let bin_dir = entry.path().join(bin_rel);
            if bin_dir.is_dir() {
                versioned.push((ver_key, bin_dir));
            }
        }
    }

    versioned.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

    let mut deduped = Vec::new();
    for (_key, dir) in versioned {
        if !deduped.contains(&dir) {
            deduped.push(dir);
        }
    }
    deduped
}

fn is_kept_system_dir(dir: &Path) -> bool {
    matches!(
        dir.to_str(),
        Some("/usr/bin" | "/bin" | "/usr/sbin" | "/sbin")
    )
}

pub fn build_kiln_child_path(
    bin: &Path,
    current_path: Option<&OsStr>,
    home_dir: Option<&Path>,
) -> Option<OsString> {
    let bin_parent = bin.parent().filter(|p| !p.as_os_str().is_empty());
    let existing_entries: Vec<PathBuf> = current_path
        .map(|raw| env::split_paths(raw).filter(|p| !p.as_os_str().is_empty()).collect())
        .unwrap_or_default();
    let versioned_bins = collect_versioned_node_bins(home_dir);
    let candidate_dirs =
        build_child_command_path_dirs(bin_parent, current_path, home_dir, &versioned_bins);

    let filtered: Vec<PathBuf> = candidate_dirs
        .into_iter()
        .filter(|dir| {
            bin_parent == Some(dir.as_path())
                || existing_entries.iter().any(|existing| existing == dir)
                || is_kept_system_dir(dir)
                || dir.is_dir()
        })
        .collect();

    join_path_dirs(&filtered)
}

fn resolve_kiln_binary() -> Result<PathBuf, String> {
    let explicit = env::var("KILN_BIN").ok();
    let current_exe = env::current_exe().ok();
    let current_path = env::var_os("PATH");
    let home_dir = resolve_user_home_dir();
    let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    resolve_kiln_binary_for_platform(
        explicit.as_deref(),
        current_exe.as_deref(),
        current_path.as_deref(),
        home_dir.as_deref(),
        local_app_data.as_deref(),
        cfg!(windows),
    )
}

#[cfg(test)]
fn resolve_kiln_binary_with(
    explicit_kiln_bin: Option<&str>,
    current_path: Option<&OsStr>,
    home_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    resolve_kiln_binary_for_platform(
        explicit_kiln_bin,
        None,
        current_path,
        home_dir,
        None,
        cfg!(windows),
    )
}

fn resolve_kiln_binary_for_platform(
    explicit_kiln_bin: Option<&str>,
    current_exe: Option<&Path>,
    current_path: Option<&OsStr>,
    home_dir: Option<&Path>,
    local_app_data: Option<&Path>,
    is_windows: bool,
) -> Result<PathBuf, String> {
    // 1. Explicit KILN_BIN environment override always wins.
    if let Some(raw_explicit) = explicit_kiln_bin {
        let trimmed = raw_explicit.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_file() {
                return Ok(candidate);
            }
            return Err(format!(
                "KILN_BIN points to missing file: {}",
                candidate.display()
            ));
        }
    }

    // 2. Sibling sidecar binary bundled alongside the desktop executable (`kiln` / `kiln.exe`).
    if let Some(sidecar) = sidecar_candidate_path(current_exe, is_windows) {
        if sidecar.is_file() {
            let is_same_as_self = match (current_exe.and_then(|p| fs::canonicalize(p).ok()), fs::canonicalize(&sidecar).ok()) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            };
            if !is_same_as_self {
                return Ok(sidecar);
            }
        }
    }

    let bin_names = platform_kiln_binary_names(is_windows);

    // 3. Existing PATH lookup.
    if let Some(path_var) = current_path {
        for dir in env::split_paths(path_var) {
            for bin_name in bin_names {
                let candidate = dir.join(bin_name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    // 4. Standard user install & Node version-manager fallback directories.
    let search_dirs = if is_windows {
        windows_kiln_search_dirs(local_app_data, home_dir)
    } else {
        let versioned_bins = collect_versioned_node_bins(home_dir);
        standard_kiln_search_dirs(home_dir, &versioned_bins)
    };
    for dir in search_dirs {
        for bin_name in bin_names {
            let candidate = dir.join(bin_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err("unable to locate `kiln` CLI binary in PATH or standard install directories".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliInstallOutcome {
    pub bin_dir: PathBuf,
    pub display_bin_dir: String,
    pub target_bin: PathBuf,
    pub in_path: bool,
}

#[cfg(unix)]
fn atomic_replace_symlink(target: &Path, link_path: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    if let (Ok(canon_target), Ok(canon_link)) = (fs::canonicalize(target), fs::canonicalize(link_path))
    {
        if canon_target == canon_link {
            return Ok(());
        }
    }

    let parent = link_path
        .parent()
        .ok_or_else(|| format!("invalid link path: {}", link_path.display()))?;
    let file_name = link_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("kiln");
    let tmp_link = parent.join(format!(".{file_name}.kiln-tmp-{}", std::process::id()));
    let _ = fs::remove_file(&tmp_link);

    symlink(target, &tmp_link).map_err(|err| {
        format!(
            "failed to create symlink {} -> {}: {err}",
            link_path.display(),
            target.display()
        )
    })?;

    if let Err(err) = fs::rename(&tmp_link, link_path) {
        let _ = fs::remove_file(&tmp_link);
        return Err(format!(
            "failed to install symlink {}: {err}",
            link_path.display()
        ));
    }

    Ok(())
}

#[cfg(unix)]
pub fn install_posix_cli_symlinks(
    source_bin: &Path,
    bin_dir: &Path,
    current_path: Option<&OsStr>,
) -> Result<CliInstallOutcome, String> {
    if !source_bin.is_file() {
        return Err(format!(
            "kiln binary does not exist: {}",
            source_bin.display()
        ));
    }
    let canonical_source = fs::canonicalize(source_bin).unwrap_or_else(|_| source_bin.to_path_buf());
    fs::create_dir_all(bin_dir)
        .map_err(|err| format!("failed to create {}: {err}", bin_dir.display()))?;

    atomic_replace_symlink(&canonical_source, &bin_dir.join("kiln"))?;
    atomic_replace_symlink(&canonical_source, &bin_dir.join("kl"))?;

    let in_path = path_contains_dir(current_path, bin_dir, false);
    Ok(CliInstallOutcome {
        bin_dir: bin_dir.to_path_buf(),
        display_bin_dir: "~/.local/bin".to_string(),
        target_bin: canonical_source,
        in_path,
    })
}

#[allow(dead_code)]
fn atomic_write_file(dest: &Path, content: &str) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("invalid destination path: {}", dest.display()))?;
    let file_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("kiln.cmd");
    let tmp_path = parent.join(format!(".{file_name}.kiln-tmp-{}", std::process::id()));
    fs::write(&tmp_path, content)
        .map_err(|err| format!("failed to write {}: {err}", tmp_path.display()))?;
    if let Err(err) = fs::rename(&tmp_path, dest) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("failed to move shim to {}: {err}", dest.display()));
    }
    Ok(())
}

#[allow(dead_code)]
fn normalize_path_for_windows_identity(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| {
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            fs::canonicalize(parent)
                .map(|p| p.join(name))
                .unwrap_or_else(|_| path.to_path_buf())
        } else {
            path.to_path_buf()
        }
    });
    let s = resolved.to_string_lossy().replace('/', "\\");
    s.trim_start_matches(r"\\?\").to_ascii_lowercase()
}

#[allow(dead_code)]
fn paths_equal_windows(a: &Path, b: &Path) -> bool {
    normalize_path_for_windows_identity(a) == normalize_path_for_windows_identity(b)
}

/// Writes user-local `kiln.cmd` and `kl.cmd` shims into `%LOCALAPPDATA%\Kiln\bin` without UAC.
/// Guards against self-overwriting existing `kiln.cmd` / `kl.cmd` shims or shadowing an already-installed
/// `kiln.exe` in the same directory.
#[allow(dead_code)]
pub fn install_windows_cli_shims(
    source_bin: &Path,
    bin_dir: &Path,
    current_path: Option<&OsStr>,
) -> Result<CliInstallOutcome, String> {
    if !source_bin.is_file() {
        return Err(format!(
            "kiln.exe binary does not exist: {}",
            source_bin.display()
        ));
    }
    let canonical_source =
        fs::canonicalize(source_bin).unwrap_or_else(|_| source_bin.to_path_buf());
    let shim_body = render_windows_cli_shim(&canonical_source)?;
    fs::create_dir_all(bin_dir)
        .map_err(|err| format!("failed to create {}: {err}", bin_dir.display()))?;

    let kiln_cmd = bin_dir.join("kiln.cmd");
    let kiln_exe = bin_dir.join("kiln.exe");
    let kl_cmd = bin_dir.join("kl.cmd");

    let source_is_kiln_cmd = paths_equal_windows(&canonical_source, &kiln_cmd);
    let source_is_kiln_exe = paths_equal_windows(&canonical_source, &kiln_exe);
    let source_is_kl_cmd = paths_equal_windows(&canonical_source, &kl_cmd);

    if !source_is_kiln_cmd && !source_is_kiln_exe {
        atomic_write_file(&kiln_cmd, &shim_body)?;
    }
    if !source_is_kl_cmd {
        atomic_write_file(&kl_cmd, &shim_body)?;
    }

    let in_path = path_contains_dir(current_path, bin_dir, true);
    Ok(CliInstallOutcome {
        bin_dir: bin_dir.to_path_buf(),
        display_bin_dir: "%LOCALAPPDATA%\\Kiln\\bin".to_string(),
        target_bin: canonical_source,
        in_path,
    })
}

/// Installs user-local `kiln` and `kl` CLI commands pointing to the bundled sidecar (or active binary)
/// without modifying shell profiles, Registry auto-start, or requiring administrator privileges.
pub fn install_cli_command() -> Result<CliInstallOutcome, String> {
    let source_bin = resolve_kiln_binary()?;
    let current_path = env::var_os("PATH");

    #[cfg(unix)]
    {
        let home = resolve_user_home_dir()
            .ok_or_else(|| "unable to determine HOME directory".to_string())?;
        let bin_dir = home.join(".local").join("bin");
        let outcome = install_posix_cli_symlinks(&source_bin, &bin_dir, current_path.as_deref())?;
        return Ok(outcome);
    }

    #[cfg(windows)]
    {
        let local_app_data = env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                resolve_user_home_dir().map(|h| h.join("AppData").join("Local"))
            })
            .ok_or_else(|| "unable to determine LOCALAPPDATA directory".to_string())?;
        let bin_dir = local_app_data.join("Kiln").join("bin");
        let outcome = install_windows_cli_shims(&source_bin, &bin_dir, current_path.as_deref())?;
        return Ok(outcome);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = env::temp_dir().join(format!(
                "kiln-desktop-test-{prefix}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp test dir");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, content: &str) {
        use std::os::unix::fs::PermissionsExt;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent dir");
        }
        fs::write(path, content).expect("write executable script");
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .expect("chmod +x executable");
    }

    #[test]
    fn collects_versioned_node_bins_sorted_descending_and_ignores_aliases() {
        let guard = TempDirGuard::new("semver-bins");
        let home = &guard.path;

        let v22 = home.join(".local/share/mise/installs/node/22.19.0/bin");
        let v24 = home.join(".local/share/mise/installs/node/24.20.0/bin");
        let v20 = home.join(".nvm/versions/node/v20.11.0/bin");
        let fnm_v21 = home.join(".fnm/node-versions/v21.7.3/installation/bin");
        let global_alias = home.join(".local/share/mise/installs/node/global/bin");
        let missing_bin_parent = home.join(".local/share/mise/installs/node/25.0.0");

        for dir in [&v22, &v24, &v20, &fnm_v21, &global_alias, &missing_bin_parent] {
            fs::create_dir_all(dir).expect("create test node dir");
        }

        let collected = collect_versioned_node_bins(Some(home));
        assert_eq!(collected, vec![v24, v22, fnm_v21, v20]);
    }

    #[test]
    fn resolves_kiln_binary_from_version_managers_and_reports_missing_explicit_kiln_bin() {
        let guard = TempDirGuard::new("resolve-bin");
        let home = &guard.path;
        let mise_v24_bin = home.join(".local/share/mise/installs/node/24.20.0/bin");
        fs::create_dir_all(&mise_v24_bin).expect("create mise bin");
        let fake_kiln = mise_v24_bin.join("kiln");
        fs::write(&fake_kiln, "#!/usr/bin/env node\n").expect("write fake kiln");

        let resolved = resolve_kiln_binary_for_platform(
            None,
            None,
            Some(OsStr::new("/nonexistent-empty")),
            Some(home),
            None,
            false,
        )
        .expect("should resolve kiln inside mise node dir");
        assert_eq!(resolved, fake_kiln);

        let missing = home.join("missing-kiln");
        let err = resolve_kiln_binary_with(
            Some(missing.to_str().unwrap()),
            Some(OsStr::new("/nonexistent-empty")),
            Some(home),
        )
        .expect_err("explicit KILN_BIN missing file must fail");
        assert!(err.starts_with("KILN_BIN points to missing file:"));
    }

    #[cfg(unix)]
    #[test]
    fn executes_env_node_shebang_script_with_bare_finder_path_via_enriched_child_path() {
        let guard = TempDirGuard::new("finder-path");
        let home = &guard.path;

        let mise_global_bin = home.join(".local/share/mise/installs/node/global/bin");
        let fake_node = mise_global_bin.join("node");
        write_executable(
            &fake_node,
            "#!/bin/sh\necho \"FAKE_NODE_RAN:$*\"\n",
        );

        let kiln_bin = home.join(".local/bin/kiln");
        write_executable(
            &kiln_bin,
            "#!/usr/bin/env node\nok\n",
        );

        let bare_finder_path = OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin");
        let child_path = build_kiln_child_path(&kiln_bin, Some(bare_finder_path), Some(home))
            .expect("child PATH must be constructed");

        let output = Command::new(&kiln_bin)
            .args(["up", "--host", "127.0.0.1", "--port", "4310"])
            .env("PATH", &child_path)
            .output()
            .expect("kiln script with #!/usr/bin/env node should launch under enriched PATH");

        assert!(
            output.status.success(),
            "expected success, stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("FAKE_NODE_RAN:"), "stdout was: {stdout}");
        assert!(stdout.contains(&kiln_bin.display().to_string()));
    }

    #[test]
    fn sidecar_binary_takes_priority_over_path_and_kiln_bin_overrides_sidecar() {
        let guard = TempDirGuard::new("sidecar-priority");
        let root = &guard.path;

        let bundle_macos_dir = root.join("Kiln.app/Contents/MacOS");
        let path_dir = root.join("path-bin");
        let override_dir = root.join("override-bin");
        fs::create_dir_all(&bundle_macos_dir).expect("create bundle dir");
        fs::create_dir_all(&path_dir).expect("create path dir");
        fs::create_dir_all(&override_dir).expect("create override dir");

        let fake_desktop_exe = bundle_macos_dir.join("kiln-desktop");
        let sidecar_kiln = bundle_macos_dir.join("kiln");
        let path_kiln = path_dir.join("kiln");
        let override_kiln = override_dir.join("kiln");
        fs::write(&fake_desktop_exe, "desktop").expect("write fake desktop exe");
        fs::write(&sidecar_kiln, "sidecar").expect("write sidecar");
        fs::write(&path_kiln, "path").expect("write path kiln");
        fs::write(&override_kiln, "override").expect("write override kiln");

        // Sidecar wins over PATH
        let resolved_sidecar = resolve_kiln_binary_for_platform(
            None,
            Some(&fake_desktop_exe),
            Some(path_dir.as_os_str()),
            Some(root),
            None,
            false,
        )
        .expect("should resolve sibling sidecar");
        assert_eq!(resolved_sidecar, sidecar_kiln);

        // Explicit KILN_BIN wins over sidecar
        let resolved_override = resolve_kiln_binary_for_platform(
            override_kiln.to_str(),
            Some(&fake_desktop_exe),
            Some(path_dir.as_os_str()),
            Some(root),
            None,
            false,
        )
        .expect("should resolve explicit KILN_BIN");
        assert_eq!(resolved_override, override_kiln);

        // Windows sidecar (`kiln.exe` next to `kiln-desktop.exe`) and `%LOCALAPPDATA%\Kiln\bin\kiln.exe` lookup
        let win_app_dir = root.join("WinApp");
        let win_local_app_data = root.join("LocalAppData");
        let win_local_bin = win_local_app_data.join("Kiln/bin");
        fs::create_dir_all(&win_app_dir).expect("create win app dir");
        fs::create_dir_all(&win_local_bin).expect("create win local bin");
        let win_desktop_exe = win_app_dir.join("kiln-desktop.exe");
        let win_sidecar_exe = win_app_dir.join("kiln.exe");
        let win_fallback_exe = win_local_bin.join("kiln.exe");
        fs::write(&win_desktop_exe, "win-desktop").expect("write win desktop");
        fs::write(&win_fallback_exe, "win-fallback").expect("write win fallback");

        let resolved_win_fallback = resolve_kiln_binary_for_platform(
            None,
            Some(&win_desktop_exe),
            None,
            Some(root),
            Some(&win_local_app_data),
            true,
        )
        .expect("should fall back to LOCALAPPDATA\\Kiln\\bin\\kiln.exe");
        assert_eq!(resolved_win_fallback, win_fallback_exe);

        // Self-recursion guard: if current_exe itself is named `Kiln.exe`, never resolve it as sidecar
        let win_self_named = win_app_dir.join("Kiln.exe");
        fs::write(&win_self_named, "win-self").expect("write win self");
        let resolved_no_self = resolve_kiln_binary_for_platform(
            None,
            Some(&win_self_named),
            None,
            Some(root),
            Some(&win_local_app_data),
            true,
        )
        .expect("should fall back instead of self-recursing on Kiln.exe");
        assert_eq!(resolved_no_self, win_fallback_exe);
        let _ = fs::remove_file(&win_self_named);

        fs::write(&win_sidecar_exe, "win-sidecar").expect("write win sidecar");
        let resolved_win_sidecar = resolve_kiln_binary_for_platform(
            None,
            Some(&win_desktop_exe),
            None,
            Some(root),
            Some(&win_local_app_data),
            true,
        )
        .expect("should prefer sibling kiln.exe sidecar on Windows");
        assert_eq!(resolved_win_sidecar, win_sidecar_exe);
    }

    #[cfg(unix)]
    #[test]
    fn installs_posix_cli_symlinks_idempotently_without_touching_shell_profiles() {
        let guard = TempDirGuard::new("posix-cli-install");
        let home = &guard.path;
        let sidecar = home.join("Kiln.app/Contents/MacOS/kiln");
        write_executable(&sidecar, "#!/bin/sh\necho kiln-sidecar\n");

        let local_bin = home.join(".local/bin");
        let first = install_posix_cli_symlinks(&sidecar, &local_bin, Some(OsStr::new("/usr/bin:/bin")))
            .expect("first symlink install must succeed");
        assert!(!first.in_path);
        assert_eq!(
            fs::read_link(local_bin.join("kiln")).expect("read kiln symlink"),
            fs::canonicalize(&sidecar).expect("canon sidecar")
        );
        assert_eq!(
            fs::read_link(local_bin.join("kl")).expect("read kl symlink"),
            fs::canonicalize(&sidecar).expect("canon sidecar")
        );

        // Idempotent re-install when ~/.local/bin IS in PATH
        let second = install_posix_cli_symlinks(&sidecar, &local_bin, Some(local_bin.as_os_str()))
            .expect("second symlink install must succeed");
        assert!(second.in_path);

        // Never modifies shell profiles or LaunchAgents
        assert!(!home.join(".zshrc").exists());
        assert!(!home.join(".bashrc").exists());
        assert!(!home.join(".profile").exists());
        assert!(!home.join("Library/LaunchAgents").exists());
    }

    #[test]
    fn installs_windows_cli_shims_idempotently() {
        let guard = TempDirGuard::new("win-shim-install");
        let root = &guard.path;
        let sidecar = root.join("Kiln/kiln.exe");
        fs::create_dir_all(sidecar.parent().unwrap()).expect("create sidecar dir");
        fs::write(&sidecar, "MZ").expect("write fake exe");

        let bin_dir = root.join("LocalAppData/Kiln/bin");
        let outcome = install_windows_cli_shims(&sidecar, &bin_dir, Some(OsStr::new("C:\\Windows\\System32")))
            .expect("shim install must succeed");
        assert!(!outcome.in_path);

        let kiln_cmd = fs::read_to_string(bin_dir.join("kiln.cmd")).expect("read kiln.cmd");
        let kl_cmd = fs::read_to_string(bin_dir.join("kl.cmd")).expect("read kl.cmd");
        assert_eq!(kiln_cmd, kl_cmd);
        assert!(kiln_cmd.starts_with("@echo off\r\n"));
        assert!(kiln_cmd.contains(&fs::canonicalize(&sidecar).unwrap().display().to_string()));
        assert!(kiln_cmd.ends_with("%*\r\n"));

        // Self-overwrite guard 1: source_bin IS bin_dir\kiln.cmd -> preserve kiln.cmd, delegate via `call` in kl.cmd
        let self_cmd_dir = root.join("SelfCmdBin");
        fs::create_dir_all(&self_cmd_dir).expect("create self cmd dir");
        let existing_kiln_cmd = self_cmd_dir.join("kiln.cmd");
        let sentinel = "@echo off\r\n\"C:\\Custom\\kiln.exe\" %*\r\n";
        fs::write(&existing_kiln_cmd, sentinel).expect("write sentinel kiln.cmd");
        install_windows_cli_shims(&existing_kiln_cmd, &self_cmd_dir, None)
            .expect("self-referencing kiln.cmd must succeed safely without self-overwrite");
        assert_eq!(
            fs::read_to_string(&existing_kiln_cmd).expect("read preserved kiln.cmd"),
            sentinel
        );
        let generated_kl = fs::read_to_string(self_cmd_dir.join("kl.cmd")).expect("read kl.cmd");
        assert!(generated_kl.contains("call \""));
        assert!(generated_kl.contains("kiln.cmd\" %*"));

        // Self-overwrite guard 2: source_bin IS bin_dir\kiln.exe -> do not create redundant kiln.cmd, only kl.cmd
        let self_exe_dir = root.join("SelfExeBin");
        fs::create_dir_all(&self_exe_dir).expect("create self exe dir");
        let existing_kiln_exe = self_exe_dir.join("kiln.exe");
        fs::write(&existing_kiln_exe, "MZ").expect("write kiln.exe");
        install_windows_cli_shims(&existing_kiln_exe, &self_exe_dir, None)
            .expect("existing kiln.exe in bin_dir must succeed");
        assert!(!self_exe_dir.join("kiln.cmd").exists());
        let kl_for_exe = fs::read_to_string(self_exe_dir.join("kl.cmd")).expect("read kl.cmd");
        assert!(kl_for_exe.contains("kiln.exe\" %*"));
    }
}
