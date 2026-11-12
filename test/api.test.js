'use strict';
/*
 * Наскрізні тести API: справжній server.js + MongoDB (набір реплік у пам’яті) + локальна «Google-таблиця» (CSV).
 * Перевіряють безпеку підвищення балів, історію змін, синхронізацію, конфлікти, статистику й панель адміністратора.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

const ROOT = path.join(__dirname, '..');
const GROUP = 'Тест-1';
const ADMIN = 'Адміненко Адмін Адмінович';
const A = 'Петренко Олена Іванівна';
const B = 'Коваль Андрій Петрович';
const C = 'Шевчук Ірина Олегівна';
const PASS = 'Надійний пароль 1';

let mongo; let client; let db; let server; let sheetServer; let base; let csv; let serverLog = '';
const tokens = {};
const ids = {};

const sheet = (rows) => ['№,"Прізвище, ім’я та по батькові",Укр,Англ,Інформ', ...rows].join('\n');

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Не дочекалися: ${what}\n${serverLog.slice(-3000)}`);
}

async function api(method, p, { body, token, device } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(device ? { 'X-Device-Id': device } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const adminApi = (method, p, body) => api(method, p, { body, token: tokens.admin });
const record = (fullName) => db.collection('navsrating').findOne({ group: GROUP, fullName });
const sync = async () => {
  const r = await adminApi('POST', '/api/admin/rating/sync', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = mongo.getUri();
  client = await MongoClient.connect(uri);
  db = client.db('gradebook_test');
  csv = sheet([`1,${A},75,60,70`, `2,${B},50,55,40`, `3,${C} (староста),65,70,80`]);
  sheetServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); res.end(csv); });
  await new Promise((r) => sheetServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), MONGODB_URI: uri, DB_NAME: 'gradebook_test', GRADES_DB: 'grades_test',
      ADMIN_NAMES: ADMIN, ADMIN_PASSWORD: 'admin-bootstrap', GOOGLE_SHEET_GROUP: GROUP, GOOGLE_SHEET_INTERVAL_MS: '3600000',
      GOOGLE_SHEET_CSV_URL: `http://127.0.0.1:${sheetServer.address().port}/sheet.csv`, SCORE_MAX: '100',
      VAPID_SUBJECT: 'mailto:test@navs.test', RENDER_EXTERNAL_URL: '', KEEP_ALIVE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await waitFor(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } }, 30000, 'запуск сервера');
  await waitFor(async () => !!(await db.collection('config').findOne({ _id: 'googleRatingSync', 'value.lastSuccessAt': { $exists: true } })), 15000, 'перша синхронізація');
});

test.after(async () => {
  if (server) server.kill('SIGTERM');
  if (sheetServer) sheetServer.close();
  if (client) await client.close();
  if (mongo) await mongo.stop();
});

test('реєстрація: ПІБ адміністратора захищено паролем адміністратора, слабкий пароль відхиляється', async () => {
  let r = await api('POST', '/api/auth/register', { body: { fullName: ADMIN, password: PASS, deviceId: 'dev-admin' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'admin_password_required');
  r = await api('POST', '/api/auth/register', { body: { fullName: ADMIN, password: PASS, deviceId: 'dev-admin', adminPassword: 'admin-bootstrap' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isAdmin, true);
  tokens.admin = r.data.token;

  r = await api('POST', '/api/auth/register', { body: { fullName: A, password: '1234', deviceId: 'dev-a1' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'weak_password');
  for (const [key, name, dev] of [['a', A, 'dev-a1'], ['b', B, 'dev-b1'], ['c', C, 'dev-c1']]) {
    r = await api('POST', '/api/auth/register', { body: { fullName: name, password: PASS, deviceId: dev } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.user.isAdmin, false);
    tokens[key] = r.data.token;
    ids[key] = r.data.user.id;
  }
  r = await api('POST', '/api/auth/register', { body: { fullName: A, password: PASS, deviceId: 'dev-x' } });
  assert.equal(r.status, 409);
});

test('вхід: невідомий ПІБ, невірний пароль, вхід з нового пристрою', async () => {
  let r = await api('POST', '/api/auth/login', { body: { fullName: 'Невідомий Студент Тестович', password: PASS, deviceId: 'x' } });
  assert.equal(r.status, 404);
  r = await api('POST', '/api/auth/login', { body: { fullName: A, password: 'неправильний пароль', deviceId: 'dev-a2' } });
  assert.equal(r.status, 403);
  r = await api('POST', '/api/auth/login', { body: { fullName: A, deviceId: 'dev-a2' } });
  assert.equal(r.data.code, 'password_required');
  r = await api('POST', '/api/auth/login', { body: { fullName: A, password: PASS, deviceId: 'dev-a2' } });
  assert.equal(r.status, 200);
  tokens.a2 = r.data.token;
});

test('синхронізація з таблицею створює записи й не дублює їх', async () => {
  const state = await adminApi('GET', '/api/admin/sync');
  assert.equal(state.status, 200);
  assert.equal(state.data.mode, 'csv-url');
  assert.ok(state.data.state.lastSuccessAt);
  assert.ok(state.data.nextRunAt);
  assert.equal(await db.collection('navsrating').countDocuments({ group: GROUP }), 3);
  assert.equal(await db.collection('ratingHistory').countDocuments({ group: GROUP, source: 'sheet' }), 9);
  const again = await sync();
  assert.equal(again.created, 0);
  assert.equal(again.scoreChanges, 0);
  assert.equal(await db.collection('navsrating').countDocuments({ group: GROUP }), 3);
  assert.equal(await db.collection('ratingHistory').countDocuments({ group: GROUP, source: 'sheet' }), 9);
  const c = await record(C);
  assert.equal(c.note, 'староста');
  ids.recA = (await record(A))._id;
  ids.recB = (await record(B))._id;
  ids.recC = c._id;
});

test('прив’язка: один запис рейтингу — лише один акаунт', async () => {
  assert.equal((await adminApi('POST', `/api/admin/users/${ids.a}/student`, { studentId: ids.recA })).status, 200);
  assert.equal((await adminApi('POST', `/api/admin/users/${ids.b}/student`, { studentId: ids.recB })).status, 200);
  const dup = await adminApi('POST', `/api/admin/users/${ids.c}/student`, { studentId: ids.recA });
  assert.equal(dup.status, 409);
});

test('студент бачить свої поточні бали з кожного предмета', async () => {
  const r = await api('GET', '/api/me/overview', { token: tokens.a });
  assert.equal(r.status, 200);
  assert.equal(r.data.linked, true);
  const values = Object.fromEntries(r.data.subjects.map((s) => [s.key, s.value]));
  assert.deepEqual(values, { 'Укр': 75, 'Англ': 60, 'Інформ': 70 });
  assert.equal(r.data.total, 205);
  assert.equal(r.data.canIncrease, true);
});

test('студент підвищує свій бал: 75 → 82, зміна записана в журнал', async () => {
  const r = await api('POST', '/api/me/scores/increase', { token: tokens.a, body: { subject: 'Укр', value: 82, expected: 75 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.previous, r.data.value, r.data.delta, r.data.points], [75, 82, 7, 212]);
  const doc = await record(A);
  assert.equal(doc.subjects['Укр'], 82);
  assert.equal(doc.points, 212);
  assert.equal(doc.subjectMeta['Укр'].source, 'student');
  const h = await db.collection('ratingHistory').findOne({ ratingId: ids.recA, source: 'student' });
  assert.equal(h.userId, ids.a);
  assert.equal(h.subject, 'Укр');
  assert.deepEqual([h.previous, h.value, h.delta], [75, 82, 7]);
  assert.ok(h.at instanceof Date);
});

test('зменшити або «не змінити» бал неможливо; сервер перевіряє все сам', async () => {
  const cases = [
    [{ subject: 'Укр', value: 75 }, 400],
    [{ subject: 'Укр', value: 82 }, 400],
    [{ subject: 'Укр', value: 101 }, 400],
    [{ subject: 'Укр', value: 'багато' }, 400],
    [{ subject: 'Укр', value: -1 }, 400],
    [{ subject: 'Неіснуючий', value: 90 }, 400],
    [{ subject: 'Укр', value: 90, expected: 75 }, 409],
  ];
  for (const [body, status] of cases) {
    const r = await api('POST', '/api/me/scores/increase', { token: tokens.a, body });
    assert.equal(r.status, status, `${JSON.stringify(body)} → ${JSON.stringify(r.data)}`);
  }
  assert.equal((await record(A)).subjects['Укр'], 82);
});

test('студент не може змінити чужий бал навіть через підроблені поля чи токен', async () => {
  const r = await api('POST', '/api/me/scores/increase', {
    token: tokens.a, body: { subject: 'Укр', value: 90, expected: 82, ratingId: ids.recB, studentId: ids.recB, userId: ids.b },
  });
  assert.equal(r.status, 200);
  assert.equal((await record(A)).subjects['Укр'], 90);
  assert.equal((await record(B)).subjects['Укр'], 50);
  const patch = await api('PATCH', `/api/admin/rating/${ids.recB}`, { token: tokens.a, body: { subjects: { 'Укр': 100 } } });
  assert.equal(patch.status, 403);
  const [payload, sig] = tokens.a.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), u: ids.b })).toString('base64url');
  const r2 = await api('POST', '/api/me/scores/increase', { token: `${forged}.${sig}`, body: { subject: 'Укр', value: 99 } });
  assert.equal(r2.status, 401);
  const r3 = await api('POST', '/api/me/scores/increase', { body: { subject: 'Укр', value: 99 } });
  assert.equal(r3.status, 401);
  assert.equal((await record(B)).subjects['Укр'], 50);
});

test('неприв’язаний акаунт і акаунт без пароля не можуть змінювати бали', async () => {
  const r = await api('POST', '/api/me/scores/increase', { token: tokens.c, body: { subject: 'Укр', value: 99 } });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'not_linked');
  await db.collection('users').updateOne({ _id: ids.b }, { $unset: { passwordHash: '' } });
  const r2 = await api('POST', '/api/me/scores/increase', { token: tokens.b, body: { subject: 'Укр', value: 55 } });
  assert.equal(r2.status, 403);
  assert.equal(r2.data.code, 'password_setup_required');
  const set = await api('POST', '/api/auth/password', { token: tokens.b, body: { newPassword: PASS } });
  assert.equal(set.status, 200);
  tokens.b = set.data.token;
  const r3 = await api('POST', '/api/me/scores/increase', { token: tokens.b, body: { subject: 'Укр', value: 55, expected: 50 } });
  assert.equal(r3.status, 200);
});

test('синхронізація: незмінена таблиця не перезаписує новіший бал студента', async () => {
  const r = await sync();
  assert.equal(r.conflicts, 0);
  assert.equal((await record(A)).subjects['Укр'], 90);
});

test('синхронізація: нові записи, змінені бали, конфлікт, деактивація замість видалення', async () => {
  csv = sheet([`1,${A},80,60,70`, `2,${B},55,65,40`, '4,Мельник Тарас Богданович,30,35,40']);
  const r = await sync();
  assert.equal(r.created, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.conflicts, 1);
  assert.equal(r.deactivated, 1);
  assert.equal((await record(A)).subjects['Укр'], 90, 'бал студента не знижено');
  const b = await record(B);
  assert.equal(b.subjects['Англ'], 65);
  assert.equal(b.subjects['Укр'], 55);
  const c = await record(C);
  assert.equal(c.active, false);
  assert.ok(c.missingSince);
  const h = await db.collection('ratingHistory').findOne({ ratingId: ids.recB, subject: 'Англ', source: 'sheet', previous: 55 });
  assert.equal(h.value, 65);
  const overview = await adminApi('GET', '/api/admin/sync');
  const conflict = overview.data.conflicts.find((x) => x.ratingId === ids.recA);
  assert.deepEqual([conflict.subject, conflict.currentValue, conflict.sheetValue, conflict.currentSource], ['Укр', 90, 80, 'student']);
  assert.ok(overview.data.runs.some((run) => run.created === 1 && run.conflicts === 1));
  ids.conflict = conflict.id;
});

test('конфлікт вирішує адміністратор; повторна синхронізація нічого не дублює', async () => {
  const r = await adminApi('POST', `/api/admin/sync/conflicts/${encodeURIComponent(ids.conflict)}/resolve`, { action: 'sheet' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await record(A)).subjects['Укр'], 80);
  const again = await sync();
  assert.deepEqual([again.created, again.scoreChanges, again.conflicts, again.deactivated], [0, 0, 0, 0]);
  assert.equal(await db.collection('navsrating').countDocuments({ group: GROUP }), 4);
  assert.equal((await adminApi('GET', '/api/admin/sync')).data.conflicts.length, 0);
});

test('історія змін студента записана повністю й по порядку', async () => {
  const r = await api('GET', '/api/me/history', { token: tokens.a });
  assert.equal(r.status, 200);
  const ukr = r.data.items.filter((i) => i.subject === 'Укр').map((i) => [i.source, i.previous, i.value]);
  assert.deepEqual(ukr, [['admin', 90, 80], ['student', 82, 90], ['student', 75, 82], ['sheet', null, 75]]);
});

test('статистика: остання точка дорівнює поточній сумі', async () => {
  const r = await api('GET', '/api/me/stats?period=7', { token: tokens.a });
  assert.equal(r.status, 200);
  assert.equal(r.data.series.length, 7);
  const last = r.data.series[r.data.series.length - 1];
  assert.equal(last.total, (await record(A)).points);
  assert.equal(r.data.hasData, true);
});

test('щоденні повідомлення про прогрес будуються з реальної історії', async () => {
  assert.equal((await adminApi('PUT', '/api/admin/rating/subject-names', { names: { 'Укр': 'Українська мова' } })).status, 200);
  // Початкові бали з таблиці переносимо на «вчора», решта змін — сьогодні.
  const yesterday = new Date(Date.now() - 30 * 3600 * 1000);
  await db.collection('ratingHistory').updateMany({ ratingId: ids.recA, source: 'sheet' }, { $set: { at: yesterday } });
  const r = await api('GET', '/api/me/overview', { token: tokens.a });
  const texts = r.data.insights.map((i) => i.text);
  assert.ok(texts.includes('Ваш рейтинг з предмета «Українська мова» покращився на 6,67% порівняно з учорашнім днем.'), texts.join('\n'));
  assert.ok(texts.includes('Ваш загальний рейтинг зріс на 5 балів за останню добу.'), texts.join('\n'));
  assert.ok(texts.includes('Ваш найкращий результат цього тижня — 90 балів з предмета «Українська мова».'), texts.join('\n'));
  const fresh = await api('GET', '/api/me/overview', { token: tokens.b });
  assert.match(fresh.data.insights[0].text, /недостатньо історичних даних/);
});

test('журнал змін: посторінковий перегляд не губить записи з однаковим часом', async () => {
  const total = await db.collection('ratingHistory').countDocuments({ source: 'sheet', kind: 'score' });
  const seen = new Set();
  let before = '';
  for (let guard = 0; guard < 50; guard++) {
    const r = await adminApi('GET', `/api/admin/score-changes?source=sheet&limit=4${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    assert.equal(r.status, 200);
    r.data.items.forEach((i) => seen.add(i.id));
    if (!r.data.more) break;
    before = r.data.next;
  }
  assert.equal(seen.size, total);
});

test('адміністратор бачить і скасовує зміну студента', async () => {
  const list = await adminApi('GET', '/api/admin/score-changes?source=student');
  const change = list.data.items.find((i) => i.ratingId === ids.recB);
  assert.equal(change.revertable, true);
  const r = await adminApi('POST', `/api/admin/score-changes/${change.id}/revert`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await record(B)).subjects['Укр'], 50);
  assert.equal((await adminApi('POST', `/api/admin/score-changes/${change.id}/revert`)).status, 409);
});

test('панель адміністратора показує точні дані', async () => {
  const r = await adminApi('GET', '/api/admin/dashboard');
  assert.equal(r.status, 200);
  const active = await db.collection('navsrating').find({ active: { $ne: false } }).toArray();
  const totals = active.map((x) => x.points).filter((v) => typeof v === 'number');
  const avg = Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100;
  assert.equal(r.data.kpi.ratingStudents, active.length);
  assert.equal(r.data.kpi.avgTotal, avg);
  assert.equal(r.data.kpi.best.points, Math.max(...totals));
  assert.equal(r.data.kpi.worst.points, Math.min(...totals));
  assert.equal(r.data.kpi.accounts, 3);
  assert.equal(r.data.kpi.linkedAccounts, 2);
  assert.equal(r.data.kpi.activeStudents7, 3);
  assert.equal(r.data.kpi.subjects, (await db.collection('config').findOne({ _id: 'ratingSubjects' })).value.length);
  const students = await adminApi('GET', `/api/admin/students?group=${encodeURIComponent(GROUP)}&q=петренко`);
  assert.deepEqual(students.data.items.map((s) => s.fullName), [A]);
  const profile = await adminApi('GET', `/api/admin/students/${ids.recA}`);
  assert.equal(profile.data.accounts[0].id, ids.a);
  assert.ok(profile.data.history.items.length >= 4);
  const analytics = await adminApi('GET', `/api/admin/analytics?group=${encodeURIComponent(GROUP)}&period=7`);
  assert.equal(analytics.status, 200);
  assert.equal(analytics.data.timeline.length, 7);
});

test('доступ: студент не відкриває маршрути адміністратора', async () => {
  for (const p of ['/api/admin/dashboard', `/api/admin/students/${ids.recB}`, '/api/admin/score-changes', '/api/admin/sync']) {
    assert.equal((await api('GET', p, { token: tokens.a })).status, 403, p);
  }
  assert.equal((await api('POST', '/api/admin/rating/sync', { token: tokens.a, body: {} })).status, 403);
});

test('імпорт файлу не видаляє студентів, а деактивує', async () => {
  const body = (names) => ({ group: 'Імпорт-1', subjects: ['Укр'], entries: names.map((n) => ({ fullName: n, subjects: { 'Укр': 10 } })) });
  let r = await adminApi('PUT', '/api/admin/rating/import', body(['Перший Студент Імпортович', 'Другий Студент Імпортович']));
  assert.equal(r.data.created, 2);
  r = await adminApi('PUT', '/api/admin/rating/import', body(['Перший Студент Імпортович']));
  assert.equal(r.data.deactivated, 1);
  assert.equal(await db.collection('navsrating').countDocuments({ group: 'Імпорт-1' }), 2);
});

test('вихід і зміна пароля завершують сеанси; скидання пароля адміністратором', async () => {
  assert.equal((await api('POST', '/api/auth/logout', { token: tokens.a2 })).status, 200);
  assert.equal((await api('GET', '/api/sync', { token: tokens.a2 })).status, 401);
  assert.equal((await api('GET', '/api/sync', { token: tokens.a })).status, 200);
  const changed = await api('POST', '/api/auth/password', { token: tokens.a, body: { currentPassword: PASS, newPassword: 'Ще надійніший пароль' } });
  assert.equal(changed.status, 200);
  assert.equal((await api('GET', '/api/sync', { token: tokens.a })).status, 401);
  assert.equal((await api('GET', '/api/sync', { token: changed.data.token })).status, 200);

  const reset = await adminApi('POST', `/api/admin/users/${ids.b}/reset-password`);
  assert.equal(reset.status, 200);
  assert.match(reset.data.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal((await api('GET', '/api/sync', { token: tokens.b })).status, 401);
  let r = await api('POST', '/api/auth/login', { body: { fullName: B, password: PASS, deviceId: 'dev-b1' } });
  assert.equal(r.status, 403);
  r = await api('POST', '/api/auth/login', { body: { fullName: B, password: reset.data.code.toLowerCase(), deviceId: 'dev-b1' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.hasPassword, false);
  r = await api('POST', '/api/auth/password', { token: r.data.token, body: { newPassword: 'Новий пароль Коваля' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.hasPassword, true);
});
