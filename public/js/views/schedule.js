// Розклад: навігація тижнями, вибір дня, пари дня (на великому екрані — весь тиждень) і вікно з деталями пари.

import { LS } from '../core/api.js';
import { html, setHTML, actions, busy } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { store, sync, on as onStore, canModerate, subjectName, subjectLink, teacherName } from '../core/store.js';
import { fmtDate, fmtWeekday, fmtWeekdayShort, fmtTime, dayKey, pairsWord, colorFor } from '../core/format.js';
import { toast, toastSuccess, toastError, openModal, emptyState, pageHead } from '../core/ui.js';
import {
  lessons, lessonById, lessonHomework, safeLink, kindLabel, placeLabel, todayKey, addDays, dayDate, weekStart, cap,
  attachments, hydrateImages, bindImageViewer, statusBadge, dueText, answerNoHomework, uiBusy,
} from './homework.js';

const weekdayName = (key) => cap(fmtWeekday(dayDate(key)));
const dayTitle = (key) => `${weekdayName(key)}, ${fmtDate(dayDate(key))}`;

function lessonRow(l, now) {
  const live = l.start <= now && now < l.end;
  const past = l.end <= now;
  const hw = lessonHomework(l);
  const hwCount = hw.given.length + hw.due.length;
  const place = placeLabel(l);
  return html`<button type="button" class="lesson st-lesson ${live ? 'now' : ''} ${past ? 'past' : ''}" data-action="lesson" data-id="${l.id}" style="--lc:${colorFor(l.subjectKey)}">
    <span class="time"><span class="t1">${fmtTime(l.start)}</span><span class="t2">${fmtTime(l.end)}</span></span>
    <span class="bar"></span>
    <span class="info">
      <span class="subj">${subjectName(l.subjectKey)}</span>
      <span class="details">
        <span>${kindLabel(l.kind)}</span>
        ${place ? html`<span>${place}</span>` : ''}
        ${l.teacher ? html`<span>${teacherName(l.teacher)}</span>` : ''}
      </span>
    </span>
    <span class="st-lesson-side">
      ${live ? html`<span class="badge accent">Зараз</span>` : ''}
      ${hwCount ? html`<span class="badge warning" title="Домашнє, пов’язане з цією парою">${icon('book')}${hwCount}</span>` : ''}
    </span>
  </button>`;
}

export default async function view(ctx) {
  const root = ctx.root;
  if (!store.data) await sync();
  if (!ctx.isActive()) return;

  const wide = window.matchMedia('(min-width: 1024px)');
  let selected = todayKey();
  let pref = LS.get('scheduleMode', null); // 'day' | 'week' | null (на великому екрані за замовчуванням — тиждень)
  const mode = () => (wide.matches && pref !== 'day' ? 'week' : 'day');

  function groupByDay() {
    const map = new Map();
    for (const l of lessons()) {
      const k = dayKey(l.start);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(l);
    }
    return map;
  }

  function weekNote(start, today) {
    const diff = Math.round((dayDate(start) - dayDate(weekStart(today))) / (7 * 86400000));
    if (diff === 0) return 'Цей тиждень';
    if (diff === 1) return 'Наступний тиждень';
    if (diff === -1) return 'Минулий тиждень';
    return start.slice(0, 4);
  }

  function draw() {
    const all = lessons();
    const now = new Date();
    const today = todayKey();
    const start = weekStart(selected);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const byDay = groupByDay();
    const sameMonth = days[0].slice(5, 7) === days[6].slice(5, 7);
    const range = sameMonth ? `${Number(days[0].slice(8))} – ${fmtDate(dayDate(days[6]))}` : `${fmtDate(dayDate(days[0]))} – ${fmtDate(dayDate(days[6]))}`;
    const asWeek = mode() === 'week';
    const title = (store.data && store.data.scheduleTitle) || '';

    const jump = (afterKey) => {
      const next = all.find((l) => dayKey(l.start) > afterKey);
      return next ? html`<button type="button" class="btn btn-soft btn-sm" data-action="day" data-key="${dayKey(next.start)}">Найближчі пари — ${dayTitle(dayKey(next.start))}</button>` : '';
    };
    const rows = (key) => (byDay.get(key) || []).map((l) => lessonRow(l, now));

    const dayChips = days.map((k) => {
      const list = byDay.get(k) || [];
      const sel = k === selected;
      return html`<button type="button" class="st-day ${sel ? 'is-selected' : ''} ${k === today ? 'is-today' : ''} ${list.length ? '' : 'is-empty'}" data-action="day" data-key="${k}" aria-pressed="${sel ? 'true' : 'false'}" aria-label="${`${dayTitle(k)}${k === today ? ', сьогодні' : ''}, ${list.length ? `${list.length} ${pairsWord(list.length)}` : 'пар немає'}`}">
        <span class="st-day-w">${cap(fmtWeekdayShort(dayDate(k)))}</span>
        <span class="st-day-n">${Number(k.slice(8))}</span>
        <span class="st-dots" aria-hidden="true">${list.slice(0, 5).map((l) => html`<i style="--lc:${colorFor(l.subjectKey)}"></i>`)}</span>
      </button>`;
    });

    const dayView = () => {
      const list = byDay.get(selected) || [];
      return html`
        <div class="st-days" role="group" aria-label="Дні тижня">${dayChips}</div>
        <section class="section">
          <div class="section-head">
            <h2>${dayTitle(selected)} ${selected === today ? html`<span class="badge accent">Сьогодні</span>` : ''}</h2>
            <span class="hint">${list.length ? `${list.length} ${pairsWord(list.length)}` : ''}</span>
          </div>
          ${list.length
    ? html`<div class="card st-rows">${rows(selected)}</div>`
    : html`<div class="card">${emptyState({ icon: 'calendar', title: 'У цей день пар немає', text: 'Можна відпочити або переглянути інші дні.', compact: true, action: jump(selected) })}</div>`}
        </section>`;
    };

    const weekView = () => {
      const filled = days.filter((k) => byDay.has(k));
      const free = days.filter((k) => !byDay.has(k));
      if (!filled.length) return html`<div class="card">${emptyState({ icon: 'calendar', title: 'На цьому тижні пар немає', compact: true, action: jump(days[6]) })}</div>`;
      return html`
        <div class="st-weekgrid">${filled.map((k) => html`<section class="card st-daycard ${k === today ? 'is-today' : ''}">
          <div class="card-head"><h2>${dayTitle(k)}</h2>${k === today ? html`<span class="badge accent">Сьогодні</span>` : html`<span class="hint">${byDay.get(k).length} ${pairsWord(byDay.get(k).length)}</span>`}</div>
          <div class="st-rows">${rows(k)}</div>
        </section>`)}</div>
        ${free.length ? html`<p class="muted small st-free">Без пар: ${free.map((k) => fmtWeekday(dayDate(k))).join(', ')}.</p>` : ''}`;
    };

    setHTML(root, html`<div class="st-page">
      ${pageHead({
    title: 'Розклад', subtitle: title,
    actions: canModerate() && all.length ? html`<a class="btn btn-secondary btn-sm" href="/admin/schedule">${icon('upload')} Оновити розклад</a>` : '',
  })}
      ${!all.length
    ? html`<div class="card">${emptyState({
      icon: 'calendar', title: 'Розкладу ще немає',
      text: canModerate() ? 'Завантажте файл розкладу — його одразу побачать усі студенти.' : 'Адміністратор чи староста ще не завантажили розклад. Зазирніть сюди пізніше.',
      action: canModerate() ? html`<a class="btn btn-primary" href="/admin/schedule">${icon('upload')} Завантажити розклад</a>` : '',
    })}</div>`
    : html`
      <div class="st-weekbar">
        <div class="st-weekinfo"><strong>${range}</strong><span>${weekNote(start, today)}</span></div>
        <div class="st-weeknav">
          ${wide.matches ? html`<div class="segmented desktop-only" role="group" aria-label="Вигляд розкладу">
            <button type="button" data-action="mode" data-mode="day" aria-pressed="${asWeek ? 'false' : 'true'}">День</button>
            <button type="button" data-action="mode" data-mode="week" aria-pressed="${asWeek ? 'true' : 'false'}">Тиждень</button>
          </div>` : ''}
          <button type="button" class="btn btn-secondary btn-sm" data-action="today">Сьогодні</button>
          <button type="button" class="icon-btn" data-action="prev" aria-label="Попередній тиждень">${icon('chevron-left')}</button>
          <button type="button" class="icon-btn" data-action="next" aria-label="Наступний тиждень">${icon('chevron-right')}</button>
        </div>
      </div>
      ${asWeek ? weekView() : dayView()}`}
    </div>`);
  }

  // ───────── Вікно з деталями пари ─────────

  function hwMini(h) {
    return html`<div class="st-hwmini">
      <div class="st-hwtext">${h.text}</div>
      ${attachments(h)}
      <div class="meta"><span>${icon('calendar')} ${dueText(dayKey(h.due))}</span>${statusBadge(h)}</div>
    </div>`;
  }

  function openLesson(id, { join = false } = {}) {
    const l = lessonById(id);
    if (!l) { toast('Пару не знайдено — можливо, розклад оновився.', { type: 'error' }); return null; }
    const url = safeLink(subjectLink(l.subjectKey));
    const now = new Date();
    const live = l.start <= now && now < l.end;
    const hw = lessonHomework(l);
    const noHw = ((store.data && store.data.noHomework) || []).includes(l.id);
    const place = placeLabel(l);
    const key = dayKey(l.start);

    const m = openModal({
      title: subjectName(l.subjectKey),
      body: html`<div class="stack">
        <div class="flex wrap">
          <span class="badge accent">${kindLabel(l.kind)}</span>
          ${live ? html`<span class="badge success">Зараз іде</span>` : ''}
          ${l.end <= now ? html`<span class="badge outline">Завершено</span>` : ''}
        </div>
        ${url ? html`<a class="btn btn-primary btn-lg btn-block st-join" href="${url}" target="_blank" rel="noopener noreferrer" data-role="join">${icon('video')} Приєднатися до пари</a>` : ''}
        <dl class="kv">
          <dt>Дата</dt><dd>${dayTitle(key)}</dd>
          <dt>Час</dt><dd>${fmtTime(l.start)} – ${fmtTime(l.end)}${l.pair ? ` · ${l.pair} пара` : ''}</dd>
          <dt>Тип</dt><dd>${kindLabel(l.kind)}</dd>
          <dt>Де</dt><dd>${place || 'Не вказано'}</dd>
          ${l.teacher ? html`<dt>Викладач</dt><dd>${teacherName(l.teacher)}</dd>` : ''}
          ${l.topic ? html`<dt>Тема</dt><dd>${l.topic}</dd>` : ''}
        </dl>
        <section class="st-sec">
          <h3>Домашнє на цій парі</h3>
          ${hw.given.length ? html`<div class="st-hwlist">${hw.given.map(hwMini)}</div>`
    : html`<p class="muted small">${noHw ? 'Позначено, що на цю пару нічого не задали.' : 'На цій парі нічого не записано.'}</p>`}
        </section>
        ${hw.due.length ? html`<section class="st-sec"><h3>Потрібно здати на цю пару</h3><div class="st-hwlist">${hw.due.map(hwMini)}</div></section>` : ''}
      </div>`,
      footer: html`<button type="button" class="btn btn-soft" data-action="add-hw">${icon('plus')} Записати ДЗ</button>
        ${canModerate() && !noHw ? html`<button type="button" class="btn btn-secondary" data-action="no-hw">${icon('check')} Нічого не задали</button>` : ''}`,
    });
    hydrateImages(m.body);
    bindImageViewer(m.el);
    actions(m.el, {
      'add-hw': () => ctx.navigate(`/homework?lesson=${encodeURIComponent(l.id)}&new=1`),
      'no-hw': (btn) => busy(btn, async () => {
        try {
          await answerNoHomework(l.id);
          toastSuccess('Позначено: на цю пару нічого не задали.');
          m.close();
        } catch (e) { toastError(e); }
      }),
    });
    if (join && url && (LS.get('settings') || {}).autoOpenLink !== false) {
      try { window.open(url, '_blank', 'noopener'); } catch { /* браузер міг заблокувати вікно */ }
    }
    m.closed.then(() => { if (ctx.isActive() && !uiBusy(root)) draw(); });
    return m;
  }

  ctx.onCleanup(actions(root, {
    lesson: (b) => openLesson(b.dataset.id),
    day: (b) => { selected = b.dataset.key; draw(); },
    prev: () => { selected = addDays(selected, -7); draw(); },
    next: () => { selected = addDays(selected, 7); draw(); },
    today: () => { selected = todayKey(); draw(); },
    mode: (b) => { pref = b.dataset.mode; LS.set('scheduleMode', pref); draw(); },
  }));
  const onSync = () => { if (!uiBusy(root)) draw(); };
  ctx.onCleanup(onStore('sync', onSync));
  const onWide = () => { if (!uiBusy(root)) draw(); };
  wide.addEventListener('change', onWide);
  ctx.onCleanup(() => wide.removeEventListener('change', onWide));
  const timer = setInterval(() => { if (!uiBusy(root)) draw(); }, 60000);
  ctx.onCleanup(() => clearInterval(timer));

  // Глибоке посилання зі сповіщення чи головної: /schedule?lesson=<id>[&join=1]
  const lessonId = ctx.query.get('lesson');
  const target = lessonId ? lessonById(lessonId) : null;
  if (target) selected = dayKey(target.start);
  draw();
  if (lessonId) {
    const join = ctx.query.get('join') === '1';
    history.replaceState(history.state, '', location.pathname);
    openLesson(lessonId, { join });
  }
}
