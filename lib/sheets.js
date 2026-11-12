'use strict';
/*
 * Читання Google-таблиці.
 *  1. Публічний режим (без ключів): CSV через ендпоінт візуалізації Google (gviz) або експорт.
 *     Працює, коли доступ до таблиці відкрито «Усі, хто має посилання — читач».
 *  2. Сервісний акаунт (необов’язково): GOOGLE_SERVICE_ACCOUNT_JSON — для закритих таблиць.
 * Обидва режими лише читають таблицю; сервер нічого в неї не записує.
 */

const crypto = require('crypto');
const { parseCsv } = require('./csv');

class SheetError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // access | unavailable | format | config
  }
}

const sheetUrl = (sheetId, gid) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit#gid=${encodeURIComponent(gid)}`;

async function fetchText(url, timeoutMs, headers = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { Accept: 'text/csv, application/json;q=0.9, */*;q=0.5', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text(), finalUrl: res.url || url };
}

const netReason = (e) => (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'час очікування вичерпано' : 'немає з’єднання');

async function readPublicGrid({ sheetId, gid, timeoutMs = 20000 }) {
  const id = encodeURIComponent(sheetId);
  const g = encodeURIComponent(gid);
  // headers=1: перший рядок — заголовок, тож назви предметів не губляться під час визначення типів колонок.
  const candidates = [
    { endpoint: 'gviz-csv', url: `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&gid=${g}` },
    { endpoint: 'export-csv', url: `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${g}` },
  ];
  const problems = [];
  let closed = false;
  for (const c of candidates) {
    let r;
    try {
      r = await fetchText(c.url, timeoutMs);
    } catch (e) {
      problems.push(`${c.endpoint}: ${netReason(e)}`);
      continue;
    }
    if (r.status === 200 && /text\/csv/i.test(r.type)) {
      return { grid: parseCsv(r.text), mode: 'public', endpoint: c.endpoint };
    }
    if (/accounts\.google\.com|ServiceLogin/i.test(r.finalUrl) || r.status === 401 || r.status === 403) {
      closed = true;
      problems.push(`${c.endpoint}: потрібен вхід у Google`);
    } else {
      problems.push(`${c.endpoint}: відповідь HTTP ${r.status}`);
    }
  }
  if (closed) {
    throw new SheetError('access', 'Google-таблиця закрита для читання без входу. Відкрийте доступ «Усі, хто має посилання — читач» або додайте ключ сервісного акаунта.');
  }
  throw new SheetError('unavailable', `Не вдалося завантажити Google-таблицю (${problems.join('; ')}).`);
}

let tokenCache = { key: '', token: '', expiresAt: 0 };

async function serviceAccountToken(credentialsJson, timeoutMs) {
  let credentials;
  try { credentials = JSON.parse(credentialsJson); } catch {
    throw new SheetError('config', 'GOOGLE_SERVICE_ACCOUNT_JSON має містити коректний JSON-ключ сервісного акаунта.');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new SheetError('config', 'У ключі сервісного акаунта немає client_email або private_key.');
  }
  if (tokenCache.key === credentials.client_email && tokenCache.token && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: tokenUri, iat: now, exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  let res;
  try {
    res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new SheetError('unavailable', `Не вдалося отримати доступ Google (${netReason(e)}).`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new SheetError('access', `Google відхилив ключ сервісного акаунта (код ${res.status}).`);
  tokenCache = { key: credentials.client_email, token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

async function readServiceAccountGrid({ sheetId, gid, credentialsJson, timeoutMs = 20000 }) {
  const token = await serviceAccountToken(credentialsJson, timeoutMs);
  const headers = { Authorization: `Bearer ${token}` };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`;
  let meta;
  try {
    meta = await fetchText(`${base}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`, timeoutMs, headers);
  } catch (e) {
    throw new SheetError('unavailable', `Не вдалося звернутися до Google Таблиць (${netReason(e)}).`);
  }
  if (meta.status !== 200) {
    throw new SheetError(meta.status === 403 || meta.status === 404 ? 'access' : 'unavailable',
      meta.status === 403 ? 'Сервісний акаунт не має доступу до таблиці: поділіться таблицею з його адресою (читач).' : `Google Таблиці відповіли кодом ${meta.status}.`);
  }
  const sheets = (JSON.parse(meta.text).sheets || []).map((x) => x.properties || {});
  const sheet = sheets.find((x) => String(x.sheetId) === String(gid));
  if (!sheet) throw new SheetError('format', `У таблиці немає аркуша з gid=${gid}.`);
  const range = `'${String(sheet.title).replace(/'/g, "''")}'!A:Z`;
  const values = await fetchText(`${base}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, timeoutMs, headers);
  if (values.status !== 200) throw new SheetError('unavailable', `Не вдалося прочитати значення аркуша (код ${values.status}).`);
  return { grid: JSON.parse(values.text).values || [], mode: 'service-account', endpoint: 'sheets-api' };
}

/** Опублікована CSV-адреса («Файл → Поділитися → Опублікувати в інтернеті → CSV») або будь-яке CSV-посилання. */
async function readCsvUrl({ url, timeoutMs = 20000 }) {
  let r;
  try {
    r = await fetchText(url, timeoutMs);
  } catch (e) {
    throw new SheetError('unavailable', `Не вдалося завантажити CSV (${netReason(e)}).`);
  }
  if (r.status !== 200) throw new SheetError(r.status === 401 || r.status === 403 ? 'access' : 'unavailable', `CSV-адреса відповіла кодом ${r.status}.`);
  if (/text\/html/i.test(r.type)) throw new SheetError('access', 'За CSV-адресою відкривається сторінка, а не таблиця. Перевірте, що таблицю опубліковано у форматі CSV.');
  return { grid: parseCsv(r.text), mode: 'csv-url', endpoint: 'csv-url' };
}

/** Читає таблицю найкращим доступним способом. */
function readSheetGrid({ sheetId, gid, credentialsJson, csvUrl, timeoutMs }) {
  if (csvUrl) return readCsvUrl({ url: csvUrl, timeoutMs });
  if (!sheetId) throw new SheetError('config', 'Не вказано ідентифікатор Google-таблиці (GOOGLE_SHEET_ID).');
  return credentialsJson
    ? readServiceAccountGrid({ sheetId, gid, credentialsJson, timeoutMs })
    : readPublicGrid({ sheetId, gid, timeoutMs });
}

const gridHash = (grid) => crypto.createHash('sha256').update(JSON.stringify(grid)).digest('hex');

module.exports = { readSheetGrid, readPublicGrid, gridHash, sheetUrl, SheetError };
