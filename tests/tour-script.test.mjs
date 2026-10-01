import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";

// client/tour.ts against a small DOM stub (like copy-buttons.test.mjs): which tip shows when, what dismissing it
// stores, and that nothing breaks without storage. Placement and looks are checked in a real browser.
class Node {
  constructor(selectors = [], { dataset = {}, rect = { top: 200, bottom: 240, left: 100, right: 200, width: 100 } } = {}) {
    Object.assign(this, { selectors, dataset, rect, children: [], listeners: {}, style: { setProperty() {} }, hidden: false });
    this.isConnected = true;
    this.attrs = new Set();
    this.classes = new Set();
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c) };
    this.offsetHeight = 120;
  }
  matches(selector) {
    return selector.split(",").some((part) => this.selectors.includes(part.trim()));
  }
  getClientRects() {
    return this.isConnected ? [this.rect] : [];
  }
  getBoundingClientRect() {
    return this.rect;
  }
  contains(other) {
    return other === this || this.children.includes(other);
  }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      node.parent = this;
      node.isConnected = true;
    }
  }
  remove() {
    this.isConnected = false;
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  setAttribute() {}
  toggleAttribute(name, on) {
    on ? this.attrs.add(name) : this.attrs.delete(name);
  }
  closest() {
    return null;
  }
  scrollIntoView() {}
}

const TARGETS = {
  book: '[data-tour="book"]',
  manage: '[data-tour="manage"]',
  machines: '[data-tour="machines"]',
};

async function board({ booked = false, anchors = ["book"], storage = "ok", legacyDismissed = false, today = "2026-10-01", sid, state } = {}) {
  const store = new Map(legacyDismissed ? [["vk-nudge-dismissed", "1"]] : []);
  if (state) store.set("vk-tips", JSON.stringify({ v: 1, shown: {}, off: false, askOff: false, ...state }));
  const session = new Map(sid ? [["vk-tips-session", sid]] : []);
  const area = (map, broken) => ({
    getItem: (key) => (broken ? (() => { throw new Error("blocked"); })() : (map.get(key) ?? null)),
    setItem: (key, value) => (broken ? (() => { throw new Error("blocked"); })() : void map.set(key, String(value))),
  });
  const main = new Node([".resident-main[data-tips]"], { dataset: { tips: booked ? "booked" : "new" } });
  const nodes = [main];
  const targets = Object.fromEntries(anchors.map((id) => [id, new Node([TARGETS[id]], { dataset: { tourMachines: "2" } })]));
  nodes.push(...Object.values(targets));
  const ask = new Node(["#push-ask"]);
  const tipsMenu = new Node(["#tips-menu"]);
  tipsMenu.hidden = true;
  nodes.push(ask, tipsMenu);
  const timers = [];
  let now = 1_000_000;
  const listeners = {};
  const body = new Node();
  const document = {
    body,
    hidden: false,
    activeElement: body,
    documentElement: { clientWidth: 390 },
    createElement: () => new Node(),
    addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
    querySelector: (selector) => nodes.find((node) => node.isConnected && node.matches(selector)) ?? null,
    querySelectorAll: (selector) => nodes.filter((node) => node.isConnected && node.matches(selector)),
  };
  class FakeDate extends Date {
    static now() {
      return now;
    }
    toLocaleDateString() {
      return today;
    }
  }
  const context = {
    document,
    Date: FakeDate,
    JSON,
    Math,
    Number,
    HTMLElement: Node,
    Element: Node,
    innerHeight: 844,
    scrollX: 0,
    scrollY: 0,
    visualViewport: undefined,
    matchMedia: () => ({ matches: false }),
    setTimeout: (callback, ms = 0) => {
      const timer = { callback, at: now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    addEventListener: (type, listener) => (listeners[`window:${type}`] ??= []).push(listener),
    localStorage: area(store, storage === "blocked"),
    sessionStorage: area(session, storage === "blocked"),
  };
  // The page script reads window.localStorage and window.sessionStorage by name.
  context.window = context;
  const { code } = await transform(await readFile("client/tour.ts", "utf8"), { loader: "ts", format: "iife" });
  runInNewContext(code, context);
  const stored = () => JSON.parse(store.get("vk-tips") ?? "null");
  const run = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.find((timer) => timer.at <= end);
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = Math.max(now, next.at);
      next.callback();
    }
    now = end;
  };
  const emit = (type, event = {}) => (listeners[type] ?? []).forEach((listener) => listener(event));
  const marks = () => body.children.filter((node) => node.className === "coach");
  return {
    main, targets, ask, tipsMenu, body, document, stored, run, emit, marks, store,
    newView: (toasts = 0) => emit("vk:board", { detail: { toasts } }),
    button: (label) => marks()[0]?.children.at(-1).children.find((b) => b.textContent === label),
    toast: (on) => {
      if (on) {
        const toast = new Node(["[data-sonner-toast]"]);
        nodes.push(toast);
        return toast;
      }
    },
    nodes,
  };
}

test("a new resident gets the booking tip once the page has settled, and it is stored", async () => {
  const b = await board();
  assert.deepEqual(b.stored(), { v: 1, seen: [], shown: {}, off: false, askOff: false });
  assert.equal(b.tipsMenu.hidden, false, "the Tips menu row appears with the script");
  b.newView();
  b.run(300);
  assert.equal(b.marks().length, 0, "not before the page has settled");
  b.run(600);
  assert.equal(b.marks().length, 1);
  assert.match(b.marks()[0].children[1].textContent, /Begge maskinene følger med/);
  assert.equal(b.stored().shown.book, 1);
  assert.ok(b.targets.book.classes.has("coach-target"));
});

test("a device that has booked before when it first loads the board gets no tour", async () => {
  const b = await board({ booked: true, anchors: ["manage", "machines"] });
  assert.equal(b.stored().off, true);
  b.newView();
  b.run(5000);
  assert.equal(b.marks().length, 0);
});

test("whoever closed the old notification card has the inline ask closed", async () => {
  const b = await board({ legacyDismissed: true });
  assert.equal(b.stored().askOff, true);
  assert.ok(b.ask.attrs.has("data-dismissed"));
});

test("Skjønner, Escape and 'Ikke vis flere tips' all end the tip, and the last turns every tip off", async () => {
  let b = await board();
  b.newView();
  b.run(700);
  b.button("Skjønner").listeners.click[0]();
  assert.equal(b.marks().length, 0);
  assert.deepEqual(b.stored().seen, ["book"]);

  b = await board();
  b.newView();
  b.run(700);
  b.emit("keydown", { key: "Escape" });
  assert.equal(b.marks().length, 0);
  assert.deepEqual(b.stored().seen, ["book"]);

  b = await board();
  b.newView();
  b.run(700);
  b.button("Ikke vis flere tips").listeners.click[0]();
  assert.equal(b.stored().off, true);
  b.newView();
  b.run(5000);
  assert.equal(b.marks().length, 0, "off stays off");
});

test("a tip waits for toasts, and a tip that was shown twice and ignored is retired", async () => {
  const b = await board();
  const toast = b.toast(true);
  b.newView(1);
  b.run(5000);
  assert.equal(b.marks().length, 0, "a toast is on screen");
  toast.isConnected = false;
  b.run(1000);
  assert.equal(b.marks().length, 1, "once it is gone");
  b.newView();
  b.run(900);
  assert.equal(b.stored().shown.book, 2);
  b.newView();
  b.run(5000);
  assert.equal(b.marks().length, 0, "shown twice, so retired");
});

test("the manage tip follows the first booking; the machines tip waits for a later session", async () => {
  const later = { seen: ["book"], shown: { book: 1 }, last: { day: "2026-10-01", sid: "s1" } };
  let b = await board({ booked: true, anchors: ["manage", "machines"], sid: "s1", state: later });
  b.newView();
  b.run(700);
  assert.equal(b.marks().length, 1);
  assert.equal(b.marks()[0].children[0].textContent, "Her er tiden din.");
  b.button("Skjønner").listeners.click[0]();
  assert.deepEqual(b.stored().seen, ["book", "manage"]);
  b.newView();
  b.run(5000);
  assert.equal(b.marks().length, 0, "the same session never shows a third tip");

  const done = { seen: ["book", "manage"], shown: { book: 1, manage: 1 }, last: { day: "2026-10-01", sid: "s1" } };
  b = await board({ booked: true, anchors: ["manage", "machines"], sid: "s1", state: done });
  b.newView();
  b.run(5000);
  assert.equal(b.marks().length, 0, "same day, same session");
  b = await board({ booked: true, anchors: ["manage", "machines"], sid: "s2", state: done });
  b.newView();
  b.run(700);
  assert.equal(b.marks()[0]?.children[0].textContent, "Trenger du bare vask eller tørk?", "a new browser session");
  b = await board({ booked: true, anchors: ["manage", "machines"], sid: "s1", today: "2026-10-02", state: done });
  b.newView();
  b.run(700);
  assert.equal(b.marks()[0]?.children[0].textContent, "Trenger du bare vask eller tørk?", "another day");
});

test("tips never show before the first booking when the resident has booked, and the manage anchor is needed", async () => {
  // Booked, but no row of the resident's own on this page: nothing to point at, so no tip.
  const b = await board({ booked: true, anchors: [], state: { seen: ["book"], shown: { book: 1 } } });
  b.newView();
  b.run(5000);
  assert.equal(b.marks().length, 0);
});

test("without storage the tour still works for the page view and remembers within it", async () => {
  const b = await board({ storage: "blocked" });
  b.newView();
  b.run(700);
  assert.equal(b.marks().length, 1, "no exception, the tip shows");
  b.button("Skjønner").listeners.click[0]();
  b.newView();
  b.run(5000);
  assert.equal(b.marks().length, 0, "dismissed once, not shown again in memory");
});

test("tapping the target counts as seen", async () => {
  const b = await board();
  b.newView();
  b.run(700);
  assert.equal(b.marks().length, 1);
  b.emit("click", { target: b.targets.book });
  assert.equal(b.marks().length, 0);
  assert.deepEqual(b.stored().seen, ["book"]);
});
