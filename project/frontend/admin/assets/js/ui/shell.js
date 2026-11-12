// Application shell: sidebar, top bar, phone bottom navigation, badges.
import { html, on, setHTML } from './dom.js';
import { icon } from './icons.js';
import { avatar } from './components.js';
import { bus, cart, prefs, store, theme } from '../core/state.js';

export const NAV = [
  { group: 'Огляд', items: [
    { key: 'dashboard', path: '/', label: 'Дашборд', icon: 'layout-dashboard' },
    { key: 'analytics', path: '/analytics', label: 'Аналітика', icon: 'chart-line' },
  ] },
  { group: 'Продажі', items: [
    { key: 'orders', path: '/orders', label: 'Замовлення', icon: 'receipt', badge: 'newOrders' },
    { key: 'order-new', path: '/orders/new', label: 'Нове замовлення', icon: 'shopping-cart', badge: 'cart' },
    { key: 'customers', path: '/customers', label: 'Клієнти', icon: 'users' },
  ] },
  { group: 'Каталог', items: [
    { key: 'products', path: '/products', label: 'Товари', icon: 'package' },
    { key: 'catalog', path: '/catalog', label: 'Категорії та лінійки', icon: 'layers' },
    { key: 'pricing', path: '/pricing', label: 'Націнки', icon: 'percent' },
    { key: 'import', path: '/import', label: 'Імпорт прайсу', icon: 'file-up' },
  ] },
  { group: 'Система', items: [
    { key: 'activity', path: '/activity', label: 'Журнал дій', icon: 'history' },
    { key: 'settings', path: '/settings', label: 'Налаштування', icon: 'settings' },
  ] },
];
const BOTTOM = [
  { key: 'dashboard', path: '/', label: 'Огляд', icon: 'layout-dashboard' },
  { key: 'orders', path: '/orders', label: 'Замовлення', icon: 'receipt', badge: 'newOrders' },
  { key: 'products', path: '/products', label: 'Товари', icon: 'package' },
  { key: 'customers', path: '/customers', label: 'Клієнти', icon: 'users' },
];

const badges = { newOrders: 0, cart: 0 };
let app;
let globalsBound = false;

const navItem = (it) => html`<a class="nav-item" href="#${it.path}" data-key="${it.key}" ${it.badge ? html`data-badge="${it.badge}"` : ''}>
  ${icon(it.icon, { size: 19 })}<span class="nav-text">${it.label}</span>
  ${it.badge ? html`<span class="nav-badge" data-badge-count="${it.badge}" hidden></span>` : ''}</a>`;

function themeIcon() {
  return theme.resolve() === 'light' ? icon('moon', { size: 18 }) : icon('sun', { size: 18 });
}

export const shell = {
  mount(root, { onLogout }) {
    const collapsed = prefs.get('collapsed', false);
    const name = store.me?.username || '';
    setHTML(root, html`<div class="app ${collapsed ? 'is-collapsed' : ''}" id="app">
      <aside class="sidebar" id="sidebar" aria-label="Головне меню">
        <a class="brand" href="#/">
          <span class="brand-mark">${icon('wind', { size: 20 })}</span>
          <span class="brand-text"><span class="brand-name truncate" id="brand-name" style="display:block"></span><span class="brand-sub" style="display:block">Адмін-панель</span></span>
        </a>
        <nav class="nav" aria-label="Розділи">
          ${NAV.map((g) => html`<div class="nav-group"><div class="nav-label">${g.group}</div>${g.items.map(navItem)}</div>`)}
        </nav>
        <div class="sidebar-footer">
          <button type="button" class="nav-item collapse-btn" data-action="collapse" data-tip-pos="right"></button>
          <div class="user-card">
            ${avatar(name, 'avatar-sm')}
            <div class="user-text"><div class="user-name truncate">${name}</div><div class="user-role">Адміністратор</div></div>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="logout" aria-label="Вийти" data-tip="Вийти">${icon('log-out', { size: 17 })}</button>
          </div>
        </div>
      </aside>
      <div class="nav-backdrop" data-action="close-nav"></div>
      <div class="main">
        <header class="topbar">
          <button type="button" class="btn btn-ghost btn-icon menu-btn" data-action="open-nav" aria-label="Відкрити меню" aria-controls="sidebar" aria-expanded="false">${icon('menu', { size: 20 })}</button>
          <div class="crumbs" id="crumbs"></div>
          <div class="topbar-actions">
            <button type="button" class="btn btn-ghost btn-icon" data-action="theme" id="theme-btn" data-tip-pos="bottom"></button>
            <a class="btn btn-primary hide-phone" href="#/orders/new" id="cta-order">${icon('plus', { size: 17 })}<span>Нове замовлення</span><span class="btn-count" data-badge-count="cart" hidden></span></a>
          </div>
        </header>
        <main id="page-host" tabindex="-1"></main>
      </div>
      <nav class="bottom-nav" aria-label="Швидка навігація">
        ${BOTTOM.map((it) => html`<a class="bn-item" href="#${it.path}" data-key="${it.key}">${icon(it.icon, { size: 21 })}<span>${it.label}</span>
          ${it.badge ? html`<span class="bn-badge" data-badge-count="${it.badge}" hidden></span>` : ''}</a>`)}
        <button type="button" class="bn-item" data-action="open-nav" aria-label="Усі розділи">${icon('menu', { size: 21 })}<span>Меню</span></button>
      </nav>
    </div>`);
    app = root.querySelector('#app');
    this.updateBrand();
    this.updateTheme();
    this.updateCollapse();
    on(app, 'click', '[data-action]', (e, t) => {
      const a = t.dataset.action;
      if (a === 'collapse') { app.classList.toggle('is-collapsed'); prefs.set('collapsed', app.classList.contains('is-collapsed')); this.updateCollapse(); }
      if (a === 'open-nav') this.openNav();
      if (a === 'close-nav') this.closeNav();
      if (a === 'logout') onLogout();
      if (a === 'theme') theme.set(theme.resolve() === 'light' ? 'dark' : 'light');
    });
    on(app, 'click', '.sidebar a', () => this.closeNav());
    if (!globalsBound) {
      globalsBound = true;
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && app?.classList.contains('nav-open')) this.closeNav(); });
      bus.on('theme', () => this.updateTheme());
      bus.on('cart', () => this.setBadge('cart', cart.count()));
      bus.on('settings', () => this.updateBrand());
    }
    this.setBadge('cart', cart.count());
    this.setBadge('newOrders', badges.newOrders);
  },
  updateBrand() {
    const el = app?.querySelector('#brand-name');
    if (el) el.textContent = store.settings.shop_name || 'Мій магазин';
  },
  updateTheme() {
    const b = app?.querySelector('#theme-btn');
    if (!b) return;
    const light = theme.resolve() === 'light';
    setHTML(b, themeIcon());
    b.setAttribute('aria-label', light ? 'Увімкнути темну тему' : 'Увімкнути світлу тему');
    b.dataset.tip = light ? 'Темна тема' : 'Світла тема';
  },
  updateCollapse() {
    const b = app?.querySelector('.collapse-btn');
    if (!b) return;
    const c = app.classList.contains('is-collapsed');
    setHTML(b, html`${icon(c ? 'panel-left-open' : 'panel-left-close', { size: 19 })}<span class="nav-text">Згорнути меню</span>`);
    b.setAttribute('aria-label', c ? 'Розгорнути меню' : 'Згорнути меню');
    if (c) b.dataset.tip = 'Розгорнути меню'; else delete b.dataset.tip;
  },
  setCollapsed(on) {
    prefs.set('collapsed', Boolean(on));
    app?.classList.toggle('is-collapsed', Boolean(on));
    this.updateCollapse();
  },
  setActive(key, title, group) {
    if (!app) return;
    app.querySelectorAll('[data-key]').forEach((a) => {
      const on = a.dataset.key === key;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    setHTML(app.querySelector('#crumbs'), html`${group ? html`<span class="hide-phone">${group}</span><span class="hide-phone">${icon('chevron-right', { size: 14 })}</span>` : ''}<span class="current truncate">${title}</span>`);
  },
  setBadge(name, n) {
    badges[name] = n;
    if (!app) return;
    app.querySelectorAll(`[data-badge-count="${name}"]`).forEach((b) => { b.textContent = n > 99 ? '99+' : String(n); b.hidden = !n; });
    app.querySelectorAll(`[data-badge="${name}"]`).forEach((a) => a.classList.toggle('has-badge', Boolean(n)));
  },
  openNav() {
    app?.classList.add('nav-open');
    app?.querySelectorAll('[data-action="open-nav"]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
    app?.querySelector('.sidebar .nav-item.is-active, .sidebar .nav-item')?.focus({ preventScroll: true });
  },
  closeNav() {
    if (!app?.classList.contains('nav-open')) return;
    app.classList.remove('nav-open');
    app.querySelectorAll('[data-action="open-nav"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  },
  host() { return app?.querySelector('#page-host'); },
  unmount() { app = null; },
};
