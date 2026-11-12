// Клієнт API. Ключі localStorage збережено зі старої версії (token, deviceId, settings, cache, done, answered, theme),
// тож після оновлення ніхто не втрачає сеанс.

export const LS = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватний режим або переповнення */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* ігноруємо */ }
  },
};

export class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.status = status;
    this.code = code || '';
    this.data = data || {};
  }
}

export function deviceId() {
  let id = LS.get('deviceId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    LS.set('deviceId', id);
  }
  return id;
}

export const getToken = () => LS.get('token');
export const setToken = (t) => (t ? LS.set('token', t) : LS.del('token'));

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

// «Сервер прокидається…»: безкоштовний хостинг присипляє сервер, перший запит може йти до хвилини.
let inflight = 0;
let bannerTimer = null;
let bannerEl = null;
function updateBanner() {
  if (inflight > 0 && !bannerTimer && !bannerEl) {
    bannerTimer = setTimeout(() => {
      bannerTimer = null;
      if (inflight <= 0) return;
      bannerEl = document.createElement('div');
      bannerEl.className = 'server-banner';
      bannerEl.setAttribute('role', 'status');
      bannerEl.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Сервер прокидається, зачекайте до хвилини…</span>';
      document.body.appendChild(bannerEl);
    }, 6000);
  }
  if (inflight <= 0) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
  }
}

export async function api(method, path, body, { timeout = 90000 } = {}) {
  const token = getToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  inflight++;
  updateBanner();
  try {
    let res;
    try {
      res = await fetch(path, {
        method,
        cache: 'no-store',
        signal: ctrl.signal,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-Device-Id': deviceId(),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new ApiError('Сервер не відповідає. Спробуйте ще раз за хвилину.', 0, 'timeout');
      throw new ApiError('Немає з’єднання з сервером. Перевірте інтернет.', 0, 'network');
    }
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) {
      const err = new ApiError(data.error || `Помилка сервера (код ${res.status}).`, res.status, data.code, data);
      if (res.status === 401 && token) onUnauthorized(err);
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
    inflight--;
    updateBanner();
  }
}

// Зображення домашнього віддаються лише авторизованим — завантажуємо з токеном і показуємо як blob.
const imageCache = new Map();
export function imageUrl(id) {
  if (!imageCache.has(id)) {
    imageCache.set(id, fetch(`/api/images/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${getToken()}`, 'X-Device-Id': deviceId() },
    }).then((r) => {
      if (!r.ok) throw new Error('Зображення недоступне.');
      return r.blob();
    }).then((b) => URL.createObjectURL(b)).catch((e) => { imageCache.delete(id); throw e; }));
  }
  return imageCache.get(id);
}
export function clearImageCache() {
  for (const p of imageCache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  imageCache.clear();
}
