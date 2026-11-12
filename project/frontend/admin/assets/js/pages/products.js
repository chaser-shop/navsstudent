// Products list: search, filters, sorting, paging; create/edit in a sheet.
import { api } from '../core/api.js';
import { AVAILABILITY, CATEGORIES, COMPLIANCE } from '../core/labels.js';
import { count, money } from '../core/format.js';
import { getBrands } from '../core/state.js';
import { replaceQuery } from '../core/router.js';
import { debounce, html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { availabilityBadge, complianceBadge, emptyState, errorState, options, pagination, segmented, skeletonRows, thumb } from '../ui/components.js';
import { openDialog } from '../ui/dialog.js';
import { hydrate } from '../ui/media.js';
import { openProductEditor } from './product-editor.js';

const LIMIT = 30;
const KEYS = ['q', 'category', 'brand', 'status', 'compliance', 'images', 'line', 'sort'];
const SORTS = [['name', 'За назвою'], ['price_asc', 'Спочатку дешевші'], ['price_desc', 'Спочатку дорожчі']];

export default function products({ root, query, signal }) {
  const st = Object.fromEntries(KEYS.map((k) => [k, query.get(k) || '']));
  st.sort = st.sort || 'name';
  st.page = Math.max(1, Number(query.get('page')) || 1);
  let brands = [];
  let byCategory = null;
  let req = 0;

  const active = () => ['q', 'brand', 'status', 'compliance', 'images', 'line'].filter((k) => st[k]).length + (st.category ? 1 : 0);

  const filterControls = (prefix) => html`
    <label class="sr-only" for="${prefix}brand">Бренд</label>
    <select class="select" id="${prefix}brand" data-filter="brand">${options([['', 'Усі бренди'], ...brands.map((b) => [b, b])], st.brand)}</select>
    <label class="sr-only" for="${prefix}status">Наявність</label>
    <select class="select" id="${prefix}status" data-filter="status">${options([['', 'Будь-яка наявність'], ...Object.entries(AVAILABILITY).map(([k, a]) => [k, a.label])], st.status)}</select>
    <label class="sr-only" for="${prefix}compliance">Юридичний статус</label>
    <select class="select" id="${prefix}compliance" data-filter="compliance">${options([['', 'Будь-який юр. статус'], ...Object.entries(COMPLIANCE).map(([k, c]) => [k, c.label])], st.compliance)}</select>
    <label class="sr-only" for="${prefix}images">Фото</label>
    <select class="select" id="${prefix}images" data-filter="images">${options([['', 'З фото й без'], ['with', 'Лише з фото'], ['without', 'Лише без фото']], st.images)}</select>
    <label class="sr-only" for="${prefix}sort">Сортування</label>
    <select class="select" id="${prefix}sort" data-filter="sort">${options(SORTS, st.sort)}</select>`;

  const catTabs = () => {
    const items = [['', 'Усі', byCategory ? Object.values(byCategory).reduce((a, b) => a + b, 0) : null],
      ...Object.entries(CATEGORIES).map(([k, c]) => [k, c.label, byCategory ? byCategory[k] || 0 : null])];
    if (byCategory?.none || st.category === 'none') items.push(['none', 'Без категорії', byCategory?.none ?? null]);
    return segmented(items, st.category, { attr: 'data-cat', label: 'Категорія' });
  };

  const chips = () => html`${st.line ? html`<span class="chip">${st.line === '__none__' ? 'Без лінійки' : html`Лінійка: ${st.line}`}<button type="button" data-unset="line" aria-label="Прибрати фільтр лінійки">${icon('x', { size: 14 })}</button></span>` : ''}`;

  function shell() {
    setHTML(root, html`<div class="page-header">
        <div><h1 class="page-title">Товари</h1><p class="page-desc" id="p-desc">Каталог, ціни, наявність і фото</p></div>
        <div class="page-actions"><button type="button" class="btn btn-primary" data-action="create">${icon('plus', { size: 16 })}Додати товар</button></div>
      </div>
      <div class="cat-chips" id="cat-tabs">${catTabs()}</div>
      <div class="toolbar">
        <div class="input-group search has-clear">${icon('search', { size: 17 })}
          <input class="input" id="p-q" type="search" placeholder="Назва, бренд, модель або артикул" value="${st.q}" aria-label="Пошук товарів" autocomplete="off">
          <button type="button" class="input-clear" data-action="clear-q" aria-label="Очистити пошук" ${st.q ? '' : 'hidden'}>${icon('x', { size: 15 })}</button>
        </div>
        <div class="toolbar hide-mobile" id="p-filters">${filterControls('f-')}</div>
        <button type="button" class="btn only-mobile" data-action="filters">${icon('sliders-horizontal', { size: 16 })}Фільтри<span class="badge badge-accent" id="f-count" ${active() - (st.q ? 1 : 0) - (st.category ? 1 : 0) > 0 ? '' : 'hidden'}>${active() - (st.q ? 1 : 0) - (st.category ? 1 : 0)}</span></button>
        <div class="toolbar-chips" id="p-chips">${chips()}</div>
        <button type="button" class="btn btn-ghost" data-action="reset" ${active() ? '' : 'hidden'}>${icon('rotate-ccw', { size: 16 })}Скинути</button>
      </div>
      <section class="card" id="p-card">${skeletonRows(8)}</section>`);
  }

  function syncUrl() {
    replaceQuery({ ...Object.fromEntries(KEYS.map((k) => [k, k === 'sort' && st.sort === 'name' ? '' : st[k]])), page: st.page > 1 ? st.page : '' });
    const n = active();
    root.querySelector('[data-action="reset"]').hidden = !n;
    root.querySelector('[data-action="clear-q"]').hidden = !st.q;
    const extra = n - (st.q ? 1 : 0) - (st.category ? 1 : 0);
    const fc = root.querySelector('#f-count');
    fc.hidden = extra <= 0;
    fc.textContent = String(extra);
    setHTML(root.querySelector('#p-chips'), chips());
  }

  async function load() {
    const my = ++req;
    const card = root.querySelector('#p-card');
    card.setAttribute('aria-busy', 'true');
    try {
      const d = await api('/api/products', { signal, query: { ...Object.fromEntries(KEYS.map((k) => [k, st[k]])), page: st.page, limit: LIMIT } });
      if (my !== req) return;
      if (st.page > d.pages && d.total) { st.page = d.pages; syncUrl(); load(); return; }
      root.querySelector('#p-desc').textContent = active() ? `Знайдено: ${count(d.total, ['товар', 'товари', 'товарів'])}` : `${count(d.total, ['товар', 'товари', 'товарів'])} у каталозі`;
      if (!d.items.length) {
        setHTML(card, active()
          ? emptyState({ ic: 'search', title: 'Нічого не знайдено', text: 'Спробуйте інший запит або скиньте фільтри.',
            action: html`<button type="button" class="btn btn-sm" data-action="reset">${icon('rotate-ccw', { size: 15 })}Скинути фільтри</button>` })
          : emptyState({ ic: 'package', title: 'Каталог порожній', text: 'Імпортуйте прайс або додайте товар вручну.',
            action: html`<div class="row"><a class="btn btn-sm" href="#/import">${icon('file-up', { size: 15 })}Імпорт</a><button type="button" class="btn btn-sm btn-primary" data-action="create">${icon('plus', { size: 15 })}Додати товар</button></div>` }));
        return;
      }
      setHTML(card, html`<div class="table-wrap"><table class="table responsive">
        <thead><tr><th>Товар</th><th>Категорія</th><th class="col-num">Ціна</th><th>Наявність</th><th>Юр. статус</th><th class="col-actions"><span class="sr-only">Дії</span></th></tr></thead>
        <tbody>${d.items.map((p) => html`<tr class="is-clickable" tabindex="0" data-id="${p.id}">
          <td class="cell-primary"><div class="cell-main">${thumb((p.images || [])[0], { alt: p.name })}
            <div class="cell-text"><span class="cell-title clamp-2">${p.name}</span>
            <span class="cell-sub truncate">${[p.brand, p.product_line || p.model].filter(Boolean).join(' · ')}</span></div></div></td>
          <td class="m-hide" data-label="Категорія">${p.category_label || 'Не визначено'}</td>
          <td class="col-num" data-label="Ціна"><div class="cell-text" style="align-items:inherit"><span class="strong">${money(p.final_price)}</span>
            <span class="cell-sub">закуп. ${money(p.purchase_price)}</span></div></td>
          <td data-label="Наявність">${availabilityBadge(p.status)}</td>
          <td data-label="Юр. статус">${complianceBadge(p.compliance, { short: true })}</td>
          <td class="col-actions">${icon('chevron-right', { size: 16, cls: 'subtle' })}</td></tr>`)}</tbody></table></div>
        ${pagination({ page: d.page, pages: d.pages, total: d.total, limit: LIMIT })}`);
      hydrate(card);
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
      byCategory = d.products.by_category;
      setHTML(root.querySelector('#cat-tabs'), catTabs());
    } catch { /* counts are optional */ }
  }

  const apply = () => { st.page = 1; syncUrl(); load(); };
  const edit = (id) => openProductEditor({ id, onSaved: () => { load(); loadCounts(); }, onDeleted: () => { load(); loadCounts(); } });
  const create = () => openProductEditor({ onSaved: () => { load(); loadCounts(); refreshBrands(); } });
  async function refreshBrands() {
    try {
      brands = await getBrands();
      const box = root.querySelector('#p-filters');
      if (box) setHTML(box, filterControls('f-'));
    } catch { /* filters keep previous brands */ }
  }

  shell();
  const search = debounce(() => { st.q = root.querySelector('#p-q').value.trim(); apply(); }, 300);
  on(root, 'input', '#p-q', search);
  on(root, 'change', '#p-filters [data-filter]', (e, s) => { st[s.dataset.filter] = s.value; apply(); });
  on(root, 'click', '[data-cat]', (e, b) => {
    st.category = b.dataset.cat;
    root.querySelectorAll('[data-cat]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    apply();
  });
  on(root, 'click', '[data-unset]', (e, b) => { st[b.dataset.unset] = ''; apply(); });
  on(root, 'click', '[data-action="clear-q"]', () => { search.cancel(); root.querySelector('#p-q').value = ''; st.q = ''; apply(); root.querySelector('#p-q').focus(); });
  on(root, 'click', '[data-action="reset"]', () => {
    search.cancel();
    Object.assign(st, { q: '', category: '', brand: '', status: '', compliance: '', images: '', line: '', sort: 'name', page: 1 });
    root.querySelector('#p-q').value = '';
    setHTML(root.querySelector('#p-filters'), filterControls('f-'));
    setHTML(root.querySelector('#cat-tabs'), catTabs());
    apply();
  });
  on(root, 'click', '[data-action="filters"]', () => {
    const d = openDialog({ title: 'Фільтри', icon: 'sliders-horizontal',
      body: html`<div class="stack">${filterControls('m-')}</div>`,
      footer: html`<button type="button" class="btn" data-action="m-reset">Скинути</button><button type="button" class="btn btn-primary" data-action="m-apply">Показати</button>` });
    d.$('[data-action="m-apply"]').addEventListener('click', () => {
      d.panel.querySelectorAll('[data-filter]').forEach((s) => { st[s.dataset.filter] = s.value; });
      setHTML(root.querySelector('#p-filters'), filterControls('f-'));
      d.close();
      apply();
    });
    d.$('[data-action="m-reset"]').addEventListener('click', () => {
      Object.assign(st, { brand: '', status: '', compliance: '', images: '', sort: 'name' });
      setHTML(root.querySelector('#p-filters'), filterControls('f-'));
      d.close();
      apply();
    });
  });
  on(root, 'click', '[data-page]', (e, b) => { st.page = Number(b.dataset.page); syncUrl(); load(); root.querySelector('#p-card').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  on(root, 'click', '[data-retry]', load);
  on(root, 'click', '[data-action="create"]', create);
  on(root, 'click', 'tr[data-id]', (e, tr) => edit(tr.dataset.id));
  on(root, 'keydown', 'tr[data-id]', (e, tr) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(tr.dataset.id); } });

  refreshBrands();
  load();
  loadCounts();
  if (query.get('open')) edit(query.get('open'));
  if (query.get('new')) { replaceQuery({ ...Object.fromEntries(KEYS.map((k) => [k, k === 'sort' && st.sort === 'name' ? '' : st[k]])) }); create(); }
}
