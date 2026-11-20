#!/bin/sh
set -eu

REPO_SLUG="zzf2333/Kiln"
RELEASE_BASE_URL="${KILN_RELEASE_BASE_URL:-https://github.com/${REPO_SLUG}/releases/download}"
RELEASE_LATEST_URL="${KILN_RELEASE_LATEST_URL:-https://github.com/${REPO_SLUG}/releases/latest}"

install_version=""
install_prefix=""
dry_run=0

print_usage() {
  printf '%s\n' \
    "Kiln CLI Installer (Zero-Dependency Standalone Binary)" \
    "" \
    "Usage:" \
    "  install.sh [options]" \
    "" \
    "Options:" \
    "  --version <ver>   Install a specific Kiln version (e.g. 0.1.0 or v0.1.0)" \
    "  --prefix <dir>    Install into <dir>/bin (default: \$HOME/.local -> \$HOME/.local/bin)" \
    "  --dry-run         Print planned download URL, checksum plan, and install paths without modifying disk" \
    "  -h, --help        Show this help message" \
    "" \
    "Guarantees:" \
    "  - Zero Node.js / npm runtime requirement (downloads prebuilt single binary + verifies SHA256SUMS)" \
    "  - Never modifies ~/.zshrc, ~/.bashrc, ~/.profile, LaunchAgents, systemd units, or crontab"
}

log_err() {
  printf '%s\n' "Error: $*" >&2
}

usage_error() {
  log_err "$1"
  printf '\n' >&2
  print_usage >&2
  exit 2
}

detect_target() {
  raw_os="$(uname -s 2>/dev/null || printf 'unknown')"
  raw_arch="$(uname -m 2>/dev/null || printf 'unknown')"

  case "${raw_os}:${raw_arch}" in
    Darwin:arm64|Darwin:aarch64)
      printf '%s\n' "darwin-arm64"
      ;;
    Darwin:x86_64|Darwin:amd64)
      printf '%s\n' "darwin-x64"
      ;;
    Linux:x86_64|Linux:amd64)
      printf '%s\n' "linux-x64"
      ;;
    *)
      log_err "Unsupported OS/architecture: ${raw_os}/${raw_arch} (supported: darwin-arm64, darwin-x64, linux-x64)."
      exit 1
      ;;
  esac
}

detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    printf '%s\n' "curl"
  elif command -v wget >/dev/null 2>&1; then
    printf '%s\n' "wget"
  else
    log_err "Either 'curl' or 'wget' is required to download Kiln release binaries."
    exit 1
  fi
}

download_file() {
  downloader="$1"
  url="$2"
  dest="$3"
  if [ "$downloader" = "curl" ]; then
    curl -fsSL "$url" -o "$dest"
  else
    wget -qO "$dest" "$url"
  fi
}

resolve_latest_version() {
  downloader="$1"
  if [ "$downloader" = "curl" ]; then
    effective_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASE_LATEST_URL" 2>/dev/null || printf '')"
  else
    effective_url="$(wget --max-redirect=5 --spider -S "$RELEASE_LATEST_URL" 2>&1 | sed -n 's/^[[:space:]]*[Ll]ocation:[[:space:]]*//p' | tail -n 1 | tr -d '\r' || printf '')"
  fi

  case "$effective_url" in
    */tag/v*)
      resolved="${effective_url##*/tag/v}"
      resolved="${resolved%%\?*}"
      resolved="${resolved%%#*}"
      resolved="${resolved%%/}"
      if [ -n "$resolved" ]; then
        printf '%s\n' "$resolved"
        return 0
      fi
      ;;
  esac

  log_err "Unable to resolve latest Kiln release version from ${RELEASE_LATEST_URL}. Pass --version <ver> explicitly."
  exit 1
}

compute_sha256() {
  file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file_path" | awk '{print tolower($NF)}'
  else
    log_err "No SHA-256 verification utility found (need sha256sum, shasum, or openssl)."
    exit 1
  fi
}

lookup_expected_sha256() {
  sums_file="$1"
  asset_name="$2"
  awk -v target="$asset_name" '
    {
      if (NF < 2) next
      hash = tolower($1)
      name = $2
      sub(/^\*/, "", name)
      sub(/^\.\//, "", name)
      if (name == target) {
        print hash
        exit 0
      }
    }
  ' "$sums_file"
}

print_next_steps() {
  bin_dir="$1"
  printf '\n%s\n' "Next steps:"
  case ":${PATH:-}:" in
    *":${bin_dir}:"*)
      ;;
    *)
      printf '%s\n' "  Ensure \"${bin_dir}\" is in your PATH (this installer never edits shell profiles):"
      printf '%s\n' "    export PATH=\"${bin_dir}:\$PATH\""
      ;;
  esac
  printf '%s\n' "  1. Verify environment:     kiln doctor"
  printf '%s\n' "  2. Start local daemon:     kiln up"
  printf '%s\n' "  3. Optional auto-start:    kiln service install"
  printf '%s\n' "  4. Clean uninstall:        kiln uninstall"
  printf '%s\n' "  (Short alias 'kl' is symlinked alongside 'kiln'.)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    --dry-run)
      dry_run=1
      shift 1
      ;;
    --version)
      if [ $# -lt 2 ]; then
        usage_error "Missing value for --version"
      fi
      case "$2" in
        ""|-*)
          usage_error "Invalid or missing value for --version: $2"
          ;;
      esac
      install_version="$2"
      shift 2
      ;;
    --version=*)
      install_version="${1#--version=}"
      case "$install_version" in
        ""|-*)
          usage_error "Invalid or empty value for --version: $install_version"
          ;;
      esac
      shift 1
      ;;
    --prefix)
      if [ $# -lt 2 ]; then
        usage_error "Missing value for --prefix"
      fi
      case "$2" in
        ""|-*)
          usage_error "Invalid or missing value for --prefix: $2"
          ;;
      esac
      install_prefix="$2"
      shift 2
      ;;
    --prefix=*)
      install_prefix="${1#--prefix=}"
      case "$install_prefix" in
        ""|-*)
          usage_error "Invalid or empty value for --prefix: $install_prefix"
          ;;
      esac
      shift 1
      ;;
    *)
      usage_error "Unknown argument: $1"
      ;;
  esac
done

if [ -n "$install_version" ]; then
  install_version="${install_version#v}"
  case "$install_version" in
    ""|*[!A-Za-z0-9._+-]*)
      usage_error "Invalid --version characters: $install_version"
      ;;
  esac
fi

if [ -z "$install_prefix" ]; then
  if [ -z "${HOME:-}" ]; then
    log_err "HOME is not set; specify --prefix <dir> explicitly."
    exit 1
  fi
  install_prefix="${HOME}/.local"
fi

bin_dir="${install_prefix%/}/bin"
target="$(detect_target)"
downloader="$(detect_downloader)"

if [ "$dry_run" -eq 1 ]; then
  display_ver="${install_version:-latest}"
  if [ -n "$install_version" ]; then
    tag="v${install_version}"
    asset_name="kiln-${tag}-${target}"
    binary_url="${RELEASE_BASE_URL}/${tag}/${asset_name}"
    sums_url="${RELEASE_BASE_URL}/${tag}/SHA256SUMS"
  else
    asset_name="kiln-v<latest>-${target}"
    binary_url="${RELEASE_BASE_URL}/v<latest>/${asset_name}"
    sums_url="${RELEASE_BASE_URL}/v<latest>/SHA256SUMS"
  fi

  printf '%s\n' "[dry-run] Planned Kiln standalone binary installation (no files will be modified):"
  printf '%s\n' "  Target:      ${target}"
  printf '%s\n' "  Version:     ${display_ver}"
  printf '%s\n' "  Downloader:  ${downloader} (Node.js not required)"
  printf '%s\n' "  Binary URL:  ${binary_url}"
  printf '%s\n' "  Checksums:   ${sums_url}"
  printf '%s\n' "  Install bin: ${bin_dir}/kiln"
  printf '%s\n' "  Alias link:  ${bin_dir}/kl -> kiln"
  printf '%s\n' "  System services / shell profiles: untouched"
  print_next_steps "$bin_dir"
  exit 0
fi

if [ -z "$install_version" ]; then
  install_version="$(resolve_latest_version "$downloader")"
  install_version="${install_version#v}"
  case "$install_version" in
    ""|*[!A-Za-z0-9._+-]*)
      log_err "Resolved invalid release version from ${RELEASE_LATEST_URL}: ${install_version}"
      exit 1
      ;;
  esac
fi

tag="v${install_version}"
asset_name="kiln-${tag}-${target}"
binary_url="${RELEASE_BASE_URL}/${tag}/${asset_name}"
sums_url="${RELEASE_BASE_URL}/${tag}/SHA256SUMS"

tmp_dir="$(mktemp -d)"
staged_bin=""
staged_link=""
cleanup() {
  if [ -n "$staged_bin" ]; then
    rm -f "$staged_bin"
  fi
  if [ -n "$staged_link" ]; then
    rm -f "$staged_link"
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

bin_download="${tmp_dir}/${asset_name}"
sums_download="${tmp_dir}/SHA256SUMS"

printf '%s\n' "Downloading Kiln ${tag} (${target})..."
download_file "$downloader" "$binary_url" "$bin_download"
download_file "$downloader" "$sums_url" "$sums_download"

expected_sha="$(lookup_expected_sha256 "$sums_download" "$asset_name")"
case "$expected_sha" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ;;
  *)
    log_err "No valid SHA-256 entry for ${asset_name} in SHA256SUMS."
    exit 1
    ;;
esac

actual_sha="$(compute_sha256 "$bin_download")"
if [ "$actual_sha" != "$expected_sha" ]; then
  log_err "SHA-256 mismatch for ${asset_name}: expected ${expected_sha}, got ${actual_sha}."
  exit 1
fi

mkdir -p "$bin_dir"
staged_bin="${bin_dir}/.kiln.tmp.$$"
staged_link="${bin_dir}/.kl.tmp.$$"
cp "$bin_download" "$staged_bin"
chmod 755 "$staged_bin"
mv -f "$staged_bin" "${bin_dir}/kiln"
staged_bin=""

rm -f "$staged_link"
ln -s "kiln" "$staged_link"
mv -f "$staged_link" "${bin_dir}/kl"
staged_link=""

printf '%s\n' "Installed kiln ${tag} (${target}) to ${bin_dir}/kiln (verified SHA-256: ${actual_sha})."
print_next_steps "$bin_dir"
