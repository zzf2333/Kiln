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

# Build minimal isolated system tool directory without node/npm so PATH tests
# do not accidentally pick up host /usr/local/bin/node or Homebrew node.
SYS_BIN="${TMP_ROOT}/sysbin"
mkdir -p "$SYS_BIN"
for tool in sh uname; do
  if command -v "$tool" >/dev/null 2>&1; then
    ln -s "$(command -v "$tool")" "${SYS_BIN}/${tool}"
  fi
done
SH_BIN="$(command -v sh)"

# Stub Node >= 22 + npm directory for deterministic dry-run tests even if host PATH varies,
# plus real-PATH checks when node >= 22 is present.
GOOD_NODE_BIN="${TMP_ROOT}/good-node-bin"
mkdir -p "$GOOD_NODE_BIN"
cat > "${GOOD_NODE_BIN}/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-v" ]; then
  printf '%s\n' "v22.14.0"
  exit 0
fi
exit 0
EOF
cat > "${GOOD_NODE_BIN}/npm" <<'EOF'
#!/bin/sh
printf '%s\n' "10.9.2"
exit 0
EOF
chmod +x "${GOOD_NODE_BIN}/node" "${GOOD_NODE_BIN}/npm"

OLD_NODE_BIN="${TMP_ROOT}/old-node-bin"
mkdir -p "$OLD_NODE_BIN"
cat > "${OLD_NODE_BIN}/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-v" ]; then
  printf '%s\n' "v20.18.0"
  exit 0
fi
exit 0
EOF
chmod +x "${OLD_NODE_BIN}/node"

# 1. POSIX shell syntax check
sh -n "$INSTALL_SCRIPT"

# 2. --help exits 0 and documents key options
help_out="$(sh "$INSTALL_SCRIPT" --help)"
assert_contains "$help_out" "--version" "--help"
assert_contains "$help_out" "--prefix" "--help"
assert_contains "$help_out" "--dry-run" "--help"
assert_contains "$help_out" "--help" "--help"

# 3. --dry-run (default and with explicit --version / --prefix) exits 0 and creates no files
TEST_HOME="${TMP_ROOT}/home-dry-run"
mkdir -p "$TEST_HOME"
TEST_PREFIX="${TMP_ROOT}/kiln-test-prefix"

dry_default_out="$(HOME="$TEST_HOME" PATH="${GOOD_NODE_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run)"
assert_contains "$dry_default_out" "@zzf2333/kiln" "--dry-run"
assert_contains "$dry_default_out" "npm install -g" "--dry-run"
assert_contains "$dry_default_out" "kiln doctor" "--dry-run"
assert_contains "$dry_default_out" "kiln service install" "--dry-run"
assert_contains "$dry_default_out" "kiln uninstall" "--dry-run"

dry_custom_out="$(HOME="$TEST_HOME" PATH="${GOOD_NODE_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run --version 0.1.0 --prefix /tmp/kiln-test-prefix)"
assert_contains "$dry_custom_out" "@zzf2333/kiln@0.1.0" "--dry-run custom"
assert_contains "$dry_custom_out" "/tmp/kiln-test-prefix" "--dry-run custom"
assert_no_autostart_side_effects "$TEST_HOME" "--dry-run"

# Prefix containing spaces must remain intact and never create directories in dry-run
SPACE_PREFIX="${TMP_ROOT}/prefix with spaces"
dry_space_out="$(HOME="$TEST_HOME" PATH="${GOOD_NODE_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run --version 0.1.0 --prefix "$SPACE_PREFIX")"
assert_contains "$dry_space_out" "$SPACE_PREFIX" "--dry-run space prefix"
if [ -e "$SPACE_PREFIX" ]; then
  fail "--dry-run created prefix directory on disk"
fi
assert_no_autostart_side_effects "$TEST_HOME" "--dry-run space prefix"

# Also verify against host Node if host already provides Node >= 22
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  host_ver="$(node -v)"
  host_clean="${host_ver#v}"
  host_major="${host_clean%%.*}"
  if [ "$host_major" -ge 22 ] 2>/dev/null; then
    host_dry_out="$(HOME="$TEST_HOME" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run --version 0.1.0 --prefix "$TEST_PREFIX")"
    assert_contains "$host_dry_out" "@zzf2333/kiln@0.1.0" "host node --dry-run"
    if [ -e "$TEST_PREFIX" ]; then
      fail "host --dry-run created prefix directory on disk"
    fi
    assert_no_autostart_side_effects "$TEST_HOME" "host --dry-run"
  fi
fi

# 4. Unknown flag and missing option values exit with code 2
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

# 5. Missing node and low-version node fail cleanly with non-zero exit and zero HOME side effects
NO_NODE_HOME="${TMP_ROOT}/home-no-node"
mkdir -p "$NO_NODE_HOME"
set +e
err_no_node="$(HOME="$NO_NODE_HOME" PATH="$SYS_BIN" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run 2>&1)"
rc_no_node=$?
set -e
[ "$rc_no_node" -ne 0 ] || fail "missing node expected non-zero exit, got 0"
assert_contains "$err_no_node" "Node.js >= 22" "missing node"
assert_no_autostart_side_effects "$NO_NODE_HOME" "missing node"

OLD_NODE_HOME="${TMP_ROOT}/home-old-node"
mkdir -p "$OLD_NODE_HOME"
set +e
err_old_node="$(HOME="$OLD_NODE_HOME" PATH="${OLD_NODE_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --dry-run 2>&1)"
rc_old_node=$?
set -e
[ "$rc_old_node" -ne 0 ] || fail "old node expected non-zero exit, got 0"
assert_contains "$err_old_node" "v20.18.0" "old node"
assert_no_autostart_side_effects "$OLD_NODE_HOME" "old node"

# 6. Simulated real install with stub npm verifies exact quoting (spaces in --prefix) and zero HOME side effects
STUB_BIN="${TMP_ROOT}/stub-install-bin"
mkdir -p "$STUB_BIN"
cp "${GOOD_NODE_BIN}/node" "${STUB_BIN}/node"
NPM_LOG="${TMP_ROOT}/npm-argv.log"
cat > "${STUB_BIN}/npm" <<'EOF'
#!/bin/sh
: "${KILN_TEST_NPM_LOG:?missing log path}"
: > "$KILN_TEST_NPM_LOG"
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$KILN_TEST_NPM_LOG"
done
EOF
chmod +x "${STUB_BIN}/node" "${STUB_BIN}/npm"

STUB_HOME="${TMP_ROOT}/home-stub-install"
mkdir -p "$STUB_HOME"
install_out="$(HOME="$STUB_HOME" KILN_TEST_NPM_LOG="$NPM_LOG" PATH="${STUB_BIN}:${SYS_BIN}" "$SH_BIN" "$INSTALL_SCRIPT" --version 0.1.0 --prefix "$SPACE_PREFIX")"
assert_contains "$install_out" "Installed @zzf2333/kiln@0.1.0." "stub install"
assert_no_autostart_side_effects "$STUB_HOME" "stub install"

expected_argv="$(printf '%s\n' "install" "-g" "--prefix" "$SPACE_PREFIX" "@zzf2333/kiln@0.1.0")"
actual_argv="$(cat "$NPM_LOG")"
[ "$actual_argv" = "$expected_argv" ] || fail "stub npm argv mismatch:
expected:
${expected_argv}
actual:
${actual_argv}"

printf '%s\n' "PASS: scripts/test-install.sh (all checks passed)"
