# Sediment

A small, dependency-free SVG chart toolkit. One file, no framework, no build
step, no runtime dependencies. It exports a single global, `Sediment`.

The house style is Tufte-ish: range-frame axes, a dotted hairline grid, direct
labels at line ends, and a `texture()` encoding that tells series apart by mark
shape/scale/density instead of colour — so the charts stay legible with no
colour channel at all.

## Design principle

Every builder takes **resolved values** — colours as CSS colour strings, data as
plain numbers, text via formatter callbacks. The module carries no app-specific
knowledge: it never reads your theme, your DOM beyond the host you hand it, or
any global state. You write a thin adapter that resolves your theme tokens (e.g.
with `getComputedStyle`) and feeds these builders. That is what keeps it liftable
into any project.

## Install

Copy the two files into your project and load them:

```html
<link rel="stylesheet" href="sediment.css">
<script src="sediment.js"></script>
```

- `sediment.js` — the module (defines `window.Sediment`).
- `sediment.css` — companion styles. Only the `svg text` rule is strictly
  required; without it labels render as default black at the wrong size. Text
  colour is inherited: set `color` on the chart host and every label follows.

To track upstream, add this repo as a git submodule and point your build/embed at
`sediment.js` — a `git submodule update --remote` pulls new versions.

See [`demo.html`](demo.html) for a runnable example (open it in a browser).

## Quick start

```js
const TIP = Sediment.tip(document.getElementById("tip"));
Sediment.dotPlot({
  host: document.getElementById("risk"),
  rows: [{ pos: 0, value: 74230, label: "Cash PIE", valueLabel: "$74,230" }],
  levels: ["cash", "conservative", "balanced", "growth", "aggressive"],
  avgPos: 1.8,
  dotColor: "#edf3d7",
  tokens: { hair: "rgba(237,243,215,0.5)", fg: "#edf3d7" },
  tip: TIP,
});
```

## Builders

Every chart builder takes a single `cfg` object; `host` is the element the SVG is
appended to (it is sized to the host's width). Colours are resolved CSS strings.
`tip` is an optional tooltip handle from `Sediment.tip(el)`.

### `dotPlot(cfg)` — items on a shared ordinal axis
```
host, rowH=22, padT=8, axisPad=30, axisFrac=0.40, rightPad=88,
rows:[{ pos, value, label, valueLabel, tipHTML }],  // pos = 0..(levels-1)
levels:[str...],                                    // axis tick labels, left→right
avgPos,                                             // optional reference-line position (fractional)
staggerLabels,                                      // allow two-row axis when labels would collide
dotColor, tokens:{ hair, fg }, tip
```
The left gutter auto-sizes to the longest row label; the ordinal axis staggers to
two rows only when labels would otherwise overlap. `avgPos` draws a solid vertical
marker; the row grid is dashed.

### `lineChart(cfg)` — lines over an x-series, range-frame
```
host, H=230, padL=56, padR=92, padT=14, padB=26,
xs:[t...],                          // x values (e.g. epoch ms), ascending
series:[{ values:[v...], color }],  // one line each; values align to xs
tokens:{ axis, hair, page },
fmtK:v=>str, xLabel:(t,first)=>str, endLabel:(seriesIndex)=>str,
annotateExtremes=false,             // label single-series min & max
tip, tipHTML:(pointIndex)=>str
```

### `stackedArea(cfg)` — stacked bands, texture-coded
```
host, H=230, padL=56, padR=110, padT=14, padB=26,
xs:[t...],
bands:[{ values:[v...], ti, label }],  // ti = texture index; stacked in order
n,                                     // texture band count
ink, bg,                               // mark colour; fill behind marks
tokens:{ surface, axis, hair },
fmtK:v=>str, xLabel:(t,first)=>str, tip, tipHTML:(pointIndex)=>str
```

### `columnChart(cfg)` — diverging columns on a baseline
```
host, H=160, padL=56, padR=12, padT=14, padB=26,
bars:[{ value, label, faint }],  // one column each, in order
posColor, negColor, ink,         // ink = baseline + labels
tokens:{ border },
target, targetLabel:str,         // optional dashed reference line
zeroLabel="$0", tip, tipHTML:(barIndex)=>str
```

### `segmentedBar(cfg)` — proportional segments, optional connectors
```
host, barH=24, gap=4, minSeg=24,
segments:[{ label, value, ti, tipHTML }],  // ti = texture index
n, total,                                  // texture band count; sum of values
ink, tokens:{ border, hair },
connectors=false, step=30, topPad=14, labelGap=8, tip
```

### `barLineChart(cfg)` — bars with an overlaid line
See the cfg block above `function barLineChart` in `sediment.js`.

## Helpers

- `Sediment.tip(el)` → `{ show(host, x, y, html), hide }` — floating tooltip bound
  to `el` (style it via the `.sediment-tip` rules in `sediment.css`).
- `Sediment.texture(svg, i, n, ink, opts)` — pattern fill for band `i` of `n`
  (the last band is solid). `Sediment.chip(i, n, ink, size)` returns an inline-SVG
  swatch string of that texture, for legends and tables.
- `Sediment.svgEl(tag, attrs)`, `frame(host, H)`, `yScale`, `niceTicks`, `grid`,
  `monthTicks`, `placedMonthTicks` — low-level building blocks.

## Licence

MIT — see [LICENSE](LICENSE).
