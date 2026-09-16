// Клиент API: JSON-запросы, обработка ошибок, загрузка файлов.
export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function handle(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const message = data?.error || data?.message || `Ошибка ${res.status}`;
    throw new ApiError(res.status, message, data);
  }
  return data;
}

export async function api(method, url, body, { signal, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, signal, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  return handle(res);
}

export const get = (url, opts) => api('GET', url, undefined, opts);
export const post = (url, body, opts) => api('POST', url, body, opts);
export const patch = (url, body, opts) => api('PATCH', url, body, opts);
export const put = (url, body, opts) => api('PUT', url, body, opts);
export const del = (url, opts) => api('DELETE', url, undefined, opts);

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Загрузка файла с прогрессом (XHR, т.к. fetch не даёт прогресс отправки). */
export function uploadFile(url, file, { fieldName = 'file', fields = {}, onProgress, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append(fieldName, file);
    xhr.open(method, url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error || `Ошибка ${xhr.status}`, data));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Сетевая ошибка'));
    xhr.send(form);
  });
}
