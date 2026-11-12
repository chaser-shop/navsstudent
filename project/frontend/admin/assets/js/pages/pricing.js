// Category markups with live preview of affected prices and a confirmation before repricing.
import { api } from '../core/api.js';
import { CATEGORIES } from '../core/labels.js';
import { count, int, money } from '../core/format.js';
import { getMarkups, store } from '../core/state.js';
import { debounce, html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { emptyState, errorState, setFieldError, setLoading, skeletonRows } from '../ui/components.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';

const RE = /^\d{1,7}([.,]\d{1,2})?$/;
const norm = (s) => String(s).trim().replace(',', '.');

export default function pricing({ root, signal }) {
  let saved = {};
  let values = {};
  let counts = {};
  let preview = null;
  let previewReq = 0;

  const changed = () => Object.keys(CATEGORIES).filter((k) => RE.test(norm(values[k])) && Number(norm(values[k])) !== Number(saved[k]));
  const valid = () => Object.keys(CATEGORIES).every((k) => RE.test(norm(values[k])));

  setHTML(root, html`<div class="page-header">
      <div><h1 class="page-title">Націнки</h1><p class="page-desc">Кінцева ціна = закупівельна ціна + націнка категорії</p></div>
    </div>
    <div class="grid grid-main" style="align-items:start">
      <section class="card">
        <div class="card-header"><div><h2 class="card-title">Націнки за категоріями</h2><p class="card-sub">Сума в гривнях, що додається до закупівельної ціни</p></div></div>
        <div class="card-body flush" id="mk-rows">${skeletonRows(4, { thumb: false })}</div>
        <div class="card-footer">
          <span class="muted small grow" id="mk-state">Змін немає</span>
          <button type="button" class="btn btn-ghost" data-action="revert" disabled>Скасувати зміни</button>
          <button type="button" class="btn btn-primary" data-action="apply" disabled>${icon('check', { size: 16 })}Застосувати</button>
        </div>
      </section>
      <div class="stack" style="gap:16px">
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Попередній перегляд</h2><p class="card-sub">Як зміняться ціни до збереження</p></div></div>
          <div class="card-body" id="mk-preview">${emptyState({ ic: 'percent', compact: true, title: 'Змініть націнку', text: 'Тут з’явиться кількість товарів, ціни яких зміняться.' })}</div>
        </section>
        <div class="callout info">${icon('info', { size: 17 })}<div>Ціни завжди перераховуються від закупівельної, тож націнка не додається двічі. Уже створені замовлення не змінюються.</div></div>
      </div>
    </div>`);

  function rows() {
    setHTML(root.querySelector('#mk-rows'), Object.entries(CATEGORIES).map(([k, c]) => {
      const v = values[k];
      const ok = RE.test(norm(v));
      const isChanged = ok && Number(norm(v)) !== Number(saved[k]);
      return html`<div class="markup-row">
        <div class="row" style="gap:12px"><span class="kpi-icon">${icon(c.icon, { size: 17 })}</span>
          <div class="cell-text"><label class="cell-title" for="mk-${k}">${c.label}</label><span class="cell-sub">${count(counts[k] || 0, ['товар', 'товари', 'товарів'])}</span></div></div>
        <div class="field"><div class="input-affix"><input class="input tabular" id="mk-${k}" data-key="${k}" inputmode="decimal" autocomplete="off" value="${v}" aria-invalid="${String(!ok)}"><span class="affix">грн</span></div>
          <div class="field-error" id="mk-${k}-error">${ok ? '' : 'Невід’ємне число, до 2 знаків після коми'}</div></div>
        <div class="example">${ok ? html`Напр.: закупівля 100 грн → <b class="tabular">${money(100 + Number(norm(v)))}</b>` : '—'}
          ${isChanged ? html`<div class="changed">було +${money(saved[k])}</div>` : ''}</div></div>`;
    }));
  }

  function footer() {
    const ch = changed();
    const ok = valid();
    root.querySelector('[data-action="apply"]').disabled = !ch.length || !ok;
    root.querySelector('[data-action="revert"]').disabled = !Object.keys(CATEGORIES).some((k) => norm(values[k]) !== norm(saved[k]));
    root.querySelector('#mk-state').textContent = !ok ? 'Виправте помилки у значеннях' : ch.length ? `Змінено: ${count(ch.length, ['категорія', 'категорії', 'категорій'])}` : 'Змін немає';
  }

  function renderPreview() {
    const box = root.querySelector('#mk-preview');
    if (!changed().length || !valid()) {
      setHTML(box, emptyState({ ic: 'percent', compact: true, title: 'Змініть націнку', text: 'Тут з’явиться кількість товарів, ціни яких зміняться.' }));
      return;
    }
    if (!preview) { setHTML(box, skeletonRows(4, { thumb: false })); return; }
    setHTML(box, html`<div class="stack">
      <div class="row" style="gap:12px"><span class="kpi-icon">${icon('refresh-cw', { size: 17 })}</span>
        <div class="cell-text"><span class="cell-title">Зміниться цін: ${int(preview.affected)}</span><span class="cell-sub">Нижче — до 20 прикладів</span></div></div>
      ${preview.sample.length ? html`<div class="order-items">${preview.sample.map((s) => html`<div class="order-item">
        <span class="grow small clamp-2">${s.name}</span>
        <span class="small muted tabular nowrap" style="text-decoration:line-through">${money(s.old)}</span>
        ${icon('arrow-right', { size: 14, cls: 'subtle' })}
        <span class="small strong tabular nowrap">${money(s.new)}</span></div>`)}</div>` : ''}
    </div>`);
  }

  const loadPreview = debounce(async () => {
    const my = ++previewReq;
    preview = null;
    renderPreview();
    if (!changed().length || !valid()) return;
    try {
      const body = { markups: Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, norm(values[k])])) };
      const d = await api('/api/pricing/markups/preview', { method: 'POST', json: body, signal });
      if (my !== previewReq) return;
      preview = d;
      renderPreview();
    } catch (e) {
      if (e.name === 'AbortError' || my !== previewReq) return;
      setHTML(root.querySelector('#mk-preview'), errorState(e.message, { compact: true }));
    }
  }, 400);

  async function load() {
    try {
      const [m, ov] = await Promise.all([getMarkups(true), api('/api/stats/overview', { signal })]);
      saved = { ...m };
      values = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, String(Number(m[k] ?? 0))]));
      counts = ov.products.by_category;
      rows();
      footer();
      renderPreview();
    } catch (e) {
      if (e.name === 'AbortError') return;
      setHTML(root.querySelector('#mk-rows'), errorState(e.message));
    }
  }

  on(root, 'input', '[data-key]', (e, i) => {
    values[i.dataset.key] = i.value;
    const ok = RE.test(norm(i.value));
    setFieldError(root, i.id, ok ? '' : 'Невід’ємне число, до 2 знаків після коми');
    const ex = i.closest('.markup-row').querySelector('.example');
    const isChanged = ok && Number(norm(i.value)) !== Number(saved[i.dataset.key]);
    setHTML(ex, ok ? html`Напр.: закупівля 100 грн → <b class="tabular">${money(100 + Number(norm(i.value)))}</b>${isChanged ? html`<div class="changed">було +${money(saved[i.dataset.key])}</div>` : ''}` : '—');
    footer();
    loadPreview();
  });
  on(root, 'click', '[data-action="revert"]', () => {
    values = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, String(Number(saved[k] ?? 0))]));
    preview = null;
    rows(); footer(); renderPreview();
  });
  on(root, 'click', '[data-action="apply"]', async (e, b) => {
    const affected = preview?.affected;
    const ok = await confirmDialog({ title: 'Застосувати нові націнки?', confirmText: 'Застосувати й перерахувати',
      text: affected != null ? `Буде перераховано ціни ${count(affected, ['товару', 'товарів', 'товарів'])}. Уже створені замовлення не зміняться.`
        : 'Ціни товарів буде перераховано. Уже створені замовлення не зміняться.' });
    if (!ok) return;
    setLoading(b, true);
    try {
      const body = { markups: Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, norm(values[k])])) };
      const r = await api('/api/pricing/markups', { method: 'PUT', json: body });
      store.markups = r.markups;
      saved = { ...r.markups };
      values = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, String(Number(saved[k]))]));
      preview = null;
      toast.success(`Націнки збережено. Перераховано цін: ${int(r.repriced)}`);
      rows(); renderPreview();
    } catch (ex) {
      toastError(ex);
    } finally {
      setLoading(b, false);
      footer();
    }
  });
  on(root, 'click', '[data-retry]', load);
  load();
}
