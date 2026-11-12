'use strict';
/*
 * Рейтинг: читання й аналітика (студентський кабінет і панель адміністратора).
 * Усі числа рахуються з поточних записів і журналу змін — нічого не вигадується.
 */

const core = require('./rating-core');
const stats = require('./stats');
const sheets = require('./sheets');
const { DAY_MS } = require('./time');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const avg = (arr) => (arr.length ? core.round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = function createRatingReader(ctx, service) {
  const { HttpError, cfg } = ctx;
  const clock = service.clock;
  const col = () => ctx.col;

  async function loadScope(filter) {
    const { ratings, history } = col();
    const records = await ratings.find(filter).toArray();
    const ids = records.map((r) => r._id);
    const events = ids.length
      ? await history.find({ ratingId: { $in: ids } }, { projection: { ratingId: 1, kind: 1, subject: 1, value: 1, previous: 1, active: 1, at: 1, source: 1 } })
        .sort({ at: 1, _id: 1 }).toArray()
      : [];
    return { records, events };
  }

  /** Місця серед активних записів (за сумою або за предметом). */
  function rankMap(records, subject) {
    const list = records
      .filter((r) => r.active !== false)
      .map((r) => ({ id: r._id, fullName: r.fullName, points: subject ? (isNum((r.subjects || {})[subject]) ? r.subjects[subject] : null) : r.points }));
    const ranked = core.rankEntries(list).filter((e) => e.rank != null);
    return { ranks: new Map(ranked.map((e) => [e.id, e.rank])), size: ranked.length };
  }

  /** Предмети групи: ті, з яких хоча б хтось у групі має бал (у порядку загального списку). */
  function groupSubjectsOf(list, records) {
    const present = new Set();
    for (const r of records) for (const [k, v] of Object.entries(r.subjects || {})) if (isNum(v)) present.add(k);
    const out = list.filter((s) => present.has(s));
    for (const s of present) if (!out.includes(s)) out.push(s);
    return out;
  }

  function parsePeriod(query, firstAt, now) {
    const raw = String(query.get('period') || '30');
    let from;
    let period = raw;
    if (raw === 'all') {
      from = firstAt ? clock.startOfDay(+firstAt) : clock.startOfDay(now - 29 * DAY_MS);
    } else {
      const days = [7, 30, 90, 365].includes(+raw) ? +raw : 30;
      period = String(days);
      from = clock.startOfDay(now - (days - 1) * DAY_MS);
    }
    let unit = ['day', 'week', 'month'].includes(query.get('unit')) ? query.get('unit') : 'day';
    const span = (now - from) / DAY_MS;
    if (unit === 'day' && span > 120) unit = 'week';
    if (unit === 'week' && span > 7 * 104) unit = 'month';
    return { period, from, unit };
  }

  const lastSyncOf = (state) => ({
    at: state.lastSuccessAt || null,
    failing: !!state.lastError && (!state.lastSuccessAt || +new Date(state.lastErrorAt || 0) >= +new Date(state.lastSuccessAt)),
  });

  function historyItem(e, names, { admin } = {}) {
    return {
      id: e._id, ratingId: e.ratingId, studentName: e.studentName, group: e.group, subject: e.subject,
      subjectName: names[e.subject] || e.subject, previous: e.previous, value: e.value, delta: e.delta,
      percent: stats.pctChange(e.previous, e.value), source: e.source, at: e.at, note: e.note || '',
      reverted: !!e.revertedAt,
      ...(admin ? { userName: e.userName || '', revertedByName: e.revertedByName || '', revertedAt: e.revertedAt || null } : {}),
    };
  }

  // ───────── Студент ─────────
  async function overviewFor(doc) {
    const now = Date.now();
    const [{ records, events }, names, list, syncState] = await Promise.all([
      loadScope({ group: doc.group }), service.subjectNames(), service.subjectList(), service.getSyncState(),
    ]);
    const me = records.find((r) => r._id === doc._id) || doc;
    const active = records.filter((r) => r.active !== false);
    const total = rankMap(records);
    const myEvents = events.filter((e) => e.ratingId === me._id && e.kind !== 'status');
    const last = new Map();
    for (const e of myEvents) last.set(e.subject, e);
    const subjectName = (s) => names[s] || s;
    const subjects = groupSubjectsOf(list, records).map((s) => {
      const value = isNum((me.subjects || {})[s]) ? me.subjects[s] : null;
      const l = last.get(s);
      const r = rankMap(records, s);
      const vals = active.map((x) => (x.subjects || {})[s]).filter(isNum);
      const previous = l && l.source !== 'baseline' ? l.previous : null;
      return {
        key: s, name: subjectName(s), value, previous,
        delta: previous != null && value != null ? core.round2(value - previous) : null,
        percent: stats.pctChange(previous, value), changedAt: l ? l.at : null, source: l ? l.source : null,
        rank: r.ranks.get(me._id) || null, ranked: r.size, groupAvg: avg(vals), groupMax: vals.length ? Math.max(...vals) : null,
      };
    });
    const insights = stats.buildInsights({ events, meId: me._id, now, clock, subjectName });
    let progress = null;
    if (myEvents.length) {
      const since = +myEvents[0].at;
      const start = stats.stateAt(events, me._id, clock.startOfDay(since) + DAY_MS - 1);
      const startTotal = start ? core.sumPoints(start.subjects) : null;
      if (startTotal != null && me.points != null) {
        progress = { since, from: startTotal, to: me.points, delta: core.round2(me.points - startTotal), percent: stats.pctChange(startTotal, me.points) };
      }
    }
    const recent = myEvents.slice(-6).reverse().map((e) => ({
      subject: e.subject, subjectName: subjectName(e.subject), value: e.value, source: e.source, at: e.at,
    }));
    return {
      linked: true,
      student: { id: me._id, fullName: me.fullName, group: me.group, note: me.note || '', remark: me.remark || '', active: me.active !== false },
      total: me.points == null ? null : me.points,
      rank: total.ranks.get(me._id) || null,
      ranked: total.size,
      groupSize: active.length,
      groupAvg: avg(active.map((r) => r.points).filter(isNum)),
      subjects,
      scoreMax: cfg.SCORE_MAX,
      insights: insights.items,
      enoughData: insights.enoughData,
      progress,
      recent,
      lastSync: lastSyncOf(syncState),
    };
  }

  async function statsFor(doc, query) {
    const now = Date.now();
    const [{ records, events }, names, list] = await Promise.all([loadScope({ group: doc.group }), service.subjectNames(), service.subjectList()]);
    const me = records.find((r) => r._id === doc._id) || doc;
    const mine = events.filter((e) => e.ratingId === me._id);
    const firstAt = mine.length ? mine[0].at : null;
    const { period, from, unit } = parsePeriod(query, firstAt, now);
    const subjects = groupSubjectsOf(list, records);
    const active = records.filter((r) => r.active !== false);
    const series = stats.studentSeries({ events, meId: me._id, from, now, unit, clock });
    const progress = stats.subjectProgress({ events, meId: me._id, from, current: me.subjects || {}, subjects })
      .map((p) => ({ ...p, name: names[p.subject] || p.subject }));
    const comparison = subjects.map((s) => {
      const vals = active.map((r) => (r.subjects || {})[s]).filter(isNum);
      const mineVal = (me.subjects || {})[s];
      return { subject: s, name: names[s] || s, mine: isNum(mineVal) ? mineVal : null, avg: avg(vals), max: vals.length ? Math.max(...vals) : null };
    });
    const rankHistory = series.filter((p) => p.rank != null).length;
    return {
      period, unit, from, now, trackingSince: firstAt, series, progress, comparison, subjectNames: names,
      hasData: series.some((p) => p.total != null), rankPoints: rankHistory,
    };
  }

  async function historyFor(ratingId, query, opts = {}) {
    const limit = Math.min(200, Math.max(1, parseInt(query.get('limit'), 10) || 50));
    const before = query.get('before') ? new Date(query.get('before')) : null;
    const filter = { ratingId, kind: 'score' };
    if (before && !Number.isNaN(+before)) filter.at = { $lt: before };
    const [rows, names] = await Promise.all([
      col().history.find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray(),
      service.subjectNames(),
    ]);
    const items = rows.slice(0, limit).map((e) => historyItem(e, names, opts));
    return { items, more: rows.length > limit, next: items.length ? items[items.length - 1].at : null };
  }

  // ───────── Таблиця рейтингу групи ─────────
  async function listGroups() {
    const { groups, ratings, users } = col();
    const [named, rAgg, uAgg] = await Promise.all([
      groups.find({}).toArray(),
      ratings.aggregate([{ $group: { _id: '$group', n: { $sum: { $cond: [{ $eq: ['$active', false] }, 0, 1] } }, inactive: { $sum: { $cond: [{ $eq: ['$active', false] }, 1, 0] } } } }]).toArray(),
      users.aggregate([{ $match: { group: { $type: 'string', $ne: '' } } }, { $group: { _id: '$group', n: { $sum: 1 } } }]).toArray(),
    ]);
    const map = new Map();
    const get = (name) => { if (!map.has(name)) map.set(name, { name, students: 0, inactive: 0, accounts: 0 }); return map.get(name); };
    named.forEach((g) => get(g._id));
    rAgg.forEach((g) => { if (g._id) { get(g._id).students = g.n; get(g._id).inactive = g.inactive; } });
    uAgg.forEach((g) => { get(g._id).accounts = g.n; });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }

  async function ratingTable(user, query) {
    const { ratings } = col();
    const assigned = user.studentId ? await ratings.findOne({ _id: user.studentId }) : null;
    let own = assigned ? assigned.group : user.group || '';
    if (!own && user.isAdmin) {
      const byName = await ratings.findOne({ nameKey: core.ratingKey(user.fullName) });
      own = byName ? byName.group : '';
    }
    let group = own;
    let groups = null;
    if (user.isAdmin) {
      groups = await listGroups();
      group = service.cleanGroup(query.get('group') || '') || own || (groups[0] ? groups[0].name : '');
    }
    const [allSubjects, names, syncState] = await Promise.all([service.subjectList(), service.subjectNames(), service.getSyncState()]);
    const want = String(query.get('subject') || '').slice(0, 40);
    const extra = { lastSync: lastSyncOf(syncState), subjectNames: names, ...(user.isAdmin ? { syncStatus: { ...syncState, ...service.syncInfo() } } : {}) };
    if (!group || (!user.isAdmin && !assigned)) {
      return { group: '', own: '', groups, subjects: [], subject: '', entries: [], total: 0, me: null, unassigned: !user.isAdmin && !assigned, ...extra };
    }
    const rows = await ratings.find({ group, active: { $ne: false } }).toArray();
    const subjects = groupSubjectsOf(allSubjects, rows);
    const subject = subjects.includes(want) ? want : '';
    const ranked = core.rankEntries(subject
      ? rows.map((e) => ({ ...e, points: isNum((e.subjects || {})[subject]) ? e.subjects[subject] : null }))
      : rows);
    const meKey = core.ratingKey(user.fullName);
    const entries = ranked.map((e) => {
      const isMe = assigned ? String(e._id) === String(assigned._id) : !!user.isAdmin && e.nameKey === meKey;
      return {
        ...(user.isAdmin ? { id: e._id } : {}),
        rank: e.rank, fullName: e.fullName, points: e.points == null ? null : e.points, note: e.note || '', isMe,
        ...(isMe || user.isAdmin ? { subjects: e.subjects || {} } : {}),
      };
    });
    const me = entries.find((e) => e.isMe) || null;
    return { group, own, groups, subjects, subject, entries, total: entries.length, me: me && { rank: me.rank, points: me.points }, ...extra };
  }

  // ───────── Адміністратор ─────────
  async function dashboard() {
    const now = Date.now();
    const { users, history, conflicts } = col();
    const [{ records, events }, accounts, state, openConflicts, list, names, recentRows] = await Promise.all([
      loadScope({}),
      users.find({}, { projection: { fullName: 1, isAdmin: 1, studentId: 1, lastSeenAt: 1, createdAt: 1, pendingDevices: 1, role: 1 } }).toArray(),
      service.getSyncState(),
      conflicts.countDocuments({ status: 'open' }),
      service.subjectList(),
      service.subjectNames(),
      history.find({ source: { $ne: 'baseline' }, kind: 'score' }).sort({ at: -1, _id: -1 }).limit(12).toArray(),
    ]);
    const active = records.filter((r) => r.active !== false);
    const students = accounts.filter((u) => !u.isAdmin);
    const weekAgo = now - 7 * DAY_MS;
    const todayStart = clock.startOfDay(now);
    const a = stats.adminAnalytics({ records, events, subjects: list, from: clock.startOfDay(now - 6 * DAY_MS), now, unit: 'day', clock });
    const studentChanges7 = events.filter((e) => e.source === 'student' && +e.at >= weekAgo).length;
    const ids = new Set(active.map((r) => r._id));
    const newAccounts = students
      .filter((u) => u.createdAt && +u.createdAt >= weekAgo)
      .sort((x, y) => +y.createdAt - +x.createdAt)
      .slice(0, 6)
      .map((u) => ({ id: u._id, fullName: u.fullName, at: u.createdAt, linked: !!u.studentId }));
    return {
      kpi: {
        ratingStudents: active.length,
        inactiveStudents: records.length - active.length,
        accounts: students.length,
        linkedAccounts: students.filter((u) => u.studentId && ids.has(u.studentId)).length,
        unlinkedAccounts: students.filter((u) => !u.studentId).length,
        activeStudents7: students.filter((u) => u.lastSeenAt && +u.lastSeenAt >= weekAgo).length,
        activeToday: students.filter((u) => u.lastSeenAt && +u.lastSeenAt >= todayStart).length,
        subjects: list.length,
        scores: active.reduce((n, r) => n + Object.values(r.subjects || {}).filter(isNum).length, 0),
        avgTotal: a.avgTotal,
        best: a.best,
        worst: a.worst,
        avgImprovement: a.avgImprovement,
        avgImprovementPercent: a.avgImprovementPercent,
        comparable: a.comparable,
        studentChanges7,
        pendingDevices: accounts.reduce((n, u) => n + (Array.isArray(u.pendingDevices) ? u.pendingDevices.length : 0), 0),
        openConflicts,
      },
      timeline: a.timeline,
      activity: a.activity,
      bySubject: a.bestSubjects.map((s) => ({ ...s, name: names[s.subject] || s.subject })),
      recent: recentRows.map((e) => historyItem(e, names, { admin: true })),
      newAccounts,
      sync: { ...state, ...service.syncInfo(), openConflicts, sheetUrl: cfg.GOOGLE_SHEET_ID ? sheets.sheetUrl(cfg.GOOGLE_SHEET_ID, cfg.GOOGLE_SHEET_GID) : '' },
      subjectNames: names,
    };
  }

  async function analytics(query) {
    const now = Date.now();
    const group = service.cleanGroup(query.get('group') || '');
    const { records, events } = await loadScope(group ? { group } : {});
    const [list, names, groups] = await Promise.all([service.subjectList(), service.subjectNames(), listGroups()]);
    const { period, from, unit } = parsePeriod(query, events.length ? events[0].at : null, now);
    const a = stats.adminAnalytics({ records, events, subjects: group ? groupSubjectsOf(list, records) : list, from, now, unit, clock });
    const ids = records.map((r) => r._id);
    const userIds = group
      ? (await col().users.find({ studentId: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map((u) => u._id)
      : null;
    const match = { at: { $gte: new Date(from) } };
    if (userIds) match.userId = { $in: userIds };
    const days = await col().activity.aggregate([{ $match: match }, { $group: { _id: '$day', users: { $addToSet: '$userId' } } }]).toArray();
    const activeUsers = clock.buckets(from, now, unit).map((b) => {
      const set = new Set();
      for (const d of days) {
        const t = clock.keyStart(d._id);
        if (t >= b.start && t < Math.max(b.end, b.start + 1)) d.users.forEach((u) => set.add(u));
      }
      return { key: b.key, start: b.start, users: set.size };
    });
    return {
      group, groups, period, unit, from, now, ...a, activeUsers,
      bySubject: a.bySubject.map((s) => ({ ...s, name: names[s.subject] || s.subject })),
      bestSubjects: a.bestSubjects.map((s) => ({ ...s, name: names[s.subject] || s.subject })),
      subjectNames: names,
    };
  }

  async function students(query) {
    const now = Date.now();
    const group = service.cleanGroup(query.get('group') || '');
    const subject = String(query.get('subject') || '').slice(0, 40);
    const status = ['active', 'inactive', 'all'].includes(query.get('status')) ? query.get('status') : 'active';
    const q = core.normKey(query.get('q') || '');
    const sort = ['rank', 'name', 'total', 'delta', 'changes', 'subject'].includes(query.get('sort')) ? query.get('sort') : 'rank';
    const { records, events } = await loadScope(group ? { group } : {});
    const [list, names, groups, accounts] = await Promise.all([
      service.subjectList(), service.subjectNames(), listGroups(),
      col().users.find({}, { projection: { fullName: 1, studentId: 1, lastSeenAt: 1, isAdmin: 1, createdAt: 1, passwordHash: 1 } }).toArray(),
    ]);
    const byGroup = new Map();
    for (const r of records) { if (!byGroup.has(r.group)) byGroup.set(r.group, []); byGroup.get(r.group).push(r); }
    const ranks = new Map();
    const subjectRanks = new Map();
    for (const rs of byGroup.values()) {
      const m = rankMap(rs);
      for (const [id, rank] of m.ranks) ranks.set(id, { rank, size: m.size });
      if (subject) for (const [id, rank] of rankMap(rs, subject).ranks) subjectRanks.set(id, rank);
    }
    const weekAgo = new Map();
    stats.sweep(events, [now - 7 * DAY_MS], (state) => { for (const [id, s] of state) if (s.active) weekAgo.set(id, core.sumPoints(s.subjects)); });
    const changes = new Map();
    for (const e of events) {
      if (e.source !== 'student') continue;
      const c = changes.get(e.ratingId) || { count: 0, last: null };
      c.count++;
      c.last = e.at;
      changes.set(e.ratingId, c);
    }
    const linked = new Map();
    for (const u of accounts) if (u.studentId) {
      if (!linked.has(u.studentId)) linked.set(u.studentId, []);
      linked.get(u.studentId).push({ id: u._id, fullName: u.fullName, lastSeenAt: u.lastSeenAt || null, hasPassword: !!u.passwordHash });
    }
    let items = records.map((r) => {
      const rk = ranks.get(r._id);
      const before = weekAgo.get(r._id);
      const ch = changes.get(r._id);
      return {
        id: r._id, fullName: r.fullName, group: r.group, note: r.note || '', remark: r.remark || '', active: r.active !== false,
        points: r.points == null ? null : r.points, rank: rk ? rk.rank : null, ranked: rk ? rk.size : 0,
        subjectValue: subject && isNum((r.subjects || {})[subject]) ? r.subjects[subject] : null,
        subjectRank: subject ? subjectRanks.get(r._id) || null : null,
        delta7: before != null && r.points != null ? core.round2(r.points - before) : null,
        studentChanges: ch ? ch.count : 0, lastChangeAt: ch ? ch.last : null,
        accounts: linked.get(r._id) || [],
      };
    });
    if (status === 'active') items = items.filter((i) => i.active);
    if (status === 'inactive') items = items.filter((i) => !i.active);
    if (q) items = items.filter((i) => core.normKey(i.fullName).includes(q));
    if (subject) items = items.filter((i) => i.subjectValue != null);
    const nullsLast = (a, b, f) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : f(a, b));
    const byName = (a, b) => a.fullName.localeCompare(b.fullName, 'uk');
    const sorters = {
      rank: (a, b) => nullsLast(a.rank, b.rank, (x, y) => x - y) || byName(a, b),
      name: byName,
      total: (a, b) => nullsLast(a.points, b.points, (x, y) => y - x) || byName(a, b),
      delta: (a, b) => nullsLast(a.delta7, b.delta7, (x, y) => y - x) || byName(a, b),
      changes: (a, b) => b.studentChanges - a.studentChanges || byName(a, b),
      subject: (a, b) => nullsLast(a.subjectValue, b.subjectValue, (x, y) => y - x) || byName(a, b),
    };
    items.sort(sorters[sort]);
    const recordIds = new Set(records.map((r) => r._id));
    const keyIndex = new Map(records.map((r) => [r.nameKey, r]));
    const unlinked = accounts
      .filter((u) => !u.isAdmin && (!u.studentId || (!group && !recordIds.has(u.studentId))))
      .map((u) => {
        const match = keyIndex.get(core.ratingKey(u.fullName));
        const taken = match && (linked.get(match._id) || []).length > 0;
        return { id: u._id, fullName: u.fullName, createdAt: u.createdAt || null, lastSeenAt: u.lastSeenAt || null, suggestion: match && !taken ? { id: match._id, fullName: match.fullName, group: match.group } : null };
      });
    return { items, total: items.length, groups, subjects: list, subjectNames: names, unlinked, filters: { group, subject, status, q: query.get('q') || '', sort } };
  }

  async function studentProfile(id) {
    const { ratings, users, conflicts } = col();
    const doc = await ratings.findOne({ _id: id });
    if (!doc) throw new HttpError(404, 'Студента не знайдено.');
    const [overview, accounts, history, open] = await Promise.all([
      overviewFor(doc),
      users.find({ studentId: id }).toArray(),
      historyFor(id, new URLSearchParams('limit=100'), { admin: true }),
      conflicts.find({ ratingId: id, status: 'open' }).toArray(),
    ]);
    const candidates = accounts.length ? [] : await users.find({ studentId: { $in: [null, ''] }, isAdmin: { $ne: true } }, { projection: { fullName: 1, nameKey: 1 } }).toArray();
    return {
      ...overview,
      accounts: accounts.map((u) => ({
        id: u._id, fullName: u.fullName, lastSeenAt: u.lastSeenAt || null, createdAt: u.createdAt || null,
        devices: Array.isArray(u.deviceIds) ? u.deviceIds.length : 0, hasPassword: !!u.passwordHash, isAdmin: !!u.isAdmin,
      })),
      suggestions: candidates.filter((u) => core.ratingKey(u.fullName) === doc.nameKey).map((u) => ({ id: u._id, fullName: u.fullName })),
      history,
      conflicts: open.map((c) => ({ id: c._id, subject: c.subject, currentValue: c.currentValue, currentSource: c.currentSource, sheetValue: c.sheetValue, detectedAt: c.detectedAt })),
    };
  }

  async function scoreChanges(query) {
    const { history, ratings } = col();
    const limit = Math.min(200, Math.max(1, parseInt(query.get('limit'), 10) || 50));
    const source = ['student', 'sheet', 'admin', 'import', 'all'].includes(query.get('source')) ? query.get('source') : 'student';
    const filter = { kind: 'score', source: source === 'all' ? { $ne: 'baseline' } : source };
    const group = service.cleanGroup(query.get('group') || '');
    if (group) filter.group = group;
    const subject = String(query.get('subject') || '').slice(0, 40);
    if (subject) filter.subject = subject;
    const q = core.normName(query.get('q') || '');
    if (q) filter.studentName = { $regex: escapeRe(q), $options: 'i' };
    const before = query.get('before') ? new Date(query.get('before')) : null;
    if (before && !Number.isNaN(+before)) filter.at = { $lt: before };
    const [rows, names] = await Promise.all([history.find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray(), service.subjectNames()]);
    const page = rows.slice(0, limit);
    const docs = await ratings.find({ _id: { $in: [...new Set(page.map((e) => e.ratingId))] } }, { projection: { subjects: 1 } }).toArray();
    const current = new Map(docs.map((d) => [d._id, d.subjects || {}]));
    const items = page.map((e) => {
      const cur = current.get(e.ratingId);
      const now = cur ? (isNum(cur[e.subject]) ? cur[e.subject] : null) : undefined;
      return {
        ...historyItem(e, names, { admin: true }),
        current: now === undefined ? null : now,
        exists: now !== undefined,
        revertable: e.source === 'student' && !e.revertedAt && e.previous != null && now !== undefined && core.sameNum(now, e.value),
      };
    });
    return { items, more: rows.length > limit, next: items.length ? items[items.length - 1].at : null, source };
  }

  async function syncOverview() {
    const { syncRuns, conflicts } = col();
    const [state, runs, open, names] = await Promise.all([
      service.getSyncState(),
      syncRuns.find({}).sort({ startedAt: -1 }).limit(30).toArray(),
      conflicts.find({ status: 'open' }).sort({ detectedAt: -1 }).limit(200).toArray(),
      service.subjectNames(),
    ]);
    const info = service.syncInfo();
    return {
      ...info,
      sheetId: cfg.GOOGLE_SHEET_ID,
      gid: cfg.GOOGLE_SHEET_GID,
      group: cfg.GOOGLE_SHEET_GROUP,
      sheetUrl: cfg.GOOGLE_SHEET_ID ? sheets.sheetUrl(cfg.GOOGLE_SHEET_ID, cfg.GOOGLE_SHEET_GID) : '',
      state,
      runs: runs.map((r) => ({ ...r, id: r._id, _id: undefined })),
      conflicts: open.map((c) => ({
        id: c._id, ratingId: c.ratingId, studentName: c.studentName, group: c.group, subject: c.subject,
        subjectName: names[c.subject] || c.subject, currentValue: c.currentValue, currentSource: c.currentSource,
        sheetValue: c.sheetValue, source: c.source, detectedAt: c.detectedAt,
      })),
    };
  }

  return { loadScope, listGroups, overviewFor, statsFor, historyFor, ratingTable, dashboard, analytics, students, studentProfile, scoreChanges, syncOverview };
};
