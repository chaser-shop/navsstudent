// Синхронізація (/admin/sync): стан підключення до Google Таблиці, правила злиття, конфлікти та історія запусків.

import { api } from '../../core/api.js';
import { html, setHTML, actions, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { pageHead, skeleton, emptyState, confirmDialog, toast, toastError } from '../../core/ui.js';
import { fmtNum, relTime, plural, studentsWord, subjectsWord, sourceLabel } from '../../core/format.js';
import {
  MODE_HINTS, modeLabel, syncVerdict, statusPill, runBadge, fmtDuration, intervalText, exactTime, studentLink, uiLocked,
} from './ad-kit.js';

const IDLE_MS = 30000;
const BUSY_MS = 3000;

const RULES = [
  ['Незмінна клітинка нічого не перезаписує.', 'Якщо значення в таблиці не змінювалося, новіші бали студента чи адміністратора залишаються як є.'],
  ['Збільшене значення застосовується завжди.', 'Якщо в таблиці бал зріс, у журналі він теж оновлюється.'],
  ['Зменшене значення — лише коли це безпечно.', 'Воно застосовується, якщо поточний бал теж прийшов із таблиці. Інакше створюється конфлікт, який вирішує адміністратор.'],
  ['Нічого не видаляється.', 'Студентів, яких немає в таблиці, позначають неактивними, а їхня історія зберігається.'],
];

function runSummary(r) {
  if (r.status === 'error') return '—';
  const parts = [
    [r.created, 'нових студентів'], [r.updated, 'оновлено записів'], [r.scoreChanges, 'змін балів'], [r.infoChanges, 'змін даних студентів'],
    [r.deactivated, 'деактивовано'], [r.reactivated, 'повернено в рейтинг'], [r.conflicts, 'конфліктів'], [r.deferred, 'відкладено'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${label}: ${fmtNum(n, 0)}`);
  return parts.length ? parts.join(' · ') : 'Змін немає';
}

function connectionCard(d) {
  const s = d.state || {};
  const v = syncVerdict({ enabled: d.enabled, lastError: s.lastError, lastSuccessAt: s.lastSuccessAt });
  const totals = s.totals || {};
  let next = '—';
  if (d.enabled) {
    if (d.busy) next = 'Виконується зараз…';
    else if (d.nextRunAt) next = +new Date(d.nextRunAt) <= Date.now() ? 'Найближчим часом' : relTime(d.nextRunAt);
  }
  return html`<section class="card card-pad ad-sync" aria-labelledby="ad-sync-title">
    <div class="ad-sync-top">
      <div class="ad-sync-title">
        <div class="flex wrap">${statusPill(v)}<span class="muted small">${modeLabel(d.mode)}</span></div>
        <h2 id="ad-sync-title">Підключення до Google Таблиці</h2>
      </div>
    </div>
    <p class="muted mt3">${d.enabled ? (MODE_HINTS[d.mode] || '') : 'Синхронізацію вимкнено: не вказано таблицю, з якої потрібно зчитувати рейтинг.'}</p>
    <dl class="ad-facts">
      <div><dt>Таблиця</dt><dd>${d.sheetUrl ? html`<a href="${d.sheetUrl}" target="_blank" rel="noopener noreferrer">Відкрити ${icon('external')}</a>` : '—'}</dd></div>
      <div><dt>Група в таблиці</dt><dd>${d.group || '—'}</dd></div>
      <div><dt>Перевірка за розкладом</dt><dd>${intervalText(d.intervalMs)}</dd></div>
      <div><dt>Наступна синхронізація</dt><dd>${next}</dd></div>
      <div><dt>Остання успішна синхронізація</dt><dd>${s.lastSuccessAt ? html`${relTime(s.lastSuccessAt)}<small>${exactTime(s.lastSuccessAt)}</small>` : 'Ще не було'}</dd></div>
      <div><dt>Остання перевірка</dt><dd>${s.lastAttemptAt ? html`${relTime(s.lastAttemptAt)}<small>${exactTime(s.lastAttemptAt)}</small>` : 'Ще не було'}</dd></div>
      <div><dt>Остання зміна даних</dt><dd>${s.lastChangeAt ? html`${relTime(s.lastChangeAt)}<small>${exactTime(s.lastChangeAt)}</small>` : 'Змін ще не було'}</dd></div>
      <div><dt>Прочитано з таблиці</dt><dd>${s.students != null ? html`${fmtNum(s.students, 0)} ${studentsWord(s.students)}<small>${fmtNum(s.subjects || 0, 0)} ${subjectsWord(s.subjects || 0)}</small>` : '—'}</dd></div>
    </dl>
    <div class="divider"></div>
    <div class="stat-strip" aria-label="Підсумок за весь час">
      <div class="st"><div class="v">${fmtNum(s.checks || 0, 0)}</div><div class="l">Перевірки таблиці</div></div>
      <div class="st"><div class="v">${fmtNum(totals.created || 0, 0)}</div><div class="l">Нові студенти</div></div>
      <div class="st"><div class="v">${fmtNum(totals.updated || 0, 0)}</div><div class="l">Оновлені записи</div></div>
      <div class="st"><div class="v">${fmtNum(totals.scoreChanges || 0, 0)}</div><div class="l">Зміни балів</div></div>
    </div>
  </section>`;
}

function conflictsSection(d) {
  const list = d.conflicts;
  return html`<section class="section" aria-labelledby="ad-conf-title">
    <div class="section-head"><h2 id="ad-conf-title">Конфлікти</h2>${list.length ? html`<span class="count">${list.length}</span>` : ''}</div>
    <div class="card">
      ${list.length
        ? html`<div class="table-wrap"><table class="table responsive ad-table">
          <thead><tr><th scope="col">Студент</th><th scope="col">Предмет</th><th scope="col" class="r">Поточне значення</th><th scope="col" class="r">У таблиці</th><th scope="col">Виявлено</th><th scope="col" class="r">Рішення</th></tr></thead>
          <tbody>${list.map((c) => html`<tr>
            <td class="primary" data-label="Студент"><span class="ad-cell">${studentLink(c.ratingId, c.studentName)}${c.group ? html`<small class="ad-sub">${c.group}</small>` : ''}</span></td>
            <td data-label="Предмет"><span class="ad-cell">${c.subjectName}</span></td>
            <td class="r num" data-label="Поточне значення"><span class="ad-cell">${c.currentValue == null ? '—' : fmtNum(c.currentValue)}<small class="ad-sub">${sourceLabel(c.currentSource)}</small></span></td>
            <td class="r num" data-label="У таблиці"><span class="ad-cell">${c.sheetValue == null ? '—' : fmtNum(c.sheetValue)}</span></td>
            <td data-label="Виявлено"><span class="ad-cell">${relTime(c.detectedAt)}</span></td>
            <td class="r" data-label="Рішення"><span class="ad-cell ad-actions">
              <button type="button" class="btn btn-soft btn-sm" data-action="resolve" data-id="${c.id}" data-choice="sheet">Прийняти значення з таблиці</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="resolve" data-id="${c.id}" data-choice="keep">Залишити поточний</button>
            </span></td>
          </tr>`)}</tbody></table></div>`
        : emptyState({ icon: 'check-circle', title: 'Конфліктів немає', text: 'Усі значення з таблиці узгоджені з журналом балів.', compact: true })}
    </div>
  </section>`;
}

function historySection(d) {
  const runs = d.runs;
  return html`<section class="section" aria-labelledby="ad-runs-title">
    <div class="section-head"><h2 id="ad-runs-title">Історія синхронізацій</h2><span class="hint">${runs.length ? `${runs.length} ${plural(runs.length, 'запуск', 'запуски', 'запусків')}` : ''}</span></div>
    <div class="card">
      ${runs.length
        ? html`<div class="table-wrap"><table class="table responsive ad-table">
          <thead><tr><th scope="col">Час</th><th scope="col">Запуск</th><th scope="col">Статус</th><th scope="col">Результат</th><th scope="col" class="r">Тривалість</th><th scope="col">Примітки</th></tr></thead>
          <tbody>${runs.map((r) => {
            const notes = [];
            if (r.repeats) notes.push(`повторів: ${fmtNum(r.repeats, 0)}${r.lastAt ? `, востаннє ${relTime(r.lastAt)}` : ''}`);
            return html`<tr>
              <td class="primary" data-label="Час"><span class="ad-cell">${relTime(r.startedAt)}<small class="ad-sub">${exactTime(r.startedAt)}</small></span></td>
              <td data-label="Запуск"><span class="ad-cell">${r.trigger === 'manual' ? `Вручну${r.userName ? ` · ${r.userName}` : ''}` : 'Автоматично'}</span></td>
              <td data-label="Статус"><span class="ad-cell">${runBadge(r.status)}</span></td>
              <td data-label="Результат"><span class="ad-cell">${runSummary(r)}${r.students != null && r.status !== 'error' ? html`<small class="ad-sub">У таблиці: ${fmtNum(r.students, 0)} ${studentsWord(r.students)}, ${fmtNum(r.subjects || 0, 0)} ${subjectsWord(r.subjects || 0)}</small>` : ''}</span></td>
              <td class="r nowrap" data-label="Тривалість"><span class="ad-cell">${fmtDuration(r.durationMs)}</span></td>
              <td data-label="Примітки" class="${r.error || notes.length || (r.warnings && r.warnings.length) ? '' : 'ad-empty'}"><span class="ad-cell ad-notes">${r.error ? html`<span class="danger-text">${r.error}</span>` : ''}${(r.warnings || []).map((w) => html`<span class="warning-text">${w}</span>`)}${notes.map((n) => html`<span class="muted">${n}</span>`)}</span></td>
            </tr>`;
          })}</tbody></table></div>`
        : emptyState({ icon: 'history', title: 'Запусків ще не було', text: 'Перша синхронізація відбудеться автоматично або після натискання «Синхронізувати зараз».', compact: true })}
    </div>
  </section>`;
}

export default async function view(ctx) {
  const root = ctx.root;
  const head = (d) => pageHead({
    title: 'Синхронізація з Google Таблицею',
    subtitle: 'Автоматичне зчитування рейтингу з таблиці, конфлікти та історія запусків',
    actions: d ? html`<button type="button" class="btn btn-primary" data-action="sync" ${d.enabled && !d.busy ? '' : 'disabled'}>${icon('refresh')} ${d.busy ? 'Синхронізація триває…' : 'Синхронізувати зараз'}</button>` : '',
  });
  setHTML(root, html`${head(null)}${skeleton(3)}`);

  let data = await api('GET', '/api/admin/sync');
  if (!ctx.isActive()) return;
  let acting = false;
  let timer = 0;

  function render() {
    const s = data.state || {};
    setHTML(root, html`
      ${head(data)}
      ${s.lastError ? html`<div class="alert danger mb4" role="alert">${icon('alert')}<div class="grow"><strong>Остання синхронізація завершилась помилкою</strong>${s.lastError}${s.lastErrorAt ? html` <span class="muted">(${relTime(s.lastErrorAt)})</span>` : ''}<div class="small mt1">Дані журналу не змінено. Наступну спробу буде виконано за розкладом, або запустіть її вручну.</div></div></div>` : ''}
      <div class="stack lg">
        <div class="split ad-fit">
          ${connectionCard(data)}
          <div class="card">
            <div class="card-head"><h3>Як працює синхронізація</h3></div>
            <ul class="ad-rules">${RULES.map(([title, text]) => html`<li><strong>${title}</strong> ${text}</li>`)}</ul>
          </div>
        </div>
        ${conflictsSection(data)}
        ${historySection(data)}
      </div>`);
  }

  async function reload({ quiet = false } = {}) {
    try {
      const next = await api('GET', '/api/admin/sync');
      if (!ctx.isActive()) return;
      data = next;
      render();
    } catch (e) {
      if (!quiet && ctx.isActive()) toastError(e);
    }
  }

  async function runSync(btn) {
    acting = true;
    try {
      await busy(btn, async () => {
        try {
          const r = await api('POST', '/api/admin/rating/sync', {});
          toast(`Нових студентів: ${r.created || 0}, оновлено: ${r.updated || 0}, змін балів: ${r.scoreChanges || 0}, конфліктів: ${r.conflicts || 0}`, { type: 'success' });
          if (r.warnings && r.warnings.length) toast(r.warnings[0], { type: 'info', duration: 7000 });
        } catch (e) {
          toastError(e);
        }
      });
    } finally {
      acting = false;
    }
    if (ctx.isActive()) await reload({ quiet: true });
  }

  async function resolve(btn, id, choice) {
    const c = data.conflicts.find((x) => x.id === id);
    if (choice === 'sheet') {
      const ok = await confirmDialog({
        title: 'Прийняти значення з таблиці?',
        text: c ? `Бал студента «${c.studentName}» з предмета «${c.subjectName}» зміниться з ${c.currentValue == null ? 'порожнього' : fmtNum(c.currentValue)} на ${c.sheetValue == null ? 'порожнє значення' : fmtNum(c.sheetValue)}. Зміну буде записано в журнал від вашого імені.` : 'Бал буде змінено на значення з таблиці. Зміну буде записано в журнал.',
        confirmText: 'Прийняти значення',
      });
      if (!ok) return;
    }
    acting = true;
    try {
      await busy(btn, async () => {
        try {
          // Ідентифікатор конфлікту містить символ «|», тому його обов’язково кодуємо.
          await api('POST', `/api/admin/sync/conflicts/${encodeURIComponent(id)}/resolve`, { action: choice });
          toast(choice === 'sheet' ? 'Значення з таблиці прийнято.' : 'Поточний бал залишено без змін.', { type: 'success' });
        } catch (e) {
          toastError(e);
        }
      });
    } finally {
      acting = false;
    }
    if (ctx.isActive()) await reload({ quiet: true });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!ctx.isActive()) return;
      if (document.visibilityState === 'visible' && !acting && !uiLocked(root)) await reload({ quiet: true });
      if (ctx.isActive()) schedule();
    }, data.busy ? BUSY_MS : IDLE_MS);
  }
  ctx.onCleanup(() => clearTimeout(timer));

  ctx.onCleanup(actions(root, {
    sync: (el) => runSync(el),
    resolve: (el) => resolve(el, el.dataset.id, el.dataset.choice),
  }));

  render();
  schedule();
}
