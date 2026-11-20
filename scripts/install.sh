#!/bin/sh
set -eu

PACKAGE_NAME="@zzf2333/kiln"
REQUIRED_NODE_MAJOR=22

install_version=""
install_prefix=""
dry_run=0

print_usage() {
  printf '%s\n' \
    "Kiln CLI Installer" \
    "" \
    "Usage:" \
    "  install.sh [options]" \
    "" \
    "Options:" \
    "  --version <ver>   Install a specific @zzf2333/kiln version (e.g. 0.1.0)" \
    "  --prefix <dir>    Pass custom npm global prefix (--prefix <dir>)" \
    "  --dry-run         Print planned commands and configuration without modifying disk" \
    "  -h, --help        Show this help message" \
    "" \
    "Requirements:" \
    "  - Node.js >= 22.0.0 and npm" \
    "  - Never modifies ~/.zshrc, ~/.bashrc, LaunchAgents, systemd units, or crontab"
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

print_node_install_hint() {
  os_name="$(uname -s 2>/dev/null || printf 'unknown')"
  if [ "$os_name" = "Darwin" ]; then
    printf '%s\n' "Install Node.js >= ${REQUIRED_NODE_MAJOR} on macOS via Homebrew:" >&2
    printf '%s\n' "  brew install node@22" >&2
    printf '%s\n' "Or download the official LTS installer from https://nodejs.org/" >&2
  else
    printf '%s\n' "Install Node.js >= ${REQUIRED_NODE_MAJOR} from https://nodejs.org/ or your OS package manager." >&2
  fi
}

check_prereqs() {
  if ! command -v node >/dev/null 2>&1; then
    log_err "Node.js >= ${REQUIRED_NODE_MAJOR}.0.0 is required, but 'node' was not found in PATH."
    print_node_install_hint
    exit 1
  fi

  node_ver="$(node -v 2>/dev/null || printf '')"
  node_clean="${node_ver#v}"
  node_major="${node_clean%%.*}"

  case "$node_major" in
    ''|*[!0-9]*)
      log_err "Unable to parse Node.js version '${node_ver:-unknown}' (requires Node.js >= ${REQUIRED_NODE_MAJOR}.0.0)."
      print_node_install_hint
      exit 1
      ;;
  esac

  if [ "$node_major" -lt "$REQUIRED_NODE_MAJOR" ]; then
    log_err "Node.js >= ${REQUIRED_NODE_MAJOR}.0.0 is required (found ${node_ver})."
    print_node_install_hint
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    log_err "'npm' is required to install ${PACKAGE_NAME}, but was not found in PATH."
    print_node_install_hint
    exit 1
  fi
}

print_next_steps() {
  printf '\n%s\n' "Next steps:"
  if [ -n "$install_prefix" ]; then
    printf '%s\n' "  Ensure \"${install_prefix}/bin\" is in your PATH (this installer never edits shell profiles)."
  fi
  printf '%s\n' "  1. Verify environment:     kiln doctor"
  printf '%s\n' "  2. Start local daemon:     kiln up"
  printf '%s\n' "  3. Optional auto-start:    kiln service install"
  printf '%s\n' "  4. Clean uninstall:        kiln uninstall"
  printf '%s\n' "  (Short alias 'kl' is also available alongside 'kiln'.)"
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
  case "$install_version" in
    *[!A-Za-z0-9._+-]*)
      usage_error "Invalid --version characters: $install_version"
      ;;
  esac
  package_spec="${PACKAGE_NAME}@${install_version}"
else
  package_spec="${PACKAGE_NAME}"
fi

check_prereqs

if [ "$dry_run" -eq 1 ]; then
  printf '%s\n' "[dry-run] Planned Kiln CLI installation (no files will be modified):"
  printf '%s\n' "  Node.js: ${node_ver}"
  printf '%s\n' "  Package: ${package_spec}"
  if [ -n "$install_prefix" ]; then
    printf '%s\n' "  Prefix:  ${install_prefix}"
    printf '%s\n' "  Command: npm install -g --prefix \"${install_prefix}\" \"${package_spec}\""
  else
    printf '%s\n' "  Prefix:  (npm global default)"
    printf '%s\n' "  Command: npm install -g \"${package_spec}\""
  fi
  printf '%s\n' "  System services / shell profiles: untouched"
  print_next_steps
  exit 0
fi

printf '%s\n' "Installing ${package_spec} with npm (Node.js ${node_ver})..."
if [ -n "$install_prefix" ]; then
  npm install -g --prefix "$install_prefix" "$package_spec"
else
  npm install -g "$package_spec"
fi

printf '%s\n' "Installed ${package_spec}."
print_next_steps
