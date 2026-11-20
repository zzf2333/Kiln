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
    parse_semver_key, parse_sse_event_block, standard_kiln_search_dirs, validate_kilnd_url,
    KilnBootstrapSummary, KilnHealth, NormalizedKilndUrl, SseEventFrame, TrayDisplayState,
    DEFAULT_KILND_URL,
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
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    if let Some(child_path) =
        build_kiln_child_path(bin, current_path.as_deref(), home_dir.as_deref())
    {
        cmd.env("PATH", child_path);
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
    let current_path = env::var_os("PATH");
    let home_dir = env::var_os("HOME").map(PathBuf::from);
    resolve_kiln_binary_with(
        explicit.as_deref(),
        current_path.as_deref(),
        home_dir.as_deref(),
    )
}

fn resolve_kiln_binary_with(
    explicit_kiln_bin: Option<&str>,
    current_path: Option<&OsStr>,
    home_dir: Option<&Path>,
) -> Result<PathBuf, String> {
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

    if let Some(path_var) = current_path {
        for dir in env::split_paths(path_var) {
            let candidate = dir.join("kiln");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    let versioned_bins = collect_versioned_node_bins(home_dir);
    for dir in standard_kiln_search_dirs(home_dir, &versioned_bins) {
        let candidate = dir.join("kiln");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err("unable to locate `kiln` CLI binary in PATH or standard install directories".to_string())
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

        let resolved =
            resolve_kiln_binary_with(None, Some(OsStr::new("/nonexistent-empty")), Some(home))
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
}
