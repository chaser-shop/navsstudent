// Акаунти й пристрої: запити на вхід з нових пристроїв, пошук і фільтри, картка акаунта
// (роль, група, запис рейтингу, пристрої, скидання пароля, видалення).

import { api } from '../../core/api.js';
import { html, setHTML, $, actions, on as delegate, busy } from '../../core/dom.js';
import { store, sync, on as onStore } from '../../core/store.js';
import { icon } from '../../core/icons.js';
import { openModal, confirmDialog, toastError, toastSuccess, emptyState, loading, pageHead, avatar } from '../../core/ui.js';
import { fmtDateYear, fmtDateTime, fmtTime, relTime, plural } from '../../core/format.js';

const enc = encodeURIComponent;
const collator = new Intl.Collator('uk');
const ROLE_LABELS = { starosta: 'Староста', deputy: 'Заступник старости' };
const devicesWord = (n) => plural(n, 'пристрій', 'пристрої', 'пристроїв');
const onDevicesWord = (n) => plural(n, 'пристрої', 'пристроях', 'пристроях');
const accountsWord = (n) => plural(n, 'акаунт', 'акаунти', 'акаунтів');
const fullDate = (d) => `${fmtDateYear(d)}, ${fmtTime(d)}`;
// Те саме нормування, що й на сервері: без приміток у дужках і з єдиним апострофом.
const nameKey = (s) => String(s || '').replace(/\([^)]*\)/g, ' ').replace(/[`'ʼ‘’]/g, '’').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk');

// Сервер зберігає лише хеш коду скидання. Показаний код тримаємо лише в пам’яті (не в сховищі),
// щоб він не пропав після переходу на іншу сторінку, і стираємо під час виходу з акаунта.
const resetCodes = new Map();
onStore('signout', () => resetCodes.clear());

const FILTERS = [
  { key: 'all', label: 'Усі', test: () => true },
  { key: 'pending', label: 'Очікують пристрій', test: (u) => u.pending.length > 0 },
  { key: 'nopass', label: 'Без пароля', test: (u) => !u.hasPassword },
  { key: 'unlinked', label: 'Без прив’язки до рейтингу', test: (u) => !u.isAdmin && !u.studentId },
  { key: 'staff', label: 'Адміністратори й старости', test: (u) => u.isAdmin || !!u.role },
];

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* запасний спосіб нижче */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  let done = false;
  try { done = document.execCommand('copy'); } catch { done = false; }
  ta.remove();
  return done;
}

function badgesFor(u) {
  const out = [];
  if (u.isAdmin) out.push(html`<span class="badge accent">Адміністратор</span>`);
  else if (u.role) out.push(html`<span class="badge accent">${ROLE_LABELS[u.role]}</span>`);
  if (u.pending.length) out.push(html`<span class="badge info">Очікує пристрій</span>`);
  if (u.resetPending) out.push(html`<span class="badge warning">Очікує скидання пароля</span>`);
  else if (!u.hasPassword) out.push(html`<span class="badge warning">Без пароля</span>`);
  if (!u.isAdmin && !u.studentId) out.push(html`<span class="badge outline">Не прив’язано</span>`);
  return out;
}

export default async function view(ctx) {
  const { root } = ctx;
  const S = { users: [], students: [], groups: [], q: '', filter: 'all', modal: null };
  const codes = resetCodes;

  async function load() {
    const [users, students, groups] = await Promise.all([
      api('GET', '/api/admin/users'),
      api('GET', '/api/admin/rating-students'),
      api('GET', '/api/admin/groups'),
    ]);
    S.users = users;
    S.students = students;
    S.groups = groups;
  }

  setHTML(root, loading());
  await load();
  if (!ctx.isActive()) return;

  const account = (id) => S.users.find((u) => u.id === id);
  const sec = (name) => $(`[data-sec="${name}"]`, root);

  // ───────── Сторінка ─────────
  function requestsHtml() {
    const list = S.users
      .flatMap((u) => u.pending.map((p) => ({ u, p })))
      .sort((a, b) => new Date(a.p.requestedAt) - new Date(b.p.requestedAt));
    if (!list.length) return '';
    return html`<section aria-labelledby="mg-req-title">
      <div class="section-head"><h2 id="mg-req-title">Запити на новий пристрій</h2><span class="hint">${list.length} ${plural(list.length, 'запит', 'запити', 'запитів')}</span></div>
      <div class="card mg-requests-card">
        <p class="help mg-requests-help">Людина входить із нового пристрою й чекає вашого підтвердження. Підтверджуйте лише знайомі пристрої.</p>
        <div class="list">${list.map(({ u, p }) => html`<div class="list-item mg-req">
          ${avatar(u.fullName)}
          <div class="grow">
            <button type="button" class="mg-link" data-action="open" data-id="${u.id}">${u.fullName}</button>
            <div class="meta wrap">${p.label} · ${relTime(p.requestedAt)} · уже прив’язано: ${u.devices} ${devicesWord(u.devices)}</div>
          </div>
          <div class="btn-row mg-req-actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="approve" data-id="${u.id}" data-key="${p.key}" aria-label="Підтвердити пристрій «${p.label}» для «${u.fullName}»">${icon('check')}Підтвердити</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="reject" data-id="${u.id}" data-key="${p.key}" aria-label="Відхилити пристрій «${p.label}» для «${u.fullName}»">Відхилити</button>
          </div>
        </div>`)}</div>
      </div>
    </section>`;
  }

  const chipsHtml = () => FILTERS.map((f) => {
    const on = S.filter === f.key;
    return html`<button type="button" class="chip ${on ? 'active' : ''}" data-action="filter" data-key="${f.key}" aria-pressed="${on ? 'true' : 'false'}">${f.label}<span class="mg-chip-n">${S.users.filter(f.test).length}</span></button>`;
  });

  function visibleUsers() {
    const f = FILTERS.find((x) => x.key === S.filter) || FILTERS[0];
    const q = S.q.trim().toLocaleLowerCase('uk');
    return S.users
      .filter(f.test)
      .filter((u) => !q || [u.fullName, u.group, u.studentName].some((v) => String(v || '').toLocaleLowerCase('uk').includes(q)))
      .sort((a, b) => (b.pending.length > 0) - (a.pending.length > 0) || collator.compare(a.fullName, b.fullName));
  }

  function accountRow(u) {
    const badges = badgesFor(u);
    const where = [u.studentId ? `Рейтинг: ${u.studentName || 'запис прив’язано'}` : '', u.group ? `Група: ${u.group}` : ''].filter(Boolean).join(' · ');
    const seen = u.lastSeenAt ? `Остання активність: ${relTime(u.lastSeenAt)}` : 'Активності ще не було';
    const push = u.pushDevices ? `сповіщення на ${u.pushDevices} ${onDevicesWord(u.pushDevices)}` : 'сповіщення вимкнено';
    return html`<button type="button" class="list-item mg-acc" data-action="open" data-id="${u.id}">
      ${avatar(u.fullName)}
      <span class="grow">
        <span class="title wrap">${u.fullName}${u.id === store.user.id ? html` <span class="faint">(це ви)</span>` : ''}</span>
        ${badges.length ? html`<span class="mg-badges">${badges}</span>` : ''}
        ${where ? html`<span class="meta wrap">${where}</span>` : ''}
        <span class="meta wrap">${seen} · ${u.devices} ${devicesWord(u.devices)} · ${push}</span>
      </span>
      ${icon('chevron-right', 'chev')}
    </button>`;
  }

  function listHtml() {
    const rows = visibleUsers();
    const filtered = S.filter !== 'all' || S.q.trim();
    if (!rows.length) {
      return S.filter === 'pending' && !S.q.trim()
        ? emptyState({ icon: 'smartphone', title: 'Немає запитів на пристрої', text: 'Коли хтось увійде з нового пристрою, запит з’явиться тут.', compact: true })
        : emptyState({ icon: 'search', title: 'Нічого не знайдено', text: 'Змініть пошуковий запит або фільтр.', compact: true });
    }
    return html`<div class="mg-count" aria-live="polite">${filtered ? `Знайдено ${rows.length} з ${S.users.length}` : `${S.users.length} ${accountsWord(S.users.length)}`}</div>
      <div class="card p0"><div class="list">${rows.map(accountRow)}</div></div>`;
  }

  function paintRequests() { setHTML(sec('requests'), requestsHtml()); }
  function paintChips() {
    const box = sec('chips');
    const focusKey = box.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    setHTML(box, chipsHtml());
    if (focusKey) { const b = $(`[data-key="${focusKey}"]`, box); if (b) b.focus(); }
  }
  function paintList() { setHTML(sec('list'), listHtml()); }
  function paintPage() { paintRequests(); paintChips(); paintList(); }

  setHTML(root, html`
    ${pageHead({ title: 'Акаунти й пристрої', subtitle: 'Ролі, групи, прив’язка до рейтингу, пристрої та скидання паролів.' })}
    <div class="mg-requests" data-sec="requests"></div>
    <section class="mg-accounts" aria-label="Акаунти">
      <div class="mg-toolbar">
        <div class="input-group">${icon('search')}<input class="input" type="search" id="mg-q" placeholder="Пошук за ПІБ або групою" aria-label="Пошук акаунтів за ПІБ, групою чи записом рейтингу" autocomplete="off"></div>
        <div class="chip-list" data-sec="chips" role="group" aria-label="Фільтри акаунтів"></div>
      </div>
      <div data-sec="list"></div>
    </section>`);
  paintPage();

  // ───────── Картка акаунта ─────────
  const activeCode = (u) => {
    const c = codes.get(u.id);
    if (!c) return null;
    if (!u.resetPending || new Date(c.expiresAt) <= new Date()) { codes.delete(u.id); return null; }
    return c;
  };

  const groupOptions = (u) => {
    const names = S.groups.map((g) => g.name);
    if (u.group && !names.includes(u.group)) names.push(u.group);
    return html`<option value="">Без групи</option>${names.map((n) => html`<option value="${n}" ${n === u.group ? 'selected' : ''}>${n}</option>`)}`;
  };

  const studentOptions = (u) => {
    const takenBy = new Map();
    for (const x of S.users) if (x.studentId && x.id !== u.id) takenBy.set(x.studentId, x.fullName);
    const byGroup = new Map();
    for (const s of S.students) {
      const g = s.group || 'Без групи';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(s);
    }
    const names = [...byGroup.keys()].sort((a, b) => (a === u.group ? -1 : b === u.group ? 1 : collator.compare(a, b)));
    const known = S.students.some((s) => s.id === u.studentId);
    return html`<option value="">Не прив’язано</option>
      ${u.studentId && !known ? html`<option value="${u.studentId}" selected>${u.studentName || 'Запис рейтингу'}</option>` : ''}
      ${names.map((g) => html`<optgroup label="${g}">${byGroup.get(g).map((s) => {
        const owner = takenBy.get(s.id);
        return html`<option value="${s.id}" ${s.id === u.studentId ? 'selected' : ''} ${owner ? 'disabled' : ''}>${s.fullName}${s.active ? '' : ' (неактивний)'}${owner ? (owner === s.fullName ? ' — уже прив’язано' : ` — прив’язано до «${owner}»`) : ''}</option>`;
      })}</optgroup>`)}`;
  };

  const suggestionFor = (u) => {
    if (u.studentId) return null;
    const key = nameKey(u.fullName);
    const taken = new Set(S.users.filter((x) => x.studentId).map((x) => x.studentId));
    return S.students.find((s) => nameKey(s.fullName) === key && !taken.has(s.id)) || null;
  };

  const SECTIONS = {
    head: (u) => html`${avatar(u.fullName, 'lg')}
      <div class="grow">
        <div class="mg-badges">${badgesFor(u).length ? badgesFor(u) : html`<span class="badge">Студент</span>`}${u.id === store.user.id ? html`<span class="badge outline">Це ваш акаунт</span>` : ''}</div>
        <div class="muted small mt1">Створено: ${fmtDateYear(u.createdAt)}</div>
        <div class="muted small">Остання активність: ${u.lastSeenAt ? relTime(u.lastSeenAt) : 'ще не було'}</div>
      </div>`,

    role: (u) => html`<label class="label" for="mg-role">Роль у групі</label>
      <div class="mg-inline">
        <select class="select" id="mg-role" data-initial="${u.role}" ${u.isAdmin ? 'disabled' : ''}>
          <option value="" ${!u.role ? 'selected' : ''}>Студент</option>
          <option value="starosta" ${u.role === 'starosta' ? 'selected' : ''}>Староста</option>
          <option value="deputy" ${u.role === 'deputy' ? 'selected' : ''}>Заступник старости</option>
        </select>
        <button type="button" class="btn btn-primary" data-action="save-role" disabled>Зберегти</button>
      </div>
      <div class="help">${u.isAdmin ? 'Адміністратору окрема роль не потрібна.' : 'Староста й заступник керують розкладом і предметами та підтверджують домашнє. Людина отримає сповіщення про зміну ролі, якщо ввімкнула їх.'}</div>
      <div class="error-text" role="alert" data-err hidden></div>`,

    group: (u) => html`<label class="label" for="mg-group">Група</label>
      <div class="mg-inline">
        <select class="select" id="mg-group" data-initial="${u.group}">${groupOptions(u)}</select>
        <button type="button" class="btn btn-primary" data-action="save-group" disabled>Зберегти</button>
      </div>
      <div class="error-text" role="alert" data-err hidden></div>`,

    student: (u) => {
      const sg = suggestionFor(u);
      return html`<label class="label" for="mg-student">Запис у рейтингу</label>
        <div class="mg-inline">
          <select class="select" id="mg-student" data-initial="${u.studentId}">${studentOptions(u)}</select>
          <button type="button" class="btn btn-primary" data-action="save-student" disabled>Зберегти</button>
        </div>
        ${sg ? html`<div class="mg-suggest">${icon('sparkles')}<span class="grow">Схоже, це «${sg.fullName}»${sg.group ? ` · ${sg.group}` : ''}.</span><button type="button" class="btn btn-soft btn-sm" data-action="link-suggest" data-student="${sg.id}">Прив’язати</button></div>` : ''}
        <div class="help">${u.studentId
          ? html`Рейтинг і статистика цього запису показуються на всіх пристроях акаунта. <a href="/admin/students/${u.studentId}">Відкрити профіль студента</a>`
          : 'Оберіть запис, щоб людина бачила свій рейтинг і могла підвищувати бали. Один запис можна прив’язати лише до одного акаунта.'}</div>
        <div class="error-text" role="alert" data-err hidden></div>`;
    },

    devices: (u) => html`<div class="mg-sec-head"><h3>Пристрої</h3><span class="badge">${u.deviceList.length}</span></div>
      ${u.pending.length ? html`<div class="alert warning mb3">${icon('smartphone')}<div class="grow"><strong>Запити на новий пристрій</strong>
        <div class="mg-rows">${u.pending.map((p) => html`<div class="mg-row">
          <div class="grow"><div class="strong">${p.label}</div><div class="xs muted">Запит: ${relTime(p.requestedAt)}</div></div>
          <div class="btn-row">
            <button type="button" class="btn btn-primary btn-sm" data-action="approve" data-id="${u.id}" data-key="${p.key}" aria-label="Підтвердити пристрій «${p.label}»">Підтвердити</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="reject" data-id="${u.id}" data-key="${p.key}" aria-label="Відхилити пристрій «${p.label}»">Відхилити</button>
          </div>
        </div>`)}</div></div></div>` : ''}
      ${u.deviceList.length
        ? html`<div class="mg-rows">${u.deviceList.map((d) => html`<div class="mg-row">
            <span class="mg-row-ic">${icon('smartphone')}</span>
            <div class="grow"><div class="strong">${d.label}</div>${d.addedAt ? html`<div class="xs muted">Додано: ${fullDate(d.addedAt)}</div>` : ''}</div>
            <button type="button" class="icon-btn sm" data-action="remove-device" data-id="${u.id}" data-key="${d.key}" data-label="${d.label}" aria-label="Видалити пристрій «${d.label}»">${icon('trash')}</button>
          </div>`)}</div>`
        : html`<p class="help">Немає прив’язаних пристроїв. Перший пристрій, з якого людина увійде, стане основним.</p>`}
      <p class="help mt2">${u.pushDevices ? `Сповіщення ввімкнено на ${u.pushDevices} ${onDevicesWord(u.pushDevices)}.` : 'Сповіщення на пристроях не ввімкнено.'}</p>
      <div class="btn-row mt3">
        ${u.deviceList.length || u.pending.length ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="reset-devices">${icon('x-circle')}Відв’язати всі пристрої</button>` : ''}
        ${u.pushDevices ? html`<a class="btn btn-secondary btn-sm" href="/admin/notify?user=${u.id}">${icon('megaphone')}Надіслати сповіщення</a>` : ''}
      </div>`,

    password: (u) => {
      const code = activeCode(u);
      const status = u.resetPending
        ? 'Очікує скидання: людина має ввести одноразовий код під час входу.'
        : u.hasPassword ? 'Пароль встановлено.' : 'Пароля ще немає — людина створить його під час наступного входу.';
      return html`<div class="mg-sec-head"><h3>Пароль</h3></div>
        <p class="muted small">${status}</p>
        ${code ? html`<div class="mg-code">
          <div class="code-box"><span class="sr-only">Код: </span>${code.code}</div>
          <div class="btn-row mt2"><button type="button" class="btn btn-soft btn-sm" data-action="copy-code">${icon('copy')}Копіювати код</button></div>
          <div class="alert info mt3">${icon('info')}<div class="grow">Передайте код студентові особисто. Під час входу він вводить код замість пароля й одразу створює новий пароль. Код діє до ${fmtDateTime(code.expiresAt)}.</div></div>
        </div>` : ''}
        ${u.id === store.user.id
          ? html`<p class="help">Свій пароль можна змінити в <a href="/profile">профілі</a>.</p>`
          : html`<div class="btn-row mt3"><button type="button" class="btn btn-secondary btn-sm" data-action="reset-password">${icon('key')}Скинути пароль</button></div>`}`;
    },

    danger: (u) => (u.id === store.user.id ? '' : html`<div class="mg-sec-head"><h3>Видалення</h3></div>
      <p class="help">Акаунт, його пристрої та підписки на сповіщення буде видалено. Запис у рейтингу й історія змін залишаться.</p>
      <div class="btn-row mt3"><button type="button" class="btn btn-danger-soft btn-sm" data-action="delete-user">${icon('trash')}Видалити акаунт</button></div>`),
  };

  const detailHtml = (u) => html`<div class="mg-detail">
    <section class="mg-head" data-sec="head">${SECTIONS.head(u)}</section>
    <section class="mg-sec" data-sec="role">${SECTIONS.role(u)}</section>
    <section class="mg-sec" data-sec="group">${SECTIONS.group(u)}</section>
    <section class="mg-sec" data-sec="student">${SECTIONS.student(u)}</section>
    <section class="mg-sec" data-sec="devices">${SECTIONS.devices(u)}</section>
    <section class="mg-sec" data-sec="password">${SECTIONS.password(u)}</section>
    <section class="mg-sec mg-sec-danger" data-sec="danger">${SECTIONS.danger(u)}</section>
  </div>`;

  // Перемальовуємо лише потрібні частини картки, щоб не губити вибір у інших полях.
  function paintModal(names) {
    if (!S.modal || !names || !names.length) return;
    const u = account(S.modal.id);
    if (!u) { S.modal.m.close(); return; }
    for (const name of names) {
      const el = $(`[data-sec="${name}"]`, S.modal.m.el);
      if (!el) continue;
      const hadFocus = el.contains(document.activeElement);
      setHTML(el, SECTIONS[name](u));
      if (hadFocus) ($('select:not([disabled]), button:not([disabled])', el) || S.modal.m.el).focus({ preventScroll: true });
    }
    // Після діалогу підтвердження фокус міг загубитися разом із замінною кнопкою — повертаємо його в картку.
    if (document.activeElement === document.body && document.querySelectorAll('.modal-backdrop:not(.closing)').length === 1) {
      S.modal.m.el.focus({ preventScroll: true });
    }
  }

  async function refresh(names = []) {
    await load();
    if (!ctx.isActive()) return;
    paintPage();
    paintModal(names);
  }

  function showError(name, message) {
    if (!S.modal) return;
    const box = $(`[data-sec="${name}"] [data-err]`, S.modal.m.el);
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  // ───────── Дії ─────────
  const deviceAction = (method, suffix, okText) => async (el) => {
    const { id, key } = el.dataset;
    try {
      await busy(el, () => api(method, `/api/admin/users/${enc(id)}/devices/${enc(key)}${suffix}`));
      toastSuccess(okText);
    } catch (e) { toastError(e); }
    await refresh(['head', 'devices']).catch(() => {});
    sync().catch(() => {});
  };

  async function removeDevice(el) {
    const { id, key, label } = el.dataset;
    const u = account(id);
    const ok = await confirmDialog({
      title: 'Видалити пристрій?',
      text: `Пристрій «${label}» буде відв’язано від акаунта «${u ? u.fullName : ''}». З нього людині треба буде входити знову.`,
      confirmText: 'Видалити',
      danger: true,
    });
    if (!ok) return;
    try {
      await busy(el, () => api('DELETE', `/api/admin/users/${enc(id)}/devices/${enc(key)}`));
      toastSuccess('Пристрій видалено.');
    } catch (e) { toastError(e); }
    await refresh(['head', 'devices']).catch(() => {});
  }

  async function resetDevices(el) {
    const u = account(S.modal.id);
    const ok = await confirmDialog({
      title: 'Відв’язати всі пристрої?',
      text: `Усі пристрої акаунта «${u.fullName}» буде відв’язано, а запити на нові — скасовано. Людині доведеться увійти знову: перший пристрій, з якого вона увійде, стане основним.`,
      confirmText: 'Відв’язати всі',
      danger: true,
    });
    if (!ok) return;
    try {
      await busy(el, () => api('POST', `/api/admin/users/${enc(u.id)}/reset-devices`));
      toastSuccess('Усі пристрої відв’язано.');
    } catch (e) { toastError(e); }
    await refresh(['head', 'devices']).catch(() => {});
    sync().catch(() => {});
  }

  async function saveRole(el) {
    const u = account(S.modal.id);
    const role = $('#mg-role', S.modal.m.el).value;
    showError('role', '');
    try {
      const r = await busy(el, () => api('POST', `/api/admin/users/${enc(u.id)}/role`, { role }));
      toastSuccess(r.notified
        ? `Роль змінено. Сповіщення надіслано (${r.notified} ${devicesWord(r.notified)}).`
        : 'Роль змінено. Людина не отримала сповіщення: на її пристроях вони не ввімкнені.');
    } catch (e) { showError('role', e.message); return; }
    await refresh(['head', 'role']);
  }

  async function saveGroup(el) {
    const u = account(S.modal.id);
    const group = $('#mg-group', S.modal.m.el).value;
    showError('group', '');
    try {
      await busy(el, () => api('POST', `/api/admin/users/${enc(u.id)}/group`, { group }));
      toastSuccess(group ? `Групу змінено на «${group}».` : 'Групу знято.');
    } catch (e) { showError('group', e.message); return; }
    await refresh(['head', 'group']);
  }

  async function linkStudent(el, studentId) {
    const u = account(S.modal.id);
    showError('student', '');
    try {
      const r = await busy(el, () => api('POST', `/api/admin/users/${enc(u.id)}/student`, { studentId }));
      toastSuccess(studentId ? `Акаунт прив’язано до запису «${r.student}».` : 'Прив’язку до запису рейтингу знято.');
    } catch (e) {
      // Перемальовуємо, щоб список «зайнятих» записів був актуальним, і лишаємо пояснення сервера.
      await refresh(['student']).catch(() => {});
      showError('student', e.message);
      return;
    }
    await refresh(['head', 'student']);
  }

  async function resetPassword(el) {
    const u = account(S.modal.id);
    const ok = await confirmDialog({
      title: 'Скинути пароль?',
      text: 'Поточний пароль і всі сеанси цього акаунта одразу перестануть діяти. Ви отримаєте одноразовий код на 24 години — передайте його людині особисто.',
      confirmText: 'Скинути пароль',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await busy(el, () => api('POST', `/api/admin/users/${enc(u.id)}/reset-password`));
      codes.set(u.id, r);
      toastSuccess('Пароль скинуто. Передайте людині одноразовий код.');
    } catch (e) { toastError(e); return; }
    await refresh(['head', 'password']);
    const box = S.modal && $('.mg-code', S.modal.m.el);
    if (box) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function copyCode() {
    const c = S.modal && codes.get(S.modal.id);
    if (!c) return;
    if (await copyText(c.code)) toastSuccess('Код скопійовано.');
    else toastError({ message: 'Не вдалося скопіювати. Виділіть код і скопіюйте його вручну.' });
  }

  async function deleteUser(el) {
    const u = account(S.modal.id);
    const ok = await confirmDialog({
      title: `Видалити акаунт «${u.fullName}»?`,
      text: 'Акаунт, його пристрої та підписки на сповіщення буде видалено без можливості відновлення. Запис у рейтингу, історія змін і внесене домашнє збережуться.',
      confirmText: 'Видалити акаунт',
      danger: true,
    });
    if (!ok) return;
    try {
      await busy(el, () => api('DELETE', `/api/admin/users/${enc(u.id)}`));
    } catch (e) { toastError(e); return; }
    toastSuccess('Акаунт видалено.');
    codes.delete(u.id);
    if (S.modal) S.modal.m.close();
    await refresh().catch(() => {});
    sync().catch(() => {});
  }

  const approve = deviceAction('POST', '/approve', 'Пристрій підтверджено — вхід відбудеться автоматично.');
  const reject = deviceAction('POST', '/reject', 'Запит відхилено.');

  function openAccount(id) {
    const u = account(id);
    if (!u) return;
    const m = openModal({
      title: u.fullName,
      size: 'lg',
      body: detailHtml(u),
      footer: html`<button type="button" class="btn btn-secondary" data-close>Закрити</button>`,
    });
    S.modal = { m, id };
    actions(m.el, {
      approve,
      reject,
      'remove-device': removeDevice,
      'reset-devices': resetDevices,
      'save-role': saveRole,
      'save-group': saveGroup,
      'save-student': (el) => linkStudent(el, $('#mg-student', m.el).value),
      'link-suggest': (el) => linkStudent(el, el.dataset.student),
      'reset-password': resetPassword,
      'copy-code': copyCode,
      'delete-user': deleteUser,
    });
    // Кнопка «Зберегти» активна, лише коли вибране значення відрізняється від збереженого.
    m.el.addEventListener('change', (e) => {
      const select = e.target.closest('select[data-initial]');
      const button = select && select.parentElement.querySelector('button');
      if (button) button.disabled = select.value === select.dataset.initial;
    });
    m.closed.then(() => {
      if (S.modal && S.modal.m === m) S.modal = null;
      // Рядок списку міг перемалюватися, поки картка була відкрита, — повертаємо фокус на нього.
      const row = ctx.isActive() ? $(`.mg-acc[data-id="${id}"]`, root) : null;
      if (row) row.focus({ preventScroll: true });
    });
  }

  ctx.onCleanup(actions(root, {
    open: (el) => openAccount(el.dataset.id),
    filter: (el) => { S.filter = el.dataset.key; paintChips(); paintList(); },
    approve,
    reject,
  }));
  ctx.onCleanup(delegate(root, 'input', '#mg-q', (el) => { S.q = el.value; paintList(); }));

  // Новий запит може з’явитися, поки сторінка відкрита: оновлюємо список, якщо адміністратор нічого не редагує.
  ctx.onCleanup(onStore('sync', () => {
    if (!ctx.isActive() || document.querySelector('.modal-backdrop')) return;
    const active = document.activeElement;
    if (active && root.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
    const known = S.users.reduce((n, u) => n + u.pending.length, 0);
    if (((store.data && store.data.deviceRequests) || 0) !== known) refresh().catch(() => {});
  }));
}
