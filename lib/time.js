'use strict';
// Календарні межі (день, тиждень, місяць) у часовому поясі застосунку без сторонніх бібліотек.

const DAY_MS = 24 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');

function makeClock(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });

  function parts(t) {
    const p = {};
    for (const x of fmt.formatToParts(new Date(t))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
  }

  // Різниця між місцевим «настінним» часом і UTC у момент t, мс.
  function offset(t) {
    const p = parts(t);
    const whole = t - (((t % 1000) + 1000) % 1000);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - whole;
  }

  // UTC-момент місцевої опівночі календарної дати. Другий прохід виправляє дні переходу на літній час.
  function midnight(y, m, d) {
    const guess = Date.UTC(y, m - 1, d);
    const first = guess - offset(guess);
    return guess - offset(first);
  }

  const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const splitKey = (key) => key.split('-').map(Number);
  const dayKey = (t) => { const p = parts(t); return keyOf(p.y, p.m, p.d); };
  const keyStart = (key) => { const [y, m, d] = splitKey(key); return midnight(y, m, d); };
  const addDays = (key, n) => {
    const [y, m, d] = splitKey(key);
    const u = new Date(Date.UTC(y, m - 1, d + n));
    return keyOf(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate());
  };
  const startOfDay = (t) => keyStart(dayKey(t));
  const weekday = (key) => { const [y, m, d] = splitKey(key); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; };
  const weekKey = (t) => { const key = dayKey(t); return addDays(key, -weekday(key)); };
  const startOfWeek = (t) => keyStart(weekKey(t));
  const monthKey = (t) => { const p = parts(t); return keyOf(p.y, p.m, 1); };
  const startOfMonth = (t) => keyStart(monthKey(t));
  const addMonths = (key, n) => {
    const [y, m] = splitKey(key);
    const u = new Date(Date.UTC(y, m - 1 + n, 1));
    return keyOf(u.getUTCFullYear(), u.getUTCMonth() + 1, 1);
  };
  const hour = (t) => parts(t).h;

  /**
   * Послідовні проміжки від `from` до `to` із кроком day | week | month.
   * Кожен: { key, start, end } — end не включно; останній обрізається моментом `to`.
   */
  function buckets(from, to, unit) {
    const out = [];
    let key = unit === 'month' ? monthKey(from) : unit === 'week' ? weekKey(from) : dayKey(from);
    for (let guard = 0; guard < 2000; guard++) {
      const start = keyStart(key);
      if (start > to) break;
      const nextKey = unit === 'month' ? addMonths(key, 1) : addDays(key, unit === 'week' ? 7 : 1);
      const end = Math.min(keyStart(nextKey), to);
      out.push({ key, start, end });
      if (keyStart(nextKey) > to) break;
      key = nextKey;
    }
    return out;
  }

  return { timeZone, parts, offset, dayKey, keyStart, addDays, startOfDay, weekKey, startOfWeek, monthKey, startOfMonth, addMonths, hour, buckets };
}

module.exports = { makeClock, DAY_MS };
