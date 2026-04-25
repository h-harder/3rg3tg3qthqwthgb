const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'chat-data.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function now() {
  return new Date().toISOString();
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function emptyData() {
  return {
    meta: {
      createdAt: now(),
      updatedAt: now(),
      sequence: 0,
      lastMergeAt: null
    },
    users: [],
    messages: []
  };
}

function normalizeData(data) {
  const normalized = data && typeof data === 'object' ? data : emptyData();
  normalized.meta = normalized.meta && typeof normalized.meta === 'object' ? normalized.meta : {};
  normalized.meta.createdAt = normalized.meta.createdAt || now();
  normalized.meta.updatedAt = normalized.meta.updatedAt || now();
  normalized.meta.sequence = Number(normalized.meta.sequence || 0);
  normalized.meta.lastMergeAt = normalized.meta.lastMergeAt || null;
  normalized.users = Array.isArray(normalized.users) ? normalized.users : [];
  normalized.messages = Array.isArray(normalized.messages) ? normalized.messages : [];
  return normalized;
}

function loadData() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    const data = emptyData();
    saveData(data, { bump: false });
    return data;
  }

  try {
    return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (error) {
    const backup = backupData(`corrupt-${Date.now()}`);
    const data = emptyData();
    saveData(data, { bump: false });
    throw new Error(`Data file was corrupt. A backup was created at ${backup}. A new empty data file was created.`);
  }
}

function saveData(data, options = {}) {
  ensureDataDir();
  const normalized = normalizeData(data);
  if (options.bump !== false) {
    normalized.meta.sequence = Number(normalized.meta.sequence || 0) + 1;
    normalized.meta.updatedAt = now();
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function backupData(label = 'backup') {
  ensureDataDir();
  const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]/g, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `chat-data-${safeLabel}-${stamp}.json`);

  if (fs.existsSync(DATA_FILE)) {
    fs.copyFileSync(DATA_FILE, backupPath);
  } else {
    fs.writeFileSync(backupPath, JSON.stringify(emptyData(), null, 2));
  }
  return backupPath;
}

function resetData() {
  const backupPath = backupData('before-reset');
  const data = emptyData();
  saveData(data, { bump: false });
  return { data, backupPath };
}

function stripPrivateUserFields(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    banned: !!user.banned,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt || null
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    userId: message.userId,
    username: message.username,
    text: message.deleted ? '[message deleted]' : message.text,
    createdAt: message.createdAt,
    deleted: !!message.deleted,
    deletedAt: message.deletedAt || null,
    deletedBy: message.deletedBy || null,
    system: !!message.system
  };
}

function isNewer(a, b) {
  const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
  return at >= bt;
}

function mergeById(localItems, remoteItems) {
  const map = new Map();
  for (const item of localItems || []) {
    if (item && item.id) map.set(item.id, item);
  }
  for (const item of remoteItems || []) {
    if (!item || !item.id) continue;
    const existing = map.get(item.id);
    if (!existing || isNewer(item, existing)) {
      map.set(item.id, item);
    }
  }
  return [...map.values()];
}

function mergeData(localData, remoteData) {
  const local = normalizeData(localData);
  const remote = normalizeData(remoteData);

  const merged = {
    meta: {
      createdAt: local.meta.createdAt || remote.meta.createdAt || now(),
      updatedAt: now(),
      sequence: Math.max(Number(local.meta.sequence || 0), Number(remote.meta.sequence || 0)) + 1,
      lastMergeAt: now(),
      lastRemoteUpdatedAt: remote.meta.updatedAt || null,
      lastRemoteSequence: remote.meta.sequence || 0
    },
    users: mergeById(local.users, remote.users),
    messages: mergeById(local.messages, remote.messages)
  };

  merged.users.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  merged.messages.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return merged;
}

function getStats(data = loadData()) {
  const normalized = normalizeData(data);
  return {
    users: normalized.users.length,
    moderators: normalized.users.filter(u => u.role === 'moderator').length,
    bannedUsers: normalized.users.filter(u => u.banned).length,
    messages: normalized.messages.length,
    deletedMessages: normalized.messages.filter(m => m.deleted).length,
    updatedAt: normalized.meta.updatedAt,
    sequence: normalized.meta.sequence
  };
}

module.exports = {
  DATA_DIR,
  DATA_FILE,
  BACKUP_DIR,
  now,
  id,
  emptyData,
  normalizeData,
  loadData,
  saveData,
  backupData,
  resetData,
  stripPrivateUserFields,
  publicMessage,
  mergeData,
  getStats
};
