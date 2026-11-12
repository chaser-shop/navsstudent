// Графіки на SVG без сторонніх бібліотек: лінійний, стовпчиковий, горизонтальні смуги, міні-графік.
// Підказки працюють і мишею, і дотиком (initChartTooltips викликається один раз).

import { html, esc } from './dom.js';
import { fmtNum } from './format.js';

const registry = new Map();
let seq = 0;
function register(tips) {
  const id = `ch${++seq}`;
  registry.set(id, tips);
  if (registry.size > 120) registry.delete(registry.keys().next().value);
  return id;
}

// Ширина координатної системи ≈ реальна ширина, щоб підписи не дрібнішали на телефоні.
const viewWidth = (hint) => hint || Math.round(Math.max(320, Math.min(760, window.innerWidth < 1024 ? window.innerWidth - 40 : 760)));

function niceTicks(min, max, count = 4) {
  if (min === max) {
    const d = Math.abs(min) || 1;
    min -= d * 0.5;
    max += d * 0.5;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { lo, hi, ticks };
}
function intTicks(min, max) {
  const lo = Math.max(1, Math.floor(min));
  const hi = Math.max(lo + 1, Math.ceil(max));
  const step = Math.max(1, Math.ceil((hi - lo) / 4));
  const ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] !== hi) ticks.push(hi);
  return { lo, hi, ticks };
}
// Підписи осі X з рівним кроком, без сусідніх підписів (останній — лише якщо не налазить на попередній).
const labelIndexes = (n, max = 6) => {
  if (n <= max) return new Set(Array.from({ length: n }, (_, i) => i));
  const step = Math.ceil((n - 1) / (max - 1));
  const out = new Set();
  let last = 0;
  for (let i = 0; i < n; i += step) { out.add(i); last = i; }
  if (last !== n - 1) {
    if (n - 1 - last < step / 2) out.delete(last);
    out.add(n - 1);
  }
  return out;
};
// Цілі поділки від нуля для лічильників (кількість змін, студентів).
function countTicks(max) {
  const step = Math.max(1, Math.ceil(max / 4));
  const ticks = [];
  for (let v = 0; v < max + step; v += step) ticks.push(v);
  return { lo: 0, hi: ticks[ticks.length - 1], ticks };
}

/**
 * lineChart({ labels, tipLabels?, series: [{ label, color, values, dashed?, area? }], height?, format?, invert?, integer?, min?, max?, empty? })
 * invert — менше значення вгорі (для місць у рейтингу); integer — цілі поділки.
 */
export function lineChart({ labels, tipLabels, series, height = 240, format = fmtNum, invert = false, integer = false, min, max, empty = 'Поки що недостатньо даних для графіка.', width, ariaLabel = 'Графік' }) {
  const all = series.flatMap((s) => s.values).filter((v) => v != null && Number.isFinite(v));
  if (!all.length) return html`<div class="chart-empty">${empty}</div>`;
  const W = viewWidth(width);
  const H = height;
  const pl = 42;
  const pr = 12;
  const pt = 12;
  const pb = 28;
  let lo = min != null ? min : Math.min(...all);
  let hi = max != null ? max : Math.max(...all);
  if (!integer && min == null) {
    const pad = (hi - lo) * 0.15 || Math.max(1, Math.abs(hi) * 0.1);
    lo = all.every((v) => v >= 0) ? Math.max(0, lo - pad) : lo - pad;
    if (max == null) hi += pad * 0.5;
  }
  const scale = integer ? intTicks(lo, hi) : niceTicks(lo, hi);
  const n = labels.length;
  const iw = W - pl - pr;
  const ih = H - pt - pb;
  const x = (i) => (n === 1 ? pl + iw / 2 : pl + (i * iw) / (n - 1));
  const y = (v) => {
    const t = (v - scale.lo) / (scale.hi - scale.lo || 1);
    return invert ? pt + t * ih : pt + ih - t * ih;
  };
  const showLabel = labelIndexes(n, W < 480 ? 4 : 7);
  const grid = scale.ticks.map((t) => html`
    <line class="grid-line" x1="${pl}" x2="${W - pr}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>
    <text class="axis-label" x="${pl - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${integer ? t : fmtNum(t, 1)}</text>`);
  const xLabels = labels.map((l, i) => (showLabel.has(i)
    ? html`<text class="axis-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle'}">${l}</text>`
    : ''));
  const paths = series.map((s) => {
    const segs = [];
    let cur = [];
    s.values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]);
    });
    if (cur.length) segs.push(cur);
    const d = segs.map((seg) => seg.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')).join('');
    const area = s.area && !invert ? segs.filter((seg) => seg.length > 1).map((seg) => `M${seg[0][0].toFixed(1)} ${pt + ih}${seg.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')}L${seg[seg.length - 1][0].toFixed(1)} ${pt + ih}Z`).join('') : '';
    const dots = n <= 45 ? s.values.map((v, i) => (v == null || !Number.isFinite(v) ? '' : html`<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${n <= 14 ? 4 : 3}" fill="${s.color}"/>`)) : '';
    // Одиночна точка без сусідів теж має бути видимою.
    const lone = n > 45 ? segs.filter((seg) => seg.length === 1).map((seg) => html`<circle class="pt" cx="${seg[0][0].toFixed(1)}" cy="${seg[0][1].toFixed(1)}" r="3" fill="${s.color}"/>`) : '';
    return html`${area ? html`<path class="area" d="${area}" fill="${s.color}"/>` : ''}<path class="line ${s.dashed ? 'dashed' : ''}" d="${d}" stroke="${s.color}"/>${dots}${lone}`;
  });
  const band = n === 1 ? iw : iw / (n - 1);
  const hits = labels.map((_, i) => html`<rect class="hit" data-i="${i}" data-x="${x(i).toFixed(1)}" x="${Math.max(pl, x(i) - band / 2).toFixed(1)}" y="${pt}" width="${Math.min(band, iw).toFixed(1)}" height="${ih}"/>`);
  const tips = labels.map((l, i) => ({
    title: (tipLabels || labels)[i],
    rows: series.map((s) => ({ color: s.color, label: s.label, value: s.values[i] == null ? '—' : format(s.values[i]) })),
  }));
  return html`<div class="chart" data-chart="${register(tips)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ariaLabel}">
      ${grid}${xLabels}
      <line class="guide" x1="0" x2="0" y1="${pt}" y2="${pt + ih}"/>
      ${paths}${hits}
    </svg>
  </div>`;
}

/** barChart({ labels, tipLabels?, series: [{ label, color, values }], stacked?, integer?, height?, format? }) */
export function barChart({ labels, tipLabels, series, stacked = false, integer, height = 220, format = fmtNum, empty = 'Поки що немає даних.', width, ariaLabel = 'Діаграма' }) {
  const totals = labels.map((_, i) => (stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(0, ...series.map((s) => s.values[i] || 0))));
  if (!totals.some((v) => v > 0)) return html`<div class="chart-empty">${empty}</div>`;
  const whole = integer != null ? integer : series.every((s) => s.values.every((v) => v == null || Number.isInteger(v)));
  const W = viewWidth(width);
  const H = height;
  const pl = 38;
  const pr = 8;
  const pt = 10;
  const pb = 28;
  const iw = W - pl - pr;
  const ih = H - pt - pb;
  const scale = whole ? countTicks(Math.max(...totals)) : niceTicks(0, Math.max(...totals), 4);
  const y = (v) => pt + ih - (v / (scale.hi || 1)) * ih;
  const n = labels.length;
  const slot = iw / n;
  const groupW = Math.min(slot * 0.72, stacked ? 46 : 22 * series.length + 8);
  const showLabel = labelIndexes(n, W < 480 ? 5 : 8);
  const grid = scale.ticks.map((t) => html`
    <line class="grid-line" x1="${pl}" x2="${W - pr}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>
    <text class="axis-label" x="${pl - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${fmtNum(t, 1)}</text>`);
  const bars = labels.map((_, i) => {
    const cx = pl + slot * i + slot / 2;
    if (stacked) {
      let acc = 0;
      return series.map((s) => {
        const v = s.values[i] || 0;
        if (!v) return '';
        const y1 = y(acc + v);
        const h = y(acc) - y1;
        acc += v;
        return html`<rect class="bar" x="${(cx - groupW / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${groupW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${s.color}"/>`;
      });
    }
    const bw = (groupW - 4 * (series.length - 1)) / series.length;
    return series.map((s, k) => {
      const v = s.values[i] || 0;
      const h = (v / (scale.hi || 1)) * ih;
      return html`<rect class="bar" x="${(cx - groupW / 2 + k * (bw + 4)).toFixed(1)}" y="${(pt + ih - h).toFixed(1)}" width="${Math.max(2, bw).toFixed(1)}" height="${Math.max(v ? 1 : 0, h).toFixed(1)}" rx="3" fill="${s.color}"/>`;
    });
  });
  const xLabels = labels.map((l, i) => (showLabel.has(i) ? html`<text class="axis-label" x="${(pl + slot * i + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${l}</text>` : ''));
  const hits = labels.map((_, i) => html`<rect class="hit" data-i="${i}" data-x="${(pl + slot * i + slot / 2).toFixed(1)}" x="${(pl + slot * i).toFixed(1)}" y="${pt}" width="${slot.toFixed(1)}" height="${ih}"/>`);
  const tips = labels.map((l, i) => ({
    title: (tipLabels || labels)[i],
    rows: series.map((s) => ({ color: s.color, label: s.label, value: format(s.values[i] || 0) })),
  }));
  return html`<div class="chart" data-chart="${register(tips)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ariaLabel}">${grid}${xLabels}<line class="guide" x1="0" x2="0" y1="${pt}" y2="${pt + ih}"/>${bars}${hits}</svg>
  </div>`;
}

/** Горизонтальні смуги: items [{ label, value, color?, mark?, title? }]; mark — позначка (наприклад, середнє групи). */
export function hBars(items, { max, format = fmtNum, markLabel = 'Середнє' } = {}) {
  if (!items.length) return html`<div class="chart-empty">Поки що немає даних.</div>`;
  const top = max || Math.max(1, ...items.map((i) => Math.max(i.value || 0, i.mark || 0)));
  return html`<div class="hbars">${items.map((i) => {
    const w = i.value == null ? 0 : Math.max(0, Math.min(100, (i.value / top) * 100));
    const m = i.mark == null ? null : Math.max(0, Math.min(100, (i.mark / top) * 100));
    const tip = `${i.title || i.label}: ${i.value == null ? '—' : format(i.value)}${i.mark != null ? ` · ${markLabel.toLowerCase()}: ${format(i.mark)}` : ''}`;
    return html`<div class="hbar" title="${tip}">
      <span class="hb-label">${i.label}</span>
      <span class="hb-track"><span class="hb-fill" style="width:${w.toFixed(1)}%;background:${i.color || 'var(--accent)'}"></span>${m != null ? html`<span class="hb-mark" style="left:${m.toFixed(1)}%"></span>` : ''}</span>
      <span class="hb-value">${i.value == null ? '—' : format(i.value)}</span>
    </div>`;
  })}</div>`;
}

/** Міні-графік для карток. */
export function sparkline(values, { color = 'var(--accent)', width = 120, height = 34 } = {}) {
  const pts = values.map((v, i) => [i, v]).filter((p) => p[1] != null);
  if (pts.length < 2) return '';
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const n = values.length - 1 || 1;
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / n) * (width - 4) + 2).toFixed(1)} ${(height - 3 - ((v - lo) / (hi - lo || 1)) * (height - 6)).toFixed(1)}`).join('');
  return html`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function legend(series) {
  return html`<div class="legend">${series.map((s) => html`<span><i class="${s.dashed ? 'dash' : ''}" style="background:${s.color}"></i>${s.label}</span>`)}</div>`;
}

// ───────── Підказки ─────────
let tipEl = null;
let activeChart = null;
function hideTip() {
  if (tipEl) { tipEl.remove(); tipEl = null; }
  if (activeChart) { activeChart.querySelectorAll('.guide').forEach((g) => g.classList.remove('on')); activeChart = null; }
}
function onPointer(e) {
  const hit = e.target && e.target.closest ? e.target.closest('.chart .hit') : null;
  if (!hit) { if (tipEl) hideTip(); return; }
  const chart = hit.closest('.chart');
  const tips = registry.get(chart.dataset.chart);
  if (!tips) return;
  const tip = tips[+hit.dataset.i];
  if (!tip) return;
  if (activeChart && activeChart !== chart) hideTip();
  activeChart = chart;
  chart.querySelectorAll('.guide').forEach((g) => { g.setAttribute('x1', hit.dataset.x); g.setAttribute('x2', hit.dataset.x); g.classList.add('on'); });
  if (!tipEl || tipEl.parentNode !== chart) {
    if (tipEl) tipEl.remove();
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    tipEl.setAttribute('role', 'tooltip');
    chart.appendChild(tipEl);
  }
  tipEl.innerHTML = `<b>${esc(tip.title)}</b>${tip.rows.map((r) => `<div class="row"><span class="sw" style="background:${esc(r.color)}"></span>${esc(r.label)}: <b>${esc(r.value)}</b></div>`).join('')}`;
  const cr = chart.getBoundingClientRect();
  const hr = hit.getBoundingClientRect();
  const half = Math.min(110, cr.width / 2);
  const left = Math.max(half, Math.min(cr.width - half, hr.left + hr.width / 2 - cr.left));
  const top = Math.max(tipEl.offsetHeight + 12, Math.min(cr.height, e.clientY - cr.top));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}
let tooltipsReady = false;
export function initChartTooltips() {
  if (tooltipsReady) return;
  tooltipsReady = true;
  document.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('pointerdown', onPointer, { passive: true });
  window.addEventListener('scroll', hideTip, { passive: true, capture: true });
}
