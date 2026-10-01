import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// First-use tips: the server-rendered anchors, the header menu rows and the notification ask (client/tour.ts reads them).
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


const page = async (cookie = "vk_apt=A3", query = `date=${tomorrow}&mode=pair-1-2`) =>
  (await mf.dispatchFetch(`http://localhost/bygg?${query}`, { headers: { Cookie: cookie } })).text();
// Failed assertions print the whole page with assert.match; keep the output readable.
const has = (html, pattern, message) => assert.ok(pattern.test(html), message ?? `expected ${pattern}`);
const lacks = (html, pattern, message) => assert.ok(!pattern.test(html), message ?? `unexpected ${pattern}`);

test("a resident without bookings gets anchors for the booking and machine tips, and the tips script", async () => {
  await reset();
  const html = await page();
  has(html, /<main class="resident-main" data-tips="new"/);
  has(html, /<script type="module" src="\/tour\.js" defer/);
  // Exactly one booking anchor: the first free slot's button, which says how many machines come along.
  assert.equal(html.match(/data-tour="book"/g)?.length, 1);
  has(html, /<button class="reserve-button"[^>]*data-tour="book" data-tour-machines="2"/);
  has(html, /<nav class="machine-options"[^>]*data-tour="machines"/);
  lacks(html, /data-tour="manage/, "no booking, nothing to manage yet");
  lacks(html, /id="push-ask"/, "the notification ask waits for a booking");
  lacks(html, /id="home-nudge"|Ett trykk reserverer/, "the old card and footnote are gone");
});

test("the booking tip anchors the first free slot, not an earlier taken one, and never a past day", async () => {
  await reset();
  await book(480, "D4");
  const html = await page();
  const anchored = html.match(/name="start" value="(\d+)"\/><button class="reserve-button"[^>]*data-tour="book"/)?.[1];
  assert.equal(anchored, "600", "the 08:00 slot is taken, so the tip moves to 10:00");
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  lacks(await page("vk_apt=A3", `date=${past}`), /data-tour="(book|manage)"/);
});

test("a device that has booked is marked, and its own booking is the anchor for the manage tip", async () => {
  await reset();
  assert.equal(flash(await book(480)), "booked");
  const html = await page("vk_apt=A3; vk_booked=1");
  has(html, /<main class="resident-main" data-tips="booked"/);
  has(html, /<article class="time-slot reserved own" data-tour="manage"/, "the own row in the schedule");
  has(html, /<details class="reservation-row" id="reservation-\d+"[^>]*data-tour="manage-card"/, "the first row under Dine tider");
  has(html, /<a class="mobile-mine-link" href="#mine" data-tour="manage-bar"/);
  lacks(html, /data-tour="book"[^>]*>[^]*data-tour="book"/);
});

test("the notification ask sits under the reservations once there is one, hidden until the page script checks the device", async () => {
  await reset();
  await book(480);
  const html = await page();
  const ask = html.match(/<div class="push-ask" id="push-ask" hidden="">.*?<\/div>/s)?.[0] ?? "";
  assert.ok(ask, "the ask is rendered");
  assert.ok(html.indexOf('id="push-ask"') > html.indexOf('id="reservation-'), "under the reservation cards");
  has(ask, /data-push-state="ready"[^>]*data-push-action="on"/, "a turn-on button for devices that can");
  has(ask, /data-push-state="needs-install"[^>]*href="\/bygg\/velkommen"/, "a way to the guide on iPhone Safari");
  has(ask, /data-tour-action="dismiss-ask"/);
  has(ask, /venter på tiden din/);
  lacks(ask, /påminnelse/i, "no reminder promise until reminders ship");
});

test("the header menu has permanent Varsler and Tips rows", async () => {
  await reset();
  const html = await page();
  const menu = html.match(/<div class="apartment-popover">.*?<\/details>/s)?.[0] ?? "";
  has(menu, /<section id="push-menu" hidden="">/);
  has(menu, /data-push-state="ready" data-push-action="on"/);
  has(menu, /data-push-state="on" data-push-action="off"/);
  has(menu, /data-push-state="needs-install" href="\/bygg\/velkommen"/);
  has(menu, /<section id="tips-menu" hidden="">/);
  has(menu, /data-tour-action="reopen"/);
});

test("there are no tips before an apartment is chosen, and none on read-only boards", async () => {
  await reset();
  const noApartment = await page("");
  lacks(noApartment, /data-tips|data-tour|id="push-menu"/);
  has(noApartment, /src="\/tour\.js"/, "loaded early: choosing an apartment updates the page in place");
  sqlite.exec("ALTER TABLE tenants ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0");
  sqlite.exec("UPDATE tenants SET read_only = 1 WHERE id = 1");
  lacks(await page(), /data-tips|data-tour|tour\.js|id="push-ask"/);
  sqlite.exec("UPDATE tenants SET read_only = 0 WHERE id = 1");
});

test("tour.ts is compiled with the other page scripts and about storage mentions the tips key", async () => {
  const config = JSON.parse(await readFile("client/tsconfig.json", "utf8"));
  assert.ok(config.files.includes("tour.ts"));
  const about = await (await mf.dispatchFetch("http://localhost/om")).text();
  has(about, /Hvilke tips du har sett/);
});
