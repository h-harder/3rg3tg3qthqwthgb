require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const {
  now,
  id,
  loadData,
  saveData,
  backupData,
  stripPrivateUserFields,
  publicMessage,
  mergeData,
  getStats
} = require('./dataStore');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const INSTANCE_ID = process.env.INSTANCE_ID || require('os').hostname();
const PEER_URL = String(process.env.PEER_URL || '').replace(/\/$/, '');
const STARTUP_HANDOFF = String(process.env.STARTUP_HANDOFF || 'true').toLowerCase() === 'true';
const MESSAGE_HISTORY_LIMIT = Number(process.env.MESSAGE_HISTORY_LIMIT || 200);

let data = loadData();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
});

app.use(express.json({ limit: '5mb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
io.engine.use(sessionMiddleware);

function persist() {
  data = saveData(data);
}

function findUserById(userId) {
  return data.users.find(u => u.id === userId);
}

function findUserByUsername(username) {
  return data.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
}

function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return findUserById(req.session.userId) || null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  if (user.banned) return res.status(403).json({ error: 'This account is banned.' });
  req.user = user;
  next();
}

function requireModerator(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  if (user.banned) return res.status(403).json({ error: 'This account is banned.' });
  if (user.role !== 'moderator') return res.status(403).json({ error: 'Moderator access required.' });
  req.user = user;
  next();
}

function requireAdminKey(req, res, next) {
  const supplied = req.get('x-admin-key') || req.query.adminKey || '';
  if (!ADMIN_KEY || supplied !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Valid ADMIN_KEY required.' });
  }
  next();
}

function safeUsername(username) {
  const clean = String(username || '').trim();
  if (clean.length < 3 || clean.length > 24) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(clean)) return null;
  return clean;
}

function publicUser(user) {
  return stripPrivateUserFields(user);
}

function recentMessages(limit = MESSAGE_HISTORY_LIMIT) {
  return data.messages.slice(-limit).map(publicMessage);
}

function emitStats() {
  io.emit('server:stats', getStats(data));
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, instanceId: INSTANCE_ID, stats: getStats(data), startedAt: process.uptime() });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? publicUser(user) : null, firstAccountAvailable: data.users.length === 0 });
});

app.post('/api/register', async (req, res) => {
  const username = safeUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username) return res.status(400).json({ error: 'Username must be 3-24 characters using letters, numbers, underscore, dot, or dash.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (findUserByUsername(username)) return res.status(409).json({ error: 'That username is already taken.' });

  const firstUser = data.users.length === 0;
  const user = {
    id: id('user'),
    username,
    passwordHash: await bcrypt.hash(password, 12),
    role: firstUser ? 'moderator' : 'member',
    banned: false,
    createdAt: now(),
    updatedAt: now(),
    lastSeenAt: now()
  };
  data.users.push(user);
  persist();
  req.session.userId = user.id;
  res.json({ user: publicUser(user), firstModerator: firstUser });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = findUserByUsername(username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  if (user.banned) return res.status(403).json({ error: 'This account is banned.' });
  user.lastSeenAt = now();
  user.updatedAt = now();
  persist();
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/messages', requireAuth, (req, res) => {
  res.json({ messages: recentMessages(Number(req.query.limit || MESSAGE_HISTORY_LIMIT)) });
});

app.post('/api/messages', requireAuth, (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message cannot be blank.' });
  if (text.length > 2000) return res.status(400).json({ error: 'Message is too long.' });

  const message = {
    id: id('msg'),
    userId: req.user.id,
    username: req.user.username,
    text,
    createdAt: now(),
    updatedAt: now(),
    deleted: false,
    system: false
  };
  data.messages.push(message);
  persist();
  io.emit('message:new', publicMessage(message));
  emitStats();
  res.json({ message: publicMessage(message) });
});

app.get('/api/admin/users', requireModerator, (req, res) => {
  res.json({ users: data.users.map(publicUser) });
});

app.post('/api/admin/users/:id/ban', requireModerator, (req, res) => {
  const target = findUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot ban your own account.' });
  target.banned = !!req.body.banned;
  target.updatedAt = now();
  persist();
  io.emit('user:updated', publicUser(target));
  res.json({ user: publicUser(target) });
});

app.post('/api/admin/users/:id/role', requireModerator, (req, res) => {
  const target = findUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const role = String(req.body.role || '').toLowerCase();
  if (!['member', 'moderator'].includes(role)) return res.status(400).json({ error: 'Role must be member or moderator.' });

  if (target.id === req.user.id && role !== 'moderator') {
    return res.status(400).json({ error: 'You cannot demote yourself.' });
  }

  target.role = role;
  target.updatedAt = now();
  persist();
  io.emit('user:updated', publicUser(target));
  res.json({ user: publicUser(target) });
});

app.delete('/api/admin/messages/:id', requireModerator, (req, res) => {
  const message = data.messages.find(m => m.id === req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found.' });
  message.deleted = true;
  message.deletedAt = now();
  message.deletedBy = req.user.username;
  message.updatedAt = now();
  persist();
  io.emit('message:deleted', publicMessage(message));
  emitStats();
  res.json({ message: publicMessage(message) });
});

app.post('/api/admin/system', requireModerator, (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Announcement cannot be blank.' });
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
  persist();
  io.emit('message:new', publicMessage(message));
  emitStats();
  res.json({ message: publicMessage(message) });
});

app.get('/api/admin/export', requireAdminKey, (req, res) => {
  res.json({ instanceId: INSTANCE_ID, exportedAt: now(), data });
});

app.post('/api/admin/import', requireAdminKey, (req, res) => {
  if (!req.body || !req.body.data) return res.status(400).json({ error: 'Missing data object.' });
  data = mergeData(data, req.body.data);
  saveData(data, { bump: false });
  io.emit('server:sync', { stats: getStats(data) });
  emitStats();
  res.json({ ok: true, stats: getStats(data) });
});

app.post('/api/admin/backup', requireAdminKey, (req, res) => {
  const backupPath = backupData('manual');
  res.json({ ok: true, backupPath });
});

app.post('/api/admin/shutdown', requireAdminKey, (req, res) => {
  const reason = String(req.body && req.body.reason ? req.body.reason : 'Requested by peer or admin.');
  console.log(`[HomeChat] Shutdown requested: ${reason}`);
  res.json({ ok: true, message: 'Server is shutting down.' });
  setTimeout(() => process.exit(0), 400);
});

io.on('connection', socket => {
  const sessionData = socket.request.session;
  const user = sessionData && sessionData.userId ? findUserById(sessionData.userId) : null;
  if (!user || user.banned) {
    socket.emit('auth:required');
    socket.disconnect(true);
    return;
  }

  user.lastSeenAt = now();
  user.updatedAt = now();
  saveData(data);
  socket.emit('messages:history', recentMessages());
  socket.emit('server:stats', getStats(data));
});

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-admin-key': ADMIN_KEY,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function startupHandoff() {
  if (!STARTUP_HANDOFF || !PEER_URL || !ADMIN_KEY) return;
  const localUrl = `http://127.0.0.1:${PORT}`;
  if (PEER_URL === localUrl || PEER_URL.includes(`localhost:${PORT}`) || PEER_URL.includes(`127.0.0.1:${PORT}`)) {
    console.log('[HomeChat] PEER_URL points to this machine. Skipping handoff.');
    return;
  }

  try {
    console.log(`[HomeChat] Startup handoff: checking peer ${PEER_URL}`);
    const exported = await fetchJson(`${PEER_URL}/api/admin/export`, { method: 'GET' });
    if (exported && exported.data) {
      data = mergeData(data, exported.data);
      saveData(data, { bump: false });
      console.log(`[HomeChat] Synced from peer. Users: ${data.users.length}. Messages: ${data.messages.length}.`);
    }

    await fetchJson(`${PEER_URL}/api/admin/shutdown`, {
      method: 'POST',
      body: JSON.stringify({ reason: `Peer handoff to ${INSTANCE_ID}` })
    });
    console.log('[HomeChat] Peer shutdown requested successfully.');
  } catch (error) {
    console.log(`[HomeChat] Peer handoff skipped: ${error.message}`);
  }
}

process.on('SIGTERM', () => {
  console.log('[HomeChat] Received SIGTERM. Exiting cleanly.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[HomeChat] Received SIGINT. Exiting cleanly.');
  process.exit(0);
});

(async () => {
  await startupHandoff();
  server.listen(PORT, HOST, () => {
    console.log(`[HomeChat] Running at http://${HOST}:${PORT}`);
    console.log(`[HomeChat] Instance: ${INSTANCE_ID}`);
    if (PEER_URL) console.log(`[HomeChat] Peer: ${PEER_URL}`);
  });
})();
