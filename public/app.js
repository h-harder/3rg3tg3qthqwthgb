const $ = selector => document.querySelector(selector);
const authCard = $('#authCard');
const chatCard = $('#chatCard');
const adminCard = $('#adminCard');
const meBox = $('#meBox');
const messagesBox = $('#messages');
const usersBox = $('#users');
const authError = $('#authError');
const firstAccountNote = $('#firstAccountNote');
const authTitle = $('#authTitle');
const authSubmit = $('#authSubmit');
const toggleAuth = $('#toggleAuth');
const stats = $('#stats');

let mode = 'login';
let me = null;
let socket = null;
let messages = new Map();

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function setMode(nextMode) {
  mode = nextMode;
  authTitle.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  authSubmit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  toggleAuth.textContent = mode === 'login' ? 'Create an account instead' : 'Sign in instead';
}

function showAuth(firstAccountAvailable = false) {
  authCard.classList.remove('hidden');
  chatCard.classList.add('hidden');
  adminCard.classList.add('hidden');
  firstAccountNote.classList.toggle('hidden', !firstAccountAvailable);
  if (firstAccountAvailable) setMode('register');
  meBox.innerHTML = '';
}

function showChat() {
  authCard.classList.add('hidden');
  chatCard.classList.remove('hidden');
  adminCard.classList.toggle('hidden', me.role !== 'moderator');
  meBox.innerHTML = `
    <span class="badge ${me.role === 'moderator' ? 'good' : ''}">${escapeHtml(me.username)} · ${escapeHtml(me.role)}</span>
    <button id="logout" class="secondary small">Sign out</button>
  `;
  $('#logout').onclick = logout;
  connectSocket();
  loadMessages();
  if (me.role === 'moderator') loadUsers();
}

function renderMessage(message) {
  const existing = document.querySelector(`[data-message-id="${message.id}"]`);
  const node = existing || document.createElement('div');
  node.className = `message ${message.system ? 'system' : ''} ${message.deleted ? 'deleted' : ''}`;
  node.dataset.messageId = message.id;
  node.innerHTML = `
    <div class="meta"><strong>${escapeHtml(message.username)}</strong><span>${new Date(message.createdAt).toLocaleString()}</span></div>
    <div>${escapeHtml(message.text)}</div>
  `;
  if (!existing) messagesBox.appendChild(node);
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

function renderMessages() {
  messagesBox.innerHTML = '';
  for (const message of [...messages.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
    renderMessage(message);
  }
}

async function loadMessages() {
  const result = await api('/api/messages');
  messages = new Map(result.messages.map(message => [message.id, message]));
  renderMessages();
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ withCredentials: true });
  socket.on('messages:history', history => {
    messages = new Map(history.map(message => [message.id, message]));
    renderMessages();
  });
  socket.on('message:new', message => {
    messages.set(message.id, message);
    renderMessage(message);
  });
  socket.on('message:deleted', message => {
    messages.set(message.id, message);
    renderMessage(message);
  });
  socket.on('server:stats', renderStats);
  socket.on('server:sync', event => renderStats(event.stats));
}

function renderStats(serverStats) {
  if (!serverStats) return;
  stats.textContent = `${serverStats.users} users · ${serverStats.messages} messages · updated ${new Date(serverStats.updatedAt).toLocaleTimeString()}`;
}

async function loadUsers() {
  const result = await api('/api/admin/users');
  usersBox.innerHTML = result.users.map(user => `
    <div class="user-row">
      <div><strong>${escapeHtml(user.username)}</strong> <span class="badge">${escapeHtml(user.role)}</span> ${user.banned ? '<span class="badge">banned</span>' : ''}</div>
      <div class="muted">Created ${new Date(user.createdAt).toLocaleString()}</div>
      <div class="user-actions">
        <button class="small" data-action="role" data-user="${user.id}" data-role="${user.role === 'moderator' ? 'member' : 'moderator'}">${user.role === 'moderator' ? 'Demote' : 'Promote'}</button>
        <button class="small danger" data-action="ban" data-user="${user.id}" data-banned="${!user.banned}">${user.banned ? 'Unban' : 'Ban'}</button>
      </div>
    </div>
  `).join('');

  usersBox.querySelectorAll('button').forEach(button => {
    button.onclick = async () => {
      const userId = button.dataset.user;
      if (button.dataset.action === 'role') {
        await api(`/api/admin/users/${userId}/role`, { method: 'POST', body: JSON.stringify({ role: button.dataset.role }) });
      } else {
        await api(`/api/admin/users/${userId}/ban`, { method: 'POST', body: JSON.stringify({ banned: button.dataset.banned === 'true' }) });
      }
      await loadUsers();
    };
  });
}

async function refreshMe() {
  const result = await api('/api/me');
  me = result.user;
  if (!me) showAuth(result.firstAccountAvailable);
  else showChat();
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  if (socket) socket.disconnect();
  me = null;
  showAuth(false);
}

$('#authForm').onsubmit = async event => {
  event.preventDefault();
  authError.textContent = '';
  try {
    const payload = {
      username: $('#username').value.trim(),
      password: $('#password').value
    };
    const endpoint = mode === 'login' ? '/api/login' : '/api/register';
    const result = await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    me = result.user;
    showChat();
  } catch (error) {
    authError.textContent = error.message;
  }
};

toggleAuth.onclick = () => setMode(mode === 'login' ? 'register' : 'login');

$('#messageForm').onsubmit = async event => {
  event.preventDefault();
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await api('/api/messages', { method: 'POST', body: JSON.stringify({ text }) });
  } catch (error) {
    alert(error.message);
  }
};

$('#announcementForm').onsubmit = async event => {
  event.preventDefault();
  const textarea = $('#announcement');
  const text = textarea.value.trim();
  if (!text) return;
  textarea.value = '';
  try {
    await api('/api/admin/system', { method: 'POST', body: JSON.stringify({ text }) });
  } catch (error) {
    alert(error.message);
  }
};

refreshMe().catch(error => {
  console.error(error);
  showAuth(false);
});
