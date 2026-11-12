// Toast notifications (stacked, auto-dismiss, pause on hover).
import { html, setHTML } from './dom.js';
import { icon } from './icons.js';

let region;
const ICON = { success: 'circle-check', error: 'circle-alert', info: 'info' };

function ensureRegion() {
  if (!region || !document.body.contains(region)) {
    region = document.createElement('div');
    region.className = 'toast-region';
    document.body.append(region);
  }
  return region;
}

export function toast(message, type = 'info', { timeout } = {}) {
  const r = ensureRegion();
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  setHTML(t, html`${icon(ICON[type] || 'info', { size: 18 })}<div class="toast-msg">${message}</div>
    <button class="toast-close" type="button" aria-label="Закрити сповіщення">${icon('x', { size: 15 })}</button>`);
  const close = () => {
    if (t.classList.contains('is-leaving')) return;
    t.classList.add('is-leaving');
    setTimeout(() => t.remove(), 190);
  };
  t.querySelector('.toast-close').addEventListener('click', close);
  let timer = setTimeout(close, timeout ?? (type === 'error' ? 6500 : 3800));
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => { timer = setTimeout(close, 2000); });
  r.append(t);
  while (r.children.length > 4) r.firstElementChild.remove();
  return close;
}
toast.success = (m, o) => toast(m, 'success', o);
toast.error = (m, o) => toast(m, 'error', o);
toast.info = (m, o) => toast(m, 'info', o);

/** Shows an API/JS error unless the request was aborted or the session expired (handled globally). */
export function toastError(e, fallback = 'Не вдалося виконати дію') {
  if (!e || e.name === 'AbortError' || e.status === 401) return;
  toast.error(e.message || fallback);
}
