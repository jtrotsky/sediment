// A small DOM stand-in: just enough for sediment.js to build its charts in
// node, with no packages. Layout in sediment depends only on host.clientWidth.
// getBoundingClientRect returns the host width and zero height, which is
// enough to drive the tooltip code paths.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = s => esc(s).replace(/"/g, "&quot;");

class Text {
  constructor(t) { this.data = t; this.children = []; }
  get textContent() { return this.data; }
  get outerHTML() { return esc(this.data); }
}

class El {
  constructor(tag) {
    this.tagName = tag; this.attrs = new Map(); this.children = []; this.parentNode = null;
    this.style = {}; this.clientWidth = 0; this.listeners = {};
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  get firstChild() { return this.children[0] || null; }
  // As in the DOM, setting textContent replaces the children with one text node.
  set textContent(t) { this.children = [new Text(String(t))]; }
  get textContent() { return this.children.map(c => c.textContent).join(""); }
  set innerHTML(h) {
    if (h !== "") throw new Error("innerHTML with content not supported: " + h);
    this.children = [];
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  // Fire an event. Returns it, so a test can check preventDefault.
  dispatch(type, props) {
    const ev = Object.assign({ type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, props);
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  // An svg fills its host's width, as with width="100%".
  getBoundingClientRect() {
    const w = this.clientWidth || (this.parentNode && this.parentNode.clientWidth) || 0;
    return { left: 0, top: 0, width: w, height: 0 };
  }
  // Selectors: "tag", "#id", ".class", "tag.class", "[attr]", and descendant
  // chains of those ("thead th").
  matches(sel) {
    if (sel[0] === "#") return this.getAttribute("id") === sel.slice(1);
    if (sel[0] === "[") return this.hasAttribute(sel.slice(1, -1));
    const [tag, cls] = sel.split(".");
    if (tag && this.tagName !== tag) return false;
    if (cls && !(this.getAttribute("class") || "").split(" ").includes(cls)) return false;
    return true;
  }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    if (parts.length > 1) {
      let scope = [this];
      for (const p of parts) scope = [].concat(...scope.map(e => e.querySelectorAll(p)));
      return [...new Set(scope)];
    }
    const out = [];
    const walk = e => { for (const c of e.children) { if (c instanceof El) { if (c.matches(sel)) out.push(c); walk(c); } } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get outerHTML() {
    let a = "";
    for (const [k, v] of this.attrs) a += " " + k + '="' + escA(v) + '"';
    return "<" + this.tagName + a + ">" + this.children.map(c => c.outerHTML).join("") + "</" + this.tagName + ">";
  }
}

// Load sediment.js into a fresh context with the stand-in, and return Sediment.
function load(file) {
  const src = file || path.join(__dirname, "..", "sediment.js");
  const document = {
    createElementNS: (ns, tag) => new El(tag),
    createElement: tag => new El(tag),
    documentElement: { clientWidth: 1200 },
  };
  const window = { scrollX: 0, scrollY: 0 };
  const ctx = vm.createContext({ window, document, Math, Date, Number, String, Array, Object, JSON, Set, Map, console });
  vm.runInContext(fs.readFileSync(src, "utf8"), ctx, { filename: src });
  return window.Sediment;
}

const host = (w = 600) => { const h = new El("div"); h.clientWidth = w; return h; };

// A tooltip stand-in that records what the chart asked it to do.
function tipSpy() {
  const calls = [];
  return { calls, show(h, x, y, html) { calls.push(["show", html]); }, hide() { calls.push(["hide"]); } };
}

module.exports = { El, load, host, tipSpy };
