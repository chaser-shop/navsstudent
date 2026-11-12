// Dashboard: everything comes from GET /api/stats/overview.
import { api } from '../core/api.js';
import { categoryLabel, CATEGORIES, describeAudit, ORDER_STATUS } from '../core/labels.js';
import { count, dateLong, greeting, int, money, moneyShort, plural, relTime, setTimeZone } from '../core/format.js';
import { store } from '../core/state.js';
import { html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { avatar, emptyState, errorState, kpi, segmented, skeletonCards, skeletonRows, statusBadge } from '../ui/components.js';
import { donut, seriesChart } from '../ui/charts.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const verb = (n, one, many) => (n % 10 === 1 && n % 100 !== 11 ? one : many);

function alerts(d) {
  const out = [];
  const nNew = d.orders.by_status.new || 0;
  if (nNew) out.push({ tone: 'info', ic: 'sparkles', href: '#/orders?status=new',
    text: `${int(nNew)} ${plural(nNew, ['нове замовлення', 'нові замовлення', 'нових замовлень'])} ${verb(nNew, 'чекає', 'чекають')} на підтвердження` });
  const open = d.orders.open || 0;
  if (open) out.push({ tone: 'warning', ic: 'clock', href: '#/orders',
    text: `${count(open, ['відкрите замовлення', 'відкриті замовлення', 'відкритих замовлень'])} на суму ${money(d.revenue.open_total)}` });
  const exp = d.products.by_status.expected || 0;
  if (exp) out.push({ tone: 'info', ic: 'package', href: '#/products?status=expected',
    text: `${count(exp, ['товар', 'товари', 'товарів'])} ${verb(exp, 'очікується', 'очікуються')} на прибуття` });
  const noPrice = d.products.without_price || 0;
  if (noPrice) out.push({ tone: 'danger', ic: 'circle-alert', href: '#/products?category=none',
    text: `${count(noPrice, ['товар', 'товари', 'товарів'])} без ціни: не визначено категорію` });
  const blocked = d.products.by_compliance.blocked_by_law || 0;
  if (blocked) out.push({ tone: 'danger', ic: 'ban', href: '#/products?compliance=blocked_by_law',
    text: `${count(blocked, ['позиція заборонена', 'позиції заборонені', 'позицій заборонено'])} законом до продажу` });
  const noImg = d.products.without_images || 0;
  if (noImg) out.push({ tone: '', ic: 'image-off', href: '#/products?images=without',
    text: `${count(noImg, ['товар', 'товари', 'товарів'])} без фото` });
  return out;
}

export default function dashboard({ root, signal }) {
  let mode = 'revenue';
  let data = null;
  let disposeChart = null;

  const header = () => html`<div class="page-header">
    <div class="hello">
      <h1 class="page-title">${greeting()}, ${store.me?.username || ''}</h1>
      <p class="hello-date">${cap(dateLong())} · ${store.settings.shop_name || 'огляд магазину'}</p>
    </div>
    <div class="page-actions">
      <button type="button" class="btn" data-action="refresh">${icon('refresh-cw', { size: 16 })}Оновити</button>
      <a class="btn btn-primary" href="#/orders/new">${icon('plus', { size: 16 })}Нове замовлення</a>
    </div>
  </div>`;

  function skeleton() {
    setHTML(root, html`${header()}
      <div class="grid grid-4">${skeletonCards(4)}</div>
      <div class="grid grid-main"><div class="card"><div class="card-body"><div class="skeleton sk-title" style="width:30%"></div><div class="skeleton sk-block" style="margin-top:18px"></div></div></div>
        <div class="card"><div class="card-body">${skeletonRows(4, { thumb: false })}</div></div></div>`);
  }

  function drawChart() {
    disposeChart?.();
    const el = root.querySelector('#dash-chart');
    if (!el || !data) return;
    const hasOrders = data.series.some((p) => p.orders > 0);
    if (!hasOrders) {
      disposeChart = null;
      setHTML(el, emptyState({ ic: 'chart-line', compact: true, title: 'За останні 30 днів замовлень немає',
        text: 'Графік з’явиться після першого замовлення.', action: html`<a class="btn btn-sm" href="#/orders/new">${icon('plus', { size: 15 })}Створити замовлення</a>` }));
      return;
    }
    disposeChart = seriesChart(el, mode === 'revenue'
      ? { data: data.series, value: (p) => p.revenue, format: moneyShort, label: 'Сума замовлень за 30 днів', height: 250,
        tipLabel: (p) => `${count(p.orders - p.cancelled, ['замовлення', 'замовлення', 'замовлень'])}` }
      : { data: data.series, value: (p) => p.orders, format: int, integer: true, kind: 'bars', label: 'Кількість замовлень за 30 днів', height: 250,
        tipLabel: (p) => (p.cancelled ? `скасовано: ${p.cancelled}` : '') });
  }

  function draw(d) {
    const o = d.orders;
    const statusItems = Object.entries(ORDER_STATUS).map(([k, v]) => ({ label: v.label, value: o.by_status[k] || 0, color: v.color }));
    const al = alerts(d);
    const cats = Object.keys(CATEGORIES).map((k) => ({ k, n: d.products.by_category[k] || 0 }));
    if (d.products.by_category.none) cats.push({ k: 'none', n: d.products.by_category.none });
    const blocked = d.products.by_compliance.blocked_by_law || 0;
    const review = d.products.by_compliance.hold_legal_review || 0;
    const total = d.products.total || 0;

    setHTML(root, html`${header()}
      <div class="grid grid-4">
        ${kpi({ label: 'Замовлення за 30 днів', ic: 'receipt', tone: 'info', value: int(o.last_30_days),
          sub: html`Сьогодні: <b class="tabular">${int(o.today)}</b> · у роботі: <b class="tabular">${int(o.open)}</b>` })}
        ${kpi({ label: 'Сума за 30 днів', ic: 'wallet', value: money(d.revenue.last_30_days),
          sub: html`Без скасованих · виконано на ${money(d.revenue.done_30_days)}` })}
        ${kpi({ label: 'Середній чек', ic: 'chart-column', tone: 'violet', value: d.revenue.avg_check_30_days ? money(d.revenue.avg_check_30_days) : '—',
          empty: !d.revenue.avg_check_30_days, sub: d.revenue.avg_check_30_days ? 'За 30 днів, без скасованих' : 'Ще немає замовлень за 30 днів' })}
        ${kpi({ label: 'Клієнти', ic: 'users', tone: 'success', value: int(d.customers.total),
          sub: html`Нових за 30 днів: <b class="tabular">${int(d.customers.new_30_days)}</b> · повторних: <b class="tabular">${int(d.customers.repeat)}</b>` })}
      </div>

      <div class="grid grid-main">
        <section class="card">
          <div class="card-header">
            <div><h2 class="card-title">Динаміка за 30 днів</h2><p class="card-sub">${mode === 'revenue' ? 'Сума замовлень за днями, без скасованих' : 'Кількість створених замовлень за днями'}</p></div>
            <div class="card-actions">${segmented([['revenue', 'Сума'], ['orders', 'Кількість']], mode, { attr: 'data-mode', label: 'Показник графіка' })}</div>
          </div>
          <div class="card-body"><div id="dash-chart" style="min-height:250px"></div></div>
        </section>
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Статуси замовлень</h2><p class="card-sub">За весь час</p></div>
            <a class="btn btn-ghost btn-sm card-actions" href="#/orders">Усі ${icon('arrow-right', { size: 15 })}</a></div>
          <div class="card-body">
            ${o.total ? donut({ items: statusItems, centerValue: o.total, centerLabel: plural(o.total, ['замовлення', 'замовлення', 'замовлень']) })
              : emptyState({ ic: 'receipt', compact: true, title: 'Замовлень ще немає' })}
          </div>
          ${o.open ? html`<div class="card-footer"><span class="muted">У роботі:</span><b class="tabular">${int(o.open)}</b><span class="muted">на суму</span><b class="tabular">${money(d.revenue.open_total)}</b></div>` : ''}
        </section>
      </div>

      <div class="grid grid-main">
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Останні замовлення</h2><p class="card-sub">Нові та оновлені нещодавно</p></div>
            <a class="btn btn-ghost btn-sm card-actions" href="#/orders">Усі замовлення ${icon('arrow-right', { size: 15 })}</a></div>
          <div class="card-body flush">
            ${d.recent_orders.length ? html`<div class="list">${d.recent_orders.map((r) => html`<a class="list-item" href="#/orders?open=${encodeURIComponent(r.number)}">
                ${avatar(r.customer?.name || '?', 'avatar-sm')}
                <div class="cell-text grow"><span class="cell-title truncate">${r.customer?.name || 'Без імені'}</span>
                  <span class="cell-sub truncate"><span class="mono">${r.number}</span> · ${relTime(r.created_at)}</span></div>
                <div class="meta"><b class="tabular">${money(r.total)}</b>${statusBadge(r.status)}</div></a>`)}</div>`
              : emptyState({ ic: 'receipt', compact: true, title: 'Замовлень ще немає', text: 'Створіть перше замовлення — воно з’явиться тут.',
                action: html`<a class="btn btn-sm btn-primary" href="#/orders/new">${icon('plus', { size: 15 })}Нове замовлення</a>` })}
          </div>
        </section>
        <div class="stack" style="gap:16px">
          <section class="card">
            <div class="card-header"><div><h2 class="card-title">Потребує уваги</h2></div></div>
            <div class="card-body flush"><div class="alerts">
              ${al.length ? al.map((a) => html`<a class="alert-row" href="${a.href}"><span class="alert-icon ${a.tone}">${icon(a.ic, { size: 16 })}</span>
                  <span class="grow">${a.text}</span>${icon('chevron-right', { size: 16, cls: 'chev' })}</a>`)
                : html`<div class="alert-row"><span class="alert-icon success">${icon('circle-check', { size: 16 })}</span><span>Термінових завдань немає</span></div>`}
            </div></div>
          </section>
          <section class="card">
            <div class="card-header"><h2 class="card-title">Швидкі дії</h2></div>
            <div class="card-body"><div class="quick">
              <a href="#/orders/new"><span class="q-icon">${icon('shopping-cart', { size: 17 })}</span><span class="q-title">Нове замовлення</span><span class="q-sub">Кошик і клієнт</span></a>
              <a href="#/products?new=1"><span class="q-icon">${icon('package-plus', { size: 17 })}</span><span class="q-title">Додати товар</span><span class="q-sub">Ручне створення</span></a>
              <a href="#/import"><span class="q-icon">${icon('file-up', { size: 17 })}</span><span class="q-title">Імпорт прайсу</span><span class="q-sub">Оновити ціни й наявність</span></a>
              <a href="#/pricing"><span class="q-icon">${icon('percent', { size: 17 })}</span><span class="q-title">Націнки</span><span class="q-sub">Перерахунок цін</span></a>
            </div></div>
          </section>
        </div>
      </div>

      <div class="grid grid-2">
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Каталог</h2><p class="card-sub">${count(total, ['товар', 'товари', 'товарів'])} у базі</p></div>
            <a class="btn btn-ghost btn-sm card-actions" href="#/catalog">Категорії ${icon('arrow-right', { size: 15 })}</a></div>
          <div class="card-body stack stack-lg">
            <div class="stat-pair">
              <div class="stat-mini"><div class="v">${int(d.products.by_status.in_stock)}</div><div class="l">В наявності</div></div>
              <div class="stat-mini"><div class="v">${int(d.products.orderable)}</div><div class="l">Можна замовити</div></div>
              <div class="stat-mini"><div class="v">${int(d.products.by_status.expected)}</div><div class="l">Очікуються</div></div>
            </div>
            <div class="cat-rows">${cats.map((c) => html`<a class="hbar-row" href="#/products?category=${c.k}">
              <div class="hbar-head"><span>${categoryLabel(c.k)}</span><span class="v">${int(c.n)}</span></div>
              <div class="bar"><span style="--w:${total ? (c.n / total) * 100 : 0}%"></span></div></a>`)}</div>
            <div class="stack stack-sm">
              <div class="row row-between small"><span class="muted">Юридичний статус</span><a class="link small" href="#/products?compliance=blocked_by_law">Заборонені ${icon('arrow-right', { size: 13 })}</a></div>
              <div class="stacked">${blocked ? html`<span style="--w:${(blocked / Math.max(1, total)) * 100}%;--c:var(--danger)"></span>` : ''}${review ? html`<span style="--w:${(review / Math.max(1, total)) * 100}%;--c:var(--warning)"></span>` : ''}</div>
              <div class="legend"><span class="legend-item" style="--c:var(--danger)"><i></i>Заборонено законом: ${int(blocked)}</span>
                <span class="legend-item" style="--c:var(--warning)"><i></i>Очікує юр. перевірки: ${int(review)}</span></div>
            </div>
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Остання активність</h2><p class="card-sub">Дії адміністраторів</p></div>
            <a class="btn btn-ghost btn-sm card-actions" href="#/activity">Увесь журнал ${icon('arrow-right', { size: 15 })}</a></div>
          <div class="card-body flush">
            ${d.activity.length ? html`<div class="list">${d.activity.map((a) => { const x = describeAudit(a); return html`<div class="list-item">
                <span class="tl-icon ${x.tone}">${icon(x.icon, { size: 14 })}</span>
                <div class="cell-text grow"><span class="truncate">${x.text}</span><span class="cell-sub">${a.admin} · ${relTime(a.at)}</span></div></div>`; })}</div>`
              : emptyState({ ic: 'history', compact: true, title: 'Журнал порожній' })}
          </div>
        </section>
      </div>`);
    drawChart();
  }

  async function load() {
    try {
      const d = await api('/api/stats/overview', { signal });
      setTimeZone(d.timezone);
      data = d;
      draw(d);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setHTML(root, html`${header()}${errorState(e.message)}`);
    }
  }

  on(root, 'click', '[data-action="refresh"], [data-retry]', () => { skeleton(); load(); });
  on(root, 'click', '[data-mode]', (e, b) => {
    mode = b.dataset.mode;
    root.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const sub = root.querySelector('#dash-chart')?.closest('.card')?.querySelector('.card-sub');
    if (sub) sub.textContent = mode === 'revenue' ? 'Сума замовлень за днями, без скасованих' : 'Кількість створених замовлень за днями';
    drawChart();
  });

  skeleton();
  load();
  return () => disposeChart?.();
}
