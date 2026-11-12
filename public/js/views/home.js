// Головна: привітання, підсумок балів, щоденний прогрес, пари на сьогодні, «Що задали?», найближче домашнє.

import { api } from '../core/api.js';
import { html, setHTML, $, actions, busy } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { store, on, subjectName, subjectLink, isDone, isAnswered, markAnswered, canModerate, sync } from '../core/store.js';
import { fmtNum, fmtSigned, fmtPct, fmtDate, fmtTime, fmtWeekday, dayKey, relTime, sourceLabel } from '../core/format.js';
import { toast, toastError, skeleton } from '../core/ui.js';
import { insightsList } from './progress.js';

const KIND = { 'Лк': 'Лекція', 'Пз': 'Практичне заняття', 'Сем': 'Семінар' };
const greeting = () => {
  const h = Number(new Intl.DateTimeFormat('uk-UA', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/Kyiv' }).format(new Date()));
  return h < 5 ? 'Доброї ночі' : h < 12 ? 'Доброго ранку' : h < 18 ? 'Доброго дня' : 'Доброго вечора';
};
const firstName = (full) => String(full || '').trim().split(/\s+/)[1] || '';
const capitalize = (s) => (s ? s[0].toLocaleUpperCase('uk') + s.slice(1) : s);
// На головній — найважливіші повідомлення: місце, загальний бал, рекорд тижня, далі найбільші зміни предметів.
const PRIORITY = { rank: 0, total: 1, best: 2, subject: 3, steady: 4, info: 5 };
const topInsights = (items) => [...(items || [])]
  .sort((a, b) => (PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9) || Math.abs(b.percent || 0) - Math.abs(a.percent || 0))
  .slice(0, 4);

function lessonsInfo(now) {
  const lessons = ((store.data && store.data.lessons) || []).slice().sort((a, b) => new Date(a.start) - new Date(b.start));
  const today = dayKey(now);
  const todays = lessons.filter((l) => dayKey(l.start) === today);
  const current = lessons.find((l) => new Date(l.start) <= now && now < new Date(l.end)) || null;
  const next = lessons.find((l) => new Date(l.start) > now) || null;
  return { lessons, todays, current, next };
}

function lessonRow(l, now) {
  const start = new Date(l.start);
  const end = new Date(l.end);
  const live = start <= now && now < end;
  const past = end <= now;
  const place = l.isRemote ? 'Дистанційно' : l.room ? `ауд. ${l.room}` : '';
  return html`<a class="lesson ${live ? 'now' : ''} ${past ? 'past' : ''}" href="/schedule?lesson=${encodeURIComponent(l.id)}" style="text-decoration:none">
    <div class="time"><div class="t1">${fmtTime(start)}</div><div class="t2">${fmtTime(end)}</div></div>
    <span class="bar" style="--lc:var(--c${(l.pair || 1) % 8 || 8})"></span>
    <div class="info">
      <div class="subj">${subjectName(l.subjectKey)} ${live ? html`<span class="badge success">Зараз</span>` : ''}</div>
      <div class="details">${[KIND[l.kind] || '', place, l.teacher || ''].filter(Boolean).map((x) => html`<span>${x}</span>`)}</div>
    </div>
  </a>`;
}

function askCards(now) {
  const homework = (store.data && store.data.homework) || [];
  const today = dayKey(now);
  return ((store.data && store.data.lessons) || [])
    .filter((l) => new Date(l.end) <= now && dayKey(l.end) === today && !isAnswered(l.id) && !homework.some((h) => h.lessonID === l.id))
    .slice(-3)
    .reverse();
}

export default async function home(ctx) {
  const u = store.user;
  ctx.setTitle('Головна');
  const render = (ov) => {
    const now = new Date();
    const { todays, current, next } = lessonsInfo(now);
    const asks = askCards(now);
    const soon = ((store.data && store.data.homework) || [])
      .filter((h) => h.status !== 'rejected' && !isDone(h.id) && new Date(h.due) >= new Date(now.getTime() - 86400000))
      .sort((a, b) => new Date(a.due) - new Date(b.due))
      .slice(0, 4);
    const tomorrowFirst = !todays.length && next ? next : null;
    const highlight = current || (next && dayKey(next.start) === dayKey(now) ? next : null);
    const link = highlight ? subjectLink(highlight.subjectKey) : '';
    setHTML(ctx.root, html`
      <div class="hello">
        <div class="date">${capitalize(fmtWeekday(now))}, ${fmtDate(now)}</div>
        <h1>${greeting()}${firstName(u.fullName) ? `, ${firstName(u.fullName)}` : ''}!</h1>
      </div>
      <div class="split">
        <div class="stack lg">
          ${ov === null ? skeleton(1) : ov && ov.linked ? hero(ov) : notLinkedCard()}
          ${ov && ov.linked ? html`<section class="card">
            <div class="card-head"><h2>Прогрес за добу</h2><a class="small" href="/progress/stats">Статистика</a></div>
            ${insightsList(topInsights(ov.insights))}
            ${ov.insights.length > 4 ? html`<div class="card-foot"><a class="small" href="/progress/stats">Усі повідомлення (${ov.insights.length})</a></div>` : ''}
          </section>` : ''}
          <section class="card">
            <div class="card-head"><h2>${todays.length ? 'Пари сьогодні' : 'Сьогодні пар немає'}</h2><a class="small" href="/schedule">Розклад</a></div>
            ${highlight ? html`<div class="card-body" style="border-bottom:1px solid var(--border)">
              <div class="flex between wrap">
                <div class="grow">
                  <div class="xs muted strong">${current ? 'Зараз іде' : `Наступна пара о ${fmtTime(highlight.start)}`}</div>
                  <div class="strong" style="font-size:17px">${subjectName(highlight.subjectKey)}</div>
                  <div class="small muted">${[KIND[highlight.kind] || '', highlight.isRemote ? 'Дистанційно' : highlight.room ? `ауд. ${highlight.room}` : ''].filter(Boolean).join(' · ')}</div>
                </div>
                ${link ? html`<a class="btn btn-primary" href="${link}" target="_blank" rel="noopener" data-external>${icon('video')} Приєднатися</a>` : ''}
              </div>
            </div>` : ''}
            ${todays.length ? html`<div class="list">${todays.map((l) => lessonRow(l, now))}</div>`
              : html`<div class="card-body muted">${tomorrowFirst ? html`Наступна пара — ${fmtWeekday(tomorrowFirst.start)}, ${fmtDate(tomorrowFirst.start)} о ${fmtTime(tomorrowFirst.start)}: <b>${subjectName(tomorrowFirst.subjectKey)}</b>.` : 'Розклад ще не завантажено або пар найближчим часом немає.'}</div>`}
          </section>
        </div>
        <div class="stack lg">
          ${asks.length ? html`<section class="card">
            <div class="card-head"><h2>Що задали?</h2><span class="hint">пари, що вже закінчилися</span></div>
            <div class="list">${asks.map((l) => html`<div class="list-item">
              <div class="grow"><div class="title">${subjectName(l.subjectKey)}</div><div class="meta">${fmtTime(l.start)}–${fmtTime(l.end)}</div></div>
              <div class="btn-row">
                <button type="button" class="btn btn-ghost btn-sm" data-action="noHomework" data-id="${l.id}">Нічого</button>
                <a class="btn btn-soft btn-sm" href="/homework?lesson=${encodeURIComponent(l.id)}&new=1">${icon('plus')} Записати</a>
              </div>
            </div>`)}</div>
          </section>` : ''}
          <section class="card">
            <div class="card-head"><h2>Найближче домашнє</h2><a class="small" href="/homework">Усе домашнє</a></div>
            ${soon.length ? html`<div class="list">${soon.map((h) => html`<a class="list-item" href="/homework">
              <div class="grow"><div class="title">${subjectName(h.subjectKey)}</div><div class="meta">${h.text}</div></div>
              <span class="badge ${dayKey(h.due) === dayKey(now) ? 'warning' : 'outline'}">${dayKey(h.due) === dayKey(now) ? 'Сьогодні' : fmtDate(h.due)}</span>
            </a>`)}</div>` : html`<div class="card-body muted">Невиконаного домашнього на найближчі дні немає.</div>`}
          </section>
          ${ov && ov.linked && ov.recent && ov.recent.length ? html`<section class="card">
            <div class="card-head"><h2>Останні зміни балів</h2><a class="small" href="/progress/history">Історія</a></div>
            <div class="list">${ov.recent.slice(0, 4).map((r) => html`<div class="list-item">
              <div class="grow"><div class="title">${r.subjectName}</div><div class="meta">${sourceLabel(r.source)} · ${relTime(r.at)}</div></div>
              <span class="strong num">${r.value == null ? '—' : fmtNum(r.value)}</span>
            </div>`)}</div>
          </section>` : ''}
        </div>
      </div>`);
  };

  const hero = (ov) => {
    const p = ov.progress;
    return html`<section class="hero">
      <div class="flex between start">
        <div>
          <div class="hero-label">Сума балів</div>
          <div class="hero-value">${ov.total == null ? '—' : fmtNum(ov.total)}</div>
        </div>
        ${p && p.delta ? html`<span class="delta ${p.delta > 0 ? 'up' : 'down'}" title="Від початку обліку">${icon(p.delta > 0 ? 'arrow-up' : 'arrow-down')}${fmtSigned(Math.abs(p.delta)).replace(/^[+−]/, '')}</span>` : ''}
      </div>
      <div class="hero-row">
        <div class="hero-stat"><div class="v">${ov.rank ? `${ov.rank} з ${ov.ranked}` : '—'}</div><div class="l">місце в групі</div></div>
        <div class="hero-stat"><div class="v">${ov.groupAvg == null ? '—' : fmtNum(ov.groupAvg)}</div><div class="l">середнє групи</div></div>
        ${p ? html`<div class="hero-stat"><div class="v">${p.percent == null ? fmtSigned(p.delta) : fmtPct(p.percent)}</div><div class="l">з ${fmtDate(p.since)}</div></div>` : ''}
      </div>
      <div class="btn-row mt4">
        <a class="btn btn-sm btn-light" href="/progress">${icon('target')} Мої бали</a>
        <a class="btn btn-sm btn-light" href="/progress/rating">${icon('award')} Рейтинг групи</a>
      </div>
    </section>`;
  };

  const notLinkedCard = () => html`<section class="card card-pad">
    <div class="flex start"><span class="empty-icon" style="display:grid;place-items:center;width:44px;height:44px;border-radius:14px;background:var(--accent-soft);color:var(--accent);flex:none">${icon('user-check')}</span>
    <div><h2 style="font-size:16px">Рейтинг ще не підключено</h2><p class="muted small mt1">Адміністратор має прив’язати ваш акаунт до вашого запису в рейтингу групи. Після цього тут з’являться бали, місце в групі та щоденний прогрес.</p></div></div>
  </section>`;

  let overview = null;
  render(null);
  const loadOverview = async () => {
    try {
      overview = await api('GET', '/api/me/overview');
    } catch (e) {
      overview = { linked: false, error: e };
    }
    if (ctx.isActive()) render(overview);
  };
  ctx.onCleanup(actions(ctx.root, {
    noHomework: (el) => busy(el, async () => {
      const id = el.dataset.id;
      try {
        if (canModerate()) await api('POST', `/api/lessons/${encodeURIComponent(id)}/no-homework`);
        await markAnswered(id);
        toast(canModerate() ? 'Позначено для всіх: нічого не задали.' : 'Позначено: нічого не задали.', { type: 'success' });
        if (canModerate()) sync().catch(() => {});
        if (ctx.isActive()) render(overview);
      } catch (e) { toastError(e); }
    }),
  }));
  ctx.onCleanup(on('sync', () => { if (ctx.isActive() && !document.querySelector('.modal-backdrop')) render(overview); }));
  const tick = setInterval(() => { if (ctx.isActive()) render(overview); }, 60000);
  ctx.onCleanup(() => clearInterval(tick));
  await loadOverview();
}

