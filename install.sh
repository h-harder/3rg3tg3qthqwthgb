#!/usr/bin/env bash
set -euo pipefail

APP_NAME="homechat-handoff"
INSTALL_DIR="${HOMECHAT_HOME:-$HOME/.homechat}"
REPO="${HOMECHAT_REPO:-${SIMPLE_CHAT_REPO:-}}"
REF="${HOMECHAT_REF:-main}"
TMP_DIR=""

info() { printf '\n[HomeChat] %s\n' "$1" >&2; }
warn() { printf '\n[HomeChat WARNING] %s\n' "$1" >&2; }
fail() { printf '\n[HomeChat ERROR] %s\n' "$1" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1; }

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT

version_major() { "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

install_node_macos_if_needed() {
  if need_cmd node && need_cmd npm; then
    local major
    major="$(version_major node || echo 0)"
    if [ "${major:-0}" -ge 18 ]; then return 0; fi
  fi

  info "Node.js 18+ was not found. Installing the latest Node.js LTS pkg from nodejs.org. This may ask for your Mac password."
  need_cmd curl || fail "curl is required."
  need_cmd awk || fail "awk is required."
  local version url pkg
  version="$(curl -fsSL https://nodejs.org/dist/index.json | awk 'BEGIN{RS="{"} /"lts":"[^"]+"/ { if (match($0, /"version":"v[^"]+"/)) { print substr($0, RSTART+11, RLENGTH-12); exit } }')"
  [ -n "$version" ] || fail "Could not determine current Node.js LTS version. Install Node.js LTS from https://nodejs.org and rerun this installer."
  url="https://nodejs.org/dist/${version}/node-${version}.pkg"
  pkg="/tmp/node-${version}.pkg"
  curl -fsSL "$url" -o "$pkg"
  sudo installer -pkg "$pkg" -target /
  rm -f "$pkg"

  if ! need_cmd node || ! need_cmd npm; then
    fail "Node.js installed, but node/npm are not available in this shell yet. Open a new Terminal window and rerun this installer."
  fi
}

check_node() {
  case "$(uname -s)" in
    Darwin) install_node_macos_if_needed ;;
    *) fail "This installer is for macOS. For Windows 11, use install.ps1 from PowerShell." ;;
  esac
  local major
  major="$(version_major node || echo 0)"
  [ "${major:-0}" -ge 18 ] || fail "Node.js 18+ is required. Current: $(node -v 2>/dev/null || echo none)."
}

find_source_dir() {
  if [ -n "$REPO" ]; then
    TMP_DIR="$(mktemp -d)"
    local zip="$TMP_DIR/source.zip"
    local url="https://github.com/${REPO}/archive/refs/heads/${REF}.zip"
    info "Downloading $url"
    curl -fsSL "$url" -o "$zip"
    unzip -q "$zip" -d "$TMP_DIR"
    local found
    found="$(find "$TMP_DIR" -mindepth 1 -maxdepth 2 -type f -name package.json -print -quit | xargs dirname)"
    [ -n "$found" ] && [ -d "$found" ] || fail "Could not find package.json inside downloaded repo zip."
    printf '%s\n' "$found"
    return
  fi

  local source_path="${BASH_SOURCE[0]:-}"
  if [ -n "$source_path" ] && [ -f "$source_path" ]; then
    local dir
    dir="$(cd "$(dirname "$source_path")" && pwd)"
    [ -f "$dir/package.json" ] && { printf '%s\n' "$dir"; return; }
  fi

  fail "No source directory found. For curl install, set HOMECHAT_REPO, for example: HOMECHAT_REPO=h-harder/3rg3tg3qthqwthgb bash"
}

generate_hex() {
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
}

write_env_if_missing() {
  local env_file="$INSTALL_DIR/.env"
  if [ -f "$env_file" ]; then return 0; fi
  cat > "$env_file" <<EOF_ENV
PORT=3000
APP_NAME=HomeChat
SESSION_SECRET=$(generate_hex)
ADMIN_KEY=$(generate_hex)
PEER_URL=
HANDOFF_ON_START=true
EOF_ENV
}

install_command() {
  local bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/homechat" <<EOF_BIN
#!/usr/bin/env bash
set -euo pipefail
exec node "$INSTALL_DIR/cli.js" "\$@"
EOF_BIN
  chmod +x "$bin_dir/homechat"
}

main() {
  check_node
  need_cmd curl || fail "curl is required."
  need_cmd unzip || fail "unzip is required."
  local src
  src="$(find_source_dir)"
  info "Installing app to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  # Copy source without carrying over data/logs/backups from a prior install package.
  (cd "$src" && tar --exclude='./data' --exclude='./logs' --exclude='./backups' -cf - .) | (cd "$INSTALL_DIR" && tar -xf -)
  mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/logs" "$INSTALL_DIR/backups"
  cd "$INSTALL_DIR"
  npm install --omit=dev
  write_env_if_missing
  install_command
  info "Installed. Open the control menu with: $HOME/.local/bin/homechat"
  info "You may need to open a new Terminal window before 'homechat' works without the full path."
}

main "$@"
