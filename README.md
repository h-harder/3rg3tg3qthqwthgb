# HomeChat Handoff

A simple self-hosted chat server for Ubuntu/Linux and macOS.

## Features

- Browser-based local chat
- Login and registration
- First registered account automatically becomes the moderator
- Moderator web panel
- Terminal control menu
- Peer handoff between Ubuntu and macOS servers
- Local JSON data storage, no database server
- No Docker
- Ubuntu `systemd --user` service
- macOS `launchd` service
- Optional keep-awake service

## Install from a ZIP

```bash
unzip homechat-handoff.zip
cd homechat-handoff
./install.sh
```

Then open the menu:

```bash
~/.local/bin/homechat
```

## Install from GitHub with one command

Upload this folder to a GitHub repository. Then run this on each server:

```bash
curl -fsSL https://raw.githubusercontent.com/YOURNAME/YOURREPO/main/install.sh | SIMPLE_CHAT_REPO=YOURNAME/YOURREPO bash
```

Example:

```bash
curl -fsSL https://raw.githubusercontent.com/h-harder/3rg3tg3qthqwthgb/main/install.sh | SIMPLE_CHAT_REPO=h-harder/3rg3tg3qthqwthgb bash
```

## macOS requirement

Install Node.js LTS from nodejs.org before running the installer.

## Ubuntu requirement

The installer will attempt to install Node.js LTS automatically if Node.js 18+ is missing.

## Open the chat

On the server machine:

```text
http://127.0.0.1:3000
```

From another device on the same network, use the LAN IP shown in:

```bash
homechat urls
```

The first account you create becomes the moderator.

## Terminal menu

```bash
homechat
```

Menu options include:

- start server
- stop server
- restart server
- show status
- show server URLs
- configure peer handoff
- sync from peer
- shut down peer
- list/delete messages
- add system announcement
- list users
- ban/unban users
- promote/demote users
- backup data
- reset data
- turn keep-awake on/off
- show logs

## Peer handoff setup

Install on both machines first.

On Ubuntu:

```bash
homechat
```

Choose `6) Configure peer handoff`.

Set `PEER_URL` to the Mac server, for example:

```text
http://192.168.1.52:3000
```

On Mac, set `PEER_URL` to the Ubuntu server, for example:

```text
http://192.168.1.45:3000
```

Use the same `ADMIN_KEY` on both machines. The easiest method is:

1. On one machine, open:

```bash
cat ~/.simple-chat-server/.env
```

2. Copy the `ADMIN_KEY` value.
3. Paste that same value during `Configure peer handoff` on the other machine.
4. Restart both servers once:

```bash
homechat restart
```

After this:

- Starting Mac syncs from Ubuntu, then asks Ubuntu to shut down.
- Starting Ubuntu syncs from Mac, then asks Mac to shut down.

## Keep-awake control

Turn keep-awake on:

```bash
homechat awake-on
```

Turn keep-awake off:

```bash
homechat awake-off
```

On Ubuntu, this uses `systemd-inhibit`.
On macOS, this uses the built-in `caffeinate` command.

## Backups

Manual backup:

```bash
homechat backup
```

Backups are saved here:

```text
~/.simple-chat-server/data/backups
```

## Reset

```bash
homechat reset
```

This backs up the existing data first, then clears users and messages. The next account created becomes the moderator.

## Important security note

This is designed for private/local-network use. Do not expose it directly to the public internet without HTTPS, firewall hardening, and a real backup plan.
