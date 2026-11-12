// Order detail sheet: customer, items, totals, status change (with confirmation), history, notes.
import { api } from '../core/api.js';
import { ORDER_STATUS } from '../core/labels.js';
import { count, dateTime, money } from '../core/format.js';
import { bus } from '../core/state.js';
import { html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { avatar, errorState, setLoading, skeletonRows, statusBadge } from '../ui/components.js';
import { confirmDialog, openSheet } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';

const customerHref = (c) => `#/customers?name=${encodeURIComponent(c?.name || '')}&contact=${encodeURIComponent(c?.contact || '')}`;

function timeline(o) {
  const ev = [];
  const hist = o.history || [];
  if (!hist.length || hist[0].status !== 'new') {
    ev.push({ at: o.created_at, ic: 'sparkles', tone: 'info', title: 'Замовлення створено', by: o.created_by });
  }
  hist.forEach((h, i) => {
    const s = ORDER_STATUS[h.status] || {};
    ev.push(i === 0 && h.status === 'new'
      ? { at: h.at, ic: 'sparkles', tone: 'info', title: 'Замовлення створено', by: h.by }
      : { at: h.at, ic: s.icon || 'refresh-cw', tone: s.tone === 'violet' ? 'info' : s.tone, title: html`Статус змінено на «${s.label || h.status}»`, by: h.by });
  });
  (o.notes || []).forEach((n) => ev.push({ at: n.at, ic: 'message-square-text', tone: '', title: 'Примітка', by: n.by, note: n.text }));
  ev.sort((a, b) => new Date(a.at) - new Date(b.at));
  return html`<div class="timeline">${ev.map((e) => html`<div class="tl-item">
    <span class="tl-icon ${e.tone || ''}">${icon(e.ic, { size: 14 })}</span>
    <div><div class="tl-title">${e.title}</div><div class="tl-meta">${dateTime(e.at)}${e.by ? html` · ${e.by}` : ''}</div>
    ${e.note ? html`<div class="tl-note">${e.note}</div>` : ''}</div></div>`)}</div>`;
}

export function openOrder(number, { onChanged } = {}) {
  let order = null;
  let selected = null;
  const sheet = openSheet({ title: `Замовлення ${number}`, subtitle: 'Завантаження…', body: skeletonRows(5, { thumb: false }), label: `Замовлення ${number}` });

  function render() {
    const o = order;
    const c = o.customer || {};
    const qty = (o.items || []).reduce((s, i) => s + (i.qty || 0), 0);
    sheet.setHeader(html`<div class="grow"><div class="row row-wrap" style="gap:10px"><h2 class="sheet-title mono">${o.number}</h2>${statusBadge(o.status)}</div>
      <p class="sheet-sub">Створено ${dateTime(o.created_at)}${o.created_by ? html` · ${o.created_by}` : ''}</p></div>`);
    sheet.setBody(html`
      <section class="section">
        <h3 class="section-title">${icon('refresh-cw', { size: 15 })}Статус</h3>
        <div class="status-pick" role="group" aria-label="Новий статус">
          ${Object.entries(ORDER_STATUS).map(([k, s]) => html`<button type="button" class="status-opt ${k === o.status ? 'is-current' : ''}" data-status="${k}"
            aria-pressed="${String(k === (selected || o.status))}" style="--c:${s.color}"><span class="dot"></span>${s.label}</button>`)}
        </div>
        <div class="row row-wrap">
          <button type="button" class="btn btn-primary" data-action="apply-status" ${!selected || selected === o.status ? 'disabled' : ''}>Змінити статус</button>
          <span class="muted small">Кожна зміна потребує підтвердження й записується в історію.</span>
        </div>
      </section>
      <section class="section">
        <h3 class="section-title">${icon('user', { size: 15 })}Клієнт</h3>
        <div class="row" style="gap:12px">
          ${avatar(c.name || '?')}
          <div class="cell-text grow"><span class="cell-title">${c.name || 'Без імені'}</span><span class="cell-sub">${c.contact || 'Контакт не вказано'}</span></div>
          ${c.contact ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="copy" data-tip="Скопіювати контакт" aria-label="Скопіювати контакт">${icon('copy', { size: 16 })}</button>` : ''}
          <a class="btn btn-sm" href="${customerHref(c)}">Профіль</a>
        </div>
      </section>
      <section class="section">
        <h3 class="section-title">${icon('shopping-bag', { size: 15 })}Товари · ${count(qty, ['одиниця', 'одиниці', 'одиниць'])}</h3>
        <div class="order-items">
          ${(o.items || []).map((i) => html`<div class="order-item">
            <div class="cell-text grow"><span class="cell-title">${i.name}</span><span class="qty">${i.brand || ''} · ${i.qty} × ${money(i.unit_price)}</span></div>
            <span class="sum">${money(i.line_total)}</span></div>`)}
          <div class="order-total"><span class="muted">Разом</span><span class="v">${money(o.total)}</span></div>
        </div>
        <p class="hint">Ціни зафіксовано під час створення замовлення; зміна прайсу чи націнок їх не змінює.</p>
      </section>
      <section class="section">
        <h3 class="section-title">${icon('history', { size: 15 })}Історія</h3>
        ${timeline(o)}
      </section>
      <section class="section">
        <h3 class="section-title">${icon('message-square-text', { size: 15 })}Нова примітка</h3>
        <form class="stack" data-form="note">
          <label class="sr-only" for="order-note">Текст примітки</label>
          <textarea class="textarea" id="order-note" maxlength="1000" placeholder="Наприклад: клієнт просить зателефонувати після 18:00"></textarea>
          <div class="row row-between"><span class="muted small" id="note-count">0 / 1000</span>
            <button type="submit" class="btn" disabled>${icon('plus', { size: 16 })}Додати примітку</button></div>
        </form>
      </section>`);
    sheet.setFooter(html`<a class="btn" href="#/orders/new?name=${encodeURIComponent(c.name || '')}&contact=${encodeURIComponent(c.contact || '')}">${icon('plus', { size: 16 })}Нове замовлення для клієнта</a>
      <span class="spacer"></span><button type="button" class="btn btn-ghost" data-close>Закрити</button>`);
  }

  async function load() {
    try {
      order = await api(`/api/orders/${encodeURIComponent(number)}`);
      selected = null;
      render();
    } catch (e) {
      sheet.setHeader(html`<div class="grow"><h2 class="sheet-title">Замовлення ${number}</h2></div>`);
      sheet.setBody(errorState(e.message));
    }
  }

  const p = sheet.panel;
  on(p, 'click', '[data-retry]', load);
  on(p, 'click', '[data-status]', (e, b) => {
    selected = b.dataset.status;
    p.querySelectorAll('[data-status]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    p.querySelector('[data-action="apply-status"]').disabled = selected === order.status;
  });
  on(p, 'click', '[data-action="apply-status"]', async (e, b) => {
    const to = ORDER_STATUS[selected];
    const from = ORDER_STATUS[order.status];
    const cancel = selected === 'cancelled';
    const ok = await confirmDialog({
      title: cancel ? 'Скасувати замовлення?' : 'Змінити статус замовлення?',
      text: html`Замовлення <b class="mono">${order.number}</b>: «${from?.label || order.status}» → «${to.label}».${cancel ? ' Скасовані замовлення не враховуються у виручці.' : ''}`,
      confirmText: cancel ? 'Скасувати замовлення' : 'Змінити статус', cancelText: 'Не змінювати', tone: cancel ? 'danger' : 'primary',
    });
    if (!ok) return;
    setLoading(b, true);
    try {
      order = await api(`/api/orders/${encodeURIComponent(order.number)}/status`, { method: 'PATCH', json: { status: selected } });
      selected = null;
      render();
      toast.success(`Статус змінено: «${to.label}»`);
      bus.emit('orders:changed');
      onChanged?.(order);
    } catch (ex) {
      toastError(ex);
      setLoading(b, false);
    }
  });
  on(p, 'click', '[data-action="copy"]', async () => {
    try { await navigator.clipboard.writeText(order.customer?.contact || ''); toast.success('Контакт скопійовано'); }
    catch { toast.error('Не вдалося скопіювати. Виділіть текст вручну.'); }
  });
  on(p, 'input', '#order-note', (e, t) => {
    p.querySelector('#note-count').textContent = `${t.value.length} / 1000`;
    p.querySelector('[data-form="note"] [type="submit"]').disabled = !t.value.trim();
  });
  on(p, 'submit', '[data-form="note"]', async (e, f) => {
    e.preventDefault();
    const text = f.querySelector('textarea').value.trim();
    if (!text) return;
    const b = f.querySelector('[type="submit"]');
    setLoading(b, true);
    try {
      order = await api(`/api/orders/${encodeURIComponent(order.number)}/notes`, { method: 'POST', json: { text } });
      render();
      toast.success('Примітку додано');
      onChanged?.(order);
    } catch (ex) {
      toastError(ex);
      setLoading(b, false);
    }
  });
  sheet.guard = async () => {
    const t = p.querySelector('#order-note');
    if (!t || !t.value.trim()) return true;
    return confirmDialog({ title: 'Закрити без збереження?', text: 'Примітку ще не додано — текст буде втрачено.', confirmText: 'Закрити', cancelText: 'Повернутися', tone: 'danger' });
  };
  load();
  return sheet;
}
