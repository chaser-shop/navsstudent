'use strict';
/*
 * Чиста (без бази даних) логіка рейтингу:
 *  - нормалізація ПІБ і ключів;
 *  - розбір таблиці рейтингу (Google Sheets / CSV / XLSX у вигляді масиву рядків);
 *  - злиття рядка таблиці із записом у базі за правилами пріоритету джерел;
 *  - перевірка запиту студента на підвищення бала;
 *  - розрахунок місць.
 */

const normName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const normKey = (s) => normName(s).toLocaleLowerCase('uk');
// Ключ студента: без приміток у дужках на кшталт «(староста)» і з єдиним апострофом.
const ratingKey = (n) => normKey(String(n == null ? '' : n).replace(/\([^)]*\)/g, ' ').replace(/[`'ʼ‘’]/g, '’'));
const round2 = (n) => Math.round(n * 100) / 100;
const sameNum = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);
const MAX_POINTS = 100000;

function sumPoints(subjects) {
  const values = Object.values(subjects || {}).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length ? round2(values.reduce((a, b) => a + b, 0)) : null;
}

/** Число з клітинки («75», «82,5», 82). Порожнє або нечислове — null. */
function parseScore(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 && raw <= MAX_POINTS ? round2(raw) : null;
  const s = String(raw).replace(/\s+/g, '').replace(',', '.');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= MAX_POINTS ? round2(n) : null;
}

const cleanCell = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const cleanSubjectName = (v) => cleanCell(v).replace(/[.$]/g, '').slice(0, 40);

/**
 * Таблиця рейтингу → { subjects, entries, skipped }.
 * Шукає рядок заголовка з колонкою «ПІБ» / «Прізвище»; праворуч від неї — предмети.
 * Текст у колонках без заголовка (наприклад «ПОТРЕБУЄ ОНОВЛЕННЯ») зберігається як примітка `remark`.
 */
function parseRatingGrid(grid) {
  const rows = Array.isArray(grid) ? grid : [];
  const nameHead = /(^|\s)(піб|прізвище)/i;
  const skipHead = /^(№|n|#|разом|сума|всього|total|місце|рейтинг|середній)/i;
  let headRow = -1;
  let nameCol = -1;
  for (let r = 0; r < Math.min(rows.length, 30) && headRow < 0; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (nameHead.test(cleanCell(row[c]))) { headRow = r; nameCol = c; break; }
    }
  }
  if (headRow < 0) throw new Error('У таблиці не знайдено заголовок колонки «ПІБ» або «Прізвище».');

  const head = rows[headRow] || [];
  const width = Math.max(...rows.map((r) => (r ? r.length : 0)));
  const subjects = [];
  const subjectCols = [];
  const remarkCols = [];
  for (let c = nameCol + 1; c < width; c++) {
    const name = cleanSubjectName(head[c]);
    if (!name) { remarkCols.push(c); continue; }
    if (skipHead.test(name) || subjects.includes(name)) continue;
    subjects.push(name);
    subjectCols.push(c);
  }
  if (!subjects.length) throw new Error('Праворуч від колонки ПІБ не знайдено жодного предмета.');

  const entries = [];
  const seen = new Set();
  let skipped = 0;
  for (let r = headRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    let fullName = cleanCell(row[nameCol]);
    if (!fullName) continue;
    let note = '';
    fullName = cleanCell(fullName.replace(/\(([^)]*)\)/g, (_, value) => { note = note || cleanCell(value); return ' '; }));
    const nameKey = ratingKey(fullName);
    if (fullName.split(' ').length < 2 || fullName.length > 100 || seen.has(nameKey)) { skipped++; continue; }
    seen.add(nameKey);
    const scores = {};
    subjects.forEach((subject, i) => {
      const value = parseScore(row[subjectCols[i]]);
      if (value != null) scores[subject] = value;
    });
    const remark = remarkCols
      .map((c) => cleanCell(row[c]))
      .filter((v) => v && parseScore(v) == null)
      .join('; ')
      .slice(0, 120);
    entries.push({ row: r + 1, fullName, nameKey, note: note.slice(0, 60), remark, subjects: scores, points: sumPoints(scores) });
  }
  if (!entries.length) throw new Error('У таблиці не знайдено жодного студента.');
  return { subjects, entries, skipped };
}

/**
 * Злиття рядка Google-таблиці із записом рейтингу.
 *
 * Пріоритет джерел (див. README, «Правила синхронізації»):
 *  1. Значення клітинки, яке не змінилося з минулої синхронізації, нічого не перезаписує —
 *     новіші бали студента чи адміністратора зберігаються.
 *  2. Змінене значення таблиці, більше за поточне, застосовується завжди.
 *  3. Змінене значення, менше за поточне, застосовується лише тоді, коли поточний бал теж
 *     прийшов із таблиці (офіційне виправлення). Якщо поточний бал виставив студент чи
 *     адміністратор — бал не змінюється, а створюється конфлікт для перевірки адміністратором.
 *
 * doc.subjectMeta[предмет] = { source, at, by?, sheet } — sheet: останнє бачене значення клітинки.
 */
// Офіційні джерела: їхні значення таблиця може виправляти й у менший бік.
const OFFICIAL_SOURCES = new Set(['sheet', 'import', 'seed', 'baseline']);

function planSheetMerge(doc, entry, sheetSubjects, now, opts = {}) {
  const source = opts.source || 'sheet';
  // trackSheet=false — разовий імпорт файлу: немає «попереднього значення клітинки», порівнюємо лише з поточним балом.
  const track = opts.trackSheet !== false;
  const subjects = { ...(doc.subjects || {}) };
  const meta = doc.subjectMeta || {};
  const set = {};
  const unset = [];
  const history = [];
  const conflicts = [];
  const settled = [];

  for (const s of sheetSubjects) {
    const sv = entry.subjects[s] == null ? null : entry.subjects[s];
    const m = meta[s] || {};
    const seenBefore = Object.prototype.hasOwnProperty.call(m, 'sheet');
    if (track && seenBefore && sameNum(m.sheet, sv)) continue;
    const cur = subjects[s] == null ? null : subjects[s];
    const curSource = m.source || 'sheet';
    const official = OFFICIAL_SOURCES.has(curSource);
    if (track) set[`subjectMeta.${s}.sheet`] = sv;

    if (sv == null) {
      if (cur == null) continue;
      if (official) {
        delete subjects[s];
        unset.push(`subjects.${s}`);
        set[`subjectMeta.${s}.source`] = source;
        set[`subjectMeta.${s}.at`] = now;
        history.push({ subject: s, previous: cur, value: null });
        settled.push(s);
      } else {
        conflicts.push({ subject: s, current: cur, currentSource: curSource, sheet: null });
      }
      continue;
    }
    if (cur == null || sv > cur || (sv < cur && official)) {
      subjects[s] = sv;
      set[`subjects.${s}`] = sv;
      set[`subjectMeta.${s}.source`] = source;
      set[`subjectMeta.${s}.at`] = now;
      history.push({ subject: s, previous: cur, value: sv });
      settled.push(s);
      continue;
    }
    if (sameNum(sv, cur)) {
      // Таблиця «наздогнала» поточний бал — відтепер він офіційний.
      if (!official) set[`subjectMeta.${s}.source`] = source;
      settled.push(s);
      continue;
    }
    conflicts.push({ subject: s, current: cur, currentSource: curSource, sheet: sv });
  }

  if (history.length) set.points = sumPoints(subjects);
  let infoChanged = false;
  if (entry.fullName && entry.fullName !== doc.fullName) { set.fullName = entry.fullName; infoChanged = true; }
  if ((entry.note || '') !== (doc.note || '')) { set.note = entry.note || ''; infoChanged = true; }
  if ((entry.remark || '') !== (doc.remark || '')) { set.remark = entry.remark || ''; infoChanged = true; }
  const reactivated = doc.active === false;
  if (reactivated) { set.active = true; set.missingSince = null; }

  return {
    set, unset, history, conflicts, settled, infoChanged, reactivated,
    changed: Object.keys(set).length > 0 || unset.length > 0,
  };
}

/** Новий запис рейтингу з рядка таблиці. */
function recordFromEntry(entry, sheetSubjects, group, now, origin = 'sheet') {
  const subjectMeta = {};
  for (const s of sheetSubjects) {
    const value = entry.subjects[s] == null ? null : entry.subjects[s];
    if (origin === 'sheet') subjectMeta[s] = { source: origin, at: now, sheet: value };
    else if (value != null) subjectMeta[s] = { source: origin, at: now };
  }
  const subjects = { ...entry.subjects };
  return {
    group, fullName: entry.fullName, nameKey: entry.nameKey, note: entry.note || '', remark: entry.remark || '',
    subjects, subjectMeta, points: sumPoints(subjects), origin, active: true, missingSince: null,
    version: 1, createdAt: now, updatedAt: now,
  };
}

/**
 * Перевірка запиту на підвищення бала (сервер повторює її незалежно від клієнта).
 * Повертає { value } або { error }.
 */
function checkIncrease(current, requested, max) {
  if (typeof current !== 'number' || !Number.isFinite(current)) {
    return { error: 'З цього предмета ще немає бала — підвищувати можна лише наявний бал.' };
  }
  const value = parseScore(typeof requested === 'number' ? requested : String(requested == null ? '' : requested));
  if (value == null) return { error: 'Введіть новий бал числом (до двох знаків після коми).' };
  if (value <= current) return { error: `Новий бал має бути більшим за поточний (${current}). Зменшити бал неможливо.` };
  if (value > max) return { error: `Бал не може перевищувати ${max}.` };
  return { value };
}

/** Місця за спаданням балів; однакові бали — однакове місце (1, 2, 2, 4). Без балів — без місця, внизу. */
function rankEntries(list, key = 'points') {
  const score = (e) => (e[key] == null ? -Infinity : e[key]);
  const sorted = [...list].sort((a, b) => score(b) - score(a) || String(a.fullName || '').localeCompare(String(b.fullName || ''), 'uk'));
  let prev = null;
  let rank = 0;
  return sorted.map((e, i) => {
    if (e[key] == null) return { ...e, rank: null };
    if (e[key] !== prev) { rank = i + 1; prev = e[key]; }
    return { ...e, rank };
  });
}

module.exports = {
  normName, normKey, ratingKey, round2, sameNum, sumPoints, parseScore, cleanSubjectName,
  parseRatingGrid, planSheetMerge, recordFromEntry, checkIncrease, rankEntries, MAX_POINTS, OFFICIAL_SOURCES,
};
