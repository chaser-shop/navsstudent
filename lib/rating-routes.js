'use strict';
/*
 * HTTP-маршрути рейтингу.
 * Студент працює лише зі своїм записом: ідентифікатор запису береться з облікового запису на сервері,
 * а не з тіла запиту, тож змінити чужі бали через API неможливо.
 */

const core = require('./rating-core');

module.exports = function registerRatingRoutes(ctx, service, reader) {
  const { route, HttpError } = ctx;
  const col = () => ctx.col;
  const ok = () => ({});
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const notLinked = () => new HttpError(404, 'Ваш акаунт ще не прив’язано до запису в рейтингу. Зверніться до адміністратора.', { code: 'not_linked' });

  async function myRecord(user) {
    return user.studentId ? col().ratings.findOne({ _id: user.studentId }) : null;
  }
  async function recordById(id) {
    const doc = await col().ratings.findOne({ _id: str(id, 64) });
    if (!doc) throw new HttpError(404, 'Студента не знайдено.');
    return doc;
  }

  // ───────── Особистий кабінет студента ─────────
  route('GET', '/api/me/overview', async ({ user }) => {
    const doc = await myRecord(user);
    if (!doc) {
      const state = await service.getSyncState();
      return { linked: false, needsPassword: !user.passwordHash, scoreMax: ctx.cfg.SCORE_MAX, lastSync: { at: state.lastSuccessAt || null } };
    }
    const out = await reader.overviewFor(doc);
    return { ...out, needsPassword: !user.passwordHash, canIncrease: !!user.passwordHash && out.student.active };
  });

  route('GET', '/api/me/stats', async ({ user, query }) => {
    const doc = await myRecord(user);
    if (!doc) throw notLinked();
    return reader.statsFor(doc, query);
  });

  route('GET', '/api/me/history', async ({ user, query }) => {
    const doc = await myRecord(user);
    if (!doc) throw notLinked();
    return reader.historyFor(doc._id, query);
  });

  // Тіло: { subject, value, expected }. Запис студента сервер визначає сам — за обліковим записом.
  route('POST', '/api/me/scores/increase', async ({ user, body }) => service.increaseScore(user, body));

  // ───────── Рейтинг групи ─────────
  route('GET', '/api/rating', async ({ user, query }) => reader.ratingTable(user, query));

  // ───────── Панель адміністратора ─────────
  route('GET', '/api/admin/dashboard', () => reader.dashboard(), { admin: true });
  route('GET', '/api/admin/analytics', ({ query }) => reader.analytics(query), { admin: true });
  route('GET', '/api/admin/students', ({ query }) => reader.students(query), { admin: true });
  route('GET', '/api/admin/students/:id', ({ params }) => reader.studentProfile(params.id), { admin: true });
  route('GET', '/api/admin/students/:id/stats', async ({ params, query }) => reader.statsFor(await recordById(params.id), query), { admin: true });
  route('GET', '/api/admin/students/:id/history', async ({ params, query }) => {
    const doc = await recordById(params.id);
    return reader.historyFor(doc._id, query, { admin: true });
  }, { admin: true });
  route('GET', '/api/admin/score-changes', ({ query }) => reader.scoreChanges(query), { admin: true });
  route('POST', '/api/admin/score-changes/:id/revert', ({ user, params }) => service.revertChange(user, str(params.id, 80)), { admin: true });

  route('GET', '/api/admin/sync', () => reader.syncOverview(), { admin: true });
  route('POST', '/api/admin/rating/sync', async ({ user }) => {
    const r = await service.runSync({ trigger: 'manual', user });
    if (r.status === 'disabled') throw new HttpError(400, 'Синхронізацію вимкнено: не вказано GOOGLE_SHEET_ID.');
    if (r.status === 'busy') throw new HttpError(409, 'Синхронізація вже виконується. Зачекайте кілька секунд.');
    if (r.status === 'error') throw new HttpError(502, r.error || 'Синхронізація не виконана.');
    return { ok: true, ...r };
  }, { admin: true });
  route('POST', '/api/admin/sync/conflicts/:id/resolve', ({ user, params, body }) => service.resolveConflict(user, str(params.id, 200), str(body.action, 10)), { admin: true });
  route('PUT', '/api/admin/rating/subject-names', async ({ body }) => ({ names: await service.setSubjectNames(body.names) }), { admin: true });

  // ───────── Записи рейтингу та групи ─────────
  route('GET', '/api/admin/rating-students', async () => {
    const rows = await col().ratings.find({}, { projection: { _id: 1, fullName: 1, group: 1, active: 1 } }).sort({ fullName: 1 }).toArray();
    return rows.map((r) => ({ id: r._id, fullName: r.fullName, group: r.group || '', active: r.active !== false }));
  }, { admin: true });

  // Прив’язка запису рейтингу до облікового запису (одна людина — один запис, один запис — один акаунт).
  route('POST', '/api/admin/users/:id/student', async ({ params, body }) => {
    const { users, ratings } = col();
    const account = await users.findOne({ _id: params.id });
    if (!account) throw new HttpError(404, 'Користувача не знайдено.');
    const studentId = str(body.studentId, 64);
    if (!studentId) {
      await users.updateOne({ _id: account._id }, { $unset: { studentId: '', studentName: '' } });
      return ok();
    }
    const student = await ratings.findOne({ _id: studentId });
    if (!student) throw new HttpError(404, 'Студента не знайдено в рейтингу. Спочатку оновіть таблицю рейтингу.');
    const other = await users.findOne({ studentId, _id: { $ne: account._id } });
    if (other) throw new HttpError(409, `Цей запис уже прив’язано до акаунта «${other.fullName}». Спершу відв’яжіть його.`);
    await users.updateOne({ _id: account._id }, { $set: { studentId: student._id, studentName: student.fullName } });
    return { ok: true, student: student.fullName };
  }, { admin: true });

  route('GET', '/api/admin/groups', () => reader.listGroups(), { admin: true });

  route('POST', '/api/admin/groups', async ({ body }) => {
    const name = service.cleanGroup(body.name);
    if (!name) throw new HttpError(400, 'Введіть назву групи.');
    await service.ensureGroup(name);
    return { name };
  }, { admin: true });

  route('PATCH', '/api/admin/groups', async ({ body }) => {
    const { ratings, users, groups } = col();
    const from = service.cleanGroup(body.from);
    const to = service.cleanGroup(body.to);
    if (!from || !to) throw new HttpError(400, 'Вкажіть стару й нову назву групи.');
    if (from === to) return ok();
    if ((await groups.findOne({ _id: to })) || (await ratings.countDocuments({ group: to }))) {
      throw new HttpError(409, `Група «${to}» уже існує. Оберіть іншу назву.`);
    }
    try {
      await ratings.updateMany({ group: from }, { $set: { group: to }, $inc: { version: 1 } });
    } catch (e) {
      if (e && e.code === 11000) throw new HttpError(409, 'У групі з новою назвою вже є студенти з такими самими ПІБ.');
      throw e;
    }
    await users.updateMany({ group: from }, { $set: { group: to } });
    await groups.deleteOne({ _id: from });
    await service.ensureGroup(to);
    return ok();
  }, { admin: true });

  route('DELETE', '/api/admin/groups/:name', async ({ params }) => {
    const { ratings, users, groups } = col();
    const name = service.cleanGroup(params.name);
    if ((await ratings.countDocuments({ group: name })) || (await users.countDocuments({ group: name }))) {
      throw new HttpError(409, 'Група не порожня: спершу видаліть її записи рейтингу (зокрема неактивні) і зніміть групу в учасників.');
    }
    await groups.deleteOne({ _id: name });
    return ok();
  }, { admin: true });

  route('POST', '/api/admin/rating', ({ user, body }) => service.adminCreateRecord(user, body), { admin: true });
  route('PATCH', '/api/admin/rating/:id', ({ user, params, body }) => service.adminUpdateRecord(user, str(params.id, 64), body), { admin: true });
  route('DELETE', '/api/admin/rating/:id', ({ params }) => service.adminDeleteRecord(str(params.id, 64)), { admin: true });
  // Таблиця, розібрана в браузері адміністратора (CSV/XLSX). Правила злиття — як у синхронізації.
  route('PUT', '/api/admin/rating/import', ({ user, body }) => service.importTable(user, body), { admin: true });

  route('POST', '/api/admin/users/:id/group', async ({ params, body }) => {
    const g = service.cleanGroup(body.group);
    const r = await col().users.updateOne({ _id: params.id }, g ? { $set: { group: g } } : { $unset: { group: '' } });
    if (!r.matchedCount) throw new HttpError(404, 'Користувача не знайдено.');
    if (g) await service.ensureGroup(g);
    return ok();
  }, { admin: true });

  return { ratingKey: core.ratingKey };
};
