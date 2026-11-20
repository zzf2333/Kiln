#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_SCRIPT="${SCRIPT_DIR}/install.sh"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

fail() {
  printf '%s\n' "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  haystack="$1"
  needle="$2"
  label="$3"
  case "$haystack" in
    *"$needle"*)
      ;;
    *)
      fail "${label}: expected output to contain '${needle}', got:
${haystack}"
      ;;
  esac
}

assert_no_autostart_side_effects() {
  home_dir="$1"
  label="$2"
  if [ -e "${home_dir}/Library/LaunchAgents" ] || [ -e "${home_dir}/Library" ]; then
    fail "${label}: unexpected LaunchAgents/Library created under ${home_dir}"
  fi
  if [ -e "${home_dir}/.config/systemd" ] || [ -e "${home_dir}/.config" ]; then
    fail "${label}: unexpected .config/systemd created under ${home_dir}"
  fi
  if [ -e "${home_dir}/.zshrc" ] || [ -e "${home_dir}/.bashrc" ] || [ -e "${home_dir}/.profile" ]; then
    fail "${label}: unexpected shell profile modified under ${home_dir}"
  fi
}

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  else
    openssl dgst -sha256 "$1" | awk '{print tolower($NF)}'
  fi
}

# Build minimal isolated system tool directory WITHOUT node or npm to prove zero Node dependency.
SYS_BIN="${TMP_ROOT}/sysbin"
mkdir -p "$SYS_BIN"
for tool in sh uname awk sed tr tail cat cp mv rm mkdir chmod ln mktemp sha256sum shasum openssl; do
  if command -v "$tool" >/dev/null 2>&1; then
    ln -s "$(command -v "$tool")" "${SYS_BIN}/${tool}"
  fi
done
SH_BIN="$(command -v sh)"

# Stub curl serving local fixture files from $KILN_TEST_FIXTURE_ROOT
STUB_CURL_BIN="${TMP_ROOT}/stub-curl-bin"
mkdir -p "$STUB_CURL_BIN"
cat > "${STUB_CURL_BIN}/curl" <<'EOF'
#!/bin/sh
set -eu
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    -*)
      shift 1
      ;;
    *)
      url="$1"
      shift 1
      ;;
  esac
done
: "${KILN_TEST_FIXTURE_ROOT:?missing fixture root}"
rel="${url#https://fixture.local/}"
src="${KILN_TEST_FIXTURE_ROOT}/${rel}"
if [ ! -f "$src" ]; then
  printf 'curl stub: 404 %s\n' "$src" >&2
  exit 22
fi
if [ -n "$out" ]; then
  cp "$src" "$out"
else
  cat "$src"
fi
EOF
chmod +x "${STUB_CURL_BIN}/curl"

# 1. POSIX shell syntax check
sh -n "$INSTALL_SCRIPT"

# 2. --help exits 0 and documents key options and zero Node.js requirement
help_out="$("$SH_BIN" "$INSTALL_SCRIPT" --help)"
assert_contains "$help_out" "--version" "--help"
assert_contains "$help_out" "--prefix" "--help"
assert_contains "$help_out" "--dry-run" "--help"
assert_contains "$help_out" "--help" "--help"
assert_contains "$help_out" "Zero Node.js" "--help"

# 3. --dry-run succeeds with ZERO node/npm in PATH and creates no files
TEST_HOME="${TMP_ROOT}/home-dry-run"
mkdir -p "$TEST_HOME"

dry_default_out="$(HOME="$TEST_HOME" PATH="${STUB_CURL_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run)"
assert_contains "$dry_default_out" "Node.js not required" "--dry-run"
assert_contains "$dry_default_out" "${TEST_HOME}/.local/bin/kiln" "--dry-run"
assert_contains "$dry_default_out" "${TEST_HOME}/.local/bin/kl -> kiln" "--dry-run"
assert_contains "$dry_default_out" "SHA256SUMS" "--dry-run"
assert_contains "$dry_default_out" "kiln doctor" "--dry-run"
assert_contains "$dry_default_out" "kiln service install" "--dry-run"
assert_contains "$dry_default_out" "kiln uninstall" "--dry-run"
assert_no_autostart_side_effects "$TEST_HOME" "--dry-run"

dry_custom_out="$(HOME="$TEST_HOME" PATH="${STUB_CURL_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run --version 0.1.0 --prefix /tmp/kiln-test-prefix)"
assert_contains "$dry_custom_out" "kiln-v0.1.0-" "--dry-run custom"
assert_contains "$dry_custom_out" "/tmp/kiln-test-prefix/bin/kiln" "--dry-run custom"
assert_no_autostart_side_effects "$TEST_HOME" "--dry-run custom"

# Prefix containing spaces must remain intact and never create directories in dry-run
SPACE_PREFIX="${TMP_ROOT}/prefix with spaces"
dry_space_out="$(HOME="$TEST_HOME" PATH="${STUB_CURL_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run --version v0.1.0 --prefix "$SPACE_PREFIX")"
assert_contains "$dry_space_out" "${SPACE_PREFIX}/bin/kiln" "--dry-run space prefix"
if [ -e "$SPACE_PREFIX" ]; then
  fail "--dry-run created prefix directory on disk"
fi
assert_no_autostart_side_effects "$TEST_HOME" "--dry-run space prefix"

# 4. Unknown flag, missing option values, and invalid version exit with code 2
set +e
err_bogus="$("$SH_BIN" "$INSTALL_SCRIPT" --bogus 2>&1)"
rc_bogus=$?
set -e
[ "$rc_bogus" -eq 2 ] || fail "--bogus expected exit 2, got $rc_bogus ($err_bogus)"

set +e
err_missing_ver="$("$SH_BIN" "$INSTALL_SCRIPT" --version 2>&1)"
rc_missing_ver=$?
set -e
[ "$rc_missing_ver" -eq 2 ] || fail "--version without value expected exit 2, got $rc_missing_ver ($err_missing_ver)"

set +e
err_missing_prefix="$("$SH_BIN" "$INSTALL_SCRIPT" --prefix 2>&1)"
rc_missing_prefix=$?
set -e
[ "$rc_missing_prefix" -eq 2 ] || fail "--prefix without value expected exit 2, got $rc_missing_prefix ($err_missing_prefix)"

set +e
err_flag_as_ver="$("$SH_BIN" "$INSTALL_SCRIPT" --version --dry-run 2>&1)"
rc_flag_as_ver=$?
set -e
[ "$rc_flag_as_ver" -eq 2 ] || fail "--version --dry-run expected exit 2, got $rc_flag_as_ver ($err_flag_as_ver)"

set +e
err_bad_ver="$("$SH_BIN" "$INSTALL_SCRIPT" --version '0.1.0;rm' 2>&1)"
rc_bad_ver=$?
set -e
[ "$rc_bad_ver" -eq 2 ] || fail "invalid --version chars expected exit 2, got $rc_bad_ver ($err_bad_ver)"

# 5. Unsupported OS/arch fails cleanly with non-zero exit
BAD_UNAME_BIN="${TMP_ROOT}/bad-uname-bin"
mkdir -p "$BAD_UNAME_BIN"
cat > "${BAD_UNAME_BIN}/uname" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-s" ]; then
  printf '%s\n' "FreeBSD"
else
  printf '%s\n' "sparc64"
fi
EOF
chmod +x "${BAD_UNAME_BIN}/uname"

set +e
err_bad_os="$(HOME="$TEST_HOME" PATH="${BAD_UNAME_BIN}:${STUB_CURL_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run 2>&1)"
rc_bad_os=$?
set -e
[ "$rc_bad_os" -ne 0 ] || fail "unsupported OS expected non-zero exit, got 0"
assert_contains "$err_bad_os" "Unsupported OS/architecture" "unsupported OS"

# 6. End-to-end simulated install with valid SHA256SUMS (prefix with spaces, zero Node)
host_os="$(uname -s)"
host_arch="$(uname -m)"
case "${host_os}:${host_arch}" in
  Darwin:arm64|Darwin:aarch64) host_target="darwin-arm64" ;;
  Darwin:x86_64|Darwin:amd64) host_target="darwin-x64" ;;
  Linux:x86_64|Linux:amd64) host_target="linux-x64" ;;
  *) fail "test-install.sh cannot map host ${host_os}/${host_arch}" ;;
esac

FIXTURE_ROOT="${TMP_ROOT}/fixtures"
RELEASE_DIR="${FIXTURE_ROOT}/v0.1.0"
mkdir -p "$RELEASE_DIR"
ASSET_NAME="kiln-v0.1.0-${host_target}"
cat > "${RELEASE_DIR}/${ASSET_NAME}" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "kiln 0.1.0"
  exit 0
fi
printf '%s\n' "stub-kiln:$*"
EOF
chmod +x "${RELEASE_DIR}/${ASSET_NAME}"
GOOD_SHA="$(compute_sha256 "${RELEASE_DIR}/${ASSET_NAME}")"
printf '%s  %s\n' "$GOOD_SHA" "$ASSET_NAME" > "${RELEASE_DIR}/SHA256SUMS"

STUB_HOME="${TMP_ROOT}/home-stub-install"
mkdir -p "$STUB_HOME"
install_out="$(HOME="$STUB_HOME" KILN_TEST_FIXTURE_ROOT="$FIXTURE_ROOT" KILN_RELEASE_BASE_URL="https://fixture.local" PATH="${STUB_CURL_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --version 0.1.0 --prefix "$SPACE_PREFIX")"
assert_contains "$install_out" "Installed kiln v0.1.0 (${host_target})" "stub install"
assert_contains "$install_out" "$GOOD_SHA" "stub install sha"
assert_no_autostart_side_effects "$STUB_HOME" "stub install"

[ -x "${SPACE_PREFIX}/bin/kiln" ] || fail "installed kiln binary missing or not executable"
[ -L "${SPACE_PREFIX}/bin/kl" ] || fail "installed kl symlink missing"
[ "$(readlink "${SPACE_PREFIX}/bin/kl")" = "kiln" ] || fail "kl symlink must target kiln"
[ "$("${SPACE_PREFIX}/bin/kiln" --version)" = "kiln 0.1.0" ] || fail "installed kiln --version mismatch"
[ "$("${SPACE_PREFIX}/bin/kl" --version)" = "kiln 0.1.0" ] || fail "installed kl --version mismatch"

# 7. Tampered SHA256SUMS MUST fail before installing anything
TAMPER_PREFIX="${TMP_ROOT}/tamper-prefix"
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$ASSET_NAME" > "${RELEASE_DIR}/SHA256SUMS"
set +e
err_tamper="$(HOME="$STUB_HOME" KILN_TEST_FIXTURE_ROOT="$FIXTURE_ROOT" KILN_RELEASE_BASE_URL="https://fixture.local" PATH="${STUB_CURL_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --version 0.1.0 --prefix "$TAMPER_PREFIX" 2>&1)"
rc_tamper=$?
set -e
[ "$rc_tamper" -ne 0 ] || fail "tampered SHA256 expected non-zero exit, got 0"
assert_contains "$err_tamper" "SHA-256 mismatch" "tampered SHA256"
[ ! -e "${TAMPER_PREFIX}/bin/kiln" ] || fail "tampered binary must not be installed"

# 8. Missing asset entry in SHA256SUMS MUST fail before installing anything
printf '%s  %s\n' "$GOOD_SHA" "other-unrelated-file" > "${RELEASE_DIR}/SHA256SUMS"
set +e
err_missing_sum="$(HOME="$STUB_HOME" KILN_TEST_FIXTURE_ROOT="$FIXTURE_ROOT" KILN_RELEASE_BASE_URL="https://fixture.local" PATH="${STUB_CURL_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --version 0.1.0 --prefix "$TAMPER_PREFIX" 2>&1)"
rc_missing_sum=$?
set -e
[ "$rc_missing_sum" -ne 0 ] || fail "missing SHA256 entry expected non-zero exit, got 0"
assert_contains "$err_missing_sum" "No valid SHA-256 entry" "missing SHA256 entry"
[ ! -e "${TAMPER_PREFIX}/bin/kiln" ] || fail "unverified binary must not be installed"

# 9. Malicious redirected latest tag MUST be rejected by version allowlist
BAD_LATEST_CURL="${TMP_ROOT}/bad-latest-curl"
mkdir -p "$BAD_LATEST_CURL"
cat > "${BAD_LATEST_CURL}/curl" <<'EOF'
#!/bin/sh
printf '%s' "https://github.com/zzf2333/Kiln/releases/tag/v0.1.0;evil"
EOF
chmod +x "${BAD_LATEST_CURL}/curl"
set +e
err_bad_latest="$(HOME="$STUB_HOME" PATH="${BAD_LATEST_CURL}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --prefix "$TAMPER_PREFIX" 2>&1)"
rc_bad_latest=$?
set -e
[ "$rc_bad_latest" -ne 0 ] || fail "malicious latest tag expected non-zero exit, got 0"
assert_contains "$err_bad_latest" "Resolved invalid release version" "malicious latest tag"

printf '%s\n' "PASS: scripts/test-install.sh (all checks passed)"
