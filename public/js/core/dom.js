// Безпечні шаблони: усі значення екрануються, крім явно позначених raw()/html``.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

export class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s == null ? '' : s));

function part(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}

/** html`<p>${текст}</p>` → Raw. Масиви з’єднуються, null/false — порожньо. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function setHTML(el, content) {
  el.innerHTML = part(content);
  return el;
}

/** Делегування кліків: елементи з data-action="назва" викликають handlers[назва](el, event). */
export function actions(root, handlers) {
  const onClick = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const fn = handlers[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    fn(el, e);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

export function on(root, type, selector, handler) {
  const fn = (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(el, e);
  };
  root.addEventListener(type, fn);
  return () => root.removeEventListener(type, fn);
}

/** Значення полів форми (name → обрізаний рядок; checkbox → boolean). */
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = typeof el.value === 'string' ? el.value.trim() : el.value;
  }
  return out;
}

/** Кнопка в стані завантаження на час виконання fn. */
export async function busy(button, fn) {
  if (!button) return fn();
  const prev = button.innerHTML;
  const width = button.offsetWidth;
  button.disabled = true;
  button.style.minWidth = `${width}px`;
  button.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.innerHTML = prev;
    button.style.minWidth = '';
  }
}
