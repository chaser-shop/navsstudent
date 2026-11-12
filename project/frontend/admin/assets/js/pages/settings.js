// Settings: shop profile (existing API), appearance, password, session, system status.
import { api } from '../core/api.js';
import { bus, prefs, store, theme } from '../core/state.js';
import { html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { avatar, field, setFieldError, setLoading } from '../ui/components.js';
import { shell } from '../ui/shell.js';
import { toast, toastError } from '../ui/toast.js';

const THEMES = [['dark', 'Темна', 'moon'], ['light', 'Світла', 'sun'], ['system', 'Як у системі', 'monitor']];

export default function settings({ root, signal }) {
  const s = store.settings || {};
  setHTML(root, html`<div class="page-header">
      <div><h1 class="page-title">Налаштування</h1><p class="page-desc">Профіль магазину, вигляд, безпека облікового запису</p></div>
    </div>
    <div class="settings-grid">
      <div class="stack" style="gap:16px">
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Магазин</h2><p class="card-sub">Назва показується в бічному меню та заголовку вкладки</p></div></div>
          <form class="card-body stack" data-form="shop" novalidate>
            ${field({ id: 's-name', label: 'Назва магазину', control: html`<input class="input" id="s-name" maxlength="200" autocomplete="organization" value="${s.shop_name || ''}" placeholder="Наприклад, Bob Smoke">` })}
            ${field({ id: 's-contact', label: 'Контакт магазину', hint: 'Телефон, Telegram або e-mail для внутрішнього використання', control: html`<input class="input" id="s-contact" maxlength="200" autocomplete="off" value="${s.contact || ''}">` })}
            <div class="row row-end"><button type="submit" class="btn btn-primary" disabled>${icon('check', { size: 16 })}Зберегти</button></div>
          </form>
        </section>
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Обліковий запис</h2><p class="card-sub">Зміна пароля адміністратора</p></div></div>
          <div class="card-body stack">
            <div class="row" style="gap:12px">${avatar(store.me?.username || '')}<div class="cell-text"><span class="cell-title">${store.me?.username || ''}</span><span class="cell-sub">Адміністратор</span></div></div>
            <form class="stack" data-form="password" novalidate>
              <input type="text" autocomplete="username" value="${store.me?.username || ''}" hidden readonly>
              ${field({ id: 'pw-cur', label: 'Поточний пароль', required: true, control: html`<input class="input" id="pw-cur" type="password" autocomplete="current-password" maxlength="256">` })}
              ${field({ id: 'pw-new', label: 'Новий пароль', required: true, hint: 'Щонайменше 10 символів. Радимо поєднувати літери, цифри й символи.', control: html`<input class="input" id="pw-new" type="password" autocomplete="new-password" maxlength="256">` })}
              ${field({ id: 'pw-rep', label: 'Повторіть новий пароль', required: true, control: html`<input class="input" id="pw-rep" type="password" autocomplete="new-password" maxlength="256">` })}
              <div class="row row-end"><button type="submit" class="btn">${icon('key-round', { size: 16 })}Змінити пароль</button></div>
            </form>
          </div>
        </section>
      </div>
      <div class="stack" style="gap:16px">
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Вигляд</h2><p class="card-sub">Зберігається в цьому браузері</p></div></div>
          <div class="card-body stack">
            <div class="theme-opts" role="group" aria-label="Тема оформлення">
              ${THEMES.map(([k, l, ic]) => html`<button type="button" class="theme-opt" data-theme-opt="${k}" aria-pressed="${String(theme.get() === k)}">${icon(ic, { size: 20 })}${l}</button>`)}
            </div>
            <label class="switch hide-mobile"><input type="checkbox" id="s-compact" ${prefs.get('collapsed', false) ? 'checked' : ''}><span>Компактне бічне меню (лише значки)</span></label>
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Сесія</h2><p class="card-sub">Вхід діє до закриття вкладки, але не довше 8 годин</p></div></div>
          <div class="card-body"><button type="button" class="btn btn-danger" data-action="logout">${icon('log-out', { size: 16 })}Вийти з адмін-панелі</button></div>
        </section>
        <section class="card">
          <div class="card-header"><div><h2 class="card-title">Стан системи</h2></div>
            <div class="card-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="health">${icon('refresh-cw', { size: 15 })}Перевірити</button></div></div>
          <div class="card-body stack" id="health"><div class="health"><span class="pulse"></span><span class="muted">Перевірка…</span></div></div>
        </section>
      </div>
    </div>`);

  const shop = root.querySelector('[data-form="shop"]');
  const shopDirty = () => shop.querySelector('#s-name').value.trim() !== (store.settings.shop_name || '')
    || shop.querySelector('#s-contact').value.trim() !== (store.settings.contact || '');
  on(shop, 'input', 'input', () => { shop.querySelector('[type="submit"]').disabled = !shopDirty(); });
  on(root, 'submit', '[data-form="shop"]', async (e, f) => {
    e.preventDefault();
    const b = f.querySelector('[type="submit"]');
    setLoading(b, true);
    try {
      const r = await api('/api/settings', { method: 'PUT', json: { shop_name: f.querySelector('#s-name').value.trim(), contact: f.querySelector('#s-contact').value.trim() } });
      store.settings = { ...store.settings, ...r };
      bus.emit('settings');
      document.title = `Налаштування · ${store.settings.shop_name || 'Адмін-панель'}`;
      toast.success('Налаштування магазину збережено');
    } catch (ex) {
      toastError(ex);
    } finally {
      setLoading(b, false);
      b.disabled = !shopDirty();
    }
  });

  on(root, 'submit', '[data-form="password"]', async (e, f) => {
    e.preventDefault();
    const cur = f.querySelector('#pw-cur').value;
    const nw = f.querySelector('#pw-new').value;
    const rep = f.querySelector('#pw-rep').value;
    const errs = {
      'pw-cur': cur ? '' : 'Введіть поточний пароль',
      'pw-new': !nw ? 'Введіть новий пароль' : nw.length < 10 ? 'Пароль має містити щонайменше 10 символів' : nw === cur ? 'Новий пароль має відрізнятися від поточного' : '',
      'pw-rep': nw && rep !== nw ? 'Паролі не збігаються' : !rep ? 'Повторіть новий пароль' : '',
    };
    Object.entries(errs).forEach(([id, m]) => setFieldError(f, id, m));
    const first = Object.keys(errs).find((k) => errs[k]);
    if (first) { f.querySelector(`#${first}`).focus(); return; }
    const b = f.querySelector('[type="submit"]');
    setLoading(b, true);
    try {
      await api('/api/auth/password', { method: 'POST', json: { current_password: cur, new_password: nw } });
      f.reset();
      toast.success('Пароль змінено. Використовуйте новий пароль під час наступного входу.');
    } catch (ex) {
      if (ex.status === 400) { setFieldError(f, 'pw-cur', ex.message); f.querySelector('#pw-cur').focus(); } else toastError(ex);
    } finally {
      setLoading(b, false);
    }
  });
  on(root, 'input', '[data-form="password"] input', (e, i) => setFieldError(root, i.id, ''));

  on(root, 'click', '[data-theme-opt]', (e, b) => {
    theme.set(b.dataset.themeOpt);
    root.querySelectorAll('[data-theme-opt]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
  on(root, 'change', '#s-compact', (e, c) => shell.setCollapsed(c.checked));
  on(root, 'click', '[data-action="logout"]', () => bus.emit('logout'));

  async function health() {
    const box = root.querySelector('#health');
    setHTML(box, html`<div class="health"><span class="pulse"></span><span class="muted">Перевірка…</span></div>`);
    let ok = false;
    try { ok = Boolean((await api('/health', { auth: false, signal })).ok); } catch (e) { if (e.name === 'AbortError') return; }
    setHTML(box, html`<div class="health"><span class="pulse" style="--c:${ok ? 'var(--success)' : 'var(--danger)'}"></span>
        <span>${ok ? 'Сервер і база даних працюють' : 'База даних недоступна — зміни зараз не збережуться'}</span></div>
      <dl class="kv"><dt>Версія інтерфейсу</dt><dd>2.0</dd><dt>Перевірено</dt><dd>${new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</dd></dl>`);
  }
  on(root, 'click', '[data-action="health"]', health);
  health();
}
