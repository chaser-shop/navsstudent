// Price-list import: choose file, dry run report, confirmed apply.
import { api } from '../core/api.js';
import { count, fileSize, int } from '../core/format.js';
import { invalidateCatalog } from '../core/state.js';
import { html, on, setHTML } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { setLoading } from '../ui/components.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';

const MAX = 20 * 1024 * 1024;

export default function importPage({ root }) {
  let file = null;
  let report = null;
  let result = null;

  const step = () => (result ? 3 : report ? 2 : file ? 1 : 0);

  function render() {
    const s = step();
    const stepCls = (n) => (s > n || (n === 3 && result) ? 'is-done' : s === n || (n === 1 && s === 0) ? 'is-active' : '');
    setHTML(root, html`<div class="page-header">
        <div><h1 class="page-title">Імпорт прайсу</h1><p class="page-desc">Оновлення каталогу з файлу products_clean.json</p></div>
      </div>
      <div class="steps" aria-label="Етапи імпорту">
        <span class="step ${stepCls(1)}"><b>1</b>Файл</span><span class="step ${stepCls(2)}"><b>2</b>Перевірка</span><span class="step ${stepCls(3)}"><b>3</b>Запис у базу</span>
      </div>
      <div class="grid grid-main" style="align-items:start">
        <div class="stack" style="gap:16px">
          <section class="card"><div class="card-body stack">
            <label class="dropzone" id="drop" tabindex="0" for="imp-file">
              <span class="empty-icon" style="margin:0">${icon(file ? 'file-check' : 'file-json', { size: 22 })}</span>
              ${file ? html`<span class="cell-title">${file.name}</span><span class="muted small">${fileSize(file.size)} · натисніть, щоб обрати інший файл</span>`
                : html`<span class="cell-title">Перетягніть файл сюди або натисніть, щоб обрати</span><span class="muted small">JSON-файл до 20 МБ</span>`}
            </label>
            <input type="file" id="imp-file" accept=".json,application/json" hidden>
            <div class="row row-wrap row-end">
              <button type="button" class="btn" data-action="check" ${file ? '' : 'disabled'}>${icon('list-checks', { size: 16 })}Перевірити файл</button>
              <button type="button" class="btn btn-primary" data-action="apply" ${report && !result ? '' : 'disabled'}>${icon('upload', { size: 16 })}Імпортувати</button>
            </div>
          </div></section>
          ${report ? reportCard(report, Boolean(result)) : ''}
        </div>
        <aside class="card"><div class="card-header"><h2 class="card-title">Як працює імпорт</h2></div>
          <div class="card-body"><ul class="reasons">
            <li>${icon('check', { size: 14 })}Спершу файл перевіряється — у базу нічого не записується.</li>
            <li>${icon('check', { size: 14 })}Повторний імпорт не створює дублікатів: товар упізнається за ключем із прайсу.</li>
            <li>${icon('check', { size: 14 })}В існуючих товарах оновлюються лише ціна й наявність. Назви, фото й лінійки, змінені вручну, зберігаються.</li>
            <li>${icon('check', { size: 14 })}Позиції, яких немає в наявності, пропускаються.</li>
            <li>${icon('check', { size: 14 })}Ціни розраховуються за поточними націнками, юридичні позначки — автоматично.</li>
          </ul></div></aside>
      </div>`);
  }

  function reportCard(r, done) {
    const stat = (v, l, tone = '') => html`<div class="stat-mini"><div class="v ${tone}">${int(v)}</div><div class="l">${l}</div></div>`;
    return html`<section class="card">
      <div class="card-header"><div><h2 class="card-title">${done ? 'Імпорт завершено' : 'Результат перевірки'}</h2>
        <p class="card-sub">${done ? 'Зміни записано в базу' : 'Попередній перегляд — у базу ще нічого не записано'}</p></div></div>
      <div class="card-body stack">
        ${done ? html`<div class="callout success">${icon('circle-check', { size: 17 })}<div>Додано ${count(r.to_insert, ['товар', 'товари', 'товарів'])}, оновлено ${int(r.to_update)}. <a class="link" href="#/products">Перейти до товарів</a></div></div>` : ''}
        <div class="report-grid">
          ${stat(r.total_rows, 'Рядків у файлі')}
          ${stat(r.to_insert, done ? 'Додано' : 'Буде додано', r.to_insert ? 'tone-success' : '')}
          ${stat(r.to_update, done ? 'Оновлено' : 'Буде оновлено', r.to_update ? 'tone-info' : '')}
          ${stat(r.unchanged, 'Без змін')}
          ${stat(r.skipped_unavailable, 'Пропущено: немає в наявності')}
          ${stat(r.errors.length, 'Рядків з помилками', r.errors.length ? 'tone-danger' : '')}
        </div>
        ${r.errors.length ? html`<div class="stack stack-sm"><span class="label">Рядки з помилками не будуть імпортовані</span>
          <ul class="err-list">${r.errors.map((e) => html`<li><span class="muted tabular nowrap">№ ${e.row + 1}</span><span class="grow">${e.name || 'Без назви'}: ${e.error}</span></li>`)}</ul></div>` : ''}
        ${!done && !r.to_insert && !r.to_update ? html`<div class="callout info">${icon('info', { size: 17 })}<div>Файл не містить нових товарів чи змін — імпортувати нічого.</div></div>` : ''}
      </div></section>`;
  }

  function choose(f) {
    if (!f) return;
    if (!/\.json$/i.test(f.name)) { toast.error('Підтримується лише JSON-файл (products_clean.json)'); return; }
    if (f.size > MAX) { toast.error('Файл завеликий: максимум 20 МБ'); return; }
    file = f;
    report = null;
    result = null;
    render();
  }

  async function send(dry) {
    const fd = new FormData();
    fd.append('file', file);
    return api('/api/import', { method: 'POST', query: { dry_run: dry ? 'true' : 'false' }, body: fd });
  }

  on(root, 'change', '#imp-file', (e, i) => { choose(i.files[0]); i.value = ''; });
  on(root, 'keydown', '#drop', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); root.querySelector('#imp-file').click(); } });
  on(root, 'dragover', '#drop', (e, d) => { e.preventDefault(); d.classList.add('is-over'); });
  on(root, 'dragleave', '#drop', (e, d) => d.classList.remove('is-over'));
  on(root, 'drop', '#drop', (e, d) => { e.preventDefault(); d.classList.remove('is-over'); choose(e.dataTransfer.files[0]); });
  on(root, 'click', '[data-action="check"]', async (e, b) => {
    setLoading(b, true);
    try {
      report = await send(true);
      result = null;
      render();
      toast.info('Перевірку завершено. Перегляньте результат перед імпортом.');
    } catch (ex) { toastError(ex); setLoading(b, false); }
  });
  on(root, 'click', '[data-action="apply"]', async (e, b) => {
    const ok = await confirmDialog({ title: 'Записати зміни в базу?', confirmText: 'Імпортувати',
      text: `Буде додано ${count(report.to_insert, ['товар', 'товари', 'товарів'])} та оновлено ${int(report.to_update)}. Дію не можна скасувати автоматично.` });
    if (!ok) return;
    setLoading(b, true);
    try {
      result = await send(false);
      report = result;
      invalidateCatalog();
      render();
      toast.success('Імпорт завершено');
    } catch (ex) { toastError(ex); setLoading(b, false); }
  });
  render();
}
