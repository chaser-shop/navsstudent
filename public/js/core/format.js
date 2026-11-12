// Форматування українською: числа, дати, відносний час, множина.

export const TZ = 'Europe/Kyiv';

export function fmtNum(n, digits = 2) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('uk-UA', { maximumFractionDigits: digits });
}
export const sign = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
export const fmtSigned = (n, digits = 2) => (n == null ? '—' : `${sign(n)}${fmtNum(Math.abs(n), digits)}`);
export const fmtPct = (n) => (n == null ? '—' : `${sign(n)}${fmtNum(Math.abs(n), 1)}%`);

export function plural(n, one, few, many, fraction = few) {
  if (!Number.isInteger(n)) return fraction;
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const pointsWord = (n) => plural(n, 'бал', 'бали', 'балів', 'бала');
export const studentsWord = (n) => plural(n, 'студент', 'студенти', 'студентів');
export const subjectsWord = (n) => plural(n, 'предмет', 'предмети', 'предметів');
export const changesWord = (n) => plural(n, 'зміна', 'зміни', 'змін');
export const placesWord = (n) => plural(n, 'місце', 'місця', 'місць');
export const recordsWord = (n) => plural(n, 'запис', 'записи', 'записів');
export const daysWord = (n) => plural(n, 'день', 'дні', 'днів');
export const pairsWord = (n) => plural(n, 'пара', 'пари', 'пар');

const fmtCache = new Map();
function dtf(opts) {
  const key = JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, ...opts }));
  return fmtCache.get(key);
}
const toDate = (d) => (d instanceof Date ? d : new Date(d));

export const fmtDate = (d) => dtf({ day: 'numeric', month: 'long' }).format(toDate(d));
export const fmtDateYear = (d) => dtf({ day: 'numeric', month: 'long', year: 'numeric' }).format(toDate(d));
export const fmtDateShort = (d) => dtf({ day: '2-digit', month: '2-digit' }).format(toDate(d));
export const fmtTime = (d) => dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(toDate(d));
export const fmtDateTime = (d) => `${fmtDate(d)}, ${fmtTime(d)}`;
export const fmtWeekday = (d) => dtf({ weekday: 'long' }).format(toDate(d));
export const fmtWeekdayShort = (d) => dtf({ weekday: 'short' }).format(toDate(d));
export const fmtMonth = (d) => dtf({ month: 'long', year: 'numeric' }).format(toDate(d));
export const fmtMonthShort = (d) => dtf({ month: 'short' }).format(toDate(d));

/** Ключ дня YYYY-MM-DD за київським часом. */
export function dayKey(d) {
  const p = {};
  for (const x of dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(toDate(d))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function relTime(d) {
  if (!d) return '—';
  const t = toDate(d).getTime();
  const diff = Date.now() - t;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60 * 1000) return 'за хвилину';
    if (ahead < 3600 * 1000) { const m = Math.round(ahead / 60000); return `за ${m} хв`; }
    if (dayKey(t) === dayKey(Date.now())) return `сьогодні о ${fmtTime(t)}`;
    return fmtDateTime(t);
  }
  if (diff < 45 * 1000) return 'щойно';
  if (diff < 3600 * 1000) return `${Math.max(1, Math.round(diff / 60000))} хв тому`;
  const today = dayKey(Date.now());
  if (dayKey(t) === today) return `сьогодні о ${fmtTime(t)}`;
  if (dayKey(t) === dayKey(Date.now() - 86400000)) return `учора о ${fmtTime(t)}`;
  if (diff < 7 * 86400000) return `${fmtWeekday(t)}, ${fmtTime(t)}`;
  return fmtDateYear(t);
}

export const SOURCE_LABELS = {
  student: 'Студент',
  sheet: 'Google Таблиця',
  admin: 'Адміністратор',
  import: 'Імпорт файлу',
  baseline: 'Початкове значення',
  seed: 'Початкові дані',
};
export const sourceLabel = (s) => SOURCE_LABELS[s] || 'Невідоме джерело';

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

const PALETTE = ['#6366f1', '#14b8a6', '#f59e0b', '#f43f5e', '#0ea5e9', '#8b5cf6', '#10b981', '#f97316'];
export function colorFor(key, i) {
  if (typeof i === 'number') return PALETTE[i % PALETTE.length];
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export const palette = PALETTE;
