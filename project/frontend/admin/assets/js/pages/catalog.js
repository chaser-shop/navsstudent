// Categories (fixed legal/pricing classification) and product lines with rename and shared photos.
import { api } from '../core/api.js';
import { CATEGORIES, categoryLabel } from '../core/labels.js';
import { count, int, money, plural } from '../core/format.js';
import { getLines, getMarkups, invalidateCatalog } from '../core/state.js';
import { debounce, html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { badge, emptyState, errorState, field, options, setFieldError, setLoading, skeletonCards, skeletonRows, thumb } from '../ui/components.js';
import { openDialog } from '../ui/dialog.js';
import { hydrate } from '../ui/media.js';
import { toast, toastError } from '../ui/toast.js';

const RULES = {
  liquid: 'Рідини понад 10 мл або міцністю понад 20 мг/мл заборонені законом; решта — на юридичній перевірці.',
  pod: 'На юридичній перевірці: діє заборона реклами електронних сигарет в інтернеті.',
  cartridge: 'На юридичній перевірці; картриджі понад 2 мл позначаються для окремої перевірки.',
  booster: 'На юридичній перевірці: діє заборона реклами в інтернеті.',
};
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const lineHref = (l) => `#/products?brand=${encodeURIComponent(l.brand)}&line=${encodeURIComponent(l.line)}`;

export default function catalog({ root, signal }) {
  const st = { q: '', category: '' };
  let lines = [];
  let unassigned = [];

  setHTML(root, html`<div class="page-header">
      <div><h1 class="page-title">Категорії та лінійки</h1><p class="page-desc">Структура каталогу: категорії, лінійки брендів і їхні спільні фото</p></div>
      <div class="page-actions"><a class="btn" href="#/pricing">${icon('percent', { size: 16 })}Націнки</a></div>
    </div>
    <div class="grid grid-4" id="cat-cards">${skeletonCards(4)}</div>
    <div class="callout info">${icon('info', { size: 17 })}<div><div class="callout-title">Чому категорії не можна створювати чи видаляти</div>
      Від категорії залежать націнка та юридична позначка товару, тому їхній перелік зафіксовано. Щоб перенести товар до іншої категорії, відкрийте його в розділі «Товари».</div></div>
    <section class="card">
      <div class="card-header"><div><h2 class="card-title">Лінійки</h2><p class="card-sub" id="lines-sub">Групи товарів одного бренду</p></div></div>
      <div class="card-body" style="padding-bottom:12px"><div class="toolbar">
        <div class="input-group search">${icon('search', { size: 17 })}<input class="input" id="ln-q" type="search" placeholder="Назва лінійки або бренд" aria-label="Пошук лінійок" autocomplete="off"></div>
        <label class="sr-only" for="ln-cat">Категорія</label>
        <select class="select" id="ln-cat">${options([['', 'Усі категорії'], ...Object.entries(CATEGORIES).map(([k, c]) => [k, c.label])], '')}</select>
      </div></div>
      <div id="lines-list">${skeletonRows(6)}</div>
    </section>
    <section class="card">
      <div class="card-header"><div><h2 class="card-title">Товари без лінійки</h2><p class="card-sub">Лінійку можна призначити в картці товару</p></div></div>
      <div class="card-body flush" id="unassigned">${skeletonRows(3, { thumb: false })}</div>
    </section>`);

  function renderLines() {
    const q = st.q.toLowerCase();
    const items = lines.filter((l) => (!st.category || l.category === st.category)
      && (!q || l.line.toLowerCase().includes(q) || (l.brand || '').toLowerCase().includes(q)));
    root.querySelector('#lines-sub').textContent = `${count(lines.length, ['лінійка', 'лінійки', 'лінійок'])}${items.length !== lines.length ? ` · показано ${items.length}` : ''}`;
    const box = root.querySelector('#lines-list');
    if (!items.length) {
      setHTML(box, emptyState({ ic: 'layers', compact: true, title: lines.length ? 'Нічого не знайдено' : 'Лінійок ще немає',
        text: lines.length ? 'Змініть запит або категорію.' : 'Вкажіть лінійку в картці товару — вона з’явиться тут.' }));
      return;
    }
    setHTML(box, html`<div class="table-wrap"><table class="table responsive">
      <thead><tr><th>Лінійка</th><th>Категорія</th><th class="col-num">Товарів</th><th class="col-num">Ціни</th><th>Юр. статус</th><th class="col-actions"><span class="sr-only">Дії</span></th></tr></thead>
      <tbody>${items.map((l) => { const i = lines.indexOf(l); return html`<tr>
        <td class="cell-primary"><div class="cell-main">${thumb(l.images[0], { alt: l.line })}<div class="cell-text"><span class="cell-title clamp-2">${l.line}</span><span class="cell-sub">${l.brand}</span></div></div></td>
        <td class="m-hide" data-label="Категорія">${categoryLabel(l.category)}</td>
        <td class="col-num" data-label="Товарів">${int(l.count)} <span class="muted small">(${int(l.in_stock)} в наявн.)</span></td>
        <td class="col-num" data-label="Ціни">${l.min_price == null ? '—' : l.min_price === l.max_price ? money(l.min_price) : html`${money(l.min_price)} – ${money(l.max_price)}`}</td>
        <td data-label="Юр. статус">${l.blocked ? badge(`Заборонено: ${l.blocked}`, 'danger', { ic: 'ban' }) : badge('Юр. перевірка', 'warning', { ic: 'shield-alert' })}</td>
        <td class="col-actions" style="display:table-cell"><div class="row" style="justify-content:flex-end;gap:4px">
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-rename="${i}" aria-label="Перейменувати лінійку «${l.line}»" data-tip="Перейменувати">${icon('pencil', { size: 16 })}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-photos="${i}" aria-label="Фото лінійки «${l.line}»" data-tip="Фото">${icon('image', { size: 16 })}</button>
          <a class="btn btn-ghost btn-icon btn-sm" href="${lineHref(l)}" aria-label="Товари лінійки «${l.line}»" data-tip="Товари">${icon('arrow-right', { size: 16 })}</a>
        </div></td></tr>`; })}</tbody></table></div>`);
    hydrate(box);
  }

  function renderUnassigned() {
    const box = root.querySelector('#unassigned');
    setHTML(box, unassigned.length ? html`<div class="list">${unassigned.map((u) => html`<a class="list-item"
        href="#/products?brand=${encodeURIComponent(u.brand)}&line=__none__${u.category !== 'none' ? `&category=${u.category}` : ''}">
        <span class="cell-text grow"><span class="cell-title">${u.brand}</span><span class="cell-sub">${categoryLabel(u.category)}</span></span>
        <span class="muted tabular">${count(u.count, ['товар', 'товари', 'товарів'])}</span>${icon('chevron-right', { size: 16, cls: 'subtle' })}</a>`)}</div>`
      : emptyState({ ic: 'circle-check', compact: true, title: 'Усі товари мають лінійку' }));
  }

  async function load(force = false) {
    try {
      const [ov, markups, l] = await Promise.all([api('/api/stats/overview', { signal }), getMarkups(), getLines(force)]);
      lines = l.items;
      unassigned = l.unassigned;
      const byCat = ov.products.by_category;
      const linesPerCat = lines.reduce((m, x) => ({ ...m, [x.category]: (m[x.category] || 0) + 1 }), {});
      setHTML(root.querySelector('#cat-cards'), Object.entries(CATEGORIES).map(([k, c]) => html`<div class="card cat-card">
        <div class="cat-card-top"><span class="cat-icon">${icon(c.icon, { size: 20 })}</span><div class="grow"><div class="card-title">${c.label}</div>
          <div class="card-sub">Націнка +${money(markups[k])} · ${count(linesPerCat[k] || 0, ['лінійка', 'лінійки', 'лінійок'])}</div></div></div>
        <div class="cat-count">${int(byCat[k] || 0)} <span class="muted small" style="font-weight:500">${plural(byCat[k] || 0, ['товар', 'товари', 'товарів'])}</span></div>
        <p class="cat-rule">${RULES[k]}</p>
        <div class="cat-actions"><a class="btn btn-sm" href="#/products?category=${k}">${icon('package', { size: 15 })}Товари</a>
          <a class="btn btn-sm btn-ghost" href="#/pricing">${icon('percent', { size: 15 })}Націнка</a></div></div>`));
      renderLines();
      renderUnassigned();
    } catch (e) {
      if (e.name === 'AbortError') return;
      setHTML(root.querySelector('#lines-list'), errorState(e.message));
    }
  }

  function rename(l) {
    const d = openDialog({ title: 'Перейменувати лінійку', icon: 'pencil',
      description: html`${l.brand} · ${count(l.count, ['товар', 'товари', 'товарів'])}`,
      body: html`${field({ id: 'ln-name', label: 'Нова назва', required: true, control: html`<input class="input" id="ln-name" maxlength="200" value="${l.line}" autocomplete="off">` })}
        <div class="callout warning" id="ln-merge" hidden style="margin-top:12px">${icon('triangle-alert', { size: 17 })}<div>Лінійка з такою назвою вже є в бренду ${l.brand}. Товари буде об’єднано в одну лінійку.</div></div>`,
      footer: html`<button type="button" class="btn" data-close>Скасувати</button><button type="button" class="btn btn-primary" data-save>Зберегти</button>`,
      initialFocus: '#ln-name' });
    const input = d.$('#ln-name');
    input.select();
    const existing = (name) => lines.some((x) => x !== l && x.brand === l.brand && x.line === name);
    input.addEventListener('input', () => { d.$('#ln-merge').hidden = !existing(input.value.trim()); setFieldError(d.panel, 'ln-name', ''); });
    const save = async () => {
      const name = input.value.trim();
      if (!name) { setFieldError(d.panel, 'ln-name', 'Вкажіть назву'); input.focus(); return; }
      if (name === l.line) { d.close(); return; }
      const b = d.$('[data-save]');
      setLoading(b, true);
      try {
        const r = await api('/api/lines', { method: 'PATCH', json: { brand: l.brand, line: l.line, new_line: name } });
        invalidateCatalog();
        toast.success(`Лінійку перейменовано: ${count(r.matched, ['товар', 'товари', 'товарів'])}`);
        d.close();
        load(true);
      } catch (e) { toastError(e); setLoading(b, false); }
    };
    d.$('[data-save]').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }

  function photos(l) {
    let imgs = [...l.images];
    let busy = 0;
    const d = openDialog({ title: 'Фото лінійки', icon: 'image', size: 'dialog-lg',
      description: html`«${l.line}» · ${l.brand}`,
      body: html`<div class="callout warning">${icon('triangle-alert', { size: 17 })}<div>Фото буде встановлено всім товарам лінійки (${int(l.count)}) і замінить їхні поточні фото.</div></div>
        <div id="ln-media" style="margin-top:14px"></div><input type="file" id="ln-file" accept="image/jpeg,image/png,image/webp" multiple hidden>`,
      footer: html`<button type="button" class="btn" data-close>Скасувати</button><button type="button" class="btn btn-primary" data-save>Зберегти фото</button>` });
    const box = d.$('#ln-media');
    const draw = () => {
      setHTML(box, html`<div class="media-grid">${imgs.map((ref, i) => html`<div class="media-tile"><img data-ref="${ref}" alt="Фото ${i + 1}">
          ${i === 0 ? html`<span class="media-badge">${badge('Головне', 'accent')}</span>` : ''}
          <div class="media-actions">${i > 0 ? html`<button type="button" class="media-btn" data-main="${i}" aria-label="Зробити головним">${icon('star', { size: 15 })}</button>` : ''}
          <button type="button" class="media-btn" data-del="${i}" aria-label="Прибрати фото">${icon('trash-2', { size: 15 })}</button></div></div>`)}
        ${Array.from({ length: busy }, () => html`<div class="media-tile" style="display:grid;place-items:center"><span class="spinner"></span></div>`)}
        ${imgs.length + busy < 6 ? html`<button type="button" class="media-add" data-pick>${icon('image-plus', { size: 22 })}Додати фото</button>` : ''}</div>
        ${!imgs.length && !busy ? html`<p class="hint" style="margin-top:10px">Без фото товари лінійки показуватимуться із заглушкою.</p>` : ''}`);
      hydrate(box);
    };
    on(box, 'click', '[data-pick]', () => d.$('#ln-file').click());
    on(box, 'click', '[data-del]', (e, b) => { imgs.splice(Number(b.dataset.del), 1); draw(); });
    on(box, 'click', '[data-main]', (e, b) => { const [x] = imgs.splice(Number(b.dataset.main), 1); imgs.unshift(x); draw(); });
    d.$('#ln-file').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const f of files) {
        if (!IMAGE_TYPES.includes(f.type)) { toast.error(`«${f.name}»: підтримуються лише JPEG, PNG або WebP`); continue; }
        if (f.size > 5 * 1024 * 1024) { toast.error(`«${f.name}» більший за 5 МБ`); continue; }
        if (imgs.length + busy >= 6) { toast.error('Для лінійки можна додати не більше 6 фото'); break; }
        busy += 1; draw();
        const fd = new FormData();
        fd.append('file', f);
        try { const r = await api('/api/media', { method: 'POST', body: fd }); if (!imgs.includes(r.path)) imgs.push(r.path); }
        catch (ex) { toastError(ex); }
        finally { busy -= 1; draw(); }
      }
    });
    d.$('[data-save]').addEventListener('click', async (e) => {
      if (busy) { toast.info('Зачекайте, доки завантажаться фото'); return; }
      const b = e.currentTarget;
      setLoading(b, true);
      try {
        const r = await api('/api/lines', { method: 'PATCH', json: { brand: l.brand, line: l.line, images: imgs } });
        toast.success(`Фото оновлено для ${count(r.matched, ['товару', 'товарів', 'товарів'])}`);
        d.close();
        load(true);
      } catch (ex) { toastError(ex); setLoading(b, false); }
    });
    draw();
  }

  on(root, 'input', '#ln-q', debounce((e) => { st.q = e.target.value.trim(); renderLines(); }, 200));
  on(root, 'change', '#ln-cat', (e, s) => { st.category = s.value; renderLines(); });
  on(root, 'click', '[data-rename]', (e, b) => rename(lines[Number(b.dataset.rename)]));
  on(root, 'click', '[data-photos]', (e, b) => photos(lines[Number(b.dataset.photos)]));
  on(root, 'click', '[data-retry]', () => load(true));
  load(true);
}
