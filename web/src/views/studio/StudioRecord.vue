<script setup>
// Запись экрана и/или камеры прямо в браузере (MediaRecorder) с последующей загрузкой как обычного видео.
import { ref, computed, onBeforeUnmount, markRaw } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../../stores/auth.js';
import { useUi } from '../../stores/ui.js';
import { ChunkedUpload } from '../../utils/upload.js';
import { fmtDuration, fmtBytes } from '../../utils/format.js';

const auth = useAuth();
const ui = useUi();
const router = useRouter();
const mode = ref('screen'); // screen | camera | both
const mic = ref(true);
const sysAudio = ref(true);
const camPos = ref('br');
const state = ref('idle'); // idle | ready | countdown | recording | paused | done
const countdown = ref(3);
const elapsed = ref(0);
const size = ref(0);
const blob = ref(null);
const previewUrl = ref('');
const title = ref('');
const upload = ref(null);
const error = ref('');
const preview = ref(null);
const camVideo = ref(null);

let screenStream = null, camStream = null, micStream = null, outStream = null, recorder = null, chunks = [], timer = null, raf = null, audioCtx = null, canvas = null;
const supported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices;
const canScreen = supported && !!navigator.mediaDevices.getDisplayMedia;

function pickMime() {
  const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
async function prepare() {
  error.value = '';
  try {
    stopStreams();
    if (mode.value !== 'camera') screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: sysAudio.value });
    if (mode.value !== 'screen') camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    if (mic.value) { try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { ui.toast('Микрофон недоступен — запись без голоса', { type: 'info' }); } }
    outStream = buildOutput();
    if (preview.value) { preview.value.srcObject = outStream; preview.value.muted = true; preview.value.play().catch(() => {}); }
    if (camVideo.value && camStream) { camVideo.value.srcObject = camStream; camVideo.value.play().catch(() => {}); }
    screenStream?.getVideoTracks()[0]?.addEventListener('ended', () => { if (state.value === 'recording' || state.value === 'paused') stop(); else reset(); });
    state.value = 'ready';
  } catch (e) { error.value = e.name === 'NotAllowedError' ? 'Доступ к экрану/камере не предоставлен' : e.message; stopStreams(); state.value = 'idle'; }
}
/** Собираем итоговый поток: видео (экран, камера или экран+камера через canvas) + смешанный звук. */
function buildOutput() {
  const out = new MediaStream();
  if (mode.value === 'both' && screenStream && camStream) {
    canvas = document.createElement('canvas');
    const sv = document.createElement('video'); sv.srcObject = screenStream; sv.muted = true; sv.play();
    const cv = document.createElement('video'); cv.srcObject = camStream; cv.muted = true; cv.play();
    const st = screenStream.getVideoTracks()[0].getSettings();
    canvas.width = st.width || 1920; canvas.height = st.height || 1080;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      ctx.drawImage(sv, 0, 0, canvas.width, canvas.height);
      const w = Math.round(canvas.width * 0.22), h = Math.round(w * 9 / 16), m = 24;
      const x = camPos.value.endsWith('r') ? canvas.width - w - m : m, y = camPos.value.startsWith('b') ? canvas.height - h - m : m;
      ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 16); ctx.clip(); ctx.drawImage(cv, x, y, w, h); ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.roundRect(x, y, w, h, 16); ctx.stroke();
      raf = requestAnimationFrame(draw);
    };
    draw();
    canvas.captureStream(30).getVideoTracks().forEach((t) => out.addTrack(t));
  } else {
    (mode.value === 'camera' ? camStream : screenStream).getVideoTracks().forEach((t) => out.addTrack(t));
  }
  // Звук: микрофон + системный звук через AudioContext
  const sources = [];
  if (micStream) sources.push(micStream);
  if (screenStream && screenStream.getAudioTracks().length) sources.push(new MediaStream(screenStream.getAudioTracks()));
  if (sources.length === 1) sources[0].getAudioTracks().forEach((t) => out.addTrack(t));
  else if (sources.length > 1) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = audioCtx.createMediaStreamDestination();
    for (const s of sources) audioCtx.createMediaStreamSource(s).connect(dest);
    dest.stream.getAudioTracks().forEach((t) => out.addTrack(t));
  }
  return out;
}
async function start() {
  state.value = 'countdown'; countdown.value = 3;
  await new Promise((r) => { const t = setInterval(() => { countdown.value--; if (countdown.value <= 0) { clearInterval(t); r(); } }, 1000); });
  chunks = []; size.value = 0; elapsed.value = 0;
  recorder = new MediaRecorder(outStream, { mimeType: pickMime() || undefined, videoBitsPerSecond: 6_000_000 });
  recorder.ondataavailable = (e) => { if (e.data.size) { chunks.push(e.data); size.value += e.data.size; } };
  recorder.onstop = finish;
  recorder.start(1000);
  state.value = 'recording';
  timer = setInterval(() => { if (state.value === 'recording') elapsed.value++; }, 1000);
}
function pause() { if (recorder?.state === 'recording') { recorder.pause(); state.value = 'paused'; } }
function resume() { if (recorder?.state === 'paused') { recorder.resume(); state.value = 'recording'; } }
function stop() { clearInterval(timer); if (recorder && recorder.state !== 'inactive') recorder.stop(); else finish(); }
function finish() {
  const type = recorder?.mimeType || 'video/webm';
  blob.value = new Blob(chunks, { type });
  previewUrl.value = URL.createObjectURL(blob.value);
  title.value = title.value || `Запись экрана ${new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`;
  stopStreams();
  state.value = 'done';
}
function stopStreams() {
  cancelAnimationFrame(raf); raf = null;
  for (const s of [screenStream, camStream, micStream]) s?.getTracks().forEach((t) => t.stop());
  screenStream = camStream = micStream = outStream = null;
  audioCtx?.close().catch(() => {}); audioCtx = null;
}
function reset() { stopStreams(); if (previewUrl.value) URL.revokeObjectURL(previewUrl.value); previewUrl.value = ''; blob.value = null; chunks = []; state.value = 'idle'; upload.value = null; elapsed.value = 0; size.value = 0; }
async function send() {
  const ext = blob.value.type.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([blob.value], `${title.value.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'recording'}.${ext}`, { type: blob.value.type });
  const up = new ChunkedUpload(file, { title: title.value, visibility: auth.config?.uploadDefaultVisibility || 'internal' });
  upload.value = { progress: 0, status: 'uploading', error: null, videoId: null, up: markRaw(up) };
  up.onChange = (u) => { upload.value = { ...upload.value, progress: u.progress, status: u.status, error: u.error, videoId: u.videoId }; if (u.status === 'done') { ui.toast('Запись загружена — идёт обработка', { type: 'success' }); router.push(`/studio/videos/${u.videoId}`); } };
  up.start();
}
function download() { const a = document.createElement('a'); a.href = previewUrl.value; a.download = `${title.value || 'recording'}.${blob.value.type.includes('mp4') ? 'mp4' : 'webm'}`; a.click(); }
onBeforeUnmount(() => { clearInterval(timer); stopStreams(); if (previewUrl.value) URL.revokeObjectURL(previewUrl.value); });
const modeLabel = computed(() => ({ screen: 'экран', camera: 'камера', both: 'экран + камера' })[mode.value]);
</script>

<template>
  <div>
    <div class="page-head"><div><h1>Запись экрана</h1><div class="sub">Инструкция, демонстрация программы или короткое обращение — запись делается прямо в браузере и загружается на портал</div></div></div>
    <div v-if="!supported" class="alert warning"><Icon name="alertCircle" :size="20" /> Ваш браузер не поддерживает запись. Используйте актуальные Chrome, Edge или Firefox.</div>
    <div v-else class="rec-layout">
      <div class="panel">
        <div class="rec-stage" :class="{ live: state === 'recording' }">
          <video v-show="state !== 'done'" ref="preview" playsinline muted class="rec-video"></video>
          <video v-if="state === 'done'" :src="previewUrl" controls class="rec-video"></video>
          <video v-show="mode === 'both' && state !== 'done' && state !== 'idle'" ref="camVideo" playsinline muted class="rec-cam" :class="camPos"></video>
          <div v-if="state === 'idle'" class="rec-empty"><Icon :name="mode === 'camera' ? 'webcam' : 'screenShare'" :size="48" /><div class="mt-8">Выберите источник и нажмите «Подготовить»</div><div class="small" style="opacity:.8">Браузер попросит выбрать экран, окно или вкладку</div></div>
          <div v-if="state === 'countdown'" class="rec-count">{{ countdown }}</div>
          <div v-if="state === 'recording' || state === 'paused'" class="rec-badge"><i></i> {{ state === 'paused' ? 'ПАУЗА' : 'ЗАПИСЬ' }} {{ fmtDuration(elapsed) }} · {{ fmtBytes(size) }}</div>
        </div>
        <div class="row wrap mt-16" style="justify-content:center">
          <template v-if="state === 'idle'"><button class="btn primary" @click="prepare"><Icon name="record" :size="18" /> Подготовить</button></template>
          <template v-else-if="state === 'ready'"><button class="btn primary" @click="start"><Icon name="record" :size="18" /> Начать запись</button><button class="btn ghost" @click="reset">Отмена</button></template>
          <template v-else-if="state === 'recording' || state === 'paused'">
            <button v-if="state === 'recording'" class="btn" @click="pause"><Icon name="pause" :size="18" /> Пауза</button><button v-else class="btn" @click="resume"><Icon name="play" :size="18" /> Продолжить</button>
            <button class="btn primary" style="background: var(--danger); border-color: var(--danger)" @click="stop"><Icon name="stop" :size="18" /> Остановить</button>
          </template>
          <template v-else-if="state === 'done' && !upload"><button class="btn primary" @click="send"><Icon name="upload" :size="18" /> Загрузить на портал</button><button class="btn" @click="download"><Icon name="download" :size="18" /> Скачать файл</button><button class="btn ghost" @click="reset">Записать заново</button></template>
          <template v-else-if="upload"><div class="col" style="min-width: 320px"><div class="up-bar"><i :style="{ width: (upload.progress * 100) + '%' }" :class="{ err: upload.status === 'error', done: upload.status === 'done' }"></i></div><div class="small muted mt-4">{{ upload.status === 'error' ? 'Ошибка: ' + upload.error : upload.status === 'done' ? 'Загружено' : `Загрузка ${Math.round(upload.progress * 100)}%` }}</div></div></template>
        </div>
        <div v-if="error" class="alert danger mt-16"><Icon name="alertCircle" :size="18" /> {{ error }}</div>
      </div>
      <div class="col gap-16">
        <div class="panel">
          <h4 class="mb-8">Источник</h4>
          <div class="col gap-8">
            <label class="check" :class="{ disabled: !canScreen }"><input type="radio" v-model="mode" value="screen" :disabled="state !== 'idle' || !canScreen" /> Экран, окно или вкладка</label>
            <label class="check"><input type="radio" v-model="mode" value="camera" :disabled="state !== 'idle'" /> Камера</label>
            <label class="check" :class="{ disabled: !canScreen }"><input type="radio" v-model="mode" value="both" :disabled="state !== 'idle' || !canScreen" /> Экран + камера в углу</label>
          </div>
          <div class="divider"></div>
          <div class="col gap-8">
            <label class="switch"><input type="checkbox" v-model="mic" :disabled="state !== 'idle'" /><span class="track"></span><span>Микрофон (голос)</span></label>
            <label class="switch" v-if="mode !== 'camera'"><input type="checkbox" v-model="sysAudio" :disabled="state !== 'idle'" /><span class="track"></span><span>Системный звук (звук вкладки/экрана)</span></label>
            <div v-if="mode === 'both'" class="field"><label>Положение камеры</label><select class="select" v-model="camPos"><option value="br">Справа внизу</option><option value="bl">Слева внизу</option><option value="tr">Справа вверху</option><option value="tl">Слева вверху</option></select></div>
          </div>
        </div>
        <div v-if="state === 'done'" class="panel">
          <div class="field"><label>Название видео</label><input class="input" v-model="title" maxlength="150" /></div>
          <div class="small muted mt-8">Длительность {{ fmtDuration(elapsed) }} · {{ fmtBytes(size) }} · {{ modeLabel }}. После загрузки видео обработается как обычное: качество, миниатюры, субтитры.</div>
        </div>
        <div class="panel small muted">
          <b>Советы.</b> Для записи вкладки со звуком выберите «Вкладка Chrome» и включите «Поделиться аудио». Запись ведётся локально в браузере и не отправляется на сервер до нажатия «Загрузить». Максимальная длительность ограничена памятью браузера — для длинных записей (более часа) используйте OBS и трансляцию с записью.
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.rec-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
.rec-stage { position: relative; aspect-ratio: 16/9; background: #0b1a2e; border-radius: var(--radius); overflow: hidden; color: #fff; }
.rec-stage.live { box-shadow: 0 0 0 3px var(--danger); }
.rec-video { width: 100%; height: 100%; object-fit: contain; background: #000; }
.rec-cam { position: absolute; width: 22%; aspect-ratio: 16/9; object-fit: cover; border-radius: 12px; border: 2px solid rgba(255,255,255,.8); }
.rec-cam.br { right: 16px; bottom: 16px; } .rec-cam.bl { left: 16px; bottom: 16px; } .rec-cam.tr { right: 16px; top: 16px; } .rec-cam.tl { left: 16px; top: 16px; }
.rec-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; }
.rec-count { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 120px; font-weight: 700; background: rgba(0,0,0,.5); font-family: var(--font-display); }
.rec-badge { position: absolute; left: 12px; top: 12px; display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: rgba(0,0,0,.6); font-size: 13px; font-weight: 500; letter-spacing: .04em; }
.rec-badge i { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: .3; } }
.check.disabled { opacity: .5; }
@media (max-width: 900px) { .rec-layout { grid-template-columns: 1fr; } }
</style>
