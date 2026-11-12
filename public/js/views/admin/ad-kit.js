// Спільні утиліти сторінок адміністратора: «Огляд», «Аналітика», «Студенти», «Студент», «Зміни балів», «Синхронізація».
// Це не маршрут, а допоміжний модуль: усе, що потрібне кільком сторінкам (підписи, графіки, хронологія, адреса).

import { html, raw, setHTML } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { delta } from '../../core/ui.js';
import {
  fmtNum, fmtPct, fmtDate, fmtDateShort, fmtDateYear, fmtDateTime, fmtMonth, fmtMonthShort, fmtTime, dayKey, sourceLabel,
} from '../../core/format.js';

export const round2 = (n) => Math.round(n * 100) / 100;
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ───────── Імена й посилання ─────────
export function shortName(full) {
  const p = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (p.length < 2) return p[0] || '';
  return `${p[0]} ${p.slice(1).map((x) => `${x[0].toLocaleUpperCase('uk')}.`).join(' ')}`;
}
export const studentHref = (id) => `/admin/students/${encodeURIComponent(id)}`;
export const studentLink = (id, name, { short = false } = {}) => html`<a href="${studentHref(id)}" title="${name}">${short ? shortName(name) : name}</a>`;

// ───────── Періоди й масштаб ─────────
export const PERIODS = [
  { value: '7', label: '7 днів' },
  { value: '30', label: '30 днів' },
  { value: '90', label: '90 днів' },
  { value: '365', label: 'Рік' },
  { value: 'all', label: 'Увесь час' },
];
export const UNITS = [
  { value: 'day', label: 'Дні' },
  { value: 'week', label: 'Тижні' },
  { value: 'month', label: 'Місяці' },
];
export const periodText = (p) => ({ 7: 'за 7 днів', 30: 'за 30 днів', 90: 'за 90 днів', 365: 'за рік', all: 'за весь час' }[p] || 'за період');
// Масштаб за замовчуванням для графіків окремого студента: довгі періоди не мають розсипатися на сотні точок.
export const defaultUnit = (period) => ({ 90: 'week', 365: 'month' }[period] || 'day');

export function segmented({ action, options, value, label }) {
  return html`<div class="segmented" role="group" aria-label="${label}">${options.map((o) => html`<button type="button" data-action="${action}" data-value="${o.value}" aria-pressed="${String(String(o.value) === String(value))}">${o.label}</button>`)}</div>`;
}
export function setPressed(group, value) {
  if (!group) return;
  group.querySelectorAll('button[data-value]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(value))));
}

// Підписи осі часу: короткі — для осі, повні — для підказок.
export function bucketLabels(list, unit) {
  return {
    labels: list.map((b) => (unit === 'month' ? fmtMonthShort(b.start) : fmtDateShort(b.start))),
    tips: list.map((b) => (unit === 'month' ? fmtMonth(b.start) : unit === 'week' ? `Тиждень із ${fmtDate(b.start)}` : fmtDate(b.start))),
  };
}

// ───────── Адреса, запити, затримка ─────────
export const apiQuery = (values) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v != null && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
};
// Фільтри живуть в адресі, але без нового запису в історії й без перемальовування сторінки.
export function replaceQuery(values, defaults = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v != null && v !== '' && v !== defaults[k]) q.set(k, v);
  const s = q.toString();
  history.replaceState({}, '', `${location.pathname}${s ? `?${s}` : ''}${location.hash}`);
}
export function debounce(fn, ms = 300) {
  let t = 0;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
/** Лічильник запитів: відповідь застарілого запиту не має перезаписувати свіжіший результат. */
export function sequencer() {
  let n = 0;
  return { next: () => ++n, isLatest: (id) => id === n };
}
export const modalOpen = () => !!document.querySelector('.modal-backdrop');
/** Користувач зараз щось вводить або відкрив діалог — фонове оновлення сторінки слід пропустити. */
export function uiLocked(root) {
  const a = document.activeElement;
  return modalOpen() || !!(root && a && root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
}
export function poll(ctx, fn, ms) {
  const id = setInterval(() => { if (document.visibilityState === 'visible' && ctx.isActive()) fn(); }, ms);
  ctx.onCleanup(() => clearInterval(id));
}

// ───────── Графіки ─────────
// Діаграми малюються за реальною шириною контейнера, щоб підписи не дрібнішали, і перемальовуються при зміні розміру.
export const chartSlot = (name, height = 240) => html`<div class="ad-chart" data-ad-chart="${name}" style="min-height:${height}px"></div>`;
export function chartHost(ctx, root) {
  let specs = {};
  let lastWidth = 0;
  let raf = 0;
  const draw = () => {
    for (const el of root.querySelectorAll('[data-ad-chart]')) {
      const build = specs[el.dataset.adChart];
      const width = Math.floor(el.clientWidth);
      if (!build || width < 120) continue;
      setHTML(el, build(width));
      el.style.minHeight = '';
    }
  };
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      const w = Math.round(root.clientWidth);
      if (Math.abs(w - lastWidth) < 3) return;
      lastWidth = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (ctx.isActive()) draw(); });
    });
    ro.observe(root);
  }
  ctx.onCleanup(() => { cancelAnimationFrame(raf); if (ro) ro.disconnect(); });
  return {
    set(next) { specs = next; lastWidth = Math.round(root.clientWidth); draw(); },
    draw,
  };
}

// Для лічильників: barChart не має режиму цілих поділок, тож дробові підписи осі Y (0,5; 2,5) прибираємо.
export function wholeAxis(chart) {
  return raw(String(chart).replace(/<text class="axis-label" [^>]*?text-anchor="end">([^<]*)<\/text>/g, (m, label) => (/[,.]/.test(label) ? '' : m)));
}

export const SOURCE_SERIES = [
  { key: 'student', label: 'Студенти', color: 'var(--c1)' },
  { key: 'sheet', label: 'Google Таблиця', color: 'var(--c2)' },
  { key: 'admin', label: 'Адміністратор', color: 'var(--c3)' },
];
export const activitySeries = (activity) => SOURCE_SERIES.map((s) => ({ label: s.label, color: s.color, values: activity.map((a) => a[s.key] || 0) }));
export const sumActivity = (activity) => activity.reduce((n, a) => n + (a.student || 0) + (a.sheet || 0) + (a.admin || 0), 0);

// ───────── Джерела змін, зміни значень ─────────
const SOURCE_UI = {
  student: { ic: 'user', badge: 'accent' },
  sheet: { ic: 'sheet', badge: 'success' },
  admin: { ic: 'shield', badge: 'warning' },
  import: { ic: 'upload', badge: 'info' },
  baseline: { ic: 'database', badge: 'outline' },
};
export const sourceIcon = (s) => (SOURCE_UI[s] || { ic: 'history' }).ic;
export const sourceBadge = (s) => html`<span class="badge ${(SOURCE_UI[s] || {}).badge || ''}">${icon(sourceIcon(s))}${sourceLabel(s)}</span>`;
export function whoText(item) {
  switch (item.source) {
    case 'student': return 'Студент';
    case 'sheet': return 'Google Таблиця';
    case 'baseline': return 'Початкове значення';
    case 'admin': return item.userName ? `Адміністратор: ${item.userName}` : 'Адміністратор';
    case 'import': return item.userName ? `Імпорт файлу: ${item.userName}` : 'Імпорт файлу';
    default: return sourceLabel(item.source);
  }
}
export function changeDelta(item) {
  if (isNum(item.previous) && isNum(item.value)) return round2(item.value - item.previous);
  return isNum(item.delta) ? item.delta : null;
}
export function changeValues(item) {
  const fresh = html`<span class="ad-tag">новий</span>`;
  const gone = html`<span class="ad-tag">видалено</span>`;
  if (item.value == null) return html`<span class="num strong">${item.previous == null ? '—' : fmtNum(item.previous)} → ${gone}</span>`;
  if (item.previous == null) return html`<span class="num strong">${fresh} ${fmtNum(item.value)}</span>`;
  return html`<span class="num strong">${fmtNum(item.previous)} → ${fmtNum(item.value)}</span>`;
}
export const deltaPill = (item) => { const d = changeDelta(item); return d == null ? '' : delta(d); };
export const percentNote = (item) => (item.percent == null ? '' : html`<span class="ad-pct">${fmtPct(item.percent)}</span>`);
export const revertedBadge = (item) => html`<span class="badge" title="${item.revertedByName ? `Скасував: ${item.revertedByName}${item.revertedAt ? `, ${fmtDateTime(item.revertedAt)}` : ''}` : 'Цю зміну скасовано'}">${icon('undo')}Скасовано</span>`;

// ───────── Хронологія за днями ─────────
export function dayTitle(key) {
  if (key === dayKey(Date.now())) return 'Сьогодні';
  if (key === dayKey(Date.now() - 86400000)) return 'Учора';
  return fmtDateYear(new Date(`${key}T12:00:00Z`));
}
export function groupByDay(items) {
  const groups = [];
  for (const it of items) {
    const key = dayKey(it.at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(it);
    else groups.push({ key, items: [it] });
  }
  return groups;
}
export function historyRow(item, { showStudent = false } = {}) {
  const meta = [
    showStudent ? item.subjectName : '',
    whoText(item),
    fmtTime(item.at),
  ].filter(Boolean).join(' · ');
  const pill = deltaPill(item);
  return html`<div class="tl-item ${item.reverted ? 'ad-reverted' : ''}">
    <span class="tl-ic ${item.source}">${icon(sourceIcon(item.source))}</span>
    <div class="tl-main">
      <div class="tl-title">${showStudent ? studentLink(item.ratingId, item.studentName) : item.subjectName}</div>
      <div class="tl-meta">${meta}${item.note ? html`<span class="ad-note"> · ${item.note}</span>` : ''} ${item.reverted ? revertedBadge(item) : ''}</div>
    </div>
    <div class="tl-change">
      <div class="vals">${changeValues(item)}</div>
      ${pill ? html`<div class="ad-change-sub">${pill} ${percentNote(item)}</div>` : ''}
    </div>
  </div>`;
}
export function historyTimeline(items, opts) {
  return html`<div class="timeline">${groupByDay(items).map((g) => html`<div class="tl-day">${dayTitle(g.key)}</div>${g.items.map((i) => historyRow(i, opts))}`)}</div>`;
}

// ───────── Синхронізація ─────────
export const MODE_LABELS = { public: 'Публічне посилання', 'service-account': 'Сервісний акаунт', 'csv-url': 'Опублікований CSV' };
export const modeLabel = (m) => MODE_LABELS[m] || 'Невідомий режим';
export const MODE_HINTS = {
  public: 'Таблицю читають за посиланням для перегляду — ключі й паролі не потрібні.',
  'service-account': 'Таблицю читає службовий акаунт Google із ключем, який зберігається лише на сервері.',
  'csv-url': 'Дані беруться з файлу CSV, опублікованого з Google Таблиці в Інтернеті.',
};
/** Підсумок стану: працює, помилка, вимкнено або ще не запускалась. */
export function syncVerdict(s) {
  if (!s.enabled) return { key: 'off', label: 'Вимкнено' };
  if (s.lastError) return { key: 'error', label: 'Помилка' };
  if (s.lastSuccessAt) return { key: 'ok', label: 'Працює' };
  return { key: 'wait', label: 'Очікує першого запуску' };
}
export const statusPill = (v) => html`<span class="ad-status ${v.key}"><i class="ad-dot"></i>${v.label}</span>`;
export const RUN_STATUS = {
  success: { badge: 'success', label: 'Успішно' },
  unchanged: { badge: '', label: 'Без змін' },
  partial: { badge: 'warning', label: 'Частково' },
  error: { badge: 'danger', label: 'Помилка' },
};
export const runBadge = (status) => { const r = RUN_STATUS[status] || { badge: '', label: 'Невідомо' }; return html`<span class="badge ${r.badge}">${r.label}</span>`; };
export function fmtDuration(ms) {
  if (!isNum(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} мс` : `${fmtNum(ms / 1000, 1)} с`;
}
export function intervalText(ms) {
  if (!isNum(ms) || ms <= 0) return '—';
  const min = Math.round(ms / 60000);
  return min >= 60 && min % 60 === 0 ? `кожні ${min / 60} год` : `кожні ${min} хв`;
}
export const exactTime = (d) => (d ? fmtDateTime(d) : '—');

// ───────── Дрібні блоки ─────────
export function alertRow({ tone = 'info', ic = 'info', title, text = '', href = '' }) {
  const body = html`${icon(ic)}<div class="grow"><strong>${title}</strong>${text}</div>${href ? icon('chevron-right') : ''}`;
  return href
    ? html`<a class="alert ${tone} ad-alert" href="${href}">${body}</a>`
    : html`<div class="alert ${tone}">${body}</div>`;
}
export const inlineError = (e, retry = true) => html`<div class="alert danger">${icon('alert')}<div class="grow"><strong>Не вдалося завантажити дані</strong>${(e && e.message) || 'Спробуйте ще раз.'}</div>${retry ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="retry">Повторити</button>` : ''}</div>`;
export const mutedNote = (text) => html`<div class="ad-note-box">${text}</div>`;
