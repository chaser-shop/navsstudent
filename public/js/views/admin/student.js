// Студент (/admin/students/:id): підсумки, бали з предметів, динаміка, прив’язані акаунти, конфлікти й повна історія змін.

import { api } from '../../core/api.js';
import { html, setHTML, actions, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { pageHead, kpi, skeleton, emptyState, delta, avatar, openModal, confirmDialog, toast, toastError } from '../../core/ui.js';
import { lineChart, legend } from '../../core/charts.js';
import { fmtNum, fmtSigned, fmtPct, fmtDate, relTime, pointsWord, sourceLabel } from '../../core/format.js';
import {
  PERIODS, periodText, defaultUnit, segmented, setPressed, bucketLabels, apiQuery, sequencer, chartHost, chartSlot, historyTimeline,
  nextPage, mergePage,
} from './ad-kit.js';

const MAX_SCORE = 100000;
const sameNum = (a, b) => Math.round(a * 100) === Math.round(b * 100);

function kpis(p) {
  const prog = p.progress;
  const diff = p.total != null && p.groupAvg != null ? Math.round((p.total - p.groupAvg) * 100) / 100 : null;
  return html`<div class="grid grid-kpi ad-kpis ad-kpis-tall">
    ${kpi({ ic: 'hash', label: 'Сума балів', value: p.total == null ? '—' : fmtNum(p.total), sub: `Предметів із балами: ${p.subjects.filter((s) => s.value != null).length}` })}
    ${kpi({
      ic: 'award', label: 'Місце в групі',
      value: p.rank ? html`${p.rank}<small class="ad-of"> з ${p.ranked}</small>` : '—',
      sub: p.rank ? `Студентів у групі: ${p.groupSize}` : (p.student.active ? 'Ще немає балів для рейтингу' : 'Запис неактивний, у рейтингу не бере участі'),
    })}
    ${prog
    ? kpi({
      ic: prog.delta < 0 ? 'trending-down' : 'trending-up', label: 'Прогрес від початку обліку',
      value: html`<span class="${prog.delta > 0 ? 'success-text' : prog.delta < 0 ? 'danger-text' : ''}">${fmtSigned(prog.delta)}</span>`,
      sub: `З ${fmtDate(prog.since)}: ${fmtNum(prog.from)} → ${fmtNum(prog.to)}${prog.percent != null ? `, ${fmtPct(prog.percent)}` : ''}`,
    })
    : kpi({ ic: 'trending-up', label: 'Прогрес від початку обліку', value: html`<span class="ad-kpi-note">Недостатньо даних</span>`, sub: 'У журналі ще немає змін балів цього студента.' })}
    ${kpi({
      ic: 'bar-chart', label: 'Середня сума групи', value: p.groupAvg == null ? '—' : fmtNum(p.groupAvg),
      sub: diff == null ? 'Немає з чим порівняти' : diff === 0 ? 'Збігається із сумою студента' : `Студент ${diff > 0 ? 'вище' : 'нижче'} за середнє на ${fmtNum(Math.abs(diff))} ${pointsWord(Math.abs(diff))}`,
    })}
  </div>`;
}

function subjectRows(p) {
  return p.subjects.map((s) => html`<tr>
    <td class="primary" data-label="Предмет"><span class="ad-cell">${s.name}${s.changedAt ? html`<small class="ad-sub">Оновлено ${relTime(s.changedAt)} · ${sourceLabel(s.source)}</small>` : ''}</span></td>
    <td class="r num strong ${s.value == null ? 'ad-empty' : ''}" data-label="Бал"><span class="ad-cell">${s.value == null ? '—' : fmtNum(s.value)}</span></td>
    <td class="r num ${s.previous == null ? 'ad-empty' : ''}" data-label="Попередній"><span class="ad-cell">${s.previous == null ? '—' : fmtNum(s.previous)}</span></td>
    <td class="r ${s.delta == null ? 'ad-empty' : ''}" data-label="Зміна"><span class="ad-cell">${s.delta == null ? html`<span class="muted">—</span>` : html`${delta(s.delta)}${s.percent != null ? html` <span class="ad-pct">${fmtPct(s.percent)}</span>` : ''}`}</span></td>
    <td class="r num ${s.rank ? '' : 'ad-empty'}" data-label="Місце з предмета"><span class="ad-cell">${s.rank ? html`${s.rank}<span class="muted"> з ${s.ranked}</span>` : '—'}</span></td>
    <td class="r num ${s.groupAvg == null ? 'ad-empty' : ''}" data-label="Середнє групи"><span class="ad-cell">${s.groupAvg == null ? '—' : fmtNum(s.groupAvg)}</span></td>
  </tr>`);
}

function insightsCard(p) {
  const ic = { up: 'trending-up', down: 'trending-down', neutral: 'info' };
  return html`<div class="card">
    <div class="card-head"><h3>Повідомлення про прогрес</h3><span class="hint">так їх бачить студент</span></div>
    ${p.insights.length
    ? html`<div class="insights">${p.insights.map((i) => html`<div class="insight ${i.tone}"><span class="ic">${icon(ic[i.tone] || 'info')}</span><p>${i.text}</p></div>`)}</div>`
    : emptyState({ icon: 'sparkles', title: p.enoughData ? 'Поки що нічого не змінилося' : 'Недостатньо історичних даних', text: p.enoughData ? 'Відносно вчорашнього дня бали й місце студента не змінилися.' : 'Порівняння з учорашнім днем з’явиться, щойно накопичиться історія змін.', compact: true })}
  </div>`;
}

export default async function view(ctx) {
  const root = ctx.root;
  const id = ctx.params.id;
  const base = `/api/admin/students/${encodeURIComponent(id)}`;
  const back = { href: '/admin/students', label: 'Студенти' };
  const state = { period: '30' };
  const statsUrl = () => `${base}/stats${apiQuery({ period: state.period, unit: defaultUnit(state.period) })}`;

  setHTML(root, html`${pageHead({ title: 'Студент', back })}${skeleton(3)}`);
  let profile = await api('GET', base);
  if (!ctx.isActive()) return;
  const loadUnlinked = () => api('GET', '/api/admin/students?status=all').then((r) => r.unlinked).catch(() => []);
  let [stats, unlinked] = await Promise.all([api('GET', statsUrl()), profile.accounts.length ? [] : loadUnlinked()]);
  if (!ctx.isActive()) return;
  let history = { ...profile.history };

  const charts = chartHost(ctx, root);
  const seq = sequencer();

  // ───────── Розмітка ─────────
  function head() {
    const s = profile.student;
    return pageHead({
      back,
      title: html`<span class="ad-name">${avatar(s.fullName, 'lg')}<span>${s.fullName}</span></span>`,
      subtitle: html`<span class="ad-sub-line"><span>${s.group ? `Група ${s.group}` : 'Без групи'}</span>${s.active ? '' : html` <span class="badge" title="Студента немає в таблиці рейтингу">Неактивний</span>`}${s.note ? html` <span class="badge accent">${s.note}</span>` : ''}${s.remark ? html` <span class="badge warning">${s.remark}</span>` : ''}</span>`,
      actions: html`<button type="button" class="btn btn-primary" data-action="edit">${icon('edit')} Редагувати бали</button>`,
    });
  }

  function conflictsSection() {
    const list = profile.conflicts;
    if (!list.length) return '';
    const nameOf = (key) => (profile.subjects.find((s) => s.key === key) || {}).name || key;
    return html`<section class="section">
      <div class="section-head"><h2>Конфлікти із таблицею</h2><span class="count">${list.length}</span></div>
      <div class="alert warning mb3">${icon('conflict')}<div class="grow"><strong>Значення в таблиці відрізняється від балів журналу</strong>Оберіть, яке значення залишити. Рішення буде записано в журнал змін.</div></div>
      <div class="card"><div class="list">${list.map((c) => html`<div class="list-item ad-conflict">
        <div class="grow">
          <div class="title">${nameOf(c.subject)}</div>
          <div class="meta wrap">Зараз: <strong>${c.currentValue == null ? '—' : fmtNum(c.currentValue)}</strong> (${sourceLabel(c.currentSource)}) · у таблиці: <strong>${c.sheetValue == null ? '—' : fmtNum(c.sheetValue)}</strong> · виявлено ${relTime(c.detectedAt)}</div>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-soft btn-sm" data-action="resolve" data-id="${c.id}" data-choice="sheet">Прийняти з таблиці</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="resolve" data-id="${c.id}" data-choice="keep">Залишити поточний</button>
        </div>
      </div>`)}</div></div>
    </section>`;
  }

  function accountsCard() {
    const list = profile.accounts;
    const s = profile.student;
    let body;
    if (list.length) {
      body = html`<div class="list">${list.map((a) => html`<div class="list-item ad-account">
        ${avatar(a.fullName, 'sm')}
        <div class="grow">
          <div class="title">${a.fullName}${a.isAdmin ? html` <span class="badge warning">Адміністратор</span>` : ''}</div>
          <div class="meta wrap">${a.lastSeenAt ? `Остання активність: ${relTime(a.lastSeenAt)}` : 'Входів ще не було'} · пристроїв: ${a.devices}</div>
          <div class="ad-badges mt1"><span class="badge ${a.hasPassword ? 'success' : 'warning'}">${a.hasPassword ? 'Пароль встановлено' : 'Пароль не встановлено'}</span></div>
        </div>
        <button type="button" class="btn btn-danger-soft btn-sm" data-action="unlink" data-user="${a.id}" data-name="${a.fullName}">Відв’язати</button>
      </div>`)}</div>`;
    } else {
      body = html`<div class="card-body">
        <p class="muted small">До цього запису ще не прив’язано жодного акаунта, тож студент не бачить своїх балів.</p>
        ${profile.suggestions.length ? html`<div class="ad-link-row">${profile.suggestions.map((u) => html`<button type="button" class="btn btn-primary btn-sm" data-action="link" data-user="${u.id}">${icon('link')}<span>Прив’язати акаунт “${u.fullName}”</span></button>`)}</div>` : ''}
        ${unlinked.length ? html`<div class="ad-link-row">
          <select class="select sm" aria-label="Акаунт для прив’язки до студента ${s.fullName}" data-link-select>
            <option value="">Оберіть акаунт без прив’язки…</option>
            ${unlinked.map((u) => html`<option value="${u.id}">${u.fullName}</option>`)}
          </select>
          <button type="button" class="btn btn-secondary btn-sm" data-action="link-select">Прив’язати</button>
        </div>` : (profile.suggestions.length ? '' : html`<p class="help mt2">Акаунтів без прив’язки зараз немає. Студент має спершу зареєструватися в щоденнику.</p>`)}
      </div>`;
    }
    return html`<div class="card"><div class="card-head"><h3>Акаунт студента</h3></div>${body}</div>`;
  }

  function progressTiles() {
    // Початок обліку предмета показуємо, лише коли він пізніший за початок обліку студента (інакше це вже сказано вище).
    const late = (r) => r.since != null && r.since > stats.from && stats.trackingSince && r.since > +new Date(stats.trackingSince) + 86400000;
    const rows = stats.progress.filter((r) => (r.from != null || r.to != null) && !(r.delta === 0));
    if (!rows.length) return html`<p class="muted small">За цей період бали з предметів не змінювалися.</p>`;
    return html`<div class="ad-tiles">${rows.map((r) => html`<div class="ad-tile">
      <div class="ad-tile-name">${r.name}</div>
      <div class="ad-tile-row"><span class="num strong">${r.from == null ? html`<span class="ad-tag">новий</span> ` : html`${fmtNum(r.from)} → `}${r.to == null ? 'видалено' : fmtNum(r.to)}</span>${r.delta == null ? '' : delta(r.delta)}${r.percent != null ? html`<span class="ad-pct">${fmtPct(r.percent)}</span>` : ''}</div>
      ${late(r) ? html`<div class="ad-tile-sub">Облік предмета — з ${fmtDate(r.since)}</div>` : ''}
    </div>`)}</div>`;
  }

  // Перемикач періоду не перемальовуємо разом із графіками, щоб не губити фокус клавіатури.
  function chartsSection() {
    return html`<div class="section-head ad-wrap"><h2>Динаміка</h2>${segmented({ action: 'period', options: PERIODS, value: state.period, label: 'Період графіків' })}</div>
      <div id="ad-stu-charts-body">${chartsBody()}</div>`;
  }
  function chartsBody() {
    const since = stats.trackingSince ? `Облік змін ведеться з ${fmtDate(stats.trackingSince)}` : 'Облік змін цього студента ще не почався';
    return html`<p class="help mb3">${since}. Графіки показують стан ${periodText(state.period)}.</p>
      ${stats.hasData ? html`<div class="split ad-fit">
        <div class="card"><div class="card-head"><h3>Сума балів і середнє групи</h3></div><div class="card-body ad-cb">${chartSlot('total', 240)}${legend([{ label: 'Сума балів', color: 'var(--accent)' }, { label: 'Середнє групи', color: 'var(--faint)', dashed: true }])}</div></div>
        <div class="card"><div class="card-head"><h3>Місце в групі</h3><span class="hint">менше — краще</span></div><div class="card-body">${chartSlot('rank', 240)}</div></div>
      </div>
      <div class="card mt4"><div class="card-head"><h3>Зміни предметів</h3><span class="hint">${periodText(state.period)}</span></div><div class="card-body">${progressTiles()}</div></div>`
      : html`<div class="card">${emptyState({ icon: 'trending-up', title: 'Історія ще не накопичилась', text: 'Графіки з’являться після першої зміни балів цього студента.' })}</div>`}`;
  }

  function historySection() {
    const s = profile.student;
    return html`<div class="section-head"><h2>Історія змін балів</h2><a class="hint" href="/admin/changes?source=all&q=${encodeURIComponent(s.fullName)}">Журнал змін</a></div>
      <div class="card">
        ${history.items.length ? historyTimeline(history.items) : emptyState({ icon: 'history', title: 'Змін ще не було', text: 'Тут з’являться всі зміни балів цього студента: від нього самого, з таблиці та від адміністратора.', compact: true })}
        ${history.more ? html`<div class="card-foot center"><button type="button" class="btn btn-secondary btn-sm" data-action="more">Показати ще</button></div>` : ''}
      </div>`;
  }

  function render() {
    const s = profile.student;
    setHTML(root, html`
      ${head()}
      ${s.active ? '' : html`<div class="alert warning mb4">${icon('alert')}<div class="grow"><strong>Запис неактивний</strong>Студента більше немає в таблиці рейтингу. Він не враховується в місцях і середніх значеннях, але історія збережена.</div></div>`}
      ${kpis(profile)}
      <div id="ad-stu-conflicts">${conflictsSection()}</div>
      <section class="section">
        <div class="section-head"><h2>Бали з предметів</h2><span class="hint">${profile.subjects.length ? `предметів: ${profile.subjects.length}` : ''}</span></div>
        <div class="card">${profile.subjects.length
          ? html`<div class="table-wrap"><table class="table responsive ad-table ad-subjects">
              <thead><tr><th scope="col">Предмет</th><th scope="col" class="r">Бал</th><th scope="col" class="r">Попередній</th><th scope="col" class="r">Зміна</th><th scope="col" class="r">Місце з предмета</th><th scope="col" class="r">Середнє групи</th></tr></thead>
              <tbody>${subjectRows(profile)}</tbody></table></div>`
          : emptyState({ icon: 'layers', title: 'Балів ще немає', text: 'У цього студента поки що немає жодного бала з предметів.', compact: true })}</div>
      </section>
      <section class="section"><div class="split ad-fit">${insightsCard(profile)}<div id="ad-stu-account">${accountsCard()}</div></div></section>
      <section class="section" id="ad-stu-charts">${chartsSection()}</section>
      <section class="section" id="ad-stu-history">${historySection()}</section>`);
    drawCharts();
  }

  function drawCharts() {
    if (!stats.hasData) { charts.set({}); return; }
    const sr = stats.series;
    const lab = bucketLabels(sr, stats.unit);
    charts.set({
      total: (width) => lineChart({
        labels: lab.labels, tipLabels: lab.tips, width, height: 240, ariaLabel: 'Сума балів студента та середнє по групі',
        series: [
          { label: 'Сума балів', color: 'var(--accent)', values: sr.map((x) => x.total), area: true },
          { label: 'Середнє групи', color: 'var(--faint)', values: sr.map((x) => x.groupAvg), dashed: true },
        ],
        empty: 'Немає даних за цей період',
      }),
      rank: (width) => lineChart({
        labels: lab.labels, tipLabels: lab.tips, width, height: 240, invert: true, integer: true, ariaLabel: 'Місце студента в рейтингу групи',
        series: [{ label: 'Місце', color: 'var(--c2)', values: sr.map((x) => x.rank) }],
        empty: 'Немає даних за цей період',
      }),
    });
  }

  // ───────── Завантаження ─────────
  async function reloadProfile() {
    const next = await api('GET', base);
    if (!ctx.isActive()) return false;
    profile = next;
    history = { ...next.history };
    unlinked = next.accounts.length ? [] : await loadUnlinked();
    return ctx.isActive();
  }
  async function reloadAll() {
    const [nextStats, ok] = await Promise.all([api('GET', statsUrl()), reloadProfile()]);
    if (!ok || !ctx.isActive()) return;
    stats = nextStats;
    render();
  }

  async function changePeriod(value) {
    state.period = value;
    setPressed(root.querySelector('#ad-stu-charts .segmented'), value);
    const holder = root.querySelector('#ad-stu-charts-body');
    const mine = seq.next();
    holder.classList.add('ad-dim');
    try {
      const next = await api('GET', statsUrl());
      if (!ctx.isActive() || !seq.isLatest(mine)) return;
      stats = next;
      setHTML(holder, chartsBody());
      drawCharts();
    } catch (e) {
      if (ctx.isActive() && seq.isLatest(mine)) toastError(e);
    } finally {
      if (seq.isLatest(mine)) holder.classList.remove('ad-dim');
    }
  }

  async function more(btn) {
    await busy(btn, async () => {
      try {
        const r = await nextPage((extra) => api('GET', `${base}/history${apiQuery({ limit: 50, ...extra })}`), history.items, history.next);
        if (!ctx.isActive()) return;
        history = mergePage(history.items, r);
        setHTML(root.querySelector('#ad-stu-history'), historySection());
      } catch (e) {
        toastError(e);
      }
    });
  }

  // ───────── Дії ─────────
  async function resolve(btn, conflictId, choice) {
    if (choice === 'sheet') {
      const c = profile.conflicts.find((x) => x.id === conflictId);
      const ok = await confirmDialog({
        title: 'Прийняти значення з таблиці?',
        text: c ? `Бал стане ${c.sheetValue == null ? 'порожнім' : fmtNum(c.sheetValue)} замість ${c.currentValue == null ? 'порожнього' : fmtNum(c.currentValue)}. Зміну буде записано в журнал від вашого імені.` : 'Бал буде змінено на значення з таблиці. Зміну буде записано в журнал.',
        confirmText: 'Прийняти значення',
      });
      if (!ok) return;
    }
    await busy(btn, async () => {
      try {
        await api('POST', `/api/admin/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`, { action: choice });
        toast(choice === 'sheet' ? 'Значення з таблиці прийнято.' : 'Поточний бал залишено без змін.', { type: 'success' });
        await reloadAll();
      } catch (e) {
        toastError(e);
      }
    });
  }

  async function linkAccount(btn, userId) {
    if (!userId) { toast('Оберіть акаунт, який потрібно прив’язати.', { type: 'error' }); return; }
    await busy(btn, async () => {
      try {
        await api('POST', `/api/admin/users/${encodeURIComponent(userId)}/student`, { studentId: id });
        toast('Акаунт прив’язано до цього студента.', { type: 'success' });
        await reloadProfile();
        if (ctx.isActive()) setHTML(root.querySelector('#ad-stu-account'), accountsCard());
      } catch (e) {
        toastError(e);
      }
    });
  }

  async function unlinkAccount(btn, userId, name) {
    const ok = await confirmDialog({
      title: 'Відв’язати акаунт?',
      text: `Акаунт «${name}» більше не бачитиме бали цього запису й не зможе їх підвищувати. Історію змін буде збережено.`,
      confirmText: 'Відв’язати', danger: true,
    });
    if (!ok) return;
    await busy(btn, async () => {
      try {
        await api('POST', `/api/admin/users/${encodeURIComponent(userId)}/student`, { studentId: '' });
        toast('Акаунт відв’язано.', { type: 'success' });
        await reloadProfile();
        if (ctx.isActive()) setHTML(root.querySelector('#ad-stu-account'), accountsCard());
      } catch (e) {
        toastError(e);
      }
    });
  }

  function openEdit() {
    const list = profile.subjects;
    if (!list.length) { toast('У цього студента ще немає предметів, бали яких можна редагувати.', { type: 'error' }); return; }
    const shownValue = (v) => (v == null ? '' : String(v).replace('.', ','));
    const m = openModal({
      title: 'Редагувати бали',
      size: 'lg',
      body: html`
        <div class="alert warning mb4">${icon('alert')}<div class="grow"><strong>Адміністратор може й знижувати бали</strong>Кожну зміну буде записано в журнал від вашого імені. Порожнє поле видаляє бал із предмета.</div></div>
        <form id="ad-edit-form" class="ad-edit-grid" novalidate>
          <button type="submit" class="sr-only" tabindex="-1" aria-hidden="true">Зберегти</button>
          ${list.map((s, i) => html`<div class="field">
            <label class="label" for="ad-edit-${i}">${s.name}</label>
            <input class="input" id="ad-edit-${i}" data-key="${s.key}" data-name="${s.name}" data-initial="${s.value == null ? '' : s.value}" inputmode="decimal" autocomplete="off" placeholder="Немає бала" value="${shownValue(s.value)}">
          </div>`)}
        </form>
        <div class="error-text mt3" data-error role="alert" hidden></div>`,
      footer: html`<button type="button" class="btn btn-secondary" data-close>Скасувати</button><button type="button" class="btn btn-primary" data-ok>Зберегти</button>`,
    });
    const errorBox = m.el.querySelector('[data-error]');
    const fail = (text, input) => { errorBox.textContent = text; errorBox.hidden = false; if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); } };

    function read() {
      const map = {};
      const changes = [];
      for (const input of m.el.querySelectorAll('input[data-key]')) {
        input.removeAttribute('aria-invalid');
        const name = input.dataset.name;
        const initial = input.dataset.initial === '' ? null : Number(input.dataset.initial);
        const text = input.value.trim().replace(/\s+/g, '').replace(',', '.');
        if (text === '') {
          if (initial != null) changes.push({ key: input.dataset.key, name, from: initial, to: null });
          continue;
        }
        if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) > MAX_SCORE) {
          return { error: `Бал із предмета «${name}» має бути числом від 0 до 100 000 (не більше двох знаків після коми).`, input };
        }
        const n = Number(text);
        map[input.dataset.key] = n;
        if (initial == null || !sameNum(initial, n)) changes.push({ key: input.dataset.key, name, from: initial, to: n });
      }
      return { map, changes };
    }

    const okBtn = m.el.querySelector('[data-ok]');
    okBtn.addEventListener('click', async () => {
      errorBox.hidden = true;
      const r = read();
      if (r.error) { fail(r.error, r.input); return; }
      if (!r.changes.length) { m.close(); toast('Змін немає: бали залишилися такими, як були.'); return; }
      const removed = r.changes.filter((c) => c.to == null);
      const high = r.changes.filter((c) => c.to != null && c.to > profile.scoreMax);
      if (removed.length || high.length) {
        const lines = [];
        if (removed.length) lines.push(`Буде видалено бали з предметів: ${removed.map((c) => `«${c.name}»`).join(', ')}.`);
        if (high.length) lines.push(`Бали перевищують звичайний максимум (${fmtNum(profile.scoreMax, 0)}): ${high.map((c) => `«${c.name}»`).join(', ')}.`);
        const ok = await confirmDialog({ title: 'Підтвердіть зміни', text: `${lines.join(' ')} Продовжити?`, confirmText: 'Зберегти' });
        if (!ok) return;
      }
      await busy(okBtn, async () => {
        try {
          const res = await api('PATCH', `/api/admin/rating/${encodeURIComponent(id)}`, { subjects: r.map });
          m.close(true);
          toast(`Бали збережено. Змінено записів: ${res.changes != null ? res.changes : r.changes.length}.`, { type: 'success' });
          await reloadAll();
        } catch (e) {
          fail(e.message || 'Не вдалося зберегти бали.');
        }
      });
    });
    m.el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); okBtn.click(); });
  }

  ctx.onCleanup(actions(root, {
    edit: () => openEdit(),
    period: (el) => { if (state.period !== el.dataset.value) changePeriod(el.dataset.value); },
    more: (el) => more(el),
    resolve: (el) => resolve(el, el.dataset.id, el.dataset.choice),
    unlink: (el) => unlinkAccount(el, el.dataset.user, el.dataset.name),
    link: (el) => linkAccount(el, el.dataset.user),
    'link-select': (el) => { const s = root.querySelector('select[data-link-select]'); return linkAccount(el, s ? s.value : ''); },
  }));
  render();
}
