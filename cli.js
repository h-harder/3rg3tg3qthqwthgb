#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { spawnSync } = require('child_process');
const {
  DATA_FILE,
  now,
  id,
  loadData,
  saveData,
  backupData,
  resetData,
  publicMessage,
  stripPrivateUserFields,
  mergeData,
  getStats
} = require('./dataStore');

const APP_DIR = __dirname;
const ENV_FILE = path.join(APP_DIR, '.env');
const OS_NAME = os.platform();
const IS_MAC = OS_NAME === 'darwin';
const IS_LINUX = OS_NAME === 'linux';
const SERVICE = 'simple-chat.service';
const AWAKE_SERVICE = 'simple-chat-awake.service';
const MAC_SERVER_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.simplechat.server.plist');
const MAC_AWAKE_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.simplechat.awake.plist');
const USER_AGENT = `gui/${process.getuid ? process.getuid() : ''}`;

function reloadEnv() {
  delete require.cache[require.resolve('dotenv')];
  require('dotenv').config({ path: ENV_FILE, override: true });
}

function env(key, fallback = '') {
  return process.env[key] || fallback;
}

function port() {
  return Number(env('PORT', '3000'));
}

function adminKey() {
  return env('ADMIN_KEY', '');
}

function peerUrl() {
  return String(env('PEER_URL', '')).replace(/\/$/, '');
}

function localUrl() {
  return `http://127.0.0.1:${port()}`;
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: APP_DIR,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false
  });
  if (options.capture) return result;
  if (result.status !== 0 && !options.ignoreError) {
    console.log(`Command failed: ${command} ${args.join(' ')}`);
  }
  return result;
}

function macLabel(service) {
  return service === 'awake' ? 'com.simplechat.awake' : 'com.simplechat.server';
}

function macPlist(service) {
  return service === 'awake' ? MAC_AWAKE_PLIST : MAC_SERVER_PLIST;
}

function launchctl(action, service = 'server') {
  const label = macLabel(service);
  const plist = macPlist(service);
  if (action === 'start') {
    run('launchctl', ['bootstrap', USER_AGENT, plist], { ignoreError: true });
    run('launchctl', ['kickstart', '-k', `${USER_AGENT}/${label}`], { ignoreError: true });
    return;
  }
  if (action === 'stop') {
    run('launchctl', ['bootout', USER_AGENT, plist], { ignoreError: true });
    return;
  }
  if (action === 'restart') {
    launchctl('stop', service);
    launchctl('start', service);
    return;
  }
  if (action === 'status') {
    return run('launchctl', ['print', `${USER_AGENT}/${label}`], { capture: true, ignoreError: true });
  }
}

function systemctl(action, service = SERVICE) {
  return run('systemctl', ['--user', action, service], { ignoreError: action === 'status', capture: action === 'status' });
}

function startServer() {
  if (IS_LINUX) systemctl('start', SERVICE);
  else if (IS_MAC) launchctl('start', 'server');
  else console.log('Unsupported OS.');
}

function stopServer() {
  if (IS_LINUX) systemctl('stop', SERVICE);
  else if (IS_MAC) launchctl('stop', 'server');
  else console.log('Unsupported OS.');
}

function restartServer() {
  if (IS_LINUX) systemctl('restart', SERVICE);
  else if (IS_MAC) launchctl('restart', 'server');
  else console.log('Unsupported OS.');
}

function statusServer() {
  let result;
  if (IS_LINUX) result = systemctl('status', SERVICE);
  else if (IS_MAC) result = launchctl('status', 'server');
  else return console.log('Unsupported OS.');

  if (result.stdout) console.log(result.stdout.trim());
  if (result.stderr) console.log(result.stderr.trim());
  if (result.status !== 0) console.log('Server service does not appear to be running.');
}

function enableAwake() {
  if (IS_LINUX) {
    systemctl('enable', AWAKE_SERVICE);
    systemctl('start', AWAKE_SERVICE);
  } else if (IS_MAC) {
    run('launchctl', ['enable', `${USER_AGENT}/com.simplechat.awake`], { ignoreError: true });
    launchctl('start', 'awake');
  }
  console.log('Keep-awake is ON.');
}

function disableAwake() {
  if (IS_LINUX) {
    systemctl('disable', AWAKE_SERVICE);
    systemctl('stop', AWAKE_SERVICE);
  } else if (IS_MAC) {
    launchctl('stop', 'awake');
    run('launchctl', ['disable', `${USER_AGENT}/com.simplechat.awake`], { ignoreError: true });
  }
  console.log('Keep-awake is OFF.');
}

function showLogs() {
  if (IS_LINUX) {
    run('journalctl', ['--user', '-u', SERVICE, '-n', '120', '--no-pager'], { ignoreError: true });
  } else if (IS_MAC) {
    const logPath = path.join(APP_DIR, 'data', 'server.log');
    if (fs.existsSync(logPath)) console.log(fs.readFileSync(logPath, 'utf8').split('\n').slice(-120).join('\n'));
    else console.log('No server log found yet.');
  }
}

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return '';
  return fs.readFileSync(ENV_FILE, 'utf8');
}

function writeEnvValue(key, value) {
  let text = readEnvFile();
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, line);
  else text += `\n${line}\n`;
  fs.writeFileSync(ENV_FILE, text.endsWith('\n') ? text : `${text}\n`);
  process.env[key] = value;
}

function ipAddresses() {
  const addrs = [];
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

function showUrls() {
  console.log('\nLocal URLs:');
  console.log(`  ${localUrl()}`);
  for (const ip of ipAddresses()) console.log(`  http://${ip}:${port()}`);
  console.log(`\nPeer URL: ${peerUrl() || '(not set)'}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-admin-key': adminKey(),
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch { json = { raw: body }; }
  if (!response.ok) throw new Error(json.error || `${response.status} ${response.statusText}`);
  return json;
}

async function syncFromPeer() {
  const peer = peerUrl();
  if (!peer) return console.log('PEER_URL is not set. Use Configure peer handoff first.');
  if (!adminKey()) return console.log('ADMIN_KEY is not set.');
  console.log(`Syncing from ${peer} ...`);
  const exported = await fetchJson(`${peer}/api/admin/export`, { method: 'GET' });
  if (!exported.data) throw new Error('Peer export did not contain data.');
  const local = loadData();
  const merged = mergeData(local, exported.data);
  saveData(merged, { bump: false });
  console.log(`Synced. Users: ${merged.users.length}. Messages: ${merged.messages.length}.`);
}

async function shutdownPeer() {
  const peer = peerUrl();
  if (!peer) return console.log('PEER_URL is not set.');
  await fetchJson(`${peer}/api/admin/shutdown`, {
    method: 'POST',
    body: JSON.stringify({ reason: `Manual shutdown requested from ${os.hostname()}` })
  });
  console.log('Peer shutdown requested.');
}

function listRecentMessages(count = 25) {
  const data = loadData();
  const recent = data.messages.slice(-count).map(publicMessage);
  if (!recent.length) return console.log('No messages yet.');
  for (const msg of recent) {
    console.log(`\n${msg.id}`);
    console.log(`${msg.createdAt} | ${msg.username}${msg.system ? ' | system' : ''}${msg.deleted ? ' | deleted' : ''}`);
    console.log(`  ${msg.text}`);
  }
}

function deleteMessage(messageId, deletedBy = 'terminal') {
  const data = loadData();
  const message = data.messages.find(m => m.id === messageId);
  if (!message) return false;
  message.deleted = true;
  message.deletedAt = now();
  message.deletedBy = deletedBy;
  message.updatedAt = now();
  saveData(data);
  return true;
}

function addSystemMessage(text) {
  const data = loadData();
  const message = {
    id: id('sys'),
    userId: 'system',
    username: 'System',
    text,
    createdAt: now(),
    updatedAt: now(),
    deleted: false,
    system: true
  };
  data.messages.push(message);
  saveData(data);
  return message;
}

function listUsers() {
  const data = loadData();
  if (!data.users.length) return console.log('No users yet.');
  for (const user of data.users.map(stripPrivateUserFields)) {
    console.log(`${user.id} | ${user.username} | ${user.role} | banned=${user.banned} | created=${user.createdAt}`);
  }
}

function updateUser(userId, patch) {
  const data = loadData();
  const user = data.users.find(u => u.id === userId);
  if (!user) return false;
  Object.assign(user, patch, { updatedAt: now() });
  saveData(data);
  return true;
}

async function configurePeer(rl) {
  console.log('\nCurrent settings:');
  console.log(`  PORT=${port()}`);
  console.log(`  PEER_URL=${peerUrl() || '(not set)'}`);
  console.log(`  STARTUP_HANDOFF=${env('STARTUP_HANDOFF', 'true')}`);
  console.log(`  ADMIN_KEY=${adminKey() ? '(set)' : '(not set)'}`);

  const newPort = (await rl.question(`Port [${port()}]: `)).trim();
  if (newPort) writeEnvValue('PORT', newPort);

  const newPeer = (await rl.question(`Peer URL [${peerUrl() || 'blank'}]: `)).trim();
  if (newPeer || peerUrl()) writeEnvValue('PEER_URL', newPeer.replace(/\/$/, ''));

  const handoff = (await rl.question(`Startup handoff true/false [${env('STARTUP_HANDOFF', 'true')}]: `)).trim().toLowerCase();
  if (handoff === 'true' || handoff === 'false') writeEnvValue('STARTUP_HANDOFF', handoff);

  const keyChoice = (await rl.question('Paste shared ADMIN_KEY, or press Enter to keep current: ')).trim();
  if (keyChoice) writeEnvValue('ADMIN_KEY', keyChoice);

  reloadEnv();
  console.log('Settings saved. Restart the server for changes to take effect.');
}

async function terminalMenu() {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const stats = getStats(loadData());
      console.log(`\nHomeChat Control Menu`);
      console.log(`Server: ${localUrl()} | users=${stats.users} messages=${stats.messages} updated=${stats.updatedAt}`);
      console.log('1) Start server');
      console.log('2) Stop server');
      console.log('3) Restart server');
      console.log('4) Server status');
      console.log('5) Show server URLs');
      console.log('6) Configure peer handoff');
      console.log('7) Sync from peer now');
      console.log('8) Shut down peer now');
      console.log('9) List recent messages');
      console.log('10) Delete a message');
      console.log('11) Add system announcement');
      console.log('12) List users');
      console.log('13) Ban or unban user');
      console.log('14) Promote or demote user');
      console.log('15) Back up data');
      console.log('16) Reset local server data');
      console.log('17) Turn keep-awake ON');
      console.log('18) Turn keep-awake OFF');
      console.log('19) Show logs');
      console.log('0) Exit');

      const choice = (await rl.question('\nChoose an option: ')).trim();
      try {
        if (choice === '0') break;
        if (choice === '1') startServer();
        else if (choice === '2') stopServer();
        else if (choice === '3') restartServer();
        else if (choice === '4') statusServer();
        else if (choice === '5') showUrls();
        else if (choice === '6') await configurePeer(rl);
        else if (choice === '7') await syncFromPeer();
        else if (choice === '8') await shutdownPeer();
        else if (choice === '9') {
          const count = Number((await rl.question('How many messages? [25]: ')).trim() || 25);
          listRecentMessages(count);
        }
        else if (choice === '10') {
          listRecentMessages(20);
          const messageId = (await rl.question('\nMessage ID to delete: ')).trim();
          console.log(deleteMessage(messageId) ? 'Message deleted locally. Restart or refresh clients if needed.' : 'Message not found.');
        }
        else if (choice === '11') {
          const text = (await rl.question('Announcement text: ')).trim();
          if (text) {
            const message = addSystemMessage(text);
            console.log(`Announcement added: ${message.id}`);
          }
        }
        else if (choice === '12') listUsers();
        else if (choice === '13') {
          listUsers();
          const userId = (await rl.question('User ID: ')).trim();
          const banned = (await rl.question('Ban this user? true/false: ')).trim().toLowerCase() === 'true';
          console.log(updateUser(userId, { banned }) ? 'User updated.' : 'User not found.');
        }
        else if (choice === '14') {
          listUsers();
          const userId = (await rl.question('User ID: ')).trim();
          const role = (await rl.question('Role member/moderator: ')).trim().toLowerCase();
          if (!['member', 'moderator'].includes(role)) console.log('Invalid role.');
          else console.log(updateUser(userId, { role }) ? 'User updated.' : 'User not found.');
        }
        else if (choice === '15') console.log(`Backup created: ${backupData('manual')}`);
        else if (choice === '16') {
          const confirm = (await rl.question('Type RESET to delete local users/messages after making a backup: ')).trim();
          if (confirm === 'RESET') {
            const result = resetData();
            console.log(`Reset complete. Backup: ${result.backupPath}`);
          } else console.log('Reset cancelled.');
        }
        else if (choice === '17') enableAwake();
        else if (choice === '18') disableAwake();
        else if (choice === '19') showLogs();
        else console.log('Unknown option.');
      } catch (error) {
        console.log(`Error: ${error.message}`);
      }

      await rl.question('\nPress Enter to continue...');
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (!cmd) return terminalMenu();
    if (cmd === 'start') return startServer();
    if (cmd === 'stop') return stopServer();
    if (cmd === 'restart') return restartServer();
    if (cmd === 'status') return statusServer();
    if (cmd === 'awake-on') return enableAwake();
    if (cmd === 'awake-off') return disableAwake();
    if (cmd === 'urls') return showUrls();
    if (cmd === 'logs') return showLogs();
    if (cmd === 'sync-peer') return syncFromPeer();
    if (cmd === 'shutdown-peer') return shutdownPeer();
    if (cmd === 'backup') return console.log(`Backup created: ${backupData('manual')}`);
    if (cmd === 'reset') {
      const result = resetData();
      return console.log(`Reset complete. Backup: ${result.backupPath}`);
    }
    console.log('Usage: homechat [start|stop|restart|status|urls|logs|awake-on|awake-off|sync-peer|shutdown-peer|backup|reset]');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
