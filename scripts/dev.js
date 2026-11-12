'use strict';
// Локальний запуск без MongoDB Atlas: тимчасова база даних у пам’яті + сервер щоденника.
//   npm run dev            — порожня база; рейтинг підтягнеться з Google-таблиці
//   npm run dev -- --demo  — ще й демо-акаунти та історія змін за минулі тижні (лише для локальної перевірки,
//                            дані зникають після зупинки; у робочу базу нічого не потрапляє)

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEMO_ADMIN = 'Адміністратор Демо Тестовий';
const DEMO_STUDENT = 'Кіянченко Нікіта Олександрович';
const DEMO_PASSWORD = 'demo-password-1';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* ще не готово */ } await wait(400); }
  return false;
}

async function seedDemo(base, uri, dbName, adminPassword) {
  const { MongoClient } = require('mongodb');
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${p}: ${data.error || res.status}`);
    return data;
  };
  await until(async () => (await fetch(`${base}/healthz`)).ok, 30000);
  const client = await MongoClient.connect(uri);
  const db = client.db(dbName);
  const synced = await until(async () => !!(await db.collection('config').findOne({ _id: 'googleRatingSync', 'value.lastSuccessAt': { $exists: true } })), 60000);
  if (!synced) console.warn('Демо: Google-таблиця недоступна, використовую початкові дані з seed/.');
  const admin = await call('POST', '/api/auth/register', { fullName: DEMO_ADMIN, password: DEMO_PASSWORD, deviceId: 'demo-admin', adminPassword });
  const student = await call('POST', '/api/auth/register', { fullName: DEMO_STUDENT, password: DEMO_PASSWORD, deviceId: 'demo-student' });
  const record = await db.collection('navsrating').findOne({ nameKey: DEMO_STUDENT.toLocaleLowerCase('uk') });
  if (!record) throw new Error('у рейтингу немає демо-студента');
  await call('POST', `/api/admin/users/${student.user.id}/student`, { studentId: record._id }, admin.token);

  // Історія за 4 тижні: проміжні значення нижчі за поточні, тож графіки показують реальну динаміку до сьогодні.
  const records = await db.collection('navsrating').find({ group: record.group }).toArray();
  const day = 24 * 3600 * 1000;
  const offsets = [27, 20, 13, 6, 2, 1];
  const rnd = (seed) => { const h = crypto.createHash('sha1').update(seed).digest(); return h[0] / 255; };
  const docs = [];
  for (const r of records) {
    for (const [subject, value] of Object.entries(r.subjects || {})) {
      offsets.forEach((ago, k) => {
        const share = 0.55 + (0.42 * (k + rnd(`${r._id}${subject}${k}`))) / offsets.length;
        docs.push({
          _id: crypto.randomUUID(), ratingId: r._id, group: r.group, studentName: r.fullName, kind: 'score', subject,
          previous: null, value: Math.max(0, Math.round(value * Math.min(1, share))), delta: null, source: 'sheet',
          at: new Date(Date.now() - ago * day - 3600 * 1000 * (8 + k)), note: 'Демонстраційні дані',
        });
      });
    }
  }
  if (docs.length) await db.collection('ratingHistory').insertMany(docs);
  const subject = Object.keys(record.subjects || {})[0];
  if (subject) {
    await call('POST', '/api/me/scores/increase', { subject, value: Math.min(100, record.subjects[subject] + 5), expected: record.subjects[subject] }, student.token);
  }
  await client.close();
  console.log(`\nДемо готове: ${base}\n  Адміністратор: «${DEMO_ADMIN}», пароль ${DEMO_PASSWORD}\n  Студент: «${DEMO_STUDENT}», пароль ${DEMO_PASSWORD}\n`);
}

(async () => {
  let MongoMemoryReplSet;
  try { ({ MongoMemoryReplSet } = require('mongodb-memory-server')); } catch {
    console.error('Спершу встановіть залежності для розробки: npm install');
    process.exit(1);
  }
  const demo = process.argv.includes('--demo');
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const port = process.env.PORT || '3000';
  const env = {
    ...process.env, PORT: port, MONGODB_URI: mongo.getUri(), DB_NAME: process.env.DB_NAME || 'navs_dev', KEEP_ALIVE: '0',
    ADMIN_NAMES: process.env.ADMIN_NAMES || DEMO_ADMIN, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin-dev',
    VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:dev@navs.dev',
  };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'inherit' });
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    await mongo.stop().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  child.on('exit', (code) => stop(code || 0));
  if (demo) await seedDemo(`http://127.0.0.1:${port}`, mongo.getUri(), env.DB_NAME, env.ADMIN_PASSWORD).catch((e) => console.error('Демо-дані не створено:', e.message));
})();
