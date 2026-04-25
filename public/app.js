'use strict';

const $ = selector => document.querySelector(selector);
const authPanel = $('#authPanel');
const chatPanel = $('#chatPanel');
const adminPanel = $('#adminPanel');
const statusText = $('#statusText');
const authError = $('#authError');
const messagesEl = $('#messages');
const usersList = $('#usersList');
const userLine = $('#userLine');
const badge = $('#connectionBadge');
const logoutBtn = $('#logoutBtn');
let me = null;
let socket = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
}

function showAuth() {
  authPanel.classList.remove('hidden');
  chatPanel.classList.add('hidden');
  logoutBtn.classList.add('hidden');
  statusText.textContent = 'Create the first account to become the moderator.';
}

function showChat() {
  authPanel.classList.add('hidden');
  chatPanel.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
  userLine.textContent = `${me.displayName} (@${me.username}) · ${me.role}`;
  adminPanel.classList.toggle('hidden', me.role !== 'moderator');
  statusText.textContent = 'Connected to your self-hosted chat server.';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function renderMessage(message) {
  if (!message || message.deleted) return;
  const existing = document.querySelector(`[data-message-id="${message.id}"]`);
  if (existing) return;
  const el = document.createElement('div');
  el.className = 'message';
  el.dataset.messageId = message.id;
  const date = new Date(message.createdAt).toLocaleString();
  const deleteButton = me && me.role === 'moderator'
    ? `<button class="secondary" data-delete-message="${message.id}">Delete</button>`
    : '';
  el.innerHTML = `
    <div class="meta"><strong>${escapeHtml(message.displayName || message.username)}</strong><span>${escapeHtml(date)}</span></div>
    <div class="body">${escapeHtml(message.text)}</div>
    <div style="margin-top:.55rem">${deleteButton}</div>
  `;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadMessages() {
  const { messages } = await api('/api/messages?limit=250');
  messagesEl.innerHTML = '';
  messages.forEach(renderMessage);
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ withCredentials: true });
  socket.on('connect', () => {
    badge.textContent = 'online';
    badge.classList.add('online');
  });
  socket.on('disconnect', () => {
    badge.textContent = 'offline';
    badge.classList.remove('online');
  });
  socket.on('chat:message', renderMessage);
  socket.on('chat:delete', payload => {
    const el = document.querySelector(`[data-message-id="${payload.id}"]`);
    if (el) el.remove();
  });
  socket.on('server:reset', () => location.reload());
  socket.on('server:sync', () => loadMessages().catch(console.error));
}

async function loadUsers() {
  if (!me || me.role !== 'moderator') return;
  const { users } = await api('/api/admin/users');
  usersList.innerHTML = '';
  for (const user of users) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <strong>${escapeHtml(user.displayName)}</strong><br />
      <span class="muted">@${escapeHtml(user.username)} · ${escapeHtml(user.role)}${user.banned ? ' · banned' : ''}</span>
      <div class="actions">
        <button class="secondary" data-role="${user.id}" data-next-role="${user.role === 'moderator' ? 'user' : 'moderator'}">${user.role === 'moderator' ? 'Demote' : 'Promote'}</button>
        <button class="${user.banned ? 'secondary' : 'danger'}" data-ban="${user.id}" data-next-ban="${!user.banned}">${user.banned ? 'Unban' : 'Ban'}</button>
      </div>
    `;
    usersList.appendChild(row);
  }
}

async function boot() {
  try {
    const result = await api('/api/me');
    me = result.user;
    if (!me) return showAuth();
    showChat();
    await loadMessages();
    await loadUsers();
    connectSocket();
  } catch (_) {
    showAuth();
  }
}

$('#loginTab').addEventListener('click', () => {
  $('#loginTab').classList.add('active');
  $('#registerTab').classList.remove('active');
  $('#loginForm').classList.remove('hidden');
  $('#registerForm').classList.add('hidden');
  authError.textContent = '';
});

$('#registerTab').addEventListener('click', () => {
  $('#registerTab').classList.add('active');
  $('#loginTab').classList.remove('active');
  $('#registerForm').classList.remove('hidden');
  $('#loginForm').classList.add('hidden');
  authError.textContent = '';
});

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  authError.textContent = '';
  const data = Object.fromEntries(new FormData(event.target).entries());
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify(data) });
    me = result.user;
    await boot();
  } catch (err) {
    authError.textContent = err.message;
  }
});

$('#registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  authError.textContent = '';
  const data = Object.fromEntries(new FormData(event.target).entries());
  try {
    const result = await api('/api/register', { method: 'POST', body: JSON.stringify(data) });
    me = result.user;
    await boot();
  } catch (err) {
    authError.textContent = err.message;
  }
});

$('#messageForm').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat:send', { text }, response => {
    if (!response || !response.ok) alert(response && response.error ? response.error : 'Message failed.');
  });
  input.value = '';
});

messagesEl.addEventListener('click', async event => {
  const id = event.target && event.target.dataset && event.target.dataset.deleteMessage;
  if (!id) return;
  if (!confirm('Delete this message?')) return;
  try {
    await api('/api/admin/delete-message', { method: 'POST', body: JSON.stringify({ id }) });
  } catch (err) {
    alert(err.message);
  }
});

usersList.addEventListener('click', async event => {
  const btn = event.target;
  try {
    if (btn.dataset.ban) {
      await api('/api/admin/ban-user', { method: 'POST', body: JSON.stringify({ id: btn.dataset.ban, banned: btn.dataset.nextBan === 'true' }) });
      await loadUsers();
    }
    if (btn.dataset.role) {
      await api('/api/admin/role', { method: 'POST', body: JSON.stringify({ id: btn.dataset.role, role: btn.dataset.nextRole }) });
      await loadUsers();
    }
  } catch (err) {
    alert(err.message);
  }
});

$('#refreshAdminBtn').addEventListener('click', () => loadUsers().catch(err => alert(err.message)));
logoutBtn.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

boot();
