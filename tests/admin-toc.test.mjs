import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";

// The settings table of contents in client/admin.ts, run against a fake page with the layout of a new
// tenant's settings at 1280x900 (two machines, empty apartment list): section tops in page pixels.
const SECTIONS = { generelt: 215, tider: 493, leiligheter: 1020, maskiner: 1475, tilgang: 1804 };
const PAGE_HEIGHT = 2117;
const BOTTOM = PAGE_HEIGHT - 900;

async function settingsPage(hash = "") {
  const { code } = await transform(await readFile("client/admin.ts", "utf8"), { loader: "ts", format: "iife" });
  const listeners = {};
  let frames = [];
  const links = Object.keys(SECTIONS).map((id) => {
    const attributes = new Map();
    return {
      hash: `#${id}`,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      getAttribute: (name) => attributes.get(name) ?? null,
      addEventListener(type, listener) {
        this[`on${type}`] = listener;
      },
    };
  });
  const page = {
    scrollY: 0,
    innerHeight: 900,
    location: { href: `http://localhost/bygg/admin/settings${hash}`, pathname: "/bygg/admin/settings", search: "", hash },
    history: { replaceState() {} },
    URL,
    HTMLDialogElement: class {},
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback) => frames.push(callback),
    addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
    document: {
      body: { append() {} },
      documentElement: { scrollHeight: PAGE_HEIGHT },
      createElement: () => ({ setAttribute() {} }),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: (selector) => (selector === ".toc a" ? links : []),
      getElementById: (id) =>
        id in SECTIONS ? { getBoundingClientRect: () => ({ top: SECTIONS[id] - page.scrollY }) } : null,
    },
  };
  page.window = page;
  runInNewContext(code, page);

  const fire = (type) => listeners[type]?.forEach((listener) => listener());
  const frame = () => {
    const due = frames;
    frames = [];
    due.forEach((callback) => callback());
  };
  // The browser scrolls, dispatches `scroll`, then runs animation frames.
  const land = (y) => {
    page.scrollY = y;
    fire("scroll");
    frame();
    frame();
  };
  return {
    marked: () => links.find((link) => link.getAttribute("aria-current"))?.hash,
    scrollTo(y) {
      page.scrollY = y;
      fire("scroll");
    },
    click(hash, y) {
      links.find((link) => link.hash === hash).onclick();
      land(y);
    },
    // Back and Forward change the hash; near the bottom the page may not scroll.
    history(hash, y) {
      page.location.hash = hash;
      fire("hashchange");
      land(y);
    },
    land,
  };
}

test("the TOC marks the section in view whichever way the admin scrolls", async () => {
  const toc = await settingsPage();
  assert.equal(toc.marked(), "#generelt");
  toc.scrollTo(300);
  assert.equal(toc.marked(), "#tider");
  toc.scrollTo(917);
  assert.equal(toc.marked(), "#leiligheter", "coming down");
  toc.scrollTo(BOTTOM);
  assert.equal(toc.marked(), "#tilgang", "the last section wins at the bottom");
  for (const y of [1117, 1017, 917]) {
    toc.scrollTo(y);
    assert.equal(toc.marked(), "#leiligheter", `coming up from the bottom to ${y}`);
  }
  toc.scrollTo(817);
  toc.scrollTo(917);
  assert.equal(toc.marked(), "#leiligheter", "down again from 817");
  toc.scrollTo(517);
  assert.equal(toc.marked(), "#tider");
});

test("a section jumped to stays marked at the bottom until the admin scrolls", async () => {
  const toc = await settingsPage("#maskiner");
  toc.land(BOTTOM);
  assert.equal(toc.marked(), "#maskiner", "loaded at #maskiner");
  toc.click("#tilgang", BOTTOM);
  assert.equal(toc.marked(), "#tilgang");
  toc.history("#maskiner", BOTTOM);
  assert.equal(toc.marked(), "#maskiner", "Back from #tilgang");
  toc.scrollTo(BOTTOM);
  assert.equal(toc.marked(), "#maskiner", "a scroll event without movement keeps the jump");
  toc.scrollTo(917);
  assert.equal(toc.marked(), "#leiligheter", "scrolling by hand follows the sections again");
  toc.click("#maskiner", BOTTOM);
  assert.equal(toc.marked(), "#maskiner");
});
