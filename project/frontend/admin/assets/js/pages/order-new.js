// New order: pick orderable products, adjust quantities, enter the customer, submit.
import { api } from '../core/api.js';
import { CATEGORIES, categoryLabel } from '../core/labels.js';
import { count, money } from '../core/format.js';
import { bus, cart } from '../core/state.js';
import { navigate } from '../core/router.js';
import { debounce, html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { emptyState, errorState, field, segmented, setFieldError, setLoading, skeletonRows, thumb } from '../ui/components.js';
import { confirmDialog } from '../ui/dialog.js';
import { hydrate } from '../ui/media.js';
import { toast, toastError } from '../ui/toast.js';

const LIMIT = 20;

export default function orderNew({ root, query, signal }) {
  const st = { q: '', category: '', page: 1, items: [], total: 0, pages: 1 };
  let req = 0;

  setHTML(root, html`<div class="page-header">
      <div><h1 class="page-title">Нове замовлення</h1><p class="page-desc">Додайте товари, вкажіть клієнта — ціни й суму розрахує сервер.</p></div>
      <div class="page-actions"><a class="btn" href="#/orders">${icon('receipt', { size: 16 })}Усі замовлення</a></div>
    </div>
    <div class="grid grid-main-wide" style="align-items:start">
      <section class="card">
        <div class="card-header"><div><h2 class="card-title">Товари</h2><p class="card-sub">Лише ті, що в наявності й не заборонені законом</p></div></div>
        <div class="card-body stack" style="padding-bottom:12px">
          <div class="input-group">${icon('search', { size: 17 })}<input class="input" id="pick-q" type="search" placeholder="Назва, бренд або модель" aria-label="Пошук товарів" autocomplete="off"></div>
          <div class="cat-chips">${segmented([['', 'Усі'], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])], '', { attr: 'data-cat', label: 'Категорія' })}</div>
        </div>
        <div id="pick-list">${skeletonRows(6)}</div>
      </section>
      <section class="card cart-sticky" id="cart-card" aria-label="Кошик"></section>
    </div>
    <div class="cart-bar" id="cart-bar" hidden></div>`);

  const list = root.querySelector('#pick-list');
  const cartCard = root.querySelector('#cart-card');
  const bar = root.querySelector('#cart-bar');
  const prefill = { name: query.get('name') || '', contact: query.get('contact') || '' };

  function rowAction(p) {
    const inCart = cart.map()[p.id];
    return inCart
      ? html`<button type="button" class="btn btn-sm" data-add="${p.id}" aria-label="Додати ще один">${icon('plus', { size: 15 })}<span class="tabular">${inCart.qty}</span></button>`
      : html`<button type="button" class="btn btn-sm btn-primary" data-add="${p.id}">${icon('plus', { size: 15 })}Додати</button>`;
  }

  function renderList(append = false) {
    if (!st.items.length) {
      setHTML(list, emptyState({ ic: 'package-x', compact: true, title: st.q || st.category ? 'Нічого не знайдено' : 'Немає товарів для замовлення',
        text: st.q || st.category ? 'Змініть запит або категорію.' : 'Товари з’являться, коли будуть в наявності.' }));
      return;
    }
    const rows = st.items.map((p) => html`<div class="pick-row" data-row="${p.id}">
      ${thumb((p.images || [])[0], { alt: p.name })}
      <div class="cell-text grow"><span class="cell-title clamp-2">${p.name}</span><span class="cell-sub truncate">${p.brand} · ${categoryLabel(p.category)}</span></div>
      <span class="price">${money(p.final_price)}</span>
      <span data-slot="${p.id}">${rowAction(p)}</span></div>`);
    setHTML(list, html`<div class="pick-list">${rows}</div>
      ${st.page < st.pages ? html`<div class="card-footer" style="justify-content:center"><button type="button" class="btn btn-ghost" data-action="more">Показати ще</button></div>` : ''}`);
    hydrate(list);
    if (!append) list.scrollTop = 0;
  }

  async function load(append = false) {
    const my = ++req;
    if (!append) setHTML(list, skeletonRows(6));
    try {
      const d = await api('/api/products', { signal, query: {
        q: st.q, category: st.category, status: 'in_stock', compliance: 'hold_legal_review', page: st.page, limit: LIMIT } });
      if (my !== req) return;
      st.items = append ? [...st.items, ...d.items] : d.items;
      st.pages = d.pages;
      st.total = d.total;
      renderList(append);
    } catch (e) {
      if (e.name === 'AbortError' || my !== req) return;
      setHTML(list, errorState(e.message, { compact: true }));
    }
  }

  function renderCart() {
    const lines = cart.lines();
    const n = cart.count();
    const total = cart.total();
    const nameVal = cartCard.querySelector('#cust-name')?.value ?? prefill.name;
    const contactVal = cartCard.querySelector('#cust-contact')?.value ?? prefill.contact;
    setHTML(cartCard, html`<div class="card-header"><div><h2 class="card-title">Кошик</h2><p class="card-sub">${n ? count(n, ['одиниця', 'одиниці', 'одиниць']) : 'Порожній'}</p></div>
        ${lines.length ? html`<div class="card-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="clear">${icon('trash-2', { size: 15 })}Очистити</button></div>` : ''}</div>
      <div class="card-body stack">
        ${lines.length ? html`<div>${lines.map((l) => html`<div class="cart-line">
            <div class="cell-text"><span class="cell-title clamp-2">${l.name}</span><span class="cell-sub">${l.brand || ''} · ${money(l.price)}</span></div>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove="${l.id}" aria-label="Прибрати «${l.name}»" data-tip="Прибрати">${icon('x', { size: 16 })}</button>
            <div class="controls">
              <div class="stepper"><button type="button" data-dec="${l.id}" aria-label="Менше">${icon('minus', { size: 15 })}</button>
                <input type="number" min="1" max="1000" inputmode="numeric" value="${l.qty}" data-qty="${l.id}" aria-label="Кількість «${l.name}»">
                <button type="button" data-inc="${l.id}" aria-label="Більше">${icon('plus', { size: 15 })}</button></div>
              <span class="line-sum">${money(Number(l.price || 0) * l.qty)}</span>
            </div></div>`)}</div>
          <div class="price-box"><div class="price-row price-total" style="border:0;padding:0;margin:0"><span>Орієнтовна сума</span><span class="v">${money(total)}</span></div>
            <span class="hint">Остаточну суму розрахує сервер за актуальними цінами.</span></div>`
          : emptyState({ ic: 'shopping-cart', compact: true, title: 'Кошик порожній', text: 'Додайте товари зі списку ліворуч.' })}
        <form class="stack" data-form="order" novalidate>
          ${field({ id: 'cust-name', label: 'Ім’я клієнта', required: true, control: html`<input class="input" id="cust-name" maxlength="120" autocomplete="off" value="${nameVal}">` })}
          ${field({ id: 'cust-contact', label: 'Контакт', hint: 'Телефон, Telegram або e-mail — необов’язково', control: html`<input class="input" id="cust-contact" maxlength="120" autocomplete="off" value="${contactVal}">` })}
          <button type="submit" class="btn btn-primary btn-lg btn-block" ${lines.length ? '' : 'disabled'}>${icon('check', { size: 17 })}Створити замовлення</button>
        </form>
      </div>`);
    bar.hidden = !lines.length;
    if (lines.length) {
      setHTML(bar, html`<div class="cell-text grow"><span class="cell-title">${count(n, ['одиниця', 'одиниці', 'одиниць'])}</span><span class="cell-sub">${money(total)}</span></div>
        <button type="button" class="btn btn-primary" data-action="to-cart">Оформити${icon('arrow-right', { size: 16 })}</button>`);
    }
  }

  function refreshRow(id) {
    const slot = list.querySelector(`[data-slot="${CSS.escape(id)}"]`);
    const p = st.items.find((x) => x.id === id);
    if (slot && p) setHTML(slot, rowAction(p));
  }

  const search = debounce(() => { st.q = root.querySelector('#pick-q').value.trim(); st.page = 1; load(); }, 300);
  on(root, 'input', '#pick-q', search);
  on(root, 'click', '[data-cat]', (e, b) => {
    st.category = b.dataset.cat; st.page = 1;
    root.querySelectorAll('[data-cat]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load();
  });
  on(root, 'click', '[data-action="more"]', (e, b) => { b.disabled = true; st.page += 1; load(true); });
  on(root, 'click', '[data-retry]', () => load());
  on(root, 'click', '[data-add]', (e, b) => {
    const p = st.items.find((x) => x.id === b.dataset.add);
    if (!p) return;
    cart.add(p, 1);
    refreshRow(p.id);
  });
  on(root, 'click', '[data-inc]', (e, b) => { const l = cart.map()[b.dataset.inc]; if (l) cart.setQty(l.id, l.qty + 1); });
  on(root, 'click', '[data-dec]', (e, b) => { const l = cart.map()[b.dataset.dec]; if (l && l.qty > 1) cart.setQty(l.id, l.qty - 1); });
  on(root, 'change', '[data-qty]', (e, i) => cart.setQty(i.dataset.qty, i.value));
  on(root, 'click', '[data-remove]', (e, b) => { cart.remove(b.dataset.remove); refreshRow(b.dataset.remove); });
  on(root, 'click', '[data-action="clear"]', async () => {
    if (await confirmDialog({ title: 'Очистити кошик?', text: 'Усі товари буде прибрано з кошика.', confirmText: 'Очистити', tone: 'danger' })) {
      cart.clear();
      st.items.forEach((p) => refreshRow(p.id));
    }
  });
  on(root, 'click', '[data-action="to-cart"]', () => {
    cartCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => cartCard.querySelector('#cust-name')?.focus({ preventScroll: true }), 350);
  });
  on(root, 'submit', '[data-form="order"]', async (e, f) => {
    e.preventDefault();
    const name = f.querySelector('#cust-name').value.trim();
    const contact = f.querySelector('#cust-contact').value.trim();
    const okName = setFieldError(f, 'cust-name', name ? '' : 'Вкажіть ім’я клієнта');
    if (!okName) { f.querySelector('#cust-name').focus(); return; }
    const lines = cart.lines();
    if (!lines.length) { toast.error('Додайте до кошика хоча б один товар'); return; }
    const b = f.querySelector('[type="submit"]');
    setLoading(b, true);
    try {
      const o = await api('/api/orders', { method: 'POST', json: { customer_name: name, contact, items: lines.map((l) => ({ product_id: l.id, qty: l.qty })) } });
      cart.clear();
      toast.success(`Замовлення ${o.number} створено на суму ${money(o.total)}`);
      bus.emit('orders:changed');
      navigate(`/orders?open=${encodeURIComponent(o.number)}`);
    } catch (ex) {
      toastError(ex);
      setLoading(b, false);
    }
  });
  on(root, 'input', '#cust-name', (e, i) => { if (i.value.trim()) setFieldError(root, 'cust-name', ''); });

  const off = bus.on('cart', renderCart);
  renderCart();
  load();
  return off;
}
