import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Compact "Dine tider" and the in-place actions on your own slot row.
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

const board = async (apartment = "A3", query = "") =>
  (
    await mf.dispatchFetch(`http://localhost/bygg?date=${tomorrow}&mode=pair-1-2${query}`, { headers: { Cookie: `vk_apt=${apartment}` } })
  ).text();

test("Dine tider is hidden while the resident has no bookings", async () => {
  await reset();
  const html = await board();
  assert.doesNotMatch(html, /id="mine"|En ren start|mobile-mine-link/);
  assert.doesNotMatch(html, />Dine tider</);
});

test("each booking is a compact row without kicker or check mark", async () => {
  await reset();
  await book(480);
  const html = await board();
  const mine = html.match(/<section class="my-bookings" id="mine">.*?<\/section>/s)?.[0] ?? "";
  assert.equal((mine.match(/<details class="reservation-row"/g) ?? []).length, 1);
  assert.doesNotMatch(mine, /DIN NESTE VASK|RESERVERT|reservation-kicker|<h3/);
  const summary = mine.match(/<summary>.*?<\/summary>/s)?.[0] ?? "";
  assert.equal((summary.match(/<svg/g) ?? []).length, 2, "washer and dryer icons");
  assert.match(summary, /08:00–10:00/);
});

test("your own slot row expands in place with calendar, comment and cancel", async () => {
  await reset();
  await book(480);
  const html = await board();
  const own = html.match(/<article class="time-slot reserved own">.*?<\/article>/s)?.[0] ?? "";
  assert.match(own, /<details class="own-slot">/);
  assert.match(own, /Din tid/);
  assert.match(own, /event\.ics/);
  assert.match(own, /Kommentar/);
  assert.match(own, /action="\/bygg\/cancel/);
  assert.match(own, /<details class="cancel-confirm">/);
  assert.match(own, /Ja, avbestill/);
  assert.doesNotMatch(html, /Se din tid/);
  assert.doesNotMatch(await board("B2"), /own-slot/, "other households do not get the actions");
});

test("a waiting household is mentioned once per list, not twice", async () => {
  await reset();
  await book(480);
  await post("wait", { machine_id: 1, date: tomorrow, start: 480 }, "B2");
  const html = await board("A3");
  const mentions = html.match(/venter på denne tiden/g) ?? [];
  assert.equal(mentions.length, 2, "once in the slot row, once under Dine tider");
  assert.doesNotMatch(html, /de får beskjed om kommentaren din/);
  const mine = html.match(/<details class="reservation-row".*?<\/details>/s)?.[0] ?? "";
  assert.equal((mine.match(/venter/g) ?? []).length, 1);
});
