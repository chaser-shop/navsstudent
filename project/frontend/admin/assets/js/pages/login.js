// Sign-in screen.
import { api, auth } from '../core/api.js';
import { html, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { setLoading } from '../ui/components.js';

export default function login(root, { onSuccess }) {
  document.title = 'Вхід · Адмін-панель';
  setHTML(root, html`<main class="login">
    <div class="login-card">
      <span class="brand-mark login-mark">${icon('wind', { size: 26 })}</span>
      <h1 class="login-title">Вхід до адмін-панелі</h1>
      <p class="login-sub">Каталог, ціни, замовлення та клієнти — в одному місці.</p>
      <form class="login-form" novalidate>
        <div class="field">
          <label class="label" for="login-user">Логін</label>
          <div class="input-group">${icon('user', { size: 17 })}
            <input class="input" id="login-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required>
          </div>
        </div>
        <div class="field">
          <label class="label" for="login-pass">Пароль</label>
          <div class="input-group">${icon('lock', { size: 17 })}
            <input class="input" id="login-pass" name="password" type="password" autocomplete="current-password" maxlength="256" required style="padding-right:46px">
            <button type="button" class="pw-toggle" data-toggle aria-label="Показати пароль" aria-pressed="false">${icon('eye', { size: 17 })}</button>
          </div>
          <div class="hint tone-warning" id="caps" hidden>Увімкнено Caps Lock</div>
        </div>
        <div class="callout danger" id="login-error" role="alert" hidden>${icon('circle-alert', { size: 17 })}<div id="login-error-text"></div></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit">Увійти${icon('arrow-right', { size: 17 })}</button>
      </form>
      <p class="login-foot">Доступ лише для адміністраторів. Після п’яти невдалих спроб вхід блокується на 15 хвилин.</p>
    </div>
  </main>`);

  const form = root.querySelector('form');
  const user = root.querySelector('#login-user');
  const pass = root.querySelector('#login-pass');
  const btn = form.querySelector('[type="submit"]');
  const err = root.querySelector('#login-error');
  const showError = (msg) => { root.querySelector('#login-error-text').textContent = msg; err.hidden = false; };

  root.querySelector('[data-toggle]').addEventListener('click', (e) => {
    const t = e.currentTarget;
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    t.setAttribute('aria-pressed', String(show));
    t.setAttribute('aria-label', show ? 'Приховати пароль' : 'Показати пароль');
    setHTML(t, icon(show ? 'eye-off' : 'eye', { size: 17 }));
    pass.focus();
  });
  pass.addEventListener('keyup', (e) => { root.querySelector('#caps').hidden = !e.getModifierState?.('CapsLock'); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = user.value.trim();
    const p = pass.value;
    if (!u || !p) {
      showError(!u ? 'Введіть логін.' : 'Введіть пароль.');
      (!u ? user : pass).focus();
      return;
    }
    err.hidden = true;
    setLoading(btn, true);
    try {
      const r = await api('/api/auth/login', { method: 'POST', json: { username: u, password: p }, auth: false });
      auth.set(r.token);
      pass.value = '';
      onSuccess();
    } catch (ex) {
      showError(ex.message);
      pass.select();
    } finally {
      setLoading(btn, false);
    }
  });
  user.focus();
}
