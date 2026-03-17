const sessionListEl = document.getElementById('sessionList');
const adminHeaderEl = document.getElementById('adminHeader');
const adminMessagesEl = document.getElementById('adminMessages');
const adminComposer = document.getElementById('adminComposer');
const adminInput = document.getElementById('adminInput');
const wsStateEl = document.getElementById('wsState');

let selectedSessionId = null;
let sessionsCache = [];
let socket = null;
let reconnectTimer = null;
let typingDebounceTimer = null;
let lastTypingSessionId = '';
const unreadSessionIds = new Set();
const sessionUpdatedAtMap = new Map();

//Human Intelligence....

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function setWsState(text) {
  wsStateEl.textContent = text;
}

async function pushTypingState(text = '') {
  if (!selectedSessionId) return;
  const safeText = typeof text === 'string' ? text : '';
  await requestJson('/api/admin/typing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: selectedSessionId, text: safeText })
  });
}

function renderSessionList() {
  sessionListEl.innerHTML = '';

  if (sessionsCache.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = '아직 세션이 없습니다.';
    sessionListEl.appendChild(empty);
    return;
  }

  sessionsCache.forEach((session) => {
    const button = document.createElement('button');
    button.className = `session-item ${session.id === selectedSessionId ? 'active' : ''}`;
    const title = session.title || session.preview || '새 채팅';
    const ip = session.ip || '-';
    const topRow = document.createElement('div');
    topRow.className = 'session-top';
    const idEl = document.createElement('div');
    idEl.className = 'session-id';
    idEl.textContent = session.id.slice(0, 8);
    topRow.appendChild(idEl);
    if (unreadSessionIds.has(session.id) && session.id !== selectedSessionId) {
      const dot = document.createElement('span');
      dot.className = 'session-unread-dot';
      topRow.appendChild(dot);
    }

    const previewEl = document.createElement('div');
    previewEl.className = 'session-preview';
    previewEl.textContent = title;

    const ipEl = document.createElement('div');
    ipEl.className = 'session-ip';
    ipEl.textContent = ip;

    button.appendChild(topRow);
    button.appendChild(previewEl);
    button.appendChild(ipEl);
    button.addEventListener('click', () => {
      if (lastTypingSessionId && lastTypingSessionId !== session.id) {
        pushTypingState('').catch(() => {});
      }
      selectedSessionId = session.id;
      unreadSessionIds.delete(session.id);
      lastTypingSessionId = session.id;
      adminInput.value = '';
      renderSessionList();
      loadMessages();
    });
    sessionListEl.appendChild(button);
  });
}

function renderMessages(messages) {
  adminMessagesEl.innerHTML = '';

  if (messages.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = '메시지가 없습니다.';
    adminMessagesEl.appendChild(empty);
    return;
  }

  messages.forEach((message) => {
    const bubble = document.createElement('div');
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    bubble.className = `admin-bubble ${role}`;
    const files = Array.isArray(message.files) ? message.files : [];
    const nonImageFileNames = files
      .filter((f) => !String(f.type || '').startsWith('image/'))
      .map((f) => f.name)
      .filter(Boolean);
    const text = [message.text, nonImageFileNames.join(', ')].filter(Boolean).join('\n');
    if (text) {
      const textEl = document.createElement('div');
      textEl.textContent = text;
      bubble.appendChild(textEl);
    }

    if (files.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-file-wrap';
      files.forEach((file) => {
        if (String(file.type || '').startsWith('image/') && file.dataUrl) {
          const img = document.createElement('img');
          img.className = 'admin-file-image';
          img.alt = file.name || 'image';
          img.src = file.dataUrl;
          wrap.appendChild(img);
          return;
        }
        const chip = document.createElement('span');
        chip.className = 'admin-file-chip';
        chip.textContent = file.name || 'file';
        wrap.appendChild(chip);
      });
      bubble.appendChild(wrap);
    }

    if (!text && files.length === 0) return;
    adminMessagesEl.appendChild(bubble);
  });

  adminMessagesEl.scrollTop = adminMessagesEl.scrollHeight;
}

async function loadSessions() {
  const data = await requestJson('/api/admin/sessions');
  const nextSessions = data.sessions || [];
  const nextIds = new Set(nextSessions.map((s) => s.id));

  nextSessions.forEach((session) => {
    const prevUpdatedAt = sessionUpdatedAtMap.get(session.id);
    if (prevUpdatedAt && prevUpdatedAt !== session.updatedAt && session.id !== selectedSessionId) {
      unreadSessionIds.add(session.id);
    }
    if (!prevUpdatedAt && session.id !== selectedSessionId) {
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

  sessionsCache = nextSessions;

  if (!selectedSessionId && sessionsCache[0]) {
    selectedSessionId = sessionsCache[0].id;
  }

  if (selectedSessionId && !sessionsCache.some((s) => s.id === selectedSessionId)) {
    selectedSessionId = sessionsCache[0]?.id || null;
  }
  lastTypingSessionId = selectedSessionId || '';

  renderSessionList();
}

async function loadMessages() {
  if (!selectedSessionId) {
    adminHeaderEl.textContent = '세션을 선택하세요';
    renderMessages([]);
    return;
  }

  adminHeaderEl.textContent = `세션 ${selectedSessionId}`;
  const data = await requestJson(`/api/messages?sessionId=${encodeURIComponent(selectedSessionId)}`);
  renderMessages(data.messages || []);
}

function connectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    socket.onclose = null;
    socket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${window.location.host}/ws?role=admin`);

  socket.onopen = () => {
    setWsState('연결됨');
  };

  socket.onmessage = async (event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload.type === 'sessions_updated') {
        const nextSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        const nextIds = new Set(nextSessions.map((s) => s.id));

        nextSessions.forEach((session) => {
          const prevUpdatedAt = sessionUpdatedAtMap.get(session.id);
          if (prevUpdatedAt && prevUpdatedAt !== session.updatedAt && session.id !== selectedSessionId) {
            unreadSessionIds.add(session.id);
          }
          if (!prevUpdatedAt && session.id !== selectedSessionId) {
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

        sessionsCache = nextSessions;

        if (!selectedSessionId && sessionsCache[0]) {
          selectedSessionId = sessionsCache[0].id;
        }

        if (selectedSessionId && !sessionsCache.some((s) => s.id === selectedSessionId)) {
          selectedSessionId = sessionsCache[0]?.id || null;
        }

        renderSessionList();
      }

      if (payload.type === 'message' && payload.sessionId === selectedSessionId) {
        await loadMessages();
      }

      if (
        payload.type === 'admin_typing' &&
        payload.sessionId === selectedSessionId &&
        payload.stoppedByUser
      ) {
        adminInput.value = '';
        setWsState('사용자가 입력 중지를 요청했습니다.');
      }

      if (payload.type === 'connected') {
        await loadSessions();
        await loadMessages();
      }
    } catch {
      // ignore malformed payload
    }
  };

  socket.onclose = () => {
    setWsState('연결 끊김 · 재연결 중');
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, 1500);
  };

  socket.onerror = () => {
    setWsState('연결 오류');
  };
}

adminComposer.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!selectedSessionId) return;

  const message = adminInput.value.trim();
  if (!message) return;

  await pushTypingState('');
  await requestJson('/api/admin/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: selectedSessionId, message })
  });

  adminInput.value = '';
});

adminInput.addEventListener('input', () => {
  if (typingDebounceTimer) {
    clearTimeout(typingDebounceTimer);
    typingDebounceTimer = null;
  }
  const text = adminInput.value;
  pushTypingState(text).catch(() => {});
  typingDebounceTimer = setTimeout(() => {
    if (!adminInput.value.trim()) {
      pushTypingState('').catch(() => {});
    }
  }, 220);
});

adminInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    adminComposer.requestSubmit();
  }
});

async function init() {
  await loadSessions();
  await loadMessages();
  connectWebSocket();
}

init();
