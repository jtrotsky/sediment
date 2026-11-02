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
// tip() expects the `.sediment-tip` rules); load it alongside this file. See
// README.md for the per-builder cfg contracts and demo.html for a runnable example.
//
// The house style is Tufte-ish: range-frame axes and no grid, lines named at
// their right end with their latest value, comparisons and events drawn on the
// chart, and identity that never rests on colour alone — lines differ by dash
// pattern, bands by a solid tint whose depth follows the band's size.
//
// Public API (all under window.Sediment):
//   svgEl(tag, attrs)                     low-level SVG element
//   frame(host, H)                        -> {svg, W, H}; appends a responsive svg
//   yScale(min,max,y0,y1) -> v=>y         linear scale
//   niceTicks(min,max,n) -> [t...]        rounded tick values
//   axisTicks(min,max) -> [t...]          three to five round tick values
//   rangeFrame(svg, ticks, yFn, x, opts)  y axis as long as the data, + labels
//   grid(svg, ticks, yFn, x0, x1, opts)   dotted gridlines + y labels (unused here)
//   monthTicks / placedMonthTicks         evenly-spaced, de-overlapped month ticks
//   tip(el) -> {show(host,x,y,html),hide} floating tooltip bound to an element
//   texture(svg, i, n, ink, opts)         tint fill for band i of n (last = solid)
//   chip(i, n, ink, size)                 inline-SVG swatch string of that tint
//   lineChart(cfg) / stackedArea(cfg) / columnChart(cfg) / dotPlot(cfg) /
//   segmentedBar(cfg) / barLineChart(cfg) / smallMultiples(cfg)
//                                         chart builders (see each for cfg shape)

(function (global) {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  let textureSvgSeq = 0;   // per-svg serial so tint pattern ids stay unique

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

  // A value is drawable when it is a number. null, undefined and NaN are gaps:
  // missing data is left blank, never drawn as zero.
  const has = v => v != null && !Number.isNaN(v);

  // Three to five round ticks. Two read as a broken scale (just the ends), and
  // more than five is a grid by another name.
  function axisTicks(min, max) {
    let t = niceTicks(min, max, 4);
    if (t.length < 3) t = niceTicks(min, max, 6);
    while (t.length > 5) t = t.filter((_, i) => i % 2 === 0);
    return t;
  }

  // Range-frame y axis: a hairline at x only as long as the data runs (lo..hi),
  // with right-aligned tick labels and no gridlines. label(t, top) is told which
  // tick is the top one, so a caller can print the unit there once.
  // opts: { axis, label(t, top)->string, lo, hi, pad=6 }.
  function rangeFrame(svg, ticks, yFn, x, opts) {
    const o = opts || {};
    const axis = o.axis || "currentColor", pad = o.pad == null ? 6 : o.pad;
    if (o.lo != null && o.hi != null)
      svg.appendChild(svgEl("line", { x1: x, x2: x, y1: yFn(o.lo), y2: yFn(o.hi),
        stroke: axis, "stroke-width": 1 }));
    ticks.forEach((t, i) => {
      if (!o.label) return;
      const lb = svgEl("text", { x: x - pad, y: yFn(t) + 4, "text-anchor": "end" });
      lb.textContent = o.label(t, i === ticks.length - 1);
      svg.appendChild(lb);
    });
  }

  // A line's path through its points, lifting the pen over gaps.
  function gapPath(pts) {
    let d = "", pen = false;
    for (const p of pts) {
      if (!p) { pen = false; continue; }
      d += (d ? " " : "") + (pen ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1);
      pen = true;
    }
    return d;
  }

  // Dash pattern per series, so lines differ by more than colour. The first
  // series is solid; an explicit s.dash (including "" for solid) wins.
  const DASHES = ["", "6 4", "1.5 3", "8 3 1.5 3"];
  const dashFor = (s, si, count) =>
    s.dash != null ? s.dash : count > 1 ? DASHES[si % DASHES.length] : "";

  // Reference lines: what the data is compared to (a target, a limit, a goal).
  // Dashed, thin, lighter than the data, from x0 to x1. Returns their label
  // slots for the caller's right-margin de-collision.
  // refs: [{ value, label }]
  function drawRefs(svg, refs, y, x0, x1, stroke) {
    return (refs || []).filter(r => has(r.value)).map(r => {
      svg.appendChild(svgEl("line", { x1: x0, x2: x1, y1: y(r.value), y2: y(r.value),
        stroke, "stroke-width": 1, "stroke-dasharray": "4 4", class: "sref" }));
      return { ref: r, ey: y(r.value) };
    });
  }

  // Events: a dotted hairline at each x, with its word above the plot so it
  // never sits on the data. events: [{ t, label }]
  function drawEvents(svg, events, x, padT, yBottom, W, stroke) {
    for (const ev of events || []) {
      const ex = x(ev.t);
      svg.appendChild(svgEl("line", { x1: ex, x2: ex, y1: padT, y2: yBottom,
        stroke, "stroke-width": 1, "stroke-dasharray": "1 3", class: "sevent" }));
      if (!ev.label) continue;
      const w = String(ev.label).length * 7;
      const anchor = ex - w / 2 < 0 ? "start" : ex + w / 2 > W ? "end" : "middle";
      const lb = svgEl("text", { x: ex, y: padT - 5, "text-anchor": anchor, class: "devent" });
      lb.textContent = ev.label;
      svg.appendChild(lb);
    }
  }

  // Push right-margin labels apart so none overlap, keeping their order.
  function spread(items, step) {
    items.sort((a, b) => a.ey - b.ey);
    for (let i = 1; i < items.length; i++)
      if (items[i].ey - items[i - 1].ey < step) items[i].ey = items[i - 1].ey + step;
    return items;
  }

  // A label at the right margin: name, then its value in the value style.
  function endText(lx, ey, name, value) {
    const lb = svgEl("text", { x: lx, y: ey + 4, class: "dlabel" });
    lb.textContent = name || "";
    if (value) {
      const v = svgEl("tspan", { class: "dvalue" });
      v.textContent = (name ? " " : "") + value;
      lb.appendChild(v);
    }
    return lb;
  }

  // Dotted hairline grid with right-aligned y labels. Kept for callers that
  // want it; the builders here draw rangeFrame instead (no gridlines).
  // opts: { hair, label(t)->string, pad=8 }.
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

  // ── tints ──────────────────────────────────────────────────────────────────
  // A band is a solid tint of the ink: no hatching, no texture, no moiré. The
  // tint's depth carries the band's size — `t` (0 small … 1 large, from
  // valueRanks) sweeps the ink's opacity from light to heavy — and the terminal
  // band is solid ink. Neighbouring bands are told apart by a hairline seam in
  // the background colour (stackedArea) or a gap (segmentedBar), and every band
  // is named on the chart, so identity never rests on the tint alone.

  // Depth parameter for band i of n: opts.t (value magnitude, preferred) else
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

  // Ink opacity for a band: 0.2 for the smallest, 0.8 short of solid.
  const tintAlpha = t => 0.2 + 0.6 * t;

  // texture(svg, i, n, ink, opts) → a fill for band i, for covering an irregular
  // shape (e.g. the stacked area). opts: { t, bg }. bg is the solid colour the
  // tint is laid over (light ink on a dark block); without it the tint is
  // translucent over whatever is behind. The name is kept for callers.
  function texture(svg, i, n, ink, opts) {
    const t = bandT(i, n, opts);
    if (t == null) return ink;                        // solid band
    const o = opts || {};
    let defs = svg.querySelector("defs");
    if (!defs) { defs = svgEl("defs"); svg.insertBefore(defs, svg.firstChild); }
    // Ids must be unique document-wide (url(#id) resolves globally): a per-svg
    // serial keeps two charts' tints from colliding.
    if (svg.__txid == null) svg.__txid = ++textureSvgSeq;
    const id = "px-" + svg.__txid + "-" + i + "-" + n + "-" + Math.round(t * 100);
    if (!defs.querySelector("#" + id)) {
      const p = svgEl("pattern", { id, width: 4, height: 4, patternUnits: "userSpaceOnUse" });
      if (o.bg) p.appendChild(svgEl("rect", { width: 4, height: 4, fill: o.bg }));
      p.appendChild(svgEl("rect", { width: 4, height: 4, fill: ink, "fill-opacity": tintAlpha(t) }));
      defs.appendChild(p);
    }
    return "url(#" + id + ")";
  }

  // drawMarks(svg, box, i, n, ink, opts) — the same tint laid over a box the
  // caller has already drawn (its bg fill and border). Appends a
  // non-interactive <g>, so the caller's own rects stay the svg's direct
  // children. The name is kept for callers.
  function drawMarks(svg, box, i, n, ink, opts) {
    const t = bandT(i, n, opts);
    if (t == null) return;                            // solid band: caller fills it
    const g = svgEl("g", { "pointer-events": "none" });
    g.appendChild(svgEl("rect", { x: box.x, y: box.y, width: box.w, height: box.h, rx: 2,
      fill: ink, "fill-opacity": tintAlpha(t) }));
    svg.appendChild(g);
  }

  // A standalone inline-SVG swatch of band i (for HTML table rows and tooltips).
  // opts.t sets its depth; opts.bg the colour under the tint.
  function chip(i, n, ink, size, opts) {
    size = size || 16;
    const svg = svgEl("svg", { width: size, height: size, class: "sw-chip" });
    const isSolid = i >= n - 1 || n < 2 || (opts && opts.t === 1);
    if (isSolid) {
      // Solid fills edge to edge, the same rule the bar segments follow
      // (including solidFill), so a holding's chip and its segment match.
      svg.appendChild(svgEl("rect", { width: size, height: size, rx: 2,
        fill: (opts && opts.solidFill) || ink }));
    } else {
      if (opts && opts.bg)
        svg.appendChild(svgEl("rect", { width: size, height: size, rx: 2, fill: opts.bg }));
      drawMarks(svg, { x: 0, y: 0, w: size, h: size }, i, n, ink, opts);
    }
    return svg.outerHTML;
  }

  // Rank each value 0..1 (smallest → largest) so callers can drive tint
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
  //   host, H=230, padL=56, padR=92, padT=14 (22 with events), padB=26,
  //   xs:[t...],                          // x values (e.g. epoch ms), ascending
  //   series:[{ values:[v...], color, dash }], // one line each; values align to xs;
  //                                       // null = no data (the line breaks);
  //                                       // dash defaults by index when >1 series
  //   tokens:{ axis, hair, page, ref },   // resolved colours (ref defaults to hair)
  //   fmtK:v=>str,                        // compact value labels
  //   fmtTick:(v,top)=>str,               // y tick labels (default fmtK); top = the
  //                                       // highest tick, where the unit goes once
  //   xLabel:(t,first)=>str,              // axis tick text
  //   endLabel:(seriesIndex)=>str,        // name at each line's right end
  //   endValue:(seriesIndex)=>str,        // its latest value, printed after the name
  //   refs:[{ value, label, showValue }], // comparison lines, named with their value
  //                                       // (showValue:false for a narrow gutter)
  //   events:[{ t, label }],              // dotted hairline + word above the plot
  //   annotateExtremes:false,             // label single-series min & max points
  //   extremeLabel:(v,t,kind)=>str,       // kind "max"|"min"; default "value · time"
  //   dotGap:14,                          // min px between point dots (0 = every point)
  //   tip, tipHTML:(pointIndex)=>str      // optional hover tooltip
  // }
  function lineChart(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const xs = cfg.xs, series = cfg.series, refs = cfg.refs || [], events = cfg.events || [];
    const padL = cfg.padL == null ? 56 : cfg.padL;
    const padR = cfg.padR == null ? (series.length > 1 ? 110 : 92) : cfg.padR;
    const padT = cfg.padT == null ? (events.length ? 22 : 14) : cfg.padT;
    const padB = cfg.padB == null ? 26 : cfg.padB;
    const H = cfg.H == null ? 230 : cfg.H;
    const tk = cfg.tokens || {};
    const { svg, W } = frame(host, H);
    const t0 = xs[0], t1 = xs[xs.length - 1];
    const x = t => xs.length === 1 ? (padL + W - padR) / 2
      : padL + (t - t0) / ((t1 - t0) || 1) * (W - padL - padR);
    let vals = [];
    for (const s of series) vals = vals.concat(s.values.filter(has));
    if (!vals.length) return;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    // Reference lines widen the domain so the comparison is always on the chart.
    const refVals = refs.map(r => r.value).filter(has);
    const dLo = Math.min(lo, ...refVals), dHi = Math.max(hi, ...refVals);
    const pad = (dHi - dLo) * 0.12 || Math.abs(dHi) * 0.05 || 1;
    const y = yScale(dLo - pad, dHi + pad, padT, H - padB);
    rangeFrame(svg, axisTicks(dLo - pad, dHi + pad), y, padL - 6,
      { axis: tk.axis, label: cfg.fmtTick || cfg.fmtK, lo, hi });
    svg.appendChild(svgEl("line", { x1: x(t0), x2: x(t1), y1: H - padB, y2: H - padB,
      stroke: tk.axis, "stroke-width": 1 }));
    placedMonthTicks(t0, t1, x).forEach((t, i) => {
      const lb = svgEl("text", { x: x(t), y: H - 8, "text-anchor": i ? "middle" : "start" });
      lb.textContent = cfg.xLabel(t, i === 0);
      svg.appendChild(lb);
    });
    drawEvents(svg, events, x, padT, H - padB, W, tk.hair || tk.axis);
    const refSlots = drawRefs(svg, refs, y, padL, x(t1), tk.ref || tk.hair || tk.axis);
    // The last drawable point of each series: where its line ends and its label sits.
    const lastIdx = s => { for (let i = s.values.length - 1; i >= 0; i--) if (has(s.values[i])) return i; return -1; };
    // stagger end-labels (and reference labels) so they never collide
    const ends = spread(series.map((s, i) => ({ i, li: lastIdx(s) }))
      .filter(e => e.li >= 0)
      .map(e => ({ i: e.i, ey: y(series[e.i].values[e.li]) }))
      .concat(refSlots), 15);
    series.forEach((s, si) => {
      const li = lastIdx(s);
      if (li < 0) return;
      const dash = dashFor(s, si, series.length);
      const pts = xs.map((t, i) => has(s.values[i]) ? [x(t), y(s.values[i])] : null);
      if (pts.filter(Boolean).length > 1) {
        const path = svgEl("path", { d: gapPath(pts), fill: "none", stroke: s.color,
          "stroke-width": 1.75, "stroke-linejoin": "round", "stroke-linecap": dash ? "butt" : "round" });
        if (dash) path.setAttribute("stroke-dasharray", dash);
        svg.appendChild(path);
      }
      // Dots mark the points; they do not carry the data — the LINE does, and
      // the hover hairline still finds every point whether or not it wears one.
      // So thin them to what the eye can resolve. A dot is 4px across inside a
      // 1.5px page-coloured ring, and when a series changes cadence — monthly
      // history, then daily once a cron starts writing — the dense end packs
      // them 2px apart. The rings then overdraw each other's fills and the last
      // month of an 11-month chart renders as a smear in the PAGE colour, which
      // reads as a rendering fault sitting exactly where the newest data is.
      //
      // Walking from the end backwards is what keeps the newest point drawn:
      // that dot is the one the end-label names, and thinning from the left
      // would drop it whenever the spacing fell out that way.
      // 14px is a shade over twice a dot's outer width, so they read as separate
      // marks rather than a bead chain. It is deliberately a PIXEL rule, not a
      // calendar one: it thins to roughly a dot a month on a multi-year chart
      // and a dot a week on a year, without either the chart or the caller
      // having to know what the x-axis measures.
      const gap = cfg.dotGap == null ? 14 : cfg.dotGap;
      const dots = [];
      for (let i = pts.length - 1; i >= 0; i--)
        if (pts[i] && (!dots.length || dots[dots.length - 1][0] - pts[i][0] >= gap)) dots.push(pts[i]);
      // data-si tags each dot with its series. Callers that post-process the
      // chart (trimming a line to half the timeline, dropping a reference
      // series' dots) can then select by series instead of counting elements:
      // the thinning above makes the dot count per series variable, so any
      // caller doing index arithmetic over a flat circle list is wrong the
      // moment two series thin differently. Dots are appended newest-first, so
      // the first dot carrying a given data-si is that series' right-hand end.
      const single = pts.filter(Boolean).length === 1;
      for (const p of dots) svg.appendChild(svgEl("circle", {
        cx: p[0], cy: p[1], r: single ? 3.5 : 2, "data-si": si,
        fill: s.color, stroke: tk.page, "stroke-width": 1.5 }));
      // Right-hand name and latest value (skipped when cfg.endLabel is absent,
      // e.g. a single-series tile that names the line in its own heading). The
      // key is a sample of the line's own stroke, dash and all.
      if (cfg.endLabel) {
        const e = ends.find(e => e.i === si);
        const lx = x(xs[li]) + 8;
        const key = svgEl("line", { x1: lx, x2: lx + 14, y1: e.ey, y2: e.ey,
          stroke: s.color, "stroke-width": 1.75, class: "skey", "data-si": si });
        if (dash) key.setAttribute("stroke-dasharray", dash);
        svg.appendChild(key);
        svg.appendChild(endText(lx + 19, e.ey, cfg.endLabel(si), cfg.endValue ? cfg.endValue(si) : ""));
      }
      if (cfg.annotateExtremes && series.length === 1 && xs.length > 2) {
        let mi = -1, ma = -1;
        s.values.forEach((v, i) => {
          if (!has(v)) return;
          if (mi < 0 || v < s.values[mi]) mi = i;
          if (ma < 0 || v > s.values[ma]) ma = i;
        });
        for (const [i, dy, kind] of [[ma, -8, "max"], [mi, 16, "min"]]) {
          // Skip the endpoints — their value is already carried by the axis range
          // and the end of the line, and a label there collides with the y-axis.
          if (i <= 0 || i === li) continue;
          const el = svgEl("text", { x: x(xs[i]), y: y(s.values[i]) + dy,
            "text-anchor": "middle", class: "dvalue" });
          el.textContent = cfg.extremeLabel ? cfg.extremeLabel(s.values[i], xs[i], kind)
            : cfg.fmtK(s.values[i]) + " · " + cfg.xLabel(xs[i], false);
          svg.appendChild(el);
        }
      }
    });
    for (const r of ends.filter(e => e.ref)) {
      svg.appendChild(endText(x(t1) + 8, r.ey, r.ref.label,
        r.ref.showValue === false ? "" : cfg.fmtK(r.ref.value)));
    }
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

  // ── stacked area over an x-series, tinted bands ──
  // cfg: {
  //   host, H=230, padL=56, padR=110, padT=14 (22 with events), padB=26,
  //   xs:[t...],
  //   bands:[{ values:[v...], ti, label }], // ti = tint index; stacked in order.
  //                                         // A date where every band is null is
  //                                         // a gap: the area breaks there.
  //   n,                                    // tint band count
  //   ink, bg,                              // tint colour; solid colour under it
  //   tokens:{surface,axis,hair,ref},
  //   fmtK:v=>str, fmtTick:(v,top)=>str, xLabel:(t,first)=>str,
  //   refs:[{ value, label }], events:[{ t, label }],
  //   tip, tipHTML:(pointIndex)=>str
  // }
  function stackedArea(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const xs = cfg.xs, bands = cfg.bands, n = cfg.n, ink = cfg.ink, tk = cfg.tokens || {};
    const events = cfg.events || [];
    const padL = cfg.padL == null ? (cfg.noAxis ? 0 : 56) : cfg.padL;
    const padR = cfg.padR == null ? 110 : cfg.padR;
    const padT = cfg.padT == null ? (events.length ? 22 : 14) : cfg.padT;
    const padB = cfg.padB == null ? (cfg.noAxis ? 10 : 26) : cfg.padB;
    const H = cfg.H == null ? 230 : cfg.H;
    const { svg, W } = frame(host, H);
    const single = xs.length === 1;
    const t0 = xs[0], t1 = xs[xs.length - 1];
    const x = t => single ? (padL + W - padR) / 2
      : padL + (t - t0) / ((t1 - t0) || 1) * (W - padL - padR);
    const present = xs.map((_, i) => bands.some(b => has(b.values[i])));
    const totals = xs.map((_, i) => bands.reduce((a, b) => a + (has(b.values[i]) ? b.values[i] : 0), 0));
    const refVals = (cfg.refs || []).map(r => r.value).filter(has);
    const top = Math.max(...totals, ...refVals);
    const hi = top * 1.08 || 1;
    const y = yScale(0, hi, padT, H - padB);

    if (!cfg.noBg) {
      svg.appendChild(svgEl("rect", { x: padL, y: padT, width: Math.max(W - padL - padR, 0),
        height: H - padB - padT, fill: tk.surface, rx: 4 }));
    }
    if (!cfg.noAxis) {
      rangeFrame(svg, axisTicks(0, hi), y, padL - 6,
        { axis: tk.axis, label: cfg.fmtTick || cfg.fmtK, lo: 0, hi: Math.max(...totals) });
    }
    drawEvents(svg, events, x, padT, H - padB, W, tk.hair || tk.axis);

    // Runs of consecutive dates that have data; each is drawn as its own area.
    const runs = [];
    present.forEach((p, i) => {
      if (!p) return;
      if (runs.length && runs[runs.length - 1].end === i - 1) runs[runs.length - 1].end = i;
      else runs.push({ start: i, end: i });
    });
    const lower = xs.map(() => 0);
    const seams = [];
    // Depth by VALUE (each band's latest total): small bands light, large ones
    // heavy, so the tint carries magnitude as well as identity.
    let last = xs.length - 1;
    while (last > 0 && !present[last]) last--;
    const rankT = valueRanks(bands.map(b => b.values[last] || 0));
    bands.forEach((b, bi) => {
      const fill = texture(svg, b.ti, n, ink, { t: b.t != null ? b.t : rankT[bi], bg: cfg.bg });
      const upper = xs.map((_, i) => lower[i] + (has(b.values[i]) ? b.values[i] : 0));
      if (single) {
        const bw = 42, cx = x(t0);
        svg.appendChild(svgEl("rect", { x: cx - bw / 2, y: y(upper[0]), width: bw,
          height: Math.max(y(lower[0]) - y(upper[0]), 0), fill }));
      } else {
        for (const r of runs) {
          const idx = [];
          for (let i = r.start; i <= r.end; i++) idx.push(i);
          const topEdge = idx.map(i => x(xs[i]).toFixed(1) + " " + y(upper[i]).toFixed(1));
          const bot = idx.map(i => x(xs[i]).toFixed(1) + " " + y(lower[i]).toFixed(1)).reverse();
          svg.appendChild(svgEl("path", { d: "M" + topEdge.join(" L") + " L" + bot.join(" L") + " Z", fill }));
          if (bi < bands.length - 1) seams.push("M" + topEdge.join(" L"));
        }
      }
      for (let i = 0; i < xs.length; i++) lower[i] = upper[i];
    });
    // A hairline seam in the background colour between neighbouring bands, so two
    // tints of similar depth still read as two bands.
    const seamColor = cfg.bg || tk.page;
    if (seamColor && seams.length)
      svg.appendChild(svgEl("path", { d: seams.join(" "), fill: "none", stroke: seamColor,
        "stroke-width": 1, "pointer-events": "none" }));
    for (const r of drawRefs(svg, cfg.refs, y, padL, x(t1), tk.ref || tk.hair || tk.axis))
      svg.appendChild(endText(padL + 4, r.ey - 6, r.ref.label,
        r.ref.showValue === false ? "" : cfg.fmtK(r.ref.value)));

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

    // De-collide the callouts: push overlapping labels apart by just their own
    // line height, so each stays on its slice (a straight hairline) whenever the
    // chart is tall enough, and the connectors bend only where slices genuinely
    // crowd — a short/squished chart fans them out, a roomy desktop one leaves
    // them straight. minStep tracks the label height rather than a fixed 26px
    // gap, which used to force bends even when there was room.
    const minStep = cfg.labelStep == null ? 18 : cfg.labelStep;
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

  // ── area + line combo: tinted "invested" area under a value/return line ──
  // The area is how much you'd put in at each point; the line is what it's worth,
  // so the gap between them reads as the return. Same silhouette language as the
  // stacked-area asset mix. cfg: {
  //   host, H=230, padL=56, padR=20, padT=14 (22 with events), padB=26,
  //   xs:[t...], bars:[v...], line:[v...],   // null in line = no data (it breaks)
  //   ti,                         // tint-band index for the bars
  //   ink, tokens:{axis,hair,page,ref},
  //   fmtK:v=>str, fmtTick:(v,top)=>str, xLabel:(t,first)=>str,
  //   refs:[{ value, label }], events:[{ t, label }],
  //   tip, tipHTML:(i)=>str
  // }
  function barLineChart(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const xs = cfg.xs, bars = cfg.bars || [], line = cfg.line || [], tk = cfg.tokens || {};
    const ink = cfg.ink, events = cfg.events || [];
    const padL = cfg.padL == null ? 56 : cfg.padL;
    const padR = cfg.padR == null ? 20 : cfg.padR;
    const padT = cfg.padT == null ? (events.length ? 22 : 14) : cfg.padT;
    const padB = cfg.padB == null ? 26 : cfg.padB;
    const H = cfg.H == null ? 230 : cfg.H;
    const { svg, W } = frame(host, H);
    const t0 = xs[0], t1 = xs[xs.length - 1];
    const x = t => xs.length === 1 ? (padL + W - padR) / 2
      : padL + (t - t0) / ((t1 - t0) || 1) * (W - padL - padR);
    // stacks[x] = [{value, i, t}] tinted segments (per fund). When present, the
    // bars are per-fund stacks and need a 0 baseline so segments sum correctly.
    // Otherwise a single invested bar, with the axis zoomed to the data so the
    // small gap to the value line (the return) stays legible.
    const stacks = Array.isArray(cfg.stacks) ? cfg.stacks : null;
    const barTotals = stacks
      ? stacks.map(segs => segs.reduce((a, s) => a + (s.value > 0 ? s.value : 0), 0))
      : bars;
    const all = barTotals.concat(line, (cfg.refs || []).map(r => r.value)).filter(has);
    const dataLo = stacks ? 0 : Math.min(...all);
    const dataHi = Math.max(...all);
    const pad = (dataHi - dataLo) * 0.12 || Math.abs(dataHi) * 0.05 || 1;
    const yLo = stacks ? 0 : dataLo - pad;
    const yHi = dataHi + pad;
    const y = yScale(yLo, yHi, padT, H - padB);
    rangeFrame(svg, axisTicks(yLo, yHi), y, padL - 6,
      { axis: tk.axis, label: cfg.fmtTick || cfg.fmtK, lo: dataLo, hi: dataHi });
    drawEvents(svg, events, x, padT, H - padB, W, tk.hair || tk.axis);
    for (const r of drawRefs(svg, cfg.refs, y, x(t0), x(t1), tk.ref || tk.hair || tk.axis))
      svg.appendChild(endText(x(t0) + 4, r.ey - 6, r.ref.label,
        r.ref.showValue === false ? "" : cfg.fmtK(r.ref.value)));
    svg.appendChild(svgEl("line", { x1: x(t0), x2: x(t1), y1: H - padB, y2: H - padB,
      stroke: tk.axis, "stroke-width": 1 }));
    placedMonthTicks(t0, t1, x).forEach((t, i) => {
      const lb = svgEl("text", { x: x(t), y: H - 8, "text-anchor": i ? "middle" : "start" });
      lb.textContent = cfg.xLabel(t, i === 0);
      svg.appendChild(lb);
    });
    // Invested area: stacked per-fund tinted bands (the same silhouette as the
    // asset-mix stacked area), or a single tinted band.
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
    const pts = xs.map((t, i) => has(line[i]) ? [x(t), y(line[i])] : null);
    if (pts.filter(Boolean).length > 1) {
      svg.appendChild(svgEl("path", { d: gapPath(pts), fill: "none", stroke: ink, "stroke-width": 1.75,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    // A single end marker rather than a dot at every point — the line reads clean
    // over the tinted area instead of stippled.
    const end = pts.filter(Boolean).pop();
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

  // ── segmented bar: tinted proportional segments, optional stepped
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
  //   segments:[{ label, value, ti, tipHTML }], // ti = tint index
  //   n, total,                                 // tint band count; sum of values
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
    // segment so a sliver of tint never reads as noise.
    const avail = W - gap * (count - 1);
    const ws = segs.map(s => s.value / (total || 1) * avail);
    const MINW = Math.min(minSeg, avail / count);
    let debt = 0;
    ws.forEach((w, i) => { if (w < MINW) { debt += MINW - w; ws[i] = MINW; } });
    if (debt > 0) ws[ws.indexOf(Math.max(...ws))] -= debt;
    // Rough monospace advance for overflow detection (px per char at 12px).
    const advance = 7.4;
    // Depth by VALUE: small segments light, large ones heavy.
    const rankT = valueRanks(segs.map(s => s.value));
    let x = 0;
    segs.forEach((s, i) => {
      const sx = x, w = ws[i];
      const ti = s.ti != null ? s.ti : i;
      // t===1 makes drawMarks null (treated as the solid terminal), so it must
      // fill solid too — otherwise the biggest segment draws nothing and reads as
      // an empty gap (the "missing bar" on Stocks & Shares). That holds for the
      // internal rank too, when the caller passes no t.
      const t = s.t != null ? s.t : rankT[i];
      const solid = ti >= n - 1 || t === 1;
      // Solid band = one colour filling the segment edge to edge (Figma: plain
      // blocks). It used to be inset 3px on a tile so the tile framed it, which
      // read as an outlined box rather than a solid value. The fill is the ink
      // by default — solid is the top of the depth ramp — but a bar whose ink
      // is DARKER than the card behind it must pass solidFill, or its biggest
      // segment sinks into the background. Tinted bands keep the block
      // (cfg.bg, or transparent so a dark card shows through) with the tint
      // laid over it.
      const rect = svgEl("rect", { x: sx, y: barY, width: w, height: barH,
        rx: 2, fill: solid ? (cfg.solidFill || ink) : (cfg.bg || "transparent"), "pointer-events": "all" });
      // The outline frames a TINTED block, whose fill is the card showing
      // through — without it a light tint would have no edge. A solid
      // segment is its own shape, so an outline there just draws a border round
      // a filled block, the same artefact as the inset.
      if (tk.border && !solid) { rect.setAttribute("stroke", tk.border); rect.setAttribute("stroke-width", 1); }
      svg.appendChild(rect);
      if (!solid) {
        drawMarks(svg, { x: sx, y: barY, w, h: barH }, ti, n, ink, { t });
      }
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

  // ── small multiples: one panel per series, stacked on one shared time axis ──
  // For series that differ in scale, or when the question is each one's shape.
  // Each panel has its own range frame with its min and max printed, its name
  // above it, and its latest value at the right end. With shared:true every
  // panel uses one scale, for when the question is level.
  // cfg: {
  //   host, panelH=56, gap=30, padL=56, padR=92, padT=0, padB=26,
  //   xs:[t...],
  //   panels:[{ label, values:[v...], color, refs:[{value,label}] }], // null = gap
  //   shared:false,
  //   note:str,                  // the encoding, said once for the group
  //   tokens:{ axis, hair, page, ref },
  //   fmtK:v=>str, xLabel:(t,first)=>str,
  //   tip, tipHTML:(pointIndex)=>str
  // }
  function smallMultiples(cfg) {
    const host = cfg.host;
    host.innerHTML = "";
    const xs = cfg.xs, panels = cfg.panels, tk = cfg.tokens || {};
    const padL = cfg.padL == null ? 56 : cfg.padL;
    const padR = cfg.padR == null ? 92 : cfg.padR;
    const padT = (cfg.padT == null ? 0 : cfg.padT) + (cfg.note ? 16 : 0);
    const padB = cfg.padB == null ? 26 : cfg.padB;
    const panelH = cfg.panelH == null ? 56 : cfg.panelH;
    const gap = cfg.gap == null ? 30 : cfg.gap;
    const H = padT + panels.length * (gap + panelH) + 8 + padB;
    const { svg, W } = frame(host, H);
    const t0 = xs[0], t1 = xs[xs.length - 1];
    const x = t => xs.length === 1 ? (padL + W - padR) / 2
      : padL + (t - t0) / ((t1 - t0) || 1) * (W - padL - padR);
    if (cfg.note) {
      const nt = svgEl("text", { x: W - 2, y: 11, "text-anchor": "end", class: "dnote" });
      nt.textContent = cfg.note;
      svg.appendChild(nt);
    }
    const allVals = [].concat(...panels.map(p => p.values.filter(has)));
    const gLo = Math.min(...allVals), gHi = Math.max(...allVals);
    panels.forEach((p, pi) => {
      const top = padT + pi * (gap + panelH) + gap;
      const vals = p.values.filter(has);
      if (!vals.length) return;
      const lo = cfg.shared ? gLo : Math.min(...vals), hi = cfg.shared ? gHi : Math.max(...vals);
      const y = yScale(lo, hi, top, top + panelH);
      const name = svgEl("text", { x: padL, y: top - 8, class: "dlabel" });
      name.textContent = p.label;
      svg.appendChild(name);
      // The panel's own range, printed: its max and its min.
      rangeFrame(svg, lo === hi ? [hi] : [lo, hi], y, padL - 6,
        { axis: tk.axis, label: cfg.fmtK, lo: Math.min(...vals), hi: Math.max(...vals) });
      for (const r of drawRefs(svg, p.refs, y, padL, x(t1), tk.ref || tk.hair || tk.axis))
        svg.appendChild(endText(x(t1) + 8, r.ey, r.ref.label,
          r.ref.showValue === false ? "" : cfg.fmtK(r.ref.value)));
      const pts = xs.map((t, i) => has(p.values[i]) ? [x(t), y(p.values[i])] : null);
      svg.appendChild(svgEl("path", { d: gapPath(pts), fill: "none", stroke: p.color,
        "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const end = pts.filter(Boolean).pop();
      svg.appendChild(svgEl("circle", { cx: end[0], cy: end[1], r: 2.5,
        fill: p.color, stroke: tk.page, "stroke-width": 1.5 }));
      const vl = svgEl("text", { x: end[0] + 8, y: end[1] + 4, class: "dvalue" });
      vl.textContent = cfg.fmtK(vals[vals.length - 1]);
      svg.appendChild(vl);
    });
    const yAxis = H - padB;
    svg.appendChild(svgEl("line", { x1: x(t0), x2: x(t1), y1: yAxis, y2: yAxis,
      stroke: tk.axis, "stroke-width": 1 }));
    placedMonthTicks(t0, t1, x).forEach((t, i) => {
      const lb = svgEl("text", { x: x(t), y: H - 8, "text-anchor": i ? "middle" : "start" });
      lb.textContent = cfg.xLabel(t, i === 0);
      svg.appendChild(lb);
    });
    if (cfg.tip && cfg.tipHTML) {
      const hair = svgEl("line", { y1: padT, y2: yAxis, stroke: tk.axis,
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

  global.Sediment = {
    svgEl, frame, yScale, niceTicks, axisTicks, rangeFrame, grid, monthTicks, placedMonthTicks,
    tip, texture, chip, valueRanks, lineChart, barLineChart, stackedArea, columnChart, dotPlot, segmentedBar,
    smallMultiples,
  };
})(typeof window !== "undefined" ? window : this);
