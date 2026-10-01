import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Waitlist sheet and inline cancel confirm on the resident board.
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

const board = async (apt = "B2") =>
  (await mf.dispatchFetch(`http://localhost/bygg?date=${tomorrow}&mode=pair-1-2`, { headers: { Cookie: `vk_apt=${apt}` } })).text();
const waits = () =>
  sqlite
    .prepare("SELECT machine_id, apartment FROM waitlist ORDER BY machine_id")
    .all()
    .map((r) => ({ ...r }));

test("a taken slot offers one named waitlist action, not two identical links", async () => {
  await reset();
  await book(600);
  const html = await board();
  assert.doesNotMatch(html, /Se detaljer/);
  assert.match(html, /<summary>\s*Venteliste/);
  assert.equal((html.match(/Si fra når den blir ledig/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Sett meg på venteliste/);
  assert.match(html, /Ventelisten reserverer ikke automatisk/);
});

test("/wait joins several machines in one request and /unwait leaves them", async () => {
  await reset();
  await book(600);
  assert.equal(flash(await post("wait", { date: tomorrow, start: 600, machine_ids: "1,2" }, "B2")), "waiting");
  assert.deepEqual(waits(), [
    { machine_id: 1, apartment: "B2" },
    { machine_id: 2, apartment: "B2" },
  ]);
  assert.match(await board(), /Forlat ventelisten/);
  // Joining again is harmless, and the old single-machine form still works.
  assert.equal(flash(await post("wait", { date: tomorrow, start: 600, machine_id: "1" }, "B2")), "waiting");
  assert.equal(waits().length, 2);
  assert.equal(flash(await post("unwait", { date: tomorrow, start: 600, machine_ids: "1,2" }, "B2")), "unwaited");
  assert.equal(waits().length, 0);
  assert.equal(flash(await post("wait", { date: tomorrow, start: 600, machine_id: "2" }, "B2")), "waiting");
  assert.deepEqual(waits(), [{ machine_id: 2, apartment: "B2" }]);
});

test("/wait with a bad machine joins nothing", async () => {
  await reset();
  await book(600);
  assert.equal(flash(await post("wait", { date: tomorrow, start: 600, machine_ids: "1,999" }, "B2")), "invalid");
  assert.equal(flash(await post("wait", { date: tomorrow, start: 600 }, "B2")), "invalid");
  assert.equal(waits().length, 0);
});

test("På venteliste groups a pair of machines into one entry", async () => {
  await reset();
  await book(600);
  await post("wait", { date: tomorrow, start: 600, machine_ids: "1,2" }, "B2");
  const html = await board();
  const section = html.match(/<section class="waitlist-section">.*?<\/section>/s)?.[0] ?? "";
  assert.equal((section.match(/class="wait-entry"/g) ?? []).length, 1);
  assert.match(section, /Vaskemaskin \+ Tørketrommel/);
});

test("cancel is an inline two-step confirm that names the consequence and the waiting neighbours", async () => {
  await reset();
  await book(600);
  let html = await board("A3");
  assert.doesNotMatch(html, /data-confirm="Avbestille/);
  assert.match(html, /<details class="cancel-confirm">/);
  assert.match(html, /Sikker\? Tiden blir ledig\./);
  assert.match(html, /Ja, avbestill/);
  await post("wait", { date: tomorrow, start: 600, machine_ids: "1,2" }, "B2");
  await post("wait", { date: tomorrow, start: 600, machine_ids: "1" }, "C1");
  html = await board("A3");
  assert.match(html, /Tiden blir ledig og 2 naboer på ventelisten får beskjed\./);
});
