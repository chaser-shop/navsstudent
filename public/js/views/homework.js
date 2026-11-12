// Домашнє: розділи за термінами, фільтр за предметом, редактор завдання.
// Модуль також дає спільні допоміжні функції для розкладу й модерації (дати за київським часом, пари, вкладення).

import { api, imageUrl } from '../core/api.js';
import { html, setHTML, $$, actions, on, busy } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { store, sync, on as onStore, canModerate, subjectName, isDone, toggleDone, markAnswered } from '../core/store.js';
import { TZ, fmtDate, fmtDateYear, fmtWeekday, fmtWeekdayShort, fmtTime, dayKey, colorFor } from '../core/format.js';
import { toast, toastSuccess, openModal, confirmDialog, emptyState, pageHead, viewImage } from '../core/ui.js';

export const MAX_LINKS = 5;
export const MAX_IMAGES = 6;
const MAX_TEXT = 2000;
const DAY_MS = 86400000;

// ───────── Дати за київським часом (ключ дня — YYYY-MM-DD) ─────────

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
/** Момент усередині київського дня — безпечний для форматування й арифметики днів. */
export const dayDate = (key) => new Date(`${key}T12:00:00Z`);
export const todayKey = () => dayKey(Date.now());
export function addDays(key, n) {
  const d = dayDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const weekStart = (key) => addDays(key, -((dayDate(key).getUTCDay() + 6) % 7));

const kyivParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
function kyivOffset(ms) {
  const v = {};
  for (const p of kyivParts.formatToParts(new Date(ms))) v[p.type] = Number(p.value);
  return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - Math.floor(ms / 1000) * 1000;
}
/** Північ київського дня як момент UTC (так само, як термін здачі зберігала стара версія). */
export function kyivMidnight(key) {
  const [y, m, d] = key.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let utc = wall - kyivOffset(wall);
  utc = wall - kyivOffset(utc);
  return new Date(utc);
}

export function relDay(key) {
  const diff = Math.round((dayDate(key) - dayDate(todayKey())) / DAY_MS);
  if (diff === 0) return 'Сьогодні';
  if (diff === 1) return 'Завтра';
  if (diff === 2) return 'Післязавтра';
  if (diff === -1) return 'Вчора';
  return cap(fmtWeekdayShort(dayDate(key)));
}
export const dayText = (key) => (key.slice(0, 4) === todayKey().slice(0, 4) ? fmtDate(dayDate(key)) : fmtDateYear(dayDate(key)));
/** «Завтра, 14 жовтня» / «Пн, 20 жовтня». */
export const dueText = (key) => `${relDay(key)}, ${dayText(key)}`;

// ───────── Пари та предмети ─────────

let lessonCache = { src: null, list: [] };
/** Пари з даними синхронізації, дати — Date; відсортовано за початком. */
export function lessons() {
  const src = (store.data && store.data.lessons) || [];
  if (lessonCache.src !== src) {
    lessonCache = {
      src,
      list: src.map((l) => ({ ...l, start: new Date(l.start), end: new Date(l.end) })).sort((a, b) => a.start - b.start),
    };
  }
  return lessonCache.list;
}
export const lessonById = (id) => (id ? lessons().find((l) => l.id === id) || null : null);

export const KIND_LABELS = { 'Лк': 'Лекція', 'Пз': 'Практичне заняття', 'Сем': 'Семінар' };
export const kindLabel = (kind) => KIND_LABELS[kind] || kind || 'Пара';
/** «ауд. 416» / «Дистанційно» / порожній рядок, якщо місце не вказано. */
export const placeLabel = (l) => (l.isRemote ? 'Дистанційно' : l.room ? `ауд. ${l.room}` : '');

export const allHomework = () => (store.data && store.data.homework) || [];

/** Ключі всіх предметів: з розкладу, довідника предметів і домашнього. */
export function subjectKeys() {
  const set = new Set(lessons().map((l) => l.subjectKey));
  Object.keys((store.data && store.data.subjects) || {}).forEach((k) => set.add(k));
  allHomework().forEach((h) => set.add(h.subjectKey));
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'uk'));
}

/** Лише http(s)-посилання; без схеми додається https://. */
export function safeLink(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!s.includes('://')) s = `https://${s}`;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.toString() : '';
  } catch { return ''; }
}
export const shortUrl = (u) => {
  const t = String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return t.length > 42 ? `${t.slice(0, 41)}…` : t;
};

// ───────── Домашнє: правила доступу й стани ─────────

export const isMine = (h) => !!store.user && h.authorID === store.user.id;
export const canEditHw = (h) => canModerate() || (isMine(h) && h.status !== 'approved');
const ts = (v) => (v ? new Date(v).getTime() || 0 : 0);
const byDue = (a, b) => ts(a.due) - ts(b.due) || ts(a.created) - ts(b.created);
const createdKey = (h) => (ts(h.created) ? dayKey(h.created) : '');

export const statusBadge = (h) => (h.status === 'pending'
  ? html`<span class="badge warning">${icon('clock')}Очікує підтвердження</span>`
  : h.status === 'rejected' ? html`<span class="badge danger">${icon('x-circle')}Відхилено</span>` : '');

/**
 * Домашнє, що стосується пари:
 *  given — задали на цій парі (прив’язане до неї або внесене з цього предмета в день пари);
 *  due — треба здати на цю пару (термін збігається з днем пари).
 */
export function lessonHomework(l) {
  const uid = store.user && store.user.id;
  const visible = allHomework().filter((h) => h.status === 'approved' || h.authorID === uid);
  const day = dayKey(l.start);
  const given = visible
    .filter((h) => h.lessonID === l.id || (!h.lessonID && h.subjectKey === l.subjectKey && createdKey(h) === day))
    .sort((a, b) => ts(a.created) - ts(b.created));
  const ids = new Set(given.map((h) => h.id));
  const due = visible
    .filter((h) => !ids.has(h.id) && h.subjectKey === l.subjectKey && dayKey(h.due) === day)
    .sort((a, b) => ts(a.created) - ts(b.created));
  return { given, due };
}

/** Чи вже записано домашнє з цієї пари (прив’язане до неї або внесене з цього предмета після початку). */
export const hasHomeworkFor = (l) => allHomework().some((h) => h.status !== 'rejected'
  && (h.lessonID === l.id || (h.subjectKey === l.subjectKey && ts(h.created) >= l.start.getTime())));

/** «Нічого не задали»: у модераторів позначка діє для всіх, в інших — лише для їхнього акаунта. */
export async function answerNoHomework(lessonId) {
  markAnswered(lessonId);
  if (canModerate()) await api('POST', `/api/lessons/${encodeURIComponent(lessonId)}/no-homework`);
  await sync().catch(() => {});
}

// ───────── Вкладення ─────────

export function attachments(h) {
  const links = (h.links || []).map(safeLink).filter(Boolean);
  const images = h.images || [];
  if (!links.length && !images.length) return '';
  return html`
    ${links.length ? html`<div class="chip-list st-links">${links.map((u) => html`<a class="chip" href="${u}" target="_blank" rel="noopener noreferrer">${icon('link')}<span class="ellipsis">${shortUrl(u)}</span></a>`)}</div>` : ''}
    ${images.length ? html`<div class="thumbs">${images.map((id, i) => html`<button type="button" class="st-thumb-btn" aria-label="${`Відкрити зображення ${i + 1}`}"><img class="thumb" data-img="${id}" alt="${`Зображення ${i + 1}`}"></button>`)}</div>` : ''}`;
}

/** Завантажує зображення з токеном і підставляє їх у img[data-img]. */
export function hydrateImages(root) {
  for (const img of $$('img[data-img]', root)) {
    const id = img.dataset.img;
    img.removeAttribute('data-img');
    imageUrl(id).then((src) => { img.src = src; }).catch(() => {
      const btn = img.closest('.st-thumb-btn');
      if (btn) { btn.classList.add('is-broken'); btn.title = 'Не вдалося завантажити зображення'; }
    });
  }
}

export function bindImageViewer(root) {
  return on(root, 'click', '.st-thumb-btn', (btn) => {
    const img = btn.querySelector('img');
    if (img && img.getAttribute('src')) viewImage(img.src, img.alt || 'Зображення');
  });
}

/** Чи не можна зараз перемальовувати екран: відкрите вікно або введення тексту. */
export function uiBusy(root) {
  if (document.querySelector('.modal-backdrop:not(.closing)')) return true;
  const a = document.activeElement;
  return !!(a && root && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox');
}

// ───────── Терміни здачі: «наступна пара / семінар / практична / лекція» ─────────

const KIND_MODES = [['Сем', 'Наступний семінар'], ['Пз', 'Наступне практичне'], ['Лк', 'Наступна лекція']];

export const nextLessonFor = (subjectKey, base, mode) => lessons()
  .find((l) => l.subjectKey === subjectKey && l.start > base && (mode === 'any' || l.kind === mode)) || null;

export function dueModes(subjectKey, base) {
  const out = [['date', 'Своя дата']];
  if (!subjectKey) return out;
  if (nextLessonFor(subjectKey, base, 'any')) out.push(['any', 'Наступна пара']);
  for (const [k, label] of KIND_MODES) if (nextLessonFor(subjectKey, base, k)) out.push([k, label]);
  return out;
}

/** Термін за замовчуванням для завдання з пари: день наступної пари предмета або наступний день. */
function dueKeyAfter(lesson) {
  const next = nextLessonFor(lesson.subjectKey, lesson.end, 'any');
  return next ? dayKey(next.start) : addDays(dayKey(lesson.start), 1);
}

// ───────── Зображення: стиснення й завантаження ─────────

/** Стискає фото до JPEG (довша сторона ≤ 1600 px, файл ≤ ~1,2 МБ), щоб швидко вантажилося. */
async function compressImage(file) {
  let bmp = null;
  if (window.createImageBitmap) { try { bmp = await createImageBitmap(file); } catch { bmp = null; } }
  if (!bmp) {
    bmp = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не вдалося прочитати зображення.')); };
      im.src = url;
    });
  }
  const w0 = bmp.width || bmp.naturalWidth;
  const h0 = bmp.height || bmp.naturalHeight;
  if (!w0 || !h0) throw new Error('Не вдалося прочитати зображення.');
  try {
    for (const [side, quality] of [[1600, 0.78], [1280, 0.65], [1024, 0.5], [800, 0.45]]) {
      const k = Math.min(1, side / Math.max(w0, h0));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w0 * k));
      canvas.height = Math.max(1, Math.round(h0 * k));
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (blob && blob.size <= 1.2 * 1024 * 1024) return blob;
    }
  } finally {
    if (bmp.close) bmp.close();
  }
  throw new Error('Зображення завелике.');
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('Не вдалося прочитати файл.'));
  r.readAsDataURL(blob);
});

const isImageFile = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);

/** Текст помилки лише якщо він українською (повідомлення браузера бувають англійськими). */
export const ukText = (e, fallback) => (e && /[а-яіїєґ]/i.test(e.message || '') ? e.message : fallback);

function normLink(v) {
  let t = String(v || '').trim();
  if (!t) return '';
  if (!t.includes('://')) t = `https://${t}`;
  try {
    const u = new URL(t);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.toString() : null;
  } catch { return null; }
}

// ───────── Редактор завдання ─────────

/**
 * Відкриває вікно створення/редагування домашнього.
 * { hw } — редагувати наявне; { lessonId } — нове з прив’язкою до пари.
 * Повертає Promise<boolean>: true, якщо щось збережено, видалено чи відмічено.
 */
export function openHomeworkEditor({ hw = null, lessonId = null } = {}) {
  const editing = !!hw;
  const mod = canModerate();
  const lesson = lessonById(editing ? hw.lessonID : lessonId);
  const item = {
    subjectKey: editing ? hw.subjectKey : lesson ? lesson.subjectKey : '',
    lessonID: editing ? hw.lessonID || null : lesson ? lesson.id : null,
    dueKey: editing ? dayKey(hw.due) : lesson ? dueKeyAfter(lesson) : addDays(todayKey(), 1),
    mode: 'date',
    links: editing ? [...(hw.links || [])] : [],
    images: editing ? [...(hw.images || [])] : [],
  };
  if (!editing && lesson && nextLessonFor(lesson.subjectKey, lesson.end, 'any')) item.mode = 'any';
  const rejected = editing && hw.status === 'rejected';
  const resubmit = rejected && !mod;
  const keys = subjectKeys();
  if (item.subjectKey && !keys.includes(item.subjectKey)) keys.push(item.subjectKey);
  keys.sort((a, b) => subjectName(a).localeCompare(subjectName(b), 'uk'));
  const previews = new Map();
  let uploading = 0;

  const submitLabel = editing ? (resubmit ? 'Надіслати знову' : 'Зберегти') : mod ? 'Додати' : 'Надіслати';
  const m = openModal({
    title: editing ? 'Редагування завдання' : 'Нове домашнє завдання',
    body: html`<form class="st-form" novalidate autocomplete="off">
      ${lesson ? html`<div class="st-context">${icon('calendar')}<span>До пари: <b>${subjectName(lesson.subjectKey)}</b> · ${dayText(dayKey(lesson.start))}, ${fmtTime(lesson.start)}</span></div>` : ''}
      ${!keys.length ? html`<div class="alert warning">${icon('alert')}<div class="grow">У розкладі ще немає предметів, тому записати домашнє поки неможливо. Спершу потрібно завантажити розклад.</div></div>` : ''}
      <div class="field">
        <label class="label" for="hw-subject">Предмет</label>
        <select class="select" id="hw-subject" name="subject" ${item.subjectKey ? '' : 'autofocus'}>
          ${item.subjectKey ? '' : html`<option value="" selected disabled>Оберіть предмет</option>`}
          ${keys.map((k) => html`<option value="${k}" ${k === item.subjectKey ? 'selected' : ''}>${subjectName(k)}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="label" for="hw-text">Що задали</label>
        <textarea class="textarea" id="hw-text" name="text" rows="4" maxlength="${MAX_TEXT}" placeholder="Наприклад: § 12, вправи 3–7" ${item.subjectKey ? 'autofocus' : ''}>${editing ? hw.text : ''}</textarea>
      </div>
      <div class="field">
        <span class="label" id="hw-due-label">Здати до</span>
        <div class="segmented st-modes" role="group" aria-labelledby="hw-due-label" data-role="modes"></div>
        <input class="input st-date" type="date" name="due" aria-labelledby="hw-due-label">
        <div class="help" data-role="due-hint" aria-live="polite"></div>
      </div>
      <div class="field">
        <span class="label">Посилання <span class="muted">· до ${MAX_LINKS}</span></span>
        <div class="st-attlist" data-role="links"></div>
        <div class="st-add" data-role="link-add">
          <input class="input" type="url" name="linkInput" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Вставте посилання" aria-label="Нове посилання">
          <button type="button" class="btn btn-secondary" data-action="link-add">Додати</button>
        </div>
      </div>
      <div class="field">
        <span class="label">Зображення <span class="muted">· до ${MAX_IMAGES}</span></span>
        <div class="st-thumbs" data-role="images" hidden></div>
        <div>
          <button type="button" class="btn btn-secondary btn-sm" data-action="pick-image" data-role="pick">${icon('image')} Додати зображення</button>
          <input type="file" accept="image/*" multiple hidden data-role="file">
        </div>
      </div>
      ${!mod && !editing ? html`<div class="alert info">${icon('info')}<div class="grow">Завдання з’явиться в усіх після того, як його підтвердить адміністратор, староста чи заступник.</div></div>` : ''}
      ${rejected ? html`<div class="alert warning">${icon('alert')}<div class="grow">Це завдання відхилили. Виправте його й надішліть знову.</div></div>` : ''}
      <div class="error-text" role="alert" data-role="err" hidden></div>
      ${(!editing && lesson) || (editing && canEditHw(hw)) ? html`<div class="btn-row st-aux">
        ${!editing && lesson ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="no-hw">${icon('check')} Нічого не задали</button>` : ''}
        ${editing && canEditHw(hw) ? html`<button type="button" class="btn btn-danger-soft btn-sm" data-action="delete">${icon('trash')} Видалити завдання</button>` : ''}
      </div>` : ''}
    </form>`,
    footer: html`<button type="button" class="btn btn-secondary" data-close>Скасувати</button>
      <button type="button" class="btn btn-primary" data-action="save" ${keys.length ? '' : 'disabled'}>${submitLabel}</button>`,
  });

  const el = (sel) => m.el.querySelector(sel);
  const subjectEl = el('[name=subject]');
  const dateEl = el('[name=due]');
  const textEl = el('[name=text]');
  const linkInput = el('[name=linkInput]');
  const fileEl = el('[data-role="file"]');
  const showErr = (text) => { const e = el('[data-role="err"]'); e.textContent = text; e.hidden = !text; };

  function refreshDue() {
    const base = lesson ? lesson.end : new Date();
    const modes = dueModes(item.subjectKey, base);
    if (!modes.some(([v]) => v === item.mode)) item.mode = 'date';
    const auto = item.mode !== 'date';
    const next = auto ? nextLessonFor(item.subjectKey, base, item.mode) : null;
    if (next) item.dueKey = dayKey(next.start);
    setHTML(el('[data-role="modes"]'), modes.map(([v, label]) => html`<button type="button" data-action="mode" data-mode="${v}" aria-pressed="${v === item.mode ? 'true' : 'false'}">${label}</button>`));
    dateEl.value = item.dueKey;
    dateEl.readOnly = auto;
    dateEl.tabIndex = auto ? -1 : 0;
    dateEl.classList.toggle('is-locked', auto);
    el('[data-role="due-hint"]').textContent = !auto ? ''
      : next ? `${kindLabel(next.kind)} · ${cap(fmtWeekday(next.start))}, ${fmtDate(next.start)}, ${fmtTime(next.start)}`
        : 'У розкладі такої пари не знайдено — оберіть дату вручну.';
  }

  function drawLinks() {
    setHTML(el('[data-role="links"]'), item.links.map((u, i) => html`<div class="st-att">
      <a href="${u}" target="_blank" rel="noopener noreferrer">${icon('link')}<span class="ellipsis">${shortUrl(u)}</span></a>
      <button type="button" class="icon-btn sm" data-action="link-del" data-i="${i}" aria-label="${`Прибрати посилання ${i + 1}`}">${icon('x')}</button>
    </div>`));
    el('[data-role="link-add"]').hidden = item.links.length >= MAX_LINKS;
  }

  function drawImages() {
    const box = el('[data-role="images"]');
    const cells = item.images.map((id, i) => html`<div class="st-thumb">
      <button type="button" class="st-thumb-btn" aria-label="${`Відкрити зображення ${i + 1}`}"><img class="thumb" ${previews.has(id) ? html`src="${previews.get(id)}"` : html`data-img="${id}"`} alt="${`Зображення ${i + 1}`}"></button>
      <button type="button" class="st-thumb-x" data-action="img-del" data-i="${i}" aria-label="${`Прибрати зображення ${i + 1}`}">${icon('x')}</button>
    </div>`);
    for (let i = 0; i < uploading; i++) cells.push(html`<div class="st-thumb st-uploading" role="status" aria-label="Завантаження зображення"><span class="spinner" aria-hidden="true"></span></div>`);
    setHTML(box, cells);
    box.hidden = !cells.length;
    hydrateImages(box);
    el('[data-role="pick"]').hidden = item.images.length + uploading >= MAX_IMAGES;
  }

  function addLink() {
    const raw = linkInput.value.trim();
    if (!raw) return true;
    const url = normLink(raw);
    if (url === null) { showErr('Некоректне посилання. Перевірте адресу.'); linkInput.setAttribute('aria-invalid', 'true'); linkInput.focus(); return false; }
    if (item.links.length >= MAX_LINKS) { showErr(`Не більше ${MAX_LINKS} посилань.`); return false; }
    if (!item.links.includes(url)) item.links.push(url);
    linkInput.value = '';
    linkInput.removeAttribute('aria-invalid');
    showErr('');
    drawLinks();
    return true;
  }

  async function addFiles(list) {
    const room = MAX_IMAGES - item.images.length - uploading;
    const files = list.filter(isImageFile);
    if (!files.length) { showErr('Оберіть файл зображення (JPEG, PNG чи WebP).'); return; }
    if (room <= 0) { showErr(`Можна додати не більше ${MAX_IMAGES} зображень.`); return; }
    const take = files.slice(0, room);
    showErr(files.length > take.length ? `Додано лише ${take.length} із ${files.length}: ліміт — ${MAX_IMAGES} зображень.` : '');
    uploading += take.length;
    drawImages();
    for (const file of take) {
      try {
        const blob = await compressImage(file);
        const { id } = await api('POST', '/api/images', { data: await blobToDataUrl(blob) });
        previews.set(id, URL.createObjectURL(blob));
        item.images.push(id);
      } catch (e) {
        showErr(ukText(e, 'Не вдалося додати зображення.'));
      }
      uploading -= 1;
      drawImages();
    }
  }

  async function save(btn) {
    showErr('');
    item.subjectKey = subjectEl.value;
    const text = textEl.value.trim();
    if (!item.subjectKey) { showErr('Оберіть предмет.'); subjectEl.focus(); return; }
    if (!text) { showErr('Опишіть, що задали.'); textEl.focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dueKey) || Number.isNaN(kyivMidnight(item.dueKey).getTime())) { showErr('Вкажіть дату, до якої треба здати.'); dateEl.focus(); return; }
    if (!addLink()) return;
    if (uploading > 0) { showErr('Зачекайте — зображення ще завантажується.'); return; }
    await busy(btn, async () => {
      try {
        const body = {
          subjectKey: item.subjectKey, lessonID: item.lessonID || null, text,
          due: kyivMidnight(item.dueKey).toISOString(), links: item.links, images: item.images,
        };
        if (editing) await api('PATCH', `/api/homework/${encodeURIComponent(hw.id)}`, body);
        else await api('POST', '/api/homework', body);
        if (item.lessonID) markAnswered(item.lessonID);
        await sync().catch(() => {});
        toastSuccess(resubmit || (!editing && !mod) ? 'Надіслано на підтвердження старості чи адміністратору.' : editing ? 'Зміни збережено.' : 'Домашнє додано.');
        m.close(true);
      } catch (e) {
        showErr(e.message);
      }
    });
  }

  async function remove(btn) {
    const ok = await confirmDialog({
      title: 'Видалити завдання?', text: 'Його разом із прикріпленими зображеннями буде видалено без можливості відновлення.',
      confirmText: 'Видалити', danger: true,
    });
    if (!ok) return;
    await busy(btn, async () => {
      try {
        await api('DELETE', `/api/homework/${encodeURIComponent(hw.id)}`);
        await sync().catch(() => {});
        toastSuccess('Завдання видалено.');
        m.close(true);
      } catch (e) { showErr(e.message); }
    });
  }

  async function none(btn) {
    await busy(btn, async () => {
      try {
        await answerNoHomework(lesson.id);
        toast('Позначено: на цю пару нічого не задали.', { type: 'success' });
        m.close(true);
      } catch (e) { showErr(e.message); }
    });
  }

  actions(m.el, {
    mode: (b) => { item.mode = b.dataset.mode; refreshDue(); },
    'link-add': () => { addLink(); linkInput.focus(); },
    'link-del': (b) => { item.links.splice(Number(b.dataset.i), 1); drawLinks(); },
    'pick-image': () => fileEl.click(),
    'img-del': (b) => { item.images.splice(Number(b.dataset.i), 1); drawImages(); },
    save, delete: remove, 'no-hw': none,
  });
  bindImageViewer(m.el);
  subjectEl.addEventListener('change', () => { item.subjectKey = subjectEl.value; refreshDue(); });
  dateEl.addEventListener('input', () => { item.dueKey = dateEl.value; });
  linkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });
  linkInput.addEventListener('input', () => linkInput.removeAttribute('aria-invalid'));
  fileEl.addEventListener('change', () => { const files = [...fileEl.files]; fileEl.value = ''; if (files.length) addFiles(files); });
  m.el.querySelector('form').addEventListener('submit', (e) => e.preventDefault());

  refreshDue();
  drawLinks();
  drawImages();
  m.closed.then(() => previews.forEach((u) => URL.revokeObjectURL(u)));
  return m.closed.then((v) => v === true);
}

// ───────── Екран «Домашнє» ─────────

/** «Прізвище Ім’я» без по батькові — для компактного підпису автора. */
const shortName = (n) => String(n || '').trim().split(/\s+/).slice(0, 2).join(' ');

function hwItem(h, today) {
  const approved = h.status === 'approved';
  const done = approved && isDone(h.id);
  const key = dayKey(h.due);
  const late = !done && key < today;
  const name = subjectName(h.subjectKey);
  return html`<div class="hw ${done ? 'done' : ''}" data-id="${h.id}">
    <div class="check">${approved
    ? html`<input type="checkbox" data-done="${h.id}" ${done ? 'checked' : ''} aria-label="${`Виконано: ${name}`}">`
    : html`<span class="st-state ${h.status}" title="${h.status === 'pending' ? 'Очікує підтвердження' : 'Відхилено'}">${icon(h.status === 'pending' ? 'clock' : 'x-circle')}</span>`}</div>
    <div class="body">
      <div class="subj"><i class="st-dot" style="--lc:${colorFor(h.subjectKey)}"></i>${name}${statusBadge(h)}</div>
      <div class="text">${h.text}</div>
      ${attachments(h)}
      <div class="meta">
        <span class="${late ? 'danger-text' : ''}">${icon('calendar')} ${dueText(key)}</span>
        ${isMine(h) ? html`<span>Ви додали</span>` : h.authorName ? html`<span title="${h.authorName}">Додав(ла): ${shortName(h.authorName)}</span>` : ''}
      </div>
    </div>
    ${canEditHw(h) ? html`<div class="st-hw-actions">
      <button type="button" class="icon-btn sm" data-action="hw-edit" data-id="${h.id}" aria-label="${`Редагувати завдання: ${name}`}">${icon('edit')}</button>
      <button type="button" class="icon-btn sm" data-action="hw-del" data-id="${h.id}" aria-label="${`Видалити завдання: ${name}`}">${icon('trash')}</button>
    </div>` : ''}
  </div>`;
}

const section = (title, list, today, { hint = '', tone = '' } = {}) => (list.length ? html`<section class="section">
  <div class="section-head"><h2>${title} <span class="count ${tone === 'danger' ? '' : 'muted'}">${list.length}</span></h2>${hint ? html`<span class="hint">${hint}</span>` : ''}</div>
  <div class="card">${list.map((h) => hwItem(h, today))}</div>
</section>` : '');

export default async function view(ctx) {
  const root = ctx.root;
  if (!store.data) await sync();
  if (!ctx.isActive()) return;
  let filter = '';

  const openEditor = (args) => openHomeworkEditor(args).then(() => { if (ctx.isActive()) draw(); });

  function draw() {
    const today = todayKey();
    const tomorrow = addDays(today, 1);
    const items = allHomework();
    const subjects = [...new Set(items.map((h) => h.subjectKey))].sort((a, b) => subjectName(a).localeCompare(subjectName(b), 'uk'));
    if (filter && !subjects.includes(filter)) filter = '';
    const list = filter ? items.filter((h) => h.subjectKey === filter) : items;
    const open = list.filter((h) => !(h.status === 'approved' && isDone(h.id)));
    const doneAll = list.filter((h) => h.status === 'approved' && isDone(h.id)).sort((a, b) => byDue(b, a));
    const sec = {
      today: open.filter((h) => dayKey(h.due) === today).sort(byDue),
      tomorrow: open.filter((h) => dayKey(h.due) === tomorrow).sort(byDue),
      later: open.filter((h) => dayKey(h.due) > tomorrow).sort(byDue),
      overdue: open.filter((h) => dayKey(h.due) < today).sort(byDue),
      done: doneAll.slice(0, 15),
    };
    const pending = canModerate() ? items.filter((h) => h.status === 'pending').length : 0;
    const waiting = open.filter((h) => h.status === 'approved').length;
    const subtitle = !items.length ? '' : waiting ? `Невиконано: ${waiting}${sec.overdue.length ? ` · прострочено: ${sec.overdue.length}` : ''}` : 'Усе виконано';

    setHTML(root, html`<div class="st-page has-fab">
      ${pageHead({
    title: 'Домашнє', subtitle,
    actions: html`<button type="button" class="btn btn-primary desktop-only" data-action="add">${icon('plus')} Додати завдання</button>`,
  })}
      ${pending ? html`<div class="alert warning mb4">${icon('clipboard')}<div class="grow"><strong>Чекають підтвердження: ${pending}</strong>Перегляньте нові завдання від студентів.</div><a class="btn btn-secondary btn-sm" href="/admin/moderation">Перевірити</a></div>` : ''}
      ${subjects.length > 1 ? html`<div class="st-filter" role="group" aria-label="Фільтр за предметом">
        <button type="button" class="chip ${filter ? '' : 'active'}" data-action="filter" data-subject="" aria-pressed="${filter ? 'false' : 'true'}">Усі предмети</button>
        ${subjects.map((k) => html`<button type="button" class="chip ${filter === k ? 'active' : ''}" data-action="filter" data-subject="${k}" aria-pressed="${filter === k ? 'true' : 'false'}"><span class="ellipsis">${subjectName(k)}</span></button>`)}
      </div>` : ''}
      ${!items.length
    ? emptyState({
      icon: 'book', title: 'Домашніх завдань поки немає',
      text: 'Щойно щось зададуть, воно з’явиться тут. Ви також можете записати завдання самі.',
      action: html`<button type="button" class="btn btn-primary" data-action="add">${icon('plus')} Додати завдання</button>`,
    })
    : !list.length ? emptyState({ icon: 'filter', title: 'За цим предметом завдань немає', compact: true })
      : html`
        ${section('На сьогодні', sec.today, today, { hint: fmtDate(dayDate(today)) })}
        <section class="section">
          <div class="section-head"><h2>На завтра ${sec.tomorrow.length ? html`<span class="count muted">${sec.tomorrow.length}</span>` : ''}</h2><span class="hint">${fmtDate(dayDate(tomorrow))}</span></div>
          ${sec.tomorrow.length ? html`<div class="card">${sec.tomorrow.map((h) => hwItem(h, today))}</div>` : html`<div class="card card-pad muted">На завтра нічого не задано.</div>`}
        </section>
        ${section('Пізніше', sec.later, today)}
        ${section('Прострочене', sec.overdue, today, { tone: 'danger' })}
        ${section('Виконане', sec.done, today, { hint: doneAll.length > 15 ? 'показано останні 15' : '' })}`}
      <button type="button" class="fab mobile-only" data-action="add" aria-label="Додати завдання">${icon('plus')}</button>
    </div>`);
    hydrateImages(root);
  }

  ctx.onCleanup(actions(root, {
    add: () => openEditor({}),
    filter: (b) => { filter = b.dataset.subject; draw(); },
    'hw-edit': (b) => { const hw = allHomework().find((h) => h.id === b.dataset.id); if (hw) openEditor({ hw }); },
    'hw-del': async (b) => {
      const hw = allHomework().find((h) => h.id === b.dataset.id);
      if (!hw) return;
      const ok = await confirmDialog({ title: 'Видалити завдання?', text: `«${subjectName(hw.subjectKey)}»: завдання буде видалено без можливості відновлення.`, confirmText: 'Видалити', danger: true });
      if (!ok) return;
      try {
        await api('DELETE', `/api/homework/${encodeURIComponent(hw.id)}`);
        await sync().catch(() => {});
        toastSuccess('Завдання видалено.');
      } catch (e) { toast(e.message, { type: 'error' }); }
      if (ctx.isActive()) draw();
    },
  }));
  ctx.onCleanup(on(root, 'change', 'input[data-done]', (box) => {
    toggleDone(box.dataset.done, box.checked);
    const row = box.closest('.hw');
    if (row) row.classList.toggle('done', box.checked);
    setTimeout(() => { if (ctx.isActive() && !uiBusy(root)) draw(); }, 320);
  }));
  ctx.onCleanup(bindImageViewer(root));
  ctx.onCleanup(onStore('sync', () => { if (!uiBusy(root)) draw(); }));

  draw();

  // Глибоке посилання «Що задали?»: /homework?lesson=<id>&new=1
  if (ctx.query.get('new') === '1') {
    const lid = ctx.query.get('lesson');
    history.replaceState(history.state, '', location.pathname);
    if (lid && !lessonById(lid)) toast('Пару не знайдено — можливо, розклад оновився. Оберіть предмет вручну.', { type: 'info' });
    openEditor({ lessonId: lid });
  }
}
