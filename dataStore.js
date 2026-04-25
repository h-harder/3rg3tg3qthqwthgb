'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'chat-data.json');
const PID_FILE = path.join(DATA_DIR, 'server.pid');

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function blankData() {
  return {
    version: 1,
    updatedAt: now(),
    users: [],
    messages: [],
    sessions: []
  };
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function atomicWrite(file, obj) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function safeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    banned: !!user.banned,
    createdAt: user.createdAt
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class Store {
  constructor() {
    ensureDir();
    this.data = readJson(DATA_FILE, blankData());
    this.normalize();
    this.save(false);
  }

  normalize() {
    this.data.version = this.data.version || 1;
    this.data.updatedAt = this.data.updatedAt || now();
    this.data.users = Array.isArray(this.data.users) ? this.data.users : [];
    this.data.messages = Array.isArray(this.data.messages) ? this.data.messages : [];
    this.data.sessions = Array.isArray(this.data.sessions) ? this.data.sessions : [];
  }

  reload() {
    this.data = readJson(DATA_FILE, blankData());
    this.normalize();
    return this.data;
  }

  save(touch = true) {
    if (touch) this.data.updatedAt = now();
    atomicWrite(DATA_FILE, this.data);
  }

  exportData() {
    this.reload();
    return JSON.parse(JSON.stringify(this.data));
  }

  replaceData(nextData) {
    const clean = nextData && typeof nextData === 'object' ? nextData : blankData();
    this.data = {
      version: 1,
      updatedAt: clean.updatedAt || now(),
      users: Array.isArray(clean.users) ? clean.users : [],
      messages: Array.isArray(clean.messages) ? clean.messages : [],
      sessions: Array.isArray(clean.sessions) ? clean.sessions : []
    };
    atomicWrite(DATA_FILE, this.data);
  }

  reset() {
    this.data = blankData();
    this.save(false);
  }

  getUpdatedAtMs() {
    this.reload();
    return Date.parse(this.data.updatedAt || '') || 0;
  }

  createUser({ username, displayName, password }) {
    this.reload();
    const uname = normalizeUsername(username);
    if (!uname || uname.length < 3) throw new Error('Username must be at least 3 characters.');
    if (!/^[a-z0-9._-]+$/.test(uname)) throw new Error('Username may only contain letters, numbers, dots, underscores, and hyphens.');
    if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters.');
    if (this.data.users.some(u => u.username === uname)) throw new Error('That username is already taken.');

    const salt = crypto.randomBytes(16).toString('hex');
    const firstAccount = this.data.users.length === 0;
    const user = {
      id: id('usr'),
      username: uname,
      displayName: String(displayName || username || uname).trim().slice(0, 80) || uname,
      salt,
      passwordHash: hashPassword(password, salt),
      role: firstAccount ? 'moderator' : 'user',
      banned: false,
      createdAt: now()
    };
    this.data.users.push(user);
    this.save(true);
    return safeUser(user);
  }

  verifyLogin(username, password) {
    this.reload();
    const uname = normalizeUsername(username);
    const user = this.data.users.find(u => u.username === uname);
    if (!user) return null;
    if (user.banned) throw new Error('This account is banned.');
    const candidate = hashPassword(password, user.salt);
    const ok = crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'));
    return ok ? safeUser(user) : null;
  }

  createSession(userId) {
    this.reload();
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    this.data.sessions = this.data.sessions.filter(s => Date.parse(s.expiresAt) > Date.now());
    this.data.sessions.push({ tokenHash: tokenHash(token), userId, createdAt: now(), expiresAt });
    this.save(true);
    return { token, expiresAt };
  }

  deleteSession(token) {
    if (!token) return;
    this.reload();
    const h = tokenHash(token);
    this.data.sessions = this.data.sessions.filter(s => s.tokenHash !== h);
    this.save(true);
  }

  getUserByToken(token) {
    if (!token) return null;
    this.reload();
    const h = tokenHash(token);
    const session = this.data.sessions.find(s => s.tokenHash === h && Date.parse(s.expiresAt) > Date.now());
    if (!session) return null;
    const user = this.data.users.find(u => u.id === session.userId);
    if (!user || user.banned) return null;
    return safeUser(user);
  }

  listUsers() {
    this.reload();
    return this.data.users.map(safeUser);
  }

  isModerator(userId) {
    this.reload();
    const user = this.data.users.find(u => u.id === userId);
    return !!user && user.role === 'moderator' && !user.banned;
  }

  setUserBan(userId, banned) {
    this.reload();
    const user = this.data.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found.');
    user.banned = !!banned;
    this.save(true);
    return safeUser(user);
  }

  setUserRole(userId, role) {
    this.reload();
    if (!['user', 'moderator'].includes(role)) throw new Error('Invalid role.');
    const user = this.data.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found.');
    user.role = role;
    this.save(true);
    return safeUser(user);
  }

  listMessages(limit = 200, includeDeleted = false) {
    this.reload();
    const messages = includeDeleted ? this.data.messages : this.data.messages.filter(m => !m.deleted);
    return messages.slice(-Math.max(1, Math.min(Number(limit) || 200, 1000)));
  }

  addMessage(user, text) {
    this.reload();
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('Message cannot be empty.');
    if (cleanText.length > 2000) throw new Error('Message is too long.');
    const message = {
      id: id('msg'),
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      text: cleanText,
      createdAt: now(),
      deleted: false
    };
    this.data.messages.push(message);
    this.save(true);
    return message;
  }

  deleteMessage(messageId, deletedBy = 'system') {
    this.reload();
    const message = this.data.messages.find(m => m.id === messageId);
    if (!message) throw new Error('Message not found.');
    message.deleted = true;
    message.deletedAt = now();
    message.deletedBy = deletedBy;
    this.save(true);
    return message;
  }

  writePid() {
    ensureDir();
    fs.writeFileSync(PID_FILE, String(process.pid));
  }

  removePid() {
    try {
      if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(PID_FILE);
      }
    } catch (_) {}
  }
}

module.exports = {
  Store,
  DATA_DIR,
  DATA_FILE,
  PID_FILE,
  blankData,
  now
};
