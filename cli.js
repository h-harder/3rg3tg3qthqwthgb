'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const readline = require('readline');
const crypto = require('crypto');

const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'chat-data.json');
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const ENV_FILE = path.join(APP_DIR, '.env');
const LOG_DIR = path.join(APP_DIR, 'logs');
const OUT_LOG = path.join(LOG_DIR, 'server.out.log');
const ERR_LOG = path.join(LOG_DIR, 'server.err.log');
const SERVER_JS = path.join(APP_DIR, 'server.js');
const PLATFORM = process.platform;
const IS_MAC = PLATFORM === 'darwin';
const IS_WIN = PLATFORM === 'win32';

const MAC_SERVER_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.homechat.server.plist');
const MAC_AWAKE_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.homechat.awake.plist');
const WIN_SERVER_TASK = 'HomeChatServer';
const WIN_AWAKE_TASK = 'HomeChatKeepAwake';
const WIN_KEEPAWAKE_PS1 = path.join(APP_DIR, 'scripts', 'keepawake.ps1');
const WIN_KEEPAWAKE_PID = path.join(DATA_DIR, 'keepawake.pid');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}
ensureDirs();

function print(msg = '') { console.log(msg); }
function warn(msg) { console.warn(`[HomeChat] ${msg}`); }
function run(cmd, args = [], options = {}) {
  const res = cp.spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...options });
  return res;
}
function commandExists(cmd) {
  const which = IS_WIN ? 'where' : 'command';
  const args = IS_WIN ? [cmd] : ['-v', cmd];
  const res = IS_WIN ? run(which, args) : cp.spawnSync('sh', ['-lc', `command -v ${shellQuote(cmd)}`], { encoding: 'utf8' });
  return res.status === 0;
}
function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function xmlEscape(s) { return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch])); }
function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }
function cmdQuote(s) { return `"${String(s).replace(/"/g, '\\"')}"`; }

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  if (!env.PORT) env.PORT = '3000';
  if (!env.APP_NAME) env.APP_NAME = 'HomeChat';
  if (!env.SESSION_SECRET) env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  if (!env.ADMIN_KEY) env.ADMIN_KEY = crypto.randomBytes(32).toString('hex');
  if (!('PEER_URL' in env)) env.PEER_URL = '';
  if (!('HANDOFF_ON_START' in env)) env.HANDOFF_ON_START = 'true';
  saveEnv(env);
  return env;
}

function saveEnv(env) {
  const order = ['PORT', 'APP_NAME', 'SESSION_SECRET', 'ADMIN_KEY', 'PEER_URL', 'HANDOFF_ON_START'];
  const lines = [];
  for (const key of order) lines.push(`${key}=${env[key] ?? ''}`);
  for (const [key, value] of Object.entries(env)) if (!order.includes(key)) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, lines.join(os.EOL) + os.EOL);
}

const env = loadEnv();
const port = () => Number(loadEnv().PORT || 3000);
const adminKey = () => loadEnv().ADMIN_KEY || '';

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { version: 1, updatedAt: new Date().toISOString(), users: [], messages: [], sessions: [] };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    return { version: 1, updatedAt: new Date().toISOString(), users: [], messages: [], sessions: [] };
  }
}
function writeData(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  data.updatedAt = new Date().toISOString();
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function backupData() {
  const backupDir = path.join(APP_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(backupDir, `chat-data-${stamp}.json`);
  const data = readData();
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  return out;
}

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch (_) { return 0; }
}
function isPidRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}
async function httpJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
async function isLocalServerUp() {
  try {
    await httpJson(`http://127.0.0.1:${port()}/api/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch (_) {
    return false;
  }
}

async function shutdownLocalByApi() {
  try {
    await httpJson(`http://127.0.0.1:${port()}/api/admin/shutdown`, {
      method: 'POST',
      headers: { 'x-admin-key': adminKey() },
      body: JSON.stringify({ reason: 'cli-stop' }),
      signal: AbortSignal.timeout(1500)
    });
    await sleep(900);
    return true;
  } catch (_) {
    return false;
  }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function writeMacServerPlist() {
  if (!IS_MAC) return;
  fs.mkdirSync(path.dirname(MAC_SERVER_PLIST), { recursive: true });
  const nodePath = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.homechat.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(SERVER_JS)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(APP_DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(OUT_LOG)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(ERR_LOG)}</string>
</dict>
</plist>
`;
  fs.writeFileSync(MAC_SERVER_PLIST, plist);
}
function macBootout(plist) {
  run('launchctl', ['bootout', `gui/${process.getuid()}`, plist]);
}
function macBootstrap(plist) {
  run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
}
function macKickstart(label) {
  run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]);
}

function winServerTaskCommand() {
  const node = process.execPath;
  const ps = `Start-Process -FilePath ${psQuote(node)} -ArgumentList ${psQuote(SERVER_JS)} -WorkingDirectory ${psQuote(APP_DIR)} -WindowStyle Hidden`;
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ${cmdQuote(ps)}`;
}
function winCreateServerTask() {
  const tr = winServerTaskCommand();
  run('schtasks.exe', ['/Create', '/TN', WIN_SERVER_TASK, '/SC', 'ONLOGON', '/TR', tr, '/F']);
}
function winDeleteTask(name) {
  run('schtasks.exe', ['/End', '/TN', name]);
  run('schtasks.exe', ['/Delete', '/TN', name, '/F']);
}
function winRunTask(name) { run('schtasks.exe', ['/Run', '/TN', name]); }
function winEndTask(name) { run('schtasks.exe', ['/End', '/TN', name]); }
function winTaskExists(name) { return run('schtasks.exe', ['/Query', '/TN', name]).status === 0; }

function spawnDetachedServer() {
  const out = fs.openSync(OUT_LOG, 'a');
  const err = fs.openSync(ERR_LOG, 'a');
  const child = cp.spawn(process.execPath, [SERVER_JS], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

async function startServer() {
  if (await isLocalServerUp()) {
    warn(`Server is already running at http://127.0.0.1:${port()}`);
    return;
  }
  ensureDirs();
  if (IS_MAC) {
    writeMacServerPlist();
    macBootout(MAC_SERVER_PLIST);
    macBootstrap(MAC_SERVER_PLIST);
    macKickstart('com.homechat.server');
  } else if (IS_WIN && winTaskExists(WIN_SERVER_TASK)) {
    winRunTask(WIN_SERVER_TASK);
  } else {
    const pid = spawnDetachedServer();
    warn(`Started server process ${pid}.`);
  }
  await sleep(1500);
  if (await isLocalServerUp()) {
    warn(`Server started at http://127.0.0.1:${port()}`);
    showUrls();
  } else {
    warn('Start command sent, but the health check did not respond yet. Check logs from the menu.');
  }
}

async function stopServer() {
  if (IS_MAC && fs.existsSync(MAC_SERVER_PLIST)) macBootout(MAC_SERVER_PLIST);
  if (IS_WIN && winTaskExists(WIN_SERVER_TASK)) winEndTask(WIN_SERVER_TASK);
  const apiStopped = await shutdownLocalByApi();
  const pid = readPid();
  if (isPidRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    await sleep(700);
    if (isPidRunning(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }
  }
  warn(apiStopped ? 'Server stopped.' : 'Stop command completed.');
}

async function restartServer() {
  await stopServer();
  await sleep(1000);
  await startServer();
}

function enableStartup() {
  if (IS_MAC) {
    writeMacServerPlist();
    macBootout(MAC_SERVER_PLIST);
    macBootstrap(MAC_SERVER_PLIST);
    warn('Startup enabled with macOS launchd.');
  } else if (IS_WIN) {
    winCreateServerTask();
    warn('Startup enabled with Windows Task Scheduler at user logon.');
  } else {
    warn('Startup helper supports macOS and Windows 11 only in this package.');
  }
}

function disableStartup() {
  if (IS_MAC) {
    macBootout(MAC_SERVER_PLIST);
    try { fs.unlinkSync(MAC_SERVER_PLIST); } catch (_) {}
    warn('Startup disabled.');
  } else if (IS_WIN) {
    winDeleteTask(WIN_SERVER_TASK);
    warn('Startup disabled.');
  }
}

function writeMacAwakePlist() {
  fs.mkdirSync(path.dirname(MAC_AWAKE_PLIST), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.homechat.awake</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-dimsu</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(LOG_DIR, 'awake.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(LOG_DIR, 'awake.err.log'))}</string>
</dict>
</plist>
`;
  fs.writeFileSync(MAC_AWAKE_PLIST, plist);
}
function enableKeepAwake() {
  if (IS_MAC) {
    writeMacAwakePlist();
    macBootout(MAC_AWAKE_PLIST);
    macBootstrap(MAC_AWAKE_PLIST);
    warn('Keep-awake enabled using caffeinate.');
  } else if (IS_WIN) {
    const tr = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${cmdQuote(WIN_KEEPAWAKE_PS1)}`;
    run('schtasks.exe', ['/Create', '/TN', WIN_AWAKE_TASK, '/SC', 'ONLOGON', '/TR', tr, '/F']);
    run('schtasks.exe', ['/Run', '/TN', WIN_AWAKE_TASK]);
    warn('Keep-awake enabled using Windows Task Scheduler.');
  } else {
    warn('Keep-awake toggle supports macOS and Windows 11 only in this package.');
  }
}
function disableKeepAwake() {
  if (IS_MAC) {
    macBootout(MAC_AWAKE_PLIST);
    try { fs.unlinkSync(MAC_AWAKE_PLIST); } catch (_) {}
    warn('Keep-awake disabled.');
  } else if (IS_WIN) {
    winDeleteTask(WIN_AWAKE_TASK);
    try {
      const pid = Number(fs.readFileSync(WIN_KEEPAWAKE_PID, 'utf8').trim());
      if (pid) run('taskkill.exe', ['/PID', String(pid), '/F']);
    } catch (_) {}
    warn('Keep-awake disabled.');
  }
}

async function configurePeer(rl) {
  const e = loadEnv();
  const peer = await ask(rl, `Peer URL [${e.PEER_URL || 'blank'}]: `);
  if (peer.trim()) e.PEER_URL = peer.trim().replace(/\/$/, '');
  const changeKey = await ask(rl, 'Use a specific shared ADMIN_KEY? Leave blank to keep current: ');
  if (changeKey.trim()) e.ADMIN_KEY = changeKey.trim();
  const handoff = await ask(rl, `Handoff on start true/false [${e.HANDOFF_ON_START || 'true'}]: `);
  if (handoff.trim()) e.HANDOFF_ON_START = String(handoff.trim()).toLowerCase() === 'false' ? 'false' : 'true';
  saveEnv(e);
  warn('Peer settings saved. Restart the server for startup handoff changes to take effect.');
}

async function syncFromPeer() {
  const e = loadEnv();
  if (!e.PEER_URL) throw new Error('PEER_URL is blank. Configure peer handoff first.');
  const payload = await httpJson(`${e.PEER_URL.replace(/\/$/, '')}/api/admin/export`, {
    headers: { 'x-admin-key': e.ADMIN_KEY },
    signal: AbortSignal.timeout(5000)
  });
  backupData();
  if (await isLocalServerUp()) {
    await httpJson(`http://127.0.0.1:${port()}/api/admin/import`, {
      method: 'POST',
      headers: { 'x-admin-key': e.ADMIN_KEY },
      body: JSON.stringify({ data: payload.data }),
      signal: AbortSignal.timeout(5000)
    });
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload.data, null, 2));
  }
  warn(`Synced data from peer. Peer updatedAt: ${payload.data.updatedAt}`);
}

async function shutdownPeer() {
  const e = loadEnv();
  if (!e.PEER_URL) throw new Error('PEER_URL is blank. Configure peer handoff first.');
  await httpJson(`${e.PEER_URL.replace(/\/$/, '')}/api/admin/shutdown`, {
    method: 'POST',
    headers: { 'x-admin-key': e.ADMIN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'cli-peer-shutdown' }),
    signal: AbortSignal.timeout(5000)
  });
  warn('Peer shutdown request sent.');
}

function listMessages() {
  const data = readData();
  const messages = (data.messages || []).slice(-100);
  if (!messages.length) return print('No messages found.');
  messages.forEach((m, idx) => {
    const status = m.deleted ? ' [deleted]' : '';
    print(`${idx + 1}. ${m.id}${status}`);
    print(`   ${m.createdAt} · ${m.displayName || m.username}: ${m.text}`);
  });
}

async function deleteMessageById(rl) {
  listMessages();
  const id = await ask(rl, 'Message ID to delete: ');
  if (!id.trim()) return;
  if (await isLocalServerUp()) {
    try {
      await httpJson(`http://127.0.0.1:${port()}/api/admin/delete-message`, {
        method: 'POST',
        headers: { 'x-admin-key': adminKey() },
        body: JSON.stringify({ id: id.trim() }),
        signal: AbortSignal.timeout(3000)
      });
      warn('Message deleted through running server.');
      return;
    } catch (_) {
      // fall through to direct edit
    }
  }
  const data = readData();
  const msg = (data.messages || []).find(m => m.id === id.trim());
  if (!msg) return warn('Message not found.');
  msg.deleted = true;
  msg.deletedAt = new Date().toISOString();
  msg.deletedBy = 'cli';
  writeData(data);
  warn('Message marked deleted. Restart or refresh clients to update displays.');
}

async function resetServerData(rl) {
  const confirm = await ask(rl, 'This deletes all users and messages. Type RESET to continue: ');
  if (confirm !== 'RESET') return warn('Reset cancelled.');
  const backup = backupData();
  await stopServer();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), users: [], messages: [], sessions: [] }, null, 2));
  warn(`Server data reset. Backup saved at ${backup}`);
}

function showLogs() {
  for (const file of [OUT_LOG, ERR_LOG]) {
    print(`\n--- ${file} ---`);
    if (!fs.existsSync(file)) {
      print('No log file yet.');
      continue;
    }
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-80).join('\n');
    print(lines);
  }
}

function showUrls() {
  const p = port();
  print('\nOpen HomeChat at:');
  print(`  Local:   http://127.0.0.1:${p}`);
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) print(`  Network: http://${net.address}:${p}`);
    }
  }
  print('');
}

function showStatus() {
  const pid = readPid();
  const data = readData();
  print(`Install directory: ${APP_DIR}`);
  print(`Port: ${port()}`);
  print(`Peer URL: ${loadEnv().PEER_URL || '(none)'}`);
  print(`Handoff on start: ${loadEnv().HANDOFF_ON_START}`);
  print(`PID file: ${pid || '(none)'}`);
  print(`PID running: ${isPidRunning(pid) ? 'yes' : 'no'}`);
  print(`Users: ${(data.users || []).length}`);
  print(`Messages: ${(data.messages || []).filter(m => !m.deleted).length}`);
  showUrls();
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer)));
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    print('\nHomeChat Control Menu');
    print('1) Start server');
    print('2) Stop server');
    print('3) Restart server');
    print('4) Enable start at login');
    print('5) Disable start at login');
    print('6) Configure peer handoff');
    print('7) Sync from peer now');
    print('8) Shut down peer now');
    print('9) List messages');
    print('10) Delete a message');
    print('11) Back up data');
    print('12) Reset server data');
    print('13) Turn keep-awake ON');
    print('14) Turn keep-awake OFF');
    print('15) Show URLs and status');
    print('16) Show logs');
    print('0) Exit');
    const choice = await ask(rl, 'Choose an option: ');
    try {
      if (choice === '1') await startServer();
      else if (choice === '2') await stopServer();
      else if (choice === '3') await restartServer();
      else if (choice === '4') enableStartup();
      else if (choice === '5') disableStartup();
      else if (choice === '6') await configurePeer(rl);
      else if (choice === '7') await syncFromPeer();
      else if (choice === '8') await shutdownPeer();
      else if (choice === '9') listMessages();
      else if (choice === '10') await deleteMessageById(rl);
      else if (choice === '11') warn(`Backup saved at ${backupData()}`);
      else if (choice === '12') await resetServerData(rl);
      else if (choice === '13') enableKeepAwake();
      else if (choice === '14') disableKeepAwake();
      else if (choice === '15') showStatus();
      else if (choice === '16') showLogs();
      else if (choice === '0') break;
    } catch (err) {
      warn(err.message || String(err));
    }
  }
  rl.close();
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === 'start') return startServer();
    if (cmd === 'stop') return stopServer();
    if (cmd === 'restart') return restartServer();
    if (cmd === 'enable-startup') return enableStartup();
    if (cmd === 'disable-startup') return disableStartup();
    if (cmd === 'keep-awake-on') return enableKeepAwake();
    if (cmd === 'keep-awake-off') return disableKeepAwake();
    if (cmd === 'urls' || cmd === 'status') return showStatus();
    if (cmd === 'logs') return showLogs();
    if (cmd === 'backup') return warn(`Backup saved at ${backupData()}`);
    return menu();
  } catch (err) {
    warn(err.message || String(err));
    process.exitCode = 1;
  }
}

main();
