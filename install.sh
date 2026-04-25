#!/usr/bin/env bash
set -euo pipefail

APP_NAME="homechat-handoff"
INSTALL_DIR="${SIMPLE_CHAT_HOME:-$HOME/.simple-chat-server}"
REPO="${SIMPLE_CHAT_REPO:-}"
REF="${SIMPLE_CHAT_REF:-main}"
TMP_DIR=""

# Print logs to stderr so command substitution can safely capture only data values.
info() { printf '\n[HomeChat] %s\n' "$1" >&2; }
warn() { printf '\n[HomeChat WARNING] %s\n' "$1" >&2; }
fail() { printf '\n[HomeChat ERROR] %s\n' "$1" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1; }

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

version_major() {
  "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

install_linux_prereqs() {
  if need_cmd apt-get; then
    sudo apt-get update
    sudo apt-get install -y curl unzip ca-certificates
  fi
}

install_node_linux_if_needed() {
  if need_cmd node && need_cmd npm; then
    local major
    major="$(version_major node || echo 0)"
    if [ "${major:-0}" -ge 18 ]; then
      return 0
    fi
  fi

  warn "Node.js 18+ was not found. Installing current Node.js LTS using the NodeSource apt repository."
  if ! need_cmd curl; then install_linux_prereqs; fi
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
}

check_node_macos() {
  if ! need_cmd node || ! need_cmd npm; then
    fail "Node.js 18+ is required on macOS. Install the Node.js LTS package from nodejs.org, then rerun this installer."
  fi
  local major
  major="$(version_major node || echo 0)"
  if [ "${major:-0}" -lt 18 ]; then
    fail "Node.js 18+ is required. Your node version is $(node -v). Install Node.js LTS from nodejs.org, then rerun this installer."
  fi
}

find_source_dir() {
  local script_ref="${BASH_SOURCE[0]-}"
  local here=""

  # This supports running ./install.sh from an extracted folder.
  # When the script is piped into bash through curl, BASH_SOURCE is not a real file,
  # so this block is skipped and the repo ZIP download below is used instead.
  if [ -n "$script_ref" ] && [ -f "$script_ref" ]; then
    here="$(cd "$(dirname "$script_ref")" >/dev/null 2>&1 && pwd || true)"
    if [ -n "$here" ] && [ -f "$here/package.json" ] && [ -f "$here/server.js" ]; then
      printf '%s\n' "$here"
      return 0
    fi
  fi

  if [ -z "$REPO" ]; then
    fail "When running via curl, set SIMPLE_CHAT_REPO first. Example: curl -fsSL https://raw.githubusercontent.com/YOURNAME/YOURREPO/main/install.sh | SIMPLE_CHAT_REPO=YOURNAME/YOURREPO bash"
  fi

  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t homechat)"
  local zip="$TMP_DIR/source.zip"
  local src_dir=""

  info "Downloading https://github.com/$REPO/archive/refs/heads/$REF.zip"
  curl -fsSL -o "$zip" "https://github.com/$REPO/archive/refs/heads/$REF.zip"
  unzip -q "$zip" -d "$TMP_DIR"

  # GitHub normally extracts to repo-ref/, but do not assume the exact folder name.
  src_dir="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1 || true)"
  if [ -z "$src_dir" ] || [ ! -d "$src_dir" ]; then
    fail "Downloaded the repo ZIP, but could not find the extracted source folder. Check that the repo exists and has files in the $REF branch."
  fi
  if [ ! -f "$src_dir/package.json" ] || [ ! -f "$src_dir/server.js" ]; then
    fail "The downloaded repo does not look like the HomeChat app. Make sure package.json and server.js are in the repository root."
  fi

  printf '%s\n' "$src_dir"
}

copy_app() {
  local src="$1"
  if [ -z "$src" ] || [ ! -d "$src" ]; then
    fail "Source folder was not found: ${src:-empty}"
  fi

  info "Installing app to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"

  local keep
  keep="$(mktemp -d 2>/dev/null || mktemp -d -t homechat-keep)"
  if [ -f "$INSTALL_DIR/.env" ]; then cp "$INSTALL_DIR/.env" "$keep/.env"; fi
  if [ -d "$INSTALL_DIR/data" ]; then cp -R "$INSTALL_DIR/data" "$keep/data"; fi

  (cd "$src" && tar -cf - .) | (cd "$INSTALL_DIR" && tar -xf -)

  if [ -f "$keep/.env" ]; then cp "$keep/.env" "$INSTALL_DIR/.env"; fi
  if [ -d "$keep/data" ]; then rm -rf "$INSTALL_DIR/data" && cp -R "$keep/data" "$INSTALL_DIR/data"; fi
  rm -rf "$keep"
}

generate_env() {
  cd "$INSTALL_DIR"
  if [ ! -f .env ]; then cp .env.example .env; fi

  node <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
let text = fs.readFileSync('.env', 'utf8');
const values = {
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  ADMIN_KEY: crypto.randomBytes(32).toString('hex'),
  INSTANCE_ID: `${os.hostname()}-${crypto.randomBytes(3).toString('hex')}`
};
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const match = text.match(re);
  if (match && !match[0].includes('CHANGE_ME')) continue;
  if (match) text = text.replace(re, `${key}=${value}`);
  else text += `\n${key}=${value}\n`;
}
fs.writeFileSync('.env', text.endsWith('\n') ? text : `${text}\n`);
NODE
}

install_node_deps() {
  cd "$INSTALL_DIR"
  info "Installing Node dependencies"
  npm install --omit=dev
}

install_linux_services() {
  local node_path
  node_path="$(command -v node)"
  mkdir -p "$HOME/.config/systemd/user"

  cat > "$HOME/.config/systemd/user/simple-chat.service" <<EOF2
[Unit]
Description=HomeChat Handoff Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$node_path server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF2

  cat > "$HOME/.config/systemd/user/simple-chat-awake.service" <<'EOF2'
[Unit]
Description=Keep this Linux machine awake for HomeChat

[Service]
Type=simple
ExecStart=/usr/bin/systemd-inhibit --what=sleep:idle:handle-lid-switch --why=HomeChat /bin/sh -c 'while true; do sleep 3600; done'
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF2

  systemctl --user daemon-reload
  systemctl --user enable simple-chat.service

  if command -v loginctl >/dev/null 2>&1; then
    sudo loginctl enable-linger "$USER" || true
  fi
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

install_macos_services() {
  local node_path escaped_node escaped_dir escaped_log
  node_path="$(command -v node)"
  escaped_node="$(xml_escape "$node_path")"
  escaped_dir="$(xml_escape "$INSTALL_DIR")"
  escaped_log="$(xml_escape "$INSTALL_DIR/data/server.log")"
  mkdir -p "$HOME/Library/LaunchAgents" "$INSTALL_DIR/data"

  cat > "$HOME/Library/LaunchAgents/com.simplechat.server.plist" <<EOF2
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.simplechat.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$escaped_node</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$escaped_dir</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>$escaped_log</string>
  <key>StandardErrorPath</key><string>$escaped_log</string>
</dict>
</plist>
EOF2

  cat > "$HOME/Library/LaunchAgents/com.simplechat.awake.plist" <<'EOF2'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.simplechat.awake</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-dimsu</string>
  </array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><true/>
  <key>Disabled</key><true/>
  <key>StandardOutPath</key><string>/tmp/simplechat-awake.log</string>
  <key>StandardErrorPath</key><string>/tmp/simplechat-awake.log</string>
</dict>
</plist>
EOF2
}

install_wrapper() {
  local bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/homechat" <<EOF2
#!/usr/bin/env bash
cd "$INSTALL_DIR"
exec "$(command -v node)" cli.js "\$@"
EOF2
  chmod +x "$bin_dir/homechat"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not currently in your PATH. You can still run: $bin_dir/homechat" ;;
  esac
}

start_service() {
  local os_name="$1"
  if [ "$os_name" = "Linux" ]; then
    systemctl --user restart simple-chat.service
  elif [ "$os_name" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.simplechat.server.plist" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.simplechat.server.plist" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/$(id -u)/com.simplechat.server" >/dev/null 2>&1 || true
  fi
}

main() {
  local os_name
  os_name="$(uname -s)"

  if [ "$os_name" = "Linux" ]; then
    install_linux_prereqs
    install_node_linux_if_needed
  elif [ "$os_name" = "Darwin" ]; then
    check_node_macos
  else
    fail "Unsupported OS: $os_name. This installer supports Ubuntu/Linux systemd and macOS."
  fi

  need_cmd npm || fail "npm is required but was not found."
  need_cmd unzip || fail "unzip is required but was not found."
  need_cmd tar || fail "tar is required but was not found."

  local src
  src="$(find_source_dir)"
  copy_app "$src"
  generate_env
  install_node_deps
  install_wrapper

  if [ "$os_name" = "Linux" ]; then install_linux_services; fi
  if [ "$os_name" = "Darwin" ]; then install_macos_services; fi

  start_service "$os_name"

  info "Installed and started."
  echo "Open the terminal menu with: $HOME/.local/bin/homechat"
  echo "Or run: cd $INSTALL_DIR && npm run menu"
  echo "Local URL: http://127.0.0.1:$(grep '^PORT=' "$INSTALL_DIR/.env" | cut -d= -f2)"
  echo "The first account created in the web app becomes the moderator."
}

main "$@"
