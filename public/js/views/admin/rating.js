// Рейтинг і групи: записи студентів, групи, імпорт із файлу, повні назви предметів.

import { api } from '../../core/api.js';
import { html, setHTML, $, $$, actions, on as delegate, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { openModal, confirmDialog, promptDialog, toastError, toastSuccess, emptyState, errorState, loading, pageHead } from '../../core/ui.js';
import { fmtNum, plural, studentsWord, subjectsWord } from '../../core/format.js';

const enc = encodeURIComponent;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const accountsWord = (n) => plural(n, 'акаунт', 'акаунти', 'акаунтів');
const NEW_GROUP = '__new__';
const TABS = [
  { key: 'records', label: 'Записи' },
  { key: 'groups', label: 'Групи' },
  { key: 'import', label: 'Імпорт' },
  { key: 'subjects', label: 'Предмети' },
];

// ───────── Читання таблиці з файлу (.xls, .xlsx, .csv) ─────────
const pad = (n) => String(n).padStart(2, '0');
let xlsxPromise = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxPromise) {
    xlsxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => {
        xlsxPromise = null;
        reject(new Error('Не вдалося завантажити бібліотеку для файлів .xls і .xlsx. Перевірте інтернет або збережіть таблицю як .csv.'));
      };
      document.head.appendChild(s);
    });
  }
  return xlsxPromise;
}

function cellText(cell) {
  if (!cell) return '';
  if (cell.t === 'd' && cell.v instanceof Date) {
    const d = cell.v;
    return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  }
  if (cell.t === 'n') {
    if (window.XLSX && cell.z && window.XLSX.SSF.is_date(cell.z)) {
      const p = window.XLSX.SSF.parse_date_code(cell.v);
      if (p) return `${pad(p.d)}.${pad(p.m)}.${p.y}`;
    }
    return String(cell.v);
  }
  return String(cell.v == null ? '' : cell.v);
}

async function readGrid(file) {
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf);
  const ole = b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;
  const zip = b[0] === 0x50 && b[1] === 0x4B;
  if (!ole && !zip) {
    if (!window.ScheduleParser) throw new Error('Не завантажився модуль читання CSV. Оновіть сторінку.');
    return window.ScheduleParser.readCSV(buf);
  }
  await loadXLSX();
  const XLSX = window.XLSX;
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) throw new Error('Не вдалося прочитати файл. Схоже, він пошкоджений.');
  const range = XLSX.utils.decode_range(ws['!ref']);
  const grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })]));
    grid.push(row);
  }
  return grid;
}

// Бал із поля вводу: «75», «82,5». Порожнє — { empty }, некоректне — { error }.
function parseScoreInput(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, '').replace(',', '.');
  if (!s) return { empty: true };
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: true };
  const n = Number(s);
  return n <= 100000 ? { value: Math.round(n * 100) / 100 } : { error: true };
}

const validateGroup = (v) => (!v ? 'Введіть назву групи.' : v.length > 40 ? 'Назва має бути не довшою за 40 символів.' : '');

export default async function view(ctx) {
  const { root } = ctx;
  const S = {
    tab: TABS.some((t) => t.key === ctx.query.get('tab')) ? ctx.query.get('tab') : 'records',
    group: ctx.query.get('group') || '',
    groups: [],
    table: null,
    q: '',
    all: null, // предмети всіх груп і повні назви — вантажаться на вкладці «Предмети»
    imp: { reading: false, file: '', parsed: null, error: '', target: '', newName: '', result: null },
  };

  async function loadTable(group = S.group) {
    let t = await api('GET', `/api/rating${group ? `?group=${enc(group)}` : ''}`);
    // Групи з застарілого посилання не існує — відкриваємо першу наявну.
    if (group && (t.groups || []).length && !t.groups.some((g) => g.name === t.group)) t = await api('GET', '/api/rating');
    S.table = t;
    S.group = t.group || '';
    S.groups = t.groups || [];
    S.all = null;
  }

  setHTML(root, loading());
  await loadTable();
  if (!ctx.isActive()) return;

  function syncUrl() {
    if (!ctx.isActive()) return;
    const p = new URLSearchParams();
    if (S.tab !== 'records') p.set('tab', S.tab);
    if (S.group) p.set('group', S.group);
    const qs = p.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  const body = () => $('[data-sec="body"]', root);

  // ───────── Вкладка «Записи» ─────────
  function recordsHtml() {
    if (!S.groups.length) {
      return emptyState({
        icon: 'layers',
        title: 'Груп ще немає',
        text: 'Створіть першу групу й додайте студентів вручну або імпортуйте таблицю з файлу — група створиться автоматично.',
        action: html`<div class="btn-row mt3"><button type="button" class="btn btn-primary" data-action="new-group">${icon('plus')}Створити групу</button><button type="button" class="btn btn-secondary" data-action="tab" data-tab="import">${icon('upload')}Імпортувати з файлу</button></div>`,
      });
    }
    return html`<div class="mg-bar">
        <select class="select mg-bar-group" id="mg-group" aria-label="Група">${S.groups.map((g) => html`<option value="${g.name}" ${g.name === S.group ? 'selected' : ''}>${g.name} · ${g.students} ${studentsWord(g.students)}</option>`)}</select>
        <div class="input-group mg-bar-search">${icon('search')}<input class="input" type="search" id="mg-search" placeholder="Пошук за ПІБ або приміткою" aria-label="Пошук за ПІБ або приміткою" value="${S.q}" autocomplete="off"></div>
        <button type="button" class="btn btn-primary mg-bar-add" data-action="add">${icon('plus')}Додати запис</button>
      </div>
      <p class="help mg-hint">Тут показано лише активні записи. Деактивовані (яких більше немає у таблиці) можна переглянути на сторінці <a href="/admin/students?status=inactive">«Студенти»</a>.</p>
      <div data-sec="table"></div>`;
  }

  function tableHtml() {
    const t = S.table;
    const q = S.q.trim().toLocaleLowerCase('uk');
    const all = t.entries || [];
    if (!all.length) {
      return emptyState({
        icon: 'users',
        title: 'У цій групі ще немає записів',
        text: 'Додайте студента вручну або імпортуйте таблицю з файлу.',
        action: html`<div class="btn-row mt3"><button type="button" class="btn btn-primary" data-action="add">${icon('plus')}Додати запис</button><button type="button" class="btn btn-secondary" data-action="tab" data-tab="import">${icon('upload')}Імпортувати з файлу</button></div>`,
      });
    }
    const rows = all.filter((e) => !q || `${e.fullName} ${e.note || ''}`.toLocaleLowerCase('uk').includes(q));
    if (!rows.length) return emptyState({ icon: 'search', title: 'Нічого не знайдено', text: 'Змініть пошуковий запит.', compact: true });
    const subjects = t.subjects || [];
    const names = t.subjectNames || {};
    return html`<div class="mg-count">${q ? `Знайдено ${rows.length} з ${all.length}` : `${all.length} ${plural(all.length, 'запис', 'записи', 'записів')}`}</div>
      <div class="card"><div class="table-wrap"><table class="table responsive mg-table">
        <caption class="sr-only">Записи групи «${t.group}»</caption>
        <thead><tr>
          <th scope="col">Місце</th><th scope="col">ПІБ</th><th scope="col" class="r">Сума</th>
          ${subjects.map((s) => html`<th scope="col" class="r desktop-only mg-subj" title="${names[s] || s}">${s}</th>`)}
          <th scope="col"><span class="sr-only">Дії</span></th>
        </tr></thead>
        <tbody>${rows.map((e) => html`<tr class="clickable" data-action="edit" data-id="${e.id}">
          <td class="num mg-rank" data-label="Місце">${e.rank != null ? e.rank : '—'}</td>
          <td class="primary" data-label="ПІБ"><span class="mg-who"><span class="strong">${e.fullName}</span>${e.note ? html`<span class="mg-note">${e.note}</span>` : ''}</span></td>
          <td class="r num strong" data-label="Сума">${e.points != null ? fmtNum(e.points) : '—'}</td>
          ${subjects.map((s) => html`<td class="r num desktop-only" data-label="${s}">${isNum((e.subjects || {})[s]) ? fmtNum(e.subjects[s]) : html`<span class="faint">—</span>`}</td>`)}
          <td class="r mg-actions" data-label=""><span class="mg-btns">
            <button type="button" class="icon-btn sm" data-action="edit" data-id="${e.id}" aria-label="Редагувати запис «${e.fullName}»">${icon('edit')}</button>
            <button type="button" class="icon-btn sm" data-action="remove" data-id="${e.id}" aria-label="Видалити запис «${e.fullName}»">${icon('trash')}</button>
          </span></td>
        </tr>`)}</tbody>
      </table></div></div>`;
  }

  const paintTable = () => { const el = $('[data-sec="table"]', root); if (el) setHTML(el, tableHtml()); };

  async function selectGroup(name) {
    const prev = S.group;
    S.group = name;
    S.q = '';
    try {
      await loadTable();
    } catch (e) {
      S.group = prev;
      toastError(e);
      paintBody();
      return;
    }
    if (!ctx.isActive()) return;
    syncUrl();
    paintBody();
  }

  function openRecordForm(entry) {
    const t = S.table;
    const editing = !!entry;
    const own = (entry && entry.subjects) || {};
    const names = t.subjectNames || {};
    const subjects = [...new Set([...(t.subjects || []), ...Object.keys(own)])];
    const groupNames = S.groups.map((g) => g.name);
    const current = S.group || groupNames[0] || '';

    const m = openModal({
      title: editing ? 'Редагування запису' : 'Новий запис у рейтингу',
      size: 'lg',
      body: html`<form id="mg-rec" class="mg-form" novalidate>
        <div class="field">
          <label class="label" for="mg-f-name">ПІБ</label>
          <input class="input" id="mg-f-name" name="fullName" value="${entry ? entry.fullName : ''}" placeholder="Прізвище Ім’я По батькові" maxlength="100" autocomplete="off" autocapitalize="words" ${editing ? '' : 'autofocus'}>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="label" for="mg-f-group">Група</label>
            <select class="select" id="mg-f-group" name="group">${groupNames.map((n) => html`<option value="${n}" ${n === current ? 'selected' : ''}>${n}</option>`)}</select>
          </div>
          <div class="field">
            <label class="label" for="mg-f-note">Примітка</label>
            <input class="input" id="mg-f-note" name="note" value="${entry ? entry.note : ''}" maxlength="60" placeholder="Наприклад: староста" autocomplete="off">
          </div>
        </div>
        <div>
          <div class="flex between mb2"><span class="label">Бали за предметами</span><span class="small muted">Сума: <b class="num" data-sum>—</b></span></div>
          ${subjects.length ? html`<div class="mg-score-grid">${subjects.map((s, i) => html`<div class="mg-score">
            <label for="mg-s-${i}"><span class="mg-score-abbr">${s}</span>${names[s] ? html`<span class="mg-score-full">${names[s]}</span>` : ''}</label>
            <input class="input sm" id="mg-s-${i}" data-subject="${s}" inputmode="decimal" autocomplete="off" placeholder="—" value="${isNum(own[s]) ? String(own[s]).replace('.', ',') : ''}">
          </div>`)}</div>` : html`<p class="help">У групі ще немає предметів. Додайте перший нижче.</p>`}
          <div class="mg-new-subject">
            <div class="field"><label class="label" for="mg-f-ns">Новий предмет</label><input class="input sm" id="mg-f-ns" name="newSubject" maxlength="40" placeholder="Скорочена назва" autocomplete="off"></div>
            <div class="field"><label class="label" for="mg-f-nv">Бал</label><input class="input sm" id="mg-f-nv" name="newScore" inputmode="decimal" placeholder="—" autocomplete="off"></div>
          </div>
          <div class="help mt2">Порожнє поле означає, що балу немає. Сума рахується автоматично.${editing ? ' Кожна зміна балу записується в історію як дія адміністратора.' : ''}</div>
        </div>
        <div class="error-text" role="alert" data-err hidden></div>
      </form>`,
      footer: html`<button type="button" class="btn btn-secondary" data-close>Скасувати</button>
        <button type="submit" form="mg-rec" class="btn btn-primary">${editing ? 'Зберегти' : 'Додати запис'}</button>`,
    });

    const form = $('#mg-rec', m.el);
    const err = $('[data-err]', m.el);
    const fail = (message, field) => {
      err.textContent = message;
      err.hidden = false;
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    };

    const updateSum = () => {
      const inputs = [...$$('[data-subject]', form), $('[name="newScore"]', form)];
      let sum = 0;
      let any = false;
      for (const i of inputs) {
        const p = parseScoreInput(i.value);
        if (p.value != null) { sum += p.value; any = true; }
      }
      $('[data-sum]', form).textContent = any ? fmtNum(sum) : '—';
    };
    updateSum();
    form.addEventListener('input', (e) => {
      if (e.target.removeAttribute) e.target.removeAttribute('aria-invalid');
      err.hidden = true;
      updateSum();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const fullName = f.fullName.value.trim().replace(/\s+/g, ' ');
      if (fullName.split(' ').length < 2) return fail('Введіть прізвище та ім’я (ПІБ).', f.fullName);
      if (!f.group.value) return fail('Оберіть групу.', f.group);
      const scores = {};
      for (const input of $$('[data-subject]', form)) {
        const p = parseScoreInput(input.value);
        if (p.error) return fail(`Бал з предмета «${input.dataset.subject}» має бути числом від 0 до 100000.`, input);
        if (p.value != null) scores[input.dataset.subject] = p.value;
      }
      const ns = f.newSubject.value.replace(/[.$]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const nv = parseScoreInput(f.newScore.value);
      if (ns || !nv.empty) {
        if (!ns) return fail('Вкажіть назву нового предмета.', f.newSubject);
        if (nv.empty) return fail(`Вкажіть бал для предмета «${ns}».`, f.newScore);
        if (nv.error) return fail('Бал має бути числом від 0 до 100000.', f.newScore);
        if (subjects.includes(ns)) return fail('Такий предмет уже є у списку вище.', f.newSubject);
        scores[ns] = nv.value;
      }
      const payload = { fullName, group: f.group.value, note: f.note.value.trim(), subjects: scores };
      const btn = $('button[type="submit"]', m.el);
      try {
        const r = await busy(btn, () => (editing
          ? api('PATCH', `/api/admin/rating/${enc(entry.id)}`, payload)
          : api('POST', '/api/admin/rating', payload)));
        m.close(true);
        toastSuccess(editing ? (r.changes ? `Запис оновлено. Змін балів: ${r.changes}.` : 'Запис оновлено.') : 'Запис додано.');
        S.group = payload.group;
        await loadTable();
        if (!ctx.isActive()) return;
        syncUrl();
        paintBody();
      } catch (error) {
        fail(error.message || 'Не вдалося зберегти запис.');
      }
    });
  }

  async function removeRecord(id) {
    const e = (S.table.entries || []).find((x) => x.id === id);
    if (!e) return;
    const ok = await confirmDialog({
      title: `Видалити запис «${e.fullName}»?`,
      text: 'Запис зникне з рейтингу. Історія змін залишиться для аудиту, а прив’язані акаунти буде відв’язано від цього запису.',
      confirmText: 'Видалити',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('DELETE', `/api/admin/rating/${enc(id)}`);
      toastSuccess('Запис видалено.');
      await loadTable();
    } catch (error) {
      toastError(error);
      return;
    }
    if (ctx.isActive()) paintBody();
  }

  // ───────── Вкладка «Групи» ─────────
  function groupsHtml() {
    return html`<div class="section-head"><h2>Групи</h2><button type="button" class="btn btn-secondary btn-sm" data-action="new-group">${icon('plus')}Нова група</button></div>
      ${S.groups.length
        ? html`<div class="card"><div class="list">${S.groups.map((g) => html`<div class="list-item mg-group">
            <button type="button" class="mg-group-main grow" data-action="open-group" data-name="${g.name}" aria-label="Відкрити записи групи «${g.name}»">
              <span class="title">${g.name}</span>
              <span class="meta">${g.students} ${studentsWord(g.students)} · ${g.accounts} ${accountsWord(g.accounts)}</span>
            </button>
            <span class="mg-btns">
              <button type="button" class="icon-btn sm" data-action="rename-group" data-name="${g.name}" aria-label="Перейменувати групу «${g.name}»">${icon('edit')}</button>
              <button type="button" class="icon-btn sm" data-action="delete-group" data-name="${g.name}" aria-label="Видалити групу «${g.name}»">${icon('trash')}</button>
            </span>
          </div>`)}</div></div>`
        : emptyState({ icon: 'layers', title: 'Груп ще немає', text: 'Створіть групу, щоб додавати до неї студентів.', compact: true })}
      <p class="help mt3">Групу можна видалити, лише коли в ній немає записів (зокрема деактивованих) і акаунтів. Акаунт переносять в іншу групу на сторінці <a href="/admin/users">«Акаунти й пристрої»</a>.</p>`;
  }

  async function groupMutation(fn, okText) {
    try {
      await fn();
      toastSuccess(okText);
      await loadTable();
    } catch (e) {
      toastError(e);
      return;
    }
    if (!ctx.isActive()) return;
    syncUrl();
    paintBody();
  }

  async function newGroup() {
    const name = await promptDialog({
      title: 'Нова група',
      label: 'Назва групи',
      placeholder: 'Наприклад: 101 СПД',
      help: 'До 40 символів. Студентів можна додати вручну або імпортувати з файлу.',
      confirmText: 'Створити',
      validate: validateGroup,
    });
    if (!name) return;
    await groupMutation(async () => { await api('POST', '/api/admin/groups', { name }); S.group = name; }, `Групу «${name}» створено.`);
  }

  async function renameGroup(el) {
    const from = el.dataset.name;
    const to = await promptDialog({ title: 'Перейменувати групу', label: 'Нова назва', value: from, confirmText: 'Перейменувати', validate: validateGroup });
    if (!to || to === from) return;
    await groupMutation(async () => {
      await api('PATCH', '/api/admin/groups', { from, to });
      if (S.group === from) S.group = to;
    }, `Групу перейменовано на «${to}».`);
  }

  async function deleteGroup(el) {
    const name = el.dataset.name;
    const ok = await confirmDialog({
      title: `Видалити групу «${name}»?`,
      text: 'Видалити можна лише порожню групу: без записів студентів (зокрема деактивованих) і акаунтів.',
      confirmText: 'Видалити',
      danger: true,
    });
    if (!ok) return;
    await groupMutation(async () => {
      await api('DELETE', `/api/admin/groups/${enc(name)}`);
      if (S.group === name) S.group = '';
    }, 'Групу видалено.');
  }

  async function openGroup(name) {
    S.tab = 'records';
    paintTabs();
    await selectGroup(name);
  }

  // ───────── Вкладка «Імпорт» ─────────
  function importHtml() {
    const I = S.imp;
    return html`<div class="stack">
      <div class="card"><div class="card-body stack">
        <div>
          <h2 class="mg-h2">Імпорт із файлу</h2>
          <p class="muted small mt1">Завантажте таблицю рейтингу у форматі .xlsx, .xls або .csv. У першому рядку мають бути «ПІБ» і назви предметів, нижче — студенти з балами.</p>
        </div>
        <label class="drop mg-drop" tabindex="0" data-drop>
          ${I.reading
            ? html`<span class="spinner" aria-hidden="true"></span><strong>Читаємо файл…</strong>`
            : html`${icon('upload')}<strong>Оберіть файл або перетягніть його сюди</strong><span class="small">.xlsx, .xls, .csv</span>`}
          <input type="file" data-file accept=".xlsx,.xls,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv">
        </label>
        ${I.error ? html`<div class="alert danger" role="alert">${icon('alert')}<div class="grow">${I.error}</div></div>` : ''}
        <div class="alert info">${icon('info')}<div class="grow">Діють ті самі правила, що й у синхронізації з Google Таблицею. Значення з файлу ніколи не перезаписують новіші бали, змінені студентом чи адміністратором, — такі розбіжності потрапляють у конфлікти на сторінці <a href="/admin/sync">«Синхронізація»</a>. Студентів, яких немає у файлі, буде деактивовано, а не видалено.</div></div>
      </div></div>
      ${I.parsed ? previewHtml() : ''}
      ${I.result ? resultHtml() : ''}
    </div>`;
  }

  function previewHtml() {
    const I = S.imp;
    const p = I.parsed;
    return html`<div class="card">
      <div class="card-head"><h3>Перевірте перед імпортом</h3><span class="hint ellipsis">${I.file}</span></div>
      <div class="card-body mg-fields">
        <div class="stat-strip">
          <div class="st"><div class="v num">${p.entries.length}</div><div class="l">${studentsWord(p.entries.length)}</div></div>
          <div class="st"><div class="v num">${p.subjects.length}</div><div class="l">${subjectsWord(p.subjects.length)}</div></div>
          ${p.skipped ? html`<div class="st"><div class="v num">${p.skipped}</div><div class="l">Пропущено рядків</div></div>` : ''}
        </div>
        <div>
          <div class="label mb2">Предмети</div>
          <div class="chip-list">${p.subjects.map((s) => html`<span class="chip">${s}</span>`)}</div>
        </div>
        <div>
          <div class="label mb2">Перші рядки</div>
          <div class="card mg-mini"><div class="table-wrap"><table class="table">
            <thead><tr><th scope="col">ПІБ</th>${p.subjects.map((s) => html`<th scope="col" class="r">${s}</th>`)}</tr></thead>
            <tbody>${p.entries.slice(0, 5).map((e) => html`<tr><td class="nowrap">${e.fullName}${e.note ? html` <span class="faint">(${e.note})</span>` : ''}</td>${p.subjects.map((s) => html`<td class="r num">${isNum(e.subjects[s]) ? fmtNum(e.subjects[s]) : html`<span class="faint">—</span>`}</td>`)}</tr>`)}</tbody>
          </table></div></div>
          ${p.entries.length > 5 ? html`<div class="help mt2">Показано 5 з ${p.entries.length}.</div>` : ''}
        </div>
        <div class="field">
          <label class="label" for="mg-imp-target">Група, у яку імпортувати</label>
          <select class="select" id="mg-imp-target">
            ${S.groups.map((g) => html`<option value="${g.name}" ${I.target === g.name ? 'selected' : ''}>${g.name}</option>`)}
            <option value="${NEW_GROUP}" ${I.target === NEW_GROUP ? 'selected' : ''}>Нова група…</option>
          </select>
        </div>
        <div class="field" data-newgroup ${I.target === NEW_GROUP ? '' : 'hidden'}>
          <label class="label" for="mg-imp-new">Назва нової групи</label>
          <input class="input" id="mg-imp-new" maxlength="40" value="${I.newName}" placeholder="Наприклад: 102 СПД" autocomplete="off">
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" data-action="run-import">${icon('upload')}Імпортувати ${p.entries.length} ${studentsWord(p.entries.length)}</button>
          <button type="button" class="btn btn-ghost" data-action="cancel-import">Скасувати</button>
        </div>
      </div>
    </div>`;
  }

  function resultHtml() {
    const r = S.imp.result;
    const stat = (value, label, tone = '') => html`<div class="mg-stat ${tone}"><div class="v num">${fmtNum(value || 0, 0)}</div><div class="l">${label}</div></div>`;
    return html`<div class="card" data-result>
      <div class="card-head"><div class="flex"><h3>Імпорт завершено</h3><span class="badge success">${icon('check')}Готово</span></div><span class="hint">Група «${r.group}»</span></div>
      <div class="card-body stack">
        <p class="muted small">У файлі знайдено ${r.students} ${studentsWord(r.students)} і ${r.subjects} ${subjectsWord(r.subjects)}.</p>
        <div class="mg-stats">
          ${stat(r.created, 'Нових записів')}
          ${stat(r.updated, 'Записів оновлено')}
          ${stat(r.scoreChanges, 'Змін балів')}
          ${stat(r.conflicts, 'Конфліктів', r.conflicts ? 'warn' : '')}
          ${stat(r.deactivated, 'Деактивовано')}
          ${r.reactivated ? stat(r.reactivated, 'Повернено в рейтинг') : ''}
        </div>
        ${r.conflicts ? html`<div class="alert warning">${icon('conflict')}<div class="grow">Для ${r.conflicts} ${plural(r.conflicts, 'значення', 'значень', 'значень')} у файлі інші бали, ніж ті, що пізніше змінили студент чи адміністратор. Їх не перезаписано — перегляньте й розв’яжіть конфлікти на сторінці <a href="/admin/sync">«Синхронізація»</a>.</div></div>` : ''}
        ${r.deferred ? html`<div class="alert warning">${icon('alert')}<div class="grow">Частину записів (${r.deferred}) не оброблено, бо вони змінювалися під час імпорту. Повторіть імпорт.</div></div>` : ''}
        ${(r.warnings || []).map((w) => html`<div class="alert warning">${icon('alert')}<div class="grow">${w}</div></div>`)}
      </div>
    </div>`;
  }

  function paintImport() { if (S.tab === 'import') setHTML(body(), importHtml()); }

  async function handleFile(file) {
    const I = S.imp;
    Object.assign(I, { error: '', result: null, parsed: null, reading: true, file: file.name });
    paintImport();
    try {
      const grid = await readGrid(file);
      if (!window.RatingParser) throw new Error('Не завантажився модуль розбору таблиці. Оновіть сторінку.');
      I.parsed = window.RatingParser.parse(grid);
      if (!S.groups.some((g) => g.name === I.target)) I.target = S.group || (S.groups[0] && S.groups[0].name) || NEW_GROUP;
    } catch (e) {
      I.error = (e && e.message) || 'Не вдалося прочитати файл.';
    }
    I.reading = false;
    if (ctx.isActive()) paintImport();
  }

  async function runImport(el) {
    const I = S.imp;
    const target = I.target === NEW_GROUP ? I.newName.replace(/\s+/g, ' ').trim() : I.target;
    const problem = validateGroup(target);
    if (problem) {
      I.error = problem;
      paintImport();
      const field = $('#mg-imp-new', root);
      if (field) field.focus();
      return;
    }
    I.error = '';
    try {
      const r = await busy(el, () => api('PUT', '/api/admin/rating/import', { group: target, subjects: I.parsed.subjects, entries: I.parsed.entries }));
      Object.assign(I, { result: r, parsed: null, file: '', newName: '' });
      toastSuccess('Таблицю імпортовано.');
      S.group = r.group;
      await loadTable(r.group);
    } catch (e) {
      I.error = (e && e.message) || 'Не вдалося імпортувати таблицю.';
    }
    if (!ctx.isActive()) return;
    paintImport();
    const result = $('[data-result]', root);
    if (result) result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ───────── Вкладка «Предмети» ─────────
  async function loadSubjects() {
    const others = S.groups.filter((g) => g.name !== S.group);
    const tables = [S.table, ...(await Promise.all(others.map((g) => api('GET', `/api/rating?group=${enc(g.name)}`))))];
    const list = [];
    for (const t of tables) for (const s of t.subjects || []) if (!list.includes(s)) list.push(s);
    S.all = { list, names: { ...(S.table.subjectNames || {}) } };
  }

  function subjectsHtml() {
    const A = S.all;
    if (!A.list.length) {
      return emptyState({ icon: 'book', title: 'Предметів ще немає', text: 'Вони з’являться після імпорту таблиці або додавання запису з балами.' });
    }
    return html`<form class="card" id="mg-names" novalidate>
      <div class="card-head"><h2>Повні назви предметів</h2><span class="hint">${A.list.length} ${subjectsWord(A.list.length)}</span></div>
      <div class="card-body stack">
        <p class="muted small">У таблиці предмети записані скороченнями. Студенти бачать повні назви у своїй статистиці та в щоденних повідомленнях про прогрес, наприклад: «Ваш рейтинг з предмета «Історія України» покращився…». Якщо поле порожнє, показується скорочення.</p>
        <div class="mg-names">${A.list.map((s, i) => html`<div class="mg-name-row">
          <label class="mg-abbr" for="mg-n-${i}"><span class="sr-only">Повна назва для </span>${s}</label>
          <input class="input" id="mg-n-${i}" data-abbr="${s}" maxlength="80" value="${A.names[s] || ''}" placeholder="Повна назва предмета" autocomplete="off">
        </div>`)}</div>
        <div class="error-text" role="alert" data-err hidden></div>
      </div>
      <div class="card-foot btn-row end"><button type="submit" class="btn btn-primary">${icon('check')}Зберегти назви</button></div>
    </form>`;
  }

  async function saveNames(form) {
    const err = $('[data-err]', form);
    err.hidden = true;
    // Назви предметів інших груп лишаємо без змін: сервер зберігає весь список одразу.
    const names = { ...(S.table.subjectNames || {}) };
    for (const input of $$('[data-abbr]', form)) {
      const v = input.value.replace(/\s+/g, ' ').trim();
      if (v) names[input.dataset.abbr] = v; else delete names[input.dataset.abbr];
    }
    try {
      const r = await busy($('button[type="submit"]', form), () => api('PUT', '/api/admin/rating/subject-names', { names }));
      S.table.subjectNames = r.names;
      S.all.names = { ...r.names };
      toastSuccess('Назви предметів збережено.');
    } catch (e) {
      err.textContent = (e && e.message) || 'Не вдалося зберегти назви.';
      err.hidden = false;
    }
  }

  // ───────── Каркас сторінки ─────────
  function paintTabs() {
    setHTML($('[data-sec="tabs"]', root), TABS.map((t) => html`<button type="button" role="tab" class="${S.tab === t.key ? 'active' : ''}" aria-selected="${S.tab === t.key ? 'true' : 'false'}" data-action="tab" data-tab="${t.key}">${t.label}</button>`));
  }

  function paintBody() {
    const el = body();
    if (S.tab === 'records') { setHTML(el, recordsHtml()); paintTable(); }
    else if (S.tab === 'groups') setHTML(el, groupsHtml());
    else if (S.tab === 'import') setHTML(el, importHtml());
    else if (S.all) setHTML(el, subjectsHtml());
  }

  async function showTab(key) {
    S.tab = key;
    syncUrl();
    paintTabs();
    if (key === 'subjects' && !S.all) {
      setHTML(body(), loading());
      try {
        await loadSubjects();
      } catch (e) {
        if (ctx.isActive() && S.tab === key) setHTML(body(), errorState(e));
        return;
      }
      if (!ctx.isActive() || S.tab !== key) return;
    }
    paintBody();
  }

  setHTML(root, html`
    ${pageHead({ title: 'Рейтинг і групи', subtitle: 'Групи, записи студентів, імпорт таблиці та повні назви предметів.' })}
    <div class="mg-tabs"><div class="segmented" role="tablist" aria-label="Розділи" data-sec="tabs"></div></div>
    <div data-sec="body"></div>`);
  paintTabs();
  if (S.tab === 'subjects') await showTab('subjects'); else paintBody();
  if (!ctx.isActive()) return;

  ctx.onCleanup(actions(root, {
    tab: (el) => showTab(el.dataset.tab),
    retry: () => showTab(S.tab),
    add: () => openRecordForm(null),
    edit: (el) => { const e = (S.table.entries || []).find((x) => x.id === el.dataset.id); if (e) openRecordForm(e); },
    remove: (el) => removeRecord(el.dataset.id),
    'new-group': newGroup,
    'rename-group': renameGroup,
    'delete-group': deleteGroup,
    'open-group': (el) => openGroup(el.dataset.name),
    'run-import': runImport,
    'cancel-import': () => { Object.assign(S.imp, { parsed: null, error: '', file: '' }); paintImport(); },
  }));
  ctx.onCleanup(delegate(root, 'change', '#mg-group', (el) => selectGroup(el.value)));
  ctx.onCleanup(delegate(root, 'input', '#mg-search', (el) => { S.q = el.value; paintTable(); }));
  ctx.onCleanup(delegate(root, 'change', '#mg-imp-target', (el) => {
    S.imp.target = el.value;
    const box = $('[data-newgroup]', root);
    if (box) box.hidden = el.value !== NEW_GROUP;
  }));
  ctx.onCleanup(delegate(root, 'input', '#mg-imp-new', (el) => { S.imp.newName = el.value; }));
  ctx.onCleanup(delegate(root, 'change', 'input[data-file]', (el) => {
    const file = el.files && el.files[0];
    el.value = '';
    if (file) handleFile(file);
  }));
  ctx.onCleanup(delegate(root, 'submit', '#mg-names', (form, e) => { e.preventDefault(); saveNames(form); }));

  // Перетягування файлу на зону імпорту й керування з клавіатури.
  const zone = (e) => e.target.closest && e.target.closest('[data-drop]');
  const onDrag = (e) => { const z = zone(e); if (z) { e.preventDefault(); z.classList.add('over'); } };
  const onLeave = (e) => { const z = zone(e); if (z) z.classList.remove('over'); };
  const onDrop = (e) => {
    const z = zone(e);
    if (!z) return;
    e.preventDefault();
    z.classList.remove('over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  };
  const onKey = (e) => {
    const z = zone(e);
    if (z && z === e.target && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('input', z).click(); }
  };
  root.addEventListener('dragenter', onDrag);
  root.addEventListener('dragover', onDrag);
  root.addEventListener('dragleave', onLeave);
  root.addEventListener('drop', onDrop);
  root.addEventListener('keydown', onKey);
  ctx.onCleanup(() => {
    root.removeEventListener('dragenter', onDrag);
    root.removeEventListener('dragover', onDrag);
    root.removeEventListener('dragleave', onLeave);
    root.removeEventListener('drop', onDrop);
    root.removeEventListener('keydown', onKey);
  });
}
