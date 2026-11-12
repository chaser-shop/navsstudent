// Розклад і предмети: завантаження файлу розкладу, повні назви предметів із посиланнями, імена викладачів.

import { api } from '../../core/api.js';
import { html, setHTML, $, $$, on, busy, formValues } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { store, sync, on as onStore } from '../../core/store.js';
import { fmtDate, fmtDateYear, pairsWord, subjectsWord } from '../../core/format.js';
import { emptyState, pageHead } from '../../core/ui.js';
import { lessons, uiBusy, ukText } from '../homework.js';

// ───────── Читання файлу розкладу (порт зі старої версії) ─────────

let xlsxPromise = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxPromise) {
    xlsxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => { xlsxPromise = null; reject(new Error('Не вдалося завантажити бібліотеку для .xls. Перевірте інтернет або використайте .csv.')); };
      document.head.appendChild(s);
    });
  }
  return xlsxPromise;
}

const pad = (n) => String(n).padStart(2, '0');

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
  if (!ole && !zip) return window.ScheduleParser.readCSV(buf);
  await loadXLSX();
  const X = window.XLSX;
  const wb = X.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) throw new Error('Не вдалося прочитати файл. Схоже, він пошкоджений.');
  const range = X.utils.decode_range(ws['!ref']);
  const grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) row.push(cellText(ws[X.utils.encode_cell({ r, c })]));
    grid.push(row);
  }
  return grid;
}

// ───────── Дані для списків ─────────

function subjectEntries() {
  const counts = new Map();
  for (const l of lessons()) counts.set(l.subjectKey, (counts.get(l.subjectKey) || 0) + 1);
  Object.keys((store.data && store.data.subjects) || {}).forEach((k) => { if (!counts.has(k)) counts.set(k, 0); });
  return [...counts].sort((a, b) => a[0].localeCompare(b[0], 'uk')).map(([key, count]) => ({ key, count }));
}

function teacherEntries() {
  const counts = new Map();
  for (const l of lessons()) if (l.teacher) counts.set(l.teacher, (counts.get(l.teacher) || 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0], 'uk')).map(([key, count]) => ({ key, count }));
}

const countText = (n) => (n ? `${n} ${pairsWord(n)} у розкладі` : 'немає в поточному розкладі');

function subjectForm({ key, count }, i) {
  const info = (store.data && store.data.subjects && store.data.subjects[key]) || {};
  return html`<form class="st-edit" data-kind="subject" data-key="${key}" data-search="${`${key} ${info.fullName || ''}`.toLowerCase()}" novalidate>
    <div class="st-edit-head"><strong>${key}</strong><span class="muted xs">${countText(count)}</span></div>
    <div class="field-row">
      <div class="field">
        <label class="label" for="${`sub-name-${i}`}">Повна назва</label>
        <input class="input" id="${`sub-name-${i}`}" name="fullName" maxlength="200" autocomplete="off" placeholder="Наприклад: Історія України" value="${info.fullName || ''}">
      </div>
      <div class="field">
        <label class="label" for="${`sub-link-${i}`}">Посилання на пару</label>
        <input class="input" id="${`sub-link-${i}`}" name="link" type="url" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="500" placeholder="Zoom, Google Meet або Teams" value="${info.link || ''}">
      </div>
    </div>
    <div class="st-edit-foot"><span class="st-msg small" role="status" aria-live="polite"></span><button type="submit" class="btn btn-secondary btn-sm">Зберегти</button></div>
  </form>`;
}

function teacherForm({ key, count }, i) {
  const name = (store.data && store.data.teachers && store.data.teachers[key]) || '';
  return html`<form class="st-edit" data-kind="teacher" data-key="${key}" data-search="${`${key} ${name}`.toLowerCase()}" novalidate>
    <div class="st-edit-head"><span class="muted xs">У розкладі:</span><strong>${key}</strong><span class="muted xs">${countText(count)}</span></div>
    <div class="field">
      <label class="label" for="${`teach-name-${i}`}">Повне ім’я</label>
      <input class="input" id="${`teach-name-${i}`}" name="fullName" maxlength="200" autocomplete="off" autocapitalize="words" placeholder="Прізвище Ім’я По батькові" value="${name}">
    </div>
    <div class="st-edit-foot"><span class="st-msg small" role="status" aria-live="polite"></span><button type="submit" class="btn btn-secondary btn-sm">Зберегти</button></div>
  </form>`;
}

export default async function view(ctx) {
  const root = ctx.root;
  if (!store.data) await sync();
  if (!ctx.isActive()) return;

  let job = { text: '', tone: '', running: false };
  let query = '';
  let quiet = 0; // доки зберігається окремий рядок, не перемальовуємо сторінку, щоб не губити введене

  const statusHTML = () => (job.text ? html`<div class="st-status ${job.tone}" role="status" aria-live="polite">
    ${job.running ? html`<span class="spinner" aria-hidden="true"></span>` : job.tone === 'ok' ? icon('check-circle') : job.tone === 'err' ? icon('alert') : ''}
    <span>${job.text}</span></div>` : '');
  function say(text, tone = '', running = false) {
    job = { text, tone, running };
    const el = $('[data-role="status"]', root);
    if (el) setHTML(el, statusHTML());
  }

  function applyFilter() {
    const q = query.trim().toLowerCase();
    for (const row of $$('form[data-kind="subject"]', root)) row.hidden = !!q && !row.dataset.search.includes(q);
    const none = $('[data-role="no-match"]', root);
    if (none) none.hidden = !q || $$('form[data-kind="subject"]:not([hidden])', root).length > 0;
  }

  function draw() {
    const all = lessons();
    const subjects = subjectEntries();
    const teachers = teacherEntries();
    const first = all[0];
    const last = all[all.length - 1];
    const title = (store.data && store.data.scheduleTitle) || '';
    setHTML(root, html`<div class="st-page">
      ${pageHead({ title: 'Розклад і предмети', subtitle: 'Завантаження розкладу, назви предметів, посилання на пари та імена викладачів' })}

      <section class="section">
        <div class="section-head"><h2>Розклад</h2></div>
        <div class="card"><div class="card-body stack">
          ${all.length ? html`
            ${title ? html`<div class="strong">${title}</div>` : ''}
            <div class="stat-strip">
              <div class="st"><div class="v num">${all.length}</div><div class="l">${pairsWord(all.length)} у розкладі</div></div>
              <div class="st"><div class="v num">${subjects.length}</div><div class="l">${subjectsWord(subjects.length)}</div></div>
              <div class="st"><div class="v">${fmtDate(first.start)} – ${fmtDateYear(last.start)}</div><div class="l">період</div></div>
            </div>` : html`<p class="muted">Розклад ще не завантажено. Завантажте файл — і всі студенти одразу його побачать.</p>`}
          <label class="drop" tabindex="0" role="button" aria-label="Обрати файл розкладу">
            ${icon('upload')}
            <strong>Перетягніть файл розкладу сюди</strong>
            <span class="small">або натисніть, щоб обрати · .xls, .xlsx, .csv</span>
            <input type="file" accept=".xls,.xlsx,.csv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" aria-label="Файл розкладу">
          </label>
          <div data-role="status">${statusHTML()}</div>
          <p class="help">Файл розбирається у браузері й надсилається на сервер. Новий файл замінює пари від його першої дати, а домашнє й посилання на пари лишаються.</p>
        </div></div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Предмети</h2><span class="hint">${subjects.length} ${subjectsWord(subjects.length)}</span></div>
        ${subjects.length ? html`
          <p class="muted small mb3">Повна назва показується замість скорочення з розкладу. Посилання на пару одне для всього предмета — студенти бачать його у вікні пари.</p>
          ${subjects.length > 6 ? html`<div class="input-group mb3">${icon('search')}<input class="input" type="search" data-role="filter" placeholder="Знайти предмет" aria-label="Знайти предмет" value="${query}" autocomplete="off"></div>` : ''}
          <div class="card st-editlist">${subjects.map(subjectForm)}</div>
          <p class="muted small center mt3" data-role="no-match" hidden>Нічого не знайдено.</p>`
    : html`<div class="card">${emptyState({ icon: 'book', title: 'Предметів ще немає', text: 'Вони з’являться після завантаження розкладу.', compact: true })}</div>`}
      </section>

      <section class="section">
        <div class="section-head"><h2>Викладачі</h2><span class="hint">${teachers.length ? `${teachers.length}` : ''}</span></div>
        ${teachers.length ? html`
          <p class="muted small mb3">У розкладі викладачі підписані скорочено. Тут можна вказати повне ім’я — його побачать студенти.</p>
          <div class="card st-editlist">${teachers.map(teacherForm)}</div>`
    : html`<div class="card">${emptyState({ icon: 'users', title: 'У розкладі немає викладачів', text: 'Спершу завантажте розклад.', compact: true })}</div>`}
      </section>
    </div>`);
    applyFilter();
  }

  async function importFile(file) {
    if (job.running) return;
    try {
      if (!window.ScheduleParser) throw new Error('Не вдалося завантажити модуль розбору розкладу. Оновіть сторінку.');
      say('Читаю файл…', '', true);
      const parsed = window.ScheduleParser.parse(await readGrid(file));
      say(`Надсилаю пар: ${parsed.lessons.length}…`, '', true);
      await api('PUT', '/api/schedule', { title: parsed.title, lessons: parsed.lessons });
      say(`Готово. Завантажено пар: ${parsed.lessons.length}.`, 'ok');
      await sync();
    } catch (e) {
      say(ukText(e, 'Не вдалося завантажити розклад. Перевірте файл і спробуйте ще раз.'), 'err');
    }
  }

  async function saveRow(form) {
    const key = form.dataset.key;
    const v = formValues(form);
    const msg = form.querySelector('.st-msg');
    const setMsg = (text, tone = '') => { msg.textContent = text; msg.className = `st-msg small ${tone === 'ok' ? 'success-text' : tone === 'err' ? 'error-text' : ''}`; };
    setMsg('');
    quiet += 1;
    await busy(form.querySelector('button[type="submit"]'), async () => {
      try {
        if (form.dataset.kind === 'subject') await api('PUT', '/api/subjects', { key, fullName: v.fullName, link: v.link });
        else await api('PUT', '/api/teachers', { key, fullName: v.fullName });
        await sync().catch(() => {});
        setMsg('Збережено', 'ok');
        setTimeout(() => { if (msg.isConnected && msg.textContent === 'Збережено') setMsg(''); }, 3500);
      } catch (e) {
        setMsg(e.message, 'err');
      }
    });
    quiet -= 1;
  }

  ctx.onCleanup(on(root, 'submit', 'form[data-kind]', (form, e) => { e.preventDefault(); saveRow(form); }));
  ctx.onCleanup(on(root, 'change', 'input[type="file"]', (input) => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) importFile(file);
  }));
  ctx.onCleanup(on(root, 'input', '[data-role="filter"]', (input) => { query = input.value; applyFilter(); }));
  ctx.onCleanup(on(root, 'dragover', '.drop', (zone, e) => { e.preventDefault(); zone.classList.add('over'); }));
  ctx.onCleanup(on(root, 'dragleave', '.drop', (zone) => zone.classList.remove('over')));
  ctx.onCleanup(on(root, 'drop', '.drop', (zone, e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) importFile(file);
  }));
  ctx.onCleanup(on(root, 'keydown', '.drop', (zone, e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); zone.querySelector('input').click(); }
  }));
  ctx.onCleanup(onStore('sync', () => { if (!quiet && !uiBusy(root)) draw(); }));
  draw();
}
