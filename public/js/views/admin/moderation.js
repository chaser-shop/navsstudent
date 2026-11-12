// Модерація: домашнє на підтвердження та нещодавні пари, з яких ще нічого не записано.

import { api } from '../../core/api.js';
import { adminNavItems } from '../../main.js';
import { html, setHTML, actions, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { store, sync, on as onStore, subjectName } from '../../core/store.js';
import { fmtTime, dayKey, relTime, colorFor } from '../../core/format.js';
import { toastError, toastSuccess, confirmDialog, emptyState, pageHead } from '../../core/ui.js';
import {
  openHomeworkEditor, allHomework, lessons, kindLabel, placeLabel, hasHomeworkFor, answerNoHomework, attachments,
  hydrateImages, bindImageViewer, dueText, todayKey, addDays, relDay, uiBusy,
} from '../homework.js';

/** Горизонтальна навігація розділами керування (на телефонах бічного меню немає). */
export function adminSubnav() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const items = adminNavItems();
  if (items.length < 2) return '';
  return html`<nav class="subnav mobile-only" aria-label="Розділи керування">${items.map((i) => {
    const on = i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`);
    return html`<a href="${i.href}" class="${on ? 'active' : ''}" ${on ? html`aria-current="page"` : ''}>${i.label}</a>`;
  })}</nav>`;
}
/** Прокручує навігацію так, щоб активний розділ було видно. */
export function revealSubnav(root) {
  const a = root.querySelector('.subnav a.active');
  if (a) a.parentElement.scrollLeft = Math.max(0, a.offsetLeft - 16);
}

const created = (h) => Date.parse(h.created) || 0;

function pendingList() {
  return allHomework().filter((h) => h.status === 'pending').sort((a, b) => created(a) - created(b));
}

/** Пари, що вже закінчилися сьогодні чи вчора, без домашнього й без позначки «нічого не задали». */
function lessonsWithoutHomework() {
  const now = new Date();
  const today = todayKey();
  const days = [today, addDays(today, -1)];
  const none = new Set((store.data && store.data.noHomework) || []);
  return lessons()
    .filter((l) => l.end <= now && days.includes(dayKey(l.start)) && !none.has(l.id) && !hasHomeworkFor(l))
    .sort((a, b) => b.end - a.end);
}

function pendingCard(h) {
  const name = subjectName(h.subjectKey);
  return html`<article class="card st-modcard" data-id="${h.id}">
    <div class="card-body">
      <div class="flex between start wrap">
        <div class="strong"><i class="st-dot" style="--lc:${colorFor(h.subjectKey)}"></i>${name}</div>
        <span class="badge warning">${icon('clock')}Очікує підтвердження</span>
      </div>
      <div class="st-hwtext">${h.text}</div>
      ${attachments(h)}
      <div class="meta st-meta">
        <span>${icon('calendar')} Здати: ${dueText(dayKey(h.due))}</span>
        ${h.authorName ? html`<span>${icon('user')} ${h.authorName}</span>` : ''}
        ${created(h) ? html`<span>${icon('clock')} Надіслано ${relTime(h.created)}</span>` : ''}
      </div>
    </div>
    <div class="card-foot btn-row">
      <button type="button" class="btn btn-success btn-sm" data-action="approve" data-id="${h.id}">${icon('check')} Підтвердити</button>
      <button type="button" class="btn btn-danger-soft btn-sm" data-action="reject" data-id="${h.id}">${icon('x')} Відхилити</button>
      <button type="button" class="icon-btn sm st-edit-btn" data-action="edit" data-id="${h.id}" title="Редагувати" aria-label="${`Редагувати завдання: ${name}`}">${icon('edit')}</button>
    </div>
  </article>`;
}

function lessonItem(l) {
  const key = dayKey(l.start);
  const place = placeLabel(l);
  return html`<div class="list-item st-modrow">
    <i class="st-bar" style="--lc:${colorFor(l.subjectKey)}"></i>
    <div class="grow">
      <div class="title">${subjectName(l.subjectKey)}</div>
      <div class="meta wrap">${relDay(key)} · ${fmtTime(l.start)}–${fmtTime(l.end)} · ${kindLabel(l.kind)}${place ? ` · ${place}` : ''}</div>
    </div>
    <div class="st-actions">
      <button type="button" class="btn btn-soft btn-sm" data-action="add" data-id="${l.id}">${icon('plus')} Записати ДЗ</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="none" data-id="${l.id}">Нічого не задали</button>
    </div>
  </div>`;
}

export default async function view(ctx) {
  const root = ctx.root;
  if (!store.data) await sync();
  if (!ctx.isActive()) return;

  function draw() {
    const pending = pendingList();
    const open = lessonsWithoutHomework();
    setHTML(root, html`<div class="st-page">
      ${pageHead({ title: 'Модерація', subtitle: 'Завдання від студентів і пари, з яких ще не записано домашнє' })}
      ${adminSubnav()}
      ${!pending.length && !open.length
    ? html`<div class="card">${emptyState({ icon: 'check-circle', title: 'Усе перевірено', text: 'Немає завдань на підтвердження й пар без запису про домашнє.' })}</div>`
    : html`
        <section class="section">
          <div class="section-head"><h2>На підтвердження ${pending.length ? html`<span class="count">${pending.length}</span>` : ''}</h2></div>
          ${pending.length ? html`<div class="stack">${pending.map(pendingCard)}</div>`
    : html`<div class="card card-pad muted">Нових завдань на підтвердження немає.</div>`}
        </section>
        <section class="section">
          <div class="section-head"><h2>Пари без запису про домашнє ${open.length ? html`<span class="count muted">${open.length}</span>` : ''}</h2><span class="hint">сьогодні й учора</span></div>
          ${open.length ? html`<div class="card">${open.map(lessonItem)}</div>`
    : html`<div class="card card-pad muted">Усі нещодавні пари мають запис про домашнє чи позначку «Нічого не задали».</div>`}
        </section>`}
    </div>`);
    hydrateImages(root);
    revealSubnav(root);
  }

  const reload = () => { if (ctx.isActive()) draw(); };
  const act = (btn, fn) => busy(btn, async () => {
    try { await fn(); } catch (e) { toastError(e); }
  });

  ctx.onCleanup(actions(root, {
    approve: (btn) => act(btn, async () => {
      await api('POST', `/api/homework/${encodeURIComponent(btn.dataset.id)}/approve`);
      await sync();
      toastSuccess('Завдання підтверджено — його бачать усі студенти.');
      reload();
    }),
    reject: async (btn) => {
      const ok = await confirmDialog({
        title: 'Відхилити завдання?', text: 'Автор побачить, що завдання відхилено, і зможе виправити та надіслати його знову.',
        confirmText: 'Відхилити', danger: true,
      });
      if (!ok) return;
      await act(btn, async () => {
        await api('POST', `/api/homework/${encodeURIComponent(btn.dataset.id)}/reject`);
        await sync();
        toastSuccess('Завдання відхилено.');
        reload();
      });
    },
    edit: (btn) => {
      const hw = allHomework().find((h) => h.id === btn.dataset.id);
      if (hw) openHomeworkEditor({ hw }).then(reload);
    },
    add: (btn) => openHomeworkEditor({ lessonId: btn.dataset.id }).then(reload),
    none: (btn) => act(btn, async () => {
      await answerNoHomework(btn.dataset.id);
      toastSuccess('Позначено: на цю пару нічого не задали.');
      reload();
    }),
  }));
  ctx.onCleanup(bindImageViewer(root));
  ctx.onCleanup(onStore('sync', () => { if (!uiBusy(root)) draw(); }));
  draw();
}
