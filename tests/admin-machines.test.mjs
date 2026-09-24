import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";

// Inline machine updates in client/admin.ts (arrows, switch, rename), run against a fake settings page
// whose server answers with `respond`. The admin clicks machine 3's up arrow.
class Element {}
class HTMLElement extends Element {
  constructor(attributes = {}) {
    super();
    this.attributes = attributes;
    this.dataset = {};
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
}
class HTMLButtonElement extends HTMLElement {}
class HTMLInputElement extends HTMLElement {}
class HTMLFormElement extends HTMLElement {
  submit() {
    this.submitted = true;
  }
}

const SETTINGS = "http://localhost/bygg/admin/settings";
const MOVE = "http://localhost/bygg/admin/machines/3/move";
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function machinesPage(respond) {
  const { code } = await transform(await readFile("client/admin.ts", "utf8"), { loader: "ts", format: "iife" });
  const listeners = {};
  const navigations = [];
  const arrow = Object.assign(new HTMLButtonElement(), { dataset: { focusKey: "up-3" } });
  const section = { setAttribute() {}, contains: (el) => el === arrow, replaceWith: (next) => (page.replaced = next) };
  const nextArrow = Object.assign(new HTMLButtonElement(), { dataset: { focusKey: "up-3" }, disabled: false });
  nextArrow.focus = () => (page.document.activeElement = nextArrow);
  const nextSection = {
    querySelector: (selector) => (selector === '[data-focus-key="up-3"]' ? nextArrow : null),
  };
  const form = Object.assign(new HTMLFormElement({ "data-inline": "" }), { action: MOVE, entries: [["dir", "up"]] });
  const body = new HTMLElement();
  body.append = () => {};
  const page = {
    location: {
      href: SETTINGS,
      pathname: "/bygg/admin/settings",
      search: "",
      hash: "",
      assign: (url) => navigations.push(url),
    },
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    Element,
    HTMLElement,
    HTMLButtonElement,
    HTMLInputElement,
    HTMLFormElement,
    HTMLDialogElement: class {},
    FormData: class {
      constructor(f) {
        this.entries = f.entries;
      }
      [Symbol.iterator]() {
        return this.entries[Symbol.iterator]();
      }
    },
    DOMParser: class {
      parseFromString(html) {
        return { getElementById: (id) => (html === "settings" && id === "maskiner" ? nextSection : null), querySelectorAll: () => [] };
      }
    },
    fetch: respond,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame() {},
    addEventListener() {},
    innerHeight: 900,
    scrollY: 0,
    document: {
      body,
      activeElement: body,
      documentElement: { scrollHeight: 2000 },
      createElement: () => ({ setAttribute() {} }),
      addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: (id) => (id === "maskiner" ? section : null),
    },
  };
  page.window = page;
  runInNewContext(code, page);

  return {
    page,
    form,
    navigations,
    nextArrow,
    async clickUp() {
      const event = { target: form, submitter: arrow, defaultPrevented: false, preventDefault() {} };
      listeners.submit.forEach((listener) => listener(event));
      for (let i = 0; i < 5; i++) await settle();
    },
  };
}

const response = (props) => async () => ({ redirected: false, url: MOVE, text: async () => "", ...props });

test("a saved move replaces the list and keeps focus on the arrow", async () => {
  const admin = await machinesPage(response({ redirected: true, url: SETTINGS, text: async () => "settings" }));
  await admin.clickUp();
  assert.ok(admin.page.replaced);
  assert.equal(admin.page.document.activeElement, admin.nextArrow);
  assert.deepEqual(admin.navigations, []);
});

test("an error page from the server reloads settings with an error, without posting again", async () => {
  for (const text of ["Forbidden", "Internal Server Error"]) {
    const admin = await machinesPage(response({ text: async () => text }));
    await admin.clickUp();
    assert.deepEqual(admin.navigations, ["/bygg/admin/settings?m=machine-failed#maskiner"]);
    assert.equal(admin.form.submitted, undefined);
  }
});

test("an expired session follows the redirect to the login page", async () => {
  const login = "http://localhost/bygg/admin/login";
  const admin = await machinesPage(response({ redirected: true, url: login, text: async () => "login" }));
  await admin.clickUp();
  assert.deepEqual(admin.navigations, [login]);
});

test("a move the server confirmed is not sent again when the page body is lost", async () => {
  const admin = await machinesPage(
    response({ redirected: true, url: SETTINGS, text: () => Promise.reject(new TypeError("network error")) }),
  );
  await admin.clickUp();
  assert.equal(admin.form.submitted, undefined);
  assert.deepEqual(admin.navigations, [SETTINGS]);
});

test("without a response the form is posted the ordinary way", async () => {
  const admin = await machinesPage(() => Promise.reject(new TypeError("offline")));
  await admin.clickUp();
  assert.equal(admin.form.submitted, true);
  assert.deepEqual(admin.navigations, []);
});

test("focus the admin moved outside the machine list stays there", async () => {
  const admin = await machinesPage(response({ redirected: true, url: SETTINGS, text: async () => "settings" }));
  const nameField = new HTMLInputElement();
  admin.page.document.activeElement = nameField;
  await admin.clickUp();
  assert.ok(admin.page.replaced);
  assert.equal(admin.page.document.activeElement, nameField);
});
