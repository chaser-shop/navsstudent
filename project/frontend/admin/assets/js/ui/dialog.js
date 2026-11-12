// Modal dialogs and side sheets: focus trap, Escape, backdrop click, optional close guard.
import { html, setHTML } from './dom.js';
import { icon } from './icons.js';

const stack = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function visibleFocusables(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter((x) => x.getClientRects().length > 0);
}

document.addEventListener('keydown', (e) => {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (top.dismissible) top.requestClose();
  } else if (e.key === 'Tab') {
    const f = visibleFocusables(top.panel);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (!top.panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

export const hasOpenLayer = () => stack.length > 0;
export function closeAll() { [...stack].reverse().forEach((c) => c.close()); }

function open({ kind, content, size = '', dismissible = true, label = '', onClose, initialFocus }) {
  const prev = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = `overlay${kind === 'sheet' ? ' is-sheet' : ''}`;
  const panel = document.createElement('div');
  panel.className = kind === 'sheet' ? 'sheet' : `dialog ${size}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if (label) panel.setAttribute('aria-label', label);
  setHTML(panel, content);
  overlay.append(panel);
  document.body.append(overlay);

  let resolve;
  const result = new Promise((r) => { resolve = r; });
  const ctl = {
    overlay, panel, result, dismissible, closed: false, guard: null,
    $(sel) { return panel.querySelector(sel); },
    close(value) {
      if (ctl.closed) return;
      ctl.closed = true;
      stack.splice(stack.indexOf(ctl), 1);
      overlay.classList.remove('is-open');
      setTimeout(() => overlay.remove(), 260);
      if (!stack.length) document.documentElement.style.overflow = '';
      try { onClose?.(value); } finally { resolve(value); }
      if (prev && document.contains(prev) && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
    },
    async requestClose(value) {
      if (ctl.guard && !(await ctl.guard())) return;
      ctl.close(value);
    },
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && ctl.dismissible) ctl.requestClose(); });
  panel.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) ctl.requestClose(); });
  stack.push(ctl);
  document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    overlay.classList.add('is-open');
    const target = (initialFocus && panel.querySelector(initialFocus)) || panel.querySelector('[autofocus]') || visibleFocusables(panel)[0];
    target?.focus({ preventScroll: true });
  });
  return ctl;
}

const closeBtn = (cls = 'dialog-close') =>
  html`<button type="button" class="btn btn-ghost btn-icon btn-sm ${cls}" data-close aria-label="Закрити">${icon('x', { size: 17 })}</button>`;

export function openDialog({ title, description = '', body = '', footer = '', icon: ic, tone = '', size = '', dismissible = true, onClose, initialFocus }) {
  const content = html`${closeBtn()}
    <div class="dialog-header">
      ${ic ? html`<div class="dialog-icon ${tone}">${icon(ic, { size: 20 })}</div>` : ''}
      <div class="grow"><h2 class="dialog-title">${title}</h2>${description ? html`<p class="dialog-desc">${description}</p>` : ''}</div>
    </div>
    ${body ? html`<div class="dialog-body">${body}</div>` : html`<div style="height:20px"></div>`}
    ${footer ? html`<div class="dialog-footer">${footer}</div>` : ''}`;
  return open({ kind: 'dialog', content, size, dismissible, label: title, onClose, initialFocus });
}

/** Resolves to true only when the user explicitly confirms. */
export function confirmDialog({ title, text = '', confirmText = 'Підтвердити', cancelText = 'Скасувати', tone = 'primary', icon: ic }) {
  const danger = tone === 'danger';
  const d = openDialog({
    title, description: text, icon: ic || (danger ? 'triangle-alert' : 'circle-alert'), tone: danger ? 'danger' : '',
    footer: html`<button type="button" class="btn" data-close>${cancelText}</button>
      <button type="button" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-confirm>${confirmText}</button>`,
    initialFocus: danger ? '[data-close]' : '[data-confirm]',
  });
  d.$('[data-confirm]').addEventListener('click', () => d.close(true));
  return d.result.then((v) => v === true);
}

export function openSheet({ title = '', subtitle = '', header, body = '', footer = '', label, onClose, initialFocus }) {
  const content = html`<div class="sheet-header">
      ${header || html`<div class="grow"><h2 class="sheet-title">${title}</h2>${subtitle ? html`<p class="sheet-sub">${subtitle}</p>` : ''}</div>`}
      ${closeBtn()}
    </div>
    <div class="sheet-body">${body}</div>
    <div class="sheet-footer"${footer ? '' : ' hidden'}>${footer}</div>`;
  const ctl = open({ kind: 'sheet', content, label: label || title, onClose, initialFocus });
  ctl.setBody = (c) => setHTML(ctl.$('.sheet-body'), c);
  ctl.setFooter = (c) => { const f = ctl.$('.sheet-footer'); setHTML(f, c); f.hidden = !c; };
  ctl.setHeader = (c) => {
    const h = ctl.$('.sheet-header');
    setHTML(h, html`${c}${closeBtn()}`);
  };
  return ctl;
}
