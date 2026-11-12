// Огляд (/admin): показники журналу, стан синхронізації, діаграми та остання активність.

import { api } from '../../core/api.js';
import { html, setHTML, actions, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { pageHead, kpi, skeleton, emptyState, avatar, toast, toastError } from '../../core/ui.js';
import { lineChart, barChart, hBars, legend, sparkline } from '../../core/charts.js';
import { fmtNum, fmtSigned, fmtPct, relTime, pointsWord, studentsWord } from '../../core/format.js';
import {
  alertRow, bucketLabels, chartHost, chartSlot, activitySeries, sumActivity, studentLink, historyTimeline, modeLabel,
  syncVerdict, statusPill, exactTime, poll, uiLocked, isNum, wholeAxis,
} from './ad-kit.js';

const REFRESH_MS = 60000;

function attention(d) {
  const k = d.kpi;
  const s = d.sync;
  const out = [];
  if (s.enabled && s.lastError) out.push({ tone: 'danger', ic: 'alert', title: 'Синхронізація з Google Таблицею не вдалася', text: s.lastError, href: '/admin/sync' });
  if (!s.enabled) out.push({ tone: 'info', ic: 'info', title: 'Синхронізацію з Google Таблицею вимкнено', text: 'Не вказано таблицю, з якої потрібно зчитувати рейтинг.', href: '/admin/sync' });
  if (k.openConflicts > 0) out.push({ tone: 'warning', ic: 'conflict', title: `Конфліктів синхронізації: ${k.openConflicts}`, text: 'Значення в таблиці відрізняються від поточних балів — потрібне ваше рішення.', href: '/admin/sync' });
  if (k.unlinkedAccounts > 0) out.push({ tone: 'warning', ic: 'user-plus', title: `Акаунтів без прив’язки до рейтингу: ${k.unlinkedAccounts}`, text: 'Доки акаунт не прив’язано до запису, студент не бачить своїх балів.', href: '/admin/students#unlinked' });
  if (k.pendingDevices > 0) out.push({ tone: 'warning', ic: 'smartphone', title: `Запитів на підключення пристроїв: ${k.pendingDevices}`, text: 'Студенти чекають на підтвердження нового пристрою.', href: '/admin/users' });
  return out;
}

function kpis(d) {
  const k = d.kpi;
  const spark = (d.timeline || []).map((t) => t.avgTotal).filter(isNum).length > 1
    ? html`<div class="ad-spark">${sparkline(d.timeline.map((t) => t.avgTotal), { width: 140, height: 30 })}</div>`
    : '';
  const person = (p) => (p ? studentLink(p.id, p.fullName, { short: true }) : 'Немає даних');
  let improvement;
  if (k.avgImprovement == null) {
    improvement = kpi({
      ic: 'trending-up', label: 'Середнє покращення',
      value: html`<span class="ad-kpi-note">Недостатньо даних</span>`,
      sub: 'Потрібна історія змін щонайменше за 7 днів, щоб було з чим порівнювати.',
    });
  } else {
    const a = k.avgImprovement;
    improvement = kpi({
      ic: a < 0 ? 'trending-down' : 'trending-up', label: 'Середнє покращення',
      value: html`<span class="${a > 0 ? 'success-text' : a < 0 ? 'danger-text' : ''}">${fmtSigned(a)}</span>`,
      sub: `${pointsWord(a)} на студента за 7 днів${k.avgImprovementPercent != null ? ` (${fmtPct(k.avgImprovementPercent)})` : ''}. Порівняно студентів: ${fmtNum(k.comparable, 0)}`,
    });
  }
  return html`<div class="grid grid-kpi ad-kpis">
    ${kpi({ ic: 'users', label: 'Студентів у рейтингу', value: fmtNum(k.ratingStudents, 0), sub: k.inactiveStudents ? `Неактивних записів: ${k.inactiveStudents}` : 'Неактивних записів немає' })}
    ${kpi({ ic: 'activity', label: 'Активні за 7 днів', value: html`${fmtNum(k.activeStudents7, 0)}<small class="ad-of"> із ${fmtNum(k.accounts, 0)}</small>`, sub: `Сьогодні заходили: ${fmtNum(k.activeToday, 0)}` })}
    ${kpi({ ic: 'bar-chart', label: 'Середня сума балів', value: k.avgTotal == null ? '—' : fmtNum(k.avgTotal), sub: 'На одного студента', extra: spark })}
    ${improvement}
    ${kpi({ ic: 'layers', label: 'Предметів', value: fmtNum(k.subjects, 0), sub: 'У таблиці рейтингу' })}
    ${kpi({ ic: 'hash', label: 'Записаних балів', value: fmtNum(k.scores, 0), sub: 'Із усіх предметів' })}
    ${kpi({ ic: 'award', label: 'Найвища сума', value: k.best ? fmtNum(k.best.points) : '—', sub: person(k.best) })}
    ${kpi({ ic: 'target', label: 'Найнижча сума', value: k.worst ? fmtNum(k.worst.points) : '—', sub: person(k.worst) })}
  </div>`;
}

function syncCard(s) {
  const v = syncVerdict(s);
  let next = '—';
  if (s.enabled) {
    if (s.busy) next = 'Виконується зараз…';
    else if (s.nextRunAt) next = +new Date(s.nextRunAt) <= Date.now() ? 'Найближчим часом' : relTime(s.nextRunAt);
  }
  return html`<section class="card card-pad ad-sync" aria-labelledby="ad-sync-title">
    <div class="ad-sync-top">
      <div class="ad-sync-title">
        <div class="flex wrap">${statusPill(v)}<span class="muted small">${modeLabel(s.mode)}</span></div>
        <h2 id="ad-sync-title">Google Таблиця</h2>
      </div>
      <button type="button" class="btn btn-primary" data-action="sync" ${s.enabled ? '' : 'disabled'}>${icon('refresh')} Синхронізувати зараз</button>
    </div>
    <dl class="ad-facts">
      <div><dt>Остання успішна синхронізація</dt><dd>${s.lastSuccessAt ? html`${relTime(s.lastSuccessAt)}<small>${exactTime(s.lastSuccessAt)}</small>` : 'Ще не було'}</dd></div>
      <div><dt>Наступна за розкладом</dt><dd>${next}</dd></div>
      <div><dt>Прочитано з таблиці</dt><dd>${s.students != null ? html`${fmtNum(s.students, 0)} ${studentsWord(s.students)}<small>${fmtNum(s.subjects || 0, 0)} предметів</small>` : '—'}</dd></div>
      <div><dt>Таблиця</dt><dd>${s.sheetUrl ? html`<a href="${s.sheetUrl}" target="_blank" rel="noopener noreferrer">Відкрити ${icon('external')}</a>` : '—'}<small><a href="/admin/sync">Докладніше про синхронізацію</a></small></dd></div>
    </dl>
    ${s.lastError ? html`<div class="alert danger mt3">${icon('alert')}<div class="grow"><strong>Остання спроба завершилась помилкою</strong>${s.lastError}${s.lastErrorAt ? html` <span class="muted">(${relTime(s.lastErrorAt)})</span>` : ''}</div></div>` : ''}
  </section>`;
}

function newAccounts(list) {
  if (!list.length) return emptyState({ icon: 'user-plus', title: 'Нових акаунтів немає', text: 'За останній тиждень ніхто не реєструвався.', compact: true });
  return html`<div class="list">${list.map((u) => html`<div class="list-item">
    ${avatar(u.fullName, 'sm')}
    <div class="grow"><div class="title">${u.fullName}</div><div class="meta">Зареєстровано ${relTime(u.at)}</div></div>
    ${u.linked ? html`<span class="badge success">Прив’язано</span>` : html`<a class="badge warning" href="/admin/students#unlinked">Без прив’язки</a>`}
  </div>`)}</div>`;
}

export default async function view(ctx) {
  const root = ctx.root;
  const head = (extra = '') => pageHead({
    title: 'Огляд',
    subtitle: 'Стан журналу, активність студентів і синхронізація з Google Таблицею',
    actions: extra,
    compact: true,
  });
  setHTML(root, html`${head()}${skeleton(3)}`);

  let d = await api('GET', '/api/admin/dashboard');
  if (!ctx.isActive()) return;
  const charts = chartHost(ctx, root);

  function render() {
    const alerts = attention(d);
    const day = bucketLabels(d.timeline, 'day');
    const actDay = bucketLabels(d.activity, 'day');
    const sources = activitySeries(d.activity);
    const subjects = d.bySubject.filter((s) => s.avg != null).slice(0, 8);
    const top = Math.max(1, ...subjects.map((s) => s.max || 0));
    setHTML(root, html`
      ${head(html`<button type="button" class="btn btn-secondary btn-sm" data-action="reload">${icon('refresh')} Оновити</button>`)}
      ${alerts.length ? html`<div class="stack sm mb4" role="region" aria-label="Потрібна увага">${alerts.map(alertRow)}</div>` : ''}
      ${kpis(d)}
      <div class="section">${syncCard(d.sync)}</div>

      <section class="section">
        <div class="section-head"><h2>Динаміка за 7 днів</h2></div>
        <div class="grid grid-2">
          <div class="card">
            <div class="card-head"><h3>Середня сума балів</h3><span class="hint">за добу</span></div>
            <div class="card-body">${chartSlot('avg', 220)}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Зміни балів за джерелами</h3><span class="hint">усього: ${fmtNum(sumActivity(d.activity), 0)}</span></div>
            <div class="card-body">${chartSlot('sources', 220)}${legend(sources)}</div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="split">
          <div>
            <div class="section-head"><h2>Остання активність</h2><a class="hint" href="/admin/changes?source=all">Усі зміни</a></div>
            <div class="card">
              ${d.recent.length ? historyTimeline(d.recent.slice(0, 8), { showStudent: true }) : emptyState({ icon: 'history', title: 'Змін балів ще не було', text: 'Тут з’являться зміни від студентів, таблиці та адміністратора.', compact: true })}
            </div>
          </div>
          <div class="stack lg">
            <div>
              <div class="section-head"><h2>Кращі предмети</h2><span class="hint">за середнім балом</span></div>
              <div class="card card-pad ad-hbars">
                ${subjects.length
                  ? hBars(subjects.map((s) => ({ label: s.name, value: s.avg, mark: s.max, title: `${s.name} (балів записано: ${s.count})` })), { max: top, markLabel: 'Найвищий бал' })
                  : emptyState({ icon: 'bar-chart', title: 'Немає даних', text: 'Середні бали з’являться, щойно в журналі будуть оцінки.', compact: true })}
                ${subjects.length ? html`<p class="help mt3">Риска на смузі — найвищий бал із предмета.</p>` : ''}
              </div>
            </div>
            <div>
              <div class="section-head"><h2>Нові акаунти</h2><span class="hint">за 7 днів</span></div>
              <div class="card">${newAccounts(d.newAccounts)}</div>
            </div>
          </div>
        </div>
      </section>`);
    charts.set({
      avg: (width) => lineChart({
        labels: day.labels, tipLabels: day.tips, width, height: 220, ariaLabel: 'Середня сума балів за останні 7 днів',
        series: [{ label: 'Середня сума', color: 'var(--accent)', values: d.timeline.map((t) => t.avgTotal), area: true }],
        empty: 'За останні 7 днів ще немає даних для графіка.',
      }),
      sources: (width) => wholeAxis(barChart({
        labels: actDay.labels, tipLabels: actDay.tips, series: sources, stacked: true, width, height: 220,
        ariaLabel: 'Зміни балів за джерелами за останні 7 днів', empty: 'За останні 7 днів змін балів не було.',
        format: (v) => fmtNum(v, 0),
      })),
    });
  }

  async function reload({ quiet = false } = {}) {
    try {
      const next = await api('GET', '/api/admin/dashboard');
      if (!ctx.isActive()) return;
      d = next;
      render();
    } catch (e) {
      if (!quiet && ctx.isActive()) toastError(e);
    }
  }

  async function runSync(btn) {
    await busy(btn, async () => {
      try {
        const r = await api('POST', '/api/admin/rating/sync', {});
        const created = r.created || 0;
        const updated = r.updated || 0;
        const changes = r.scoreChanges || 0;
        const conflicts = r.conflicts || 0;
        toast(created || updated || changes || conflicts
          ? `Нових студентів: ${created}, оновлено: ${updated}, змін балів: ${changes}, конфліктів: ${conflicts}`
          : 'Синхронізацію виконано: у таблиці змін немає.', { type: 'success' });
      } catch (e) {
        toastError(e);
      }
    });
    if (ctx.isActive()) await reload({ quiet: true });
  }

  ctx.onCleanup(actions(root, {
    reload: (el) => busy(el, () => reload()),
    sync: (el) => runSync(el),
  }));
  poll(ctx, () => { if (!uiLocked(root)) reload({ quiet: true }); }, REFRESH_MS);
  render();
}
