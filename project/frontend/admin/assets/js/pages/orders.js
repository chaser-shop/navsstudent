// Orders list: search, status and date filters, paging; details open in a sheet.
import { api } from '../core/api.js';
import { ORDER_STATUS, ORDER_STATUS_PLURAL } from '../core/labels.js';
import { count, dateNum, int, money, time } from '../core/format.js';
import { bus } from '../core/state.js';
import { replaceQuery } from '../core/router.js';
import { debounce, html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { emptyState, errorState, pagination, segmented, skeletonRows, statusBadge } from '../ui/components.js';
import { openOrder } from './order-sheet.js';

const LIMIT = 30;

export default function orders({ root, query, signal }) {
  const st = {
    q: query.get('q') || '', status: query.get('status') || '', from: query.get('from') || '', to: query.get('to') || '',
    page: Math.max(1, Number(query.get('page')) || 1),
  };
  let counts = null;
  let req = 0;

  const filtersActive = () => Boolean(st.q || st.from || st.to);
  const statusTabs = () => segmented(
    [['', 'Усі', counts && !filtersActive() ? Object.values(counts).reduce((a, b) => a + b, 0) : null],
      ...Object.keys(ORDER_STATUS).map((k) => [k, ORDER_STATUS_PLURAL[k], counts && !filtersActive() ? counts[k] || 0 : null])],
    st.status, { attr: 'data-status', label: 'Статус замовлення' },
  );

  setHTML(root, html`<div class="page-header">
      <div><h1 class="page-title">Замовлення</h1><p class="page-desc" id="orders-desc">Пошук, статуси та історія замовлень</p></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/orders/new">${icon('plus', { size: 16 })}Нове замовлення</a></div>
    </div>
    <div id="status-tabs" style="max-width:100%">${statusTabs()}</div>
    <div class="toolbar">
      <div class="input-group search has-clear">${icon('search', { size: 17 })}
        <input class="input" id="orders-q" type="search" placeholder="Номер, ім’я або контакт клієнта" value="${st.q}" aria-label="Пошук замовлень" autocomplete="off">
        <button type="button" class="input-clear" data-action="clear-q" aria-label="Очистити пошук" ${st.q ? '' : 'hidden'}>${icon('x', { size: 15 })}</button>
      </div>
      <label class="sr-only" for="orders-from">Дата від</label>
      <input class="input" style="width:auto" type="date" id="orders-from" value="${st.from}" title="Дата від">
      <span class="muted">—</span>
      <label class="sr-only" for="orders-to">Дата до</label>
      <input class="input" style="width:auto" type="date" id="orders-to" value="${st.to}" title="Дата до">
      <button type="button" class="btn btn-ghost" data-action="reset" ${filtersActive() || st.status ? '' : 'hidden'}>${icon('rotate-ccw', { size: 16 })}Скинути</button>
    </div>
    <section class="card" id="orders-card">${skeletonRows(8, { thumb: false })}</section>`);

  const card = root.querySelector('#orders-card');

  function syncUrl() {
    replaceQuery({ q: st.q, status: st.status, from: st.from, to: st.to, page: st.page > 1 ? st.page : '' });
    root.querySelector('[data-action="reset"]').hidden = !(filtersActive() || st.status);
    root.querySelector('[data-action="clear-q"]').hidden = !st.q;
  }

  async function load() {
    const my = ++req;
    if (st.from && st.to && st.from > st.to) {
      setHTML(card, emptyState({ ic: 'calendar', compact: true, title: 'Некоректний період', text: 'Дата «від» має бути не пізнішою за дату «до».' }));
      return;
    }
    card.setAttribute('aria-busy', 'true');
    try {
      const d = await api('/api/orders', { signal, query: { q: st.q, status: st.status, date_from: st.from, date_to: st.to, page: st.page, limit: LIMIT } });
      if (my !== req) return;
      if (st.page > d.pages && d.total) { st.page = d.pages; syncUrl(); load(); return; }
      root.querySelector('#orders-desc').textContent = filtersActive() || st.status
        ? `Знайдено: ${count(d.total, ['замовлення', 'замовлення', 'замовлень'])}`
        : `Усього ${count(d.total, ['замовлення', 'замовлення', 'замовлень'])}`;
      if (!d.items.length) {
        setHTML(card, filtersActive() || st.status
          ? emptyState({ ic: 'search', title: 'Нічого не знайдено', text: 'Змініть пошуковий запит або фільтри.',
            action: html`<button type="button" class="btn btn-sm" data-action="reset">${icon('rotate-ccw', { size: 15 })}Скинути фільтри</button>` })
          : emptyState({ ic: 'receipt', title: 'Замовлень ще немає', text: 'Створіть перше замовлення з товарів каталогу.',
            action: html`<a class="btn btn-sm btn-primary" href="#/orders/new">${icon('plus', { size: 15 })}Нове замовлення</a>` }));
        return;
      }
      setHTML(card, html`<div class="table-wrap"><table class="table responsive">
        <thead><tr><th>Замовлення</th><th>Клієнт</th><th class="col-num">Товарів</th><th class="col-num">Сума</th><th>Статус</th><th class="col-actions"><span class="sr-only">Дії</span></th></tr></thead>
        <tbody>${d.items.map((o) => html`<tr class="is-clickable" tabindex="0" data-number="${o.number}">
          <td class="cell-primary"><div class="cell-text"><span class="cell-title mono">${o.number}</span><span class="cell-sub">${dateNum(o.created_at)}, ${time(o.created_at)}</span></div></td>
          <td data-label="Клієнт"><div class="cell-text"><span class="truncate">${o.customer?.name || 'Без імені'}</span><span class="cell-sub truncate">${o.customer?.contact || '—'}</span></div></td>
          <td class="col-num" data-label="Товарів">${int((o.items || []).reduce((s, i) => s + (i.qty || 0), 0))}</td>
          <td class="col-num strong" data-label="Сума">${money(o.total)}</td>
          <td data-label="Статус">${statusBadge(o.status)}</td>
          <td class="col-actions">${icon('chevron-right', { size: 16, cls: 'subtle' })}</td></tr>`)}</tbody></table></div>
        ${pagination({ page: d.page, pages: d.pages, total: d.total, limit: LIMIT })}`);
    } catch (e) {
      if (e.name === 'AbortError' || my !== req) return;
      setHTML(card, errorState(e.message));
    } finally {
      card.removeAttribute('aria-busy');
    }
  }

  async function loadCounts() {
    try {
      const d = await api('/api/stats/overview', { signal });
      counts = d.orders.by_status;
      setHTML(root.querySelector('#status-tabs'), statusTabs());
    } catch { /* counts are optional */ }
  }

  const open = (number) => openOrder(number, { onChanged: () => { load(); loadCounts(); } });
  const search = debounce(() => { st.q = root.querySelector('#orders-q').value.trim(); st.page = 1; syncUrl(); load(); setHTML(root.querySelector('#status-tabs'), statusTabs()); }, 300);

  on(root, 'input', '#orders-q', search);
  on(root, 'change', '#orders-from, #orders-to', () => {
    st.from = root.querySelector('#orders-from').value;
    st.to = root.querySelector('#orders-to').value;
    st.page = 1; syncUrl(); load(); setHTML(root.querySelector('#status-tabs'), statusTabs());
  });
  on(root, 'click', '[data-status]', (e, b) => {
    st.status = b.dataset.status; st.page = 1;
    root.querySelectorAll('[data-status]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    syncUrl(); load();
  });
  on(root, 'click', '[data-action="clear-q"]', () => { root.querySelector('#orders-q').value = ''; search(); search.cancel?.(); st.q = ''; st.page = 1; syncUrl(); load(); });
  on(root, 'click', '[data-action="reset"]', () => {
    Object.assign(st, { q: '', status: '', from: '', to: '', page: 1 });
    root.querySelector('#orders-q').value = '';
    root.querySelector('#orders-from').value = '';
    root.querySelector('#orders-to').value = '';
    setHTML(root.querySelector('#status-tabs'), statusTabs());
    syncUrl(); load();
  });
  on(root, 'click', '[data-page]', (e, b) => { st.page = Number(b.dataset.page); syncUrl(); load(); card.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  on(root, 'click', '[data-retry]', load);
  on(root, 'click', 'tr[data-number]', (e, tr) => open(tr.dataset.number));
  on(root, 'keydown', 'tr[data-number]', (e, tr) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(tr.dataset.number); } });
  const off = bus.on('orders:changed', () => { load(); loadCounts(); });

  load();
  loadCounts();
  if (query.get('open')) open(query.get('open'));
  return off;
}
