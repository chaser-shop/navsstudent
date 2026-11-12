// API client: bearer token, Ukrainian error messages, session-expiry hook.
import { FIELD_LABELS } from './labels.js';

const TOKEN_KEY = 't'; // same key as the previous panel, so open sessions survive the upgrade

export const auth = {
  get token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t) { sessionStorage.setItem(TOKEN_KEY, t); },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } },
};

export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

const VALIDATION = {
  missing: 'обов’язкове поле',
  string_too_short: 'надто коротке значення',
  string_too_long: 'надто довге значення',
  string_pattern_mismatch: 'неправильний формат',
  greater_than_equal: 'значення замале',
  less_than_equal: 'значення завелике',
  literal_error: 'недопустиме значення',
  enum: 'недопустиме значення',
  int_parsing: 'має бути цілим числом',
  int_from_float: 'має бути цілим числом',
  float_parsing: 'має бути числом',
  too_short: 'потрібне хоча б одне значення',
  too_long: 'забагато значень',
  string_type: 'має бути текстом',
  json_invalid: 'некоректні дані',
};

const STATUS_TEXT = {
  0: 'Немає з’єднання із сервером. Перевірте мережу й спробуйте ще раз.',
  400: 'Некоректний запит.',
  401: 'Сесія завершилася. Увійдіть знову.',
  403: 'Недостатньо прав для цієї дії.',
  404: 'Не знайдено.',
  409: 'Такий запис уже існує.',
  413: 'Файл завеликий.',
  415: 'Непідтримуваний тип файлу.',
  422: 'Перевірте правильність заповнення полів.',
  429: 'Забагато спроб. Спробуйте пізніше.',
  500: 'Внутрішня помилка сервера. Спробуйте пізніше.',
  502: 'Сервер тимчасово недоступний.',
  503: 'Сервіс тимчасово недоступний. Спробуйте пізніше.',
};

export function errorMessage(status, data) {
  const d = data && data.detail;
  if (typeof d === 'string' && d) return d;
  if (Array.isArray(d) && d.length) {
    return d.slice(0, 3).map((e) => {
      const field = [...(e.loc || [])].reverse().find((x) => typeof x === 'string' && !['body', 'query', 'path'].includes(x));
      return `${FIELD_LABELS[field] || 'Поле'}: ${VALIDATION[e.type] || 'некоректне значення'}`;
    }).join('; ');
  }
  return STATUS_TEXT[status] || `Не вдалося виконати запит (код ${status}).`;
}

let onExpired = () => {};
export const setOnExpired = (fn) => { onExpired = fn; };

export async function api(path, { method = 'GET', json, body, query, signal, auth: withAuth = true } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== '' && v != null && v !== false) qs.set(k, v);
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const headers = {};
  if (withAuth && auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(STATUS_TEXT[0], 0);
  }
  const type = res.headers.get('content-type') || '';
  let data = null;
  try {
    data = type.includes('json') ? await res.json() : res.ok ? await res.blob() : null;
  } catch {
    data = null;
  }
  if (res.status === 401 && withAuth) {
    auth.clear();
    onExpired();
    throw new ApiError(STATUS_TEXT[401], 401, data);
  }
  if (!res.ok) throw new ApiError(errorMessage(res.status, data), res.status, data);
  return data;
}
