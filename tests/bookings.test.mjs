import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

let mf, db, temp, sqlite;
// Exercise the real Hono handlers and SQL with an isolated SQLite database.
// D1 batch transactions are mirrored here; browser tests cover the Workers runtime.
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
      return {
        results: sqlite.prepare(sql).all(...bindings),
        success: true,
        meta: {},
      };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...bindings);
      return {
        results: [],
        success: true,
        meta: { changes: Number(result.changes) },
      };
    },
    execute() {
      const stmt = sqlite.prepare(sql);
      if (stmt.columns().length) return { results: stmt.all(...bindings), success: true, meta: {} };
      const result = stmt.run(...bindings);
      return {
        results: [],
        success: true,
        meta: { changes: Number(result.changes) },
      };
    },
  };
}
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const post = (path, body, apartment = "A3") =>
  mf.dispatchFetch(`http://localhost/demo/${path}?date=${tomorrow}&mode=pair-1-2`, {
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
  await db.batch([
    db.prepare("DELETE FROM bookings"),
    db.prepare("DELETE FROM waitlist"),
    db.prepare("UPDATE tenants SET max_active_bookings = 0"),
  ]);
};
const flash = (response) => new URL(response.headers.get("location"), "http://localhost").searchParams.get("m");
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-tests-"));
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
  const bindings = {
    DB: db,
    SESSION_SECRET: "isolated-test-only",
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
    VAPID_SUBJECT: "",
  };
  mf = {
    dispatchFetch: (url, init) =>
      worker.fetch(new Request(url, init), bindings, {
        waitUntil: (promise) => promise.catch(() => {}),
      }),
  };
  const schema = await readFile("migrations/0001_init.sql", "utf8");
  sqlite.exec(schema);
  await db.prepare(await readFile("migrations/0002_booking_overlap.sql", "utf8")).run();
  await db.prepare("INSERT INTO tenants (id,slug,name,admin_password_hash) VALUES (1,'demo','Test','unused')").run();
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

test("one action books both machines; preserves selected day and comments after booking", async () => {
  await reset();
  const response = await book(480);
  assert.equal(flash(response), "booked");
  assert.match(response.headers.get("location"), new RegExp(`date=${tomorrow}`));
  const rows = (await active()).results;
  assert.deepEqual(
    rows.map((b) => b.machine_id),
    [1, 2],
  );
  const ids = rows.map((b) => b.id).join(",");
  assert.equal(flash(await post("note", { booking_ids: ids, note: "Ferdig før 10" })), "note");
  assert.ok((await active()).results.every((b) => b.note === "Ferdig før 10"));
  assert.equal(flash(await post("cancel", { booking_ids: ids })), "cancelled");
  assert.equal((await active()).results.length, 0);
});

test("occupied dryer rolls back washer reservation too", async () => {
  await reset();
  assert.equal(flash(await book(480, "D4", "2")), "booked");
  assert.equal(flash(await book(480)), "taken");
  assert.equal((await active()).results.length, 1);
});

test("competing households cannot partially reserve the same pair", async () => {
  await reset();
  const responses = await Promise.all([book(600, "A3"), book(600, "B2")]);
  assert.deepEqual(responses.map(flash).sort(), ["booked", "taken"]);
  const rows = (await active()).results;
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.apartment)).size, 1);
});

test("a pair counts as one time; concurrent requests enforce the household limit", async () => {
  await reset();
  await db.prepare("UPDATE tenants SET max_active_bookings = 1").run();
  const responses = await Promise.all([book(720), book(840)]);
  assert.deepEqual(responses.map(flash).sort(), ["booked", "limit"]);
  assert.equal((await active()).results.length, 2);
});

test("can add the other machine to an existing time at the household limit", async () => {
  await reset();
  await db.prepare("UPDATE tenants SET max_active_bookings = 1").run();
  assert.equal(flash(await book(480, "A3", "1")), "booked");
  assert.equal(flash(await book(480, "A3", "2")), "booked");
  assert.equal((await active()).results.length, 2);
});

test("cannot cancel or edit another household’s reservations, including mixed IDs", async () => {
  await reset();
  await book(480, "D4");
  await book(600, "A3");
  const ids = (await active()).results.map((b) => b.id).join(",");
  assert.equal(flash(await post("cancel", { booking_ids: ids })), "invalid");
  assert.equal(flash(await post("note", { booking_ids: ids, note: "bad" })), "invalid");
  assert.equal((await active()).results.length, 4);
});

test("schedule changes cannot overlap a prior reservation", async () => {
  await reset();
  await db
    .prepare("INSERT INTO bookings (tenant_id,machine_id,date,start_min,end_min,apartment) VALUES (1,2,?,540,660,?)")
    .bind(tomorrow, "D4")
    .run();
  assert.equal(flash(await book(480)), "taken");
  assert.equal((await active()).results.length, 1);
});

test("invalid dates, modes, tenant machines, and past slots are rejected", async () => {
  await reset();
  assert.equal(flash(await book(480, "A3", "pair-1-999")), "invalid");
  assert.equal(flash(await post("book", { date: "2000-01-01", start: 480, mode: "pair-1-2" })), "invalid");
  assert.equal(flash(await book(481)), "invalid");
  assert.equal(flash(await post("book", { date: "2026-09-31", start: 480, mode: "pair-1-2" })), "invalid");
  assert.equal((await active()).results.length, 0);
});

const board = (query = "", apartment) =>
  mf.dispatchFetch(`http://localhost/demo?date=${tomorrow}&mode=pair-1-2${query}`, {
    headers: apartment ? { Cookie: `vk_apt=${apartment}` } : {},
  });

test("saving an apartment validates it, sets the cookie and keeps the view", async () => {
  await db.prepare("UPDATE tenants SET apartments = 'A3\nB2'").run();
  try {
    const bad = await post("apartment", { apartment: "Z9" });
    assert.notEqual(flash(bad), "apartment");
    assert.doesNotMatch(bad.headers.get("set-cookie") ?? "", /vk_apt=Z9/);
    const ok = await post("apartment", { apartment: "b2" });
    assert.equal(flash(ok), "apartment");
    assert.match(ok.headers.get("set-cookie"), /vk_apt=B2/);
    assert.match(ok.headers.get("location"), new RegExp(`date=${tomorrow}.*mode=pair-1-2`));
  } finally {
    await db.prepare("UPDATE tenants SET apartments = NULL").run();
  }
});

test("first visit shows the inline welcome; a saved apartment gets the chip popover", async () => {
  const first = await (await board()).text();
  assert.match(first, /Hei, nabo\./);
  assert.doesNotMatch(first, /apartment-menu/);

  const saved = await (await board("", "A3")).text();
  assert.doesNotMatch(saved, /Hei, nabo\./);
  assert.match(saved, /<details class="apartment-menu">/);
  assert.match(saved, /class="apartment-popover"[\s\S]*action="\/demo\/apartment\?date=/);

  const fallback = await (await board("&bytt=1", "A3")).text();
  assert.match(fallback, /<details class="apartment-menu" open/);
  assert.doesNotMatch(fallback, /Hei, nabo\./);
});
