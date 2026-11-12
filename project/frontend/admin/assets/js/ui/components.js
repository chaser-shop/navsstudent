// Small presentational helpers that return escaped HTML fragments.
import { html, raw } from './dom.js';
import { icon } from './icons.js';
import { AVAILABILITY, COMPLIANCE, ORDER_STATUS } from '../core/labels.js';
import { change, hashTone, initials, int } from '../core/format.js';

export const badge = (text, tone = '', { dot = false, ic = '' } = {}) =>
  html`<span class="badge ${tone ? `badge-${tone}` : ''}">${dot ? raw('<span class="dot"></span>') : ''}${ic ? icon(ic, { size: 13 }) : ''}${text}</span>`;

export function statusBadge(s) {
  const x = ORDER_STATUS[s] || { label: s || '—', tone: '' };
  return badge(x.label, x.tone, { dot: true });
}
export function availabilityBadge(s) {
  const x = AVAILABILITY[s] || { label: 'Невідомо', tone: '' };
  return badge(x.label, x.tone, { dot: true });
}
export function complianceBadge(c, { short = false } = {}) {
  const x = COMPLIANCE[c?.status];
  return x ? badge(short ? x.short : x.label, x.tone, { ic: x.icon }) : badge('Без позначки', '');
}

export const avatar = (name, cls = '') =>
  html`<span class="avatar tone-${hashTone(name)} ${cls}" aria-hidden="true">${initials(name)}</span>`;

export const thumb = (ref, { cls = '', alt = '' } = {}) =>
  html`<span class="thumb ${cls}">${icon('image', { size: 16 })}${ref ? html`<img data-ref="${ref}" alt="${alt}" decoding="async">` : ''}</span>`;

export function emptyState({ ic = 'inbox', title, text = '', action = '', compact = false, error = false }) {
  return html`<div class="empty ${compact ? 'compact' : ''} ${error ? 'is-error' : ''}">
    <div class="empty-icon">${icon(ic, { size: compact ? 19 : 22 })}</div>
    <div class="empty-title">${title}</div>
    ${text ? html`<div class="empty-text">${text}</div>` : ''}
    ${action}
  </div>`;
}

export const errorState = (message, { compact = false } = {}) => emptyState({
  ic: 'circle-alert', error: true, compact, title: 'Не вдалося завантажити дані', text: message,
  action: html`<button type="button" class="btn btn-sm" data-retry>${icon('refresh-cw', { size: 15 })}Спробувати ще раз</button>`,
});

const widths = [62, 48, 74, 55, 68, 44, 58, 71];
export const skeletonRows = (n = 6, { thumb: withThumb = true } = {}) => html`<div aria-busy="true" aria-label="Завантаження">
  ${Array.from({ length: n }, (_, i) => html`<div class="sk-row">
    ${withThumb ? raw('<div class="skeleton sk-thumb"></div>') : ''}
    <div class="grow stack stack-sm"><div class="skeleton sk-line" style="width:${widths[i % 8]}%"></div>
    <div class="skeleton sk-line" style="width:${widths[(i + 3) % 8] / 2}%"></div></div>
    <div class="skeleton sk-line" style="width:72px"></div></div>`)}
</div>`;

export const skeletonCards = (n = 4) => Array.from({ length: n }, () => html`<div class="card kpi" aria-hidden="true">
  <div class="row"><div class="skeleton" style="width:32px;height:32px;border-radius:10px"></div><div class="skeleton sk-line" style="width:45%"></div></div>
  <div class="skeleton sk-kpi"></div><div class="skeleton sk-line" style="width:70%"></div></div>`);

export function kpi({ label, value, sub = '', ic = 'circle-dot', tone = '', empty = false }) {
  return html`<div class="card kpi">
    <div class="kpi-top"><span class="kpi-icon ${tone}">${icon(ic, { size: 17 })}</span>${label}</div>
    <div class="kpi-value ${empty ? 'is-empty' : ''}">${value}</div>
    ${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

export function deltaBadge(cur, prev) {
  const c = change(cur, prev);
  const ic = c.dir === 'up' ? 'arrow-up-right' : c.dir === 'down' ? 'arrow-down-right' : '';
  return html`<span class="delta ${c.dir}">${ic ? icon(ic, { size: 13 }) : ''}${c.text}</span>`;
}

export function field({ id, label, control, hint = '', required = false, cls = '' }) {
  return html`<div class="field ${cls}">
    <label class="label" for="${id}">${label}${required ? html`<span class="req" aria-hidden="true">*</span>` : ''}</label>
    ${control}
    ${hint ? html`<div class="hint" id="${id}-hint">${hint}</div>` : ''}
    <div class="field-error" id="${id}-error"></div>
  </div>`;
}

export function setFieldError(root, id, msg = '') {
  const input = root.querySelector(`#${id}`);
  const err = root.querySelector(`#${id}-error`);
  if (input) {
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) input.setAttribute('aria-describedby', `${id}-error`);
  }
  if (err) err.textContent = msg;
  return !msg;
}

export function setLoading(btn, on) {
  if (!btn) return;
  btn.classList.toggle('is-loading', Boolean(on));
  btn.disabled = Boolean(on);
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

export const options = (opts, value) =>
  opts.map(([v, l]) => html`<option value="${v}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${l}</option>`);

export function segmented(items, value, { attr = 'data-value', label = '' } = {}) {
  return html`<div class="segmented" role="group" ${label ? html`aria-label="${label}"` : ''}>
    ${items.map(([v, text, n]) => html`<button type="button" ${raw(attr)}="${v}" aria-pressed="${String(String(v) === String(value))}">${text}${n != null ? html`<span class="count">${int(n)}</span>` : ''}</button>`)}
  </div>`;
}

/** Compact page list with ellipses. */
export function pagination({ page, pages, total, limit }) {
  if (!total) return '';
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const nums = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const sorted = [...nums].sort((a, b) => a - b);
  const btns = [];
  sorted.forEach((n, i) => {
    if (i && n - sorted[i - 1] > 1) btns.push(html`<span class="page-gap">…</span>`);
    btns.push(html`<button type="button" class="page-btn" data-page="${n}" ${n === page ? raw('aria-current="page"') : ''} aria-label="Сторінка ${n}">${n}</button>`);
  });
  return html`<nav class="pagination" aria-label="Сторінки">
    <span class="muted small">${int(from)}–${int(to)} з ${int(total)}</span>
    ${pages > 1 ? html`<div class="pages">
      <button type="button" class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Попередня сторінка">${icon('chevron-left', { size: 16 })}</button>
      ${btns}
      <button type="button" class="page-btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Наступна сторінка">${icon('chevron-right', { size: 16 })}</button>
    </div>` : ''}
  </nav>`;
}
