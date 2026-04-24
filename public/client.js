const state = {
  me: null,
  serverName: "Home Chat",
  rooms: [],
  currentRoomId: "general",
  socket: null,
  typingTimer: null
};

const el = {
  authPanel: document.getElementById("authPanel"),
  authTitle: document.getElementById("authTitle"),
  loginForm: document.getElementById("loginForm"),
  registerForm: document.getElementById("registerForm"),
  authMessage: document.getElementById("authMessage"),
  appShell: document.getElementById("appShell"),
  serverName: document.getElementById("serverName"),
  meLabel: document.getElementById("meLabel"),
  roomList: document.getElementById("roomList"),
  currentRoomName: document.getElementById("currentRoomName"),
  roomHint: document.getElementById("roomHint"),
  serverEvent: document.getElementById("serverEvent"),
  messageList: document.getElementById("messageList"),
  typingLine: document.getElementById("typingLine"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  adminPanel: document.getElementById("adminPanel"),
  userList: document.getElementById("userList"),
  refreshUsersBtn: document.getElementById("refreshUsersBtn"),
  logoutBtn: document.getElementById("logoutBtn")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function formToJson(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setAuthMessage(message, isError = false) {
  el.authMessage.textContent = message || "";
  el.authMessage.classList.toggle("error", Boolean(isError));
}

function showAuth() {
  el.authPanel.classList.remove("hidden");
  el.appShell.classList.add("hidden");
}

function showApp() {
  el.authPanel.classList.add("hidden");
  el.appShell.classList.remove("hidden");
}

function showServerEvent(message, isWarning = false) {
  el.serverEvent.textContent = message || "";
  el.serverEvent.classList.toggle("hidden", !message);
  el.serverEvent.classList.toggle("warning", Boolean(isWarning));
}

function roleBadge(role) {
  return role === "moderator" ? "Moderator" : "User";
}

function renderRoomList() {
  el.roomList.replaceChildren();
  for (const room of state.rooms) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = room.id === state.currentRoomId ? "active" : "";
    button.textContent = room.name;
    button.addEventListener("click", () => selectRoom(room.id));
    el.roomList.append(button);
  }
}

function formatTime(iso) {
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function renderMessage(message) {
  const article = document.createElement("article");
  article.className = `message ${message.userId === state.me?.id ? "mine" : ""} ${message.deleted ? "deleted" : ""}`;
  article.dataset.messageId = message.id;

  const header = document.createElement("div");
  header.className = "message-header";
  header.innerHTML = `<strong></strong><span></span>`;
  header.querySelector("strong").textContent = message.displayName || message.username;
  header.querySelector("span").textContent = `${roleBadge(message.role)} · ${formatTime(message.createdAt)}`;

  const body = document.createElement("p");
  body.textContent = message.deleted ? "Message deleted by moderator." : message.body;

  article.append(header, body);

  if (state.me?.role === "moderator" && !message.deleted) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger small-button";
    button.textContent = "Delete";
    button.addEventListener("click", async () => {
      if (!confirm("Delete this message?")) return;
      try {
        const result = await api(`/api/messages/${message.id}/delete`, { method: "POST" });
        replaceMessage(result.message);
      } catch (error) {
        alert(error.message);
      }
    });
    article.append(button);
  }

  return article;
}

function appendMessage(message) {
  el.messageList.append(renderMessage(message));
  el.messageList.scrollTop = el.messageList.scrollHeight;
}

function replaceMessage(message) {
  const existing = el.messageList.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (existing) existing.replaceWith(renderMessage(message));
}

async function loadMessages() {
  const payload = await api(`/api/messages/${state.currentRoomId}`);
  el.messageList.replaceChildren();
  payload.messages.forEach(appendMessage);
}

async function selectRoom(roomId) {
  state.currentRoomId = roomId;
  const room = state.rooms.find((item) => item.id === roomId);
  el.currentRoomName.textContent = room?.name || roomId;
  el.roomHint.textContent = `Connected to ${state.serverName}.`;
  renderRoomList();
  state.socket?.emit("room:join", roomId);
  await loadMessages();
}

async function loadRooms() {
  const payload = await api("/api/rooms");
  state.rooms = payload.rooms;
  renderRoomList();
}

async function loadUsers() {
  if (state.me?.role !== "moderator") return;
  const payload = await api("/api/admin/users");
  el.userList.replaceChildren();

  for (const user of payload.users) {
    const row = document.createElement("div");
    row.className = "user-row";
    const label = document.createElement("div");
    label.innerHTML = `<strong></strong><span></span>`;
    label.querySelector("strong").textContent = user.displayName;
    label.querySelector("span").textContent = `${user.username} · ${roleBadge(user.role)}${user.banned ? " · banned" : ""}`;

    const controls = document.createElement("div");
    controls.className = "user-controls";

    if (user.id !== state.me.id) {
      const roleButton = document.createElement("button");
      roleButton.type = "button";
      roleButton.className = "secondary small-button";
      roleButton.textContent = user.role === "moderator" ? "Make user" : "Make mod";
      roleButton.addEventListener("click", async () => {
        await api(`/api/admin/users/${user.id}/role`, {
          method: "POST",
          body: JSON.stringify({ role: user.role === "moderator" ? "user" : "moderator" })
        });
        await loadUsers();
      });

      const banButton = document.createElement("button");
      banButton.type = "button";
      banButton.className = user.banned ? "secondary small-button" : "danger small-button";
      banButton.textContent = user.banned ? "Unban" : "Ban";
      banButton.addEventListener("click", async () => {
        await api(`/api/admin/users/${user.id}/ban`, {
          method: "POST",
          body: JSON.stringify({ banned: !user.banned })
        });
        await loadUsers();
      });
      controls.append(roleButton, banButton);
    }

    row.append(label, controls);
    el.userList.append(row);
  }
}

function connectSocket() {
  state.socket = io();
  state.socket.on("message:new", appendMessage);
  state.socket.on("message:deleted", replaceMessage);
  state.socket.on("typing", (payload) => {
    if (payload.roomId !== state.currentRoomId) return;
    el.typingLine.textContent = `${payload.displayName} is typing...`;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => { el.typingLine.textContent = ""; }, 1600);
  });
  state.socket.on("server:event", (payload) => {
    showServerEvent(payload.message || "Server event received.", payload.type === "shutdown" || payload.type === "reset");
  });
}

async function boot() {
  const me = await api("/api/me");
  state.serverName = me.serverName || "Home Chat";
  el.serverName.textContent = state.serverName;
  el.authTitle.textContent = state.serverName;

  if (!me.user) {
    showAuth();
    return;
  }

  state.me = me.user;
  el.meLabel.textContent = `${state.me.displayName} · ${roleBadge(state.me.role)}`;
  el.adminPanel.classList.toggle("hidden", state.me.role !== "moderator");
  showApp();
  await loadRooms();
  await selectRoom(state.currentRoomId);
  await loadUsers();
  connectSocket();
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify(formToJson(el.loginForm)) });
    location.reload();
  } catch (error) {
    setAuthMessage(error.message, true);
  }
});

el.registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/register", { method: "POST", body: JSON.stringify(formToJson(el.registerForm)) });
    if (payload.firstAccount) setAuthMessage("First account created. You are the moderator.");
    location.reload();
  } catch (error) {
    setAuthMessage(error.message, true);
  }
});

el.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = el.messageInput.value;
  el.messageInput.value = "";
  try {
    await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ roomId: state.currentRoomId, body })
    });
  } catch (error) {
    alert(error.message);
    el.messageInput.value = body;
  }
});

el.messageInput.addEventListener("input", () => {
  state.socket?.emit("typing", { roomId: state.currentRoomId });
});

el.refreshUsersBtn.addEventListener("click", loadUsers);
el.logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

boot().catch((error) => {
  setAuthMessage(error.message, true);
  showAuth();
});
