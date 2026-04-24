#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
const EXAMPLE_ENV = path.join(ROOT, ".env.example");

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(EXAMPLE_ENV, ENV_FILE);
  }
  const env = parseEnv(fs.readFileSync(ENV_FILE, "utf8"));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return env;
}

function saveEnv(updates) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : fs.readFileSync(EXAMPLE_ENV, "utf8");
  const existing = parseEnv(text);
  const finalValues = { ...existing, ...updates };

  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text += `\n${key}=${value}\n`;
  }

  // Ensure generated values exist even if the file was manually trimmed.
  for (const key of ["SESSION_SECRET", "ADMIN_KEY", "INSTANCE_ID"]) {
    if (!finalValues[key] || finalValues[key].includes("CHANGE_ME")) {
      const generated = key === "INSTANCE_ID" ? `${os.hostname()}-${crypto.randomBytes(3).toString("hex")}` : crypto.randomBytes(32).toString("hex");
      const re = new RegExp(`^${key}=.*$`, "m");
      if (re.test(text)) text = text.replace(re, `${key}=${generated}`);
      else text += `\n${key}=${generated}\n`;
      finalValues[key] = generated;
    }
  }

  fs.writeFileSync(ENV_FILE, text.endsWith("\n") ? text : `${text}\n`);
  return finalValues;
}

let env = loadEnv();

function dataFile() {
  return path.resolve(ROOT, env.DATA_FILE || "data/chat-data.json");
}

function pausedFile() {
  return path.resolve(ROOT, env.PAUSED_FILE || "data/server.paused");
}

function localUrl() {
  return `http://127.0.0.1:${env.PORT || 3000}`;
}

function peerUrl() {
  return String(env.PEER_URL || "").replace(/\/+$/, "");
}

function adminHeaders() {
  return { "Content-Type": "application/json", "x-admin-key": env.ADMIN_KEY || "" };
}

function run(cmd, args = [], opts = {}) {
  const result = spawnSync(cmd, args, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", ...opts });
  return result;
}

function runQuiet(cmd, args = []) {
  return spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
}

function isLinux() { return process.platform === "linux"; }
function isMac() { return process.platform === "darwin"; }

function serviceName() { return "simple-chat"; }
function macLabel() { return "com.simplechat.server"; }
function macAwakeLabel() { return "com.simplechat.awake"; }
function macPlist() { return path.join(os.homedir(), "Library/LaunchAgents/com.simplechat.server.plist"); }
function macAwakePlist() { return path.join(os.homedir(), "Library/LaunchAgents/com.simplechat.awake.plist"); }
function userSystemdService() { return path.join(os.homedir(), ".config/systemd/user/simple-chat.service"); }
function userAwakeService() { return path.join(os.homedir(), ".config/systemd/user/simple-chat-awake.service"); }

function removePaused() {
  if (fs.existsSync(pausedFile())) fs.rmSync(pausedFile(), { force: true });
}

function createPaused(reason = "Stopped from terminal menu") {
  fs.mkdirSync(path.dirname(pausedFile()), { recursive: true });
  fs.writeFileSync(pausedFile(), JSON.stringify({ reason, at: new Date().toISOString() }, null, 2));
}

function serviceStatus() {
  if (isLinux()) {
    const r = runQuiet("systemctl", ["--user", "is-active", serviceName()]);
    return r.stdout.trim() || r.stderr.trim() || "unknown";
  }
  if (isMac()) {
    const r = runQuiet("launchctl", ["print", `gui/${process.getuid()}/${macLabel()}`]);
    return r.status === 0 ? "loaded" : "not loaded";
  }
  return "unsupported";
}

function awakeStatus() {
  if (isLinux()) {
    const r = runQuiet("systemctl", ["--user", "is-active", "simple-chat-awake"]);
    return r.stdout.trim() || r.stderr.trim() || "unknown";
  }
  if (isMac()) {
    const r = runQuiet("launchctl", ["print", `gui/${process.getuid()}/${macAwakeLabel()}`]);
    return r.status === 0 ? "loaded" : "not loaded";
  }
  return "unsupported";
}

function startServer() {
  removePaused();
  if (isLinux()) {
    run("systemctl", ["--user", "start", serviceName()]);
  } else if (isMac()) {
    const plist = macPlist();
    run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { capture: true });
    run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${macLabel()}`]);
  } else {
    console.log("Unsupported OS for service start. Run npm start manually.");
  }
}

function stopServer() {
  createPaused();
  if (isLinux()) {
    run("systemctl", ["--user", "stop", serviceName()]);
  } else if (isMac()) {
    run("launchctl", ["bootout", `gui/${process.getuid()}/${macLabel()}`], { capture: true });
  }
}

function restartServer() {
  removePaused();
  if (isLinux()) {
    run("systemctl", ["--user", "restart", serviceName()]);
  } else if (isMac()) {
    run("launchctl", ["bootout", `gui/${process.getuid()}/${macLabel()}`], { capture: true });
    run("launchctl", ["bootstrap", `gui/${process.getuid()}`, macPlist()], { capture: true });
    run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${macLabel()}`]);
  }
}

function startAwake() {
  if (isLinux()) run("systemctl", ["--user", "start", "simple-chat-awake"]);
  else if (isMac()) {
    run("launchctl", ["bootstrap", `gui/${process.getuid()}`, macAwakePlist()], { capture: true });
    run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${macAwakeLabel()}`]);
  }
}

function stopAwake() {
  if (isLinux()) run("systemctl", ["--user", "stop", "simple-chat-awake"]);
  else if (isMac()) run("launchctl", ["bootout", `gui/${process.getuid()}/${macAwakeLabel()}`], { capture: true });
}

function localIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) ips.push(item.address);
    }
  }
  return ips;
}

function readData() {
  const file = dataFile();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeData(data) {
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function backupData(label = "manual") {
  const file = dataFile();
  if (!fs.existsSync(file)) return null;
  const backupDir = path.join(path.dirname(file), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `chat-data-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.copyFileSync(file, backup);
  return backup;
}

function defaultData() {
  const now = new Date().toISOString();
  return {
    meta: { schemaVersion: 2, createdAt: now, updatedAt: now, lastWriter: env.INSTANCE_ID || os.hostname() },
    rooms: [{ id: "general", name: "General" }, { id: "announcements", name: "Announcements" }],
    users: [],
    messages: []
  };
}

function listMessages(limit = 30) {
  const data = readData();
  if (!data || !Array.isArray(data.messages)) {
    console.log("No message data found yet.");
    return;
  }
  const messages = data.messages.slice(-limit);
  if (!messages.length) {
    console.log("No messages yet.");
    return;
  }
  for (const msg of messages) {
    const status = msg.deleted ? "[deleted]" : "";
    const body = msg.deleted ? "Message deleted" : String(msg.body || "").replace(/\s+/g, " ").slice(0, 120);
    console.log(`${msg.id} | ${msg.roomId} | ${msg.displayName || msg.username} | ${msg.createdAt} ${status}`);
    console.log(`  ${body}`);
  }
}

async function deleteMessage(id) {
  try {
    const response = await fetch(`${localUrl()}/api/admin/delete-message`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ id })
    });
    if (response.ok) {
      console.log("Message deleted through running server.");
      return;
    }
  } catch {}

  const data = readData();
  if (!data) throw new Error("No data file found.");
  const message = data.messages.find((item) => item.id === id);
  if (!message) throw new Error("Message not found.");
  backupData("before-delete-message");
  message.deleted = true;
  message.deletedBy = "terminal-admin-offline";
  message.deletedAt = new Date().toISOString();
  message.updatedAt = new Date().toISOString();
  data.meta.updatedAt = new Date().toISOString();
  data.meta.lastWriter = env.INSTANCE_ID || os.hostname();
  writeData(data);
  console.log("Message marked deleted in local data file. Restart or refresh clients if needed.");
}

async function syncFromPeer() {
  const url = peerUrl();
  if (!url) throw new Error("PEER_URL is not configured. Use Configure peer handoff first.");
  const response = await fetch(`${url}/api/admin/export`, { headers: adminHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Peer export failed: ${response.status}`);
  const backup = backupData("before-manual-peer-sync");
  writeData(payload.data);
  console.log(`Imported peer data from ${url}.`);
  if (backup) console.log(`Backup created: ${backup}`);
}

async function shutdownPeer() {
  const url = peerUrl();
  if (!url) throw new Error("PEER_URL is not configured.");
  const response = await fetch(`${url}/api/admin/remote-shutdown`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ reason: `${env.SERVER_NAME || os.hostname()} requested peer shutdown from terminal menu` })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Peer shutdown failed: ${response.status}`);
  console.log("Peer shutdown request sent.");
}

async function resetServer() {
  stopServer();
  const backup = backupData("before-reset");
  writeData(defaultData());
  console.log("Server data reset. The next account created becomes the moderator.");
  if (backup) console.log(`Backup created: ${backup}`);
}

function openBrowser() {
  const ips = localIps();
  const url = ips.length ? `http://${ips[0]}:${env.PORT || 3000}` : localUrl();
  console.log(`Chat URL: ${url}`);
  if (isMac()) spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else if (isLinux()) spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function showStatus() {
  console.log(`Server name: ${env.SERVER_NAME || "Home Chat"}`);
  console.log(`Local URL: ${localUrl()}`);
  for (const ip of localIps()) console.log(`LAN URL: http://${ip}:${env.PORT || 3000}`);
  console.log(`Peer URL: ${peerUrl() || "not configured"}`);
  console.log(`Service status: ${serviceStatus()}`);
  console.log(`Keep-awake status: ${awakeStatus()}`);
  console.log(`Data file: ${dataFile()}`);
  console.log(`Paused file: ${fs.existsSync(pausedFile()) ? pausedFile() : "not paused"}`);
  const data = readData();
  if (data) console.log(`Users: ${data.users?.length || 0}, Messages: ${data.messages?.length || 0}, Updated: ${data.meta?.updatedAt || "unknown"}`);
}

async function ask(rl, question, fallback = "") {
  return await new Promise((resolve) => rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `, (answer) => resolve(answer.trim() || fallback)));
}

async function configurePeer(rl) {
  const serverName = await ask(rl, "Server display name", env.SERVER_NAME || os.hostname());
  const port = await ask(rl, "Port", env.PORT || "3000");
  const peer = await ask(rl, "Peer URL, example http://192.168.1.50:3000", env.PEER_URL || "");
  let key = await ask(rl, "Shared ADMIN_KEY. Use the exact same key on both computers", env.ADMIN_KEY && !env.ADMIN_KEY.includes("CHANGE_ME") ? env.ADMIN_KEY : "");
  if (!key) key = crypto.randomBytes(32).toString("hex");
  const handoff = await ask(rl, "Handoff on start? true/false", env.HANDOFF_ON_START || "true");
  const shutdownPeer = await ask(rl, "When this starts, shut down peer? true/false", env.HANDOFF_SHUTDOWN_PEER || "true");
  env = saveEnv({
    SERVER_NAME: serverName,
    PORT: port,
    PEER_URL: peer,
    ADMIN_KEY: key,
    HANDOFF_ON_START: handoff,
    HANDOFF_SHUTDOWN_PEER: shutdownPeer
  });
  console.log("Configuration saved. Restart the server for changes to apply.");
  console.log("Use this same ADMIN_KEY on the other computer:");
  console.log(key);
}

function printMenu() {
  console.log("\nHomeChat terminal menu");
  console.log("1) Show status and URLs");
  console.log("2) Start server");
  console.log("3) Stop server");
  console.log("4) Restart server");
  console.log("5) Open chat in browser");
  console.log("6) Configure peer handoff");
  console.log("7) Sync from peer now");
  console.log("8) Shut down peer now");
  console.log("9) List recent messages");
  console.log("10) Delete message by ID");
  console.log("11) Reset server data");
  console.log("12) Back up server data");
  console.log("13) Turn keep-awake ON");
  console.log("14) Turn keep-awake OFF");
  console.log("15) Tail logs");
  console.log("0) Exit");
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      printMenu();
      const choice = await ask(rl, "Select an option");
      try {
        if (choice === "1") showStatus();
        else if (choice === "2") startServer();
        else if (choice === "3") stopServer();
        else if (choice === "4") restartServer();
        else if (choice === "5") openBrowser();
        else if (choice === "6") await configurePeer(rl);
        else if (choice === "7") await syncFromPeer();
        else if (choice === "8") await shutdownPeer();
        else if (choice === "9") listMessages(Number(await ask(rl, "How many messages", "30")));
        else if (choice === "10") await deleteMessage(await ask(rl, "Message ID to delete"));
        else if (choice === "11") {
          const confirm = await ask(rl, "Type RESET to delete users and messages");
          if (confirm === "RESET") await resetServer(); else console.log("Reset cancelled.");
        }
        else if (choice === "12") console.log(`Backup created: ${backupData("manual") || "no data file yet"}`);
        else if (choice === "13") startAwake();
        else if (choice === "14") stopAwake();
        else if (choice === "15") tailLogs();
        else if (choice === "0" || choice.toLowerCase() === "q") break;
        else console.log("Unknown option.");
      } catch (error) {
        console.error(`Error: ${error.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

function tailLogs() {
  if (isLinux()) {
    spawn("journalctl", ["--user", "-u", serviceName(), "-f"], { stdio: "inherit" });
  } else if (isMac()) {
    const logFile = path.join(ROOT, "data/server.log");
    console.log(`Tailing ${logFile}`);
    spawn("tail", ["-f", logFile], { stdio: "inherit" });
  } else {
    console.log("Log tailing is not configured for this OS.");
  }
}

async function main() {
  env = saveEnv({});
  const cmd = process.argv[2] || "menu";
  if (cmd === "menu") return menu();
  if (cmd === "status") return showStatus();
  if (cmd === "start") return startServer();
  if (cmd === "stop") return stopServer();
  if (cmd === "restart") return restartServer();
  if (cmd === "awake-on") return startAwake();
  if (cmd === "awake-off") return stopAwake();
  if (cmd === "open") return openBrowser();
  if (cmd === "list") return listMessages(Number(process.argv[3] || 30));
  if (cmd === "delete") return deleteMessage(process.argv[3]);
  if (cmd === "sync-peer") return syncFromPeer();
  if (cmd === "shutdown-peer") return shutdownPeer();
  if (cmd === "reset") return resetServer();
  console.log(`Unknown command: ${cmd}`);
  console.log("Try: npm run menu");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
