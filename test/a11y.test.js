// Accessibility tests. Run with: node --test test/
// No packages: test/dom.js stands in for the browser DOM.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, host, tipSpy } = require("./dom.js");

const S = load();
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];
const xs = months.map((_, i) => Date.UTC(2026, i, 1));
const xLabel = t => months[new Date(t).getUTCMonth()];
const grid = [410, 380, 352, null, 300, 282, 270, 255];
const solar = [200, 215, 230, 236, 250, 262, 280, 291];

// The README's example chart.
function example(extra) {
  const h = host();
  S.lineChart(Object.assign({
    host: h, xs, xLabel,
    series: [{ values: grid, color: "#222" }, { values: solar, color: "#222", dash: "5 3" }],
    tokens: { axis: "#222", hair: "#999", page: "#fff" },
    fmtK: v => v + " kWh",
    endLabel: i => ["grid", "solar"][i],
    refs: [{ value: 320, label: "budget" }],
    events: [{ t: xs[2], label: "panels on" }],
  }, extra));
  return { h, svg: h.querySelector("svg") };
}

const descOf = svg => svg.querySelector("#" + svg.getAttribute("aria-describedby"));

test("a line chart is a named image with a description written from its data", () => {
  const { svg } = example({ title: "Power use, 2026" });
  assert.equal(svg.getAttribute("role"), "img");
  assert.equal(svg.getAttribute("aria-label"), "Power use, 2026");
  const d = descOf(svg);
  assert.ok(d, "aria-describedby points at an element in the svg");
  assert.equal(d.tagName, "desc");
  assert.equal(d.textContent,
    "Line chart, 2 series: grid, solar. Jan to Aug. " +
    "grid: latest 255 kWh (Aug), low 255 kWh (Aug), high 410 kWh (Jan), no data for Apr. " +
    "solar: latest 291 kWh (Aug), low 200 kWh (Jan), high 291 kWh (Aug). " +
    "Reference line: budget 320 kWh. Event: panels on (Mar).");
  assert.equal(svg.querySelectorAll("title").length, 0, "no <title>: it would show as a hover tooltip");
});

test("the name falls back to the chart kind", () => {
  const { svg } = example();
  assert.equal(svg.getAttribute("aria-label"), "Line chart");
});

test("a caller can replace or edit the description", () => {
  assert.equal(descOf(example({ desc: "Grid use falls." }).svg).textContent, "Grid use falls.");
  const edited = descOf(example({ desc: auto => "Since the panels went on. " + auto }).svg).textContent;
  assert.ok(edited.startsWith("Since the panels went on. Line chart, 2 series"));
});

test("fmtValue and fmtX change the words, not the chart", () => {
  const { svg } = example({ fmtValue: v => v + " kilowatt hours", fmtX: t => xLabel(t) + " 2026" });
  assert.match(descOf(svg).textContent, /grid: latest 255 kilowatt hours \(Aug 2026\)/);
});

test("without a tooltip, a chart is not focusable and adds nothing to its host", () => {
  const { h, svg } = example();
  assert.equal(svg.getAttribute("tabindex"), null);
  assert.equal(h.children.length, 1, "only the svg");
  assert.doesNotMatch(descOf(svg).textContent, /Arrow keys/);
});

test("table: true adds a data table with every value, gaps as 'no data'", () => {
  const { h } = example({ table: true, title: "Power use" });
  const det = h.querySelector("details");
  assert.ok(det);
  assert.equal(det.querySelector("summary").textContent, "Data table");
  assert.equal(det.querySelector("caption").textContent, "Power use");
  const head = det.querySelectorAll("thead th").map(th => th.textContent);
  assert.deepEqual(head, ["", "grid", "solar"]);
  const rows = det.querySelectorAll("tbody tr").map(tr => tr.children.map(c => c.textContent));
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[3], ["Apr", "no data", "236 kWh"]);
  assert.equal(det.querySelectorAll("tbody th")[0].getAttribute("scope"), "row");
  // A string names the summary.
  assert.equal(example({ table: "Show the numbers" }).h.querySelector("summary").textContent, "Show the numbers");
});

test("keyboard: arrows, Home and End move the tooltip and the live region says it", () => {
  const tip = tipSpy();
  const tipHTML = i => '<div class="t">' + months[i] + '</div><div class="row"><span>grid</span><span>' +
    (grid[i] == null ? "no data" : grid[i] + " kWh") + "</span></div>";
  const { h, svg } = example({ tip, tipHTML });
  assert.equal(svg.getAttribute("tabindex"), "0");
  assert.match(descOf(svg).textContent, /Arrow keys step through the values\./);
  const live = h.querySelector("[aria-live]");
  assert.equal(live.getAttribute("aria-live"), "polite");
  assert.match(live.style.cssText, /position:absolute.*clip-path:inset\(50%\)/, "visually hidden");
  const hair = svg.querySelectorAll("line").find(l => l.getAttribute("stroke-dasharray") === "2 3");

  let ev = svg.dispatch("keydown", { key: "ArrowRight" });
  assert.ok(ev.defaultPrevented);
  assert.equal(live.textContent, "Jan grid 410 kWh");
  assert.equal(hair.getAttribute("visibility"), "visible");
  const x0 = +hair.getAttribute("x1");

  svg.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(live.textContent, "Feb grid 380 kWh");
  assert.ok(+hair.getAttribute("x1") > x0, "the hairline moved right");

  svg.dispatch("keydown", { key: "End" });
  assert.equal(live.textContent, "Aug grid 255 kWh");
  svg.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(live.textContent, "Aug grid 255 kWh", "stops at the last point");
  svg.dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(live.textContent, "Jul grid 270 kWh");
  svg.dispatch("keydown", { key: "Home" });
  assert.equal(live.textContent, "Jan grid 410 kWh");
  assert.deepEqual(tip.calls[tip.calls.length - 1], ["show", tipHTML(0)]);

  ev = svg.dispatch("keydown", { key: "Escape" });
  assert.ok(ev.defaultPrevented);
  assert.equal(hair.getAttribute("visibility"), "hidden");
  assert.deepEqual(tip.calls[tip.calls.length - 1], ["hide"]);

  // Escape with nothing open, and keys the chart does not use, reach the page.
  assert.equal(svg.dispatch("keydown", { key: "Escape" }).defaultPrevented, false);
  assert.equal(svg.dispatch("keydown", { key: "Tab" }).defaultPrevented, false);

  // ArrowLeft from closed starts at the end. Blur closes.
  svg.dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(live.textContent, "Aug grid 255 kWh");
  svg.dispatch("blur");
  assert.equal(hair.getAttribute("visibility"), "hidden");
});

test("keyboard: false keeps the old tab order; keyboard: true works with no tooltip", () => {
  const off = example({ tip: tipSpy(), tipHTML: () => "x", keyboard: false });
  assert.equal(off.svg.getAttribute("tabindex"), null);
  assert.equal(off.h.querySelector("[aria-live]"), null);

  const { h, svg } = example({ keyboard: true });
  assert.equal(svg.getAttribute("tabindex"), "0");
  svg.dispatch("keydown", { key: "ArrowRight" });
  svg.dispatch("keydown", { key: "ArrowRight" });
  svg.dispatch("keydown", { key: "ArrowRight" });
  svg.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(h.querySelector("[aria-live]").textContent, "Apr: grid no data, solar 236 kWh");
});

test("pointer: moving over the chart still opens the tooltip at the nearest point", () => {
  const tip = tipSpy();
  const { h, svg } = example({ tip, tipHTML: i => "point " + i });
  svg.dispatch("pointermove", { clientX: h.clientWidth - 1 });
  // The rightmost pixel is nearest the last point (the right margin holds labels).
  assert.deepEqual(tip.calls[0], ["show", "point 7"]);
  svg.dispatch("pointerleave");
  assert.deepEqual(tip.calls[1], ["hide"]);
});

test("column chart: keys step through columns and ring the active one", () => {
  const tip = tipSpy();
  const h = host();
  S.columnChart({ host: h, ink: "#222", negColor: "#c00", tokens: { border: "#999" },
    bars: [{ value: 6, label: "Jan" }, { value: -1.5, label: "Feb" }, { value: 7, label: "Mar" }],
    target: 3, targetLabel: "goal", title: "Savings", fmtValue: v => "$" + v + "k",
    tip, tipHTML: i => "<b>" + ["Jan", "Feb", "Mar"][i] + "</b> net" });
  const svg = h.querySelector("svg");
  assert.equal(descOf(svg).textContent,
    "Column chart, 3 columns, Jan to Mar. Highest $7k (Mar). Lowest $-1.5k (Feb). Reference line: goal $3k." +
    " Arrow keys step through the values. Home and End jump to the ends. Escape closes.");
  svg.dispatch("keydown", { key: "ArrowRight" });
  svg.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(h.querySelector("[aria-live]").textContent, "Feb net");
  const ring = svg.querySelector("g.sfocus");
  assert.equal(ring.getAttribute("visibility"), "visible");
  const bar = svg.children.filter(c => c.tagName === "rect")[1];
  assert.equal(+ring.children[0].getAttribute("x"), +bar.getAttribute("x") - 3, "ring sits on the Feb column");
});

test("segmented bar: the data rects stay the svg's only direct-child rects", () => {
  // tally recolours a segment by indexing the svg's direct-child <rect>s.
  const h = host();
  const segs = [["A", 60], ["B", 180], ["C", 520], ["D", 90]];
  S.segmentedBar({ host: h, n: 5, ink: "#222", tokens: { border: "#999" }, tip: tipSpy(),
    segments: segs.map(([label, value], ti) => ({ label, value, ti, tipHTML: label })) });
  const svg = h.querySelector("svg");
  assert.equal(svg.children.filter(c => c.tagName === "rect").length, segs.length);
  assert.equal(descOf(svg).textContent.split(" Arrow")[0],
    "Segmented bar, 4 parts of 850. A: 60, 7%. B: 180, 21%. C: 520, 61%. D: 90, 11%.");
  svg.dispatch("keydown", { key: "End" });
  assert.equal(h.querySelector("[aria-live]").textContent, "D");
});

test("dot plot, stacked area, area-and-line and small multiples describe themselves", () => {
  const six = xs.slice(0, 6);
  let h = host();
  S.dotPlot({ host: h, levels: ["low", "mid", "high"], avgPos: 1.5, dotColor: "#222",
    rows: [{ pos: 0, value: 10, label: "Cash", valueLabel: "$10" }, { pos: 2, value: 30, label: "Shares", valueLabel: "$30" }] });
  assert.equal(descOf(h.querySelector("svg")).textContent,
    "Dot plot, 2 rows on a scale from low to high. Cash: low, $10. Shares: high, $30. Marker line: between mid and high.");

  h = host();
  S.stackedArea({ host: h, xs: six, n: 3, ink: "#222", xLabel, fmtK: String, fmtNZD: v => v + " kWh",
    bands: [{ values: [1, 2, 3, 4, 5, 6], ti: 0, label: "battery" }, { values: [10, 10, 10, 10, 10, 12], ti: 1, label: "grid" }] });
  assert.equal(descOf(h.querySelector("svg")).textContent,
    "Stacked area chart, 2 bands: battery, grid. Jan to Jun. Latest total 18 kWh (Jun). " +
    "battery: latest 6 kWh (Jun), low 1 kWh (Jan), high 6 kWh (Jun). " +
    "grid: latest 12 kWh (Jun), low 10 kWh (Jan), high 12 kWh (Jun).");

  h = host();
  S.barLineChart({ host: h, xs: six, ink: "#222", xLabel, fmtK: String, areaLabel: "invested", lineLabel: "value",
    bars: [1, 2, 3, 4, 5, 6], line: [1, 2, 4, null, 6, 8] });
  assert.match(descOf(h.querySelector("svg")).textContent,
    /^Area and line chart: invested and value\. Jan to Jun\. invested: latest 6 \(Jun\).*value: latest 8 \(Jun\), low 1 \(Jan\), high 8 \(Jun\), no data for Apr\.$/);

  h = host();
  S.smallMultiples({ host: h, xs: six, xLabel, fmtK: String,
    panels: [{ label: "A", values: [1, 2, 3, 4, 5, 6], color: "#222" }, { label: "B", values: [6, 5, 4, 3, 2, 1], color: "#222" }] });
  assert.match(descOf(h.querySelector("svg")).textContent,
    /^Small multiples, 2 panels: A, B, each on its own scale\. Jan to Jun\. A: latest 6 \(Jun\)/);
});

test("texture chips are hidden from screen readers; describe() is public", () => {
  assert.match(S.chip(0, 3, "#222", 12), /aria-hidden="true"/);
  const h = host();
  const { svg } = S.frame(h, 100);
  S.describe(svg, { title: "Custom", desc: "Hand-drawn." });
  S.describe(svg, { title: "Custom", desc: "Updated." });
  assert.equal(svg.getAttribute("role"), "img");
  assert.equal(svg.querySelectorAll("desc").length, 1, "a second call updates, not adds");
  assert.equal(descOf(svg).textContent, "Updated.");
});

test("every chart svg carries the sediment class the CSS keys on", () => {
  const { svg } = example();
  assert.equal(svg.getAttribute("class"), "sediment");
});
