// Sediment — a small, dependency-free SVG chart toolkit.
//
// Self-contained: no framework, no build step, no globals beyond the single
// `Sediment` object it exports. Every builder takes RESOLVED values — colours
// as CSS colour strings, data as plain numbers, text via formatter callbacks —
// so the module carries no app-specific knowledge and can be lifted into any
// project. The consumer writes a thin adapter that resolves its theme tokens
// (e.g. with getComputedStyle) and feeds these builders resolved values.
//
// Companion styles live in sediment.css (SVG text uses `fill: currentColor`, and
// the tip() tooltip expects the `#... tooltip` rules); load it alongside this
// file. See README.md for the per-builder cfg contracts and demo.html for a
// runnable example.
//
// The house style is Tufte-ish: range-frame axes, a dotted hairline grid, direct
// labels at line ends, and — the distinctive part — a texture() encoding that
// tells series apart by mark shape/scale/density instead of colour, so the charts
// stay legible with no colour channel at all (the accessibility win).
//
// Public API (all under window.Sediment):
//   svgEl(tag, attrs)                     low-level SVG element
//   frame(host, H)                        -> {svg, W, H}; appends a responsive svg
//   yScale(min,max,y0,y1) -> v=>y         linear scale
//   niceTicks(min,max,n) -> [t...]        rounded tick values
//   grid(svg, ticks, yFn, x0, x1, opts)   dotted gridlines + y labels
//   monthTicks / placedMonthTicks         evenly-spaced, de-overlapped month ticks
//   tip(el) -> {show(host,x,y,html),hide} floating tooltip bound to an element
//   texture(svg, i, n, ink, opts)         pattern fill for band i of n (last = solid)
//   chip(i, n, ink, size)                 inline-SVG swatch string of that texture
//   lineChart(cfg) / stackedArea(cfg) / columnChart(cfg) / dotPlot(cfg) /
//   segmentedBar(cfg)                     chart builders (see each for cfg shape)

(function (global) {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  let textureSvgSeq = 0;   // per-svg serial so texture pattern ids stay unique
  let clipPathSeq = 0;     // per-svg serial so clip path ids stay unique

  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // A responsive svg sized to its host's width and a fixed height H. viewBox
  // uses the measured pixel width so 1 user-unit == 1 CSS px at full width.
  function frame(host, H) {
    const W = Math.max(host.clientWidth, 320);
    const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", height: H });
    host.appendChild(svg);
    return { svg, W, H };
  }

  const yScale = (min, max, y0, y1) =>
    v => y1 - (v - min) / ((max - min) || 1) * (y1 - y0);

  function niceTicks(min, max, n) {
    const span = (max - min) || 1, step0 = span / n,
      mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || mag * 10;
    const out = [];
    for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(t);
    return out;
  }

  // Dotted hairline grid with right-aligned y labels — the quietest grid that
  // still reads. opts: { hair, label(t)->string, pad=8 }.
  function grid(svg, ticks, yFn, x0, x1, opts) {
    const o = opts || {};
    const hair = o.hair || "currentColor", label = o.label, pad = o.pad == null ? 8 : o.pad;
    for (const t of ticks) {
      const y = yFn(t);
      svg.appendChild(svgEl("line", { x1: x0, x2: x1, y1: y, y2: y,
        stroke: hair, "stroke-width": 1, "stroke-dasharray": "1 4" }));
      if (label) {
        const lb = svgEl("text", { x: x0 - pad, y: y + 4, "text-anchor": "end" });
        lb.textContent = label(t);
        svg.appendChild(lb);
      }
    }
  }

  // Evenly spaced month ticks (ms) across [t0,t1]: first pinned to t0 so it never
  // clips left; the rest on whole-month boundaries, stepped so ~5 show.
  function monthTicks(t0, t1) {
    const d0 = new Date(t0), d1 = new Date(t1);
    const span = (d1.getFullYear() - d0.getFullYear()) * 12 + d1.getMonth() - d0.getMonth();
    if (span <= 0) return [t0];
    const step = [1, 2, 3, 6, 12, 24].find(s => span / s <= 5) || 36;
    const out = [t0];
    for (let t = new Date(d0.getFullYear(), d0.getMonth() + step, 1).getTime(); t <= t1; ) {
      out.push(t);
      const d = new Date(t);
      t = new Date(d.getFullYear(), d.getMonth() + step, 1).getTime();
    }
    return out;
  }

  // monthTicks thinned so adjacent labels can't collide, given a projection x(t).
  // The first label is start-anchored (extends right of its tick; the rest are
  // centred), so it claims an extra half-gap — otherwise a t0 late in the month
  // sits almost on top of the next whole-month tick.
  function placedMonthTicks(t0, t1, x, minGap) {
    const gap = minGap == null ? 48 : minGap;
    let lastX = -1e9;
    return monthTicks(t0, t1).filter((t, i) => {
      if (i === 0) { lastX = x(t) + gap / 2; return true; }
      if (x(t) - lastX < gap) return false;
      lastX = x(t);
      return true;
    });
  }

  // Floating tooltip bound to a fixed positioned element. Returns show/hide; the
  // caller passes host-relative (x,y) in CSS px and pre-built HTML.
  function tip(el) {
    return {
      show(host, x, y, html) {
        el.innerHTML = html;
        el.style.display = "block";
        const hr = host.getBoundingClientRect(), mr = el.getBoundingClientRect();
        let left = hr.left + window.scrollX + x + 14;
        if (left + mr.width > window.scrollX + document.documentElement.clientWidth - 8)
          left = hr.left + window.scrollX + x - mr.width - 14;
        el.style.left = left + "px";
        el.style.top = Math.max(window.scrollY + 4,
          hr.top + window.scrollY + y - mr.height - 10) + "px";
      },
      hide() { el.style.display = "none"; },
    };
  }

  // ── texture generator ──────────────────────────────────────────────────────
  // A value is encoded by tiling a small mint square or circle (Figma
  // pattern-square 1:398 / pattern-circle 1:403). Contrast between keys rides on
  // two Figma pattern params with BIG jumps — SCALE (mark size, % of source) and
  // SPACING (gap between marks, % of the mark) — plus shape and tile type
  // (rectangular / hexagonal). Calibrated to the five reference patterns
  // (dense→sparse): {square,rect,50%,15%} · {circle,hex,50%,40%} ·
  // {square,hex,50%,75%} · {circle,hex,20%,400%} · then solid mint / solid choc bg.
  //
  // Coverage = 1/(1+spacing)², so SPACING carries magnitude: `t` (0 small … 1
  // large value) sweeps spacing exponentially 15%→400% (constant ratio = even,
  // big contrast jumps) so a key's marks pack CLOSE for small values and spread
  // FAR APART for large ones — the pattern shows scale as well as identity. `i`
  // (identity index) picks the shape/tile by parity.
  function markParams(t, i, opts) {
    const o = opts || {};
    const src = o.src == null ? 8 : o.src;            // source shape size (px)
    const spacing = 0.15 * Math.pow(4.0 / 0.15, t);   // 15% … 400% gap
    const scale = 0.50 - 0.30 * t;                    // 50% … 20% of source
    const square = i % 2 === 0;                       // shape by identity parity
    const markSize = src * scale;
    return { square, hex: !square, markSize, pitch: markSize * (1 + spacing) };
  }

  function markShape(square, cx, cy, m) {
    return square
      ? svgEl("rect", { x: cx - m / 2, y: cy - m / 2, width: m, height: m,
          rx: Math.min(m * 0.14, 1) })
      : svgEl("circle", { cx, cy, r: m / 2 });
  }

  // Density parameter for band i of n: opts.t (value magnitude, preferred) else
  // the band index. Returns null for the solid terminal band.
  function bandT(i, n, opts) {
    if (i >= n - 1 || n < 2) return null;             // solid band (largest / single)
    if (opts && opts.t != null) {
      if (opts.t === 1) return null;
      return opts.t;
    }
    const nTex = n - 1;
    return nTex > 1 ? i / (nTex - 1) : 0;
  }

  // texture(svg, i, n, ink, opts) → a tiled <pattern> fill url, for covering an
  // irregular shape (e.g. the stacked area). opts: { t, bg, src }. bg fills the
  // tile behind the marks (light marks on a dark block).
  function texture(svg, i, n, ink, opts) {
    const t = bandT(i, n, opts);
    if (t == null) return ink;                        // solid band
    const o = opts || {};
    const P = markParams(t, i, o);
    let defs = svg.querySelector("defs");
    if (!defs) { defs = svgEl("defs"); svg.insertBefore(defs, svg.firstChild); }
    // Ids must be unique document-wide (url(#id) resolves globally): a per-svg
    // serial keeps the cream area and the brown bar from colliding.
    if (svg.__txid == null) svg.__txid = ++textureSvgSeq;
    const id = "px-" + svg.__txid + "-" + i + "-" + n;
    if (!defs.querySelector("#" + id)) {
      const pitch = P.pitch, m = P.markSize;
      const rowH = P.hex ? pitch * 0.866 : pitch;     // hex: tighter, offset rows
      const tileH = P.hex ? rowH * 2 : rowH;
      const p = svgEl("pattern", { id, width: pitch, height: tileH,
        patternUnits: "userSpaceOnUse", fill: ink });
      if (o.bg) p.appendChild(svgEl("rect", { width: pitch, height: tileH, fill: o.bg }));
      p.appendChild(markShape(P.square, pitch / 2, rowH / 2, m));
      if (P.hex) {                                    // offset row (halves wrap across the tile)
        p.appendChild(markShape(P.square, 0, rowH * 1.5, m));
        p.appendChild(markShape(P.square, pitch, rowH * 1.5, m));
      }
      defs.appendChild(p);
    }
    return "url(#" + id + ")";
  }

  // drawMarks(svg, box, i, n, ink, opts) — the same ladder drawn as explicit WHOLE
  // marks inside a box: any mark that would cross an edge is skipped for rectangular
  // patterns, but hexagonal patterns are generated slightly larger and clipped
  // to ensure clean edges and full coverage.
  // Appends a non-interactive <g>; the caller draws the box fill/border.
  function drawMarks(svg, box, i, n, ink, opts) {
    const t = bandT(i, n, opts);
    if (t == null) return;                            // solid band: no marks
    const P = markParams(t, i, opts);
    let pitch = P.pitch, m = P.markSize;
    const fit = Math.min(box.w, box.h);
    if (pitch > fit && pitch > 0) { const k = fit / pitch; pitch *= k; m *= k; } // ≥1 fits
    const rowH = P.hex ? pitch * 0.866 : pitch;
    const rows = Math.max(1, Math.round(box.h / rowH));
    const cols = Math.max(1, Math.round(box.w / pitch));
    const ox = box.x + (box.w - cols * pitch) / 2;    // centre the grid → even margins
    const oy = box.y + (box.h - rows * rowH) / 2;

    let defs = svg.querySelector("defs");
    if (!defs) { defs = svgEl("defs"); svg.insertBefore(defs, svg.firstChild); }
    const clipId = "tx-clip-" + (++clipPathSeq);
    const cp = svgEl("clipPath", { id: clipId });
    cp.appendChild(svgEl("rect", { x: box.x, y: box.y, width: box.w, height: box.h, rx: 2 }));
    defs.appendChild(cp);

    const g = svgEl("g", { fill: ink, "pointer-events": "none", "clip-path": "url(#" + clipId + ")" });

    for (let r = -1; r <= rows; r++) {
      const cy = oy + r * rowH + rowH / 2;
      const xoff = (P.hex && (r % 2 !== 0)) ? pitch / 2 : 0;  // hexagonal: offset odd rows
      for (let c = -1; c <= cols; c++) {
        const cx = ox + c * pitch + pitch / 2 + xoff;
        const overlaps = cx + m / 2 >= box.x && cx - m / 2 <= box.x + box.w
                      && cy + m / 2 >= box.y && cy - m / 2 <= box.y + box.h;
        if (overlaps) g.appendChild(markShape(P.square, cx, cy, m));
      }
    }
    svg.appendChild(g);
  }

  // A standalone inline-SVG swatch of band i (for HTML table rows) — explicit
  // whole marks so the swatch edges are clean too. opts.t sets its density.
  function chip(i, n, ink, size, opts) {
    size = size || 16;
    const svg = svgEl("svg", { width: size, height: size, class: "sw-chip" });
    const isSolid = i >= n - 1 || n < 2 || (opts && opts.t === 1);
    if (isSolid) {
      svg.appendChild(svgEl("rect", { width: size, height: size, rx: 2, fill: ink }));
    } else {
      if (opts && opts.bg)
        svg.appendChild(svgEl("rect", { width: size, height: size, rx: 2, fill: opts.bg }));
      drawMarks(svg, { x: 0, y: 0, w: size, h: size }, i, n, ink, opts);
    }
    return svg.outerHTML;
  }

  // Rank each value 0..1 (smallest → largest) so callers can drive texture
  // density by magnitude: small values pack close, large values spread apart.
  function valueRanks(values) {
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    const rank = new Array(values.length);
    const denom = values.length > 1 ? values.length - 1 : 1;
    order.forEach((idx, r) => { rank[idx] = r / denom; });
    return rank;
  }

  // ── line chart over an x-series, Tufte range-frame ──
  // cfg: {
  //   host, H=230, padL=56, padR=92, padT=14, padB=26,
  //   xs:[t...],                          // x values (e.g. epoch ms), ascending
  //   series:[{ values:[v...], color }],  // one line each; values align to xs
  //   tokens:{ axis, hair, page },        // resolved colours
  //   fmtK:v=>str,                        // compact y/extreme labels
  //   xLabel:(t,first)=>str,              // axis tick text
  //   endLabel:(seriesIndex)=>str,        // text at each line's right end
  //   annotateExtremes:false,             // label single-series min & max points
  //   tip, tipHTML:(pointIndex)=>str      // optional hover tooltip
  // }
  function lineChart(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const xs = cfg.xs, series = cfg.series;
    const padL = cfg.padL == null ? 56 : cfg.padL;
    const padR = cfg.padR == null ? (series.length > 1 ? 110 : 92) : cfg.padR;
    const padT = cfg.padT == null ? 14 : cfg.padT;
    const padB = cfg.padB == null ? 26 : cfg.padB;
    const H = cfg.H == null ? 230 : cfg.H;
    const tk = cfg.tokens || {};
    const { svg, W } = frame(host, H);
    const t0 = xs[0], t1 = xs[xs.length - 1];
    const x = t => xs.length === 1 ? (padL + W - padR) / 2
      : padL + (t - t0) / ((t1 - t0) || 1) * (W - padL - padR);
    let vals = [];
    for (const s of series) vals = vals.concat(s.values);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
    const y = yScale(lo - pad, hi + pad, padT, H - padB);
    grid(svg, niceTicks(lo - pad, hi + pad, 4), y, padL, W - padR,
      { hair: tk.hair, label: cfg.fmtK });
    svg.appendChild(svgEl("line", { x1: x(t0), x2: x(t1), y1: H - padB, y2: H - padB,
      stroke: tk.axis, "stroke-width": 1 }));
    placedMonthTicks(t0, t1, x).forEach((t, i) => {
      const lb = svgEl("text", { x: x(t), y: H - 8, "text-anchor": i ? "middle" : "start" });
      lb.textContent = cfg.xLabel(t, i === 0);
      svg.appendChild(lb);
    });
    // stagger end-labels so they never collide
    const ends = series.map((s, i) => ({ i, ey: y(s.values[s.values.length - 1]) }))
      .sort((a, b) => a.ey - b.ey);
    for (let i = 1; i < ends.length; i++)
      if (ends[i].ey - ends[i - 1].ey < 15) ends[i].ey = ends[i - 1].ey + 15;
    series.forEach((s, si) => {
      const pts = xs.map((t, i) => [x(t), y(s.values[i])]);
      if (pts.length > 1) {
        const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
        svg.appendChild(svgEl("path", { d, fill: "none", stroke: s.color,
          "stroke-width": 1.75, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      }
      for (const p of pts) svg.appendChild(svgEl("circle", {
        cx: p[0], cy: p[1], r: pts.length > 1 ? 2 : 3.5,
        fill: s.color, stroke: tk.page, "stroke-width": 1.5 }));
      // Optional right-hand legend (skipped when cfg.endLabel is absent, e.g. a
      // single-series tile that names the line in its own heading).
      if (cfg.endLabel) {
        const e = ends.find(e => e.i === si);
        const lx = x(t1) + 8;
        svg.appendChild(svgEl("line", { x1: lx, x2: lx + 10, y1: e.ey, y2: e.ey,
          stroke: s.color, "stroke-width": 3 }));
        const lb = svgEl("text", { x: lx + 15, y: e.ey + 4, class: "dlabel" });
        lb.textContent = cfg.endLabel(si);
        svg.appendChild(lb);
      }
      if (cfg.annotateExtremes && series.length === 1 && xs.length > 2) {
        let mi = 0, ma = 0;
        s.values.forEach((v, i) => { if (v < s.values[mi]) mi = i; if (v > s.values[ma]) ma = i; });
        for (const [i, dy] of [[ma, -8], [mi, 16]]) {
          // Skip the endpoints — their value is already carried by the axis range
          // and the end of the line, and a label there collides with the y-axis.
          if (i === 0 || i === xs.length - 1) continue;
          const el = svgEl("text", { x: x(xs[i]), y: y(s.values[i]) + dy,
            "text-anchor": "middle", class: "dvalue" });
          el.textContent = cfg.fmtK(s.values[i]);
          svg.appendChild(el);
        }
      }
    });
    if (cfg.tip && cfg.tipHTML) {
      const hair = svgEl("line", { y1: padT, y2: H - padB, stroke: tk.axis,
        "stroke-width": 1, "stroke-dasharray": "2 3", visibility: "hidden" });
      svg.appendChild(hair);
      svg.addEventListener("pointermove", ev => {
        const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
        let bi = 0;
        for (let i = 1; i < xs.length; i++)
          if (Math.abs(x(xs[i]) - px) < Math.abs(x(xs[bi]) - px)) bi = i;
        hair.setAttribute("x1", x(xs[bi])); hair.setAttribute("x2", x(xs[bi]));
        hair.setAttribute("visibility", "visible");
        cfg.tip.show(host, x(xs[bi]) * (r.width / W), padT * (r.height / H), cfg.tipHTML(bi));
      });
      svg.addEventListener("pointerleave", () => {
        hair.setAttribute("visibility", "hidden"); cfg.tip.hide();
      });
    }
  }

  // ── stacked area over an x-series, texture-coded bands ──
  // cfg: {
  //   host, H=230, padL=56, padR=110, padT=14, padB=26,
  //   xs:[t...],
  //   bands:[{ values:[v...], ti, label }], // ti = texture index; stacked in order
  //   n,                                    // texture band count
  //   ink, bg,                              // mark colour; chocolate fill behind marks
  //   tokens:{surface,axis,hair},
  //   fmtK:v=>str, xLabel:(t,first)=>str,
  //   tip, tipHTML:(pointIndex)=>str
  // }
  function stackedArea(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const xs = cfg.xs, bands = cfg.bands, n = cfg.n, ink = cfg.ink, tk = cfg.tokens || {};
    const padL = cfg.padL == null ? (cfg.noAxis ? 0 : 56) : cfg.padL;
    const padR = cfg.padR == null ? 110 : cfg.padR;
    const padT = cfg.padT == null ? 14 : cfg.padT;
    const padB = cfg.padB == null ? (cfg.noAxis ? 10 : 26) : cfg.padB;
    const H = cfg.H == null ? 230 : cfg.H;
    const { svg, W } = frame(host, H);
    const single = xs.length === 1;
    const t0 = xs[0], t1 = xs[xs.length - 1];
    const x = t => single ? (padL + W - padR) / 2
      : padL + (t - t0) / ((t1 - t0) || 1) * (W - padL - padR);
    const totals = xs.map((_, i) => bands.reduce((a, b) => a + (b.values[i] || 0), 0));
    const hi = Math.max(...totals) * 1.08 || 1;
    const y = yScale(0, hi, padT, H - padB);

    if (!cfg.noBg) {
      svg.appendChild(svgEl("rect", { x: padL, y: padT, width: Math.max(W - padL - padR, 0),
        height: H - padB - padT, fill: tk.surface, rx: 4 }));
    }
    if (!cfg.noAxis) {
      grid(svg, niceTicks(0, hi, 4), y, padL, W - padR, { hair: tk.hair, label: cfg.fmtK });
    }

    const lower = xs.map(() => 0);
    // Density by VALUE (each band's latest total): small bands pack close, large
    // ones spread far apart, so the texture portrays magnitude as well as identity.
    const last = xs.length - 1;
    const rankT = valueRanks(bands.map(b => b.values[last] || 0));
    bands.forEach((b, bi) => {
      const fill = texture(svg, b.ti, n, ink, { t: b.t != null ? b.t : rankT[bi], bg: cfg.bg });
      const upper = xs.map((_, i) => lower[i] + (b.values[i] || 0));
      if (single) {
        const bw = 42, cx = x(t0);
        svg.appendChild(svgEl("rect", { x: cx - bw / 2, y: y(upper[0]), width: bw,
          height: Math.max(y(lower[0]) - y(upper[0]), 0), fill }));
      } else {
        const top = xs.map((t, i) => x(t).toFixed(1) + " " + y(upper[i]).toFixed(1));
        const bot = xs.map((t, i) => x(t).toFixed(1) + " " + y(lower[i]).toFixed(1)).reverse();
        svg.appendChild(svgEl("path", { d: "M" + top.join(" L") + " L" + bot.join(" L") + " Z", fill }));
      }
      for (let i = 0; i < xs.length; i++) lower[i] = upper[i];
    });

    if (!single && !cfg.noAxis) {
      svg.appendChild(svgEl("line", { x1: x(t0), x2: x(t1), y1: H - padB, y2: H - padB,
        stroke: tk.axis, "stroke-width": 1 }));
      placedMonthTicks(t0, t1, x).forEach((t, i) => {
        const lb = svgEl("text", { x: x(t), y: H - 8, "text-anchor": i ? "middle" : "start" });
        lb.textContent = cfg.xLabel(t, i === 0);
        svg.appendChild(lb);
      });
    }

    // Direct labels at the right edge, anchored to the mid-height of each slice
    let acc = 0;
    const lastTotal = totals[last] || 1;
    const labels = bands.map(b => {
      const v = b.values[last] || 0, mid = acc + v / 2; acc += v;
      const ey = y(mid);
      return { b, v, ey, oy: ey };
    }).sort((a, c) => a.ey - c.ey);

    // Enforce uniform minimum spacing between label callouts (26px step)
    const minStep = 26;
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].ey - labels[i - 1].ey < minStep) {
        labels[i].ey = labels[i - 1].ey + minStep;
      }
    }

    // Keep labels within chart vertical bounds
    const maxY = H - padB - 6;
    if (labels.length && labels[labels.length - 1].ey > maxY) {
      const overflow = labels[labels.length - 1].ey - maxY;
      for (let i = 0; i < labels.length; i++) {
        labels[i].ey -= overflow;
      }
    }
    const minY = padT + 10;
    if (labels.length && labels[0].ey < minY) {
      const underflow = minY - labels[0].ey;
      for (let i = 0; i < labels.length; i++) {
        labels[i].ey += underflow;
      }
    }

    // Connector & legend line parameters (consistent with segmentedBar connectors: open circle + hairline)
    const connLen = cfg.connectors && !single ? (cfg.connLen == null ? 48 : cfg.connLen) : 0;
    const lx = (single ? x(t0) + 24 : x(t1) + connLen) + 8;
    const strokeCol = cfg.connColor || tk.hair || tk.border || tk.axis || "currentColor";

    for (const L of labels) {
      if (connLen) {
        const dotCx = x(t1) + 6;
        svg.appendChild(svgEl("circle", { cx: dotCx, cy: L.oy, r: 2,
          fill: "none", stroke: strokeCol, "stroke-width": 1 }));
        const cx1 = dotCx + 3, cx2 = lx - 6;
        if (Math.abs(L.oy - L.ey) < 0.5) {
          // Label sits level with its band — a straight hairline.
          svg.appendChild(svgEl("line", { x1: cx1, x2: cx2, y1: L.oy, y2: L.ey,
            stroke: strokeCol, "stroke-width": 1 }));
        } else {
          // Label nudged off its band to avoid overlap: elbow with square turns
          // (horizontal → vertical riser → horizontal) rather than a diagonal.
          const xm = (cx1 + cx2) / 2;
          svg.appendChild(svgEl("polyline", {
            points: cx1 + "," + L.oy + " " + xm + "," + L.oy + " " + xm + "," + L.ey + " " + cx2 + "," + L.ey,
            fill: "none", stroke: strokeCol, "stroke-width": 1, "stroke-linejoin": "miter" }));
        }
      }
      const lb = svgEl("text", { x: lx, y: L.ey + 4, class: "dlabel", fill: ink || "currentColor" });
      const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());
      const capName = titleCase(L.b.label);
      const pct = Math.round(L.v / lastTotal * 100);
      const valStr = cfg.fmtNZD ? cfg.fmtNZD(L.v) : ("$" + Math.round(L.v).toLocaleString("en-NZ"));
      lb.textContent = capName + " " + pct + "% \u00b7 " + valStr;
      svg.appendChild(lb);
    }
    if (cfg.tip && cfg.tipHTML && !single) {
      const hair = svgEl("line", { y1: padT, y2: H - padB, stroke: tk.axis,
        "stroke-width": 1, "stroke-dasharray": "2 3", visibility: "hidden" });
      svg.appendChild(hair);
      svg.addEventListener("pointermove", ev => {
        const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
        let bi = 0;
        for (let i = 1; i < xs.length; i++)
          if (Math.abs(x(xs[i]) - px) < Math.abs(x(xs[bi]) - px)) bi = i;
        hair.setAttribute("x1", x(xs[bi])); hair.setAttribute("x2", x(xs[bi]));
        hair.setAttribute("visibility", "visible");
        cfg.tip.show(host, x(xs[bi]) * (r.width / W), padT * (r.height / H), cfg.tipHTML(bi));
      });
      svg.addEventListener("pointerleave", () => {
        hair.setAttribute("visibility", "hidden"); cfg.tip.hide();
      });
    }
  }

  // ── vertical columns on a shared baseline, diverging +/- ──
  // cfg: {
  //   host, H=160, padL=56, padR=12, padT=14, padB=26,
  //   bars:[{ value, label, faint }],  // one column each, in order
  //   posColor, negColor, ink,         // resolved colours (ink = baseline + labels)
  //   tokens:{ border },
  //   target,                          // optional dashed reference line value
  //   targetLabel:str,                 // label for the target line
  //   zeroLabel:"$0",
  //   tip, tipHTML:(barIndex)=>str
  // }
  function columnChart(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const bars = cfg.bars, ink = cfg.ink, tk = cfg.tokens || {};
    const padL = cfg.padL == null ? 56 : cfg.padL;
    const padR = cfg.padR == null ? 12 : cfg.padR;
    const padT = cfg.padT == null ? 14 : cfg.padT;
    const padB = cfg.padB == null ? 26 : cfg.padB;
    const H = cfg.H == null ? 160 : cfg.H;
    const target = cfg.target || 0;
    const { svg, W } = frame(host, H);
    const lo = Math.min(0, ...bars.map(b => b.value)) * 1.12;
    const hi = (Math.max(target, ...bars.map(b => b.value), 0) * 1.12) || 1;
    const y = yScale(lo, hi, padT, H - padB);
    const yLabel = (v, txt) => {
      const lb = svgEl("text", { x: padL - 8, y: y(v) + 4, "text-anchor": "end" });
      lb.textContent = txt;
      svg.appendChild(lb);
    };
    if (target > 0) {
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y(target), y2: y(target),
        stroke: tk.border, "stroke-width": 1, "stroke-dasharray": "2 4" }));
      yLabel(target, cfg.targetLabel);
    }
    const slot = (W - padL - padR) / bars.length;
    const bw = Math.max(Math.min(slot - 3, 28), 3);
    bars.forEach((b, i) => {
      const cx = padL + slot * i + slot / 2;
      const rect = svgEl("rect", {
        x: cx - bw / 2, y: b.value >= 0 ? y(b.value) : y(0),
        width: bw, height: Math.abs(y(b.value) - y(0)) || 1, rx: 2,
        fill: b.value >= 0 ? ink : cfg.negColor, opacity: b.faint ? 0.4 : 1 });
      svg.appendChild(rect);
      const lb = svgEl("text", { x: cx, y: H - 8, "text-anchor": "middle" });
      lb.textContent = b.label;
      svg.appendChild(lb);
      if (cfg.tip && cfg.tipHTML) {
        rect.addEventListener("pointermove", () => {
          const r = svg.getBoundingClientRect();
          cfg.tip.show(host, cx * (r.width / W), y(Math.max(b.value, 0)) * (r.height / H), cfg.tipHTML(i));
        });
        rect.addEventListener("pointerleave", cfg.tip.hide);
      }
    });
    svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y(0), y2: y(0),
      stroke: ink, "stroke-width": 1 }));
    yLabel(0, cfg.zeroLabel || "$0");
  }

  // ── area + line combo: textured "invested" area under a value/return line ──
  // The area is how much you'd put in at each point; the line is what it's worth,
  // so the gap between them reads as the return. Same silhouette language as the
  // stacked-area asset mix. cfg: {
  //   host, H=230, padL=56, padR=20, padT=14, padB=26,
  //   xs:[t...], bars:[v...], line:[v...],
  //   ti,                         // texture-band index for the bars
  //   ink, tokens:{axis,hair,page},
  //   fmtK:v=>str, xLabel:(t,first)=>str,
  //   tip, tipHTML:(i)=>str
  // }
  function barLineChart(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const xs = cfg.xs, bars = cfg.bars || [], line = cfg.line || [], tk = cfg.tokens || {};
    const ink = cfg.ink;
    const padL = cfg.padL == null ? 56 : cfg.padL;
    const padR = cfg.padR == null ? 20 : cfg.padR;
    const padT = cfg.padT == null ? 14 : cfg.padT;
    const padB = cfg.padB == null ? 26 : cfg.padB;
    const H = cfg.H == null ? 230 : cfg.H;
    const { svg, W } = frame(host, H);
    const t0 = xs[0], t1 = xs[xs.length - 1];
    const x = t => xs.length === 1 ? (padL + W - padR) / 2
      : padL + (t - t0) / ((t1 - t0) || 1) * (W - padL - padR);
    // stacks[x] = [{value, i, t}] textured segments (per fund). When present, the
    // bars are per-fund stacks and need a 0 baseline so segments sum correctly.
    // Otherwise a single invested bar, with the axis zoomed to the data so the
    // small gap to the value line (the return) stays legible.
    const stacks = Array.isArray(cfg.stacks) ? cfg.stacks : null;
    const barTotals = stacks
      ? stacks.map(segs => segs.reduce((a, s) => a + (s.value > 0 ? s.value : 0), 0))
      : bars;
    const all = barTotals.concat(line).filter(v => v != null);
    const dataLo = stacks ? 0 : Math.min(...all);
    const dataHi = Math.max(...all);
    const pad = (dataHi - dataLo) * 0.12 || Math.abs(dataHi) * 0.05 || 1;
    const yLo = stacks ? 0 : dataLo - pad;
    const yHi = dataHi + pad;
    const y = yScale(yLo, yHi, padT, H - padB);
    grid(svg, niceTicks(yLo, yHi, 4), y, padL, W - padR, { hair: tk.hair, label: cfg.fmtK });
    svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB,
      stroke: tk.axis, "stroke-width": 1 }));
    placedMonthTicks(t0, t1, x).forEach((t, i) => {
      const lb = svgEl("text", { x: x(t), y: H - 8, "text-anchor": i ? "middle" : "start" });
      lb.textContent = cfg.xLabel(t, i === 0);
      svg.appendChild(lb);
    });
    // Invested area: stacked per-fund textured bands (the same silhouette as the
    // asset-mix stacked area), or a single textured band.
    const n = cfg.n || 6;
    const areaPath = (upper, lower) => {
      const top = xs.map((t, i) => x(t).toFixed(1) + " " + y(upper[i]).toFixed(1));
      const bot = xs.map((t, i) => x(t).toFixed(1) + " " + y(lower[i]).toFixed(1)).reverse();
      return "M" + top.join(" L") + " L" + bot.join(" L") + " Z";
    };
    if (stacks) {
      // Reshape the per-snapshot segment lists into per-fund bands so each fund is
      // one continuous area across the series (segments share a fund index; the
      // untraced shortfall is a single faint band stacked on top).
      const order = [];
      const seen = new Set();
      stacks.forEach(segs => segs.forEach(s => {
        const key = s.faint ? "faint" : s.i;
        if (!seen.has(key)) { seen.add(key); order.push({ key, i: s.i || 0, t: s.t, faint: !!s.faint }); }
      }));
      const lower = xs.map(() => 0);
      order.forEach(band => {
        const upper = xs.map((_, xi) => {
          const seg = stacks[xi].find(s => (s.faint ? "faint" : s.i) === band.key);
          return lower[xi] + (seg && seg.value > 0 ? seg.value : 0);
        });
        if (band.faint) { // funds with no trade history — a plain, muted band
          svg.appendChild(svgEl("path", { d: areaPath(upper, lower), fill: ink, opacity: 0.12 }));
        } else {
          const fill = texture(svg, band.i, n, ink, { t: band.t, bg: cfg.bg });
          svg.appendChild(svgEl("path", { d: areaPath(upper, lower), fill }));
        }
        for (let xi = 0; xi < xs.length; xi++) lower[xi] = upper[xi];
      });
    } else {
      // Single aggregate invested area.
      const upper = xs.map((_, xi) => (bars[xi] > 0 ? bars[xi] : 0));
      const fill = texture(svg, cfg.ti || 0, n, ink, { bg: cfg.bg });
      svg.appendChild(svgEl("path", { d: areaPath(upper, xs.map(() => 0)), fill }));
    }
    // Value/return line.
    const pts = xs.map((t, i) => [x(t), y(line[i])]);
    if (pts.length > 1) {
      const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
      svg.appendChild(svgEl("path", { d, fill: "none", stroke: ink, "stroke-width": 1.75,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    // A single end marker rather than a dot at every point — the line reads clean
    // over the textured area instead of stippled.
    const end = pts[pts.length - 1];
    if (end) svg.appendChild(svgEl("circle", { cx: end[0], cy: end[1],
      r: 3.5, fill: ink, stroke: tk.page, "stroke-width": 1.5 }));
    if (cfg.tip && cfg.tipHTML) {
      const hair = svgEl("line", { y1: padT, y2: H - padB, stroke: tk.axis,
        "stroke-width": 1, "stroke-dasharray": "2 3", visibility: "hidden" });
      svg.appendChild(hair);
      svg.addEventListener("pointermove", ev => {
        const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
        let bi = 0;
        for (let i = 1; i < xs.length; i++)
          if (Math.abs(x(xs[i]) - px) < Math.abs(x(xs[bi]) - px)) bi = i;
        hair.setAttribute("x1", x(xs[bi])); hair.setAttribute("x2", x(xs[bi]));
        hair.setAttribute("visibility", "visible");
        cfg.tip.show(host, x(xs[bi]) * (r.width / W), padT * (r.height / H), cfg.tipHTML(bi));
      });
      svg.addEventListener("pointerleave", () => { hair.setAttribute("visibility", "hidden"); cfg.tip.hide(); });
    }
  }

  // ── dot plot: one row per item on a shared ordinal axis ──
  // cfg: {
  //   host, rowH=22, padT=8, axisPad=30, axisFrac=0.40, rightPad=88,
  //   rows:[{ pos, value, label, valueLabel, tipHTML }], // pos = 0..(levels-1)
  //   levels:[str...],          // axis tick labels, left->right
  //   avgPos,                   // optional reference line position (fractional)
  //   dotColor, tokens:{ hair, fg },
  //   tip
  // }
  function dotPlot(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const rows = cfg.rows, levels = cfg.levels, tk = cfg.tokens || {};
    const padT = cfg.padT == null ? 12 : cfg.padT;
    const axisPad = cfg.axisPad == null ? 36 : cfg.axisPad;

    const { svg, W } = frame(host, 200);

    const fontCharW = 6.6;
    // Left gutter fits the longest row label rather than a fixed fraction of the
    // card, so short fund names don't leave a wide gap before the dots — the
    // reclaimed width goes to the level axis (below), which then rarely needs to
    // stagger. Capped so a very long name still truncates instead of eating the plot.
    const gutterCap = Math.min(W * 0.36, 170);
    const longestLabel = rows.reduce((m, r) => Math.max(m, (r.label || "").length), 0);
    // Fragment Mono advances ~7.2px per glyph at 12px, so size the gutter to the
    // real name width plus a clear gap — the tighter fontCharW undershot and let
    // long names touch the dots. maxChars below still uses fontCharW, so a name
    // only truncates once it hits the cap, not before.
    const ax0 = Math.round(Math.max(64, Math.min(longestLabel * 7.2 + 16, gutterCap)));
    const rightPad = Math.round(Math.max(55, Math.min(W * 0.20, 80)));
    const ax1 = Math.max(ax0 + 50, W - rightPad);

    const maxLabelW = ax0 - 8;
    const maxChars = Math.max(8, Math.floor(maxLabelW / fontCharW));
    const needsWrap = rows.some(r => r.label && r.label.length > maxChars);
    const rowH = cfg.rowH == null ? (needsWrap ? 30 : 24) : cfg.rowH;

    const maxV = Math.max(...rows.map(r => r.value), 1);
    const H = padT + rows.length * rowH + axisPad;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", H);

    const span = Math.max(levels.length - 1, 1);
    const x = p => ax0 + (p / span) * (ax1 - ax0);
    const axisY = padT + rows.length * rowH + 4;

    // Average marker: a solid, prominent vertical line — the anchor showing where
    // the portfolio sits on the scale, standing clear of the dashed row grid below.
    if (cfg.avgPos != null)
      svg.appendChild(svgEl("line", { x1: x(cfg.avgPos), x2: x(cfg.avgPos), y1: padT - 4, y2: axisY,
        stroke: tk.fg || "var(--ink)", "stroke-width": 1.5, "stroke-opacity": 0.6 }));

    rows.forEach((it, i) => {
      const cy = padT + i * rowH + rowH / 2;
      svg.appendChild(svgEl("line", { x1: ax0, x2: ax1, y1: cy, y2: cy, stroke: tk.hair || "var(--hair)", "stroke-dasharray": "1 4", "stroke-opacity": 0.5 }));

      const nm = svgEl("text", { x: 0, class: "dlabel" });
      const str = it.label || "";
      if (str.length > maxChars && needsWrap) {
        const words = str.split(" ");
        let line1 = "", line2 = "";
        words.forEach(w => {
          if ((line1 + " " + w).trim().length <= maxChars) {
            line1 = (line1 + " " + w).trim();
          } else {
            line2 = (line2 + " " + w).trim();
          }
        });
        if (!line2) {
          line1 = str.substring(0, maxChars - 1) + "…";
        } else if (line2.length > maxChars) {
          line2 = line2.substring(0, maxChars - 1) + "…";
        }
        nm.setAttribute("y", cy - 4);
        const t1 = svgEl("tspan", { x: 0, dy: "0" });
        t1.textContent = line1;
        const t2 = svgEl("tspan", { x: 0, dy: "1.1em" });
        t2.textContent = line2;
        nm.appendChild(t1);
        nm.appendChild(t2);
      } else {
        nm.setAttribute("y", cy + 4);
        nm.textContent = str.length > maxChars ? str.substring(0, maxChars - 1) + "…" : str;
      }
      svg.appendChild(nm);

      const vl = svgEl("text", { x: W, y: cy + 4, "text-anchor": "end", class: "dvalue" });
      vl.textContent = it.valueLabel;
      svg.appendChild(vl);

      const r = Math.max(3, Math.min(9, Math.sqrt(it.value / maxV) * 9));
      const c = svgEl("circle", { cx: x(it.pos), cy, r, fill: cfg.dotColor, "fill-opacity": 0.85 });
      svg.appendChild(c);

      if (cfg.tip && it.tipHTML) {
        const cx = x(it.pos);
        c.addEventListener("pointermove", () => {
          const rr = svg.getBoundingClientRect();
          cfg.tip.show(host, cx * (rr.width / W), cy * (rr.height / H), it.tipHTML);
        });
        c.addEventListener("pointerleave", cfg.tip.hide);
      }
    });

    svg.appendChild(svgEl("line", { x1: ax0, x2: ax1, y1: axisY, y2: axisY, stroke: tk.hair || "var(--hair)" }));
    // Stagger the level labels only when they'd actually collide at this width:
    // two adjacent labels overlap once the widest exceeds the centre-to-centre gap.
    const levelGap = (ax1 - ax0) / span;
    const maxLevelW = levels.reduce((m, l) => Math.max(m, String(l).length), 0) * fontCharW;
    const stagger = cfg.staggerLabels && maxLevelW > levelGap;
    levels.forEach((l, i) => {
      svg.appendChild(svgEl("line", { x1: x(i), x2: x(i), y1: axisY, y2: axisY + 3, stroke: tk.hair || "var(--hair)" }));
      const yOff = stagger && i % 2 ? 26 : 14;
      const t = svgEl("text", { x: x(i), y: axisY + yOff, "text-anchor": "middle" });
      t.textContent = l;
      svg.appendChild(t);
    });
  }

  // ── segmented bar: texture-coded proportional segments, optional stepped
  //    connector labels above (the Figma "Vertical Connector" annotation) ──
  //
  // The connector fix: each label column is ANCHORED TO ITS OWN SEGMENT — the
  // connector drops straight from the label down to a small open dot sitting over
  // that segment, and the label text is free to overflow the segment's width
  // (labels are not re-flowed to avoid collisions). Connector lengths step down
  // as the index rises (first label highest above the bar, last label closest),
  // matching the design's 96/64/32/8 ladder. A right-most label whose text would
  // run off the frame is right-anchored to its segment instead, so it stays on
  // the card while still belonging to its segment.
  //
  // cfg: {
  //   host, barH=24, gap=4, minSeg=24,
  //   segments:[{ label, value, ti, tipHTML }], // ti = texture index
  //   n, total,                                 // texture band count; sum of values
  //   ink, tokens:{ border, hair },
  //   connectors:false,                         // draw the stepped connector labels
  //   step=30, topPad=14, labelGap=8,           // connector geometry
  //   tip
  // }
  function segmentedBar(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const segs = cfg.segments, n = cfg.n, ink = cfg.ink, tk = cfg.tokens || {};
    const barH = cfg.barH == null ? 24 : cfg.barH;
    const gap = cfg.gap == null ? 4 : cfg.gap;
    const minSeg = cfg.minSeg == null ? 24 : cfg.minSeg;
    const connectors = !!cfg.connectors;
    const step = cfg.step == null ? 30 : cfg.step;
    const topPad = cfg.topPad == null ? 14 : cfg.topPad;
    const labelGap = cfg.labelGap == null ? 8 : cfg.labelGap;
    const count = segs.length;
    // Measure once so W is known before we size widths.
    const barY = connectors ? topPad + step * (count - 1) + 22 : 0;
    const { svg, W } = frame(host, barY + barH);
    const total = cfg.total != null ? cfg.total : segs.reduce((a, s) => a + s.value, 0);
    // Proportional widths with a min-width clamp; the excess comes off the widest
    // segment so a sliver of texture never reads as noise.
    const avail = W - gap * (count - 1);
    const ws = segs.map(s => s.value / (total || 1) * avail);
    const MINW = Math.min(minSeg, avail / count);
    let debt = 0;
    ws.forEach((w, i) => { if (w < MINW) { debt += MINW - w; ws[i] = MINW; } });
    if (debt > 0) ws[ws.indexOf(Math.max(...ws))] -= debt;
    // Rough monospace advance for overflow detection (px per char at 12px).
    const advance = 7.4;
    // Density by VALUE: small segments pack close, large ones spread far apart.
    const rankT = valueRanks(segs.map(s => s.value));
    let x = 0;
    segs.forEach((s, i) => {
      const sx = x, w = ws[i];
      const ti = s.ti != null ? s.ti : i;
      const solid = ti >= n - 1;
      // Solid terminal band = filled ink; textured bands = a block (cfg.bg dark, or
      // transparent so a dark card shows through) with an explicit whole-mark grid
      // drawn inside, so the pattern has clean edges rather than clipped tiles.
      const rect = svgEl("rect", { x: sx, y: barY, width: w, height: barH,
        rx: 2, fill: solid ? ink : (cfg.bg || "transparent"), "pointer-events": "all" });
      if (tk.border) { rect.setAttribute("stroke", tk.border); rect.setAttribute("stroke-width", 1); }
      svg.appendChild(rect);
      if (!solid) drawMarks(svg, { x: sx, y: barY, w, h: barH }, ti, n, ink, { t: s.t != null ? s.t : rankT[i] });
      if (cfg.tip && s.tipHTML) {
        rect.addEventListener("pointermove", () => {
          const r = svg.getBoundingClientRect();
          cfg.tip.show(host, (sx + w / 2) * (r.width / W), barY, s.tipHTML);
        });
        rect.addEventListener("pointerleave", cfg.tip.hide);
      }
      if (connectors) {
        const txt = s.label;
        const ly = topPad + step * i;                 // this label's baseline
        const textW = txt.length * advance;
        // Anchor the label (and its connector) to the segment. If the text would
        // overflow the right frame edge, right-anchor it to the segment instead.
        let anchor = "start", lx = sx, cx = sx + Math.min(6, w / 2);
        if (sx + textW > W) {
          anchor = "end";
          lx = Math.min(sx + w, W);
          cx = Math.max(sx + w - 6, sx + w / 2);
        }
        const strokeCol = cfg.connColor || tk.hair || tk.border || "currentColor";
        svg.appendChild(svgEl("line", { x1: cx, x2: cx, y1: ly + labelGap, y2: barY - 9,
          stroke: strokeCol, "stroke-width": 1 }));
        svg.appendChild(svgEl("circle", { cx, cy: barY - 6, r: 2,
          fill: "none", stroke: strokeCol, "stroke-width": 1 }));
        const lb = svgEl("text", { x: lx, y: ly, "text-anchor": anchor });
        lb.textContent = txt;
        svg.appendChild(lb);
      }
      x += w + gap;
    });
  }

  global.Sediment = {
    svgEl, frame, yScale, niceTicks, grid, monthTicks, placedMonthTicks,
    tip, texture, chip, valueRanks, lineChart, barLineChart, stackedArea, columnChart, dotPlot, segmentedBar,
  };
})(typeof window !== "undefined" ? window : this);
