require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const ROOT_DIR = __dirname;
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const SERVER_NAME = process.env.SERVER_NAME || "Home Chat";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-me";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true";
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 5000);
const INSTANCE_ID = process.env.INSTANCE_ID || crypto.randomUUID();
const PEER_URL = String(process.env.PEER_URL || "").replace(/\/+$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const HANDOFF_ON_START = String(process.env.HANDOFF_ON_START || "true").toLowerCase() === "true";
const HANDOFF_SHUTDOWN_PEER = String(process.env.HANDOFF_SHUTDOWN_PEER || "true").toLowerCase() === "true";
const HANDOFF_IMPORT_MODE = process.env.HANDOFF_IMPORT_MODE || "newer";
const DATA_FILE = path.resolve(ROOT_DIR, process.env.DATA_FILE || "data/chat-data.json");
const DATA_DIR = path.dirname(DATA_FILE);
const PAUSED_FILE = path.resolve(ROOT_DIR, process.env.PAUSED_FILE || "data/server.paused");

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${INSTANCE_ID}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function defaultData() {
  const time = nowIso();
  return {
    meta: {
      schemaVersion: 2,
      createdAt: time,
      updatedAt: time,
      lastWriter: INSTANCE_ID
    },
    rooms: [
      { id: "general", name: "General" },
      { id: "announcements", name: "Announcements" }
    ],
    users: [],
    messages: []
  };
}

function normalizeData(raw) {
  const base = defaultData();
  const parsed = raw && typeof raw === "object" ? raw : {};

  // Migration support for the first simple-chat release, which used numeric IDs.
  if (!parsed.meta && Array.isArray(parsed.users) && Array.isArray(parsed.messages)) {
    parsed.meta = {
      schemaVersion: 2,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastWriter: "legacy-import"
    };
    parsed.users = parsed.users.map((user) => ({
      ...user,
      id: String(user.id),
      createdAt: user.createdAt || nowIso(),
      updatedAt: user.updatedAt || user.createdAt || nowIso()
    }));
    parsed.messages = parsed.messages.map((message) => ({
      ...message,
      id: String(message.id),
      userId: String(message.userId),
      createdAt: message.createdAt || nowIso(),
      updatedAt: message.updatedAt || message.createdAt || nowIso()
    }));
  }

  parsed.meta ||= base.meta;
  parsed.rooms ||= base.rooms;
  parsed.users ||= [];
  parsed.messages ||= [];

  parsed.rooms = parsed.rooms.length ? parsed.rooms : base.rooms;
  parsed.users = parsed.users.map((user) => ({
    id: String(user.id || createId("user")),
    username: String(user.username || "user").trim(),
    displayName: String(user.displayName || user.username || "User").trim(),
    passwordHash: user.passwordHash || "",
    role: user.role === "moderator" ? "moderator" : "user",
    banned: Boolean(user.banned),
    createdAt: user.createdAt || nowIso(),
    updatedAt: user.updatedAt || user.createdAt || nowIso(),
    lastSeenAt: user.lastSeenAt || null
  }));
  parsed.messages = parsed.messages.map((message) => ({
    id: String(message.id || createId("msg")),
    roomId: message.roomId || "general",
    userId: String(message.userId || "unknown"),
    username: message.username || "unknown",
    displayName: message.displayName || message.username || "Unknown",
    role: message.role === "moderator" ? "moderator" : "user",
    body: String(message.body || ""),
    deleted: Boolean(message.deleted),
    deletedBy: message.deletedBy || null,
    deletedAt: message.deletedAt || null,
    createdAt: message.createdAt || nowIso(),
    updatedAt: message.updatedAt || message.createdAt || nowIso()
  }));
  parsed.meta.schemaVersion = 2;
  parsed.meta.updatedAt ||= nowIso();
  parsed.meta.lastWriter ||= "unknown";
  return parsed;
}

function loadData() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    const initial = defaultData();
    writeJsonAtomic(DATA_FILE, initial);
    return initial;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return normalizeData(parsed);
  } catch (error) {
    const backup = `${DATA_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(DATA_FILE, backup);
    console.error(`Could not read data file. A backup was saved at ${backup}`);
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

let data = loadData();

function touchData() {
  data.meta.updatedAt = nowIso();
  data.meta.lastWriter = INSTANCE_ID;
}

function trimMessages() {
  if (data.messages.length > MAX_MESSAGES) {
    data.messages = data.messages.slice(data.messages.length - MAX_MESSAGES);
  }
}

function saveData() {
  trimMessages();
  writeJsonAtomic(DATA_FILE, data);
}

function backupData(label = "backup") {
  ensureDataDir();
  const backupDir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `chat-data-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, backupFile);
  return backupFile;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    banned: Boolean(user.banned),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastSeenAt: user.lastSeenAt || null
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    roomId: message.roomId,
    userId: message.userId,
    username: message.username,
    displayName: message.displayName,
    role: message.role,
    body: message.deleted ? "" : message.body,
    deleted: Boolean(message.deleted),
    deletedAt: message.deletedAt || null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  };
}

function findUserById(id) {
  return data.users.find((user) => user.id === String(id));
}

function findUserByUsername(username) {
  return data.users.find((user) => user.username.toLowerCase() === String(username || "").toLowerCase());
}

function isModerator(user) {
  return user && user.role === "moderator" && !user.banned;
}

function activeModeratorCount() {
  return data.users.filter((user) => user.role === "moderator" && !user.banned).length;
}

function roomExists(roomId) {
  return data.rooms.some((room) => room.id === roomId);
}

function getRequestUser(req) {
  if (!req.session || !req.session.userId) return null;
  return findUserById(req.session.userId);
}

function requireAuth(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  if (user.banned) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: "This account is banned." });
  }
  user.lastSeenAt = nowIso();
  user.updatedAt = nowIso();
  req.user = user;
  touchData();
  saveData();
  next();
}

function requireModerator(req, res, next) {
  requireAuth(req, res, () => {
    if (!isModerator(req.user)) return res.status(403).json({ error: "Moderator access required." });
    next();
  });
}

function validateUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

function validateDisplayName(displayName) {
  return typeof displayName === "string" && displayName.trim().length >= 2 && displayName.trim().length <= 40;
}

function validatePassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}

function cleanMessageBody(body) {
  if (typeof body !== "string") return "";
  return body.replace(/\r\n/g, "\n").trim().slice(0, 1000);
}

function isAdminKeyValid(req) {
  if (!ADMIN_KEY || ADMIN_KEY.includes("CHANGE_ME")) return false;
  const provided = req.get("x-admin-key") || req.body?.adminKey || "";
  try {
    return crypto.timingSafeEqual(Buffer.from(String(provided)), Buffer.from(String(ADMIN_KEY)));
  } catch {
    return false;
  }
}

function requireAdminKey(req, res, next) {
  if (!isAdminKeyValid(req)) return res.status(401).json({ error: "Valid admin key required." });
  next();
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function shouldImportPeer(peerData) {
  const localUpdated = Date.parse(data.meta?.updatedAt || 0) || 0;
  const peerUpdated = Date.parse(peerData.meta?.updatedAt || 0) || 0;

  if (HANDOFF_IMPORT_MODE === "always") return true;
  if (HANDOFF_IMPORT_MODE === "never") return false;
  if (!data.users.length && !data.messages.length) return true;
  if (peerUpdated > localUpdated) return true;
  if (peerData.messages?.length > data.messages.length && peerUpdated >= localUpdated) return true;
  return false;
}

function importPeerData(peerData, reason = "peer-import") {
  const normalized = normalizeData(peerData);
  const backupFile = backupData(reason);
  data = normalized;
  touchData();
  saveData();
  return backupFile;
}

async function performStartupHandoff() {
  if (!HANDOFF_ON_START || !PEER_URL || !ADMIN_KEY || ADMIN_KEY.includes("CHANGE_ME")) {
    return;
  }

  try {
    log(`Peer handoff enabled. Checking peer at ${PEER_URL} ...`);
    const health = await fetchJsonWithTimeout(`${PEER_URL}/api/health`, {}, 2000);
    log(`Peer is online: ${health.serverName || PEER_URL}`);

    const exported = await fetchJsonWithTimeout(`${PEER_URL}/api/admin/export`, {
      headers: { "x-admin-key": ADMIN_KEY }
    }, 6000);

    if (exported?.data && shouldImportPeer(exported.data)) {
      const backupFile = importPeerData(exported.data, "before-peer-handoff");
      log(`Imported peer data. Local backup created at ${backupFile}`);
    } else {
      log("Local data is already current. No import needed.");
    }

    if (HANDOFF_SHUTDOWN_PEER) {
      await fetchJsonWithTimeout(`${PEER_URL}/api/admin/remote-shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
        body: JSON.stringify({ reason: `${SERVER_NAME} on ${INSTANCE_ID} took over` })
      }, 3000);
      log("Peer shutdown request sent successfully.");
    }
  } catch (error) {
    log(`Peer handoff skipped: ${error.message}`);
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: false,
  maxHttpBufferSize: 1e6
});

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  message: { error: "Too many login or registration attempts. Try again soon." },
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const sessionMiddleware = session({
  name: "homechat.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
app.use(express.static(path.join(ROOT_DIR, "public"), { extensions: ["html"] }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    active: true,
    serverName: SERVER_NAME,
    instanceId: INSTANCE_ID,
    time: nowIso(),
    updatedAt: data.meta.updatedAt,
    users: data.users.length,
    messages: data.messages.length
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    serverName: SERVER_NAME,
    instanceId: INSTANCE_ID,
    peerConfigured: Boolean(PEER_URL),
    peerUrl: PEER_URL || null,
    handoffOnStart: HANDOFF_ON_START,
    shutdownPeerOnStart: HANDOFF_SHUTDOWN_PEER,
    updatedAt: data.meta.updatedAt,
    users: data.users.length,
    messages: data.messages.length,
    rooms: data.rooms
  });
});

app.get("/api/me", (req, res) => {
  const user = getRequestUser(req);
  if (!user || user.banned) return res.json({ user: null, serverName: SERVER_NAME });
  user.lastSeenAt = nowIso();
  user.updatedAt = nowIso();
  touchData();
  saveData();
  res.json({ user: publicUser(user), serverName: SERVER_NAME, instanceId: INSTANCE_ID });
});

app.post("/api/register", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const displayName = String(req.body.displayName || username).trim();
  const password = String(req.body.password || "");

  if (!validateUsername(username)) return res.status(400).json({ error: "Username must be 3-20 characters and use only letters, numbers, or underscores." });
  if (!validateDisplayName(displayName)) return res.status(400).json({ error: "Display name must be 2-40 characters." });
  if (!validatePassword(password)) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (findUserByUsername(username)) return res.status(409).json({ error: "That username is already taken." });

  const firstAccount = data.users.length === 0;
  const passwordHash = await bcrypt.hash(password, 12);
  const time = nowIso();
  const user = {
    id: createId("user"),
    username,
    displayName,
    passwordHash,
    role: firstAccount ? "moderator" : "user",
    banned: false,
    createdAt: time,
    updatedAt: time,
    lastSeenAt: time
  };

  data.users.push(user);
  touchData();
  saveData();
  req.session.userId = user.id;
  res.status(201).json({ user: publicUser(user), firstAccount });
});

app.post("/api/login", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = findUserByUsername(username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "Invalid username or password." });
  if (user.banned) return res.status(403).json({ error: "This account is banned." });
  user.lastSeenAt = nowIso();
  user.updatedAt = nowIso();
  touchData();
  saveData();
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/rooms", requireAuth, (req, res) => {
  res.json({ rooms: data.rooms });
});

app.get("/api/messages/:roomId", requireAuth, (req, res) => {
  const roomId = String(req.params.roomId || "general");
  if (!roomExists(roomId)) return res.status(404).json({ error: "Room not found." });
  const messages = data.messages.filter((message) => message.roomId === roomId).slice(-250).map(publicMessage);
  res.json({ messages });
});

app.post("/api/messages", requireAuth, (req, res) => {
  const roomId = String(req.body.roomId || "general");
  const body = cleanMessageBody(req.body.body);
  if (!roomExists(roomId)) return res.status(404).json({ error: "Room not found." });
  if (!body) return res.status(400).json({ error: "Message cannot be empty." });

  const time = nowIso();
  const message = {
    id: createId("msg"),
    roomId,
    userId: req.user.id,
    username: req.user.username,
    displayName: req.user.displayName,
    role: req.user.role,
    body,
    deleted: false,
    deletedBy: null,
    deletedAt: null,
    createdAt: time,
    updatedAt: time
  };

  data.messages.push(message);
  touchData();
  saveData();
  io.to(roomId).emit("message:new", publicMessage(message));
  res.status(201).json({ message: publicMessage(message) });
});

app.post("/api/messages/:id/delete", requireModerator, (req, res) => {
  const message = data.messages.find((item) => item.id === String(req.params.id));
  if (!message) return res.status(404).json({ error: "Message not found." });
  message.deleted = true;
  message.deletedBy = req.user.id;
  message.deletedAt = nowIso();
  message.updatedAt = nowIso();
  touchData();
  saveData();
  io.to(message.roomId).emit("message:deleted", publicMessage(message));
  res.json({ message: publicMessage(message) });
});

app.get("/api/admin/users", requireModerator, (req, res) => {
  res.json({ users: data.users.map(publicUser) });
});

app.post("/api/admin/users/:id/role", requireModerator, (req, res) => {
  const user = findUserById(req.params.id);
  const role = req.body.role === "moderator" ? "moderator" : "user";
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.id === req.user.id && role !== "moderator") return res.status(400).json({ error: "You cannot demote yourself." });
  user.role = role;
  user.updatedAt = nowIso();
  touchData();
  saveData();
  io.emit("user:updated", publicUser(user));
  res.json({ user: publicUser(user) });
});

app.post("/api/admin/users/:id/ban", requireModerator, (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.id === req.user.id) return res.status(400).json({ error: "You cannot ban yourself." });
  if (user.role === "moderator" && activeModeratorCount() <= 1) return res.status(400).json({ error: "At least one active moderator must remain." });
  user.banned = Boolean(req.body.banned);
  user.updatedAt = nowIso();
  touchData();
  saveData();
  io.emit("user:updated", publicUser(user));
  res.json({ user: publicUser(user) });
});

app.get("/api/admin/export", requireAdminKey, (req, res) => {
  res.json({ ok: true, exportedAt: nowIso(), serverName: SERVER_NAME, instanceId: INSTANCE_ID, data });
});

app.post("/api/admin/import", requireAdminKey, (req, res) => {
  if (!req.body || !req.body.data) return res.status(400).json({ error: "Missing data payload." });
  const backupFile = importPeerData(req.body.data, "before-admin-import");
  io.emit("server:event", { type: "sync", message: "Server data was synchronized by admin command.", at: nowIso() });
  res.json({ ok: true, backupFile, updatedAt: data.meta.updatedAt });
});

app.post("/api/admin/delete-message", requireAdminKey, (req, res) => {
  const id = String(req.body.id || "");
  const message = data.messages.find((item) => item.id === id);
  if (!message) return res.status(404).json({ error: "Message not found." });
  message.deleted = true;
  message.deletedBy = "terminal-admin";
  message.deletedAt = nowIso();
  message.updatedAt = nowIso();
  touchData();
  saveData();
  io.to(message.roomId).emit("message:deleted", publicMessage(message));
  res.json({ ok: true, message: publicMessage(message) });
});

app.post("/api/admin/reset", requireAdminKey, (req, res) => {
  const backupFile = backupData("before-reset");
  data = defaultData();
  saveData();
  io.emit("server:event", { type: "reset", message: "Server was reset. Please create a new first account.", at: nowIso() });
  res.json({ ok: true, backupFile });
});

app.post("/api/admin/remote-shutdown", requireAdminKey, (req, res) => {
  const reason = String(req.body?.reason || "Remote handoff requested").slice(0, 200);
  fs.writeFileSync(PAUSED_FILE, JSON.stringify({ reason, at: nowIso(), by: req.ip }, null, 2));
  io.emit("server:event", { type: "shutdown", message: `This server is stopping: ${reason}`, at: nowIso() });
  res.json({ ok: true, message: "Server is shutting down.", reason });
  log(`Remote shutdown requested: ${reason}`);
  setTimeout(() => process.exit(0), 500);
});

io.on("connection", (socket) => {
  const session = socket.request.session;
  const user = session?.userId ? findUserById(session.userId) : null;
  if (!user || user.banned) {
    socket.disconnect(true);
    return;
  }

  socket.join("general");
  socket.on("room:join", (roomId) => {
    if (!roomExists(roomId)) return;
    socket.rooms.forEach((room) => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join(roomId);
  });

  socket.on("typing", (payload) => {
    const roomId = String(payload?.roomId || "general");
    if (!roomExists(roomId)) return;
    socket.to(roomId).emit("typing", { displayName: user.displayName, roomId });
  });
});

async function main() {
  if (fs.existsSync(PAUSED_FILE) && String(process.env.IGNORE_PAUSED_FILE || "false").toLowerCase() !== "true") {
    const paused = fs.readFileSync(PAUSED_FILE, "utf8");
    log(`Server is paused. Remove ${PAUSED_FILE} or run the terminal menu Start option. Details: ${paused}`);
    process.exit(0);
  }

  await performStartupHandoff();

  server.listen(PORT, HOST, () => {
    log(`${SERVER_NAME} is running at http://${HOST}:${PORT}`);
    log(`Instance ID: ${INSTANCE_ID}`);
    if (PEER_URL) log(`Peer URL: ${PEER_URL}`);
  });
}

process.on("SIGTERM", () => {
  log("Received SIGTERM. Stopping server.");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

process.on("SIGINT", () => {
  log("Received SIGINT. Stopping server.");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
