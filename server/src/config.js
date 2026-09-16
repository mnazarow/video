// Конфигурация сервера: переменные окружения (.env) с разумными значениями по умолчанию.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Загружаем .env: сначала из переменной ENV_FILE, затем из корня server/, затем из /etc/corpvideo/corpvideo.env
for (const candidate of [process.env.ENV_FILE, path.join(ROOT, '.env'), path.join(ROOT, '..', '.env'), '/etc/corpvideo/corpvideo.env']) {
  if (candidate && fs.existsSync(candidate)) {
    try {
      const parsed = parseEnv(fs.readFileSync(candidate, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
    } catch { /* ignore */ }
    break;
  }
}

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '').trim(); // комментарий в конце строки (как в docker compose)
    out[key] = val;
  }
  return out;
}

const env = (name, def) => (process.env[name] !== undefined && process.env[name] !== '' ? process.env[name] : def);
const int = (name, def) => { const v = parseInt(env(name, ''), 10); return Number.isFinite(v) ? v : def; };
const bool = (name, def) => { const v = env(name, undefined); if (v === undefined) return def; return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()); };

const dataDir = env('DATA_DIR', process.platform === 'linux' && fs.existsSync('/var/lib/corpvideo') ? '/var/lib/corpvideo' : path.join(ROOT, 'data'));

export const config = {
  root: ROOT,
  env: env('NODE_ENV', 'production'),
  isDev: env('NODE_ENV', 'production') !== 'production',
  host: env('HOST', '127.0.0.1'),
  port: int('PORT', 3000),
  baseUrl: env('BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  // Число = сколько ближайших прокси доверять (nginx). true/false и список адресов тоже принимаются.
  trustProxy: (() => {
    const raw = (process.env.TRUST_PROXY ?? '1').trim();
    if (raw === '' || raw === '1' || raw === 'true') return 1;
    if (raw === '0' || raw === 'false') return false;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw; // список адресов/CIDR
  })(),
  logLevel: env('LOG_LEVEL', 'info'),
  secretKey: env('SECRET_KEY', ''),
  databaseUrl: env('DATABASE_URL', 'postgres://corpvideo:corpvideo@127.0.0.1:5432/corpvideo'),
  dbPoolSize: int('DB_POOL_SIZE', 10),
  dataDir,
  mediaDir: env('MEDIA_DIR', path.join(dataDir, 'media')),
  uploadTmpDir: env('UPLOAD_TMP_DIR', path.join(dataDir, 'uploads')),
  liveRecordDir: env('LIVE_RECORD_DIR', path.join(dataDir, 'live')),
  webDist: env('WEB_DIST', path.resolve(ROOT, '..', 'web', 'dist')),
  ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: env('FFPROBE_PATH', 'ffprobe'),
  ffmpegThreads: int('FFMPEG_THREADS', 0),
  workerConcurrency: int('WORKER_CONCURRENCY', Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)))),
  workerId: env('WORKER_ID', `${os.hostname()}-${process.pid}`),
  sessionCookie: env('SESSION_COOKIE', 'cv_session'),
  cookieSecure: bool('COOKIE_SECURE', env('BASE_URL', '').startsWith('https://')),
  importAllowLocal: bool('IMPORT_ALLOW_LOCAL', false), // разрешить импорт по ссылке с localhost/loopback (для тестов)
  mediamtx: {
    apiUrl: env('MEDIAMTX_API_URL', 'http://127.0.0.1:9997'),
    hlsUrl: env('MEDIAMTX_HLS_URL', 'http://127.0.0.1:8888'),
    hookSecret: env('MEDIAMTX_HOOK_SECRET', ''),
    rtmpPublicUrl: env('LIVE_RTMP_URL', ''),   // rtmp://host:1935/live
    srtPublicUrl: env('LIVE_SRT_URL', ''),     // srt://host:8890
    whipPublicUrl: env('LIVE_WHIP_URL', ''),   // https://host/whip
  },
  version: readVersion(),
};

function readVersion() {
  for (const p of [path.join(ROOT, '..', 'VERSION'), path.join(ROOT, 'VERSION')]) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch { /* next */ }
  }
  return '1.0.0';
}

export function assertConfig() {
  const problems = [];
  if (!config.secretKey || config.secretKey.length < 16) problems.push('SECRET_KEY должен быть задан (не короче 16 символов)');
  if (!config.databaseUrl) problems.push('DATABASE_URL не задан');
  if (problems.length) {
    console.error('Ошибка конфигурации:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  for (const d of [config.dataDir, config.mediaDir, config.uploadTmpDir, config.liveRecordDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
