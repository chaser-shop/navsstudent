// Ukrainian number, money, date and plural formatting. Dates use the shop time zone.
let TZ = 'Europe/Kyiv';
export const setTimeZone = (tz) => { if (tz) TZ = tz; };

const nf0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const isNum = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));

export const num = (v) => (isNum(v) ? nf2.format(Number(v)) : '—');
export const int = (v) => (isNum(v) ? nf0.format(Number(v)) : '—');
export const money = (v) => (isNum(v) ? `${nf2.format(Number(v))} грн` : '—');

export function moneyShort(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  if (a >= 1e6) return `${nf1.format(n / 1e6)} млн`;
  if (a >= 1e4) return `${nf1.format(n / 1e3)} тис.`;
  return nf0.format(n);
}

/** Ukrainian plural: [one, few, many] — 1 товар, 2 товари, 5 товарів. */
export function plural(n, [one, few, many]) {
  const a = Math.abs(Math.trunc(Number(n) || 0)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const count = (n, forms) => `${int(n)} ${plural(n, forms)}`;

export const toDate = (v) => (v instanceof Date ? v : new Date(v));
const fmt = (opts) => new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, ...opts });

export const dateNum = (v) => (v ? fmt({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(toDate(v)) : '—');
export const time = (v) => (v ? fmt({ hour: '2-digit', minute: '2-digit' }).format(toDate(v)) : '—');
export const dateTime = (v) => (v ? `${dateNum(v)}, ${time(v)}` : '—');
export const dateLong = (v = new Date()) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(toDate(v));

/** YYYY-MM-DD in the shop time zone. */
export const isoDay = (v = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(toDate(v));

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 864e5);
}
/** Labels for calendar days given as YYYY-MM-DD (no time-zone shift). */
export function dayShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(y, m - 1, d)));
}
export function dayFull(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

export function relTime(v) {
  if (!v) return '—';
  const d = toDate(v);
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 45) return 'щойно';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} хв тому`;
  if (sec < 6 * 3600) return `${Math.round(sec / 3600)} год тому`;
  const day = isoDay(d);
  if (day === isoDay()) return `сьогодні о ${time(d)}`;
  if (day === isoDay(new Date(Date.now() - 864e5))) return `вчора о ${time(d)}`;
  return dateTime(d);
}

export function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (h < 5) return 'Доброї ночі';
  if (h < 12) return 'Доброго ранку';
  if (h < 18) return 'Доброго дня';
  return 'Доброго вечора';
}

/** Group heading for a day: «Сьогодні», «Вчора» or a full date. */
export function dayHeading(v) {
  const day = isoDay(v);
  if (day === isoDay()) return 'Сьогодні';
  if (day === isoDay(new Date(Date.now() - 864e5))) return 'Вчора';
  return fmt({ day: 'numeric', month: 'long', year: 'numeric' }).format(toDate(v));
}

export const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

/** Change versus the previous period: { dir: 'up'|'down'|'flat', text }. */
export function change(cur, prev) {
  const c = Number(cur) || 0;
  const p = Number(prev) || 0;
  if (!p) return c ? { dir: 'up', text: 'нове' } : { dir: 'flat', text: '0%' };
  const r = Math.round(((c - p) / p) * 100);
  return { dir: r > 0 ? 'up' : r < 0 ? 'down' : 'flat', text: `${r > 0 ? '+' : ''}${r}%` };
}

export const initials = (name) =>
  (String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();

export function hashTone(str, n = 6) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % n) + 1;
}

export const fileSize = (b) =>
  b < 1024 ? `${b} Б` : b < 1048576 ? `${nf1.format(b / 1024)} КБ` : `${nf1.format(b / 1048576)} МБ`;
