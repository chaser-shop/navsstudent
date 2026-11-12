// Точка входу: вхід, каркас (бічне меню / нижні вкладки), маршрутизація, синхронізація, глибокі посилання.

import { api, getToken, setToken, setUnauthorizedHandler } from './core/api.js';
import { store, sync, loadCache, clearSession, on, emit, isAdmin, canModerate, markAnswered, setUser } from './core/store.js';
import { html, setHTML, $ } from './core/dom.js';
import { icon } from './core/icons.js';
import { toast, closeAllModals, avatar, loading, errorState, emptyState } from './core/ui.js';
import { initChartTooltips } from './core/charts.js';

const app = document.getElementById('app');

// ───────── Маршрути ─────────
const ROUTES = [
  { path: '/', title: 'Головна', view: () => import('./views/home.js') },
  { path: '/schedule', title: 'Розклад', view: () => import('./views/schedule.js') },
  { path: '/homework', title: 'Домашнє', view: () => import('./views/homework.js') },
  { path: '/progress', title: 'Успішність', view: () => import('./views/progress.js') },
  { path: '/progress/:tab', title: 'Успішність', view: () => import('./views/progress.js') },
  { path: '/profile', title: 'Профіль', view: () => import('./views/profile.js') },
  { path: '/admin', title: 'Огляд', role: 'admin', modHome: true, view: () => import('./views/admin/dashboard.js') },
  { path: '/admin/analytics', title: 'Аналітика', role: 'admin', view: () => import('./views/admin/analytics.js') },
  { path: '/admin/students', title: 'Студенти', role: 'admin', view: () => import('./views/admin/students.js') },
  { path: '/admin/students/:id', title: 'Студент', role: 'admin', back: '/admin/students', view: () => import('./views/admin/student.js') },
  { path: '/admin/changes', title: 'Зміни балів', role: 'admin', view: () => import('./views/admin/changes.js') },
  { path: '/admin/sync', title: 'Синхронізація', role: 'admin', view: () => import('./views/admin/sync.js') },
  { path: '/admin/rating', title: 'Рейтинг і групи', role: 'admin', view: () => import('./views/admin/rating.js') },
  { path: '/admin/users', title: 'Акаунти й пристрої', role: 'admin', view: () => import('./views/admin/users.js') },
  { path: '/admin/moderation', title: 'Модерація', role: 'mod', view: () => import('./views/admin/moderation.js') },
  { path: '/admin/schedule', title: 'Розклад і предмети', role: 'mod', view: () => import('./views/admin/schedule.js') },
  { path: '/admin/grades', title: 'Оцінки', role: 'admin', view: () => import('./views/admin/grades.js') },
  { path: '/admin/notify', title: 'Розсилка', role: 'admin', view: () => import('./views/admin/notify.js') },
].map((r) => {
  const keys = [];
  const re = new RegExp(`^${r.path.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  return { ...r, re, keys };
});

function match(pathname) {
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

const pendingHomework = () => ((store.data && store.data.homework) || []).filter((h) => h.status === 'pending').length;
const deviceRequests = () => (store.data && store.data.deviceRequests) || 0;

const NAV_MAIN = [
  { href: '/', label: 'Головна', icon: 'home', exact: true },
  { href: '/schedule', label: 'Розклад', icon: 'calendar' },
  { href: '/homework', label: 'Домашнє', icon: 'book' },
  { href: '/progress', label: 'Успішність', icon: 'trending-up' },
];
const NAV_ADMIN = [
  { href: '/admin', label: 'Огляд', icon: 'grid', role: 'admin', exact: true },
  { href: '/admin/analytics', label: 'Аналітика', icon: 'bar-chart', role: 'admin' },
  { href: '/admin/students', label: 'Студенти', icon: 'users', role: 'admin' },
  { href: '/admin/changes', label: 'Зміни балів', icon: 'history', role: 'admin' },
  { href: '/admin/sync', label: 'Синхронізація', icon: 'sheet', role: 'admin' },
  { href: '/admin/rating', label: 'Рейтинг і групи', icon: 'layers', role: 'admin' },
  { href: '/admin/users', label: 'Акаунти й пристрої', icon: 'shield', role: 'admin', badge: deviceRequests },
  { href: '/admin/moderation', label: 'Модерація', icon: 'clipboard', role: 'mod', badge: pendingHomework },
  { href: '/admin/schedule', label: 'Розклад і предмети', icon: 'calendar-cog', role: 'mod' },
  { href: '/admin/grades', label: 'Оцінки', icon: 'file-check', role: 'admin' },
  { href: '/admin/notify', label: 'Розсилка', icon: 'megaphone', role: 'admin' },
];
const allowed = (item) => !item.role || (item.role === 'admin' ? isAdmin() : canModerate());
const isActive = (item, path) => (item.exact ? path === item.href : path === item.href || path.startsWith(`${item.href}/`));
const adminHome = () => (isAdmin() ? '/admin' : '/admin/moderation');

export const adminNavItems = () => NAV_ADMIN.filter(allowed);

const roleLabel = (u) => (u.isAdmin ? 'Адміністратор' : u.role === 'starosta' ? 'Староста' : u.role === 'deputy' ? 'Заступник старости' : 'Студент');

// ───────── Каркас ─────────
function renderShell() {
  setHTML(app, html`<div class="shell">
    <aside class="sidebar" aria-label="Головне меню"></aside>
    <div class="main">
      <header class="topbar"></header>
      <nav class="subnav mobile-only shell-subnav" id="adminNav" aria-label="Розділи керування" hidden></nav>
      <main id="content" class="content" tabindex="-1"></main>
    </div>
    <nav class="tabbar" aria-label="Розділи"></nav>
  </div>`);
  const topbar = $('.topbar', app);
  const onScroll = () => topbar.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
}

function navItem(item, path) {
  const n = item.badge ? item.badge() : 0;
  return html`<a class="nav-item ${isActive(item, path) ? 'active' : ''}" href="${item.href}" ${isActive(item, path) ? html`aria-current="page"` : ''}>
    ${icon(item.icon)}<span>${item.label}</span>${n ? html`<span class="count" aria-label="${n} нових">${n}</span>` : ''}
  </a>`;
}

function updateChrome(path, route) {
  const u = store.user;
  if (!u) return;
  const sidebar = $('.sidebar', app);
  if (!sidebar) return;
  const admin = NAV_ADMIN.filter(allowed);
  setHTML(sidebar, html`
    <a class="brand" href="/">
      <span class="brand-mark">${icon('cap')}</span>
      <span><span class="brand-name">Щоденник</span><br><span class="brand-sub">${u.group || 'Електронний журнал'}</span></span>
    </a>
    <nav class="nav-group" aria-label="Навчання">
      <div class="nav-label">Навчання</div>
      ${NAV_MAIN.map((i) => navItem(i, path))}
    </nav>
    ${admin.length ? html`<nav class="nav-group" aria-label="Керування">
      <div class="nav-label">Керування</div>
      ${admin.map((i) => navItem(i, path))}
    </nav>` : ''}
    <div class="sidebar-foot">
      <a class="me-card" href="/profile" ${path === '/profile' ? html`aria-current="page"` : ''}>
        ${avatar(u.fullName)}
        <span class="who"><span class="name">${u.fullName}</span><span class="role">${roleLabel(u)}</span></span>
      </a>
    </div>`);

  const back = route && route.back;
  setHTML($('.topbar', app), html`
    ${back ? html`<a class="icon-btn" href="${back}" aria-label="Назад">${icon('arrow-left')}</a>` : html`<a class="brand" href="/" aria-label="Головна"><span class="brand-mark">${icon('cap')}</span></a>`}
    <div class="topbar-title">${document.title.replace(/ · Щоденник$/, '')}</div>
    <a href="/profile" class="icon-btn" aria-label="Профіль">${avatar(u.fullName, 'sm')}</a>`);

  const tabs = [...NAV_MAIN];
  if (canModerate()) {
    const badge = () => (isAdmin() ? deviceRequests() : 0) + pendingHomework();
    tabs.push({ href: adminHome(), match: '/admin', label: 'Керування', icon: 'shield', badge });
  } else {
    tabs.push({ href: '/profile', label: 'Профіль', icon: 'user' });
  }
  setHTML($('.tabbar', app), tabs.map((t) => {
    const active = t.match ? path.startsWith(t.match) : isActive(t, path);
    const n = t.badge ? t.badge() : 0;
    return html`<a class="tab ${active ? 'active' : ''}" href="${t.href}" ${active ? html`aria-current="page"` : ''}>
      ${icon(t.icon)}<span>${t.label}</span>${n ? html`<span class="dot" aria-label="Є нові"></span>` : ''}
    </a>`;
  }));

  // На телефоні й планшеті бічного меню немає — розділи керування показуємо смугою над сторінкою.
  const adminNav = $('#adminNav', app);
  if (adminNav) {
    const show = path.startsWith('/admin') && admin.length > 1;
    adminNav.hidden = !show;
    if (show) {
      setHTML(adminNav, admin.map((i) => {
        const n = i.badge ? i.badge() : 0;
        return html`<a href="${i.href}" class="${isActive(i, path) ? 'active' : ''}" ${isActive(i, path) ? html`aria-current="page"` : ''}>${i.label}${n ? html`<span class="count">${n}</span>` : ''}</a>`;
      }));
      const active = adminNav.querySelector('a.active');
      if (active) adminNav.scrollLeft = Math.max(0, active.offsetLeft - 16);
    }
  }
}

function setTitle(title) {
  document.title = title ? `${title} · Щоденник` : 'Щоденник';
  const el = $('.topbar-title', app);
  if (el) el.textContent = title || 'Щоденник';
}

// ───────── Рендер маршруту ─────────
let current = { token: 0, cleanup: [] };

async function renderRoute({ scroll = true } = {}) {
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  for (const fn of current.cleanup) { try { fn(); } catch (e) { console.error(e); } }
  const token = current.token + 1;
  current = { token, cleanup: [] };
  closeAllModals();
  const root = $('#content', app);
  if (!root) return;
  root.style.animation = 'none';
  void root.offsetHeight;
  root.style.animation = '';
  const found = match(path);
  const route = found && found.route;
  setTitle(route ? route.title : 'Сторінку не знайдено');
  updateChrome(path, route);
  if (scroll) window.scrollTo(0, 0);
  if (!route) {
    setHTML(root, emptyState({ icon: 'search', title: 'Сторінку не знайдено', text: 'Можливо, посилання застаріло.', action: html`<a class="btn btn-primary" href="/">На головну</a>` }));
    return;
  }
  if (route.role === 'admin' && !isAdmin()) {
    if (route.modHome && canModerate()) { navigate('/admin/moderation', { replace: true }); return; }
    setHTML(root, emptyState({ icon: 'lock', title: 'Немає доступу', text: 'Цей розділ доступний лише адміністратору.', action: html`<a class="btn btn-primary" href="/">На головну</a>` }));
    return;
  }
  if (route.role === 'mod' && !canModerate()) {
    setHTML(root, emptyState({ icon: 'lock', title: 'Немає доступу', text: 'Цей розділ доступний адміністратору, старості та заступнику.', action: html`<a class="btn btn-primary" href="/">На головну</a>` }));
    return;
  }
  const ctx = {
    root, path, params: found.params, query: url.searchParams, route,
    navigate, setTitle,
    isActive: () => current.token === token,
    onCleanup: (fn) => current.cleanup.push(fn),
    refresh: () => renderRoute({ scroll: false }),
  };
  setHTML(root, loading());
  try {
    const mod = await route.view();
    if (!ctx.isActive()) return;
    // Індикатор лишається, доки сторінка не відмалює себе (setHTML замінює його вмістом).
    await mod.default(ctx);
  } catch (e) {
    if (!ctx.isActive()) return;
    console.error(e);
    setHTML(root, errorState(e));
    const retry = root.querySelector('[data-action="retry"]');
    if (retry) retry.addEventListener('click', () => renderRoute({ scroll: false }));
  }
}

export function navigate(to, { replace = false } = {}) {
  const target = new URL(to, location.origin);
  const same = target.pathname + target.search === location.pathname + location.search;
  if (replace || same) history.replaceState({}, '', target.pathname + target.search + target.hash);
  else history.pushState({}, '', target.pathname + target.search + target.hash);
  renderRoute({ scroll: !same });
}

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('download') || a.dataset.external != null) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || /\.[a-z0-9]+$/i.test(url.pathname)) return;
  if (!store.user) return;
  e.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', () => { if (store.user) renderRoute({ scroll: false }); });

// ───────── Глибокі посилання (зі сповіщень і старих адрес ?tab=…) ─────────
const LEGACY_TABS = {
  today: '/', schedule: '/schedule', homework: '/homework', rating: '/progress/rating', grades: '/admin/grades',
  moderation: '/admin/moderation', settings: '/profile', users: '/admin/users', notify: '/admin/notify', admin: '/admin',
};
function processDeepLink(href, { fromPush = false } = {}) {
  const url = new URL(href, location.origin);
  const q = url.searchParams;
  // Старі адреси зі сповіщень мають вигляд «/?tab=…», «/?lesson=…» — лише на головному шляху.
  if (url.pathname !== '/') return fromPush ? navigate(url.pathname + url.search) : renderRoute();
  if (q.has('lesson')) return navigate(`/schedule?lesson=${encodeURIComponent(q.get('lesson'))}${q.get('join') ? '&join=1' : ''}`, { replace: !fromPush });
  if (q.has('homework')) return navigate(`/homework?lesson=${encodeURIComponent(q.get('homework'))}&new=1`, { replace: !fromPush });
  if (q.has('answered')) {
    markAnswered(q.get('answered'));
    toast('Позначено: на цю пару нічого не задали.', { type: 'success' });
    return navigate('/', { replace: !fromPush });
  }
  if (q.has('tab')) return navigate(LEGACY_TABS[q.get('tab')] || '/', { replace: !fromPush });
  if (fromPush) return navigate(url.pathname + url.search);
  return renderRoute();
}

// ───────── Сеанс ─────────
let timers = [];
function startTimers() {
  stopTimers();
  timers.push(setInterval(() => { if (document.visibilityState === 'visible') sync().catch(() => {}); }, 120000));
}
function stopTimers() { timers.forEach(clearInterval); timers = []; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.user && Date.now() - store.lastSync > 30000) sync().catch(() => {});
});

let started = false;
async function startApp() {
  if (store.user && store.user.hasPassword === false) { showPasswordGate(); return; }
  if (!started || !$('.shell', app)) {
    renderShell();
    started = true;
    startTimers();
    processDeepLink(location.href);
    // Якщо сповіщення вже дозволено, прив’язуємо підписку цього пристрою до поточного акаунта.
    import('./views/profile.js').then((m) => m.ensurePushBinding && m.ensurePushBinding()).catch(() => {});
  } else {
    renderRoute({ scroll: false });
  }
}

// Подія «встановити застосунок» приходить один раз — зберігаємо її для сторінки профілю.
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installPrompt = e; });

async function showLogin(message) {
  started = false;
  stopTimers();
  closeAllModals();
  const { renderLogin } = await import('./views/login.js');
  renderLogin(app, {
    message,
    onSuccess: async ({ token, user }) => {
      setToken(token);
      setUser(user);
      try { await sync(); } catch { /* показуємо з тим, що є */ }
      if (location.pathname === '/login') history.replaceState({}, '', '/');
      startApp();
    },
  });
}

async function showPasswordGate() {
  started = false;
  const { renderPasswordGate } = await import('./views/login.js');
  renderPasswordGate(app, {
    user: store.user,
    onDone: async ({ token, user }) => {
      setToken(token);
      setUser(user);
      sync().catch(() => {});
      toast('Пароль збережено. Тепер ваш акаунт захищено.', { type: 'success' });
      startApp();
    },
    onSignOut: () => signOut(),
  });
}

async function unsubscribePush() {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* сповіщення недоступні */ }
}

async function signOut(message) {
  await unsubscribePush();
  try { if (getToken()) await api('POST', '/api/auth/logout', {}); } catch { /* сеанс уже недійсний */ }
  clearSession();
  history.replaceState({}, '', '/');
  showLogin(message);
}

on('signout', (message) => signOut(message));
on('user', () => {
  if (!started) return;
  if (store.user && store.user.hasPassword === false) { showPasswordGate(); return; }
  updateChrome(location.pathname, (match(location.pathname) || {}).route);
});
on('sync', () => { if (started) updateChrome(location.pathname, (match(location.pathname) || {}).route); });

setUnauthorizedHandler(() => {
  clearSession();
  showLogin('Сеанс завершено. Увійдіть знову.');
});

// ───────── Service worker ─────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'sync' && store.user) sync().catch(() => {});
    if (d.type === 'route' && d.url && store.user) processDeepLink(d.url, { fromPush: true });
  });
}

// ───────── Запуск ─────────
async function boot() {
  initChartTooltips();
  if (!getToken()) { showLogin(); return; }
  const cached = loadCache();
  if (cached) startApp();
  else setHTML(app, html`<div class="auth"><div class="auth-main">${loading('Відкриваємо щоденник…')}</div></div>`);
  try {
    await sync();
    if (!cached) startApp();
  } catch (e) {
    if (e.status === 401) return;
    if (!cached) {
      setHTML(app, html`<div class="auth"><div class="auth-main"><div class="auth-card">${errorState(e)}</div></div></div>`);
      app.querySelector('[data-action="retry"]').addEventListener('click', () => boot());
    }
  }
}

emit('boot');
boot();
