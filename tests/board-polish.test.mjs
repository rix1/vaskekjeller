import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Board polish: partly free rows, day-strip status, and the first-booking hint cookie.
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

const tomorrowBoard = async (cookie = "vk_apt=A3", mode = "pair-1-2") =>
  (await mf.dispatchFetch(`http://localhost/bygg?date=${tomorrow}&mode=${mode}`, { headers: { Cookie: cookie } })).text();
const dayItem = (html) => html.match(new RegExp(`<a [^>]*data-date="${tomorrow}"[^>]*>.*?</a>`))?.[0] ?? "";
const bookAllSlots = async (machines) => {
  for (const start of [480, 600, 720, 840, 960, 1080])
    for (const machine of machines)
      await db
        .prepare("INSERT INTO bookings (tenant_id,machine_id,date,start_min,end_min,apartment) VALUES (1,?,?,?,?,?)")
        .bind(machine, tomorrow, start, start + 120, "D4")
        .run();
};

test("a partly free pair shows who holds each machine and books the free one after confirmation", async () => {
  await reset();
  assert.equal(flash(await book(480, "D4", "1")), "booked");
  const html = await tomorrowBoard();
  assert.match(html, /Delvis ledig/);
  assert.match(html, /Vask: Leil. D4/);
  assert.match(html, /Tørk: ledig/);
  assert.match(html, /Kun tørketrommelen er ledig. Vil du reservere den\?/);
  const confirm = html.match(/<details class="slot-details slot-confirm">.*?<\/details>/)?.[0] ?? "";
  assert.match(confirm, /name="mode" value="2"/);
  assert.match(confirm, /name="start" value="480"/);
  const response = await book(480, "A3", "2");
  assert.equal(flash(response), "booked");
  assert.match(response.headers.get("location"), /mode=pair-1-2/);
  assert.deepEqual(
    (await active()).results.map((b) => [b.machine_id, b.apartment]),
    [
      [1, "D4"],
      [2, "A3"],
    ],
  );
  assert.match(await tomorrowBoard(), /Reservert/);
});

test("day strip says Delvis when every slot is partly taken and Fullt only when fully booked", async () => {
  await reset();
  await bookAllSlots([1]);
  let html = await tomorrowBoard();
  let day = dayItem(html);
  assert.match(day, /class="date-item[^"]*\bpartial\b/);
  assert.match(day, /<small>Delvis<\/small>/);
  assert.match(day, /aria-label="[^"]*delvis ledig, 6 tider med én maskin ledig"/);
  assert.match(html, /Ingen tider med alle maskinene ledige denne dagen\./);
  html = await tomorrowBoard("vk_apt=A3", "1");
  day = dayItem(html);
  assert.match(day, /class="date-item[^"]*\bfull\b/);
  assert.match(day, /<small>Fullt<\/small>/);
  assert.match(html, /Ingen ledige tider igjen denne dagen\./);
  await bookAllSlots([2]);
  html = await tomorrowBoard();
  day = dayItem(html);
  assert.match(day, /class="date-item[^"]*\bfull\b/);
  assert.match(day, /aria-label="[^"]*, fullt"/);
  assert.match(html, /Ingen ledige tider igjen denne dagen\./);
  await reset();
  day = dayItem(await tomorrowBoard());
  assert.doesNotMatch(day, /\b(full|partial)\b/);
  assert.match(day, /<small>6 ledige<\/small>/);
});

test("the first successful booking sets a device cookie that hides the booking hint", async () => {
  await reset();
  assert.match(await tomorrowBoard(), /Ett trykk reserverer/);
  assert.equal(flash(await book(480, "D4")), "booked");
  const taken = await book(480);
  assert.equal(flash(taken), "taken");
  assert.equal(taken.headers.get("set-cookie"), null);
  const response = await book(600);
  assert.equal(flash(response), "booked");
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^vk_booked=1;/);
  assert.match(cookie, /Path=\/bygg/);
  assert.match(cookie, /Max-Age=34560000/);
  assert.doesNotMatch(await tomorrowBoard("vk_apt=A3; vk_booked=1"), /Ett trykk reserverer/);
});

test("past days never render the booking hint, even before the first booking", async () => {
  await reset();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 3);
  const past = d.toISOString().slice(0, 10);
  const html = await (await mf.dispatchFetch(`http://localhost/bygg?date=${past}`, { headers: { Cookie: "vk_apt=A3" } })).text();
  assert.match(html, new RegExp(`data-date="${past}"[^>]*aria-current="date"`));
  assert.doesNotMatch(html, /Ett trykk reserverer/);
  assert.match(
    await (await mf.dispatchFetch(`http://localhost/bygg`, { headers: { Cookie: "vk_apt=A3" } })).text(),
    /Ett trykk reserverer/,
  );
});
