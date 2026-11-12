// Аналітика (/admin/analytics): успішність, зміни місць у рейтингу й активність за вибраний період.

import { api } from '../../core/api.js';
import { html, setHTML, actions, on } from '../../core/dom.js';
import { pageHead, kpi, skeleton, emptyState, delta } from '../../core/ui.js';
import { lineChart, barChart, hBars, legend } from '../../core/charts.js';
import { fmtNum, fmtSigned, fmtPct, pointsWord, studentsWord } from '../../core/format.js';
import {
  PERIODS, UNITS, periodText, segmented, setPressed, bucketLabels, apiQuery, replaceQuery, sequencer, chartHost, chartSlot,
  activitySeries, sumActivity, wholeAxis, studentLink, inlineError,
} from './ad-kit.js';

const DEFAULTS = { group: '', period: '30', unit: 'day' };
const UNIT_NAMES = { day: 'днями', week: 'тижнями', month: 'місяцями' };

function kpis(d) {
  const act = d.activity || [];
  const by = (key) => act.reduce((n, a) => n + (a[key] || 0), 0);
  const person = (p) => (p ? studentLink(p.id, p.fullName, { short: true }) : 'Немає даних');
  let improvement;
  if (d.avgImprovement == null) {
    improvement = kpi({
      ic: 'trending-up', label: 'Середнє покращення',
      value: html`<span class="ad-kpi-note">Недостатньо даних</span>`,
      sub: 'На початок періоду в журналі ще немає балів, з якими можна порівняти.',
    });
  } else {
    const a = d.avgImprovement;
    improvement = kpi({
      ic: a < 0 ? 'trending-down' : 'trending-up', label: 'Середнє покращення',
      value: html`<span class="${a > 0 ? 'success-text' : a < 0 ? 'danger-text' : ''}">${fmtSigned(a)}</span>`,
      sub: `${pointsWord(a)} на студента ${periodText(d.period)}${d.avgImprovementPercent != null ? ` (${fmtPct(d.avgImprovementPercent)})` : ''}. Порівняно студентів: ${fmtNum(d.comparable, 0)}`,
    });
  }
  return html`<div class="grid grid-kpi ad-kpis ad-kpis-3">
    ${kpi({ ic: 'users', label: 'Студентів у вибірці', value: fmtNum(d.students, 0), sub: `Із балами: ${fmtNum(d.withScores, 0)}` })}
    ${kpi({ ic: 'bar-chart', label: 'Середня сума балів', value: d.avgTotal == null ? '—' : fmtNum(d.avgTotal), sub: 'На одного студента' })}
    ${improvement}
    ${kpi({ ic: 'award', label: 'Найвища сума', value: d.best ? fmtNum(d.best.points) : '—', sub: person(d.best) })}
    ${kpi({ ic: 'target', label: 'Найнижча сума', value: d.worst ? fmtNum(d.worst.points) : '—', sub: person(d.worst) })}
    ${kpi({ ic: 'history', label: 'Змін балів за період', value: fmtNum(sumActivity(act), 0), sub: `Студенти: ${fmtNum(by('student'), 0)} · таблиця: ${fmtNum(by('sheet'), 0)} · адміністратор: ${fmtNum(by('admin'), 0)}` })}
  </div>`;
}

function changesTable(rows, { empty, showGroup }) {
  if (!rows.length) return emptyState({ icon: 'inbox', title: empty.title, text: empty.text, compact: true });
  return html`<div class="table-wrap"><table class="table responsive ad-table">
    <thead><tr><th scope="col">Студент</th><th scope="col" class="r">Було → стало</th><th scope="col" class="r">Зміна</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr>
      <td class="primary" data-label="Студент"><span class="ad-cell">${studentLink(r.id, r.fullName)}${showGroup && r.group ? html`<small class="ad-sub">${r.group}</small>` : ''}</span></td>
      <td class="r num" data-label="Було → стало"><span class="ad-cell">${fmtNum(r.from)} → ${fmtNum(r.to)}</span></td>
      <td class="r" data-label="Зміна"><span class="ad-cell">${delta(r.delta)}${r.percent != null ? html` <span class="ad-pct">${fmtPct(r.percent)}</span>` : ''}</span></td>
    </tr>`)}</tbody>
  </table></div>`;
}

export default async function view(ctx) {
  const root = ctx.root;
  const q = ctx.query;
  const state = {
    group: q.get('group') || '',
    period: PERIODS.some((p) => p.value === q.get('period')) ? q.get('period') : DEFAULTS.period,
    unit: UNITS.some((u) => u.value === q.get('unit')) ? q.get('unit') : DEFAULTS.unit,
  };
  const fetchData = () => api('GET', `/api/admin/analytics${apiQuery(state)}`);

  setHTML(root, html`${pageHead({ title: 'Аналітика', subtitle: 'Успішність, місця в рейтингу та активність студентів за вибраний період', compact: true })}${skeleton(3)}`);
  let data = await fetchData();
  if (!ctx.isActive()) return;
  // Якщо групи з адреси вже немає, показуємо всі групи.
  if (state.group && !data.groups.some((g) => g.name === state.group)) state.group = '';

  const charts = chartHost(ctx, root);
  const seq = sequencer();

  setHTML(root, html`
    ${pageHead({ title: 'Аналітика', subtitle: 'Успішність, місця в рейтингу та активність студентів за вибраний період', compact: true })}
    <div class="card card-pad ad-filterbar" role="search" aria-label="Параметри аналітики">
      <div class="field">
        <label class="label" for="ad-an-group">Група</label>
        <select class="select" id="ad-an-group" data-filter="group">
          <option value="">Усі групи</option>
          ${data.groups.map((g) => html`<option value="${g.name}" ${g.name === state.group ? 'selected' : ''}>${g.name} · ${g.students}</option>`)}
        </select>
      </div>
      <div class="field"><span class="label">Період</span>${segmented({ action: 'period', options: PERIODS, value: state.period, label: 'Період' })}</div>
      <div class="field"><span class="label">Масштаб графіків</span>${segmented({ action: 'unit', options: UNITS, value: data.unit, label: 'Масштаб графіків' })}</div>
    </div>
    <p class="help mt2" id="ad-an-note" hidden></p>
    <div id="ad-an-body" class="ad-body" aria-live="polite"></div>`);

  const body = root.querySelector('#ad-an-body');
  const note = root.querySelector('#ad-an-note');

  function renderBody() {
    const d = data;
    if (!d.students) {
      setHTML(body, html`<div class="card mt4">${emptyState({ icon: 'users', title: 'У вибраній групі немає студентів', text: 'Оберіть іншу групу або дочекайтеся першої синхронізації з таблицею.' })}</div>`);
      return;
    }
    const t = bucketLabels(d.timeline, d.unit);
    const ta = bucketLabels(d.activity, d.unit);
    const rankTimeline = d.timeline.slice(1);
    const tr = bucketLabels(rankTimeline, d.unit);
    const dist = d.distribution || [];
    const sources = activitySeries(d.activity);
    const subjects = d.bestSubjects || [];
    const top = Math.max(1, ...subjects.map((s) => s.max || 0));
    const multiGroup = !d.group && d.groups.length > 1;
    setHTML(body, html`
      <div class="section">${kpis(d)}</div>

      <section class="section">
        <div class="section-head"><h2>Динаміка рейтингу</h2><span class="hint">${periodText(d.period)}</span></div>
        <div class="grid grid-2">
          <div class="card">
            <div class="card-head"><h3>Середня сума балів у динаміці</h3></div>
            <div class="card-body">${chartSlot('avg', 240)}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Зміни позицій у рейтингу</h3><span class="hint">студентів змінили місце</span></div>
            <div class="card-body">${chartSlot('ranks', 240)}</div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Предмети та розподіл</h2></div>
        <div class="grid grid-2">
          <div class="card">
            <div class="card-head"><h3>Середній бал за предметами</h3><span class="hint">риска — найвищий бал</span></div>
            <div class="card-body ad-hbars">${subjects.length
              ? hBars(subjects.map((s) => ({ label: s.name, value: s.avg, mark: s.max, title: `${s.name} (записів: ${s.count}, найнижчий бал: ${fmtNum(s.min)})` })), { max: top, markLabel: 'Найвищий бал' })
              : emptyState({ icon: 'bar-chart', title: 'Немає даних', text: 'Середні бали з’являться, щойно в журналі будуть оцінки.', compact: true })}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Розподіл студентів за сумою балів</h3><span class="hint">кількість студентів</span></div>
            <div class="card-body">${chartSlot('dist', 240)}</div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Хто змінився</h2><span class="hint">${periodText(d.period)}</span></div>
        <div class="grid grid-2">
          <div class="card">
            <div class="card-head"><h3>Найбільше покращення</h3></div>
            ${changesTable(d.improvers || [], { showGroup: multiGroup, empty: { title: 'Покращень немає', text: 'За цей період бали студентів не зросли або немає з чим порівнювати.' } })}
          </div>
          <div class="card">
            <div class="card-head"><h3>Знизили результати</h3><span class="hint">через таблицю чи правки адміністратора</span></div>
            ${changesTable(d.decliners || [], { showGroup: multiGroup, empty: { title: 'Зниження не зафіксовано', text: 'За цей період сума балів жодного студента не зменшилась.' } })}
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Активність</h2><span class="hint">${periodText(d.period)}</span></div>
        <div class="grid grid-2">
          <div class="card">
            <div class="card-head"><h3>Зміни балів за джерелами</h3><span class="hint">усього: ${fmtNum(sumActivity(d.activity), 0)}</span></div>
            <div class="card-body">${chartSlot('sources', 240)}${legend(sources)}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Активні користувачі</h3><span class="hint">унікальні акаунти за проміжок</span></div>
            <div class="card-body">${chartSlot('users', 240)}</div>
          </div>
        </div>
      </section>`);

    charts.set({
      avg: (width) => lineChart({
        labels: t.labels, tipLabels: t.tips, width, height: 240, ariaLabel: 'Середня сума балів у динаміці',
        series: [{ label: 'Середня сума', color: 'var(--accent)', values: d.timeline.map((p) => p.avgTotal), area: true }],
        empty: 'Немає даних за цей період',
      }),
      ranks: (width) => wholeAxis(barChart({
        labels: tr.labels, tipLabels: tr.tips, width, height: 240, ariaLabel: 'Зміни позицій у рейтингу',
        series: [{ label: 'Змінили місце', color: 'var(--c6)', values: rankTimeline.map((p) => p.rankChanges || 0) }],
        format: (v) => fmtNum(v, 0), empty: 'Немає даних за цей період',
      })),
      dist: (width) => wholeAxis(barChart({
        labels: dist.map((b) => `${b.from}–${b.to}`),
        tipLabels: dist.map((b) => `Сума від ${fmtNum(b.from, 0)} до ${fmtNum(b.to, 0)} ${pointsWord(b.to)}`),
        width, height: 240, ariaLabel: 'Розподіл студентів за сумою балів',
        series: [{ label: 'Студентів', color: 'var(--c1)', values: dist.map((b) => b.count) }],
        format: (v) => `${fmtNum(v, 0)} ${studentsWord(v)}`, empty: 'Немає даних',
      })),
      sources: (width) => wholeAxis(barChart({
        labels: ta.labels, tipLabels: ta.tips, series: sources, stacked: true, width, height: 240,
        ariaLabel: 'Зміни балів за джерелами', format: (v) => fmtNum(v, 0), empty: 'Немає даних за цей період',
      })),
      users: (width) => wholeAxis(barChart({
        labels: ta.labels, tipLabels: ta.tips, width, height: 240, ariaLabel: 'Активні користувачі',
        series: [{ label: 'Користувачів', color: 'var(--c5)', values: (d.activeUsers || []).map((u) => u.users) }],
        format: (v) => fmtNum(v, 0), empty: 'Немає даних за цей період',
      })),
    });
  }

  function syncControls() {
    const select = root.querySelector('#ad-an-group');
    if (select) select.value = state.group;
    const groups = root.querySelectorAll('.ad-filterbar .segmented');
    setPressed(groups[0], state.period);
    setPressed(groups[1], data.unit);
    const upgraded = data.unit !== state.unit;
    note.hidden = !upgraded;
    if (upgraded) note.textContent = `Для цього періоду дані згруповано ${UNIT_NAMES[data.unit]}, щоб графіки залишалися читабельними.`;
  }

  async function load() {
    const id = seq.next();
    body.classList.add('ad-dim');
    body.setAttribute('aria-busy', 'true');
    try {
      const next = await fetchData();
      if (!ctx.isActive() || !seq.isLatest(id)) return;
      data = next;
      renderBody();
      syncControls();
    } catch (e) {
      if (!ctx.isActive() || !seq.isLatest(id)) return;
      setHTML(body, html`<div class="mt4">${inlineError(e)}</div>`);
    } finally {
      if (seq.isLatest(id)) { body.classList.remove('ad-dim'); body.removeAttribute('aria-busy'); }
    }
  }

  function changed() {
    replaceQuery(state, DEFAULTS);
    const groups = root.querySelectorAll('.ad-filterbar .segmented');
    setPressed(groups[0], state.period);
    setPressed(groups[1], state.unit);
    load();
  }

  ctx.onCleanup(actions(root, {
    period: (el) => { if (state.period !== el.dataset.value) { state.period = el.dataset.value; changed(); } },
    unit: (el) => { if (state.unit !== el.dataset.value || data.unit !== el.dataset.value) { state.unit = el.dataset.value; changed(); } },
    retry: () => load(),
  }));
  ctx.onCleanup(on(root, 'change', 'select[data-filter="group"]', (el) => { state.group = el.value; changed(); }));

  renderBody();
  syncControls();
}
