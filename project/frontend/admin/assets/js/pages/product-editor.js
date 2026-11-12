// Product create/edit sheet: full form with validation, live price, images, legal status, deletion.
import { api } from '../core/api.js';
import { AVAILABILITY, CATEGORIES, COMPLIANCE, REASONS } from '../core/labels.js';
import { dateTime, money, num } from '../core/format.js';
import { cart, getBrands, getLines, getMarkups, invalidateCatalog } from '../core/state.js';
import { html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { availabilityBadge, badge, complianceBadge, errorState, field, options, setFieldError, setLoading, skeletonRows, thumb } from '../ui/components.js';
import { confirmDialog, openSheet } from '../ui/dialog.js';
import { hydrate } from '../ui/media.js';
import { toast, toastError } from '../ui/toast.js';

const PRICE_RE = /^\d{1,7}([.,]\d{1,2})?$/;
const TEXT = ['name', 'brand', 'product_line', 'model', 'variant'];
const MAX_IMAGES = 12;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const blank = () => ({ name: '', brand: '', category: '', product_line: '', model: '', variant: '', volume_ml: '', nicotine_mg: '',
  purchase_price: '', status: 'in_stock', images: [] });

function fromProduct(p) {
  return {
    name: p.name || '', brand: p.brand || '', category: p.category || '', product_line: p.product_line || '', model: p.model || '',
    variant: p.variant || '', volume_ml: p.volume_ml == null ? '' : String(p.volume_ml), nicotine_mg: p.nicotine_mg == null ? '' : String(p.nicotine_mg),
    purchase_price: p.purchase_price != null ? String(Number(p.purchase_price)) : '', status: p.status || 'in_stock', images: [...(p.images || [])],
  };
}

const orderable = (p) => p && p.status === 'in_stock' && p.final_price != null && p.compliance?.status !== 'blocked_by_law';

/**
 * Opens the editor. id = null creates a product.
 * onSaved(product, {created}) and onDeleted(id) let the caller refresh its list.
 */
export function openProductEditor({ id = null, onSaved, onDeleted } = {}) {
  const creating = !id;
  let product = null;
  let original = blank();
  let v = blank();
  let markups = {};
  let brands = [];
  let lines = [];
  let uploading = 0;

  const sheet = openSheet({ title: creating ? 'Новий товар' : 'Товар', subtitle: 'Завантаження…', body: skeletonRows(6), label: creating ? 'Новий товар' : 'Редагування товару' });
  const p = sheet.panel;

  const dirty = () => JSON.stringify(v) !== JSON.stringify(original);

  function finalPrice() {
    const price = Number(String(v.purchase_price).replace(',', '.'));
    if (!v.category || !PRICE_RE.test(String(v.purchase_price).trim()) || markups[v.category] == null) return null;
    return price + Number(markups[v.category]);
  }

  function header() {
    if (creating) return html`<div class="grow"><h2 class="sheet-title">Новий товар</h2><p class="sheet-sub">Кінцеву ціну буде розраховано автоматично: закупівельна ціна + націнка категорії.</p></div>`;
    return html`<div class="product-head grow">${thumb(product.images?.[0], { cls: 'thumb-lg', alt: product.name })}
      <div class="cell-text grow"><h2 class="sheet-title">${product.name}</h2>
        <p class="sheet-sub">${product.brand}${product.category_label ? html` · ${product.category_label}` : ''}</p>
        <div class="row row-wrap" style="margin-top:8px">${availabilityBadge(product.status)}${complianceBadge(product.compliance)}</div></div></div>`;
  }

  function priceBox() {
    const fp = finalPrice();
    const m = v.category ? markups[v.category] : null;
    return html`<div class="price-box" id="price-box">
      <div class="price-row"><span>Закупівельна ціна</span><span class="v">${PRICE_RE.test(String(v.purchase_price).trim()) ? money(String(v.purchase_price).replace(',', '.')) : '—'}</span></div>
      <div class="price-row"><span>Націнка категорії <a class="link small" href="#/pricing">змінити</a></span><span class="v">${m != null ? `+ ${money(m)}` : '—'}</span></div>
      <div class="price-row price-total"><span>Ціна для клієнта</span><span class="v">${fp != null ? money(fp) : '—'}</span></div>
      ${!v.category ? html`<span class="hint tone-warning">Ціну не буде розраховано, доки не обрано категорію.</span>` : ''}
    </div>`;
  }

  function mediaGrid() {
    return html`<div class="media-grid" id="media-grid">
      ${v.images.map((ref, i) => html`<div class="media-tile">
        <img data-ref="${ref}" alt="Фото ${i + 1}" decoding="async">
        ${i === 0 ? html`<span class="media-badge">${badge('Головне', 'accent')}</span>` : ''}
        <div class="media-actions">
          ${i > 0 ? html`<button type="button" class="media-btn" data-main="${i}" aria-label="Зробити головним" data-tip="Зробити головним">${icon('star', { size: 15 })}</button>` : ''}
          <button type="button" class="media-btn" data-unimg="${i}" aria-label="Прибрати фото" data-tip="Прибрати">${icon('trash-2', { size: 15 })}</button>
        </div></div>`)}
      ${Array.from({ length: uploading }, () => html`<div class="media-tile" style="display:grid;place-items:center"><span class="spinner" role="status" aria-label="Завантаження фото"></span></div>`)}
      ${v.images.length + uploading < MAX_IMAGES ? html`<button type="button" class="media-add" data-action="pick-image">${icon('image-plus', { size: 22 })}Додати фото</button>` : ''}
    </div>
    <input type="file" id="img-input" accept="image/jpeg,image/png,image/webp" multiple hidden>`;
  }

  function lineOptions() {
    return lines.filter((l) => !v.brand || l.brand.toLowerCase() === v.brand.trim().toLowerCase()).map((l) => html`<option value="${l.line}"></option>`);
  }

  function body() {
    const c = product?.compliance;
    const cx = COMPLIANCE[c?.status];
    const internal = product?.internal || {};
    return html`<form id="product-form" novalidate>
      <section class="section">
        <h3 class="section-title">${icon('banknote', { size: 15 })}Ціна</h3>
        <div class="form-grid">
          ${field({ id: 'pf-price', label: 'Закупівельна ціна', required: true, hint: 'До 2 знаків після коми, напр. 812 або 812,50',
            control: html`<div class="input-affix"><input class="input tabular" id="pf-price" name="purchase_price" inputmode="decimal" autocomplete="off" value="${v.purchase_price}"><span class="affix">грн</span></div>` })}
          <div>${priceBox()}</div>
        </div>
        ${product?.usdt ? html`<div class="callout info">${icon('info', { size: 17 })}<div>Ціну отримано з прайсу в USDT: ${num(product.usdt.purchase)} USDT за курсом ${num(product.usdt.rate)}${product.final_price_usdt ? html` · для клієнта ${num(product.final_price_usdt)} USDT` : ''}. Після ручної зміни закупівельної ціни прив’язку до USDT буде скинуто.</div></div>` : ''}
      </section>
      <section class="section">
        <h3 class="section-title">${icon('package', { size: 15 })}Наявність</h3>
        <div class="segmented segmented-block" role="group" aria-label="Наявність">
          ${Object.entries(AVAILABILITY).map(([k, a]) => html`<button type="button" data-avail="${k}" aria-pressed="${String(v.status === k)}">${a.label}</button>`)}
        </div>
      </section>
      <section class="section">
        <h3 class="section-title">${icon('tag', { size: 15 })}Основні дані</h3>
        <div class="form-grid">
          ${field({ id: 'pf-name', label: 'Назва', required: true, cls: 'span-2', control: html`<input class="input" id="pf-name" name="name" maxlength="200" autocomplete="off" value="${v.name}">` })}
          ${field({ id: 'pf-brand', label: 'Бренд', required: true, control: html`<input class="input" id="pf-brand" name="brand" maxlength="80" list="dl-brands" autocomplete="off" value="${v.brand}">
            <datalist id="dl-brands">${brands.map((b) => html`<option value="${b}"></option>`)}</datalist>` })}
          ${field({ id: 'pf-category', label: 'Категорія', required: creating, hint: 'Визначає націнку та юридичну позначку',
            control: html`<select class="select" id="pf-category" name="category">
              ${creating || v.category ? html`<option value="" ${v.category ? '' : 'selected'} disabled hidden>Оберіть категорію</option>` : html`<option value="">Не визначено</option>`}
              ${options(Object.entries(CATEGORIES).map(([k, c]) => [k, c.one]), v.category)}</select>` })}
          ${field({ id: 'pf-line', label: 'Лінійка', hint: 'Група товарів одного бренду (серія, набір)', control: html`<input class="input" id="pf-line" name="product_line" maxlength="200" list="dl-lines" autocomplete="off" value="${v.product_line}">
            <datalist id="dl-lines">${lineOptions()}</datalist>` })}
          ${field({ id: 'pf-model', label: 'Модель', control: html`<input class="input" id="pf-model" name="model" maxlength="120" autocomplete="off" value="${v.model}">` })}
          ${field({ id: 'pf-variant', label: 'Варіант', hint: 'Смак, колір тощо', control: html`<input class="input" id="pf-variant" name="variant" maxlength="120" autocomplete="off" value="${v.variant}">` })}
          ${field({ id: 'pf-volume', label: 'Об’єм', control: html`<div class="input-affix"><input class="input tabular" id="pf-volume" name="volume_ml" inputmode="decimal" autocomplete="off" value="${v.volume_ml}"><span class="affix">мл</span></div>` })}
          ${field({ id: 'pf-nicotine', label: 'Нікотин', control: html`<div class="input-affix"><input class="input tabular" id="pf-nicotine" name="nicotine_mg" inputmode="decimal" autocomplete="off" value="${v.nicotine_mg}"><span class="affix">мг/мл</span></div>` })}
        </div>
      </section>
      <section class="section">
        <h3 class="section-title">${icon('image', { size: 15 })}Фото <span class="muted small" style="font-weight:400">JPEG, PNG або WebP, до 5 МБ, не більше ${MAX_IMAGES}</span></h3>
        ${mediaGrid()}
        ${product?.image_scope ? html`<p class="hint">Фото спільне для всієї ${product.image_scope === 'line' ? 'лінійки' : 'моделі'}, а не лише для цього смаку чи кольору.</p>` : ''}
      </section>
      ${!creating ? html`<section class="section">
        <h3 class="section-title">${icon('shield-alert', { size: 15 })}Юридичний статус</h3>
        <div class="row row-wrap">${complianceBadge(c)}</div>
        ${c?.reasons?.length ? html`<ul class="reasons">${c.reasons.map((r) => html`<li>${icon('chevron-right', { size: 14 })}${REASONS[r] || r}</li>`)}</ul>` : ''}
        ${c?.status === 'blocked_by_law' ? html`<div class="callout danger">${icon('ban', { size: 17 })}<div>Товар заборонений законом до продажу й не може бути доданий до замовлення.</div></div>` : ''}
        <p class="hint">Позначку розраховано автоматично за категорією, об’ємом і вмістом нікотину; вручну її змінити не можна. Після зміни цих полів вона оновиться під час збереження.${cx ? '' : ''}</p>
      </section>
      <section class="section">
        <h3 class="section-title">${icon('info', { size: 15 })}Службова інформація</h3>
        <dl class="kv">
          <dt>Створено</dt><dd>${dateTime(product.created_at)}</dd>
          <dt>Оновлено</dt><dd>${dateTime(product.updated_at)}</dd>
          ${product.sku ? html`<dt>Артикул</dt><dd>${product.sku}</dd>` : ''}
          ${internal.supplier_mrc_uah ? html`<dt>РРЦ постачальника</dt><dd>${money(internal.supplier_mrc_uah)}</dd>` : ''}
          ${internal.source_sheet ? html`<dt>Джерело</dt><dd>Аркуш «${internal.source_sheet}», рядок ${internal.source_row ?? '—'}</dd>` : ''}
          ${internal.manual ? html`<dt>Джерело</dt><dd>Створено вручну</dd>` : ''}
        </dl>
      </section>` : ''}
    </form>`;
  }

  function footer() {
    return creating
      ? html`<span class="spacer"></span><button type="button" class="btn" data-close>Скасувати</button>
        <button type="button" class="btn btn-primary" data-action="save">${icon('check', { size: 16 })}Створити товар</button>`
      : html`<button type="button" class="btn btn-danger" data-action="delete">${icon('trash-2', { size: 16 })}Видалити</button>
        <span class="spacer"></span>
        ${orderable(product) ? html`<button type="button" class="btn" data-action="to-cart" ${dirty() ? 'disabled' : ''}>${icon('shopping-cart', { size: 16 })}${cart.has(product.id) ? 'Ще одна в кошик' : 'До замовлення'}</button>` : ''}
        <button type="button" class="btn btn-primary" data-action="save" ${dirty() ? '' : 'disabled'}>${icon('check', { size: 16 })}Зберегти</button>`;
  }

  function render() {
    sheet.setHeader(header());
    sheet.setBody(body());
    sheet.setFooter(footer());
    hydrate(p);
  }
  const refreshFooter = () => sheet.setFooter(footer());
  const refreshPrice = () => { const b = p.querySelector('#price-box'); if (b) b.outerHTML = String(priceBox()); };
  const refreshMedia = () => {
    const g = p.querySelector('#media-grid');
    const input = p.querySelector('#img-input');
    if (!g) return;
    input?.remove();
    g.outerHTML = String(mediaGrid());
    hydrate(p);
    refreshFooter();
  };

  function validate() {
    const errs = {};
    const price = String(v.purchase_price).trim();
    if (!v.name.trim()) errs['pf-name'] = 'Вкажіть назву товару';
    if (!v.brand.trim()) errs['pf-brand'] = 'Вкажіть бренд';
    if (!price) errs['pf-price'] = 'Вкажіть закупівельну ціну';
    else if (!PRICE_RE.test(price)) errs['pf-price'] = 'Ціна — число до 9 999 999 з двома знаками після коми';
    if (creating && !v.category) errs['pf-category'] = 'Оберіть категорію';
    for (const [key, id] of [['volume_ml', 'pf-volume'], ['nicotine_mg', 'pf-nicotine']]) {
      const s = String(v[key]).trim().replace(',', '.');
      if (s && (!/^\d+(\.\d+)?$/.test(s) || Number(s) > 100000)) errs[id] = 'Вкажіть невід’ємне число';
    }
    for (const id of ['pf-name', 'pf-brand', 'pf-price', 'pf-category', 'pf-volume', 'pf-nicotine']) setFieldError(p, id, errs[id] || '');
    const first = Object.keys(errs)[0];
    if (first) p.querySelector(`#${first}`)?.focus();
    return !first;
  }

  function payload() {
    const num_ = (s) => { const t = String(s).trim().replace(',', '.'); return t === '' ? null : Number(t); };
    const out = {};
    const norm = {
      name: v.name.trim(), brand: v.brand.trim(), category: v.category || null,
      product_line: v.product_line.trim() || null, model: v.model.trim() || null, variant: v.variant.trim() || null,
      volume_ml: num_(v.volume_ml), nicotine_mg: num_(v.nicotine_mg),
      purchase_price: String(v.purchase_price).trim().replace(',', '.'), status: v.status, images: v.images,
    };
    if (creating) return norm;
    const o = original;
    for (const k of TEXT) if ((norm[k] || '') !== (o[k] || '').trim()) out[k] = norm[k];
    if ((norm.category || '') !== (o.category || '')) out.category = norm.category;
    if (norm.volume_ml !== num_(o.volume_ml)) out.volume_ml = norm.volume_ml;
    if (norm.nicotine_mg !== num_(o.nicotine_mg)) out.nicotine_mg = norm.nicotine_mg;
    if (Number(norm.purchase_price) !== Number(o.purchase_price)) out.purchase_price = norm.purchase_price;
    if (norm.status !== o.status) out.status = norm.status;
    if (JSON.stringify(norm.images) !== JSON.stringify(o.images)) out.images = norm.images;
    return out;
  }

  async function save(btn) {
    if (uploading) { toast.info('Зачекайте, доки завантажаться фото'); return; }
    if (!validate()) return;
    const body = payload();
    if (!creating && !Object.keys(body).length) { toast.info('Змін немає'); return; }
    setLoading(btn, true);
    try {
      const saved = creating
        ? await api('/api/products', { method: 'POST', json: body })
        : await api(`/api/products/${encodeURIComponent(id)}`, { method: 'PATCH', json: body });
      invalidateCatalog();
      toast.success(creating ? `Товар «${saved.name}» створено` : 'Зміни збережено');
      onSaved?.(saved, { created: creating });
      if (creating) { sheet.close(); return; }
      product = saved;
      original = fromProduct(saved);
      v = fromProduct(saved);
      render();
    } catch (e) {
      toastError(e);
      setLoading(btn, false);
    }
  }

  async function upload(files) {
    for (const f of files) {
      if (!IMAGE_TYPES.includes(f.type)) { toast.error(`«${f.name}»: підтримуються лише JPEG, PNG або WebP`); continue; }
      if (f.size > 5 * 1024 * 1024) { toast.error(`«${f.name}» більший за 5 МБ`); continue; }
      if (v.images.length + uploading >= MAX_IMAGES) { toast.error(`Можна додати не більше ${MAX_IMAGES} фото`); break; }
      uploading += 1;
      refreshMedia();
      const fd = new FormData();
      fd.append('file', f);
      try {
        const r = await api('/api/media', { method: 'POST', body: fd });
        if (!v.images.includes(r.path)) v.images.push(r.path);
      } catch (e) {
        toastError(e);
      } finally {
        uploading -= 1;
        refreshMedia();
      }
    }
  }

  on(p, 'input', '#product-form input', (e, i) => {
    if (!i.name) return;
    v[i.name] = i.value;
    if (i.name === 'purchase_price') refreshPrice();
    if (i.name === 'brand') setHTML(p.querySelector('#dl-lines'), lineOptions());
    setFieldError(p, i.id, '');
    refreshFooter();
  });
  on(p, 'change', '#pf-category', (e, s) => { v.category = s.value; setFieldError(p, s.id, ''); refreshPrice(); refreshFooter(); });
  on(p, 'click', '[data-avail]', (e, b) => {
    v.status = b.dataset.avail;
    p.querySelectorAll('[data-avail]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    refreshFooter();
  });
  on(p, 'click', '[data-action="pick-image"]', () => p.querySelector('#img-input')?.click());
  on(p, 'change', '#img-input', (e, input) => { const files = [...input.files]; input.value = ''; upload(files); });
  on(p, 'click', '[data-unimg]', (e, b) => { v.images.splice(Number(b.dataset.unimg), 1); refreshMedia(); });
  on(p, 'click', '[data-main]', (e, b) => { const [img] = v.images.splice(Number(b.dataset.main), 1); v.images.unshift(img); refreshMedia(); });
  on(p, 'click', '[data-action="save"]', (e, b) => save(b));
  on(p, 'submit', '#product-form', (e) => { e.preventDefault(); save(p.querySelector('[data-action="save"]')); });
  on(p, 'click', '[data-action="to-cart"]', () => { cart.add(product, 1); toast.success(`«${product.name}» додано до кошика`); refreshFooter(); });
  on(p, 'click', '[data-action="delete"]', async (e, b) => {
    const ok = await confirmDialog({ title: 'Видалити товар?', tone: 'danger', confirmText: 'Видалити',
      text: html`«<b>${product.name}</b>» буде видалено з каталогу. Уже створені замовлення не зміняться. Дію не можна скасувати.` });
    if (!ok) return;
    setLoading(b, true);
    try {
      await api(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE', query: { confirm: 'true' } });
      invalidateCatalog();
      cart.remove(id);
      toast.success('Товар видалено');
      sheet.close();
      onDeleted?.(id);
    } catch (ex) {
      toastError(ex);
      setLoading(b, false);
    }
  });
  on(p, 'click', '[data-retry]', () => init());
  sheet.guard = async () => !dirty() || confirmDialog({ title: 'Скасувати зміни?', text: 'Незбережені зміни буде втрачено.',
    confirmText: 'Скасувати зміни', cancelText: 'Продовжити редагування', tone: 'danger' });

  async function init() {
    try {
      const [prod, m, b, l] = await Promise.all([
        creating ? null : api(`/api/products/${encodeURIComponent(id)}`), getMarkups(), getBrands(), getLines().catch(() => ({ items: [] }))]);
      product = prod;
      markups = m;
      brands = b;
      lines = l.items || [];
      original = creating ? blank() : fromProduct(prod);
      v = creating ? blank() : fromProduct(prod);
      render();
      if (creating) p.querySelector('#pf-name')?.focus();
    } catch (e) {
      sheet.setHeader(html`<div class="grow"><h2 class="sheet-title">${creating ? 'Новий товар' : 'Товар'}</h2></div>`);
      sheet.setBody(errorState(e.message));
      sheet.setFooter('');
    }
  }
  init();
  return sheet;
}
