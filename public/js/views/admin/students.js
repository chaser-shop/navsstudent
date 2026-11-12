// Студенти (/admin/students): пошук і фільтри, таблиця студентів та прив’язка акаунтів без запису в рейтингу.

import { api } from '../../core/api.js';
import { html, setHTML, actions, on, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { pageHead, skeleton, emptyState, delta, avatar, toast, toastError } from '../../core/ui.js';
import { fmtNum, fmtDate, relTime, studentsWord } from '../../core/format.js';
import { apiQuery, replaceQuery, debounce, sequencer, studentHref, inlineError } from './ad-kit.js';

const DEFAULTS = { status: 'active', sort: 'rank' };
const STATUSES = [['active', 'Активні'], ['inactive', 'Неактивні'], ['all', 'Усі']];
const SORTS = [['rank', 'За місцем'], ['name', 'За ПІБ'], ['total', 'За сумою'], ['delta', 'За зміною за 7 днів'], ['changes', 'За кількістю змін студента']];
const PAGE = 100;

export default async function view(ctx) {
  const root = ctx.root;
  const q = ctx.query;
  const state = {
    q: q.get('q') || '',
    group: q.get('group') || '',
    subject: q.get('subject') || '',
    status: STATUSES.some(([v]) => v === q.get('status')) ? q.get('status') : DEFAULTS.status,
    sort: [...SORTS.map(([v]) => v), 'subject'].includes(q.get('sort')) ? q.get('sort') : DEFAULTS.sort,
  };
  let shown = PAGE;
  const fetchData = () => api('GET', `/api/admin/students${apiQuery(state)}`);

  setHTML(root, html`${pageHead({ title: 'Студенти', subtitle: 'Записи рейтингу, акаунти студентів і їхні зміни', compact: true })}${skeleton(3)}`);
  let data = await fetchData();
  if (!ctx.isActive()) return;
  // Застарілі значення з адреси (група чи предмет, яких уже немає) скидаємо.
  let fixed = false;
  if (state.group && !data.groups.some((g) => g.name === state.group)) { state.group = ''; fixed = true; }
  if (state.subject && !data.subjects.includes(state.subject)) { state.subject = ''; fixed = true; }
  if (state.sort === 'subject' && !state.subject) { state.sort = DEFAULTS.sort; fixed = true; }
  if (fixed) {
    data = await fetchData();
    if (!ctx.isActive()) return;
  }
  const records = data.unlinked.length ? await api('GET', '/api/admin/rating-students').catch(() => null) : null;
  if (!ctx.isActive()) return;

  const seq = sequencer();
  const subjectName = (k) => data.subjectNames[k] || k;
  const recordGroups = records
    ? [...records.reduce((m, r) => { const g = r.group || 'Без групи'; if (!m.has(g)) m.set(g, []); m.get(g).push(r); return m; }, new Map())]
    : [];

  setHTML(root, html`
    ${pageHead({ title: 'Студенти', subtitle: 'Записи рейтингу, акаунти студентів і їхні зміни', compact: true })}
    <div id="ad-st-attention"></div>
    <div class="card card-pad ad-filters" role="search" aria-label="Пошук і фільтри студентів">
      <div class="field ad-f-search">
        <label class="label" for="ad-st-q">Пошук за ПІБ</label>
        <div class="input-group">${icon('search')}<input class="input" id="ad-st-q" type="search" data-filter="q" placeholder="Прізвище або ім’я" autocomplete="off" value="${state.q}"></div>
      </div>
      <div class="field">
        <label class="label" for="ad-st-group">Група</label>
        <select class="select" id="ad-st-group" data-filter="group">
          <option value="">Усі групи</option>
          ${data.groups.map((g) => html`<option value="${g.name}" ${g.name === state.group ? 'selected' : ''}>${g.name}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="label" for="ad-st-subject">Предмет</label>
        <select class="select" id="ad-st-subject" data-filter="subject">
          <option value="">Будь-який предмет</option>
          ${data.subjects.map((s) => html`<option value="${s}" ${s === state.subject ? 'selected' : ''}>${subjectName(s)}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="label" for="ad-st-status">Статус</label>
        <select class="select" id="ad-st-status" data-filter="status">
          ${STATUSES.map(([v, l]) => html`<option value="${v}" ${v === state.status ? 'selected' : ''}>${l}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="label" for="ad-st-sort">Сортування</label>
        <select class="select" id="ad-st-sort" data-filter="sort"></select>
      </div>
    </div>
    <div id="ad-st-results" class="ad-body" aria-live="polite"></div>
    <section id="unlinked" class="section ad-anchor" aria-labelledby="ad-unlinked-title"></section>`);

  const results = root.querySelector('#ad-st-results');
  const unlinkedBox = root.querySelector('#unlinked');
  const attention = root.querySelector('#ad-st-attention');
  const sortSelect = root.querySelector('#ad-st-sort');

  function renderSort() {
    const list = state.subject ? [...SORTS, ['subject', 'За балом з предмета']] : SORTS;
    if (!list.some(([v]) => v === state.sort)) state.sort = DEFAULTS.sort;
    setHTML(sortSelect, list.map(([v, l]) => html`<option value="${v}" ${v === state.sort ? 'selected' : ''}>${l}</option>`));
  }

  // Ім’я акаунта показуємо, лише якщо воно відрізняється від ПІБ у рейтингу.
  function accountCell(i) {
    if (!i.accounts.length) return html`<span class="badge outline">Не прив’язано</span>`;
    const a = i.accounts[0];
    const same = a.fullName.trim().toLocaleLowerCase('uk') === i.fullName.trim().toLocaleLowerCase('uk');
    return html`${same ? html`<span class="badge success">Прив’язано</span>` : a.fullName}${i.accounts.length > 1 ? html` <span class="muted">+${i.accounts.length - 1}</span>` : ''}<small class="ad-sub">${a.lastSeenAt ? `Остання активність: ${relTime(a.lastSeenAt)}` : 'Входів ще не було'}</small>`;
  }

  function row(i) {
    const subj = !!state.subject;
    const place = subj ? i.subjectRank : i.rank;
    return html`<tr class="clickable" data-href="${studentHref(i.id)}">
      <td class="num ad-rank" data-label="${subj ? 'Місце за предметом' : 'Місце'}"><span class="ad-cell">${place == null ? '—' : place}</span></td>
      <td class="primary" data-label="Студент"><span class="ad-cell"><a href="${studentHref(i.id)}">${i.fullName}</a>
        ${i.note ? html` <span class="badge accent">${i.note}</span>` : ''}${i.remark ? html` <span class="badge warning">${i.remark}</span>` : ''}${i.active ? '' : html` <span class="badge">Неактивний</span>`}
        <small class="ad-sub ad-group-inline">${i.group || ''}</small></span></td>
      <td data-label="Група" class="nowrap ad-col-group"><span class="ad-cell">${i.group || '—'}</span></td>
      <td class="r num" data-label="${subj ? 'Бал з предмета' : 'Сума балів'}"><span class="ad-cell">${subj ? (i.subjectValue == null ? '—' : fmtNum(i.subjectValue)) : (i.points == null ? '—' : fmtNum(i.points))}${subj && i.points != null ? html`<small class="ad-sub">Сума: ${fmtNum(i.points)}</small>` : ''}</span></td>
      <td class="r ${i.delta7 == null ? 'ad-empty' : ''}" data-label="Зміна за 7 днів"><span class="ad-cell">${i.delta7 == null ? html`<span class="muted">—</span>` : delta(i.delta7)}</span></td>
      <td class="r num ${i.studentChanges ? '' : 'ad-empty'}" data-label="Змін студентом"><span class="ad-cell">${i.studentChanges ? fmtNum(i.studentChanges, 0) : html`<span class="muted">—</span>`}</span></td>
      <td data-label="Акаунт"><span class="ad-cell">${accountCell(i)}</span></td>
    </tr>`;
  }

  function renderResults() {
    const items = data.items;
    if (!items.length) {
      const filtered = state.q || state.group || state.subject || state.status !== 'active';
      setHTML(results, html`<div class="card mt4">${emptyState({
        icon: 'users', title: 'Студентів не знайдено',
        text: filtered ? 'Змініть пошуковий запит або фільтри.' : 'У рейтингу ще немає жодного студента. Вони з’являться після першої синхронізації з таблицею.',
      })}</div>`);
      return;
    }
    const subj = !!state.subject;
    const visible = items.slice(0, shown);
    setHTML(results, html`
      <div class="flex between wrap mt4 mb3">
        <div class="muted small">Знайдено: <strong>${fmtNum(data.total, 0)}</strong> ${studentsWord(data.total)}${subj ? html` · бали з предмета «${subjectName(state.subject)}»` : ''}</div>
      </div>
      <div class="card"><div class="table-wrap"><table class="table responsive ad-table ad-students">
        <thead><tr>
          <th scope="col" class="r">${subj ? 'Місце за предметом' : 'Місце'}</th><th scope="col">Студент</th><th scope="col" class="ad-col-group">Група</th>
          <th scope="col" class="r">${subj ? 'Бал з предмета' : 'Сума балів'}</th><th scope="col" class="r">Зміна за 7 днів</th><th scope="col" class="r">Змін студентом</th><th scope="col">Акаунт</th>
        </tr></thead>
        <tbody>${visible.map(row)}</tbody>
      </table></div></div>
      ${items.length > visible.length ? html`<div class="center mt4"><button type="button" class="btn btn-secondary" data-action="more">Показати ще (${fmtNum(items.length - visible.length, 0)})</button></div>` : ''}`);
  }

  function linkRow(u) {
    return html`<div class="ad-link-row">
      ${u.suggestion ? html`<button type="button" class="btn btn-primary btn-sm" data-action="link-suggest" data-user="${u.id}" data-student="${u.suggestion.id}" data-name="${u.suggestion.fullName}">${icon('link')}<span>Прив’язати до “${u.suggestion.fullName}”</span></button><span class="xs muted">група ${u.suggestion.group}</span>` : ''}
      ${records ? html`<select class="select sm" aria-label="Запис у рейтингу для акаунта ${u.fullName}" data-link-select="${u.id}">
          <option value="">${u.suggestion ? 'або оберіть інший запис…' : 'Оберіть запис у рейтингу…'}</option>
          ${recordGroups.map(([g, list]) => html`<optgroup label="${g}">${list.map((r) => html`<option value="${r.id}">${r.fullName}${r.active ? '' : ' (неактивний)'}</option>`)}</optgroup>`)}
        </select>
        <button type="button" class="btn btn-secondary btn-sm" data-action="link-manual" data-user="${u.id}">Прив’язати</button>`
        : html`<span class="xs muted">Не вдалося завантажити список записів рейтингу.</span>`}
    </div>`;
  }

  function renderUnlinked() {
    const list = data.unlinked;
    setHTML(attention, list.length ? html`<a class="alert warning ad-alert mb4" href="#unlinked" data-action="goto-unlinked">${icon('user-plus')}<div class="grow"><strong>Акаунтів без прив’язки: ${list.length}</strong>Такі студенти не бачать своїх балів, доки їх не прив’язано до запису в рейтингу.</div>${icon('chevron-right')}</a>` : '');
    setHTML(unlinkedBox, html`
      <div class="section-head"><h2 id="ad-unlinked-title">Акаунти без прив’язки</h2>${list.length ? html`<span class="count">${list.length}</span>` : ''}</div>
      <div class="card">
        ${list.length ? html`<div class="list">${list.map((u) => html`<div class="list-item ad-unlinked">
          ${avatar(u.fullName, 'sm')}
          <div class="grow">
            <div class="title">${u.fullName}</div>
            <div class="meta">${u.createdAt ? `Реєстрація: ${fmtDate(u.createdAt)}` : 'Дата реєстрації невідома'} · ${u.lastSeenAt ? `остання активність: ${relTime(u.lastSeenAt)}` : 'входів ще не було'}</div>
            ${linkRow(u)}
          </div>
        </div>`)}</div>`
          : emptyState({ icon: 'user-check', title: 'Усі акаунти прив’язано', text: 'Кожен зареєстрований студент бачить свої бали й статистику.', compact: true })}
      </div>`);
  }

  async function load({ keepScroll = false } = {}) {
    const id = seq.next();
    results.classList.add('ad-dim');
    try {
      const next = await fetchData();
      if (!ctx.isActive() || !seq.isLatest(id)) return;
      data = next;
      if (!keepScroll) shown = PAGE;
      renderResults();
      renderUnlinked();
    } catch (e) {
      if (!ctx.isActive() || !seq.isLatest(id)) return;
      setHTML(results, html`<div class="mt4">${inlineError(e)}</div>`);
    } finally {
      if (seq.isLatest(id)) results.classList.remove('ad-dim');
    }
  }

  const changed = () => { replaceQuery(state, DEFAULTS); load(); };
  const typed = debounce(() => { replaceQuery(state, DEFAULTS); load(); }, 320);
  ctx.onCleanup(() => typed.cancel());

  async function link(btn, userId, studentId) {
    if (!studentId) { toast('Оберіть запис у рейтингу, до якого потрібно прив’язати акаунт.', { type: 'error' }); return; }
    const account = data.unlinked.find((u) => u.id === userId);
    await busy(btn, async () => {
      try {
        const r = await api('POST', `/api/admin/users/${encodeURIComponent(userId)}/student`, { studentId });
        toast(`Акаунт «${account ? account.fullName : 'студента'}» прив’язано до запису «${r.student || 'у рейтингу'}».`, { type: 'success' });
        await load({ keepScroll: true });
      } catch (e) {
        toastError(e);
      }
    });
  }

  ctx.onCleanup(on(root, 'input', 'input[data-filter="q"]', (el) => { state.q = el.value.trim(); typed(); }));
  ctx.onCleanup(on(root, 'change', 'select[data-filter]', (el) => {
    state[el.dataset.filter] = el.value;
    if (el.dataset.filter === 'subject') renderSort();
    changed();
  }));
  ctx.onCleanup(on(root, 'click', 'tr[data-href]', (tr, e) => {
    if (e.target.closest('a, button, select, input, label')) return;
    ctx.navigate(tr.dataset.href);
  }));
  ctx.onCleanup(actions(root, {
    more: () => { shown += PAGE; renderResults(); },
    retry: () => load(),
    'goto-unlinked': () => unlinkedBox.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    'link-suggest': (el) => link(el, el.dataset.user, el.dataset.student),
    'link-manual': (el) => {
      const select = root.querySelector(`select[data-link-select="${CSS.escape(el.dataset.user)}"]`);
      return link(el, el.dataset.user, select ? select.value : '');
    },
  }));

  renderSort();
  renderResults();
  renderUnlinked();
  if (location.hash === '#unlinked') requestAnimationFrame(() => unlinkedBox.scrollIntoView({ block: 'start' }));
}
