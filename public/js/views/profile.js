// Профіль: обліковий запис, сповіщення (Web Push), вигляд, застосунок, безпека (зміна пароля) і вихід.

import { api, ApiError, LS, setToken } from '../core/api.js';
import { html, setHTML, $, actions, on, busy } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { store, sync, on as onStore, setUser, emit } from '../core/store.js';
import { relTime } from '../core/format.js';
import { avatar, confirmDialog, pageHead, switchInput, toast, toastError, toastSuccess } from '../core/ui.js';

const roleLabel = (u) => (u.isAdmin ? 'Адміністратор' : u.role === 'starosta' ? 'Староста' : u.role === 'deputy' ? 'Заступник старости' : 'Студент');
const ukText = (e, fallback) => (e && /[а-яіїєґ]/i.test(e.message || '') ? e.message : fallback);

// ───────── Налаштування сповіщень (дзеркало на пристрої, ключ settings — як у старій версії) ─────────

const DEFAULTS = { notificationsEnabled: true, leadMinutes: 2, askHomework: true, autoOpenLink: true, notifyHomework: true, notifyProgress: true };
const clampLead = (n) => Math.min(15, Math.max(1, Math.round(Number(n)) || DEFAULTS.leadMinutes));
const settings = () => {
  const s = { ...DEFAULTS, ...(LS.get('settings') || {}) };
  s.leadMinutes = clampLead(s.leadMinutes);
  return s;
};
const saveSettings = (s) => LS.set('settings', s);
const pushSettings = () => {
  const s = settings();
  return { notificationsEnabled: s.notificationsEnabled, leadMinutes: s.leadMinutes, askHomework: s.askHomework, notifyHomework: s.notifyHomework, notifyProgress: s.notifyProgress };
};

// ───────── Web Push ─────────

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

/** Службовий процес може так і не стати активним (наприклад, без захищеного з’єднання) — не чекаємо вічно. */
function swReady() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Браузер не підготував службу сповіщень. Оновіть сторінку й спробуйте ще раз.')), 10000)),
  ]);
}
async function getSub() {
  if (!pushSupported()) return null;
  const reg = await swReady();
  return reg.pushManager.getSubscription();
}

function b64ToU8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Чи підписку створено з поточним ключем сервера. Після зміни ключів стара підписка отримує від push-сервісу 403. */
function sameKey(sub, publicKey) {
  try {
    const k = sub.options && sub.options.applicationServerKey;
    if (!k) return true;
    const a = new Uint8Array(k);
    const b = b64ToU8(publicKey);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  } catch { return true; }
}

async function subscribePush(force = false) {
  const reg = await swReady();
  const cfg = await api('GET', '/api/push/config');
  let sub = await reg.pushManager.getSubscription();
  if (sub && (force || !sameKey(sub, cfg.publicKey))) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(cfg.publicKey) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), settings: pushSettings(), key: cfg.publicKey });
  return sub;
}

/** Якщо дозвіл уже є — тихо прив’язуємо підписку цього пристрою до поточного акаунта. */
export async function ensurePushBinding() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try { await subscribePush(); } catch { /* не критично */ }
}

let settingsTimer = null;
function pushSettingsChanged() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    try {
      const sub = await getSub();
      if (sub) await api('PUT', '/api/push/settings', { endpoint: sub.endpoint, settings: pushSettings() });
    } catch (e) {
      if (e && e.status === 404) { try { await subscribePush(); } catch { /* підтягнеться під час наступного входу */ } }
    }
  }, 500);
}

// «Встановити застосунок»: подія приходить лише раз, тому слухаємо її одразу після завантаження модуля.
let installEvent = window.__installPrompt || null;
let redrawApp = () => {};
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; redrawApp(); });
window.addEventListener('appinstalled', () => { installEvent = null; redrawApp(); });

let bound = false; // прив’язку підписки перевіряємо раз за сеанс

export default async function view(ctx) {
  const root = ctx.root;
  if (!store.data && !store.user) await sync();
  if (!ctx.isActive()) return;

  const push = {
    supported: pushSupported(),
    permission: 'Notification' in window ? Notification.permission : 'denied',
    subscribed: false, ready: false, msg: null,
  };
  const sec = (name) => $(`[data-sec="${name}"]`, root);

  // ───────── Обліковий запис ─────────
  function drawAccount() {
    const u = store.user;
    setHTML(sec('account'), html`<section class="card"><div class="card-body">
      <div class="st-account">
        ${avatar(u.fullName, 'lg')}
        <div class="grow">
          <h2 class="st-name">${u.fullName}</h2>
          <div class="flex wrap mt1"><span class="badge accent">${roleLabel(u)}</span>${u.group ? html`<span class="badge outline">${icon('users')}${u.group}</span>` : ''}</div>
        </div>
      </div>
      <hr class="divider">
      <dl class="kv">
        <dt>Група</dt><dd>${u.group || 'Не вказано'}</dd>
        <dt>Запис у рейтингу</dt><dd>${u.studentName || 'Ще не прив’язано — зверніться до адміністратора'}</dd>
      </dl>
    </div></section>`);
  }

  // ───────── Сповіщення ─────────
  function drawPush() {
    const s = settings();
    const p = push;
    const iosHint = isIOS() && !isStandalone();
    const howTo = isIOS()
      ? 'Відкрийте «Налаштування» iPhone → «Сповіщення» → «Щоденник» і ввімкніть «Дозволити сповіщення».'
      : 'Натисніть значок замка ліворуч від адреси сайту → «Сповіщення» → «Дозволити», а потім оновіть сторінку.';
    const row = (title, desc, control, extra = '') => html`<div class="settings-row ${extra}"><div class="grow"><div class="title">${title}</div>${desc ? html`<div class="desc">${desc}</div>` : ''}</div>${control}</div>`;
    const sw = (name, label, disabled = false) => switchInput({ name, checked: !!s[name], label, disabled });
    const enabled = p.supported && p.permission !== 'denied' && p.subscribed;
    const muted = !s.notificationsEnabled;

    let top;
    if (!p.supported) {
      top = iosHint
        ? html`<div class="alert info">${icon('smartphone')}<div class="grow"><strong>Сповіщення на iPhone й iPad</strong>Відкрийте щоденник у Safari, натисніть «Поділитися» → «На початковий екран» і запускайте його з іконки — лише так iOS дозволяє вебзастосункам надсилати сповіщення.</div></div>`
        : html`<div class="alert info">${icon('info')}<div class="grow">Цей браузер не підтримує сповіщення. Спробуйте актуальну версію Chrome, Edge, Firefox або Safari.</div></div>`;
    } else if (p.permission === 'denied') {
      top = html`<div class="alert warning">${icon('bell-off')}<div class="grow"><strong>Сповіщення заборонено</strong>Дозвольте їх у налаштуваннях пристрою чи браузера й поверніться сюди. ${howTo}</div></div>`;
    } else if (!p.ready) {
      top = html`<div class="muted small flex"><span class="spinner" aria-hidden="true"></span> Перевіряємо стан сповіщень…</div>`;
    } else if (!p.subscribed) {
      top = html`<p class="muted small">Нагадування про пари, запитання «Що задали?» після пари, нове домашнє й щоденний підсумок прогресу — навіть коли щоденник закрито. Дозвіл і підписка діють окремо для кожного пристрою.</p>
        <div class="btn-row"><button type="button" class="btn btn-primary" data-action="push-on">${icon('bell')} Увімкнути сповіщення</button></div>`;
    } else {
      top = html`<div class="btn-row">
        <button type="button" class="btn btn-secondary" data-action="push-test">${icon('send')} Надіслати тестове сповіщення</button>
        <button type="button" class="btn btn-ghost" data-action="push-off">${icon('bell-off')} Вимкнути на цьому пристрої</button>
      </div>`;
    }

    setHTML(sec('push'), html`<section class="card" aria-labelledby="st-push-h">
      <div class="card-head"><h2 id="st-push-h">Сповіщення</h2>${enabled ? html`<span class="badge success">${icon('check')}Увімкнено</span>` : ''}</div>
      <div class="card-body stack sm">${top}${p.msg ? html`<div class="alert ${p.msg.tone}" role="status">${icon(p.msg.tone === 'success' ? 'check-circle' : p.msg.tone === 'danger' ? 'alert' : 'info')}<div class="grow">${p.msg.text}</div></div>` : ''}</div>
      ${enabled ? html`<div class="st-settings">
        ${row('Усі сповіщення', 'Головний перемикач для цього пристрою. Вимкніть, щоб призупинити всі сповіщення, не відключаючи пристрій.', sw('notificationsEnabled', 'Усі сповіщення'))}
        ${row(html`Нагадувати про пару за <span data-role="lead-title">${s.leadMinutes}</span> хв`, 'Сповіщення надійде перед початком пари.', html`<div class="st-stepper" role="group" aria-label="Скільки хвилин до початку нагадувати">
          <button type="button" class="icon-btn sm" data-action="lead-dec" aria-label="Менше хвилин" ${s.leadMinutes <= 1 || muted ? 'disabled' : ''}>${icon('minus')}</button>
          <output class="num" data-role="lead-out" aria-live="polite">${s.leadMinutes}</output>
          <button type="button" class="icon-btn sm" data-action="lead-inc" aria-label="Більше хвилин" ${s.leadMinutes >= 15 || muted ? 'disabled' : ''}>${icon('plus')}</button>
        </div>`)}
        ${row('Питати «Що задали?» після пари', 'Коротке нагадування записати домашнє, коли пара закінчилась.', sw('askHomework', 'Питати «Що задали?» після пари', muted))}
        ${row('Нове домашнє завдання', 'Повідомлення, коли підтверджено нове завдання.', sw('notifyHomework', 'Нове домашнє завдання', muted))}
        ${row('Щоденний підсумок прогресу', 'Вечірній підсумок змін ваших балів і місця в рейтингу.', sw('notifyProgress', 'Щоденний підсумок прогресу', muted))}
      </div>` : ''}
      <div class="st-settings">
        ${row('Одразу відкривати посилання на пару', 'Коли ви відкриваєте пару зі сповіщення, посилання на заняття відкривається автоматично. Діє лише на цьому пристрої.', sw('autoOpenLink', 'Одразу відкривати посилання на пару'))}
      </div>
    </section>`);
  }

  async function refreshPush() {
    push.supported = pushSupported();
    push.permission = 'Notification' in window ? Notification.permission : 'denied';
    try { push.subscribed = !!(await getSub()); } catch { push.subscribed = false; }
    push.ready = true;
    if (ctx.isActive()) drawPush();
  }

  async function enablePush() {
    push.msg = null;
    if (!pushSupported()) {
      toast(isIOS() && !isStandalone() ? 'На iPhone спершу додайте щоденник на екран «Додому» й відкрийте його з іконки.' : 'Цей браузер не підтримує сповіщення.');
      return;
    }
    let perm = 'denied';
    try { perm = await Notification.requestPermission(); } catch { /* вважаємо відмовою */ }
    if (perm !== 'granted') {
      // Після прямої відмови екран і так покаже, як дозволити сповіщення; нагадуємо лише про закритий запит.
      if (perm !== 'denied') push.msg = { tone: 'warning', text: 'Дозвіл не надано — сповіщення не ввімкнено. Спробуйте ще раз і натисніть «Дозволити».' };
      await refreshPush();
      return;
    }
    try {
      saveSettings({ ...settings(), notificationsEnabled: true });
      await subscribePush();
      toastSuccess('Сповіщення увімкнено.');
    } catch (e) {
      push.msg = { tone: 'danger', text: `Не вдалося увімкнути сповіщення. ${e instanceof ApiError ? e.message : 'Перевірте з’єднання та дозвіл у налаштуваннях браузера й спробуйте ще раз.'}` };
    }
    await refreshPush();
  }

  async function disablePush() {
    push.msg = null;
    try {
      const sub = await getSub();
      if (sub) {
        await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      toast('Сповіщення на цьому пристрої вимкнено.');
    } catch { /* підписки вже немає */ }
    await refreshPush();
  }

  async function testPush() {
    push.msg = null;
    const run = async () => {
      const sub = await getSub();
      if (!sub) throw new Error('Спершу увімкніть сповіщення.');
      await api('PUT', '/api/push/settings', { endpoint: sub.endpoint, settings: pushSettings() });
      await api('POST', '/api/push/test', { endpoint: sub.endpoint });
    };
    try {
      try {
        await run();
      } catch (e) {
        // Підписки немає на сервері або її відхилив push-сервіс — створюємо заново й пробуємо ще раз.
        if (e.status === 404 || e.code === 'push_rejected') { await subscribePush(true); await run(); } else throw e;
      }
      push.msg = { tone: 'success', text: 'Тестове сповіщення надіслано — воно має з’явитися за кілька секунд.' };
    } catch (e) {
      if (e && e.code === 'push_rejected') {
        const code = e.data && e.data.status ? ` (код ${e.data.status})` : '';
        push.msg = {
          tone: 'danger',
          text: `Push-сервіс браузера відхилив сповіщення${code}. Вимкніть сповіщення на цьому пристрої та ввімкніть знову. Якщо це не допоможе, зверніться до адміністратора.${store.user && store.user.isAdmin ? ' Для адміністратора: перевірте змінну VAPID_SUBJECT на сервері — вона має містити справжню адресу пошти.' : ''}`,
        };
      } else {
        push.msg = { tone: 'danger', text: ukText(e, 'Не вдалося надіслати тестове сповіщення. Спробуйте ще раз.') };
      }
    }
    await refreshPush();
  }

  function stepLead(delta) {
    const s = settings();
    const n = clampLead(s.leadMinutes + delta);
    saveSettings({ ...s, leadMinutes: n });
    pushSettingsChanged();
    root.querySelectorAll('[data-role="lead-title"], [data-role="lead-out"]').forEach((e) => { e.textContent = String(n); });
    const dec = $('[data-action="lead-dec"]', root);
    const inc = $('[data-action="lead-inc"]', root);
    if (dec) dec.disabled = n <= 1;
    if (inc) inc.disabled = n >= 15;
  }

  // ───────── Вигляд ─────────
  const THEMES = [['auto', 'Авто', 'monitor'], ['light', 'Світла', 'sun'], ['dark', 'Темна', 'moon']];
  function drawTheme() {
    const saved = LS.get('theme', 'auto');
    const cur = saved === 'light' || saved === 'dark' ? saved : 'auto';
    setHTML(sec('theme'), html`<section class="card"><div class="card-head"><h2>Вигляд</h2></div><div class="card-body stack sm">
      <div class="segmented st-theme" role="group" aria-label="Тема оформлення">${THEMES.map(([k, label, ic]) => html`<button type="button" data-action="theme" data-mode="${k}" aria-pressed="${k === cur ? 'true' : 'false'}">${icon(ic)}${label}</button>`)}</div>
      <p class="help">«Авто» повторює тему вашого пристрою. Вибір зберігається на цьому пристрої.</p>
    </div></section>`);
  }

  // ───────── Застосунок ─────────
  function drawApp() {
    const iosInstall = isIOS() && !isStandalone();
    const last = store.lastSync ? relTime(store.lastSync) : '';
    setHTML(sec('app'), html`<section class="card"><div class="card-head"><h2>Застосунок</h2></div>
      ${installEvent ? html`<div class="settings-row"><div class="grow"><div class="title">Встановити застосунок</div><div class="desc">Щоденник відкриватиметься з іконки, як звичайний застосунок.</div></div><button type="button" class="btn btn-soft btn-sm" data-action="install">${icon('download')} Встановити</button></div>`
    : isStandalone() ? html`<div class="settings-row"><div class="grow"><div class="title">Застосунок встановлено</div><div class="desc">Щоденник запущено з головного екрана.</div></div><span class="badge success">${icon('check')}Готово</span></div>`
      : iosInstall ? html`<div class="settings-row"><div class="grow"><div class="title">Встановити на iPhone чи iPad</div><div class="desc">У Safari натисніть «Поділитися» → «На початковий екран».</div></div>${icon('smartphone')}</div>`
        : html`<div class="settings-row"><div class="grow"><div class="title">Встановлення</div><div class="desc">Щоб додати щоденник на пристрій, скористайтеся меню браузера: «Встановити застосунок» чи «Додати на головний екран».</div></div></div>`}
      <div class="settings-row"><div class="grow"><div class="title">Оновити дані</div><div class="desc">${last ? `Востаннє оновлено: ${last}.` : 'Завантажити свіжий розклад, домашнє й бали.'}</div></div><button type="button" class="btn btn-secondary btn-sm" data-action="refresh">${icon('refresh')} Оновити</button></div>
      <div class="settings-row"><div class="grow"><div class="title">Поділитися щоденником</div><div class="desc">Надішліть одногрупникам посилання на сайт.</div></div><button type="button" class="btn btn-secondary btn-sm" data-action="share">${icon('share')} Поділитися</button></div>
    </section>`);
  }
  redrawApp = () => { if (ctx.isActive()) drawApp(); };
  ctx.onCleanup(() => { redrawApp = () => {}; });

  // ───────── Безпека ─────────
  function passwordField(name, id, label, autocomplete) {
    return html`<div class="field"><label class="label" for="${id}">${label}</label>
      <div class="input-group st-pw">${icon('lock')}<input class="input" id="${id}" name="${name}" type="password" autocomplete="${autocomplete}" maxlength="128" autocapitalize="none" spellcheck="false">
        <button type="button" class="icon-btn" data-action="toggle-pw" aria-label="Показати пароль" aria-pressed="false">${icon('eye')}</button></div></div>`;
  }
  function drawSecurity() {
    const has = store.user && store.user.hasPassword !== false;
    setHTML(sec('security'), html`<section class="card"><div class="card-head"><h2>Безпека</h2></div>
      <form class="card-body" id="st-pw-form" novalidate>
        <p class="muted small mb3">Пароль має містити щонайменше 8 символів і не складатися лише з цифр. Після зміни на інших пристроях доведеться увійти знову.</p>
        ${has ? passwordField('currentPassword', 'st-pw-cur', 'Поточний пароль', 'current-password') : ''}
        ${passwordField('newPassword', 'st-pw-new', 'Новий пароль', 'new-password')}
        ${passwordField('repeatPassword', 'st-pw-rep', 'Повторіть новий пароль', 'new-password')}
        <div class="error-text mt3" role="alert" data-role="pw-err" hidden></div>
        <div class="btn-row mt4"><button type="submit" class="btn btn-primary">Змінити пароль</button></div>
      </form></section>`);
  }

  async function changePassword(form) {
    const err = $('[data-role="pw-err"]', form);
    const show = (text, field) => {
      err.textContent = text;
      err.hidden = !text;
      form.querySelectorAll('input').forEach((i) => i.removeAttribute('aria-invalid'));
      if (field && form.elements[field]) { form.elements[field].setAttribute('aria-invalid', 'true'); form.elements[field].focus(); }
    };
    const el = form.elements;
    const current = el.currentPassword ? el.currentPassword.value : '';
    const next = el.newPassword.value;
    const repeat = el.repeatPassword.value;
    show('');
    if (el.currentPassword && !current) return show('Введіть поточний пароль.', 'currentPassword');
    if (next.length < 8) return show('Новий пароль має містити щонайменше 8 символів.', 'newPassword');
    if (/^\d+$/.test(next)) return show('Пароль не може складатися лише з цифр.', 'newPassword');
    if (next !== repeat) return show('Паролі не збігаються.', 'repeatPassword');
    if (el.currentPassword && next === current) return show('Новий пароль має відрізнятися від поточного.', 'newPassword');
    await busy($('button[type="submit"]', form), async () => {
      try {
        const res = await api('POST', '/api/auth/password', { currentPassword: current, newPassword: next });
        setToken(res.token);
        setUser(res.user);
        form.reset();
        toastSuccess('Пароль змінено. На інших пристроях потрібно буде увійти знову.');
      } catch (e) {
        show(ukText(e, 'Не вдалося змінити пароль. Спробуйте ще раз.'), e && e.code === 'password_invalid' ? 'currentPassword' : '');
      }
    });
  }

  // ───────── Вихід ─────────
  function drawSignout() {
    setHTML(sec('signout'), html`<button type="button" class="btn btn-danger-soft btn-block btn-lg" data-action="logout">${icon('logout')} Вийти з акаунта</button>`);
  }

  // ───────── Каркас ─────────
  setHTML(root, html`<div class="st-page">
    ${pageHead({ title: 'Профіль', subtitle: 'Акаунт, сповіщення та налаштування застосунку' })}
    <div class="st-cols">
      <div class="st-col">
        <div class="st-o1" data-sec="account"></div>
        <div class="st-o3" data-sec="theme"></div>
        <div class="st-o5" data-sec="app"></div>
      </div>
      <div class="st-col">
        <div class="st-o2" data-sec="push"></div>
        <div class="st-o4" data-sec="security"></div>
        <div class="st-o6" data-sec="signout"></div>
      </div>
    </div>
  </div>`);
  drawAccount();
  drawPush();
  drawTheme();
  drawApp();
  drawSecurity();
  drawSignout();

  ctx.onCleanup(actions(root, {
    'push-on': (btn) => busy(btn, enablePush),
    'push-off': (btn) => busy(btn, disablePush),
    'push-test': (btn) => busy(btn, testPush),
    'lead-dec': () => stepLead(-1),
    'lead-inc': () => stepLead(1),
    theme: (btn) => {
      LS.set('theme', btn.dataset.mode);
      if (window.__applyTheme) window.__applyTheme();
      root.querySelectorAll('[data-action="theme"]').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
    },
    install: async () => {
      const ev = installEvent;
      if (!ev) return;
      ev.prompt();
      await ev.userChoice.catch(() => {});
      installEvent = null;
      drawApp();
    },
    refresh: (btn) => busy(btn, async () => {
      try { await sync(); toastSuccess('Дані оновлено.'); } catch (e) { toastError(e); }
      if (ctx.isActive()) drawApp();
    }),
    share: async () => {
      const url = location.origin;
      if (navigator.share) {
        try { await navigator.share({ title: 'Щоденник студента', text: 'Розклад, домашнє й нагадування про пари', url }); } catch { /* скасовано */ }
        return;
      }
      try { await navigator.clipboard.writeText(url); toastSuccess('Посилання скопійовано.'); } catch { toast(url); }
    },
    'toggle-pw': (btn) => {
      const input = btn.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Сховати пароль' : 'Показати пароль');
      btn.innerHTML = String(icon(show ? 'eye-off' : 'eye'));
    },
    logout: async () => {
      const ok = await confirmDialog({
        title: 'Вийти з акаунта?', text: 'Дані на цьому пристрої буде видалено, на сервері вони лишаться.',
        confirmText: 'Вийти', danger: true,
      });
      if (ok) emit('signout');
    },
  }));
  ctx.onCleanup(on(root, 'change', 'input[role="switch"]', (box) => {
    const s = settings();
    const name = box.name;
    s[name] = box.checked;
    saveSettings(s);
    if (name !== 'autoOpenLink') pushSettingsChanged();
    if (name === 'notificationsEnabled') {
      drawPush();
      const again = $('input[name="notificationsEnabled"]', root);
      if (again) again.focus();
    }
  }));
  ctx.onCleanup(on(root, 'submit', '#st-pw-form', (form, e) => { e.preventDefault(); changePassword(form); }));
  ctx.onCleanup(onStore('user', () => { if (ctx.isActive()) { drawAccount(); drawSecurity(); } }));
  ctx.onCleanup(onStore('sync', () => { if (ctx.isActive()) { drawAccount(); drawApp(); } }));

  // Стан підписки та тиха прив’язка підписки до цього акаунта.
  (async () => {
    await refreshPush();
    if (!bound && ctx.isActive() && push.permission === 'granted') {
      bound = true;
      await ensurePushBinding();
      await refreshPush();
    }
  })();
}
