// Activity log (audit_log): filter by area, grouped by day, incremental loading.
import { api } from '../core/api.js';
import { AUDIT_FILTERS, describeAudit } from '../core/labels.js';
import { count, dayHeading, isoDay, time } from '../core/format.js';
import { replaceQuery } from '../core/router.js';
import { html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { emptyState, errorState, segmented, setLoading, skeletonRows } from '../ui/components.js';

const LIMIT = 40;

export default function activity({ root, query, signal }) {
  const st = { action: query.get('action') || '', page: 1, pages: 1, items: [], total: 0 };
  let req = 0;

  setHTML(root, html`<div class="page-header">
      <div><h1 class="page-title">Журнал дій</h1><p class="page-desc" id="a-desc">Хто, що і коли змінював в адмін-панелі</p></div>
    </div>
    <div class="cat-chips">${segmented(AUDIT_FILTERS, st.action, { attr: 'data-action-filter', label: 'Тип дій' })}</div>
    <section class="card" id="a-card">${skeletonRows(8, { thumb: false })}</section>`);
  const card = root.querySelector('#a-card');

  function render() {
    if (!st.items.length) {
      setHTML(card, emptyState({ ic: 'history', title: 'Записів немає', text: st.action ? 'Для цього типу дій записів ще немає.' : 'Дії адміністраторів з’являться тут.' }));
      return;
    }
    const groups = [];
    for (const a of st.items) {
      const day = isoDay(a.at);
      if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, at: a.at, items: [] });
      groups[groups.length - 1].items.push(a);
    }
    setHTML(card, html`${groups.map((g) => html`<div class="day-label">${dayHeading(g.at)}</div>
      ${g.items.map((a) => { const x = describeAudit(a); return html`<div class="act-row">
        <span class="tl-icon ${x.tone}">${icon(x.icon, { size: 14 })}</span>
        <div class="cell-text grow"><span>${x.text}</span><span class="cell-sub">${a.admin}</span></div>
        <span class="when">${time(a.at)}</span></div>`; })}`)}
      ${st.page < st.pages ? html`<div class="card-footer" style="justify-content:center"><button type="button" class="btn btn-ghost" data-action="more">Показати ще</button></div>` : ''}`);
  }

  async function load(append = false) {
    const my = ++req;
    replaceQuery({ action: st.action });
    if (!append) setHTML(card, skeletonRows(8, { thumb: false }));
    try {
      const d = await api('/api/audit', { signal, query: { action: st.action, page: st.page, limit: LIMIT } });
      if (my !== req) return;
      st.items = append ? [...st.items, ...d.items] : d.items;
      st.pages = d.pages;
      st.total = d.total;
      root.querySelector('#a-desc').textContent = `${count(d.total, ['запис', 'записи', 'записів'])}${st.action ? ' за фільтром' : ' у журналі'}`;
      render();
    } catch (e) {
      if (e.name === 'AbortError' || my !== req) return;
      setHTML(card, errorState(e.message));
    }
  }

  on(root, 'click', '[data-action-filter]', (e, b) => {
    st.action = b.dataset.actionFilter;
    st.page = 1;
    root.querySelectorAll('[data-action-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load();
  });
  on(root, 'click', '[data-action="more"]', (e, b) => { setLoading(b, true); st.page += 1; load(true); });
  on(root, 'click', '[data-retry]', () => load());
  load();
}
