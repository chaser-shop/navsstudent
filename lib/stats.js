'use strict';
/*
 * Статистика на основі журналу змін балів (ratingHistory).
 * Стан на будь-який момент відтворюється програванням журналу, тому графіки, місця в рейтингу
 * та щоденні повідомлення про прогрес завжди спираються на реальні дані — без вигаданих значень.
 *
 * Подія журналу: { ratingId, kind: 'score' | 'status', subject, value, active, at, source }.
 */

const { round2, sumPoints, sameNum } = require('./rating-core');
const { DAY_MS } = require('./time');

const fmtNum = (n) => Number(n).toLocaleString('uk-UA', { maximumFractionDigits: 2 });

function plural(n, one, few, many, fraction) {
  if (!Number.isInteger(n)) return fraction;
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
const pointsWord = (n) => plural(n, 'бал', 'бали', 'балів', 'бала');
const positionsWord = (n) => plural(n, 'позицію', 'позиції', 'позицій', 'позиції');

function applyEvent(state, e) {
  let s = state.get(e.ratingId);
  if (!s) { s = { subjects: {}, active: true }; state.set(e.ratingId, s); }
  if (e.kind === 'status') { s.active = !!e.active; return; }
  if (e.value == null) delete s.subjects[e.subject];
  else s.subjects[e.subject] = e.value;
}

/** Програє події (відсортовані за часом) і викликає fn(state, index, t) у кожен момент із `times` (за зростанням). */
function sweep(events, times, fn) {
  const state = new Map();
  let i = 0;
  times.forEach((t, idx) => {
    while (i < events.length && +events[i].at <= t) { applyEvent(state, events[i]); i++; }
    fn(state, idx, t);
  });
  return state;
}

/** Місця (1, 2, 2, 4) серед активних записів за загальною сумою або за предметом. */
function ranksOf(state, subject) {
  const list = [];
  for (const [id, s] of state) {
    if (!s.active) continue;
    const v = subject ? s.subjects[subject] : sumPoints(s.subjects);
    if (v != null) list.push({ id, v });
  }
  list.sort((a, b) => b.v - a.v);
  const ranks = new Map();
  let prev = null;
  let rank = 0;
  list.forEach((x, i) => {
    if (prev === null || !sameNum(x.v, prev)) { rank = i + 1; prev = x.v; }
    ranks.set(x.id, rank);
  });
  return { ranks, size: list.length };
}

const momentOf = (bucket, now) => (bucket.end >= now ? now : bucket.end - 1);
const pctChange = (from, to) => (from != null && to != null && from > 0 ? round2(((to - from) / from) * 100) : null);

/**
 * Динаміка одного студента за період: загальна сума, місце в групі, бали з предметів, середнє по групі.
 * events — події всіх записів групи (для місць), meId — запис студента.
 */
function studentSeries({ events, meId, from, now, unit, clock }) {
  const buckets = clock.buckets(from, now, unit);
  const times = buckets.map((b) => momentOf(b, now));
  const points = [];
  sweep(events, times, (state, idx) => {
    const me = state.get(meId);
    const mine = me && me.active ? me : null;
    const { ranks, size } = ranksOf(state);
    let sum = 0;
    let count = 0;
    for (const s of state.values()) {
      if (!s.active) continue;
      const t = sumPoints(s.subjects);
      if (t != null) { sum += t; count++; }
    }
    points.push({
      key: buckets[idx].key,
      start: buckets[idx].start,
      total: mine ? sumPoints(mine.subjects) : null,
      rank: mine ? ranks.get(meId) || null : null,
      groupSize: size,
      groupAvg: count ? round2(sum / count) : null,
      subjects: mine ? { ...mine.subjects } : {},
    });
  });
  return points;
}

/** Стан одного запису на момент t (або null, якщо в журналі ще немає даних). */
function stateAt(events, ratingId, t) {
  let found = null;
  sweep(events.filter((e) => e.ratingId === ratingId), [t], (state) => { found = state.get(ratingId) || null; });
  return found;
}

/**
 * Зміни кожного предмета за період: значення на початку, зараз, приріст і відсоток.
 * Якщо облік предмета почався всередині періоду, початком вважається перше записане значення (since — його час).
 */
function subjectProgress({ events, meId, from, current, subjects }) {
  const start = stateAt(events, meId, from - 1);
  const firstInPeriod = new Map();
  for (const e of events) {
    if (e.ratingId !== meId || e.kind === 'status' || e.value == null || +e.at < from) continue;
    if (!firstInPeriod.has(e.subject)) firstInPeriod.set(e.subject, e);
  }
  return subjects.map((s) => {
    let before = start && start.subjects[s] != null ? start.subjects[s] : null;
    let since = before != null ? from : null;
    if (before == null && firstInPeriod.has(s)) {
      before = firstInPeriod.get(s).value;
      since = +firstInPeriod.get(s).at;
    }
    const now = current[s] == null ? null : current[s];
    return {
      subject: s, from: before, to: now, since,
      delta: before != null && now != null ? round2(now - before) : null,
      percent: pctChange(before, now),
    };
  });
}

/**
 * Повідомлення про прогрес на основі журналу. Кожне — реальне порівняння двох станів.
 * subjectName(key) → повна назва предмета.
 */
function buildInsights({ events, meId, now, clock, subjectName }) {
  const name = subjectName || ((s) => s);
  const todayStart = clock.startOfDay(now);
  const yesterdayEnd = todayStart - 1;
  const dayAgo = now - DAY_MS;
  const weekStart = clock.startOfWeek(now);
  const snaps = {};
  sweep(events, [dayAgo, yesterdayEnd, now], (state, idx) => {
    const me = state.get(meId);
    const mine = me && me.active ? me : null;
    snaps[['dayAgo', 'yesterday', 'now'][idx]] = mine
      ? { subjects: { ...mine.subjects }, total: sumPoints(mine.subjects), rank: ranksOf(state).ranks.get(meId) || null }
      : null;
  });

  const out = [];
  const { yesterday, dayAgo: before, now: current } = snaps;
  if (!current) return { items: out, enoughData: false };
  if (!yesterday) {
    out.push({
      type: 'info', tone: 'neutral',
      text: 'Поки що недостатньо історичних даних для порівняння з учорашнім днем. Порівняння з’явиться, щойно накопичиться історія змін.',
    });
  } else {
    const keys = [...new Set([...Object.keys(yesterday.subjects), ...Object.keys(current.subjects)])];
    for (const s of keys) {
      const y = yesterday.subjects[s];
      const c = current.subjects[s];
      if (y == null || c == null || sameNum(y, c)) continue;
      const up = c > y;
      const pct = pctChange(y, c);
      const text = pct != null
        ? `Ваш рейтинг з предмета «${name(s)}» ${up ? 'покращився' : 'знизився'} на ${fmtNum(Math.abs(pct))}% порівняно з учорашнім днем.`
        : `Ваш бал з предмета «${name(s)}» ${up ? 'зріс' : 'знизився'} з ${fmtNum(y)} до ${fmtNum(c)} порівняно з учорашнім днем.`;
      out.push({ type: 'subject', tone: up ? 'up' : 'down', subject: s, from: y, to: c, percent: pct, text });
    }
    if (yesterday.rank != null && current.rank != null && yesterday.rank !== current.rank) {
      const diff = Math.abs(current.rank - yesterday.rank);
      const up = current.rank < yesterday.rank;
      out.push({
        type: 'rank', tone: up ? 'up' : 'down', from: yesterday.rank, to: current.rank,
        text: `Ви ${up ? 'піднялися' : 'опустилися'} на ${diff} ${positionsWord(diff)} в рейтингу групи.`,
      });
    }
  }
  if (before && before.total != null && current.total != null && !sameNum(before.total, current.total)) {
    const diff = round2(Math.abs(current.total - before.total));
    const up = current.total > before.total;
    out.push({
      type: 'total', tone: up ? 'up' : 'down', from: before.total, to: current.total,
      text: `Ваш загальний рейтинг ${up ? 'зріс' : 'знизився'} на ${fmtNum(diff)} ${pointsWord(diff)} за останню добу.`,
    });
  }
  let best = null;
  for (const e of events) {
    // Початкові значення (baseline) — не результат цього тижня, лише стан на момент запуску обліку.
    if (e.ratingId !== meId || e.kind === 'status' || e.source === 'baseline' || e.value == null || +e.at < weekStart || +e.at > now) continue;
    if (!best || e.value > best.value) best = e;
  }
  if (best) {
    out.push({
      type: 'best', tone: 'up', subject: best.subject, value: best.value,
      text: `Ваш найкращий результат цього тижня — ${fmtNum(best.value)} ${pointsWord(best.value)} з предмета «${name(best.subject)}».`,
    });
  }
  if (yesterday && !out.some((x) => x.type !== 'best')) {
    out.unshift({ type: 'steady', tone: 'neutral', text: 'Від учорашнього дня ваші бали й місце в рейтингу не змінилися.' });
  }
  return { items: out, enoughData: !!yesterday };
}

function histogram(values, bins = 8) {
  if (!values.length) return [];
  const max = Math.max(...values);
  const step = Math.max(1, Math.ceil(max / bins / 5) * 5);
  const out = [];
  for (let i = 0; i < bins; i++) out.push({ from: i * step, to: (i + 1) * step, count: 0 });
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor(v / step));
    out[idx].count++;
  }
  while (out.length > 1 && out[out.length - 1].count === 0) out.pop();
  return out;
}

const avg = (arr) => (arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

/**
 * Аналітика для адміністратора за групою (або кількома групами).
 * records — поточні записи рейтингу, events — журнал змін цих записів (за зростанням часу).
 */
function adminAnalytics({ records, events, subjects, from, now, unit, clock }) {
  const active = records.filter((r) => r.active !== false);
  const totals = active.filter((r) => r.points != null);
  const sortedTotals = [...totals].sort((a, b) => b.points - a.points);
  const bySubject = subjects.map((s) => {
    const vals = active.map((r) => (r.subjects || {})[s]).filter((v) => typeof v === 'number');
    return {
      subject: s, count: vals.length, avg: avg(vals),
      max: vals.length ? Math.max(...vals) : null, min: vals.length ? Math.min(...vals) : null,
    };
  });

  const buckets = clock.buckets(from, now, unit);
  const times = buckets.map((b) => momentOf(b, now));
  const timeline = [];
  let prevRanks = null;
  sweep(events, times, (state, idx) => {
    const vals = [];
    for (const s of state.values()) {
      if (!s.active) continue;
      const t = sumPoints(s.subjects);
      if (t != null) vals.push(t);
    }
    const { ranks } = ranksOf(state);
    let moved = 0;
    if (prevRanks) for (const [id, r] of ranks) if (prevRanks.has(id) && prevRanks.get(id) !== r) moved++;
    prevRanks = ranks;
    timeline.push({ key: buckets[idx].key, start: buckets[idx].start, avgTotal: avg(vals), students: vals.length, rankChanges: idx === 0 ? null : moved });
  });

  const start = new Map();
  sweep(events, [from - 1], (state) => { for (const [id, s] of state) if (s.active) start.set(id, sumPoints(s.subjects)); });
  const changes = [];
  for (const r of totals) {
    const before = start.get(r._id);
    if (before == null) continue;
    changes.push({ id: r._id, fullName: r.fullName, group: r.group, from: before, to: r.points, delta: round2(r.points - before), percent: pctChange(before, r.points) });
  }
  const improvers = changes.filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10);
  const decliners = changes.filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10);

  const activity = buckets.map((b) => ({ key: b.key, start: b.start, student: 0, sheet: 0, admin: 0 }));
  let bi = 0;
  for (const e of events) {
    const t = +e.at;
    if (t < from || e.kind === 'status' || e.source === 'baseline') continue;
    while (bi < buckets.length - 1 && t >= buckets[bi].end) bi++;
    if (t >= buckets[bi].start && t <= Math.max(buckets[bi].end, now)) {
      const k = e.source === 'student' ? 'student' : e.source === 'sheet' ? 'sheet' : 'admin';
      activity[bi][k]++;
    }
  }

  return {
    students: active.length,
    withScores: totals.length,
    avgTotal: avg(totals.map((r) => r.points)),
    best: sortedTotals[0] ? { id: sortedTotals[0]._id, fullName: sortedTotals[0].fullName, points: sortedTotals[0].points } : null,
    worst: sortedTotals.length ? { id: sortedTotals[sortedTotals.length - 1]._id, fullName: sortedTotals[sortedTotals.length - 1].fullName, points: sortedTotals[sortedTotals.length - 1].points } : null,
    bySubject,
    bestSubjects: bySubject.filter((s) => s.avg != null).sort((a, b) => b.avg - a.avg),
    distribution: histogram(totals.map((r) => r.points)),
    timeline,
    avgImprovement: changes.length ? avg(changes.map((c) => c.delta)) : null,
    avgImprovementPercent: changes.length ? avg(changes.map((c) => c.percent).filter((p) => p != null)) : null,
    comparable: changes.length,
    improvers,
    decliners,
    activity,
  };
}

module.exports = {
  fmtNum, plural, pointsWord, positionsWord, sweep, ranksOf, stateAt, studentSeries, subjectProgress,
  buildInsights, adminAnalytics, histogram, pctChange,
};
