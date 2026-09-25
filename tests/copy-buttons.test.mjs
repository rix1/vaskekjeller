import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";

// The Kopier buttons, with client/app.ts and client/admin.ts both loaded as on the admin and signup pages.
// A click runs the button's own listener, then bubbles to the document listeners.
class Element {
  constructor({ classes = [], id, dataset = {}, parent, text = "" } = {}) {
    Object.assign(this, { classes, id, dataset, parentElement: parent, textContent: text, listeners: [] });
    this.hidden = true;
    this.classList = { add: (c) => classes.push(c), remove: () => {}, contains: (c) => classes.includes(c) };
  }
  // Enough of CSS for the selectors the scripts use here: `.class`, `#id`, `[data-x]` and one descendant step.
  matches(selector) {
    const parts = selector.trim().split(/\s+/);
    const own = (el, part) =>
      part.startsWith(".")
        ? el.classes.includes(part.slice(1))
        : part.startsWith("#")
          ? el.id === part.slice(1)
          : part === "[data-copy]" && "copy" in el.dataset;
    if (!own(this, parts.at(-1))) return false;
    if (parts.length === 1) return true;
    for (let el = this.parentElement; el; el = el.parentElement) if (own(el, parts[0])) return true;
    return false;
  }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (selector.split(",").some((s) => el.matches(s))) return el;
    return null;
  }
  querySelector(selector) {
    return this.children?.find((el) => el.matches(selector)) ?? null;
  }
  addEventListener(type, listener) {
    this.listeners.push(listener);
  }
  setAttribute() {}
  getAttribute() {
    return null;
  }
  hasAttribute() {
    return false;
  }
  select() {}
}
class HTMLElement extends Element {}
class HTMLButtonElement extends HTMLElement {}
class HTMLInputElement extends HTMLElement {}
class HTMLTextAreaElement extends HTMLElement {}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function button(copy, parent) {
  const el = new HTMLButtonElement({ dataset: { copy }, parent });
  const label = new HTMLElement({ dataset: { copyLabel: "" }, parent: el, text: copy === "#melding-beboere" ? "Kopier melding" : "Kopier" });
  label.matches = (selector) => selector === "[data-copy-label]" || Element.prototype.matches.call(label, selector);
  el.children = [label];
  el.label = label;
  return el;
}

async function page(elements, scripts) {
  const listeners = {};
  const writes = [];
  const timers = [];
  const body = new HTMLElement();
  body.append = () => {};
  const all = elements;
  const context = {
    location: { href: "http://localhost/bygg/admin/settings", pathname: "/bygg/admin/settings", search: "", hash: "", origin: "http://localhost" },
    history: { replaceState() {} },
    URL,
    Element,
    HTMLElement,
    HTMLButtonElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLDialogElement: class {},
    HTMLAnchorElement: class {},
    navigator: { clipboard: { writeText: async (text) => void writes.push(text) }, userAgent: "" },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame() {},
    setTimeout: (callback) => timers.push(callback),
    clearTimeout() {},
    addEventListener() {},
    innerHeight: 900,
    scrollY: 0,
    document: {
      body,
      documentElement: { scrollHeight: 2000, classList: { add() {} } },
      createElement: () => new HTMLElement(),
      addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
      querySelector: (selector) => all.find((el) => el.matches(selector)) ?? null,
      querySelectorAll: (selector) => all.filter((el) => el.matches(selector)),
      getElementById: () => null,
    },
  };
  context.window = context;
  for (const script of scripts) {
    const { code } = await transform(await readFile(script, "utf8"), { loader: "ts", format: "iife" });
    runInNewContext(code, context);
  }
  return {
    writes,
    async click(el) {
      const event = { target: el.label ?? el, preventDefault() {} };
      el.listeners.forEach((listener) => listener(event));
      listeners.click.forEach((listener) => listener(event));
      await settle();
    },
    timersRun: () => timers.splice(0).forEach((callback) => callback()),
  };
}

test("each Kopier button on an admin page copies its own text, once, and keeps its label", async () => {
  const code = new HTMLElement({ id: "recovery-code-value", text: "9WPD-H4D4-KM2X" });
  const secret = new HTMLElement({ classes: ["secret-plain"], text: "Dør4521" });
  const message = Object.assign(new HTMLTextAreaElement({ id: "melding-beboere" }), { value: "Hei, naboer!", readOnly: true });
  const copyCode = button("#recovery-code-value");
  const copySecret = button(".secret-plain");
  const copyMessage = button("#melding-beboere");
  const admin = await page([code, secret, message, copyCode, copySecret, copyMessage], ["client/app.ts", "client/admin.ts"]);

  await admin.click(copyCode);
  await admin.click(copySecret);
  await admin.click(copyMessage);
  assert.deepEqual(admin.writes, ["9WPD-H4D4-KM2X", "Dør4521", "Hei, naboer!"]);
  admin.timersRun();
  // Setting the button's own text would replace its icon and label.
  for (const el of [copyCode, copySecret, copyMessage]) assert.equal(el.textContent, "", "the icon and label stay");
  assert.equal(copyMessage.label.textContent, "Kopier melding");
});

test("the resident page's calendar link still copies", async () => {
  const field = new HTMLElement({ classes: ["calendar-link"] });
  const input = Object.assign(new HTMLInputElement({ id: "calendar-url", parent: field }), { value: "https://example/cal.ics" });
  const copy = new HTMLButtonElement({ dataset: { copy: "#calendar-url" }, parent: field });
  const resident = await page([field, input, copy], ["client/app.ts"]);
  await resident.click(copy);
  assert.deepEqual(resident.writes, ["https://example/cal.ics"]);
});
