// Розсилка: сповіщення на пристрої всіх або однієї людини з живим попереднім переглядом.

import { api } from '../../core/api.js';
import { html, setHTML, $, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { confirmDialog, toastSuccess, loading, pageHead } from '../../core/ui.js';
import { plural } from '../../core/format.js';

const DEFAULT_TITLE = 'Повідомлення від адміністратора';
const BODY_PLACEHOLDER = 'Текст сповіщення з’явиться тут.';
const devicesWord = (n) => plural(n, 'пристрій', 'пристрої', 'пристроїв');
const ofDevicesWord = (n) => plural(n, 'пристрою', 'пристроїв', 'пристроїв');
const peopleWord = (n) => plural(n, 'людина', 'людини', 'людей');

export default async function view(ctx) {
  const { root } = ctx;
  setHTML(root, loading());
  const users = await api('GET', '/api/admin/users');
  if (!ctx.isActive()) return;

  const collator = new Intl.Collator('uk');
  const sorted = [...users].sort((a, b) => collator.compare(a.fullName, b.fullName));
  const subscribed = users.filter((u) => u.pushDevices > 0);
  const totalDevices = subscribed.reduce((n, u) => n + u.pushDevices, 0);
  const wanted = ctx.query.get('user');
  const preselect = sorted.some((u) => u.id === wanted && u.pushDevices > 0) ? wanted : 'all';

  setHTML(root, html`
    ${pageHead({ title: 'Розсилка', subtitle: 'Надішліть сповіщення на пристрої всіх або однієї людини.' })}
    ${subscribed.length ? '' : html`<div class="alert info mb4">${icon('bell-off')}<div class="grow">Ніхто ще не ввімкнув сповіщення, тому надсилати поки нікому. Кожен вмикає їх у своєму профілі на потрібному пристрої.</div></div>`}
    <form class="mg-notify" id="mg-notify" novalidate>
      <div class="card mg-n-form"><div class="card-body stack">
        <div class="field">
          <label class="label" for="mg-to">Кому</label>
          <select class="select" id="mg-to">
            <option value="all">Усім, у кого ввімкнено сповіщення (${subscribed.length})</option>
            <optgroup label="Окремі люди">${sorted.map((u) => html`<option value="${u.id}" ${u.pushDevices ? '' : 'disabled'} ${u.id === preselect ? 'selected' : ''}>${u.fullName}${u.pushDevices ? ` · ${u.pushDevices} ${devicesWord(u.pushDevices)}` : ' — сповіщення вимкнено'}</option>`)}</optgroup>
          </select>
          <div class="help" data-who></div>
        </div>
        <div class="field">
          <label class="label" for="mg-title">Заголовок <span class="faint">(необов’язково)</span></label>
          <input class="input" id="mg-title" maxlength="60" placeholder="${DEFAULT_TITLE}" autocomplete="off">
          <div class="help mg-counter"><span data-count="title">0</span> / 60</div>
        </div>
        <div class="field">
          <label class="label" for="mg-body">Текст</label>
          <textarea class="textarea" id="mg-body" maxlength="300" rows="5" placeholder="Наприклад: завтра перша пара скасована"></textarea>
          <div class="help mg-counter"><span data-count="body">0</span> / 300</div>
        </div>
        <div data-msg aria-live="polite"></div>
      </div></div>
      <div class="card mg-n-preview">
        <div class="card-head"><h2>Попередній перегляд</h2><span class="hint">так воно виглядатиме</span></div>
        <div class="card-body">
          <div class="mg-phone">
            <div class="mg-push" role="group" aria-label="Попередній перегляд сповіщення">
              <span class="brand-mark mg-push-ic">${icon('cap')}</span>
              <div class="mg-push-main">
                <div class="mg-push-top"><span>Щоденник</span><span>зараз</span></div>
                <div class="mg-push-title" data-prev="title">${DEFAULT_TITLE}</div>
                <div class="mg-push-body mg-push-empty" data-prev="body">${BODY_PLACEHOLDER}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="mg-n-actions"><button type="submit" class="btn btn-primary btn-lg">${icon('send')}Надіслати</button></div>
    </form>
    <p class="help mt4">Сповіщення приходить на всі пристрої, де людина його ввімкнула. Налаштування нагадувань на нього не впливають.</p>`);

  const to = $('#mg-to', root);
  const titleIn = $('#mg-title', root);
  const bodyIn = $('#mg-body', root);
  const msg = $('[data-msg]', root);

  const say = (type, text) => setHTML(msg, text
    ? html`<div class="alert ${type}" role="${type === 'danger' ? 'alert' : 'status'}">${icon(type === 'success' ? 'check-circle' : 'alert')}<div class="grow">${text}</div></div>`
    : '');

  function who() {
    const el = $('[data-who]', root);
    if (to.value === 'all') {
      el.textContent = subscribed.length
        ? `Отримають ${subscribed.length} ${peopleWord(subscribed.length)} — усього ${totalDevices} ${devicesWord(totalDevices)}.`
        : 'Сповіщення вимкнено в усіх. Сервер повідомить, якщо надсилати нікому.';
    } else {
      const u = users.find((x) => x.id === to.value);
      el.textContent = u ? `Отримає: ${u.pushDevices} ${devicesWord(u.pushDevices)}.` : '';
    }
  }

  function preview() {
    const text = bodyIn.value.trim();
    $('[data-prev="title"]', root).textContent = titleIn.value.trim() || DEFAULT_TITLE;
    const body = $('[data-prev="body"]', root);
    body.textContent = text || BODY_PLACEHOLDER;
    body.classList.toggle('mg-push-empty', !text);
    $('[data-count="title"]', root).textContent = titleIn.value.length;
    $('[data-count="body"]', root).textContent = bodyIn.value.length;
  }
  who();
  preview();

  const onChange = () => { who(); say('', ''); };
  const onInput = () => { preview(); };
  to.addEventListener('change', onChange);
  titleIn.addEventListener('input', onInput);
  bodyIn.addEventListener('input', onInput);

  const form = $('#mg-notify', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type="submit"]', form);
    const text = bodyIn.value.trim();
    say('', '');
    if (!text) {
      say('danger', 'Введіть текст сповіщення.');
      bodyIn.focus();
      return;
    }
    if (to.value === 'all' && subscribed.length) {
      const ok = await confirmDialog({
        title: 'Надіслати всім?',
        text: `Сповіщення отримають ${subscribed.length} ${peopleWord(subscribed.length)} (${totalDevices} ${devicesWord(totalDevices)}). Скасувати надсилання буде неможливо.`,
        confirmText: 'Надіслати',
      });
      if (!ok) return;
    }
    try {
      const r = await busy(button, () => api('POST', '/api/admin/notify', { userId: to.value, title: titleIn.value.trim(), body: text }));
      if (!ctx.isActive()) return;
      say('success', `Сповіщення надіслано: ${r.sent} з ${r.total} ${ofDevicesWord(r.total)}.${r.sent < r.total ? ' Решта пристроїв не відповіла — на них могли вимкнути сповіщення.' : ''}`);
      toastSuccess('Сповіщення надіслано.');
      bodyIn.value = '';
      preview();
      bodyIn.focus();
    } catch (error) {
      if (ctx.isActive()) say('danger', (error && error.message) || 'Не вдалося надіслати сповіщення.');
    }
  });

  ctx.onCleanup(() => {
    to.removeEventListener('change', onChange);
    titleIn.removeEventListener('input', onInput);
    bodyIn.removeEventListener('input', onInput);
  });
}
