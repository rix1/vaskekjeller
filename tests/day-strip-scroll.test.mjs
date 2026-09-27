import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Day strip on phones: a sideways-scrolling, snapping Monday-first week that opens on the selected day.
// Same harness as board-polish.test.mjs: the real Hono routes against an isolated SQLite database.
let worker, temp, sqlite;
function statement(sql) {
  let bindings = [];
  return {
    bind(...values) {
      bindings = values;
      return this;
    },
    async first(column) {
      const row = sqlite.prepare(sql).get(...bindings);
      return row ? (column ? row[column] : row) : null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...bindings), success: true, meta: {} };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...bindings);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
  };
}
const db = { prepare: statement, batch: async (statements) => Promise.all(statements.map((s) => s.run())) };
const bindings = { DB: db, SESSION_SECRET: "isolated-test-only", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" };
const board = async () =>
  (
    await worker.fetch(new Request("http://localhost/bygg", { headers: { Cookie: "vk_apt=A3" } }), bindings, {
      waitUntil: (promise) => promise.catch(() => {}),
    })
  ).text();

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-strip-tests-"));
  const output = join(temp, "worker.mjs");
  await build({
    entryPoints: ["src/index.tsx"],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: output,
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  });
  worker = (await import(pathToFileURL(output).href)).default;
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(await readFile("migrations/0001_init.sql", "utf8"));
  sqlite.exec(await readFile("migrations/0002_booking_overlap.sql", "utf8"));
  sqlite.exec(await readFile("migrations/0005_calendar_feeds.sql", "utf8"));
  sqlite.exec("INSERT INTO tenants (id,slug,name,admin_password_hash) VALUES (1,'bygg','Test','unused')");
  sqlite.exec("INSERT INTO machines (id,tenant_id,kind,name) VALUES (1,1,'washer','Vaskemaskin'),(2,1,'dryer','Tørketrommel')");
});
after(async () => {
  sqlite?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

// A 311px strip at x=16 holding seven 64px days 6px apart, as on a 375px phone.
function fakeStrip(selectedIndex) {
  const width = 311;
  const max = 7 * 64 + 6 * 6 - width;
  const strip = {
    _scroll: 0,
    get scrollLeft() {
      return this._scroll;
    },
    set scrollLeft(value) {
      this._scroll = Math.max(0, Math.min(max, value));
    },
    getBoundingClientRect: () => ({ left: 16, right: 16 + width }),
    querySelector: (selector) => (selector === ".selected" ? items[selectedIndex] : null),
  };
  const items = Array.from({ length: 7 }, (_, i) => ({
    getBoundingClientRect: () => ({ left: 16 + i * 70 - strip._scroll, right: 16 + i * 70 + 64 - strip._scroll }),
  }));
  items.forEach((item, i) => (item.previousElementSibling = items[i - 1] ?? null));
  return { strip, max };
}

test("the strip is followed by a script that scrolls the selected day into view before the first paint", async () => {
  const html = await board();
  const match = html.match(/<nav class="date-strip"[\s\S]*?<\/nav><script>([\s\S]*?)<\/script>/);
  assert.ok(match, "inline script directly after the date strip");
  const code = match[1].replaceAll("&#39;", "'");
  const run = (selectedIndex) => {
    const { strip, max } = fakeStrip(selectedIndex);
    new Function("document", code)({ currentScript: { previousElementSibling: strip } });
    return { scrollLeft: strip.scrollLeft, max };
  };
  assert.equal(run(0).scrollLeft, 0, "Monday: start of the week");
  assert.equal(run(3).scrollLeft, 2 * 70, "Thursday: Wednesday first");
  const sunday = run(6);
  assert.equal(sunday.scrollLeft, sunday.max, "Sunday: fully scrolled right");
});

test("on phones the days scroll sideways with snap points and a minimum width", async () => {
  const css = await readFile("public/style.css", "utf8");
  const block = css.match(/@media \(max-width: 740px\) \{\s*\.date-strip \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(block, /overflow-x: auto/);
  assert.match(block, /scroll-snap-type: x mandatory/);
  assert.match(block, /\.date-item \{[^}]*min-width: \d+px/);
  assert.match(block, /\.date-item \{[^}]*scroll-snap-align: start/);
});
