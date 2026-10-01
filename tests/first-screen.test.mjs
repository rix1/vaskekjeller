import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// First-screen diet: the board drops repeated text so the slot list starts higher.
// Same harness as bookings.test.mjs: the real Hono routes against an isolated SQLite database.
let mf, db, temp, sqlite;
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
    execute() {
      const stmt = sqlite.prepare(sql);
      if (stmt.columns().length) return { results: stmt.all(...bindings), success: true, meta: {} };
      const result = stmt.run(...bindings);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
  };
}
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const post = (path, body, apartment = "A3") =>
  mf.dispatchFetch(`http://localhost/bygg/${path}?date=${tomorrow}&mode=pair-1-2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "http://localhost",
      Cookie: `vk_apt=${apartment}`,
    },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
const book = (start, apartment = "A3", mode = "pair-1-2") => post("book", { date: tomorrow, start, mode }, apartment);
const active = () => db.prepare("SELECT * FROM bookings WHERE cancelled_at IS NULL ORDER BY id").all();
const reset = async () => {
  await db.batch([db.prepare("DELETE FROM bookings"), db.prepare("DELETE FROM waitlist")]);
};
const flash = (response) => new URL(response.headers.get("location"), "http://localhost").searchParams.get("m");
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-board-tests-"));
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
  sqlite = new DatabaseSync(":memory:");
  db = {
    prepare: statement,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => s.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const worker = (await import(pathToFileURL(output).href)).default;
  const bindings = { DB: db, SESSION_SECRET: "isolated-test-only", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" };
  mf = {
    dispatchFetch: (url, init) => worker.fetch(new Request(url, init), bindings, { waitUntil: (promise) => promise.catch(() => {}) }),
  };
  sqlite.exec(await readFile("migrations/0001_init.sql", "utf8"));
  await db.prepare(await readFile("migrations/0002_booking_overlap.sql", "utf8")).run();
  sqlite.exec(await readFile("migrations/0005_calendar_feeds.sql", "utf8"));
  await db.prepare("INSERT INTO tenants (id,slug,name,admin_password_hash) VALUES (1,'bygg','Test','unused')").run();
  await db
    .prepare(
      "INSERT INTO machines (id,tenant_id,kind,name) VALUES (1,1,'washer','Vaskemaskin'),(2,1,'dryer','Tørketrommel'),(3,1,'washer','Ekstra vaskemaskin')",
    )
    .run();
});
after(async () => {
  sqlite?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

const page = async (query) =>
  (await mf.dispatchFetch(`http://localhost/bygg?${query}`, { headers: { Cookie: "vk_apt=A3" } })).text();
const today = new Date().toISOString().slice(0, 10);
// Visible text only: the Reserver button's aria-label legitimately names the machines.
const rows = (html) =>
  [...html.matchAll(/<article class="time-slot available".*?<\/article>/gs)].map((m) => m[0].replace(/aria-label="[^"]*"/g, ""));

test("free rows do not repeat the machine names or the duration", async () => {
  const html = await page(`date=${tomorrow}&mode=pair-1-2`);
  const free = rows(html);
  assert.ok(free.length > 0);
  for (const row of free) {
    assert.match(row, /Begge ledige/);
    assert.doesNotMatch(row, /Vaskemaskin|Tørketrommel|timer|<small>/);
  }
  assert.match(html, /per tid/);
});

test("single-machine mode does not repeat the machine name on rows", async () => {
  const html = await page(`date=${tomorrow}&mode=1`);
  for (const row of rows(html)) assert.doesNotMatch(row, /Vaskemaskin/);
});

test("the Ledig legend and the tips card are gone", async () => {
  const html = await page(`date=${tomorrow}&mode=pair-1-2`);
  assert.doesNotMatch(html, /legend-dot|good-neighbor|Litt omtanke/);
});

test("I dag is only offered when not viewing today", async () => {
  assert.match(await page(`date=${tomorrow}&mode=pair-1-2`), /class="today-link"/);
  assert.doesNotMatch(await page(`date=${today}&mode=pair-1-2`), /class="today-link"/);
});

test("elapsed slots fold into one line, keeping a still-late latest slot open", async () => {
  const html = await page(`date=${today}&mode=pair-1-2`);
  const elapsed = (html.match(/class="time-slot elapsed/g) ?? []).length;
  const fold = html.match(/<details class="elapsed-fold">.*?<\/details>/s)?.[0];
  if (elapsed === 0) return assert.equal(fold, undefined);
  const folded = fold ? (fold.match(/class="time-slot elapsed/g) ?? []).length : 0;
  assert.ok(elapsed - folded <= 1);
  if (fold) assert.match(fold, new RegExp(`<summary>${folded === 1 ? "1 tidligere tid" : `${folded} tidligere tider`}</summary>`));
});
