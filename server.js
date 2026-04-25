'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Store, DATA_DIR } = require('./dataStore');

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const APP_NAME = process.env.APP_NAME || 'HomeChat';
const SESSION_COOKIE = 'homechat_session';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PEER_URL = (process.env.PEER_URL || '').replace(/\/$/, '');
const HANDOFF_ON_START = String(process.env.HANDOFF_ON_START || 'true').toLowerCase() !== 'false';

const store = new Store();
store.writePid();
process.on('exit', () => store.removePid());
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function parseCookies(cookieHeader) {
  const out = {};
  String(cookieHeader || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function getSessionToken(req) {
  return parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
}

function cookieOptions() {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 30}`
  ].join('; ');
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions()}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function currentUser(req) {
  return store.getUserByToken(getSessionToken(req));
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Login required.' });
  req.user = user;
  next();
}

function requireModerator(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Login required.' });
  if (user.role !== 'moderator') return res.status(403).json({ error: 'Moderator access required.' });
  req.user = user;
  next();
}

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error: 'Admin key required.' });
  next();
}

function requireModeratorOrAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (ADMIN_KEY && key === ADMIN_KEY) {
    req.user = { id: 'admin-key', username: 'cli', displayName: 'CLI', role: 'moderator' };
    return next();
  }
  return requireModerator(req, res, next);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: APP_NAME, port: PORT, updatedAt: store.exportData().updatedAt });
});

app.get('/api/me', (req, res) => {
  res.json({ user: currentUser(req) });
});

app.post('/api/register', (req, res) => {
  try {
    const user = store.createUser(req.body || {});
    const session = store.createSession(user.id);
    setSessionCookie(res, session.token);
    res.json({ user, firstModerator: user.role === 'moderator' });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not create account.' });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = store.verifyLogin(username, password);
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
    const session = store.createSession(user.id);
    setSessionCookie(res, session.token);
    res.json({ user });
  } catch (err) {
    res.status(403).json({ error: err.message || 'Login failed.' });
  }
});

app.post('/api/logout', (req, res) => {
  store.deleteSession(getSessionToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/messages', requireUser, (req, res) => {
  res.json({ messages: store.listMessages(Number(req.query.limit || 200)) });
});

app.post('/api/messages', requireUser, (req, res) => {
  try {
    const message = store.addMessage(req.user, req.body.text);
    io.emit('chat:message', message);
    res.json({ message });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Message failed.' });
  }
});

app.get('/api/admin/users', requireModerator, (_req, res) => {
  res.json({ users: store.listUsers() });
});

app.post('/api/admin/delete-message', requireModeratorOrAdminKey, (req, res) => {
  try {
    const message = store.deleteMessage(req.body.id, req.user.username);
    io.emit('chat:delete', { id: message.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not delete message.' });
  }
});

app.post('/api/admin/ban-user', requireModerator, (req, res) => {
  try {
    const user = store.setUserBan(req.body.id, !!req.body.banned);
    io.emit('admin:user-updated', user);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not update user.' });
  }
});

app.post('/api/admin/role', requireModerator, (req, res) => {
  try {
    const user = store.setUserRole(req.body.id, req.body.role);
    io.emit('admin:user-updated', user);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not update role.' });
  }
});

app.get('/api/admin/export', requireAdminKey, (_req, res) => {
  res.json({ data: store.exportData() });
});

app.post('/api/admin/import', requireAdminKey, (req, res) => {
  try {
    if (!req.body || !req.body.data) return res.status(400).json({ error: 'Missing data.' });
    store.replaceData(req.body.data);
    io.emit('server:sync', { updatedAt: store.exportData().updatedAt });
    res.json({ ok: true, updatedAt: store.exportData().updatedAt });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Import failed.' });
  }
});

app.post('/api/admin/reset', requireAdminKey, (_req, res) => {
  store.reset();
  io.emit('server:reset');
  res.json({ ok: true });
});

app.post('/api/admin/shutdown', requireAdminKey, (_req, res) => {
  log('Remote shutdown requested.');
  res.json({ ok: true, message: 'Server shutting down.' });
  setTimeout(() => process.exit(0), 600);
});

io.use((socket, next) => {
  const cookies = parseCookies(socket.request.headers.cookie || '');
  const user = store.getUserByToken(cookies[SESSION_COOKIE]);
  if (!user) return next(new Error('Login required.'));
  socket.user = user;
  next();
});

io.on('connection', socket => {
  socket.emit('chat:ready', { user: socket.user });

  socket.on('chat:send', (payload, callback) => {
    try {
      const latest = store.getUserByToken(parseCookies(socket.request.headers.cookie || '')[SESSION_COOKIE]);
      if (!latest) throw new Error('Login required.');
      const message = store.addMessage(latest, payload && payload.text);
      io.emit('chat:message', message);
      if (callback) callback({ ok: true, message });
    } catch (err) {
      if (callback) callback({ ok: false, error: err.message || 'Message failed.' });
    }
  });
});

async function startupHandoff() {
  if (!HANDOFF_ON_START || !PEER_URL || !ADMIN_KEY || typeof fetch !== 'function') return;
  try {
    log(`Peer handoff enabled. Checking ${PEER_URL}`);
    const response = await fetch(`${PEER_URL}/api/admin/export`, {
      headers: { 'x-admin-key': ADMIN_KEY },
      signal: AbortSignal.timeout(3500)
    });
    if (!response.ok) throw new Error(`Peer export failed: ${response.status}`);
    const payload = await response.json();
    const peerData = payload.data;
    const peerMs = Date.parse(peerData && peerData.updatedAt || '') || 0;
    const localMs = store.getUpdatedAtMs();
    if (peerMs > localMs) {
      store.replaceData(peerData);
      log(`Synced newer data from peer. Peer updatedAt=${peerData.updatedAt}`);
    } else {
      log('Local data is as new or newer than peer data.');
    }
    const shutdownResponse = await fetch(`${PEER_URL}/api/admin/shutdown`, {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'peer-handoff', startedBy: APP_NAME }),
      signal: AbortSignal.timeout(3500)
    });
    if (shutdownResponse.ok) log('Peer shutdown request sent.');
  } catch (err) {
    log(`Peer handoff skipped: ${err.message}`);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  log(`${APP_NAME} listening on port ${PORT}`);
  startupHandoff();
});
