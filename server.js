const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const sessions = new Map();
const wsClients = new Set();
const typingStates = new Map();

function nowIso() {
  return new Date().toISOString();
}

function createSession() {
  const id = crypto.randomUUID();
  const now = nowIso();
  const session = {
    id,
    ownerId: '',
    ip: '',
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  sessions.set(id, session);
  return session;
}

function createSessionFromId(id, createdAt = nowIso()) {
  const session = {
    id,
    ownerId: '',
    ip: '',
    createdAt,
    updatedAt: createdAt,
    messages: []
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  if (!id) return null;
  return sessions.get(id) || null;
}

function sessionLogPath(sessionId) {
  return path.join(LOG_DIR, `${sessionId}.jsonl`);
}

async function appendSessionLog(sessionId, type, payload = {}) {
  if (!sessionId) return;
  const line = JSON.stringify({
    ts: nowIso(),
    type,
    sessionId,
    ...payload
  });
  await fsp.appendFile(sessionLogPath(sessionId), `${line}\n`, 'utf8');
}

function hydrateSessionsFromLogs() {
  const files = fs.readdirSync(LOG_DIR).filter((name) => name.endsWith('.jsonl'));

  files.forEach((fileName) => {
    const sessionId = fileName.slice(0, -6);
    if (!sessionId) return;

    const raw = fs.readFileSync(path.join(LOG_DIR, fileName), 'utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    let session = null;

    lines.forEach((line) => {
      try {
        const entry = JSON.parse(line);
        const entryTs = typeof entry.ts === 'string' ? entry.ts : nowIso();

        if (!session) {
          session = createSessionFromId(sessionId, entryTs);
        }

        if (entry.type === 'session_created') {
          if (typeof entry.ownerId === 'string') {
            session.ownerId = entry.ownerId;
          }
          if (typeof entry.ip === 'string') {
            session.ip = entry.ip;
          }
          if (entryTs < session.createdAt) {
            session.createdAt = entryTs;
          }
          if (entryTs > session.updatedAt) {
            session.updatedAt = entryTs;
          }
        }

        if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
          const msg = entry.message;
          session.messages.push(msg);
          if (msg.createdAt && msg.createdAt > session.updatedAt) {
            session.updatedAt = msg.createdAt;
          } else if (entryTs > session.updatedAt) {
            session.updatedAt = entryTs;
          }
        }
      } catch {
        // ignore malformed log entries
      }
    });

    if (!session) {
      createSessionFromId(sessionId);
    }
  });
}

function pushMessage(session, role, text, meta = {}) {
  const message = {
    id: crypto.randomUUID(),
    role,
    text: text || '',
    createdAt: nowIso(),
    ...meta
  };
  session.messages.push(message);
  session.updatedAt = message.createdAt;
  return message;
}

function sessionTitle(session) {
  const firstUserMessage = session.messages.find((item) => item.role === 'user' && item.text);
  if (!firstUserMessage || !firstUserMessage.text) {
    return '새 채팅';
  }
  return firstUserMessage.text.slice(0, 18);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof forwarded === 'string' && forwarded.trim()) {
    ip = forwarded.split(',')[0].trim();
  } else {
    ip = req.socket?.remoteAddress || '';
  }
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  if (ip === '::1') {
    return '127.0.0.1';
  }
  return ip;
}

function sessionSummaries() {
  return Array.from(sessions.values())
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
    .map((session) => ({
      id: session.id,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      title: sessionTitle(session),
      ip: session.ip || ''
    }));
}

function sendWs(client, payload) {
  if (client.readyState === 1) {
    client.send(JSON.stringify(payload));
  }
}

function broadcast(payload, predicate = null) {
  wsClients.forEach((client) => {
    if (!predicate || predicate(client)) {
      sendWs(client, payload);
    }
  });
}

function notifySessionListUpdated() {
  const sessionsData = sessionSummaries();
  broadcast({ type: 'sessions_updated', sessions: sessionsData }, (client) => client.role === 'admin');
}

function updateTypingState(sessionId, isTyping, text = '') {
  if (!sessionId) return;
  if (!isTyping) {
    typingStates.delete(sessionId);
    return;
  }
  typingStates.set(sessionId, { isTyping: true, text: text || '' });
}

function notifyUserSessionsUpdated(ownerId) {
  if (!ownerId) return;
  const sessionsData = Array.from(sessions.values())
    .filter((session) => session.ownerId === ownerId)
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
    .map((session) => ({
      id: session.id,
      updatedAt: session.updatedAt,
      title: sessionTitle(session)
    }));
  broadcast(
    { type: 'user_sessions_updated', sessions: sessionsData },
    (client) => client.role === 'user' && client.userId === ownerId
  );
}

hydrateSessionsFromLogs();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  ws.role = url.searchParams.get('role') || 'user';
  ws.sessionId = url.searchParams.get('sessionId') || '';
  ws.userId = url.searchParams.get('userId') || '';
  wsClients.add(ws);

  sendWs(ws, { type: 'connected' });

  if (ws.role === 'admin') {
    sendWs(ws, { type: 'sessions_updated', sessions: sessionSummaries() });
  } else if (ws.userId) {
    const sessionsData = Array.from(sessions.values())
      .filter((session) => session.ownerId === ws.userId)
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
      .map((session) => ({
        id: session.id,
        updatedAt: session.updatedAt,
        title: sessionTitle(session)
      }));
    sendWs(ws, { type: 'user_sessions_updated', sessions: sessionsData });
  }
  if (ws.sessionId) {
    const typing = typingStates.get(ws.sessionId);
    if (typing?.isTyping) {
      sendWs(ws, {
        type: 'admin_typing',
        sessionId: ws.sessionId,
        isTyping: true,
        text: typing.text || ''
      });
    }
  }

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

app.post('/api/session', async (req, res) => {
  const { sessionId, userId } = req.body || {};
  const safeUserId = typeof userId === 'string' ? userId : '';
  const clientIp = getClientIp(req);
  const existing = getSession(sessionId);
  if (existing && (!safeUserId || existing.ownerId === safeUserId)) {
    if (clientIp) {
      existing.ip = clientIp;
    }
    return res.json({ sessionId: existing.id });
  }
  const created = createSession();
  created.ownerId = safeUserId;
  created.ip = clientIp;
  await appendSessionLog(created.id, 'session_created', {
    ownerId: created.ownerId,
    ip: created.ip
  });
  notifySessionListUpdated();
  notifyUserSessionsUpdated(safeUserId);
  return res.json({ sessionId: created.id });
});

app.get('/api/user/sessions', (req, res) => {
  const { userId } = req.query || {};
  const safeUserId = typeof userId === 'string' ? userId : '';
  if (!safeUserId) {
    return res.json({ sessions: [] });
  }
  const list = Array.from(sessions.values())
    .filter((session) => session.ownerId === safeUserId)
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
    .map((session) => ({
      id: session.id,
      updatedAt: session.updatedAt,
      title: sessionTitle(session)
    }));
  return res.json({ sessions: list });
});

app.get('/api/messages', (req, res) => {
  const { sessionId } = req.query || {};
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }
  return res.json({ messages: session.messages });
});

app.post('/api/chat', async (req, res) => {
  const { sessionId, message, model, files } = req.body || {};
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }
  const typing = typingStates.get(session.id);
  if (typing?.isTyping) {
    return res.status(423).json({ error: 'admin is typing' });
  }

  const safeMessage = typeof message === 'string' ? message.trim() : '';
  const safeFiles = Array.isArray(files) ? files : [];
  if (!safeMessage && safeFiles.length === 0) {
    return res.status(400).json({ error: 'message or files is required' });
  }

  pushMessage(session, 'user', safeMessage, {
    model: model || 'crystal-hi',
    files: safeFiles
  });
  const userMessageObj = session.messages[session.messages.length - 1];
  await appendSessionLog(session.id, 'message', { message: userMessageObj });
  broadcast(
    { type: 'message', sessionId: session.id, message: userMessageObj },
    (client) => client.role === 'admin' || client.sessionId === session.id
  );
  notifySessionListUpdated();
  notifyUserSessionsUpdated(session.ownerId);

  return res.json({ ok: true });
});

app.get('/api/admin/sessions', (req, res) => {
  return res.json({ sessions: sessionSummaries() });
});

app.post('/api/admin/reply', async (req, res) => {
  const { sessionId, message } = req.body || {};
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'message is required' });
  }
  updateTypingState(session.id, false, '');
  broadcast(
    { type: 'admin_typing', sessionId: session.id, isTyping: false, text: '' },
    (client) => client.role === 'admin' || client.sessionId === session.id
  );
  pushMessage(session, 'assistant', text, { sender: 'human-admin' });
  const messageObj = session.messages[session.messages.length - 1];
  await appendSessionLog(session.id, 'message', { message: messageObj });
  broadcast(
    { type: 'message', sessionId: session.id, message: messageObj },
    (client) => client.role === 'admin' || client.sessionId === session.id
  );
  notifySessionListUpdated();
  notifyUserSessionsUpdated(session.ownerId);
  return res.json({ ok: true });
});

app.post('/api/admin/typing', (req, res) => {
  const { sessionId, text } = req.body || {};
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }
  const safeText = typeof text === 'string' ? text : '';
  const isTyping = safeText.length > 0;
  updateTypingState(session.id, isTyping, safeText);
  broadcast(
    { type: 'admin_typing', sessionId: session.id, isTyping, text: safeText },
    (client) => client.role === 'admin' || client.sessionId === session.id
  );
  return res.json({ ok: true });
});

app.post('/api/user/interrupt', (req, res) => {
  const { sessionId } = req.body || {};
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }
  updateTypingState(session.id, false, '');
  broadcast(
    {
      type: 'admin_typing',
      sessionId: session.id,
      isTyping: false,
      text: '',
      stoppedByUser: true
    },
    (client) => client.role === 'admin' || client.sessionId === session.id
  );
  return res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
