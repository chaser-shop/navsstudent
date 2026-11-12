'use strict';
/*
 * Рейтинг: запис у базу даних.
 *  - міграція наявних записів і початкова історія (baseline);
 *  - підвищення бала студентом (атомарно, з журналом);
 *  - редагування, імпорт файлу, видалення адміністратором;
 *  - автоматична синхронізація з Google-таблицею, історія синхронізацій, конфлікти;
 *  - щоденні push-сповіщення про прогрес.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./rating-core');
const stats = require('./stats');
const sheets = require('./sheets');
const { makeClock } = require('./time');

const ERROR_RUN_COLLAPSE_MS = 6 * 3600 * 1000;

module.exports = function createRatingService(ctx) {
  const { HttpError, cfg } = ctx;
  const clock = makeClock(cfg.APP_TZ);
  const col = () => ctx.col;
  const uuid = () => crypto.randomUUID();
  const dupOk = (e) => {
    if (!(e && (e.code === 11000 || (e.writeErrors || []).every((w) => w.code === 11000)))) throw e;
  };

  // ───────── Транзакції ─────────
  // MongoDB Atlas (набір реплік) підтримує транзакції; на окремому сервері — послідовний запис із відкатом.
  let txnSupported = null;
  async function supportsTxn() {
    if (txnSupported === null) {
      try {
        const hello = await ctx.db.admin().command({ hello: 1 });
        txnSupported = !!(hello.setName || hello.msg === 'isdbgrid');
      } catch {
        txnSupported = false;
      }
    }
    return txnSupported;
  }
  async function withTxn(fn) {
    if (!(await supportsTxn())) return fn(undefined);
    const session = ctx.client.startSession();
    try {
      let out;
      await session.withTransaction(async () => { out = await fn(session); });
      return out;
    } finally {
      await session.endSession();
    }
  }

  // ───────── Предмети ─────────
  async function subjectList() {
    const { config, ratings } = col();
    const saved = await config.findOne({ _id: 'ratingSubjects' });
    const out = saved && Array.isArray(saved.value) ? [...saved.value] : [];
    const extra = await ratings.aggregate([
      { $project: { k: { $objectToArray: { $ifNull: ['$subjects', {}] } } } },
      { $unwind: '$k' },
      { $group: { _id: '$k.k' } },
    ]).toArray();
    for (const x of extra) if (!out.includes(x._id)) out.push(x._id);
    return out;
  }
  async function subjectNames() {
    const doc = await col().config.findOne({ _id: 'ratingSubjectNames' });
    return doc && doc.value && typeof doc.value === 'object' ? doc.value : {};
  }
  async function setSubjectNames(names) {
    const clean = {};
    const known = await subjectList();
    for (const [k, v] of Object.entries(names || {})) {
      if (!known.includes(k)) continue;
      const full = core.normName(v).slice(0, 80);
      if (full && full !== k) clean[k] = full;
    }
    await col().config.updateOne({ _id: 'ratingSubjectNames' }, { $set: { value: clean } }, { upsert: true });
    return clean;
  }

  const ensureGroup = (name) => col().groups.updateOne({ _id: name }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });

  const stripUndefined = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
  // Запис журналу змін. extra: source, at, userId, userName, syncRunId, note, _id (для ідемпотентних записів).
  function makeHistory(doc, h, extra) {
    const value = h.value == null ? null : h.value;
    const previous = h.previous == null ? null : h.previous;
    return stripUndefined({
      _id: uuid(), ratingId: doc._id, group: doc.group, studentName: doc.fullName, kind: 'score',
      subject: h.subject, previous, value, delta: previous != null && value != null ? core.round2(value - previous) : null,
      ...extra,
    });
  }
  const statusDoc = (doc, active, extra) => stripUndefined({
    _id: uuid(), ratingId: doc._id, group: doc.group, studentName: doc.fullName, kind: 'status', active, ...extra,
  });

  // ───────── Ініціалізація, початкові дані, міграція ─────────
  async function ensureIndexes() {
    const { ratings, history, syncRuns, conflicts, activity, users } = col();
    await ratings.createIndex({ group: 1, nameKey: 1 }, { unique: true });
    await ratings.createIndex({ nameKey: 1 });
    await history.createIndex({ ratingId: 1, at: 1 });
    await history.createIndex({ at: -1 });
    await history.createIndex({ source: 1, at: -1 });
    await history.createIndex({ group: 1, at: -1 });
    await syncRuns.createIndex({ startedAt: -1 });
    await conflicts.createIndex({ status: 1, detectedAt: -1 });
    await activity.createIndex({ day: 1 });
    await activity.createIndex({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });
    await users.createIndex({ studentId: 1 }, { sparse: true });
  }

  // Одноразовий безпечний імпорт першої таблиці (seed/rating-101-spd.json). Наявні записи не перезаписує.
  async function seedRating() {
    const { config, ratings } = col();
    const KEY = 'ratingSeed101spd';
    let seed;
    try { seed = JSON.parse(fs.readFileSync(path.join(cfg.ROOT_DIR, 'seed', 'rating-101-spd.json'), 'utf8')); } catch { return; }
    if (Array.isArray(seed.subjects) && seed.subjects.length) {
      await config.updateOne({ _id: 'ratingSubjects' }, { $setOnInsert: { value: seed.subjects } }, { upsert: true });
    }
    if (await config.findOne({ _id: KEY })) return;
    const now = new Date();
    let added = 0;
    for (const e of seed.entries || []) {
      const entry = { fullName: core.normName(e.fullName), nameKey: core.ratingKey(e.fullName), note: e.note || '', remark: '', subjects: e.subjects || {} };
      const doc = { _id: uuid(), ...core.recordFromEntry(entry, Object.keys(entry.subjects), seed.group, now, 'seed') };
      try { await ratings.insertOne(doc); added++; } catch (err) { dupOk(err); }
    }
    await ensureGroup(seed.group);
    await config.updateOne({ _id: KEY }, { $set: { value: { at: now, added } } }, { upsert: true });
    if (added) console.log(`Рейтинг: початково імпортовано ${added} студентів групи «${seed.group}».`);
  }

  // Міграція v1: версія запису, джерело кожного бала, прапорець активності та початкова історія.
  async function migrate() {
    const { config, ratings, history } = col();
    const KEY = 'migration:rating-history-v1';
    if (await config.findOne({ _id: KEY })) return;
    const now = new Date();
    const docs = await ratings.find({}).toArray();
    for (const d of docs) {
      const origin = d.origin || (d.source === 'google-sheets' ? 'sheet' : d.source === 'import' ? 'import' : d.source ? 'seed' : 'admin');
      const set = {};
      if (d.version == null) set.version = 1;
      if (d.active == null) set.active = true;
      if (!d.origin) set.origin = origin;
      if (!d.subjectMeta) {
        const metaSource = origin === 'admin' ? 'admin' : origin === 'sheet' ? 'sheet' : 'import';
        // Без поля sheet: перша синхронізація звірить ці значення з таблицею як із новими.
        set.subjectMeta = Object.fromEntries(Object.keys(d.subjects || {}).map((s) => [s, { source: metaSource, at: d.updatedAt || now }]));
      }
      if (Object.keys(set).length) await ratings.updateOne({ _id: d._id }, { $set: set });
      const base = Object.entries(d.subjects || {})
        .filter(([, v]) => typeof v === 'number')
        .map(([s, v]) => makeHistory(d, { subject: s, previous: null, value: v }, { _id: `baseline|${d._id}|${s}`, source: 'baseline', at: now }));
      if (base.length) await history.insertMany(base, { ordered: false }).catch(dupOk);
    }
    await config.updateOne({ _id: KEY }, { $set: { value: { at: now, records: docs.length } } }, { upsert: true });
    if (docs.length) console.log(`Міграція рейтингу: оновлено ${docs.length} записів, створено початкову історію балів.`);
  }

  async function init() {
    await ensureIndexes();
    await seedRating();
    await migrate();
  }

  // ───────── Підвищення бала студентом ─────────
  const increaseLog = new Map();
  function limitIncreases(userId) {
    const now = Date.now();
    const list = (increaseLog.get(userId) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (list.length >= 30) throw new HttpError(429, 'Забагато змін за короткий час. Спробуйте за кілька хвилин.');
    list.push(now);
    increaseLog.set(userId, list);
  }
  setInterval(() => increaseLog.clear(), 3600 * 1000).unref();

  async function increaseScore(user, body) {
    if (!user.passwordHash) {
      throw new HttpError(403, 'Спершу створіть пароль у профілі — він захищає ваші бали від чужих змін.', { code: 'password_setup_required' });
    }
    if (!user.studentId) {
      throw new HttpError(403, 'Ваш акаунт ще не прив’язано до запису в рейтингу. Зверніться до адміністратора.', { code: 'not_linked' });
    }
    const subject = String(body.subject == null ? '' : body.subject).trim().slice(0, 40);
    if (!subject) throw new HttpError(400, 'Оберіть предмет.');
    limitIncreases(user._id);
    const { ratings, history } = col();
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await ratings.findOne({ _id: user.studentId });
      if (!doc) throw new HttpError(404, 'Ваш запис у рейтингу не знайдено. Зверніться до адміністратора.', { code: 'not_linked' });
      if (doc.active === false) throw new HttpError(409, 'Ваш запис зараз неактивний (його немає в таблиці рейтингу). Зверніться до адміністратора.');
      const subjects = doc.subjects || {};
      if (!Object.prototype.hasOwnProperty.call(subjects, subject) && !(await subjectList()).includes(subject)) {
        throw new HttpError(400, 'Такого предмета немає в рейтингу.');
      }
      const current = typeof subjects[subject] === 'number' ? subjects[subject] : null;
      if (body.expected !== undefined && body.expected !== null && !core.sameNum(Number(body.expected), current)) {
        throw new HttpError(409, 'Ваш бал щойно змінився. Перевірте нове значення й спробуйте ще раз.', { code: 'stale', current });
      }
      const check = core.checkIncrease(current, body.value, cfg.SCORE_MAX);
      if (check.error) throw new HttpError(400, check.error, { code: 'invalid_value', current });

      const now = new Date();
      const nextSubjects = { ...subjects, [subject]: check.value };
      const points = core.sumPoints(nextSubjects);
      const prevMeta = (doc.subjectMeta || {})[subject];
      const entry = makeHistory(doc, { subject, previous: current, value: check.value }, {
        source: 'student', userId: user._id, userName: user.fullName, at: now,
      });
      const applied = await withTxn(async (session) => {
        const res = await ratings.updateOne(
          { _id: doc._id, version: doc.version == null ? null : doc.version, [`subjects.${subject}`]: current },
          {
            $set: {
              [`subjects.${subject}`]: check.value, points, updatedAt: now,
              [`subjectMeta.${subject}.source`]: 'student', [`subjectMeta.${subject}.at`]: now, [`subjectMeta.${subject}.by`]: user._id,
            },
            $inc: { version: 1 },
          },
          { session },
        );
        if (!res.matchedCount) return false;
        try {
          await history.insertOne(entry, { session });
        } catch (e) {
          if (!session) {
            // Без транзакції: повертаємо бал, щоб зміна без запису в журналі не залишилась.
            const restore = { [`subjects.${subject}`]: current, points: doc.points == null ? null : doc.points, updatedAt: doc.updatedAt || now };
            const update = prevMeta ? { $set: { ...restore, [`subjectMeta.${subject}`]: prevMeta }, $inc: { version: 1 } } : { $set: restore, $unset: { [`subjectMeta.${subject}`]: '' }, $inc: { version: 1 } };
            await ratings.updateOne({ _id: doc._id, version: (doc.version || 0) + 1 }, update).catch(() => {});
          }
          throw e;
        }
        return true;
      });
      if (applied) {
        return { ok: true, subject, previous: current, value: check.value, delta: entry.delta, points, at: now };
      }
    }
    throw new HttpError(409, 'Бал саме оновлюється з іншого джерела. Спробуйте ще раз.', { code: 'busy' });
  }

  // ───────── Дії адміністратора ─────────
  function cleanSubjectsInput(o) {
    const out = {};
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o).slice(0, 30)) {
        const key = core.cleanSubjectName(k);
        if (!key || v === null || v === undefined || v === '') continue;
        const val = core.parseScore(v);
        if (val == null) throw new HttpError(400, `Бал з предмета «${key}» має бути числом від 0 до ${core.MAX_POINTS}.`);
        out[key] = val;
      }
    }
    return out;
  }
  const cleanGroup = (v) => core.normName(v).slice(0, 40);
  const dupRating = (e) => { if (e && e.code === 11000) throw new HttpError(409, 'Цей студент уже є в рейтингу цієї групи.'); throw e; };

  function readRecordInfo(body, full) {
    const set = {};
    if (full || 'fullName' in body) {
      const n = core.normName(body.fullName);
      if (n.split(' ').length < 2 || n.length > 100) throw new HttpError(400, 'Введіть прізвище та ім’я (ПІБ).');
      set.fullName = n;
      set.nameKey = core.ratingKey(n);
    }
    if (full || 'group' in body) {
      const g = cleanGroup(body.group);
      if (!g) throw new HttpError(400, 'Оберіть групу.');
      set.group = g;
    }
    if ('note' in body) set.note = String(body.note == null ? '' : body.note).trim().slice(0, 60);
    return set;
  }

  async function adminCreateRecord(admin, body) {
    const info = readRecordInfo(body, true);
    const subjects = cleanSubjectsInput(body.subjects);
    const now = new Date();
    const doc = {
      _id: uuid(), ...core.recordFromEntry({ ...info, note: info.note || '', remark: '', subjects }, Object.keys(subjects), info.group, now, 'admin'),
    };
    const entries = Object.entries(subjects).map(([s, v]) => makeHistory(doc, { subject: s, previous: null, value: v }, {
      source: 'admin', userId: admin._id, userName: admin.fullName, at: now,
    }));
    await withTxn(async (session) => {
      try { await col().ratings.insertOne(doc, { session }); } catch (e) { dupRating(e); }
      if (entries.length) await col().history.insertMany(entries, { session });
    });
    await ensureGroup(doc.group);
    return { id: doc._id };
  }

  async function adminUpdateRecord(admin, id, body) {
    const { ratings, history, users } = col();
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = await ratings.findOne({ _id: id });
      if (!doc) throw new HttpError(404, 'Запис не знайдено.');
      const now = new Date();
      const set = { ...readRecordInfo(body, false), updatedAt: now };
      const unset = {};
      const entries = [];
      const current = doc.subjects || {};
      if ('subjects' in body) {
        const next = cleanSubjectsInput(body.subjects);
        for (const s of new Set([...Object.keys(current), ...Object.keys(next)])) {
          const prev = typeof current[s] === 'number' ? current[s] : null;
          const val = next[s] == null ? null : next[s];
          if (core.sameNum(prev, val)) continue;
          if (val == null) unset[`subjects.${s}`] = '';
          else set[`subjects.${s}`] = val;
          set[`subjectMeta.${s}.source`] = 'admin';
          set[`subjectMeta.${s}.at`] = now;
          set[`subjectMeta.${s}.by`] = admin._id;
          entries.push(makeHistory({ ...doc, ...set }, { subject: s, previous: prev, value: val }, {
            source: 'admin', userId: admin._id, userName: admin.fullName, at: now,
          }));
        }
        set.points = core.sumPoints(next);
      } else if ('points' in body) {
        // Сумісність зі старим клієнтом: окрему суму можна задати лише записам без балів за предметами.
        if (Object.keys(current).length) throw new HttpError(400, 'Загальна сума рахується автоматично з балів за предметами.');
        set.points = body.points === null || body.points === '' ? null : core.parseScore(body.points);
      }
      const update = { $set: set, $inc: { version: 1 } };
      if (Object.keys(unset).length) update.$unset = unset;
      let matched = false;
      await withTxn(async (session) => {
        let res;
        try { res = await ratings.updateOne({ _id: doc._id, version: doc.version == null ? null : doc.version }, update, { session }); } catch (e) { dupRating(e); }
        matched = res.matchedCount > 0;
        if (matched && entries.length) await history.insertMany(entries, { session });
      });
      if (!matched) continue;
      if (set.group) await ensureGroup(set.group);
      if (set.fullName) await users.updateMany({ studentId: doc._id }, { $set: { studentName: set.fullName } });
      return { ok: true, changes: entries.length };
    }
    throw new HttpError(409, 'Запис щойно змінився. Оновіть сторінку й спробуйте ще раз.');
  }

  async function adminDeleteRecord(id) {
    const { ratings, users, conflicts } = col();
    const res = await ratings.deleteOne({ _id: id });
    if (!res.deletedCount) throw new HttpError(404, 'Запис не знайдено.');
    // Історія змін лишається для аудиту; прив’язки акаунтів і відкриті конфлікти прибираємо.
    await users.updateMany({ studentId: id }, { $unset: { studentId: '', studentName: '' } });
    await conflicts.deleteMany({ ratingId: id, status: 'open' });
    return {};
  }

  async function revertChange(admin, historyId) {
    const { ratings, history } = col();
    const entry = await history.findOne({ _id: historyId });
    if (!entry) throw new HttpError(404, 'Зміну не знайдено.');
    if (entry.source !== 'student') throw new HttpError(400, 'Скасувати можна лише зміну, зроблену студентом.');
    if (entry.revertedAt) throw new HttpError(409, 'Цю зміну вже скасовано.');
    if (entry.previous == null) throw new HttpError(400, 'Немає попереднього значення для відновлення.');
    const doc = await ratings.findOne({ _id: entry.ratingId });
    if (!doc) throw new HttpError(404, 'Запис студента вже видалено.');
    const cur = (doc.subjects || {})[entry.subject];
    if (!core.sameNum(cur, entry.value)) {
      throw new HttpError(409, `Бал уже змінився після цієї зміни (зараз ${cur == null ? 'немає' : cur}). Відредагуйте бал вручну.`);
    }
    const now = new Date();
    const nextSubjects = { ...doc.subjects, [entry.subject]: entry.previous };
    const revert = makeHistory(doc, { subject: entry.subject, previous: cur, value: entry.previous }, {
      source: 'admin', userId: admin._id, userName: admin.fullName, at: now, note: 'Скасування зміни студента', revertOf: entry._id,
    });
    const ok = await withTxn(async (session) => {
      const res = await ratings.updateOne(
        { _id: doc._id, version: doc.version == null ? null : doc.version },
        {
          $set: {
            [`subjects.${entry.subject}`]: entry.previous, points: core.sumPoints(nextSubjects), updatedAt: now,
            [`subjectMeta.${entry.subject}.source`]: 'admin', [`subjectMeta.${entry.subject}.at`]: now, [`subjectMeta.${entry.subject}.by`]: admin._id,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!res.matchedCount) return false;
      await history.insertOne(revert, { session });
      await history.updateOne({ _id: entry._id }, { $set: { revertedAt: now, revertedBy: admin._id, revertedByName: admin.fullName } }, { session });
      return true;
    });
    if (!ok) throw new HttpError(409, 'Запис щойно змінився. Оновіть сторінку й спробуйте ще раз.');
    return { ok: true };
  }

  // ───────── Злиття таблиці (синхронізація та імпорт файлу) ─────────
  async function upsertConflicts(doc, list, source, runId, now) {
    for (const c of list) {
      await col().conflicts.updateOne(
        { _id: `${doc._id}|${c.subject}` },
        {
          $set: {
            ratingId: doc._id, group: doc.group, studentName: doc.fullName, subject: c.subject, currentValue: c.current,
            currentSource: c.currentSource, sheetValue: c.sheet, source, runId, detectedAt: now, status: 'open',
          },
          $unset: { resolvedAt: '', resolvedBy: '', resolvedByName: '', resolution: '' },
        },
        { upsert: true },
      );
    }
  }
  async function settleConflicts(doc, subjects, now) {
    if (!subjects.length) return;
    await col().conflicts.updateMany(
      { _id: { $in: subjects.map((s) => `${doc._id}|${s}`) }, status: 'open' },
      { $set: { status: 'resolved', resolution: 'auto', resolvedAt: now } },
    );
  }

  /**
   * Застосовує розібрану таблицю до групи. Повертає лічильники змін.
   * mode: 'sheet' (Google-таблиця, відстежує останнє значення клітинки) або 'import' (файл від адміністратора).
   */
  async function applyTable(parsed, group, { mode, runId, actor }) {
    const { ratings, history } = col();
    const now = new Date();
    const origin = mode === 'sheet' ? 'sheet' : 'import';
    const extra = mode === 'sheet' ? { source: 'sheet', syncRunId: runId } : { source: 'import', userId: actor && actor._id, userName: actor && actor.fullName };
    const counts = { created: 0, updated: 0, scoreChanges: 0, infoChanges: 0, deactivated: 0, reactivated: 0, conflicts: 0, deferred: 0, warnings: [] };
    const docs = await ratings.find({ group }).toArray();
    const byKey = new Map(docs.map((d) => [d.nameKey, d]));

    for (const entry of parsed.entries) {
      let doc = byKey.get(entry.nameKey);
      if (!doc) {
        const fresh = { _id: uuid(), ...core.recordFromEntry(entry, parsed.subjects, group, now, origin) };
        const entries = Object.entries(fresh.subjects).map(([s, v]) => makeHistory(fresh, { subject: s, previous: null, value: v }, { ...extra, at: now }));
        try {
          await withTxn(async (session) => {
            await ratings.insertOne(fresh, { session });
            if (entries.length) await history.insertMany(entries, { session });
          });
          counts.created++;
          counts.scoreChanges += entries.length;
        } catch (e) {
          if (e && e.code === 11000) counts.deferred++;
          else throw e;
        }
        continue;
      }
      let done = false;
      for (let attempt = 0; attempt < 3 && doc && !done; attempt++) {
        const plan = core.planSheetMerge(doc, entry, parsed.subjects, now, { source: origin, trackSheet: mode === 'sheet' });
        if (!plan.changed) {
          if (plan.conflicts.length) {
            await upsertConflicts(doc, plan.conflicts, origin, runId, now);
            counts.conflicts += plan.conflicts.length;
          }
          done = true;
          break;
        }
        const named = { ...doc, fullName: plan.set.fullName || doc.fullName };
        const entries = plan.history.map((h) => makeHistory(named, h, { ...extra, at: now }));
        if (plan.reactivated) entries.push(statusDoc(named, true, { ...extra, at: now }));
        const update = { $set: { ...plan.set, updatedAt: now }, $inc: { version: 1 } };
        if (plan.unset.length) update.$unset = Object.fromEntries(plan.unset.map((p) => [p, '']));
        const applied = await withTxn(async (session) => {
          const res = await ratings.updateOne({ _id: doc._id, version: doc.version == null ? null : doc.version }, update, { session });
          if (!res.matchedCount) return false;
          if (entries.length) await history.insertMany(entries, { session });
          return true;
        });
        if (!applied) { doc = await ratings.findOne({ _id: doc._id }); continue; }
        done = true;
        if (plan.history.length) { counts.updated++; counts.scoreChanges += plan.history.length; }
        if (plan.infoChanged) counts.infoChanges++;
        if (plan.reactivated) counts.reactivated++;
        if (plan.conflicts.length) await upsertConflicts(named, plan.conflicts, origin, runId, now);
        counts.conflicts += plan.conflicts.length;
        await settleConflicts(doc, plan.settled, now);
        if (plan.set.fullName) await col().users.updateMany({ studentId: doc._id }, { $set: { studentName: plan.set.fullName } });
      }
      if (!done) counts.deferred++;
    }

    // Студенти, яких більше немає в таблиці, не видаляються: запис деактивується, історія зберігається.
    const present = new Set(parsed.entries.map((e) => e.nameKey));
    const tracked = docs.filter((d) => d.active !== false && (mode === 'import' || d.origin !== 'admin'));
    const missing = tracked.filter((d) => !present.has(d.nameKey));
    if (missing.length && missing.length > Math.max(3, Math.floor(tracked.length / 2))) {
      counts.warnings.push(`У таблиці бракує ${missing.length} із ${tracked.length} студентів — деактивацію пропущено, щоб не втратити дані через тимчасову помилку таблиці.`);
    } else {
      for (const d of missing) {
        await withTxn(async (session) => {
          const res = await ratings.updateOne({ _id: d._id, active: { $ne: false } }, { $set: { active: false, missingSince: now, updatedAt: now }, $inc: { version: 1 } }, { session });
          if (res.matchedCount) await history.insertOne(statusDoc(d, false, { ...extra, at: now }), { session });
        });
        counts.deactivated++;
      }
    }
    await ensureGroup(group);
    return counts;
  }

  async function importTable(admin, body) {
    const subjList = [];
    for (const raw of Array.isArray(body.subjects) ? body.subjects.slice(0, 30) : []) {
      const k = core.cleanSubjectName(raw);
      if (k && !subjList.includes(k)) subjList.push(k);
    }
    if (!subjList.length) throw new HttpError(400, 'У таблиці немає предметів.');
    if (!Array.isArray(body.entries) || !body.entries.length) throw new HttpError(400, 'У таблиці немає студентів.');
    if (body.entries.length > 1000) throw new HttpError(400, 'Забагато студентів у файлі.');
    const group = cleanGroup(body.group) || cfg.GOOGLE_SHEET_GROUP || 'Без групи';
    const byKey = new Map();
    for (const raw of body.entries) {
      const fullName = core.normName(raw && raw.fullName);
      if (fullName.split(' ').length < 2 || fullName.length > 100) continue;
      const nameKey = core.ratingKey(fullName);
      if (byKey.has(nameKey)) continue;
      const subjects = {};
      for (const [k, v] of Object.entries(cleanSubjectsInput(raw.subjects))) if (subjList.includes(k)) subjects[k] = v;
      byKey.set(nameKey, { fullName, nameKey, note: String(raw.note || '').slice(0, 60), remark: '', subjects });
    }
    if (!byKey.size) throw new HttpError(400, 'У таблиці не знайдено жодного коректного ПІБ.');
    const counts = await applyTable({ subjects: subjList, entries: [...byKey.values()] }, group, { mode: 'import', actor: admin });
    const known = await subjectList();
    await col().config.updateOne({ _id: 'ratingSubjects' }, { $set: { value: [...subjList, ...known.filter((s) => !subjList.includes(s))] } }, { upsert: true });
    return { ok: true, group, students: byKey.size, subjects: subjList.length, ...counts };
  }

  // ───────── Синхронізація з Google-таблицею ─────────
  const SYNC_STATE = 'googleRatingSync';
  const syncEnabled = () => !!(cfg.GOOGLE_SHEET_ID || cfg.GOOGLE_SHEET_CSV_URL);
  const syncMode = () => (cfg.GOOGLE_SHEET_CSV_URL ? 'csv-url' : cfg.GOOGLE_SERVICE_ACCOUNT_JSON ? 'service-account' : 'public');
  let syncBusy = false;
  let nextSyncAt = null;
  let timer = null;

  async function getSyncState() {
    const doc = await col().config.findOne({ _id: SYNC_STATE });
    return (doc && doc.value) || {};
  }
  async function saveSyncState(state) {
    await col().config.updateOne({ _id: SYNC_STATE }, { $set: { value: state } }, { upsert: true });
  }

  // Захист від одночасного запуску на кількох екземплярах сервера.
  const leaseOwner = uuid();
  async function acquireLease() {
    const now = new Date();
    try {
      const res = await col().config.findOneAndUpdate(
        { _id: 'syncLease', $or: [{ until: { $lt: now } }, { until: { $exists: false } }] },
        { $set: { until: new Date(now.getTime() + 3 * 60 * 1000), owner: leaseOwner } },
        { upsert: true, returnDocument: 'after' },
      );
      const doc = res && res.value !== undefined ? res.value : res;
      return !!doc && doc.owner === leaseOwner;
    } catch (e) {
      if (e && e.code === 11000) return false;
      throw e;
    }
  }
  const releaseLease = () => col().config.updateOne({ _id: 'syncLease', owner: leaseOwner }, { $set: { until: new Date(0) } }).catch(() => {});

  async function recordRun(run) {
    const { syncRuns } = col();
    if (run.status === 'error') {
      // Однакові помилки поспіль не засмічують історію: оновлюємо останній запис.
      const last = await syncRuns.find({}).sort({ startedAt: -1 }).limit(1).next();
      if (last && last.status === 'error' && last.error === run.error && Date.now() - +last.startedAt < ERROR_RUN_COLLAPSE_MS) {
        await syncRuns.updateOne({ _id: last._id }, { $set: { lastAt: run.finishedAt }, $inc: { repeats: 1 } });
        return;
      }
    }
    await syncRuns.insertOne(run);
  }

  async function runSync({ trigger = 'auto', user = null } = {}) {
    if (!syncEnabled()) return { status: 'disabled' };
    if (syncBusy) return { status: 'busy' };
    syncBusy = true;
    const startedAt = new Date();
    const group = cfg.GOOGLE_SHEET_GROUP;
    const run = {
      _id: uuid(), startedAt, trigger, group, mode: syncMode(),
      ...(user ? { userId: user._id, userName: user.fullName } : {}),
    };
    let leased = false;
    try {
      leased = await acquireLease();
      if (!leased) return { status: 'busy' };
      const prev = await getSyncState();
      const { grid, mode, endpoint } = await sheets.readSheetGrid({
        sheetId: cfg.GOOGLE_SHEET_ID, gid: cfg.GOOGLE_SHEET_GID, credentialsJson: cfg.GOOGLE_SERVICE_ACCOUNT_JSON, csvUrl: cfg.GOOGLE_SHEET_CSV_URL,
      });
      const hash = sheets.gridHash(grid);
      const parsed = core.parseRatingGrid(grid);
      if (parsed.entries.length > 1000) throw new Error('У таблиці понад 1000 студентів — синхронізацію зупинено.');
      const finishedAt = new Date();
      const base = {
        ...prev, enabled: true, mode, endpoint, group, lastAttemptAt: startedAt, lastSuccessAt: finishedAt,
        lastError: '', students: parsed.entries.length, subjects: parsed.subjects.length, subjectList: parsed.subjects,
        checks: (prev.checks || 0) + 1,
      };
      if (trigger === 'auto' && prev.contentHash === hash && prev.lastSuccessAt) {
        await saveSyncState(base);
        return { status: 'unchanged', ...base };
      }
      const counts = await applyTable(parsed, group, { mode: 'sheet', runId: run._id });
      const known = await subjectList();
      await col().config.updateOne({ _id: 'ratingSubjects' }, { $set: { value: [...parsed.subjects, ...known.filter((s) => !parsed.subjects.includes(s))] } }, { upsert: true });
      const changed = counts.created + counts.updated + counts.infoChanges + counts.deactivated + counts.reactivated + counts.conflicts;
      Object.assign(run, {
        status: changed ? 'success' : 'unchanged', finishedAt: new Date(), durationMs: Date.now() - +startedAt,
        endpoint, students: parsed.entries.length, subjects: parsed.subjects.length, skippedRows: parsed.skipped, ...counts,
      });
      if (counts.deferred) run.status = 'partial';
      const state = {
        ...base, contentHash: counts.deferred ? '' : hash, lastRunId: run._id,
        ...(changed ? { lastChangeAt: run.finishedAt } : {}),
        totals: {
          created: ((prev.totals || {}).created || 0) + counts.created,
          updated: ((prev.totals || {}).updated || 0) + counts.updated,
          scoreChanges: ((prev.totals || {}).scoreChanges || 0) + counts.scoreChanges,
        },
      };
      await saveSyncState(state);
      if (trigger !== 'auto' || changed || counts.deferred || counts.warnings.length || !prev.lastSuccessAt) await recordRun(run);
      if (changed) console.log(`Google Таблиця: нових ${counts.created}, оновлено ${counts.updated}, змін балів ${counts.scoreChanges}, конфліктів ${counts.conflicts}.`);
      return { ...state, ...run };
    } catch (error) {
      const message = String((error && error.message) || error).slice(0, 500);
      const finishedAt = new Date();
      Object.assign(run, { status: 'error', error: message, finishedAt, durationMs: Date.now() - +startedAt });
      const prev = await getSyncState().catch(() => ({}));
      const state = { ...prev, enabled: true, mode: syncMode(), group, lastAttemptAt: startedAt, lastError: message, lastErrorAt: finishedAt };
      await saveSyncState(state).catch(() => {});
      await recordRun(run).catch(() => {});
      console.error('Синхронізація Google-таблиці:', message);
      return { ...state, ...run };
    } finally {
      if (leased) await releaseLease();
      syncBusy = false;
    }
  }

  function scheduleSync(delay) {
    if (!syncEnabled()) return;
    clearTimeout(timer);
    nextSyncAt = new Date(Date.now() + delay);
    timer = setTimeout(async () => {
      try { await runSync({ trigger: 'auto' }); } catch (e) { console.error('Синхронізація:', e); }
      scheduleSync(cfg.GOOGLE_SHEET_INTERVAL_MS);
    }, delay);
    timer.unref();
  }

  async function resolveConflict(admin, id, action) {
    const { conflicts, ratings, history } = col();
    const c = await conflicts.findOne({ _id: id });
    if (!c || c.status !== 'open') throw new HttpError(404, 'Конфлікт уже вирішено або не знайдено.');
    const now = new Date();
    if (action === 'sheet') {
      const doc = await ratings.findOne({ _id: c.ratingId });
      if (!doc) throw new HttpError(404, 'Запис студента вже видалено.');
      const cur = (doc.subjects || {})[c.subject];
      const value = c.sheetValue;
      const next = { ...doc.subjects };
      if (value == null) delete next[c.subject]; else next[c.subject] = value;
      const entry = makeHistory(doc, { subject: c.subject, previous: cur == null ? null : cur, value }, {
        source: 'admin', userId: admin._id, userName: admin.fullName, at: now, note: 'Прийнято значення з таблиці (конфлікт)',
      });
      const set = {
        points: core.sumPoints(next), updatedAt: now,
        [`subjectMeta.${c.subject}.source`]: 'sheet', [`subjectMeta.${c.subject}.at`]: now, [`subjectMeta.${c.subject}.by`]: admin._id,
      };
      const update = { $set: set, $inc: { version: 1 } };
      if (value == null) update.$unset = { [`subjects.${c.subject}`]: '' }; else set[`subjects.${c.subject}`] = value;
      const ok = await withTxn(async (session) => {
        const res = await ratings.updateOne({ _id: doc._id, version: doc.version == null ? null : doc.version }, update, { session });
        if (!res.matchedCount) return false;
        if (!core.sameNum(cur == null ? null : cur, value)) await history.insertOne(entry, { session });
        return true;
      });
      if (!ok) throw new HttpError(409, 'Запис щойно змінився. Оновіть сторінку й спробуйте ще раз.');
    } else if (action !== 'keep') {
      throw new HttpError(400, 'Невідома дія.');
    }
    await conflicts.updateOne({ _id: id }, { $set: { status: 'resolved', resolution: action, resolvedAt: now, resolvedBy: admin._id, resolvedByName: admin.fullName } });
    return { ok: true };
  }

  // ───────── Щоденні сповіщення про прогрес ─────────
  async function progressTick() {
    const now = Date.now();
    if (clock.hour(now) < cfg.PROGRESS_HOUR) return;
    const key = `progress|${clock.dayKey(now)}`;
    if (!(await ctx.claim(key))) return;
    try {
      const { users, pushSubs, ratings, history } = col();
      const linked = await users.find({ studentId: { $type: 'string', $ne: '' } }).toArray();
      if (!linked.length) return;
      const subs = (await pushSubs.find({ userId: { $in: linked.map((u) => u._id) }, 'settings.notificationsEnabled': true }).toArray())
        .filter((s) => !s.settings || s.settings.notifyProgress !== false);
      if (!subs.length) return;
      const names = await subjectNames();
      const byGroup = new Map();
      let sent = 0;
      for (const u of linked) {
        const mine = subs.filter((s) => s.userId === u._id);
        if (!mine.length) continue;
        const doc = await ratings.findOne({ _id: u.studentId });
        if (!doc || doc.active === false) continue;
        if (!byGroup.has(doc.group)) {
          const records = await ratings.find({ group: doc.group }).project({ _id: 1 }).toArray();
          const events = await history.find({ ratingId: { $in: records.map((r) => r._id) } }).sort({ at: 1, _id: 1 }).toArray();
          byGroup.set(doc.group, events);
        }
        const { items } = stats.buildInsights({ events: byGroup.get(doc.group), meId: doc._id, now, clock, subjectName: (s) => names[s] || s });
        const real = items.filter((i) => i.tone === 'up' || i.tone === 'down');
        if (!real.length) continue;
        const payload = {
          title: 'Ваш прогрес за день',
          body: real.slice(0, 2).map((i) => i.text).join(' ').slice(0, 240),
          tag: `progress-${clock.dayKey(now)}`,
          data: { url: '/progress' },
          ttl: 6 * 3600,
        };
        const res = await Promise.all(mine.map((s) => ctx.sendPush(s, payload)));
        sent += res.filter((r) => r.ok).length;
      }
      if (sent) console.log(`Сповіщення про прогрес: доставлено ${sent}.`);
    } catch (e) {
      console.error('progressTick:', e);
    }
  }

  function start() {
    if (syncEnabled()) {
      scheduleSync(2000);
      console.log(`Синхронізація з Google-таблицею: кожні ${Math.round(cfg.GOOGLE_SHEET_INTERVAL_MS / 60000)} хв (${{ public: 'публічний доступ за посиланням', 'service-account': 'сервісний акаунт', 'csv-url': 'опублікований CSV' }[syncMode()]}).`);
    }
    setInterval(() => { progressTick(); }, 60 * 1000).unref();
  }

  return {
    clock, init, start, withTxn, subjectList, subjectNames, setSubjectNames, ensureGroup, cleanGroup,
    increaseScore, adminCreateRecord, adminUpdateRecord, adminDeleteRecord, revertChange, importTable,
    runSync, getSyncState, resolveConflict, progressTick,
    syncInfo: () => ({ enabled: syncEnabled(), mode: syncMode(), busy: syncBusy, nextRunAt: nextSyncAt, intervalMs: cfg.GOOGLE_SHEET_INTERVAL_MS }),
  };
};
