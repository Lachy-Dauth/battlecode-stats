// Small dependency-free SVG charts: time-series lines with a crosshair
// tooltip, sparklines, and column charts. Colors come from CSS tokens.

const NS = 'http://www.w3.org/2000/svg';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

function timeTicks(t0, t1, width) {
  const span = t1 - t0;
  const want = Math.max(2, Math.floor(width / 90));
  const steps = [3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400];
  const step = steps.find((s) => span / s <= want) || 7 * 86400;
  const ticks = [];
  // Align to local midnight/hour boundaries.
  const d = new Date(t0 * 1000);
  if (step >= 86400) d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0);
  let t = d.getTime() / 1000;
  while (t < t0) t += step;
  for (; t <= t1; t += step) ticks.push(t);
  return { ticks, step };
}

const fmtTick = (t, step) => {
  const d = new Date(t * 1000);
  if (step >= 86400) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (d.getHours() === 0) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleTimeString(undefined, { hour: 'numeric' });
};
export const fmtWhen = (t) => new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Step-line time series. series: [{name, points: [[t, v]], cls}] where cls
 * picks a color slot (s1..s8). opts: {height, invert, fmt, label, band}
 */
export function lineChart(host, series, opts = {}) {
  host.classList.add('chart');
  host.innerHTML = '';
  const tip = document.createElement('div');
  tip.className = 'tip';
  host.appendChild(tip);
  const svg = el('svg', { role: 'img', 'aria-label': opts.label || 'chart' }, host);
  const fmt = opts.fmt || ((v) => String(Math.round(v)));
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) { host.insertAdjacentHTML('beforeend', '<p class="muted empty">No data yet.</p>'); return; }
  const now = opts.now || Math.max(...pts.map((p) => p[0]));
  const t0 = opts.t0 ?? Math.min(...pts.map((p) => p[0]));
  const t1 = Math.max(now, ...pts.map((p) => p[0]));
  const vals = pts.map((p) => p[1]);
  const y = niceTicks(Math.min(...vals), Math.max(...vals), 5);

  function draw() {
    const W = Math.max(280, host.clientWidth), H = opts.height || 240;
    const m = { l: 48, r: 14, t: 12, b: 26 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = '';
    const X = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
    const Y = (v) => {
      const f = (v - y.lo) / (y.hi - y.lo || 1);
      return opts.invert ? m.t + f * (H - m.t - m.b) : H - m.b - f * (H - m.t - m.b);
    };
    const g = el('g', { class: 'grid' }, svg);
    for (const v of y.ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, g);
      el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' }, g).textContent = fmt(v);
    }
    const xt = timeTicks(t0, t1, W - m.l - m.r);
    for (const t of xt.ticks) {
      el('text', { x: X(t), y: H - 8, 'text-anchor': 'middle', class: 'axis' }, g).textContent = fmtTick(t, xt.step);
    }
    // Reference lines (e.g. tier boundaries), labelled just above the line.
    for (const b of opts.bands || []) {
      if (b.from <= y.lo || b.from >= y.hi) continue;
      el('line', { x1: m.l, x2: W - m.r, y1: Y(b.from), y2: Y(b.from), class: 'band-line' }, g);
      el('text', { x: m.l + 6, y: Y(b.from) - 4, class: 'band-label' }, g).textContent = b.label;
    }
    for (const s of series) {
      if (!s.points.length) continue;
      let d = '';
      s.points.forEach(([t, v], i) => {
        d += i ? `H${X(t).toFixed(1)}V${Y(v).toFixed(1)}` : `M${X(t).toFixed(1)},${Y(v).toFixed(1)}`;
      });
      const last = s.points[s.points.length - 1];
      d += `H${X(now).toFixed(1)}`;
      el('path', { d, class: `line ${s.cls || 's1'}` }, svg);
      el('circle', { cx: X(now), cy: Y(last[1]), r: 3.5, class: `end ${s.cls || 's1'}` }, svg);
    }
    const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
    const dots = series.map((s) => el('circle', { r: 4, class: `dot ${s.cls || 's1'}`, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const t = t0 + ((px - m.l) / (W - m.l - m.r)) * (t1 - t0);
      const rows = [];
      series.forEach((s, i) => {
        let v = null;
        for (const p of s.points) { if (p[0] <= t) v = p[1]; else break; }
        if (v == null) { dots[i].setAttribute('visibility', 'hidden'); return; }
        dots[i].setAttribute('cx', X(Math.min(t, t1))); dots[i].setAttribute('cy', Y(v));
        dots[i].setAttribute('visibility', 'visible');
        rows.push(`<div><i class="key ${s.cls || 's1'}"></i>${series.length > 1 ? `${esc(s.name)} ` : ''}<b>${esc(fmt(v))}</b></div>`);
      });
      cross.setAttribute('x1', X(Math.min(t, t1))); cross.setAttribute('x2', X(Math.min(t, t1)));
      cross.setAttribute('visibility', 'visible');
      tip.innerHTML = `<div class="tip-h">${fmtWhen(t)}</div>${rows.join('')}`;
      tip.style.display = 'block';
      const left = ((X(Math.min(t, t1))) / W) * r.width;
      tip.style.left = `${Math.min(Math.max(0, left + 12), r.width - tip.offsetWidth)}px`;
      tip.style.top = '8px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => {
      tip.style.display = 'none';
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    });
  }
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(host);
}

/** Inline sparkline SVG string for table cells. */
export function sparkline(points, { w = 88, h = 22 } = {}) {
  if (!points || points.length < 2) return '';
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const X = (t) => 1 + ((t - t0) / Math.max(1, t1 - t0)) * (w - 4);
  const Y = (v) => h - 2 - ((v - lo) / Math.max(1, hi - lo)) * (h - 4);
  const d = points.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}"/><circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="2"/></svg>`;
}

/**
 * Vertical columns with hover. bars: [{label, values: [v...], tip}] stacked
 * bottom-up using classes from opts.classes.
 */
export function columnChart(host, bars, opts = {}) {
  host.classList.add('chart');
  host.innerHTML = '';
  const tip = document.createElement('div');
  tip.className = 'tip';
  host.appendChild(tip);
  const svg = el('svg', { role: 'img', 'aria-label': opts.label || 'chart' }, host);
  const classes = opts.classes || ['s1', 's2', 's3'];
  const totals = bars.map((b) => b.values.reduce((a, c) => a + c, 0));
  const y = niceTicks(0, Math.max(1, ...totals), 4);
  function draw() {
    const W = Math.max(280, host.clientWidth), H = opts.height || 200;
    const m = { l: 44, r: 8, t: 10, b: 26 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = '';
    const Y = (v) => H - m.b - (v / (y.hi || 1)) * (H - m.t - m.b);
    const g = el('g', { class: 'grid' }, svg);
    for (const v of y.ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, g);
      el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' }, g).textContent = opts.fmt ? opts.fmt(v) : v;
    }
    const slot = (W - m.l - m.r) / bars.length;
    const bw = Math.max(1, Math.min(28, slot - 2));
    const every = Math.ceil(bars.length / Math.max(2, Math.floor((W - m.l) / 70)));
    bars.forEach((b, i) => {
      const x = m.l + i * slot + (slot - bw) / 2;
      let acc = 0;
      b.values.forEach((v, k) => {
        if (!v) return;
        const y0 = Y(acc), y1 = Y(acc + v);
        el('rect', { x, y: y1 + (acc ? 1 : 0), width: bw, height: Math.max(0.5, y0 - y1 - (acc ? 1 : 0)), rx: Math.min(2, bw / 3), class: `bar ${classes[k]}` }, svg);
        acc += v;
      });
      if ((opts.sparse || i % every === 0) && b.label) el('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'axis' }, g).textContent = b.label;
      const hit = el('rect', { x: m.l + i * slot, y: m.t, width: slot, height: H - m.t - m.b, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', (ev) => {
        const r = svg.getBoundingClientRect();
        tip.innerHTML = b.tip;
        tip.style.display = 'block';
        tip.style.left = `${Math.min(Math.max(0, ((x + bw) / W) * r.width + 8), r.width - tip.offsetWidth)}px`;
        tip.style.top = '8px';
      });
      hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    });
  }
  draw();
  new ResizeObserver(() => draw()).observe(host);
}

/** Horizontal percentage bars as plain HTML (labels stay in text ink). */
export function hbars(rows, { fmt = (v) => `${(v * 100).toFixed(1)}%`, max } = {}) {
  const top = max ?? Math.max(1e-9, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar-row"${r.title ? ` title="${esc(r.title)}"` : ''}>
      <div class="hbar-label">${r.labelHtml ?? esc(r.label)}</div>
      <div class="hbar-track"><div class="hbar-fill ${r.cls || 's1'}" style="width:${Math.max(0.5, (r.value / top) * 100).toFixed(2)}%"></div></div>
      <div class="hbar-value">${fmt(r.value)}</div>
    </div>`).join('')}</div>`;
}
