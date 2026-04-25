# HomeChat Handoff

HomeChat is a simple self-hosted chat server for macOS and Windows 11. It uses Node.js, Express, Socket.IO, and a local JSON data file. No Docker is required.

## Features

- Real-time chat
- Account creation and login
- First account becomes the moderator
- Moderator controls in the browser
- Terminal control menu on macOS and Windows 11
- Start, stop, restart, backup, reset, delete messages
- Peer handoff between two computers
- Optional keep-awake toggle
- Optional start-at-login setup

## One-command install from GitHub

Upload these files to the root of your GitHub repo first. The repo root must contain:

```text
install.sh
install.ps1
server.js
cli.js
dataStore.js
package.json
public/
scripts/
README.md
```

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/h-harder/3rg3tg3qthqwthgb/main/install.sh | HOMECHAT_REPO=h-harder/3rg3tg3qthqwthgb bash
```

The macOS installer will try to install Node.js LTS from nodejs.org if Node.js 18+ is missing. This can require your Mac password.

### Windows 11 PowerShell

Open PowerShell and run:

```powershell
$env:HOMECHAT_REPO='h-harder/3rg3tg3qthqwthgb'; irm 'https://raw.githubusercontent.com/h-harder/3rg3tg3qthqwthgb/main/install.ps1' | iex
```

The Windows installer will try to install Node.js LTS through winget if Node.js 18+ is missing.

## Open the control menu

### macOS

```bash
~/.local/bin/homechat
```

### Windows 11

Open a new PowerShell window, then run:

```powershell
homechat
```

If PowerShell has not refreshed your PATH yet, run:

```powershell
$env:USERPROFILE\.local\bin\homechat.cmd
```

## Menu options

The terminal menu includes:

```text
Start server
Stop server
Restart server
Enable start at login
Disable start at login
Configure peer handoff
Sync from peer now
Shut down peer now
List messages
Delete a message
Back up data
Reset server data
Turn keep-awake ON
Turn keep-awake OFF
Show URLs and status
Show logs
```

## First account moderator behavior

The first account created in the web app automatically becomes the moderator. After a full reset, the next first account created becomes the moderator.

## Peer handoff setup

Install HomeChat on both computers. Then open the menu on both computers and choose:

```text
6) Configure peer handoff
```

On the Mac, set `PEER_URL` to the Windows computer:

```text
http://WINDOWS_IP_ADDRESS:3000
```

On the Windows computer, set `PEER_URL` to the Mac:

```text
http://MAC_IP_ADDRESS:3000
```

Use the exact same `ADMIN_KEY` on both computers. You can view the current key in:

### macOS

```bash
cat ~/.homechat/.env
```

### Windows

```powershell
type $env:USERPROFILE\.homechat\.env
```

When one side starts, it checks the peer. If the peer has newer data, it imports that data. Then it asks the peer to shut down so only one side remains active.

## Data location

### macOS

```text
~/.homechat/data/chat-data.json
```

### Windows

```text
%USERPROFILE%\.homechat\data\chat-data.json
```

## Firewall notes

If another computer cannot open the chat page, allow TCP port 3000 through the firewall.

On Windows, allow Node.js or port 3000 when Windows Defender Firewall prompts you.

On macOS, go to System Settings > Network > Firewall if the Mac blocks inbound access.

## Important security note

This is designed for a trusted home/local network. Do not expose it directly to the public internet without HTTPS, hardened firewall rules, and a backup plan.
