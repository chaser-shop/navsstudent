// Оцінки: перегляд зовнішньої колекції «grades» (лише читання), щоденна перевірка нових оцінок і ручний запуск.

import { api } from '../../core/api.js';
import { html, setHTML, $, actions, on as delegate, busy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { toastError, toastSuccess, emptyState, loading, pageHead } from '../../core/ui.js';
import { fmtNum, relTime, plural, TZ } from '../../core/format.js';

const PAGE = 50;
const collator = new Intl.Collator('uk');
const dateFmt = new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const numGrade = (v) => (/^\d+([.,]\d+)?$/.test(String(v).trim()) ? parseFloat(String(v).replace(',', '.')) : null);
const prepare = (items) => items.map((x) => ({
  ...x,
  subject: x.subject || 'Без предмета',
  ts: x.date ? new Date(x.date).getTime() : null,
  num: numGrade(x.value),
}));

// Нові — зверху; оцінки без дати завжди внизу.
const byNew = (a, b) => (a.ts == null) - (b.ts == null) || (b.ts - a.ts);
const byOld = (a, b) => (a.ts == null) - (b.ts == null) || (a.ts - b.ts);
const SORTS = [
  { key: 'new', label: 'Нові', cmp: byNew },
  { key: 'old', label: 'Старі', cmp: byOld },
  { key: 'subject', label: 'За предметом', cmp: (a, b) => collator.compare(a.subject, b.subject) || byNew(a, b) },
];

export default async function view(ctx) {
  const { root } = ctx;
  setHTML(root, loading());
  const first = await api('GET', '/api/admin/grades');
  if (!ctx.isActive()) return;

  const S = { items: [], docs: 0, db: '', lastCheck: null, hour: 20, subject: '', q: '', sort: 'new', limit: PAGE, result: null };
  const apply = (r) => {
    S.items = prepare(r.items || []);
    S.docs = r.docs || 0;
    S.db = r.db || '';
    S.lastCheck = r.lastCheck || null;
    S.hour = r.hour;
    if (S.subject && !S.items.some((x) => x.subject === S.subject)) S.subject = '';
  };
  apply(first);

  const sec = (name) => $(`[data-sec="${name}"]`, root);

  function filtered() {
    const q = S.q.trim().toLocaleLowerCase('uk');
    const cmp = (SORTS.find((s) => s.key === S.sort) || SORTS[0]).cmp;
    return S.items
      .filter((x) => (!S.subject || x.subject === S.subject)
        && (!q || [x.subject, x.value, x.type, x.teacher, x.period].some((v) => String(v || '').toLocaleLowerCase('uk').includes(q))))
      .sort(cmp);
  }

  // ───────── Стан перевірки ─────────
  function statusHtml() {
    const when = S.lastCheck ? new Date(S.lastCheck) : null;
    const hh = `${String(S.hour).padStart(2, '0')}:00`;
    const nums = S.items.map((x) => x.num).filter((n) => n != null);
    const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    const subjects = new Set(S.items.map((x) => x.subject)).size;
    const r = S.result;
    return html`<div class="card card-pad mg-status">
      <div class="mg-status-row">
        <span class="mg-status-ic">${icon('clock')}</span>
        <div class="grow">
          <div class="strong">Остання перевірка: ${when ? relTime(when) : 'ще не виконувалась'}</div>
          <p class="muted small mt1">Оцінки надходять із зовнішньої колекції «grades» (база «${S.db}»), яку застосунок лише читає. Нові оцінки перевіряються щодня о ${hh} за київським часом — адміністратори отримують сповіщення про них.</p>
        </div>
        <button type="button" class="btn btn-secondary mg-status-btn" data-action="check">${icon('refresh')}Перевірити зараз</button>
      </div>
      ${r ? (r.fresh
        ? html`<div class="alert success mt3" role="status">${icon('check-circle')}<div class="grow">Знайдено нових оцінок: ${r.fresh}. Сповіщень доставлено адміністраторам: ${r.notified}.</div></div>`
        : html`<div class="alert info mt3" role="status">${icon('info')}<div class="grow">Нових оцінок немає. Усього оцінок у колекції: ${r.total}.</div></div>`) : ''}
      ${S.items.length ? html`<hr class="divider">
        <div class="stat-strip">
          <div class="st"><div class="v num">${fmtNum(S.items.length, 0)}</div><div class="l">Усього оцінок</div></div>
          <div class="st"><div class="v num">${fmtNum(subjects, 0)}</div><div class="l">${plural(subjects, 'предмет', 'предмети', 'предметів')}</div></div>
          <div class="st"><div class="v num">${avg == null ? '—' : fmtNum(avg)}</div><div class="l">${nums.length ? `Середня за ${nums.length} ${plural(nums.length, 'числову оцінку', 'числові оцінки', 'числових оцінок')}` : 'Середня: числових оцінок немає'}</div></div>
        </div>` : ''}
    </div>`;
  }

  // ───────── Список ─────────
  function subjectOptions() {
    const counts = new Map();
    for (const x of S.items) counts.set(x.subject, (counts.get(x.subject) || 0) + 1);
    const names = [...counts.keys()].sort(collator.compare);
    return html`<select class="select mg-bar-group" id="mg-g-subject" aria-label="Предмет">
      <option value="">Усі предмети · ${S.items.length}</option>
      ${names.map((n) => html`<option value="${n}" ${n === S.subject ? 'selected' : ''}>${n} · ${counts.get(n)}</option>`)}
    </select>`;
  }

  function listHtml() {
    if (!S.items.length) {
      return emptyState({
        icon: 'file-check',
        title: 'Оцінок ще немає',
        text: S.docs
          ? `У колекції «grades» (база «${S.db}») є документів: ${S.docs}, але масиву grades з оцінками в них немає.`
          : `У колекції «grades» (база «${S.db}») немає жодного документа. Якщо оцінки лежать в іншій базі, вкажіть її у змінній середовища GRADES_DB.`,
      });
    }
    const rows = filtered();
    if (!rows.length) return emptyState({ icon: 'search', title: 'Нічого не знайдено', text: 'Змініть пошуковий запит або предмет.', compact: true });
    const shown = rows.slice(0, S.limit);
    const nums = rows.map((x) => x.num).filter((n) => n != null);
    const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    return html`<div class="mg-count" aria-live="polite">Показано ${shown.length} з ${rows.length}${avg != null && rows.length !== S.items.length ? ` · середня ${fmtNum(avg)}` : ''}</div>
      <div class="card"><div class="table-wrap"><table class="table responsive mg-table mg-grades">
        <caption class="sr-only">Оцінки</caption>
        <thead><tr><th scope="col">Дата</th><th scope="col">Предмет</th><th scope="col">Оцінка</th><th scope="col">Тип</th><th scope="col">Викладач</th><th scope="col">Період</th></tr></thead>
        <tbody>${shown.map((x) => html`<tr>
          <td class="nowrap mg-opt" data-label="Дата">${x.ts != null ? dateFmt.format(x.ts) : ''}</td>
          <td class="primary" data-label="Предмет">${x.subject}</td>
          <td class="mg-val" data-label="Оцінка">${x.value ? html`<span class="badge accent">${x.value}</span>` : ''}</td>
          <td class="mg-opt" data-label="Тип">${x.type}</td>
          <td class="mg-opt" data-label="Викладач">${x.teacher}</td>
          <td class="mg-opt" data-label="Період">${x.period}</td>
          <td class="mg-m-meta">${[x.ts != null ? dateFmt.format(x.ts) : '', x.type, x.teacher, x.period].filter(Boolean).join(' · ')}</td>
        </tr>`)}</tbody>
      </table></div></div>
      ${rows.length > shown.length ? html`<div class="center mt4"><button type="button" class="btn btn-secondary" data-action="more">Показати ще ${Math.min(PAGE, rows.length - shown.length)}</button></div>` : ''}`;
  }

  const paintStatus = () => setHTML(sec('status'), statusHtml());
  const paintList = () => setHTML(sec('list'), listHtml());
  const paintSubjects = () => setHTML(sec('subjects'), subjectOptions());
  const sortButtons = () => SORTS.map((s) => html`<button type="button" data-action="sort" data-key="${s.key}" aria-pressed="${S.sort === s.key ? 'true' : 'false'}">${s.label}</button>`);

  setHTML(root, html`
    ${pageHead({ title: 'Оцінки', subtitle: 'Оцінки із зовнішньої колекції — лише для перегляду.' })}
    <div data-sec="status"></div>
    <div class="mg-gap" data-sec="tools-wrap">
      <div class="mg-bar" data-sec="tools">
        <div class="mg-bar-group" data-sec="subjects"></div>
        <div class="input-group mg-bar-search">${icon('search')}<input class="input" type="search" id="mg-g-search" placeholder="Пошук за предметом чи викладачем" aria-label="Пошук оцінок за предметом, викладачем, типом чи оцінкою" autocomplete="off"></div>
        <div class="segmented" role="group" aria-label="Сортування" data-sec="sorts">${sortButtons()}</div>
      </div>
      <div data-sec="list"></div>
    </div>`);
  paintStatus();
  paintSubjects();
  paintList();
  // Без оцінок панель пошуку й сортування не потрібна.
  const syncTools = () => { sec('tools').hidden = !S.items.length; };
  syncTools();

  async function check(el) {
    try {
      S.result = await busy(el, () => api('POST', '/api/admin/grades/check'));
      toastSuccess(S.result.fresh ? `Знайдено нових оцінок: ${S.result.fresh}.` : 'Нових оцінок немає.');
      apply(await api('GET', '/api/admin/grades'));
    } catch (e) {
      toastError(e);
      return;
    }
    if (!ctx.isActive()) return;
    S.limit = PAGE;
    paintStatus();
    paintSubjects();
    syncTools();
    paintList();
  }

  ctx.onCleanup(actions(root, {
    check,
    more: () => { S.limit += PAGE; paintList(); },
    sort: (el) => {
      S.sort = el.dataset.key;
      S.limit = PAGE;
      setHTML(sec('sorts'), sortButtons());
      const active = $(`[data-key="${S.sort}"]`, sec('sorts'));
      if (active) active.focus();
      paintList();
    },
  }));
  ctx.onCleanup(delegate(root, 'change', '#mg-g-subject', (el) => { S.subject = el.value; S.limit = PAGE; paintList(); }));
  ctx.onCleanup(delegate(root, 'input', '#mg-g-search', (el) => { S.q = el.value; S.limit = PAGE; paintList(); }));
}
