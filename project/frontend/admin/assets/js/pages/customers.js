// Customers derived from orders (name + contact); detail sheet with order history.
import { api } from '../core/api.js';
import { count, dateNum, int, money, relTime } from '../core/format.js';
import { replaceQuery } from '../core/router.js';
import { debounce, html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { avatar, emptyState, errorState, options, pagination, skeletonRows, statusBadge } from '../ui/components.js';
import { openSheet } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { openOrder } from './order-sheet.js';

const LIMIT = 30;
const SORTS = [['last', 'Останнє замовлення'], ['orders', 'Кількість замовлень'], ['spent', 'Сума покупок'], ['name', 'Ім’я']];

function openCustomer(name, contact, { onChanged } = {}) {
  const sheet = openSheet({ title: name || 'Клієнт', subtitle: 'Завантаження…', body: skeletonRows(5, { thumb: false }), label: 'Клієнт' });
  const p = sheet.panel;
  async function load() {
    try {
      const d = await api('/api/customers/detail', { query: { name, contact } });
      const c = d.customer;
      sheet.setHeader(html`<div class="product-head grow">${avatar(c.name, 'avatar-lg')}<div class="cell-text grow">
        <h2 class="sheet-title">${c.name || 'Без імені'}</h2><p class="sheet-sub">${c.contact || 'Контакт не вказано'}</p></div></div>`);
      sheet.setBody(html`<section class="section">
          <div class="mini-stats">
            <div class="stat-mini"><div class="v">${int(c.orders)}</div><div class="l">${count(c.orders, ['замовлення', 'замовлення', 'замовлень']).replace(/^[\d\s]+/, '').trim() || 'замовлень'}${c.cancelled ? `, скасовано ${c.cancelled}` : ''}</div></div>
            <div class="stat-mini"><div class="v">${money(c.spent)}</div><div class="l">Сума покупок</div></div>
            <div class="stat-mini"><div class="v">${c.avg_check ? money(c.avg_check) : '—'}</div><div class="l">Середній чек</div></div>
            <div class="stat-mini"><div class="v">${dateNum(c.first_order_at)}</div><div class="l">Перше замовлення</div></div>
          </div>
          <p class="hint">Окремої реєстрації клієнтів немає: профіль зібрано із замовлень з тим самим ім’ям і контактом. Суми — без скасованих замовлень.</p>
        </section>
        <section class="section">
          <h3 class="section-title">${icon('receipt', { size: 15 })}Історія замовлень</h3>
          <div class="order-items">${d.orders.map((o) => html`<button type="button" class="order-item list-item" style="border-radius:0" data-order="${o.number}">
            <div class="cell-text grow"><span class="cell-title mono">${o.number}</span><span class="qty">${dateNum(o.created_at)} · ${count((o.items || []).reduce((s, i) => s + i.qty, 0), ['одиниця', 'одиниці', 'одиниць'])}</span></div>
            <div class="meta"><b class="tabular">${money(o.total)}</b>${statusBadge(o.status)}</div></button>`)}</div>
        </section>`);
      sheet.setFooter(html`${c.contact ? html`<button type="button" class="btn" data-action="copy">${icon('copy', { size: 16 })}Скопіювати контакт</button>` : ''}
        <span class="spacer"></span>
        <a class="btn btn-primary" href="#/orders/new?name=${encodeURIComponent(c.name)}&contact=${encodeURIComponent(c.contact)}">${icon('plus', { size: 16 })}Нове замовлення</a>`);
      on(p, 'click', '[data-action="copy"]', async () => {
        try { await navigator.clipboard.writeText(c.contact); toast.success('Контакт скопійовано'); } catch { toast.error('Не вдалося скопіювати. Виділіть текст вручну.'); }
      });
    } catch (e) {
      sheet.setBody(errorState(e.message));
    }
  }
  on(p, 'click', '[data-order]', (e, b) => openOrder(b.dataset.order, { onChanged: () => { load(); onChanged?.(); } }));
  on(p, 'click', '[data-retry]', load);
  load();
}

export default function customers({ root, query, signal }) {
  const st = { q: query.get('q') || '', sort: query.get('sort') || 'last', page: Math.max(1, Number(query.get('page')) || 1) };
  let req = 0;

  setHTML(root, html`<div class="page-header">
      <div><h1 class="page-title">Клієнти</h1><p class="page-desc">Сформовано із замовлень: однакові ім’я та контакт — один клієнт</p></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/orders/new">${icon('plus', { size: 16 })}Нове замовлення</a></div>
    </div>
    <div class="stat-pair" id="c-summary">${[1, 2, 3].map(() => html`<div class="stat-mini"><div class="skeleton sk-title" style="width:40%"></div><div class="skeleton sk-line" style="width:70%;margin-top:8px"></div></div>`)}</div>
    <div class="toolbar">
      <div class="input-group search">${icon('search', { size: 17 })}
        <input class="input" id="c-q" type="search" placeholder="Ім’я або контакт" value="${st.q}" aria-label="Пошук клієнтів" autocomplete="off"></div>
      <label class="sr-only" for="c-sort">Сортування</label>
      <select class="select" id="c-sort">${options(SORTS, st.sort)}</select>
    </div>
    <section class="card" id="c-card">${skeletonRows(8)}</section>`);
  const card = root.querySelector('#c-card');

  async function load() {
    const my = ++req;
    replaceQuery({ q: st.q, sort: st.sort === 'last' ? '' : st.sort, page: st.page > 1 ? st.page : '' });
    try {
      const d = await api('/api/customers', { signal, query: { q: st.q, sort: st.sort, page: st.page, limit: LIMIT } });
      if (my !== req) return;
      setHTML(root.querySelector('#c-summary'), html`
        <div class="stat-mini"><div class="v">${int(d.summary.customers)}</div><div class="l">Усього клієнтів</div></div>
        <div class="stat-mini"><div class="v">${int(d.summary.repeat)}</div><div class="l">Повторні покупці</div></div>
        <div class="stat-mini"><div class="v">${int(d.summary.with_contact)}</div><div class="l">Із контактом</div></div>`);
      if (!d.items.length) {
        setHTML(card, st.q
          ? emptyState({ ic: 'search', title: 'Нікого не знайдено', text: 'Перевірте ім’я або контакт.' })
          : emptyState({ ic: 'users', title: 'Клієнтів ще немає', text: 'Клієнти з’являться після перших замовлень.',
            action: html`<a class="btn btn-sm btn-primary" href="#/orders/new">${icon('plus', { size: 15 })}Нове замовлення</a>` }));
        return;
      }
      setHTML(card, html`<div class="table-wrap"><table class="table responsive">
        <thead><tr><th>Клієнт</th><th class="col-num">Замовлень</th><th class="col-num">Сума покупок</th><th class="col-num">Середній чек</th><th>Останнє замовлення</th></tr></thead>
        <tbody>${d.items.map((c) => html`<tr class="is-clickable" tabindex="0" data-name="${c.name}" data-contact="${c.contact}">
          <td class="cell-primary"><div class="cell-main">${avatar(c.name, 'avatar-sm')}<div class="cell-text"><span class="cell-title truncate">${c.name || 'Без імені'}</span>
            <span class="cell-sub truncate">${c.contact || 'Без контакту'}</span></div></div></td>
          <td class="col-num" data-label="Замовлень">${int(c.orders)}${c.open ? html` <span class="muted small">(${c.open} у роботі)</span>` : ''}</td>
          <td class="col-num strong" data-label="Сума покупок">${money(c.spent)}</td>
          <td class="col-num m-hide" data-label="Середній чек">${c.avg_check ? money(c.avg_check) : '—'}</td>
          <td data-label="Останнє замовлення"><div class="row row-wrap" style="gap:6px"><span class="small">${relTime(c.last_order_at)}</span>${statusBadge(c.last_status)}</div></td></tr>`)}</tbody></table></div>
        ${pagination({ page: d.page, pages: d.pages, total: d.total, limit: LIMIT })}`);
    } catch (e) {
      if (e.name === 'AbortError' || my !== req) return;
      setHTML(card, errorState(e.message));
    }
  }

  const open = (name, contact) => openCustomer(name, contact, { onChanged: load });
  const search = debounce(() => { st.q = root.querySelector('#c-q').value.trim(); st.page = 1; load(); }, 300);
  on(root, 'input', '#c-q', search);
  on(root, 'change', '#c-sort', (e, s) => { st.sort = s.value; st.page = 1; load(); });
  on(root, 'click', '[data-page]', (e, b) => { st.page = Number(b.dataset.page); load(); card.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  on(root, 'click', '[data-retry]', load);
  on(root, 'click', 'tr[data-name]', (e, tr) => open(tr.dataset.name, tr.dataset.contact));
  on(root, 'keydown', 'tr[data-name]', (e, tr) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(tr.dataset.name, tr.dataset.contact); } });

  load();
  if (query.has('name')) open(query.get('name'), query.get('contact') || '');
}
