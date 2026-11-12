// Компоненти інтерфейсу: сповіщення, діалоги (на телефоні — нижній аркуш), стани, дрібні елементи.

import { html } from './dom.js';
import { icon } from './icons.js';
import { initials, colorFor, fmtSigned, fmtPct } from './format.js';

// ───────── Сповіщення ─────────
let toastRoot = null;
export function toast(message, { type = 'info', duration = 3800 } = {}) {
  if (!toastRoot) {
    toastRoot = document.createElement('div');
    toastRoot.className = 'toasts';
    toastRoot.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastRoot);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = String(html`${icon(type === 'success' ? 'check-circle' : type === 'error' ? 'alert' : 'info')}<div>${message}</div>`);
  toastRoot.appendChild(el);
  let gone = false;
  const close = () => {
    if (gone) return;
    gone = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  setTimeout(close, duration);
  el.addEventListener('click', close);
}
export const toastError = (e) => toast((e && e.message) || 'Щось пішло не так. Спробуйте ще раз.', { type: 'error', duration: 5500 });
export const toastSuccess = (m) => toast(m, { type: 'success' });

// ───────── Діалоги ─────────
const stack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * openModal({ title, body, footer, size: ''|'sm'|'lg', dismissible, onMount(m) })
 * → { el, body, close(value), closed: Promise }. Кнопки з атрибутом data-close закривають діалог.
 */
export function openModal({ title, body = '', footer = '', size = '', dismissible = true, onMount } = {}) {
  const prevFocus = document.activeElement;
  const id = `dlg${Math.random().toString(36).slice(2, 8)}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = String(html`
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="${id}" tabindex="-1">
      <div class="modal-head">
        <h2 id="${id}">${title}</h2>
        ${dismissible ? html`<button type="button" class="icon-btn sm" data-close aria-label="Закрити">${icon('x')}</button>` : ''}
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? html`<div class="modal-foot">${footer}</div>` : ''}
    </div>`);
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
  const dialog = backdrop.querySelector('.modal');
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  let done = false;

  const m = {
    el: dialog,
    body: dialog.querySelector('.modal-body'),
    foot: dialog.querySelector('.modal-foot'),
    closed,
    close(value) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      const idx = stack.indexOf(m);
      if (idx >= 0) stack.splice(idx, 1);
      backdrop.classList.add('closing');
      setTimeout(() => {
        backdrop.remove();
        if (!stack.length) document.body.style.overflow = '';
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
      }, 190);
      resolveClosed(value);
    },
  };

  function onKey(e) {
    if (stack[stack.length - 1] !== m) return;
    if (e.key === 'Escape' && dismissible) { e.preventDefault(); m.close(); return; }
    if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && dismissible) m.close(); });
  backdrop.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) { e.preventDefault(); m.close(); } });
  stack.push(m);
  if (onMount) onMount(m);
  requestAnimationFrame(() => {
    const auto = dialog.querySelector('[autofocus]');
    (auto || dialog).focus({ preventScroll: true });
  });
  return m;
}
export const closeAllModals = () => [...stack].reverse().forEach((m) => m.close());

export function confirmDialog({ title, text = '', confirmText = 'Підтвердити', cancelText = 'Скасувати', danger = false }) {
  const m = openModal({
    title, size: 'sm',
    body: text ? html`<p class="muted">${text}</p>` : '',
    footer: html`<button type="button" class="btn btn-secondary" data-close>${cancelText}</button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmText}</button>`,
  });
  m.el.querySelector('[data-ok]').addEventListener('click', () => m.close(true));
  return m.closed.then((v) => v === true);
}

/** Діалог з одним полем. Повертає рядок або null (скасовано). validate(value) → текст помилки або ''. */
export function promptDialog({ title, label, value = '', placeholder = '', help = '', confirmText = 'Зберегти', type = 'text', inputmode = '', validate }) {
  const m = openModal({
    title, size: 'sm',
    body: html`<form class="field" novalidate>
      <label class="label" for="prompt-input">${label}</label>
      <input class="input" id="prompt-input" name="value" type="${type}" value="${value}" placeholder="${placeholder}" ${inputmode ? html`inputmode="${inputmode}"` : ''} autocomplete="off" autofocus>
      ${help ? html`<div class="help">${help}</div>` : ''}
      <div class="error-text" hidden></div>
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-close>Скасувати</button>
      <button type="button" class="btn btn-primary" data-ok>${confirmText}</button>`,
  });
  const input = m.el.querySelector('input');
  const err = m.el.querySelector('.error-text');
  const submit = () => {
    const v = input.value.trim();
    const problem = validate ? validate(v) : '';
    if (problem) { err.textContent = problem; err.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    m.close(v);
  };
  m.el.querySelector('[data-ok]').addEventListener('click', submit);
  m.el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  return m.closed.then((v) => (typeof v === 'string' ? v : null));
}

// ───────── Стани й дрібні компоненти ─────────
export const loading = (text = 'Завантаження…') => html`<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>${text}</span></div>`;

export const emptyState = ({ icon: ic = 'inbox', title, text = '', action = '', compact = false }) => html`
  <div class="empty ${compact ? 'compact' : ''}">
    <div class="empty-icon">${icon(ic)}</div>
    <h3>${title}</h3>
    ${text ? html`<p>${text}</p>` : ''}
    ${action}
  </div>`;

export const errorState = (e, action = 'retry') => html`
  <div class="empty">
    <div class="empty-icon">${icon('alert')}</div>
    <h3>Не вдалося завантажити дані</h3>
    <p>${(e && e.message) || 'Спробуйте ще раз.'}</p>
    <button type="button" class="btn btn-secondary" data-action="${action}">${icon('refresh')} Спробувати ще раз</button>
  </div>`;

export const skeleton = (blocks = 3) => html`<div class="stack" aria-hidden="true">
  ${Array.from({ length: blocks }, () => html`<div class="skeleton sk-block"></div>`)}
</div>`;

export function avatar(name, size = '') {
  return html`<span class="avatar ${size}" style="--av1:${colorFor(name)};--av2:${colorFor(`${name}·`)}" aria-hidden="true">${initials(name)}</span>`;
}

/** Значок зміни: +5 / −3 / 0. pct=true — у відсотках. */
export function delta(value, { pct = false, title = '' } = {}) {
  if (value == null) return '';
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const ic = value > 0 ? 'arrow-up' : value < 0 ? 'arrow-down' : 'minus';
  return html`<span class="delta ${cls}" ${title ? html`title="${title}"` : ''}>${icon(ic)}${pct ? fmtPct(Math.abs(value)).replace(/^[+−]/, '') : fmtSigned(Math.abs(value)).replace(/^[+−]/, '')}</span>`;
}

export function pageHead({ title, subtitle = '', actions = '', back = null, compact = false }) {
  return html`<header class="page-head ${compact ? 'compact-mobile' : ''}">
    <div class="titles">
      ${back ? html`<a class="back-link" href="${back.href}">${icon('arrow-left')} ${back.label}</a>` : ''}
      <h1>${title}</h1>
      ${subtitle ? html`<p class="subtitle">${subtitle}</p>` : ''}
    </div>
    ${actions ? html`<div class="actions">${actions}</div>` : ''}
  </header>`;
}

export function kpi({ label, value, sub = '', ic = '', extra = '' }) {
  return html`<div class="card kpi">
    <div class="kpi-label">${ic ? icon(ic) : ''}${label}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}
    ${extra}
  </div>`;
}

export function switchInput({ name, checked, label, disabled = false }) {
  return html`<span class="switch"><input type="checkbox" role="switch" name="${name}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${label}"><span class="track"></span></span>`;
}

/** Повноекранний перегляд зображення. */
export function viewImage(src, alt = 'Зображення') {
  openModal({ title: alt, size: 'lg', body: html`<img src="${src}" alt="${alt}" style="width:100%;border-radius:12px">` });
}
