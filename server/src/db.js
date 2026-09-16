// Доступ к PostgreSQL: пул соединений, транзакции, LISTEN/NOTIFY.
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

const { Pool } = pg;

// numeric → number, int8 → number (для счётчиков)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// date → строка 'YYYY-MM-DD' (без сдвига часовых поясов)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Ошибка пула PostgreSQL:', err.message);
});

/** Выполнить запрос. */
export async function query(text, params = []) {
  return pool.query(text, params);
}

/** Одна строка или null. */
export async function one(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

/** Массив строк. */
export async function many(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

/** Скалярное значение первой колонки первой строки. */
export async function scalar(text, params = []) {
  const r = await pool.query(text, params);
  if (!r.rows[0]) return null;
  return r.rows[0][r.fields[0].name];
}

/** Транзакция: fn получает клиент с методами query/one/many. */
export async function tx(fn) {
  const client = await pool.connect();
  const api = {
    query: (t, p = []) => client.query(t, p),
    one: async (t, p = []) => (await client.query(t, p)).rows[0] || null,
    many: async (t, p = []) => (await client.query(t, p)).rows,
    client,
  };
  try {
    await client.query('BEGIN');
    const result = await fn(api);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Шина событий на LISTEN/NOTIFY (между API и воркерами). */
export const bus = new EventEmitter();
bus.setMaxListeners(1000);
let listenClient = null;
const CHANNEL = 'corpvideo_events';

export async function startListener() {
  if (listenClient) return;
  const connect = async () => {
    try {
      const client = new pg.Client({ connectionString: config.databaseUrl });
      await client.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== CHANNEL) return;
        try {
          const payload = JSON.parse(msg.payload);
          bus.emit('event', payload);
          if (payload.type) bus.emit(payload.type, payload);
        } catch { /* ignore */ }
      });
      client.on('error', () => {
        listenClient = null;
        setTimeout(connect, 3000);
      });
      await client.query(`LISTEN ${CHANNEL}`);
      listenClient = client;
    } catch (e) {
      console.error('LISTEN недоступен, повтор через 5 c:', e.message);
      setTimeout(connect, 5000);
    }
  };
  await connect();
}

/** Опубликовать событие всем процессам (API/воркеры). Полезная нагрузка — до 8000 байт. */
export async function publish(payload) {
  try {
    const text = JSON.stringify(payload);
    if (text.length > 7900) return;
    await pool.query('SELECT pg_notify($1, $2)', [CHANNEL, text]);
  } catch (e) {
    console.error('publish failed:', e.message);
  }
}

export async function closeDb() {
  try { if (listenClient) await listenClient.end(); } catch { /* ignore */ }
  await pool.end();
}
