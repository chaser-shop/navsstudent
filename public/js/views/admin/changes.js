// Зміни балів (/admin/changes): журнал змін за джерелами, пошук і фільтри, скасування помилкових змін студентів.

import { api } from '../../core/api.js';
import { html, setHTML, actions, on, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { pageHead, skeleton, emptyState, confirmDialog, toast, toastError } from '../../core/ui.js';
import { fmtNum, fmtDate, fmtDateYear, fmtTime, changesWord } from '../../core/format.js';
import {
  segmented, setPressed, apiQuery, replaceQuery, debounce, sequencer, studentLink, sourceBadge, changeValues, deltaPill,
  percentNote, revertedBadge, inlineError,
} from './ad-kit.js';

const DEFAULTS = { source: 'student' };
const SOURCES = [
  { value: 'student', label: 'Студенти' },
  { value: 'sheet', label: 'Google Таблиця' },
  { value: 'admin', label: 'Адміністратор' },
  { value: 'import', label: 'Імпорт' },
  { value: 'all', label: 'Усі' },
];
const EMPTY_TEXT = {
  student: 'Студенти ще не підвищували бали або за цими умовами змін немає.',
  sheet: 'Зміни з Google Таблиці з’являться після синхронізації, коли в таблиці щось зміниться.',
  admin: 'Адміністратор ще не змінював бали вручну.',
  import: 'Імпорту таблиць із файлу ще не було.',
  all: 'За цими умовами змін не знайдено.',
};

const thisYear = new Date().getFullYear();
const dateOf = (at) => (new Date(at).getFullYear() === thisYear ? fmtDate(at) : fmtDateYear(at));

export default async function view(ctx) {
  const root = ctx.root;
  const q = ctx.query;
  const state = {
    source: SOURCES.some((s) => s.value === q.get('source')) ? q.get('source') : DEFAULTS.source,
    q: q.get('q') || '',
    group: q.get('group') || '',
    subject: q.get('subject') || '',
  };
  const page = (extra = {}) => api('GET', `/api/admin/score-changes${apiQuery({ ...state, limit: 50, ...extra })}`);

  setHTML(root, html`${pageHead({ title: 'Зміни балів', subtitle: 'Журнал усіх змін: хто, коли й що змінив', compact: true })}${skeleton(3)}`);
  const [first, meta] = await Promise.all([page(), api('GET', '/api/admin/students?status=all').catch(() => null)]);
  if (!ctx.isActive()) return;
  const groups = meta ? meta.groups : [];
  const subjects = meta ? meta.subjects : [];
  const names = meta ? meta.subjectNames : {};
  let list = { items: first.items, more: first.more, next: first.next };

  const seq = sequencer();

  setHTML(root, html`
    ${pageHead({ title: 'Зміни балів', subtitle: 'Журнал усіх змін: хто, коли й що змінив', compact: true })}
    <div class="card card-pad ad-filters ad-filters-changes" role="search" aria-label="Фільтри журналу змін">
      <div class="field ad-f-search">
        <span class="label">Джерело змін</span>
        ${segmented({ action: 'source', options: SOURCES, value: state.source, label: 'Джерело змін' })}
      </div>
      <div class="field">
        <label class="label" for="ad-ch-q">Студент</label>
        <div class="input-group">${icon('search')}<input class="input" id="ad-ch-q" type="search" data-filter="q" placeholder="Пошук за ПІБ" autocomplete="off" value="${state.q}"></div>
      </div>
      <div class="field">
        <label class="label" for="ad-ch-group">Група</label>
        <select class="select" id="ad-ch-group" data-filter="group">
          <option value="">Усі групи</option>
          ${groups.map((g) => html`<option value="${g.name}" ${g.name === state.group ? 'selected' : ''}>${g.name}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="label" for="ad-ch-subject">Предмет</label>
        <select class="select" id="ad-ch-subject" data-filter="subject">
          <option value="">Будь-який предмет</option>
          ${subjects.map((s) => html`<option value="${s}" ${s === state.subject ? 'selected' : ''}>${names[s] || s}</option>`)}
        </select>
      </div>
    </div>
    <div id="ad-ch-results" class="ad-body" aria-live="polite"></div>`);

  const results = root.querySelector('#ad-ch-results');

  function row(item) {
    const who = item.source === 'student' || item.source === 'sheet' || item.source === 'baseline' ? '' : item.userName;
    return html`<tr class="${item.reverted ? 'ad-reverted' : ''}">
      <td class="nowrap" data-label="Дата й час"><span class="ad-cell">${dateOf(item.at)}<small class="ad-sub">${fmtTime(item.at)}</small></span></td>
      <td class="primary" data-label="Студент"><span class="ad-cell">${studentLink(item.ratingId, item.studentName)}${item.group ? html`<small class="ad-sub">${item.group}</small>` : ''}</span></td>
      <td data-label="Предмет"><span class="ad-cell">${item.subjectName}</span></td>
      <td class="r" data-label="Зміна"><span class="ad-cell"><span class="ad-line">${changeValues(item)}</span><span class="ad-line">${deltaPill(item)} ${percentNote(item)}</span></span></td>
      <td data-label="Хто змінив"><span class="ad-cell">${sourceBadge(item.source)}${who ? html`<small class="ad-sub">${who}</small>` : ''}</span></td>
      <td class="r ${item.reverted || item.revertable ? '' : 'ad-empty'}" data-label="Стан"><span class="ad-cell">${item.reverted ? revertedBadge(item) : item.revertable ? html`<button type="button" class="btn btn-danger-soft btn-sm" data-action="revert" data-id="${item.id}">${icon('undo')} Скасувати</button>` : ''}</span></td>
    </tr>`;
  }

  function renderResults() {
    const items = list.items;
    if (!items.length) {
      const filtered = state.q || state.group || state.subject;
      setHTML(results, html`<div class="card mt4">${emptyState({
        icon: 'history', title: 'Змін не знайдено',
        text: filtered ? 'Змініть пошуковий запит або фільтри.' : EMPTY_TEXT[state.source],
      })}</div>`);
      return;
    }
    setHTML(results, html`
      <div class="muted small mt4 mb3">Показано: <strong>${fmtNum(items.length, 0)}</strong> ${changesWord(items.length)}${list.more ? ' · є ще' : ''}</div>
      <div class="card"><div class="table-wrap"><table class="table responsive ad-table">
        <thead><tr><th scope="col">Дата й час</th><th scope="col">Студент</th><th scope="col">Предмет</th><th scope="col" class="r">Зміна</th><th scope="col">Хто змінив</th><th scope="col" class="r">Стан</th></tr></thead>
        <tbody>${items.map(row)}</tbody>
      </table></div></div>
      ${list.more ? html`<div class="center mt4"><button type="button" class="btn btn-secondary" data-action="more">Показати ще</button></div>` : ''}`);
  }

  async function load(extra = {}) {
    const id = seq.next();
    results.classList.add('ad-dim');
    try {
      const next = await page(extra);
      if (!ctx.isActive() || !seq.isLatest(id)) return;
      list = { items: next.items, more: next.more, next: next.next };
      renderResults();
    } catch (e) {
      if (!ctx.isActive() || !seq.isLatest(id)) return;
      setHTML(results, html`<div class="mt4">${inlineError(e)}</div>`);
    } finally {
      if (seq.isLatest(id)) results.classList.remove('ad-dim');
    }
  }

  const changed = () => { replaceQuery(state, DEFAULTS); load(); };
  const typed = debounce(changed, 320);
  ctx.onCleanup(() => typed.cancel());

  async function more(btn) {
    await busy(btn, async () => {
      try {
        const r = await page({ before: list.next });
        if (!ctx.isActive()) return;
        const known = new Set(list.items.map((i) => i.id));
        list = { items: [...list.items, ...r.items.filter((i) => !known.has(i.id))], more: r.more, next: r.next };
        renderResults();
      } catch (e) {
        toastError(e);
      }
    });
  }

  async function revert(btn, id) {
    const item = list.items.find((i) => i.id === id);
    if (!item) return;
    const ok = await confirmDialog({
      title: 'Скасувати зміну бала?',
      text: `Бал студента «${item.studentName}» з предмета «${item.subjectName}» повернеться з ${fmtNum(item.value)} до ${fmtNum(item.previous)}. Цю дію буде записано в журнал змін.`,
      confirmText: 'Скасувати зміну', cancelText: 'Не скасовувати', danger: true,
    });
    if (!ok) return;
    await busy(btn, async () => {
      try {
        await api('POST', `/api/admin/score-changes/${encodeURIComponent(id)}/revert`, {});
        toast(`Зміну скасовано: бал повернуто до ${fmtNum(item.previous)}.`, { type: 'success' });
      } catch (e) {
        toastError(e);
      }
    });
    if (ctx.isActive()) await load({ limit: Math.min(200, Math.max(50, list.items.length)) });
  }

  ctx.onCleanup(actions(root, {
    source: (el) => {
      if (state.source === el.dataset.value) return;
      state.source = el.dataset.value;
      setPressed(root.querySelector('.ad-filters-changes .segmented'), state.source);
      changed();
    },
    more: (el) => more(el),
    revert: (el) => revert(el, el.dataset.id),
    retry: () => load(),
  }));
  ctx.onCleanup(on(root, 'input', 'input[data-filter="q"]', (el) => { state.q = el.value.trim(); typed(); }));
  ctx.onCleanup(on(root, 'change', 'select[data-filter]', (el) => { state[el.dataset.filter] = el.value; changed(); }));

  renderResults();
}
