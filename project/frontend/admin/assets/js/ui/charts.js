// Dependency-free SVG charts: time series (area or bars), donut, horizontal bars.
import { html, setHTML, uid } from './dom.js';
import { dayFull, dayShort, int } from '../core/format.js';

function niceMax(v, integer) {
  if (integer) v = Math.max(4, v);
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  const max = nf * exp;
  return integer ? Math.ceil(max / 4) * 4 : max;
}

/**
 * Daily series chart. data: [{date, ...}], value(d) -> number.
 * Re-renders on resize; returns a disposer.
 */
export function seriesChart(el, { data, value, format = int, kind = 'area', height = 240, integer = false, label = 'Графік', tipLabel = '' }) {
  const gid = uid('grad');
  const values = data.map((d) => Number(value(d)) || 0);
  const max = niceMax(Math.max(0, ...values), integer);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';

  function render() {
    const w = Math.max(260, el.clientWidth);
    const h = height;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
    const padL = Math.max(...ticks.map((t) => format(t).length)) * 6.4 + 12;
    const padR = 8;
    const padT = 10;
    const padB = 26;
    const iw = w - padL - padR;
    const ih = h - padT - padB;
    const n = data.length;
    const band = iw / Math.max(1, n);
    const x = (i) => (kind === 'bars' ? padL + band * i + band / 2 : padL + (n > 1 ? (iw * i) / (n - 1) : iw / 2));
    const y = (v) => padT + ih - (v / max) * ih;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 72))));

    const grid = ticks.map((t) => html`<line class="grid-line" x1="${padL}" x2="${w - padR}" y1="${y(t)}" y2="${y(t)}"></line>
      <text class="axis" x="${padL - 8}" y="${y(t) + 4}" text-anchor="end">${format(t)}</text>`);
    const showLabel = (i) => i === n - 1 || (i % every === 0 && n - 1 - i >= Math.ceil(every / 2));
    const anchor = (i) => (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
    const xl = data.map((d, i) => (showLabel(i)
      ? html`<text class="axis" x="${x(i)}" y="${h - 6}" text-anchor="${anchor(i)}">${dayShort(d.date)}</text>` : ''));

    let marks;
    if (kind === 'bars') {
      const bw = Math.max(2, Math.min(28, band * 0.62));
      marks = values.map((v, i) => html`<rect class="bar-rect" data-i="${i}" x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, padT + ih - y(v))}" rx="${Math.min(4, bw / 3)}"></rect>`);
    } else {
      const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      const line = `M${pts.join('L')}`;
      const area = `${line}L${x(n - 1).toFixed(1)},${padT + ih}L${x(0).toFixed(1)},${padT + ih}Z`;
      marks = html`<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--chart-1)" stop-opacity=".32"></stop>
          <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0"></stop></linearGradient></defs>
        <path d="${area}" fill="url(#${gid})"></path><path class="line" d="${line}"></path>`;
    }
    setHTML(el, html`<svg viewBox="0 0 ${w} ${h}" height="${h}" role="img" aria-label="${label}">
      ${grid}${xl}${marks}
      <line class="cursor" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" visibility="hidden"></line>
      ${kind === 'bars' ? '' : html`<circle class="dot" r="4.5" cx="0" cy="0" visibility="hidden"></circle>`}
      <rect x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="transparent" data-hit></rect>
    </svg>`);
    el.append(tip);

    const svg = el.querySelector('svg');
    const cursor = svg.querySelector('.cursor');
    const dot = svg.querySelector('.dot');
    const hit = svg.querySelector('[data-hit]');
    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const sx = ((clientX - r.left) / r.width) * w;
      const i = kind === 'bars'
        ? Math.min(n - 1, Math.max(0, Math.floor((sx - padL) / band)))
        : Math.min(n - 1, Math.max(0, Math.round(((sx - padL) / iw) * (n - 1))));
      const cx = x(i);
      const cy = y(values[i]);
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', 'visible');
      if (dot) { dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible'); }
      svg.querySelectorAll('.bar-rect').forEach((b) => b.classList.toggle('is-hover', Number(b.dataset.i) === i));
      setHTML(tip, html`<span class="muted">${dayFull(data[i].date)}</span><b>${format(values[i])}</b>${tipLabel ? html`<span class="muted">${tipLabel(data[i])}</span>` : ''}`);
      tip.classList.add('is-visible');
      const px = (cx / w) * r.width;
      const tw = tip.offsetWidth;
      const left = Math.min(Math.max(px - tw / 2, 0), r.width - tw);
      tip.style.transform = `translate(${left}px, ${Math.max(0, (cy / h) * r.height - tip.offsetHeight - 12)}px)`;
    };
    const hide = () => {
      cursor.setAttribute('visibility', 'hidden');
      dot?.setAttribute('visibility', 'hidden');
      svg.querySelectorAll('.bar-rect.is-hover').forEach((b) => b.classList.remove('is-hover'));
      tip.classList.remove('is-visible');
    };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', hide);
  }

  el.classList.add('chart');
  render();
  let last = el.clientWidth;
  const ro = new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - last) > 4) { last = el.clientWidth; render(); }
  });
  ro.observe(el);
  return () => ro.disconnect();
}

/** Donut with legend. items: [{label, value, color}] */
export function donut({ items, centerValue, centerLabel, format = int }) {
  const total = items.reduce((s, i) => s + (Number(i.value) || 0), 0);
  const r = 58;
  const c = 2 * Math.PI * r;
  const nonzero = items.filter((i) => Number(i.value) > 0).length;
  const gap = nonzero > 1 ? 3 : 0;
  let off = 0;
  const segs = total ? items.filter((i) => Number(i.value) > 0).map((i) => {
    const len = (Number(i.value) / total) * c;
    const seg = html`<circle class="seg" r="${r}" cx="74" cy="74" stroke="${i.color}"
      stroke-dasharray="${Math.max(0, len - gap)} ${c - Math.max(0, len - gap)}" stroke-dashoffset="${-off}" transform="rotate(-90 74 74)"></circle>`;
    off += len;
    return seg;
  }) : '';
  return html`<div class="donut">
    <svg viewBox="0 0 148 148" role="img" aria-label="${centerLabel}: ${format(centerValue ?? total)}">
      <circle class="track" r="${r}" cx="74" cy="74"></circle>${segs}
      <text class="center-value" x="74" y="76" text-anchor="middle">${format(centerValue ?? total)}</text>
      <text class="center-label" x="74" y="95" text-anchor="middle">${centerLabel}</text>
    </svg>
    <div class="donut-legend">${items.map((i) => html`<div class="legend-row" style="--c:${i.color}"><i></i><span>${i.label}</span>
      <span class="v">${format(i.value)}</span><span class="muted small" style="width:38px;text-align:right">${total ? Math.round((Number(i.value) / total) * 100) : 0}%</span></div>`)}</div>
  </div>`;
}

/** Horizontal bars. items: [{label, value, sub, color}] */
export function hbars(items, { format = int } = {}) {
  const max = Math.max(1, ...items.map((i) => Number(i.value) || 0));
  return html`<div class="hbar-list">${items.map((i) => html`<div class="hbar-row">
    <div class="hbar-head"><span class="truncate">${i.label}${i.sub ? html` <span class="muted small">${i.sub}</span>` : ''}</span><span class="v">${format(i.value)}</span></div>
    <div class="bar"><span style="--w:${((Number(i.value) || 0) / max) * 100}%;--c:${i.color || 'var(--accent)'}"></span></div>
  </div>`)}</div>`;
}
