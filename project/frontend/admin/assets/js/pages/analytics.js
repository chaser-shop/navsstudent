// Analytics for a date range, compared with the previous period of the same length.
import { api } from '../core/api.js';
import { categoryLabel, ORDER_STATUS } from '../core/labels.js';
import { addDays, count, daysBetween, int, isoDay, money, moneyShort, plural, setTimeZone } from '../core/format.js';
import { replaceQuery } from '../core/router.js';
import { html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { avatar, deltaBadge, emptyState, errorState, kpi, segmented, skeletonCards } from '../ui/components.js';
import { donut, hbars, seriesChart } from '../ui/charts.js';
import { toast } from '../ui/toast.js';

const PRESETS = [['7', '7 днів'], ['30', '30 днів'], ['90', '90 днів'], ['365', '12 місяців']];
const CAT_COLORS = { liquid: 'var(--chart-2)', pod: 'var(--chart-1)', cartridge: 'var(--chart-4)', booster: 'var(--chart-3)', none: 'var(--chart-6)', unknown: 'var(--chart-6)' };

export default function analytics({ root, query, signal }) {
  const today = isoDay();
  const st = { to: query.get('to') || today, from: query.get('from') || addDays(today, -29), mode: 'revenue' };
  let data = null;
  let disposeChart = null;

  const preset = () => {
    if (st.to !== isoDay()) return '';
    const days = String(daysBetween(st.from, st.to) + 1);
    return PRESETS.some(([d]) => d === days) ? days : '';
  };

  function frame(content) {
    setHTML(root, html`<div class="page-header">
        <div><h1 class="page-title">Аналітика</h1><p class="page-desc">Продажі, замовлення, клієнти й товари за обраний період</p></div>
      </div>
      <div class="toolbar">
        ${segmented(PRESETS, preset(), { attr: 'data-preset', label: 'Період' })}
        <form class="toolbar" data-form="range" novalidate>
          <label class="sr-only" for="a-from">Від</label><input class="input" style="width:auto" type="date" id="a-from" value="${st.from}" max="${today}">
          <span class="muted">—</span>
          <label class="sr-only" for="a-to">До</label><input class="input" style="width:auto" type="date" id="a-to" value="${st.to}" max="${today}">
          <button type="submit" class="btn">${icon('calendar', { size: 16 })}Застосувати</button>
        </form>
      </div>
      ${content}`);
  }

  function drawChart() {
    disposeChart?.();
    disposeChart = null;
    const el = root.querySelector('#a-chart');
    if (!el || !data) return;
    if (!data.totals.orders) {
      setHTML(el, emptyState({ ic: 'chart-line', compact: true, title: 'За цей період замовлень немає', text: 'Оберіть інший період.' }));
      return;
    }
    const tip = (p) => (st.mode === 'revenue' ? count(p.orders - p.cancelled, ['замовлення', 'замовлення', 'замовлень']) : (p.cancelled ? `скасовано: ${p.cancelled}` : ''));
    disposeChart = seriesChart(el, st.mode === 'revenue'
      ? { data: data.series, value: (p) => p.revenue, format: moneyShort, height: 260, label: 'Сума замовлень за днями', tipLabel: tip }
      : { data: data.series, value: (p) => p.orders, format: int, integer: true, kind: 'bars', height: 260, label: 'Кількість замовлень за днями', tipLabel: tip });
  }

  function draw(d) {
    const t = d.totals;
    const pv = d.previous;
    const statusItems = Object.entries(ORDER_STATUS).map(([k, s]) => ({ label: s.label, value: d.by_status[k] || 0, color: s.color }));
    const vs = html`<span class="muted">до попередніх ${d.range.days} дн.</span>`;
    frame(html`
      <div class="grid kpis-6">
        ${kpi({ label: 'Сума замовлень', ic: 'wallet', value: money(t.revenue), sub: html`${deltaBadge(t.revenue, pv.revenue)} ${vs}` })}
        ${kpi({ label: 'Замовлення', ic: 'receipt', tone: 'info', value: int(t.orders),
          sub: html`${deltaBadge(t.orders, pv.orders)} ${t.orders_cancelled ? html`<span class="muted">скасовано: ${t.orders_cancelled}</span>` : vs}` })}
        ${kpi({ label: 'Середній чек', ic: 'chart-column', tone: 'violet', value: t.avg_check ? money(t.avg_check) : '—', empty: !t.avg_check,
          sub: t.avg_check ? html`${deltaBadge(t.avg_check, pv.avg_check)} ${vs}` : 'Немає замовлень' })}
        ${kpi({ label: 'Продано одиниць', ic: 'shopping-bag', value: int(t.items_sold), sub: html`${deltaBadge(t.items_sold, pv.items_sold)} ${vs}` })}
        ${kpi({ label: 'Клієнти', ic: 'users', tone: 'success', value: int(t.customers),
          sub: html`<span class="muted">нових: <b class="tabular">${int(t.new_customers)}</b> · повторних: <b class="tabular">${int(t.returning_customers)}</b></span>` })}
        ${kpi({ label: 'Виконано', ic: 'circle-check', tone: 'success', value: int(t.orders_done), sub: html`<span class="muted">на суму ${money(t.revenue_done)}</span>` })}
      </div>
      <section class="card">
        <div class="card-header"><div><h2 class="card-title">Динаміка</h2><p class="card-sub" id="a-chart-sub">${st.mode === 'revenue' ? 'Сума замовлень за днями, без скасованих' : 'Кількість створених замовлень за днями'}</p></div>
          <div class="card-actions">${segmented([['revenue', 'Сума'], ['orders', 'Кількість']], st.mode, { attr: 'data-mode', label: 'Показник' })}</div></div>
        <div class="card-body"><div id="a-chart" style="min-height:260px"></div></div>
      </section>
      <div class="grid grid-2">
        <section class="card"><div class="card-header"><div><h2 class="card-title">Статуси замовлень</h2><p class="card-sub">Створені за період</p></div></div>
          <div class="card-body">${t.orders ? donut({ items: statusItems, centerValue: t.orders, centerLabel: plural(t.orders, ['замовлення', 'замовлення', 'замовлень']) })
            : emptyState({ ic: 'chart-pie', compact: true, title: 'Немає даних' })}</div></section>
        <section class="card"><div class="card-header"><div><h2 class="card-title">Продажі за категоріями</h2><p class="card-sub">Сума без скасованих замовлень</p></div></div>
          <div class="card-body">${d.by_category.length ? hbars(d.by_category.map((c) => ({ label: categoryLabel(c.category), sub: `${int(c.qty)} од.`, value: Number(c.revenue), color: CAT_COLORS[c.category] })), { format: money })
            : emptyState({ ic: 'layers', compact: true, title: 'Немає продажів' })}</div></section>
      </div>
      <div class="grid grid-main">
        <section class="card"><div class="card-header"><div><h2 class="card-title">Топ товарів</h2><p class="card-sub">За сумою продажів</p></div></div>
          <div class="card-body flush">${d.top_products.length ? html`<div class="table-wrap"><table class="table responsive">
            <thead><tr><th>#</th><th>Товар</th><th class="col-num">Продано</th><th class="col-num">Сума</th></tr></thead>
            <tbody>${d.top_products.map((p, i) => html`<tr>
              <td class="m-hide muted tabular">${i + 1}</td>
              <td class="cell-primary"><div class="cell-text"><a class="cell-title link" style="color:var(--text)" href="#/products?open=${encodeURIComponent(p.product_id)}">${p.name}</a><span class="cell-sub">${p.brand || ''}</span></div></td>
              <td class="col-num" data-label="Продано">${int(p.qty)} од.</td>
              <td class="col-num strong" data-label="Сума">${money(p.revenue)}</td></tr>`)}</tbody></table></div>`
            : emptyState({ ic: 'package', compact: true, title: 'Продажів за період немає' })}</div></section>
        <section class="card"><div class="card-header"><div><h2 class="card-title">Топ клієнтів</h2><p class="card-sub">За сумою покупок</p></div></div>
          <div class="card-body flush">${d.top_customers.length ? html`<div class="list">${d.top_customers.map((c) => html`<a class="list-item" href="#/customers?name=${encodeURIComponent(c.name)}&contact=${encodeURIComponent(c.contact)}">
              ${avatar(c.name, 'avatar-sm')}<div class="cell-text grow"><span class="cell-title truncate">${c.name || 'Без імені'}</span>
              <span class="cell-sub">${count(c.orders, ['замовлення', 'замовлення', 'замовлень'])}</span></div><b class="tabular">${money(c.spent)}</b></a>`)}</div>`
            : emptyState({ ic: 'users', compact: true, title: 'Немає клієнтів за період' })}</div></section>
      </div>
      <p class="hint">${icon('info', { size: 13 })} Дні — за часовим поясом магазину (${d.timezone}). Скасовані замовлення не входять у суми. Порівняння — з періодом ${d.range.previous_from.split('-').reverse().join('.')}–${d.range.previous_to.split('-').reverse().join('.')}.</p>`);
    drawChart();
  }

  async function load() {
    replaceQuery({ from: st.from, to: st.to });
    disposeChart?.();
    frame(html`<div class="grid kpis-6">${skeletonCards(6)}</div><div class="card"><div class="card-body"><div class="skeleton sk-block"></div></div></div>`);
    try {
      const d = await api('/api/stats/analytics', { signal, query: { date_from: st.from, date_to: st.to } });
      setTimeZone(d.timezone);
      data = d;
      draw(d);
    } catch (e) {
      if (e.name === 'AbortError') return;
      frame(errorState(e.message));
    }
  }

  on(root, 'click', '[data-preset]', (e, b) => {
    const days = Number(b.dataset.preset);
    st.to = isoDay();
    st.from = addDays(st.to, -(days - 1));
    load();
  });
  on(root, 'submit', '[data-form="range"]', (e, f) => {
    e.preventDefault();
    const from = f.querySelector('#a-from').value;
    const to = f.querySelector('#a-to').value;
    if (!from || !to) { toast.error('Вкажіть обидві дати'); return; }
    if (from > to) { toast.error('Дата «від» має бути не пізнішою за дату «до»'); return; }
    if (daysBetween(from, to) + 1 > 366) { toast.error('Період не може перевищувати 366 днів'); return; }
    st.from = from;
    st.to = to;
    load();
  });
  on(root, 'click', '[data-mode]', (e, b) => {
    st.mode = b.dataset.mode;
    root.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const sub = root.querySelector('#a-chart-sub');
    if (sub) sub.textContent = st.mode === 'revenue' ? 'Сума замовлень за днями, без скасованих' : 'Кількість створених замовлень за днями';
    drawChart();
  });
  on(root, 'click', '[data-retry]', load);
  load();
  return () => disposeChart?.();
}
