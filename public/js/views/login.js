// Вхід, реєстрація та обов’язкове створення пароля для старих акаунтів.

import { api, deviceId } from '../core/api.js';
import { html, setHTML, $, formValues, busy } from '../core/dom.js';
import { icon } from '../core/icons.js';

const deviceLabel = () => {
  try { return (window.DeviceInfo && window.DeviceInfo.label && window.DeviceInfo.label()) || ''; } catch { return ''; }
};
const firstName = (full) => String(full || '').trim().split(/\s+/)[1] || String(full || '').trim().split(/\s+/)[0] || '';

function passwordProblem(pw, fullName) {
  if (pw.length < 8) return 'Пароль має містити щонайменше 8 символів.';
  if (/^\d+$/.test(pw)) return 'Пароль не може складатися лише з цифр.';
  if (fullName && pw.replace(/\s+/g, '').toLocaleLowerCase('uk') === fullName.replace(/\s+/g, '').toLocaleLowerCase('uk')) return 'Пароль не може збігатися з ПІБ.';
  return '';
}

function layout(card) {
  return html`<div class="auth">
    <aside class="auth-aside">
      <span class="brand"><span class="brand-mark">${icon('cap')}</span><span class="brand-name">Щоденник</span></span>
      <div>
        <h2>Розклад, домашнє, бали й рейтинг — в одному місці.</h2>
        <p>Електронний щоденник групи: стежте за своїм прогресом, підвищуйте бали й отримуйте нагадування про пари.</p>
        <div class="auth-points">
          <div class="auth-point">${icon('trending-up')}<span>Особиста статистика, графіки й щоденні підсумки прогресу</span></div>
          <div class="auth-point">${icon('sheet')}<span>Бали автоматично оновлюються з Google Таблиці групи</span></div>
          <div class="auth-point">${icon('lock')}<span>Акаунт захищено паролем — ваші бали змінюєте лише ви</span></div>
        </div>
      </div>
      <span class="small" style="opacity:.55">Щоденник групи</span>
    </aside>
    <main class="auth-main">
      <div class="auth-card">
        <span class="brand"><span class="brand-mark">${icon('cap')}</span><span class="brand-name">Щоденник</span></span>
        ${card}
      </div>
    </main>
  </div>`;
}

const passwordField = ({ id, name, label, autocomplete, help = '', autofocus = false }) => html`
  <div class="field">
    <label class="label" for="${id}">${label}</label>
    <div class="input-group">
      <input class="input" id="${id}" name="${name}" type="password" autocomplete="${autocomplete}" ${autofocus ? 'autofocus' : ''} style="padding-right:44px">
      <button type="button" class="icon-btn" data-toggle="${id}" aria-label="Показати пароль">${icon('eye')}</button>
    </div>
    ${help ? html`<div class="help">${help}</div>` : ''}
  </div>`;

function wirePasswordToggles(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    const input = root.querySelector(`#${btn.dataset.toggle}`);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Сховати пароль' : 'Показати пароль');
    btn.innerHTML = String(icon(show ? 'eye-off' : 'eye'));
  });
}

export function renderLogin(app, { onSuccess, message = '' }) {
  let mode = 'login';
  let adminPasswordNeeded = false;
  let resetMode = false;
  let pollTimer = null;
  let notice = message;
  const state = { fullName: '' };

  const stopPolling = () => { clearTimeout(pollTimer); pollTimer = null; };

  function render() {
    const login = mode === 'login';
    setHTML(app, layout(html`
      <h1>${login ? 'Вхід до щоденника' : 'Створення акаунта'}</h1>
      <p class="lead">${login ? 'Введіть свій ПІБ і пароль.' : 'Вкажіть ПІБ так, як у списку групи, і придумайте пароль.'}</p>
      ${notice ? html`<div class="alert info mb4">${icon('info')}<div class="grow">${notice}</div></div>` : ''}
      <div class="segmented mb4" role="tablist" aria-label="Режим">
        <button type="button" role="tab" class="${login ? 'active' : ''}" aria-selected="${login}" data-mode="login">Вхід</button>
        <button type="button" role="tab" class="${login ? '' : 'active'}" aria-selected="${!login}" data-mode="register">Реєстрація</button>
      </div>
      <form id="authForm" novalidate>
        <div class="field">
          <label class="label" for="fullName">Прізвище, ім’я та по батькові</label>
          <input class="input" id="fullName" name="fullName" autocomplete="name" autocapitalize="words" value="${state.fullName}" placeholder="Наприклад: Шевченко Олена Петрівна" ${state.fullName ? '' : 'autofocus'}>
        </div>
        ${login
          ? passwordField({
            id: 'password', name: 'password', label: resetMode ? 'Код відновлення' : 'Пароль', autocomplete: 'current-password', autofocus: !!state.fullName,
            help: resetMode ? 'Введіть код, який видав адміністратор. Після входу ви створите новий пароль.' : 'Ще не створювали пароль? Залиште поле порожнім — вхід з нового пристрою підтвердить адміністратор.',
          })
          : html`${passwordField({ id: 'password', name: 'password', label: 'Пароль', autocomplete: 'new-password', help: 'Щонайменше 8 символів, не лише цифри.' })}
            ${passwordField({ id: 'password2', name: 'password2', label: 'Повторіть пароль', autocomplete: 'new-password' })}
            ${adminPasswordNeeded ? passwordField({ id: 'adminPassword', name: 'adminPassword', label: 'Пароль адміністратора', autocomplete: 'off', help: 'Цей ПІБ належить адміністратору. Введіть пароль із налаштувань сервера (ADMIN_PASSWORD).' }) : ''}`}
        <div class="error-text mt3" role="alert" id="authError" hidden></div>
        <div id="authPending" class="alert info mt4" hidden>${icon('clock')}<div class="grow"><strong>Очікуємо підтвердження</strong><span id="authPendingText"></span></div></div>
        <div class="field mt6">
          <button type="submit" class="btn btn-primary btn-lg btn-block">${login ? 'Увійти' : 'Створити акаунт'}</button>
        </div>
      </form>
      <p class="auth-switch">${login
        ? html`Забули пароль? Зверніться до адміністратора — він видасть одноразовий код для входу.`
        : html`Уже маєте акаунт? <button type="button" data-mode="login">Увійти</button>`}</p>
    `));
    wirePasswordToggles(app);
    app.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      state.fullName = $('#fullName', app).value.trim();
      stopPolling();
      mode = b.dataset.mode;
      notice = '';
      render();
    }));
    $('#authForm', app).addEventListener('submit', onSubmit);
  }

  const showError = (text) => {
    const el = $('#authError', app);
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  };

  async function doLogin(body) {
    const r = await api('POST', '/api/auth/login', body);
    stopPolling();
    onSuccess(r);
  }

  function startPolling(body) {
    stopPolling();
    const pending = $('#authPending', app);
    pending.hidden = false;
    $('#authPendingText', app).textContent = ' Запит на вхід з цього пристрою надіслано адміністратору. Щойно він підтвердить — вхід відбудеться автоматично. Сторінку можна не закривати.';
    const tick = async () => {
      try {
        const r = await api('POST', '/api/auth/device-status', { fullName: body.fullName, deviceId: body.deviceId });
        if (r.status === 'approved') { await doLogin(body); return; }
        if (r.status === 'none') {
          pending.hidden = true;
          showError('Запит не підтверджено. Зверніться до адміністратора або спробуйте ще раз.');
          return;
        }
      } catch (e) {
        if (e.status && e.status !== 0) { pending.hidden = true; showError(e.message); return; }
      }
      pollTimer = setTimeout(tick, 6000);
    };
    pollTimer = setTimeout(tick, 6000);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const v = formValues(form);
    state.fullName = v.fullName;
    showError('');
    const name = v.fullName.replace(/\s+/g, ' ').trim();
    if (name.split(' ').length < 2) { showError('Введіть прізвище, ім’я та по батькові.'); $('#fullName', app).focus(); return; }
    const button = form.querySelector('button[type="submit"]');
    if (mode === 'register') {
      const problem = passwordProblem(v.password, name);
      if (problem) { showError(problem); $('#password', app).focus(); return; }
      if (v.password !== v.password2) { showError('Паролі не збігаються.'); $('#password2', app).focus(); return; }
    }
    await busy(button, async () => {
      try {
        if (mode === 'login') {
          await doLogin({ fullName: name, password: form.password.value, deviceId: deviceId(), deviceLabel: deviceLabel() });
        } else {
          const r = await api('POST', '/api/auth/register', {
            fullName: name, password: form.password.value, deviceId: deviceId(), deviceLabel: deviceLabel(),
            ...(adminPasswordNeeded ? { adminPassword: form.adminPassword.value } : {}),
          });
          onSuccess(r);
        }
      } catch (err) {
        if (err.code === 'device_pending') { startPolling({ fullName: name, password: '', deviceId: deviceId(), deviceLabel: deviceLabel() }); return; }
        if (err.code === 'no_account') {
          showError(err.message);
          const box = $('#authError', app);
          box.insertAdjacentHTML('beforeend', ' <button type="button" class="btn btn-ghost btn-sm" data-goto-register>Зареєструватися</button>');
          box.querySelector('[data-goto-register]').addEventListener('click', () => { mode = 'register'; render(); });
          return;
        }
        if (err.code === 'password_required' && err.data && err.data.reset && !resetMode) {
          resetMode = true;
          render();
          showError(err.message);
          return;
        }
        if (err.code === 'admin_password_required' && !adminPasswordNeeded) {
          adminPasswordNeeded = true;
          const pw = form.password.value;
          render();
          $('#password', app).value = pw;
          $('#password2', app).value = pw;
          showError(err.message);
          $('#adminPassword', app).focus();
          return;
        }
        if (err.code === 'exists') {
          showError(err.message);
          return;
        }
        showError(err.message);
      }
    });
  }

  render();
}

export function renderPasswordGate(app, { user, onDone, onSignOut }) {
  setHTML(app, layout(html`
    <div class="empty-icon" style="display:grid;place-items:center;width:52px;height:52px;border-radius:16px;background:var(--accent-soft);color:var(--accent);margin-bottom:16px">${icon('lock')}</div>
    <h1>Захистіть свій акаунт</h1>
    <p class="lead">Вітаємо${firstName(user && user.fullName) ? `, ${firstName(user.fullName)}` : ''}! Тепер вхід до щоденника захищено паролем. Створіть пароль — він знадобиться для входу з інших пристроїв і не дає нікому змінити ваші бали.</p>
    <form id="gateForm" novalidate>
      ${passwordField({ id: 'newPassword', name: 'newPassword', label: 'Новий пароль', autocomplete: 'new-password', help: 'Щонайменше 8 символів, не лише цифри.', autofocus: true })}
      ${passwordField({ id: 'newPassword2', name: 'newPassword2', label: 'Повторіть пароль', autocomplete: 'new-password' })}
      <div class="error-text mt3" role="alert" id="gateError" hidden></div>
      <div class="field mt6"><button type="submit" class="btn btn-primary btn-lg btn-block">Зберегти пароль</button></div>
    </form>
    <p class="auth-switch"><button type="button" data-signout>Вийти з акаунта</button></p>
  `));
  wirePasswordToggles(app);
  const err = (t) => { const el = $('#gateError', app); el.textContent = t; el.hidden = !t; };
  app.querySelector('[data-signout]').addEventListener('click', () => onSignOut());
  $('#gateForm', app).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const pw = form.newPassword.value;
    const problem = passwordProblem(pw, user && user.fullName);
    if (problem) { err(problem); form.newPassword.focus(); return; }
    if (pw !== form.newPassword2.value) { err('Паролі не збігаються.'); form.newPassword2.focus(); return; }
    err('');
    await busy(form.querySelector('button[type="submit"]'), async () => {
      try {
        onDone(await api('POST', '/api/auth/password', { newPassword: pw }));
      } catch (ex) {
        err(ex.message);
      }
    });
  });
}
