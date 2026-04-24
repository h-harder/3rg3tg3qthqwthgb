# HomeChat Handoff

A simple self-hosted chat system that runs on Ubuntu/Linux or macOS without Docker.

It includes:

- Web chat with account creation and login
- First account created automatically becomes the moderator
- Moderator tools in the browser
- Terminal menu for starting, stopping, resetting, syncing, deleting messages, and toggling keep-awake
- Active/passive handoff between two computers, such as an Ubuntu HP Envy and a Mac
- Local JSON data storage in `data/chat-data.json`
- Linux `systemd --user` service support
- macOS `launchd` LaunchAgent support
- Optional keep-awake service on both Linux and macOS

## How the two-server handoff works

Both computers run the same app. Each computer has a `PEER_URL` pointing at the other computer and both computers share the same `ADMIN_KEY`.

When one server starts:

1. It checks whether the peer server is online.
2. It asks the peer for the latest chat data.
3. It imports the peer data if the peer copy is newer.
4. It asks the peer to shut down cleanly.
5. The newly started computer becomes the active server.

Example:

- Ubuntu server is running.
- You start the Mac server.
- Mac pulls the latest data from Ubuntu.
- Mac tells Ubuntu to stop.
- Mac becomes the active server.

The same works in reverse.

This is intentionally active/passive. It is not designed for both servers to accept chat messages at the same time.

## Requirements

### Ubuntu/Linux

The installer can install the needed Linux packages with `apt`:

- curl
- unzip
- Node.js 18 or newer
- npm

### macOS

Install Node.js LTS from <https://nodejs.org> first, then run the installer.

No Docker is required.

## Option A: Install from the ZIP directly

Unzip this project and run:

```bash
cd homechat-handoff
./install.sh
```

The installer copies the app to:

```text
~/.simple-chat-server
```

Then it installs dependencies, creates the service, starts the server, and creates this terminal command:

```bash
~/.local/bin/homechat
```

Open the terminal menu:

```bash
~/.local/bin/homechat
```

Or:

```bash
cd ~/.simple-chat-server
npm run menu
```

## Option B: Upload to GitHub and install with one command

1. Create a GitHub repository.
2. Upload the contents of this folder to the repository.
3. Replace `YOURNAME/YOURREPO` below with your GitHub username and repo name.
4. Run this on Ubuntu and on macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/YOURNAME/YOURREPO/main/install.sh | SIMPLE_CHAT_REPO=YOURNAME/YOURREPO bash
```

If your branch is not `main`, add `SIMPLE_CHAT_REF`:

```bash
curl -fsSL https://raw.githubusercontent.com/YOURNAME/YOURREPO/main/install.sh | SIMPLE_CHAT_REPO=YOURNAME/YOURREPO SIMPLE_CHAT_REF=main bash
```

## First login

After installation, open the chat site.

On the server itself:

```text
http://127.0.0.1:3000
```

From another device on the same Wi-Fi, open the LAN URL shown in the terminal menu.

The first account created becomes the moderator.

## Terminal menu

Run:

```bash
~/.local/bin/homechat
```

The menu includes:

```text
1) Show status and URLs
2) Start server
3) Stop server
4) Restart server
5) Open chat in browser
6) Configure peer handoff
7) Sync from peer now
8) Shut down peer now
9) List recent messages
10) Delete message by ID
11) Reset server data
12) Back up server data
13) Turn keep-awake ON
14) Turn keep-awake OFF
15) Tail logs
0) Exit
```

You can also run direct commands:

```bash
~/.local/bin/homechat status
~/.local/bin/homechat start
~/.local/bin/homechat stop
~/.local/bin/homechat restart
~/.local/bin/homechat awake-on
~/.local/bin/homechat awake-off
~/.local/bin/homechat list 50
~/.local/bin/homechat delete MESSAGE_ID
~/.local/bin/homechat sync-peer
~/.local/bin/homechat shutdown-peer
```

## Configure Ubuntu and macOS peer handoff

Do this after installing the app on both computers.

### 1. Find each computer's LAN URL

On Ubuntu:

```bash
~/.local/bin/homechat status
```

Look for a LAN URL like:

```text
http://192.168.1.45:3000
```

On macOS:

```bash
~/.local/bin/homechat status
```

Look for a LAN URL like:

```text
http://192.168.1.52:3000
```

### 2. Configure Ubuntu's peer URL

On Ubuntu:

```bash
~/.local/bin/homechat
```

Choose:

```text
6) Configure peer handoff
```

Set Ubuntu's peer URL to the Mac URL, for example:

```text
http://192.168.1.52:3000
```

When asked for `ADMIN_KEY`, either accept the generated value or enter your own long random key.

Copy that key. You must use the same key on both computers.

### 3. Configure macOS's peer URL

On macOS:

```bash
~/.local/bin/homechat
```

Choose:

```text
6) Configure peer handoff
```

Set Mac's peer URL to the Ubuntu URL, for example:

```text
http://192.168.1.45:3000
```

Paste the exact same `ADMIN_KEY` used on Ubuntu.

### 4. Restart both services once

On Ubuntu:

```bash
~/.local/bin/homechat restart
```

On macOS:

```bash
~/.local/bin/homechat restart
```

From now on, starting one side should sync from the other and shut the other side down.

## Make the server easy to find on your network

Reserve the IP address of both computers in your router's DHCP settings.

For example:

```text
Ubuntu HP Envy: 192.168.1.45
Mac:           192.168.1.52
```

This keeps the peer URLs from changing.

## Keep-awake controls

Turn keep-awake on:

```bash
~/.local/bin/homechat awake-on
```

Turn keep-awake off:

```bash
~/.local/bin/homechat awake-off
```

Ubuntu uses `systemd-inhibit`.

macOS uses `caffeinate`.

## Ubuntu service commands

The installer creates a user-level systemd service.

```bash
systemctl --user status simple-chat
systemctl --user start simple-chat
systemctl --user stop simple-chat
systemctl --user restart simple-chat
journalctl --user -u simple-chat -f
```

The installer also tries to run:

```bash
sudo loginctl enable-linger "$USER"
```

That allows the user service to continue after logout on many Ubuntu systems.

## macOS service commands

The installer creates:

```text
~/Library/LaunchAgents/com.simplechat.server.plist
~/Library/LaunchAgents/com.simplechat.awake.plist
```

The terminal menu handles start/stop actions, so you usually do not need to run `launchctl` manually.

Logs are written to:

```text
~/.simple-chat-server/data/server.log
```

## Data and backups

Main data file:

```text
~/.simple-chat-server/data/chat-data.json
```

Backup folder:

```text
~/.simple-chat-server/data/backups
```

Create a backup from the menu:

```text
12) Back up server data
```

## Reset server

From the menu:

```text
11) Reset server data
```

This deletes users and messages after creating a backup.

After reset, the next account created becomes the moderator.

## Security notes

This app is intended for a private home network or trusted local network.

Do not expose it directly to the public internet without adding HTTPS, stronger network firewall rules, and a reverse proxy.

Keep the `ADMIN_KEY` private. Anyone with that key can export data, reset the server, delete messages, or shut the server down.

## Troubleshooting

### The peer does not shut down

Check that both computers have the same `ADMIN_KEY`.

Check that each computer's `PEER_URL` points to the other computer.

Check that both machines are on the same network.

### The server starts and immediately stops

The server may be paused because the peer took over. Start it from the terminal menu:

```bash
~/.local/bin/homechat start
```

That removes the pause marker and starts the service.

### I changed `.env` and nothing happened

Restart the server:

```bash
~/.local/bin/homechat restart
```

### I cannot access it from another device

Check the LAN URL:

```bash
~/.local/bin/homechat status
```

On Ubuntu, allow the port through the firewall if needed:

```bash
sudo ufw allow 3000/tcp
```
