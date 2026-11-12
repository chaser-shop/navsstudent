// «Успішність»: мої бали (з підвищенням), статистика, рейтинг групи, історія змін.

import { api } from '../core/api.js';
import { html, setHTML, $, actions, busy } from '../core/dom.js';
import { icon } from '../core/icons.js';
import {
  fmtNum, fmtSigned, fmtPct, fmtDate, fmtDateShort, fmtMonth, fmtMonthShort, fmtDateTime, fmtTime, relTime, dayKey,
  pointsWord, sourceLabel, colorFor, subjectsWord, studentsWord,
} from '../core/format.js';
import { toast, toastError, openModal, emptyState, errorState, skeleton, pageHead, kpi, delta, avatar } from '../core/ui.js';
import { lineChart, hBars, legend } from '../core/charts.js';

const TABS = [
  { key: 'scores', href: '/progress', label: 'Мої бали' },
  { key: 'stats', href: '/progress/stats', label: 'Статистика' },
  { key: 'rating', href: '/progress/rating', label: 'Рейтинг групи' },
  { key: 'history', href: '/progress/history', label: 'Історія змін' },
];

const SOURCE_ICON = { student: 'arrow-up', sheet: 'sheet', admin: 'shield', import: 'upload', baseline: 'database', seed: 'database' };

// ───────── Спільні частини (використовує й головна сторінка) ─────────
export function insightsList(items) {
  if (!items || !items.length) return '';
  return html`<div class="insights">${items.map((i) => html`
    <div class="insight ${i.tone === 'up' ? 'up' : i.tone === 'down' ? 'down' : 'neutral'}">
      <span class="ic">${icon(i.type === 'rank' ? 'award' : i.type === 'best' ? 'star' : i.tone === 'up' ? 'trending-up' : i.tone === 'down' ? 'trending-down' : 'info')}</span>
      <p>${i.text}</p>
    </div>`)}</div>`;
}

export function lastSyncNote(lastSync) {
  if (!lastSync || !lastSync.at) return html`<span class="muted small">Дані з Google Таблиці ще не завантажувалися.</span>`;
  return html`<span class="small ${lastSync.failing ? 'warning-text' : 'muted'}">${icon(lastSync.failing ? 'alert' : 'refresh', 'sync-ic')}
    Оновлено з Google Таблиці ${relTime(lastSync.at)}${lastSync.failing ? ' · остання перевірка не вдалася' : ''}</span>`;
}

const valueInfo = (v) => (v == null ? '—' : fmtNum(v));

/** Діалог підвищення бала. Сервер повторно перевіряє все: предмет, поточний бал, новий бал і власника запису. */
export function openIncrease(subject, { scoreMax }, onDone) {
  let current = subject.value;
  const step = (n) => Math.min(scoreMax, Math.round((current + n) * 100) / 100);
  const m = openModal({
    title: 'Підвищення бала',
    body: html`
      <div class="flex between start mb4">
        <div><div class="strong">${subject.name}</div>${subject.name !== subject.key ? html`<div class="xs muted">${subject.key}</div>` : ''}</div>
        <div class="right"><div class="xs muted">Поточний бал</div><div class="strong num" id="incCurrent" style="font-size:22px">${fmtNum(current)}</div></div>
      </div>
      <form id="incForm" novalidate>
        <div class="field">
          <label class="label" for="incValue">Новий бал (більший за поточний, до ${fmtNum(scoreMax)})</label>
          <input class="input input-xl" id="incValue" name="value" type="number" inputmode="decimal" step="0.01" min="${current}" max="${scoreMax}" placeholder="${fmtNum(step(1))}" autocomplete="off" autofocus>
        </div>
        <div class="chip-list mt3" aria-label="Швидкий вибір">
          ${[1, 2, 5, 10].filter((n) => current + n <= scoreMax || n === 1).map((n) => html`<button type="button" class="chip" data-add="${n}">+${n}</button>`)}
        </div>
        <div class="mt4 small" id="incPreview" aria-live="polite"></div>
        <div class="error-text mt2" id="incError" role="alert" hidden></div>
      </form>
      <div class="alert info mt4">${icon('lock')}<div class="grow">Бал можна лише підвищити. Після збереження зменшити його неможливо — зміна потрапить до історії з датою й часом.</div></div>`,
    footer: html`<button type="button" class="btn btn-secondary" data-close>Скасувати</button>
      <button type="button" class="btn btn-primary" id="incSubmit" disabled>Підвищити</button>`,
  });
  const input = $('#incValue', m.el);
  const submit = $('#incSubmit', m.el);
  const preview = $('#incPreview', m.el);
  const errBox = $('#incError', m.el);

  const parse = () => {
    const raw = String(input.value).trim().replace(',', '.');
    if (!raw) return { empty: true };
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { error: 'Введіть число (до двох знаків після коми).' };
    const v = Number(raw);
    if (v <= current) return { error: `Новий бал має бути більшим за поточний (${fmtNum(current)}).` };
    if (v > scoreMax) return { error: `Бал не може перевищувати ${fmtNum(scoreMax)}.` };
    return { value: v };
  };
  const update = () => {
    const p = parse();
    submit.disabled = !p.value;
    errBox.hidden = !p.error;
    errBox.textContent = p.error || '';
    input.setAttribute('aria-invalid', p.error ? 'true' : 'false');
    if (p.value) {
      const d = Math.round((p.value - current) * 100) / 100;
      setHTML(preview, html`<span class="muted">Було</span> <b class="num">${fmtNum(current)}</b> → <span class="muted">стане</span> <b class="num">${fmtNum(p.value)}</b> ${delta(d)} <span class="muted">${current > 0 ? fmtPct((d / current) * 100) : ''}</span>`);
      submit.textContent = `Підвищити до ${fmtNum(p.value)}`;
    } else {
      preview.textContent = '';
      submit.textContent = 'Підвищити';
    }
  };
  input.addEventListener('input', update);
  m.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    input.value = String(step(Number(b.dataset.add)));
    update();
    input.focus();
  });
  const send = () => busy(submit, async () => {
    const p = parse();
    if (!p.value) { update(); return; }
    try {
      const r = await api('POST', '/api/me/scores/increase', { subject: subject.key, value: p.value, expected: current });
      m.close(true);
      toast(`Бал з предмета «${subject.name}» підвищено: ${fmtNum(r.previous)} → ${fmtNum(r.value)}.`, { type: 'success' });
      onDone(r);
    } catch (e) {
      if (e.code === 'stale' && e.data && typeof e.data.current === 'number') {
        current = e.data.current;
        $('#incCurrent', m.el).textContent = fmtNum(current);
        input.min = String(current);
      }
      errBox.hidden = false;
      errBox.textContent = e.message;
    }
  });
  submit.addEventListener('click', send);
  $('#incForm', m.el).addEventListener('submit', (e) => { e.preventDefault(); if (!submit.disabled) send(); });
}

// ───────── Сторінка ─────────
export default async function progress(ctx) {
  const tab = TABS.find((t) => t.key === (ctx.params.tab || 'scores'));
  if (!tab) { ctx.navigate('/progress', { replace: true }); return; }
  ctx.setTitle(tab.key === 'scores' ? 'Успішність' : tab.label);
  setHTML(ctx.root, html`
    ${pageHead({ title: 'Успішність', subtitle: 'Ваші бали, прогрес і місце в рейтингу групи', compact: true })}
    <nav class="subnav" aria-label="Розділи успішності">${TABS.map((t) => html`<a href="${t.href}" class="${t.key === tab.key ? 'active' : ''}" ${t.key === tab.key ? html`aria-current="page"` : ''}>${t.label}</a>`)}</nav>
    <div id="tab">${skeleton(3)}</div>`);
  const host = $('#tab', ctx.root);
  const load = async () => {
    try {
      if (tab.key === 'scores') await scoresTab(ctx, host);
      else if (tab.key === 'stats') await statsTab(ctx, host);
      else if (tab.key === 'rating') await ratingTab(ctx, host);
      else await historyTab(ctx, host);
    } catch (e) {
      if (!ctx.isActive()) return;
      setHTML(host, errorState(e));
    }
  };
  ctx.onCleanup(actions(host, { retry: () => load() }));
  await load();
}

function notLinked() {
  return emptyState({
    icon: 'user-check',
    title: 'Рейтинг ще не підключено',
    text: 'Адміністратор має прив’язати ваш акаунт до вашого запису в рейтингу групи. Після цього тут з’являться ваші бали, статистика й прогрес.',
  });
}

// ───────── Мої бали ─────────
async function scoresTab(ctx, host) {
  const ov = await api('GET', '/api/me/overview');
  if (!ctx.isActive()) return;
  if (!ov.linked) { setHTML(host, notLinked()); return; }
  const withScore = ov.subjects.filter((s) => s.value != null);
  const p = ov.progress;
  setHTML(host, html`
    <div class="grid grid-kpi">
      ${kpi({ label: 'Сума балів', ic: 'target', value: valueInfo(ov.total), sub: ov.groupAvg != null ? `Середнє групи: ${fmtNum(ov.groupAvg)}` : '' })}
      ${kpi({ label: 'Місце в групі', ic: 'award', value: ov.rank ? `${ov.rank}` : '—', sub: ov.rank ? `з ${ov.ranked} ${studentsWord(ov.ranked)}` : 'Немає балів для рейтингу' })}
      ${kpi({ label: 'Предмети', ic: 'book', value: `${withScore.length}`, sub: `з балами — із ${ov.subjects.length} ${subjectsWord(ov.subjects.length)} групи` })}
      ${kpi({
        label: 'Прогрес', ic: 'trending-up',
        value: p ? fmtSigned(p.delta) : '—',
        sub: p ? `${p.percent != null ? fmtPct(p.percent) + ' · ' : ''}з ${fmtDate(p.since)}` : 'Історія ще накопичується',
      })}
    </div>
    ${!ov.student.active ? html`<div class="alert warning mt4">${icon('alert')}<div class="grow"><strong>Запис неактивний</strong>Вашого прізвища зараз немає в таблиці рейтингу, тому підвищення бала тимчасово недоступне. Зверніться до адміністратора.</div></div>` : ''}
    <section class="section">
      <div class="section-head"><h2>Бали за предметами</h2>${lastSyncNote(ov.lastSync)}</div>
      <div class="subject-grid">${ov.subjects.map((s) => subjectCard(s, ov))}</div>
      <p class="help mt4">${icon('info', 'inline-ic')} Позначка на смузі — середній бал групи. Підвищити можна лише наявний бал; зменшити його неможливо.</p>
    </section>`);
  ctx.onCleanup(actions(host, {
    increase: (el) => {
      const s = ov.subjects.find((x) => x.key === el.dataset.subject);
      if (s) openIncrease(s, ov, () => { if (ctx.isActive()) scoresTab(ctx, host).catch(toastError); });
    },
  }));
}

function subjectCard(s, ov) {
  const max = ov.scoreMax || 100;
  const pct = s.value == null ? 0 : Math.min(100, (s.value / max) * 100);
  const avgPct = s.groupAvg == null ? null : Math.min(100, (s.groupAvg / max) * 100);
  const canRaise = ov.canIncrease && s.value != null && s.value < max;
  return html`<article class="card subject-card ${s.value == null ? 'empty-score' : ''}">
    <div class="top">
      <div class="grow"><div class="name">${s.name}</div>${s.name !== s.key ? html`<div class="abbr">${s.key}</div>` : ''}</div>
      ${s.delta != null && s.delta !== 0 ? delta(s.delta, { title: 'Зміна відносно попереднього бала' }) : ''}
    </div>
    <div class="score num">${s.value == null ? 'Бал ще не виставлено' : fmtNum(s.value)}${s.value != null ? html` <small>з ${fmtNum(max)}</small>` : ''}</div>
    ${s.value != null ? html`<div class="progress thin" role="img" aria-label="${fmtNum(s.value)} з ${fmtNum(max)}"><span style="width:${pct.toFixed(1)}%"></span>${avgPct != null ? html`<span class="marker" style="left:${avgPct.toFixed(1)}%" title="Середнє групи: ${fmtNum(s.groupAvg)}"></span>` : ''}</div>` : ''}
    <div class="facts">
      ${s.previous != null ? html`<span>Попередній: <b>${fmtNum(s.previous)}</b>${s.percent != null ? html` (${fmtPct(s.percent)})` : ''}</span>` : ''}
      ${s.rank ? html`<span>Місце: <b>${s.rank} з ${s.ranked}</b></span>` : ''}
      ${s.groupAvg != null ? html`<span>Середнє групи: <b>${fmtNum(s.groupAvg)}</b></span>` : ''}
    </div>
    <div class="bottom">
      <span class="xs muted">${s.changedAt ? `${sourceLabel(s.source)} · ${relTime(s.changedAt)}` : ''}</span>
      ${s.value != null ? html`<button type="button" class="btn btn-soft btn-sm" data-action="increase" data-subject="${s.key}" ${canRaise ? '' : 'disabled'} ${s.value >= max ? html`title="Досягнуто найбільшого бала"` : ''}>${icon('arrow-up')} Підвищити</button>` : ''}
    </div>
  </article>`;
}

// ───────── Статистика ─────────
const PERIODS = [['7', '7 днів'], ['30', '30 днів'], ['90', '90 днів'], ['365', 'Рік'], ['all', 'Увесь час']];
const UNITS = [['day', 'Дні'], ['week', 'Тижні'], ['month', 'Місяці']];

export function bucketLabels(series, unit) {
  return {
    labels: series.map((p) => (unit === 'month' ? fmtMonthShort(p.start) : fmtDateShort(p.start))),
    tips: series.map((p) => (unit === 'month' ? fmtMonth(p.start) : unit === 'week' ? `Тиждень з ${fmtDate(p.start)}` : fmtDate(p.start))),
  };
}

async function statsTab(ctx, host) {
  const period = PERIODS.some(([k]) => k === ctx.query.get('period')) ? ctx.query.get('period') : '30';
  const unit = UNITS.some(([k]) => k === ctx.query.get('unit')) ? ctx.query.get('unit') : 'day';
  const [ov, st] = await Promise.all([api('GET', '/api/me/overview'), api('GET', `/api/me/stats?period=${period}&unit=${unit}`)]);
  if (!ctx.isActive()) return;
  if (!ov.linked) { setHTML(host, notLinked()); return; }
  const go = (p, u) => ctx.navigate(`/progress/stats?period=${p}&unit=${u}`, { replace: true });
  const { labels, tips } = bucketLabels(st.series, st.unit);
  const subjects = st.comparison.filter((c) => c.mine != null || c.avg != null);
  const chosen = subjects.some((c) => c.subject === ctx.query.get('subject')) ? ctx.query.get('subject') : (subjects[0] && subjects[0].subject);
  const subjectSeries = chosen ? st.series.map((p) => (p.subjects[chosen] == null ? null : p.subjects[chosen])) : [];
  const changed = st.progress.filter((p) => p.from != null || p.to != null);

  setHTML(host, html`
    <div class="flex wrap between mb4">
      <div class="segmented" role="group" aria-label="Період">${PERIODS.map(([k, l]) => html`<button type="button" data-period="${k}" aria-pressed="${k === st.period}">${l}</button>`)}</div>
      <div class="segmented" role="group" aria-label="Крок">${UNITS.map(([k, l]) => html`<button type="button" data-unit="${k}" aria-pressed="${k === st.unit}">${l}</button>`)}</div>
    </div>
    ${st.unit !== unit ? html`<p class="help mb4">Для такого довгого періоду дані згруповано по ${st.unit === 'week' ? 'тижнях' : 'місяцях'}.</p>` : ''}
    <div class="split">
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Сума балів</h2><span class="hint">${st.trackingSince ? `облік з ${fmtDate(st.trackingSince)}` : ''}</span></div>
          <div class="card-body">
            ${st.hasData ? html`${lineChart({
              labels, tipLabels: tips, ariaLabel: 'Динаміка суми балів',
              series: [
                { label: 'Мій результат', color: 'var(--accent)', values: st.series.map((p) => p.total), area: true },
                { label: 'Середнє групи', color: 'var(--faint)', values: st.series.map((p) => p.groupAvg), dashed: true },
              ],
            })}${legend([{ label: 'Мій результат', color: 'var(--accent)' }, { label: 'Середнє групи', color: 'var(--faint)', dashed: true }])}`
              : html`<div class="chart-empty">За цей період ще немає історії балів. Щойно бали зміняться — тут з’явиться графік.</div>`}
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Місце в рейтингу групи</h2><span class="hint">1 — найвище місце</span></div>
          <div class="card-body">${lineChart({
            labels, tipLabels: tips, invert: true, integer: true, ariaLabel: 'Історія місця в рейтингу', format: (v) => `${v} місце`,
            series: [{ label: 'Місце', color: 'var(--c2)', values: st.series.map((p) => p.rank) }],
            empty: 'Місце в рейтингу з’явиться, щойно накопичиться історія.',
          })}</div>
        </section>
        <section class="card">
          <div class="card-head">
            <h2>Динаміка предмета</h2>
            ${subjects.length ? html`<select class="select sm" style="width:auto;max-width:60%" id="subjectPick" aria-label="Предмет">${subjects.map((c) => html`<option value="${c.subject}" ${c.subject === chosen ? 'selected' : ''}>${c.name}</option>`)}</select>` : ''}
          </div>
          <div class="card-body">${chosen ? lineChart({
            labels, tipLabels: tips, ariaLabel: 'Динаміка бала з предмета',
            series: [{ label: (subjects.find((c) => c.subject === chosen) || {}).name || chosen, color: 'var(--c6)', values: subjectSeries, area: true }],
          }) : html`<div class="chart-empty">Немає предметів з балами.</div>`}</div>
        </section>
      </div>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Прогрес за добу</h2></div>
          ${ov.insights.length ? insightsList(ov.insights) : html`<div class="card-body muted">Поки що немає змін для порівняння.</div>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>Порівняння з групою</h2><span class="hint">риска — середнє групи</span></div>
          <div class="card-body">${hBars(subjects.map((c, i) => ({ label: c.name, value: c.mine, mark: c.avg, color: colorFor(c.subject, i) })), { max: ov.scoreMax, markLabel: 'Середнє групи' })}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Зміни за період</h2><span class="hint">з ${fmtDate(st.from)}</span></div>
          ${changed.length ? html`<div class="table-wrap"><table class="table responsive">
            <thead><tr><th>Предмет</th><th class="r">Було</th><th class="r">Зараз</th><th class="r">Зміна</th></tr></thead>
            <tbody>${changed.map((p) => html`<tr>
              <td class="primary">${p.name}${p.since && p.since > st.from ? html`<div class="xs muted">облік з ${fmtDate(p.since)}</div>` : ''}</td>
              <td class="r num" data-label="Було">${valueInfo(p.from)}</td>
              <td class="r num" data-label="Зараз">${valueInfo(p.to)}</td>
              <td class="r" data-label="Зміна">${p.delta == null ? html`<span class="muted small">новий бал</span>` : html`${delta(p.delta)} ${p.percent != null ? html`<span class="xs muted nowrap">${fmtPct(p.percent)}</span>` : ''}`}</td>
            </tr>`)}</tbody></table></div>`
            : html`<div class="card-body muted">За цей період змін немає.</div>`}
        </section>
      </div>
    </div>`);
  host.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => go(b.dataset.period, unit)));
  host.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => go(period, b.dataset.unit)));
  const pick = $('#subjectPick', host);
  if (pick) pick.addEventListener('change', () => ctx.navigate(`/progress/stats?period=${period}&unit=${unit}&subject=${encodeURIComponent(pick.value)}`, { replace: true }));
}

// ───────── Рейтинг групи ─────────
async function ratingTab(ctx, host) {
  const subject = ctx.query.get('subject') || '';
  const group = ctx.query.get('group') || '';
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (group) params.set('group', group);
  const r = await api('GET', `/api/rating?${params}`);
  if (!ctx.isActive()) return;
  if (r.unassigned) { setHTML(host, notLinked()); return; }
  if (!r.entries.length) {
    setHTML(host, emptyState({ icon: 'award', title: 'Рейтинг порожній', text: 'Щойно з’являться бали, тут буде таблиця рейтингу групи.' }));
    return;
  }
  const names = r.subjectNames || {};
  const nameOf = (s) => names[s] || s;
  const ranked = r.entries.filter((e) => e.rank != null);
  const podium = ranked.length >= 3 ? ranked.slice(0, 3) : [];
  const rest = podium.length ? r.entries.filter((e) => !podium.includes(e)) : r.entries;
  const me = r.entries.find((e) => e.isMe);
  const update = (patch) => {
    const q = new URLSearchParams({ ...(group ? { group } : {}), ...(subject ? { subject } : {}), ...patch });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    ctx.navigate(`/progress/rating${q.toString() ? `?${q}` : ''}`, { replace: true });
  };
  const place = (e, cls) => html`<div class="place ${cls} ${e.isMe ? 'me' : ''}">
    <span class="medal">${e.rank}</span>${avatar(e.fullName, 'sm')}<span class="who">${e.fullName}</span><span class="pts">${valueInfo(e.points)}</span>
  </div>`;
  setHTML(host, html`
    <div class="flex wrap between mb4">
      <div class="flex wrap">
        ${r.groups && r.groups.length ? html`<select class="select sm" style="width:auto" id="groupPick" aria-label="Група">${r.groups.map((g) => html`<option value="${g.name}" ${g.name === r.group ? 'selected' : ''}>${g.name}</option>`)}</select>` : html`<span class="badge outline">${r.group}</span>`}
        <select class="select sm" style="width:auto;max-width:100%" id="subjectPick" aria-label="Предмет">
          <option value="">Загальний рейтинг (сума балів)</option>
          ${r.subjects.map((s) => html`<option value="${s}" ${s === r.subject ? 'selected' : ''}>${nameOf(s)}</option>`)}
        </select>
      </div>
      ${lastSyncNote(r.lastSync)}
    </div>
    ${me ? html`<div class="card card-pad mb4 flex between wrap">
      <div class="flex">${avatar(me.fullName)}<div><div class="strong">Ваше місце: ${me.rank || '—'}${me.rank ? ` з ${ranked.length}` : ''}</div><div class="small muted">${r.subject ? nameOf(r.subject) : 'Сума балів'}: ${valueInfo(me.points)}</div></div></div>
      <button type="button" class="btn btn-secondary btn-sm" data-action="findMe">${icon('target')} Показати в списку</button>
    </div>` : ''}
    ${podium.length ? html`<div class="podium">${place(podium[1], 'p2')}${place(podium[0], 'p1')}${place(podium[2], 'p3')}</div>` : ''}
    <div class="card">${rest.map((e) => html`<div class="rank-row ${e.isMe ? 'me' : ''}" ${e.isMe ? html`id="meRow"` : ''}>
      <span class="pos">${e.rank || '—'}</span>
      <span class="who"><span class="n">${e.fullName}${e.isMe ? html` <span class="badge accent">Ви</span>` : ''}</span>${e.note ? html`<span class="s">${e.note}</span>` : ''}</span>
      <span class="pts">${valueInfo(e.points)}</span>
    </div>`)}</div>
    <p class="help mt4">Однакова кількість балів — однакове місце. Розбивку за предметами бачите лише ви у своєму рядку.</p>`);
  const sp = $('#subjectPick', host);
  sp.addEventListener('change', () => update({ subject: sp.value }));
  const gp = $('#groupPick', host);
  if (gp) gp.addEventListener('change', () => update({ group: gp.value, subject: '' }));
  ctx.onCleanup(actions(host, {
    findMe: () => {
      const row = $('#meRow', host) || host.querySelector('.podium .me');
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  }));
}

// ───────── Історія змін ─────────
export function historyTimeline(items, { admin = false } = {}) {
  let lastDay = '';
  return items.map((i) => {
    const day = dayKey(i.at);
    const head = day !== lastDay ? html`<div class="tl-day">${fmtDate(i.at)}</div>` : '';
    lastDay = day;
    const kind = ['student', 'sheet', 'admin'].includes(i.source) ? i.source : 'other';
    return html`${head}<div class="tl-item">
      <span class="tl-ic ${kind}" title="${sourceLabel(i.source)}">${icon(SOURCE_ICON[i.source] || 'history')}</span>
      <div class="tl-main">
        <div class="tl-title">${i.subjectName}${i.reverted ? html` <span class="badge warning">Скасовано</span>` : ''}</div>
        <div class="tl-meta">${sourceLabel(i.source)}${admin && i.userName ? ` · ${i.userName}` : ''} · ${fmtTime(i.at)}${i.note ? ` · ${i.note}` : ''}</div>
      </div>
      <div class="tl-change">
        <div class="vals num">${i.previous == null ? '' : `${fmtNum(i.previous)} → `}${i.value == null ? 'прибрано' : fmtNum(i.value)}</div>
        ${i.delta != null && i.delta !== 0 ? delta(i.delta) : i.previous == null && i.value != null ? html`<span class="xs muted">перший бал</span>` : ''}
      </div>
    </div>`;
  });
}

async function historyTab(ctx, host) {
  const items = [];
  let next = null;
  let more = false;
  const loadPage = async () => {
    const r = await api('GET', `/api/me/history?limit=40${next ? `&before=${encodeURIComponent(next)}` : ''}`);
    items.push(...r.items);
    next = r.next;
    more = r.more;
  };
  try {
    await loadPage();
  } catch (e) {
    if (e.code === 'not_linked') { if (ctx.isActive()) setHTML(host, notLinked()); return; }
    throw e;
  }
  if (!ctx.isActive()) return;
  const render = () => {
    if (!items.length) {
      setHTML(host, emptyState({ icon: 'history', title: 'Змін ще немає', text: 'Тут з’являтиметься кожна зміна ваших балів: з Google Таблиці, від адміністратора і ваші власні підвищення.' }));
      return;
    }
    const mine = items.filter((i) => i.source === 'student');
    const gained = mine.reduce((a, i) => a + (i.delta || 0), 0);
    setHTML(host, html`
      <div class="card card-pad mb4 stat-strip">
        <div class="st"><div class="v">${items.length}${more ? '+' : ''}</div><div class="l">змін завантажено</div></div>
        <div class="st"><div class="v">${mine.length}</div><div class="l">ваших підвищень</div></div>
        <div class="st"><div class="v">${fmtSigned(Math.round(gained * 100) / 100)}</div><div class="l">${pointsWord(Math.abs(gained))} завдяки підвищенням</div></div>
      </div>
      <div class="card timeline">${historyTimeline(items)}</div>
      ${more ? html`<div class="center mt4"><button type="button" class="btn btn-secondary" data-action="more">Показати ще</button></div>` : ''}`);
  };
  render();
  ctx.onCleanup(actions(host, {
    more: (el) => busy(el, async () => {
      try { await loadPage(); if (ctx.isActive()) render(); } catch (e) { toastError(e); }
    }),
  }));
}

