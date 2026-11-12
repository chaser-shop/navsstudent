'use strict';
// Модульні тести чистої логіки: розбір таблиць, правила злиття, перевірка підвищення бала, статистика.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../lib/csv');
const core = require('../lib/rating-core');
const stats = require('../lib/stats');
const { makeClock } = require('../lib/time');
const { hashPassword, verifyPassword, passwordProblem } = require('../lib/passwords');

const clock = makeClock('Europe/Kyiv');
const kyiv = (iso) => Date.parse(iso); // ISO з явним зсувом, напр. '2026-11-12T15:00:00+02:00'

test('CSV: лапки, коми, переноси рядків і BOM', () => {
  const rows = parseCsv('\uFEFF"a","b, c"\r\n"x ""y""","line1\nline2"\n1,2');
  assert.deepEqual(rows, [['a', 'b, c'], ['x "y"', 'line1\nline2'], ['1', '2']]);
});

test('розбір таблиці: заголовок, примітки в дужках, текст без заголовка, дробові бали', () => {
  const grid = [
    ['Рейтинг групи'],
    ['№ з/п', 'Прізвище, ім’я та по батькові', 'Укр', 'Англ', 'Разом', ''],
    ['1', 'Петренко Олена Іванівна (староста)', '75', '60,5', '135,5', ''],
    ['2', 'Коваль Андрій', '', '40', '40', 'ПОТРЕБУЄ ОНОВЛЕННЯ'],
    ['3', 'Однослівний', '10', '10', '', ''],
    ['4', 'Петренко  Олена  Іванівна', '1', '1', '', ''],
  ];
  const p = core.parseRatingGrid(grid);
  assert.deepEqual(p.subjects, ['Укр', 'Англ']);
  assert.equal(p.entries.length, 2);
  assert.equal(p.skipped, 2);
  assert.deepEqual(p.entries[0], {
    row: 3, fullName: 'Петренко Олена Іванівна', nameKey: 'петренко олена іванівна', note: 'староста', remark: '',
    subjects: { 'Укр': 75, 'Англ': 60.5 }, points: 135.5,
  });
  assert.equal(p.entries[1].remark, 'ПОТРЕБУЄ ОНОВЛЕННЯ');
  assert.deepEqual(p.entries[1].subjects, { 'Англ': 40 });
  assert.throws(() => core.parseRatingGrid([['a', 'b']]), /ПІБ/);
});

test('ключ ПІБ: однакові апострофи й без приміток', () => {
  assert.equal(core.ratingKey("Змерзла Дар`я (староста)"), core.ratingKey('Змерзла Дар’я'));
});

const doc = (subjects, meta, extra = {}) => ({ _id: 'r1', fullName: 'Петренко Олена Іванівна', note: '', remark: '', subjects, subjectMeta: meta, ...extra });
const entry = (subjects, extra = {}) => ({ fullName: 'Петренко Олена Іванівна', note: '', remark: '', subjects, ...extra });
const now = new Date('2026-11-12T10:00:00Z');

test('злиття: незмінена клітинка таблиці не перезаписує новіший бал студента', () => {
  const d = doc({ 'Укр': 82 }, { 'Укр': { source: 'student', sheet: 75 } });
  const plan = core.planSheetMerge(d, entry({ 'Укр': 75 }), ['Укр'], now);
  assert.equal(plan.changed, false);
  assert.equal(plan.history.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test('злиття: змінене більше значення таблиці застосовується', () => {
  const d = doc({ 'Укр': 82 }, { 'Укр': { source: 'student', sheet: 75 } });
  const plan = core.planSheetMerge(d, entry({ 'Укр': 90 }), ['Укр'], now);
  assert.equal(plan.set['subjects.Укр'], 90);
  assert.equal(plan.set['subjectMeta.Укр.source'], 'sheet');
  assert.equal(plan.set.points, 90);
  assert.deepEqual(plan.history, [{ subject: 'Укр', previous: 82, value: 90 }]);
});

test('злиття: менше значення таблиці проти бала студента — конфлікт, бал не знижується', () => {
  const d = doc({ 'Укр': 82 }, { 'Укр': { source: 'student', sheet: 75 } });
  const plan = core.planSheetMerge(d, entry({ 'Укр': 80 }), ['Укр'], now);
  assert.equal(plan.set['subjects.Укр'], undefined);
  assert.equal(plan.set['subjectMeta.Укр.sheet'], 80);
  assert.deepEqual(plan.conflicts, [{ subject: 'Укр', current: 82, currentSource: 'student', sheet: 80 }]);
  assert.equal(plan.history.length, 0);
});

test('злиття: офіційне виправлення таблиці в менший бік застосовується', () => {
  const d = doc({ 'Укр': 82 }, { 'Укр': { source: 'sheet', sheet: 82 } });
  const plan = core.planSheetMerge(d, entry({ 'Укр': 78 }), ['Укр'], now);
  assert.equal(plan.set['subjects.Укр'], 78);
  assert.equal(plan.conflicts.length, 0);
});

test('злиття: очищена клітинка прибирає лише офіційний бал', () => {
  const official = core.planSheetMerge(doc({ 'Укр': 70 }, { 'Укр': { source: 'sheet', sheet: 70 } }), entry({}), ['Укр'], now);
  assert.deepEqual(official.unset, ['subjects.Укр']);
  const studentOwned = core.planSheetMerge(doc({ 'Укр': 70 }, { 'Укр': { source: 'student', sheet: 60 } }), entry({}), ['Укр'], now);
  assert.equal(studentOwned.unset.length, 0);
  assert.equal(studentOwned.conflicts.length, 1);
});

test('злиття: таблиця наздогнала бал студента — він стає офіційним; змінюється примітка', () => {
  const d = doc({ 'Укр': 82 }, { 'Укр': { source: 'student', sheet: 75 } });
  const plan = core.planSheetMerge(d, entry({ 'Укр': 82 }, { note: 'староста' }), ['Укр'], now);
  assert.equal(plan.set['subjectMeta.Укр.source'], 'sheet');
  assert.deepEqual(plan.settled, ['Укр']);
  assert.equal(plan.infoChanged, true);
  assert.equal(plan.set.note, 'староста');
});

test('злиття: імпорт файлу порівнює лише з поточним балом і не відстежує клітинку', () => {
  const d = doc({ 'Укр': 82 }, { 'Укр': { source: 'student' } });
  const plan = core.planSheetMerge(d, entry({ 'Укр': 70 }), ['Укр'], now, { source: 'import', trackSheet: false });
  assert.equal(plan.conflicts.length, 1);
  assert.equal(Object.keys(plan.set).some((k) => k.endsWith('.sheet')), false);
});

test('підвищення бала: дозволено лише більше значення в межах максимуму', () => {
  assert.deepEqual(core.checkIncrease(75, 82, 100), { value: 82 });
  assert.deepEqual(core.checkIncrease(75, '82,5', 100), { value: 82.5 });
  assert.match(core.checkIncrease(82, 75, 100).error, /більшим/);
  assert.match(core.checkIncrease(82, 82, 100).error, /більшим/);
  assert.match(core.checkIncrease(82, 101, 100).error, /100/);
  assert.match(core.checkIncrease(82, 'abc', 100).error, /числом/);
  assert.match(core.checkIncrease(82, -5, 100).error, /числом/);
  assert.match(core.checkIncrease(null, 50, 100).error, /немає бала/);
});

test('місця: однакові бали — однакове місце, без балів — у кінці', () => {
  const r = core.rankEntries([
    { fullName: 'В', points: 10 }, { fullName: 'А', points: 20 }, { fullName: 'Б', points: 10 }, { fullName: 'Г', points: null },
  ]);
  assert.deepEqual(r.map((x) => [x.fullName, x.rank]), [['А', 1], ['Б', 2], ['В', 2], ['Г', null]]);
});

test('час: межі днів за Києвом, зокрема день переходу на зимовий час', () => {
  assert.equal(clock.dayKey(kyiv('2026-11-12T00:30:00+02:00')), '2026-11-12');
  assert.equal(new Date(clock.keyStart('2026-10-25')).toISOString(), '2026-10-24T21:00:00.000Z');
  assert.equal(new Date(clock.keyStart('2026-10-26')).toISOString(), '2026-10-25T22:00:00.000Z');
  const b = clock.buckets(kyiv('2026-10-24T12:00:00+03:00'), kyiv('2026-10-26T12:00:00+02:00'), 'day');
  assert.deepEqual(b.map((x) => x.key), ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.equal(b[1].end - b[1].start, 25 * 3600 * 1000);
  assert.equal(clock.weekKey(kyiv('2026-11-12T15:00:00+02:00')), '2026-11-09');
});

test('множина: бал/бали/балів, позицію/позиції/позицій', () => {
  assert.deepEqual([1, 2, 5, 11, 21, 2.5].map(stats.pointsWord), ['бал', 'бали', 'балів', 'балів', 'бал', 'бала']);
  assert.deepEqual([1, 3, 7].map(stats.positionsWord), ['позицію', 'позиції', 'позицій']);
});

// Група з трьох студентів: m (я), a, b. Події в часі Києва.
function groupEvents() {
  const ev = (ratingId, subject, value, iso, source = 'sheet') => ({ ratingId, kind: 'score', subject, value, at: new Date(kyiv(iso)), source });
  return [
    ev('m', 'Укр', 50, '2026-11-10T10:00:00+02:00'), ev('m', 'Англ', 40, '2026-11-10T10:00:00+02:00'),
    ev('a', 'Укр', 60, '2026-11-10T10:00:00+02:00'), ev('a', 'Англ', 50, '2026-11-10T10:00:00+02:00'),
    ev('b', 'Укр', 45, '2026-11-10T10:00:00+02:00'), ev('b', 'Англ', 40, '2026-11-10T10:00:00+02:00'),
    ev('m', 'Укр', 54, '2026-11-11T12:00:00+02:00', 'student'),
    ev('m', 'Укр', 58.32, '2026-11-12T09:00:00+02:00', 'student'),
    ev('m', 'Англ', 60, '2026-11-12T09:05:00+02:00', 'student'),
  ];
}
const names = { 'Укр': 'Українська мова', 'Англ': 'Англійська мова' };

test('щоденні повідомлення про прогрес відповідають реальній історії', () => {
  const { items, enoughData } = stats.buildInsights({
    events: groupEvents(), meId: 'm', now: kyiv('2026-11-12T15:00:00+02:00'), clock, subjectName: (s) => names[s],
  });
  assert.equal(enoughData, true);
  const texts = items.map((i) => i.text);
  assert.ok(texts.includes('Ваш рейтинг з предмета «Українська мова» покращився на 8% порівняно з учорашнім днем.'), texts.join('\n'));
  assert.ok(texts.includes('Ваш рейтинг з предмета «Англійська мова» покращився на 50% порівняно з учорашнім днем.'));
  assert.ok(texts.includes('Ви піднялися на 1 позицію в рейтингу групи.'));
  assert.ok(texts.includes('Ваш загальний рейтинг зріс на 24,32 бала за останню добу.'));
  assert.ok(texts.includes('Ваш найкращий результат цього тижня — 60 балів з предмета «Англійська мова».'));
});

test('без учорашніх даних — чесне повідомлення про нестачу історії', () => {
  const events = [{ ratingId: 'n', kind: 'score', subject: 'Укр', value: 70, at: new Date(kyiv('2026-11-12T08:00:00+02:00')), source: 'baseline' }];
  const { items, enoughData } = stats.buildInsights({ events, meId: 'n', now: kyiv('2026-11-12T15:00:00+02:00'), clock });
  assert.equal(enoughData, false);
  assert.equal(items.length, 1);
  assert.match(items[0].text, /недостатньо історичних даних/);
});

test('без змін за добу — повідомлення про стабільність, без вигаданих змін', () => {
  const events = groupEvents().filter((e) => +e.at < kyiv('2026-11-11T00:00:00+02:00'));
  const { items } = stats.buildInsights({ events, meId: 'm', now: kyiv('2026-11-12T15:00:00+02:00'), clock });
  assert.equal(items[0].type, 'steady');
  assert.equal(items.filter((i) => i.type === 'subject' || i.type === 'rank' || i.type === 'total').length, 0);
  // Бали, отримані у вівторок, — справжній результат цього тижня.
  assert.deepEqual(items.slice(1).map((i) => [i.type, i.value]), [['best', 50]]);
});

test('динаміка студента: сума, місце й середнє групи за днями', () => {
  const points = stats.studentSeries({
    events: groupEvents(), meId: 'm', from: clock.keyStart('2026-11-10'), now: kyiv('2026-11-12T15:00:00+02:00'), unit: 'day', clock,
  });
  assert.deepEqual(points.map((p) => p.key), ['2026-11-10', '2026-11-11', '2026-11-12']);
  assert.deepEqual(points.map((p) => p.total), [90, 94, 118.32]);
  assert.deepEqual(points.map((p) => p.rank), [2, 2, 1]);
  assert.equal(points[0].groupAvg, 95);
});

test('аналітика: приріст, лідери зростання та активність за джерелами', () => {
  const records = [
    { _id: 'm', fullName: 'М', points: 118.32, subjects: { 'Укр': 58.32, 'Англ': 60 } },
    { _id: 'a', fullName: 'А', points: 110, subjects: { 'Укр': 60, 'Англ': 50 } },
    { _id: 'b', fullName: 'Б', points: 85, subjects: { 'Укр': 45, 'Англ': 40 } },
  ];
  const a = stats.adminAnalytics({
    records, events: groupEvents(), subjects: ['Укр', 'Англ'], from: clock.keyStart('2026-11-11'), now: kyiv('2026-11-12T15:00:00+02:00'), unit: 'day', clock,
  });
  assert.equal(a.avgTotal, 104.44);
  assert.equal(a.best.fullName, 'М');
  assert.equal(a.worst.fullName, 'Б');
  assert.deepEqual(a.improvers.map((x) => [x.id, x.delta]), [['m', 28.32]]);
  assert.equal(a.decliners.length, 0);
  assert.deepEqual(a.activity.map((x) => x.student), [1, 2]);
  assert.equal(a.bySubject.find((s) => s.subject === 'Укр').avg, 54.44);
});

test('паролі: scrypt, перевірка й політика', async () => {
  const hash = await hashPassword('Секретний-пароль1');
  assert.equal(await verifyPassword('Секретний-пароль1', hash), true);
  assert.equal(await verifyPassword('інший', hash), false);
  assert.match(passwordProblem('1234567'), /8/);
  assert.match(passwordProblem('12345678'), /цифр/);
  assert.equal(passwordProblem('Надійний пароль'), '');
});
