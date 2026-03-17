const messagesEl = document.getElementById('messages');
const chatListEl = document.getElementById('chatList');
const composer = document.getElementById('composer');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('sendBtn');
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menuBtn');
const modelPicker = document.getElementById('modelPicker');
const modelBtn = document.getElementById('modelBtn');
const modelMenu = document.getElementById('modelMenu');
const modelBtnText = document.getElementById('modelBtnText');
const modelOptions = Array.from(document.querySelectorAll('.model-option'));
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const attachmentList = document.getElementById('attachmentList');
const connectionStatusEl = document.getElementById('connectionStatus');
const newChatBtn = document.querySelector('.new-chat');
const welcomeMessageEl = document.getElementById('welcomeMessage');
const DEFAULT_PLACEHOLDER = '무엇이든 물어보세요';
const ADMIN_TYPING_PLACEHOLDER = '생각중...';

let attachments = [];
let isSending = false;
let selectedModel = 'crystal-hi';
let sessionId = null;
let userId = '';
let socket = null;
let reconnectTimer = null;
let userSessions = [];
let isAdminTyping = false;
let typingPreviewEl = null;
const renderedMessageIds = new Set();
const pendingUserMessageCounts = new Map();
const unreadSessionIds = new Set();
const sessionUpdatedAtMap = new Map();

menuBtn?.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

function setConnectionStatus(text, connected) {
  connectionStatusEl.textContent = text;
  connectionStatusEl.style.borderColor = connected ? '#cfe8d2' : '#ececec';
}

function closeModelMenu() {
  modelMenu.hidden = true;
  modelBtn.setAttribute('aria-expanded', 'false');
}

function openModelMenu() {
  modelMenu.hidden = false;
  modelBtn.setAttribute('aria-expanded', 'true');
}

function setModel(option) {
  // Model switching is intentionally locked for user-facing UI.
  modelOptions.forEach((item) => {
    const active = item.dataset.model === 'crystal-hi';
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
  selectedModel = 'crystal-hi';
  modelBtnText.textContent = 'Crystal AI';
}

modelBtn?.addEventListener('click', () => {
  if (modelMenu.hidden) {
    openModelMenu();
  } else {
    closeModelMenu();
  }
});

modelOptions.forEach((option) => {
  option.addEventListener('click', () => {
    setModel(option);
    closeModelMenu();
  });
});

document.addEventListener('click', (e) => {
  if (!modelPicker?.contains(e.target)) {
    closeModelMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModelMenu();
  }
});

function autoResize() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 220)}px`;
  const isMultiline = promptEl.value.includes('\n') || promptEl.scrollHeight > 42;
  const hasAttachments = attachments.length > 0;
  composer.classList.toggle('composer-multiline', isMultiline || hasAttachments);
}

function updateSendState() {
  const hasMessage = promptEl.value.trim().length > 0;
  const hasFiles = attachments.length > 0;
  const canSend = hasMessage || hasFiles;
  promptEl.disabled = isAdminTyping;
  attachBtn.disabled = isAdminTyping;
  promptEl.placeholder = isAdminTyping ? ADMIN_TYPING_PLACEHOLDER : DEFAULT_PLACEHOLDER;
  sendBtn.classList.toggle('stop-mode', isAdminTyping);
  sendBtn.disabled = isSending || isAdminTyping || !canSend;
  sendBtn.textContent = isSending ? '…' : isAdminTyping ? '■' : '↑';
}

promptEl.addEventListener('input', () => {
  autoResize();
  updateSendState();
});

promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

function buildMessageText(message) {
  const fileNames = Array.isArray(message.files)
    ? message.files
        .filter((f) => !String(f.type || '').startsWith('image/'))
        .map((f) => f.name)
        .filter(Boolean)
    : [];
  const parts = [];
  if (message.text) parts.push(message.text);
  if (fileNames.length) parts.push(fileNames.join(', '));
  return parts.join('\n');
}

function isImageFile(file) {
  return String(file?.type || '').startsWith('image/');
}

function buildMessageKey(text, files = []) {
  const names = (files || []).map((f) => f?.name || '').join('|');
  return `${text || ''}::${names}`;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

async function prepareFilesForPayload(rawFiles) {
  const prepared = [];
  for (const file of rawFiles) {
    const base = {
      name: file.name,
      size: file.size,
      type: file.type || 'unknown'
    };
    if (isImageFile(file)) {
      prepared.push({ ...base, dataUrl: await readFileAsDataURL(file) });
    } else {
      prepared.push(base);
    }
  }
  return prepared;
}

function scrollMessagesToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}

function scrollMessagesToBottomSafe() {
  scrollMessagesToBottom();
  requestAnimationFrame(scrollMessagesToBottom);
  setTimeout(scrollMessagesToBottom, 0);
  setTimeout(scrollMessagesToBottom, 120);
}

function updateWelcomeVisibility() {
  const hasBubble = messagesEl.querySelector('.bubble');
  if (welcomeMessageEl) {
    welcomeMessageEl.style.display = hasBubble ? 'none' : 'block';
  }
}

function addBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  if (text) {
    const textEl = document.createElement('div');
    textEl.className = 'bubble-text';
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }
  messagesEl.appendChild(bubble);
  if (role === 'user') {
    requestAnimationFrame(() => {
      const styles = getComputedStyle(bubble);
      const lineHeight = parseFloat(styles.lineHeight) || 24;
      const paddingTop = parseFloat(styles.paddingTop) || 0;
      const paddingBottom = parseFloat(styles.paddingBottom) || 0;
      const contentHeight = Math.max(0, bubble.scrollHeight - paddingTop - paddingBottom);
      const visualLineCount = Math.round(contentHeight / lineHeight);
      const isMultiline = text.includes('\n') || visualLineCount > 1;
      bubble.classList.toggle('multiline', isMultiline);
    });
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateWelcomeVisibility();
  return bubble;
}

function appendFilesToBubble(bubble, files = []) {
  if (!Array.isArray(files) || files.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'bubble-files';
  files.forEach((file) => {
    if (isImageFile(file) && file.dataUrl) {
      const img = document.createElement('img');
      img.className = 'bubble-image';
      img.alt = file.name || 'image';
      img.src = file.dataUrl;
      wrap.appendChild(img);
      return;
    }
    const chip = document.createElement('span');
    chip.className = 'bubble-file-chip';
    chip.textContent = file.name || 'file';
    wrap.appendChild(chip);
  });
  bubble.appendChild(wrap);
}

function renderMessage(message) {
  if (!message?.id || renderedMessageIds.has(message.id)) return;
  const text = buildMessageText(message);
  const files = Array.isArray(message.files) ? message.files : [];
  if (!text && files.length === 0) return;
  const role = message.role === 'user' ? 'user' : 'assistant';
  if (role === 'user') {
    const key = buildMessageKey(message.text || '', files);
    const pendingCount = pendingUserMessageCounts.get(key) || 0;
    if (pendingCount > 0) {
      pendingUserMessageCounts.set(key, pendingCount - 1);
      renderedMessageIds.add(message.id);
      return;
    }
  }
  if (role === 'assistant') {
    clearTypingPreview();
  }
  const bubble = addBubble(role, text);
  appendFilesToBubble(bubble, files);
  renderedMessageIds.add(message.id);
  if (role === 'assistant') {
    scrollMessagesToBottomSafe();
  }
}

function clearTypingPreview() {
  if (typingPreviewEl) {
    typingPreviewEl.remove();
    typingPreviewEl = null;
  }
}

function renderTypingPreview(text) {
  if (!typingPreviewEl) {
    typingPreviewEl = document.createElement('div');
    typingPreviewEl.className = 'bubble assistant typing-preview';
    messagesEl.appendChild(typingPreviewEl);
  }
  typingPreviewEl.textContent = text || '';
  updateWelcomeVisibility();
  scrollMessagesToBottomSafe();
}

function resetChatView() {
  messagesEl.querySelectorAll('.bubble').forEach((bubble) => bubble.remove());
  renderedMessageIds.clear();
  pendingUserMessageCounts.clear();
  updateWelcomeVisibility();
}

function renderAttachments() {
  attachmentList.innerHTML = '';
  attachmentList.classList.toggle('has-items', attachments.length > 0);
  attachments.forEach((file, index) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = file.name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'attachment-remove';
    removeBtn.setAttribute('aria-label', `${file.name} 삭제`);
    removeBtn.dataset.index = String(index);
    removeBtn.textContent = '×';
    chip.appendChild(name);
    chip.appendChild(removeBtn);
    attachmentList.appendChild(chip);
  });
  autoResize();
}

attachmentList?.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.classList.contains('attachment-remove')) return;
  const index = Number(target.dataset.index);
  if (Number.isNaN(index)) return;
  attachments = attachments.filter((_, i) => i !== index);
  if (attachments.length === 0) {
    fileInput.value = '';
  }
  renderAttachments();
  updateSendState();
});

function renderChatList() {
  chatListEl.innerHTML = '';
  userSessions.forEach((chat) => {
    const item = document.createElement('button');
    item.className = `chat-item ${chat.id === sessionId ? 'active' : ''}`;
    const title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = chat.title || '새 채팅';
    item.appendChild(title);

    const showUnread = unreadSessionIds.has(chat.id) && chat.id !== sessionId;
    if (showUnread) {
      const dot = document.createElement('span');
      dot.className = 'chat-unread-dot';
      item.appendChild(dot);
    }

    item.addEventListener('click', async () => {
      if (chat.id === sessionId) return;
      sessionId = chat.id;
      unreadSessionIds.delete(chat.id);
      setCookie('crystal_hi_session', sessionId, 30);
      isAdminTyping = false;
      clearTypingPreview();
      resetChatView();
      renderChatList();
      await loadMessages();
      connectWebSocket();
      updateSendState();
    });
    chatListEl.appendChild(item);
  });
  updateNewChatButtonState();
}

attachBtn?.addEventListener('click', () => {
  fileInput?.click();
});

fileInput?.addEventListener('change', () => {
  const selected = Array.from(fileInput.files || []);
  attachments = selected;
  renderAttachments();
  updateSendState();
});

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

async function ensureSession(reset = false) {
  const storedId = !reset ? getCookie('crystal_hi_session') : null;
  const data = await requestJson('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: storedId, userId })
  });
  sessionId = data.sessionId;
  setCookie('crystal_hi_session', sessionId, 30);
  await loadUserSessions();
  renderChatList();
}

async function loadMessages() {
  if (!sessionId) return;
  const data = await requestJson(`/api/messages?sessionId=${encodeURIComponent(sessionId)}`);
  (data.messages || []).forEach(renderMessage);
  scrollMessagesToBottomSafe();
}

async function loadUserSessions() {
  if (!userId) return;
  const data = await requestJson(`/api/user/sessions?userId=${encodeURIComponent(userId)}`);
  const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
  const nextIds = new Set(nextSessions.map((s) => s.id));

  nextSessions.forEach((session) => {
    const prevUpdatedAt = sessionUpdatedAtMap.get(session.id);
    if (prevUpdatedAt && prevUpdatedAt !== session.updatedAt && session.id !== sessionId) {
      unreadSessionIds.add(session.id);
    }
    if (!prevUpdatedAt && session.id !== sessionId) {
      unreadSessionIds.add(session.id);
    }
    sessionUpdatedAtMap.set(session.id, session.updatedAt || '');
  });

  Array.from(sessionUpdatedAtMap.keys()).forEach((id) => {
    if (!nextIds.has(id)) {
      sessionUpdatedAtMap.delete(id);
      unreadSessionIds.delete(id);
    }
  });

  userSessions = nextSessions;
  renderChatList();
}

function updateNewChatButtonState() {
  if (!newChatBtn) return;
  const hasEmptyNewChat = userSessions.some((chat) => (chat.title || '').trim() === '새 채팅');
  newChatBtn.disabled = hasEmptyNewChat;
}

function getCookie(name) {
  const target = `${name}=`;
  const cookies = document.cookie ? document.cookie.split('; ') : [];
  for (const cookie of cookies) {
    if (cookie.startsWith(target)) {
      return decodeURIComponent(cookie.slice(target.length));
    }
  }
  return '';
}

function setCookie(name, value, days) {
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; samesite=lax`;
}

function ensureUserId() {
  const existing = getCookie('crystal_hi_user');
  if (existing) {
    userId = existing;
    return;
  }
  userId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  setCookie('crystal_hi_user', userId, 365);
}

function connectWebSocket() {
  if (!sessionId || !userId) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(
    `${protocol}://${window.location.host}/ws?role=user&sessionId=${encodeURIComponent(sessionId)}&userId=${encodeURIComponent(userId)}`
  );

  socket.onopen = () => {
    setConnectionStatus('연결됨', true);
  };

  socket.onmessage = async (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'message' && payload.sessionId === sessionId) {
        renderMessage(payload.message);
        scrollMessagesToBottomSafe();
      }
      if (payload.type === 'admin_typing' && payload.sessionId === sessionId) {
        isAdminTyping = !!payload.isTyping;
        if (isAdminTyping) {
          renderTypingPreview(payload.text || '');
        } else {
          clearTypingPreview();
        }
        updateSendState();
      }
      if (payload.type === 'user_sessions_updated') {
        const nextSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        const nextIds = new Set(nextSessions.map((s) => s.id));

        nextSessions.forEach((session) => {
          const prevUpdatedAt = sessionUpdatedAtMap.get(session.id);
          if (prevUpdatedAt && prevUpdatedAt !== session.updatedAt && session.id !== sessionId) {
            unreadSessionIds.add(session.id);
          }
          if (!prevUpdatedAt && session.id !== sessionId) {
            unreadSessionIds.add(session.id);
          }
          sessionUpdatedAtMap.set(session.id, session.updatedAt || '');
        });

        Array.from(sessionUpdatedAtMap.keys()).forEach((id) => {
          if (!nextIds.has(id)) {
            sessionUpdatedAtMap.delete(id);
            unreadSessionIds.delete(id);
          }
        });

        userSessions = nextSessions;
        renderChatList();
      }
      if (payload.type === 'connected') {
        await loadMessages();
        await loadUserSessions();
      }
    } catch {
      // ignore malformed payload
    }
  };

  socket.onclose = () => {
    setConnectionStatus('연결 끊김', false);
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, 1500);
  };

  socket.onerror = () => {
    setConnectionStatus('연결 불안정', false);
  };
}

newChatBtn?.addEventListener('click', async () => {
  if (newChatBtn.disabled) return;
  try {
    await ensureSession(true);
    isAdminTyping = false;
    clearTypingPreview();
    resetChatView();
    await loadMessages();
    connectWebSocket();
    setConnectionStatus('연결됨', true);
    updateSendState();
  } catch {
    setConnectionStatus('연결 실패', false);
  }
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();

  const message = promptEl.value.trim();
  const rawFiles = attachments.slice();
  if (!message && rawFiles.length === 0) return;

  let files = [];
  try {
    files = await prepareFilesForPayload(rawFiles);
  } catch {
    addBubble('assistant', '파일을 읽는 중 오류가 발생했습니다.');
    return;
  }

  const optimisticText = [message, files.filter((f) => !isImageFile(f)).map((f) => f.name).join(', ')]
    .filter((item) => item && item.trim().length > 0)
    .join('\n');
  if (optimisticText || files.length > 0) {
    const bubble = addBubble('user', optimisticText);
    appendFilesToBubble(bubble, files);
    const key = buildMessageKey(message, files);
    const pendingCount = pendingUserMessageCounts.get(key) || 0;
    pendingUserMessageCounts.set(key, pendingCount + 1);
  }

  isSending = true;
  updateSendState();

  try {
    await requestJson('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message, model: selectedModel, files })
    });
    promptEl.value = '';
    fileInput.value = '';
    attachments = [];
    renderAttachments();
    autoResize();
    await loadMessages();
    await loadUserSessions();
    setConnectionStatus('연결됨', true);
  } catch {
    addBubble('assistant', '메시지 전송에 실패했습니다.');
    setConnectionStatus('연결 끊김', false);
  } finally {
    isSending = false;
    updateSendState();
  }
});

async function init() {
  try {
    ensureUserId();
    if (modelOptions.length > 0) {
      setModel(modelOptions.find((item) => item.classList.contains('active')) || modelOptions[0]);
    }
    await ensureSession();
    await loadMessages();
    connectWebSocket();
    setConnectionStatus('연결됨', true);
  } catch {
    setConnectionStatus('연결 실패', false);
  }
  autoResize();
  updateSendState();
  updateWelcomeVisibility();
  scrollMessagesToBottomSafe();
  window.addEventListener('load', scrollMessagesToBottomSafe);
}

init();
