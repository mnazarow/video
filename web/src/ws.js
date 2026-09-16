// WebSocket-клиент с автопереподключением и простой шиной событий.
const listeners = new Map();
let socket = null;
let timer = null;
let attempts = 0;
let joined = new Set();

function emit(type, payload) {
  for (const fn of listeners.get(type) || []) { try { fn(payload); } catch (e) { console.error(e); } }
  for (const fn of listeners.get('*') || []) { try { fn(payload); } catch (e) { console.error(e); } }
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

export function send(msg) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
}

export function join(channel) {
  joined.add(channel);
  send({ type: 'join', channel });
}
export function leave(channel) {
  joined.delete(channel);
  send({ type: 'leave', channel });
}

export function connect() {
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    socket = new WebSocket(`${proto}://${location.host}/ws`);
  } catch { scheduleReconnect(); return; }
  socket.onopen = () => {
    attempts = 0;
    emit('open', {});
    for (const ch of joined) send({ type: 'join', channel: ch });
  };
  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && msg.type) emit(msg.type, msg);
  };
  socket.onclose = () => { emit('close', {}); scheduleReconnect(); };
  socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
}

function scheduleReconnect() {
  clearTimeout(timer);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
  timer = setTimeout(connect, delay);
}

export function reconnect() {
  try { socket?.close(); } catch { /* ignore */ }
  socket = null;
  attempts = 0;
  connect();
}

setInterval(() => send({ type: 'ping' }), 30000);
