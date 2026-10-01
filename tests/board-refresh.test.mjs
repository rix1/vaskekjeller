import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Board refresh: the "taken" message says someone else got the slot and the board shown with it is current;
// an unchanged board renders identically, so the client can skip redrawing it. Same harness as toasts.test.mjs.
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
const reset = async () => {
  await db.batch([db.prepare("DELETE FROM bookings"), db.prepare("DELETE FROM waitlist")]);
};
const flash = (response) => new URL(response.headers.get("location"), "http://localhost").searchParams.get("m");
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-refresh-tests-"));
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

const page = async (location, apartment = "A3") =>
  (await mf.dispatchFetch(new URL(location, "http://localhost"), { headers: { Cookie: `vk_apt=${apartment}` } })).text();
const toasts = (html) => [...html.matchAll(/<div class="(toast [^"]*)" role="(\w+)">([\s\S]*?)<a class="toast-close"/g)];

test("a lost race says someone else took the slot and shows the board with their booking", async () => {
  await reset();
  await book(480, "D4");
  const taken = await book(480);
  assert.equal(flash(taken), "taken");
  const html = await page(taken.headers.get("location"));
  const [toast] = toasts(html);
  assert.match(toast[3], /Noen andre tok akkurat den tiden\. Tidene under er oppdatert\./);
  assert.equal(sqlite.prepare("SELECT 1 FROM bookings WHERE cancelled_at IS NULL").all().length, 2);
});

test("an unchanged board renders identically, a new booking changes it", async () => {
  await reset();
  const url = `/bygg?date=${tomorrow}&mode=pair-1-2`;
  const board = (html) => html.match(/<main[\s\S]*<\/main>/)?.[0];
  const before = board(await page(url));
  assert.ok(before);
  assert.equal(board(await page(url)), before);
  await book(480, "D4");
  assert.notEqual(board(await page(url)), before);
});
