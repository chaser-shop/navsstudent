// Bootstrap: theme, auth gate, shell, routing.
import { api, auth, setOnExpired } from './core/api.js';
import { bus, cart, store, theme } from './core/state.js';
import { addRoute, match, navigate, parseHash } from './core/router.js';
import { html, setHTML } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { emptyState, errorState } from './ui/components.js';
import { closeAll } from './ui/dialog.js';
import { clearMediaCache } from './ui/media.js';
import { shell } from './ui/shell.js';
import { toast } from './ui/toast.js';

const root = document.getElementById('root');
theme.apply();

const R = (key, path, title, group, load) => addRoute(path, load, { key, title, group });
R('dashboard', '/', 'Дашборд', 'Огляд', () => import('./pages/dashboard.js'));
R('analytics', '/analytics', 'Аналітика', 'Огляд', () => import('./pages/analytics.js'));
R('order-new', '/orders/new', 'Нове замовлення', 'Продажі', () => import('./pages/order-new.js'));
R('orders', '/orders', 'Замовлення', 'Продажі', () => import('./pages/orders.js'));
R('customers', '/customers', 'Клієнти', 'Продажі', () => import('./pages/customers.js'));
R('products', '/products', 'Товари', 'Каталог', () => import('./pages/products.js'));
R('catalog', '/catalog', 'Категорії та лінійки', 'Каталог', () => import('./pages/catalog.js'));
R('pricing', '/pricing', 'Націнки', 'Каталог', () => import('./pages/pricing.js'));
R('import', '/import', 'Імпорт прайсу', 'Каталог', () => import('./pages/import.js'));
R('activity', '/activity', 'Журнал дій', 'Система', () => import('./pages/activity.js'));
R('settings', '/settings', 'Налаштування', 'Система', () => import('./pages/settings.js'));

let mounted = false;
let renderSeq = 0;
let cleanup = null;
let expiredNotified = false;

function runCleanup() {
  if (cleanup) { try { cleanup(); } catch { /* page already gone */ } cleanup = null; }
}

async function renderRoute() {
  if (!mounted) return;
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  const m = match(path);
  closeAll();
  shell.closeNav();
  runCleanup();
  const host = shell.host();
  const page = document.createElement('div');
  page.className = 'page';
  host.replaceChildren(page);
  window.scrollTo(0, 0);
  if (!m) {
    shell.setActive(null, 'Сторінку не знайдено');
    document.title = 'Сторінку не знайдено';
    setHTML(page, emptyState({ ic: 'circle-alert', title: 'Сторінку не знайдено', text: 'Можливо, посилання застаріло.',
      action: html`<a class="btn btn-primary" href="#/">${icon('layout-dashboard', { size: 16 })}На дашборд</a>` }));
    return;
  }
  shell.setActive(m.meta.key, m.meta.title, m.meta.group);
  document.title = `${m.meta.title} · ${store.settings.shop_name || 'Адмін-панель'}`;
  const ac = new AbortController();
  cleanup = () => ac.abort();
  let mod;
  try {
    mod = await m.load();
  } catch {
    if (seq === renderSeq) setHTML(page, errorState('Не вдалося завантажити розділ. Оновіть сторінку браузера.'));
    return;
  }
  if (seq !== renderSeq) return;
  const dispose = mod.default({ root: page, query, params: m.params, signal: ac.signal, title: m.meta.title });
  cleanup = () => { ac.abort(); if (typeof dispose === 'function') dispose(); };
  host.focus({ preventScroll: true });
}

export async function refreshBadges() {
  try {
    const d = await api('/api/orders', { query: { status: 'new', limit: 1 } });
    shell.setBadge('newOrders', d.total);
  } catch { /* badge is optional */ }
}

async function showLogin() {
  mounted = false;
  runCleanup();
  closeAll();
  shell.unmount();
  document.body.classList.add('is-guest');
  const { default: login } = await import('./pages/login.js');
  login(root, { onSuccess: () => { expiredNotified = false; boot(); } });
}

function logout() {
  auth.clear();
  cart.clear();
  clearMediaCache();
  store.brands = null;
  store.markups = null;
  history.replaceState(null, '', '#/');
  showLogin();
  toast.info('Ви вийшли з адмін-панелі');
}

async function boot() {
  if (!auth.token) { showLogin(); return; }
  document.body.classList.remove('is-guest');
  setHTML(root, html`<div class="login"><div class="spinner" role="status" aria-label="Завантаження"></div></div>`);
  try {
    const [me, settings] = await Promise.all([api('/api/auth/me'), api('/api/settings')]);
    store.me = me;
    store.settings = settings;
  } catch (e) {
    if (e.status === 401) return;
    setHTML(root, html`<div class="login"><div class="login-card">${errorState(e.message)}</div></div>`);
    root.querySelector('[data-retry]')?.addEventListener('click', boot);
    return;
  }
  shell.mount(root, { onLogout: logout });
  mounted = true;
  refreshBadges();
  renderRoute();
}

setOnExpired(() => {
  if (expiredNotified) return;
  expiredNotified = true;
  toast.info('Сесія завершилася. Увійдіть знову.');
  showLogin();
});
bus.on('orders:changed', refreshBadges);
window.addEventListener('hashchange', renderRoute);
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'AbortError' || e.reason?.status === 401) e.preventDefault();
});
export { navigate };
boot();
