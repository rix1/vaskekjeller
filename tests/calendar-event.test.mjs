import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { pbkdf2Sync, randomBytes } from "node:crypto";

// Add to calendar: the single-event .ics download for one reservation.
// Same harness as bookings.test.mjs: the real Hono routes against an isolated SQLite database.
let mf, db, temp, sqlite;
const ADMIN_PASSWORD = "admin-test-password";
const pbkdf2Hash = (password) => {
  const salt = randomBytes(16);
  return `pbkdf2$1$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 1, 32, "sha256").toString("base64url")}`;
};
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
const wait = (apartment, machine, start) =>
  db
    .prepare("INSERT INTO waitlist (tenant_id, machine_id, date, start_min, apartment) VALUES (1, ?, ?, ?, ?)")
    .bind(machine, tomorrow, start, apartment)
    .run();
const flash = (response) => new URL(response.headers.get("location"), "http://localhost").searchParams.get("m");
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-calendar-event-tests-"));
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
  sqlite.exec(await readFile("migrations/0003_resident_password_readable.sql", "utf8"));
  sqlite.exec(await readFile("migrations/0006_audit_log_and_closing.sql", "utf8"));
  await db.prepare("INSERT INTO tenants (id,slug,name,admin_password_hash) VALUES (1,'bygg','Test',?)").bind(pbkdf2Hash(ADMIN_PASSWORD)).run();
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

const boardFor = (apartment, query = "") =>
  mf.dispatchFetch(`http://localhost/bygg?date=${tomorrow}&mode=pair-1-2${query}`, {
    headers: { Cookie: apartment ? `vk_apt=${apartment}` : "" },
  });
const download = (ids, apartment = "A3") =>
  mf.dispatchFetch(`http://localhost/bygg/event.ics?booking_ids=${ids}`, { headers: { Cookie: apartment ? `vk_apt=${apartment}` : "" } });
const rows = async () => (await active()).results;
const ids = async () => (await rows()).map((b) => b.id).join(",");
/** Unfolds RFC 5545 continuation lines into property -> value. */
const props = (ics) =>
  Object.fromEntries(
    ics
      .replace(/\r\n /g, "")
      .split("\r\n")
      .filter(Boolean)
      .map((line) => [line.split(":")[0], line.slice(line.indexOf(":") + 1)]),
  );

test("a reservation downloads as one event with machines, comment and a link to the day", async () => {
  await reset();
  await book(480, "A3");
  await post("note", { booking_ids: await ids(), note: "Ferdig før 10, lover; tøy" });
  const res = await download(await ids());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.match(res.headers.get("content-disposition"), /^attachment; filename="vaskekjeller\.ics"$/);
  const ics = await res.text();
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 1, "both machines are one event");
  assert.ok(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75), "long lines are folded");
  assert.doesNotMatch(ics, /REFRESH-INTERVAL|X-PUBLISHED-TTL/, "not a subscription");
  const ev = props(ics);
  assert.equal(ev.SUMMARY, "Vask & tørk · Test");
  assert.match(ev.DTSTART, /^\d{8}T\d{6}Z$/);
  assert.equal(Date.parse(ev.DTEND.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z")) - Date.parse(ev.DTSTART.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z")) > 0, true);
  assert.match(ev.DESCRIPTION, /Vaskemaskin \+ Tørketrommel/);
  assert.match(ev.DESCRIPTION, /Kommentar: Ferdig før 10\\, lover\\; tøy/);
  assert.match(ev.DESCRIPTION, new RegExp(`Se dagen: http://localhost/bygg\\?date=${tomorrow}`));
  assert.equal(ev.URL, `http://localhost/bygg?date=${tomorrow}`);
  assert.equal(ev.TRANSP, "OPAQUE");
  assert.match(ev.UID, /@bygg\.vaskekjeller$/);
});

test("only the apartment's own bookings can be downloaded", async () => {
  await reset();
  await book(480, "A3");
  await book(600, "D4", "1");
  assert.equal((await download((await ids()), "B2")).status, 404, "another apartment");
  assert.equal((await download((await ids()), "")).status, 404, "no apartment chosen");
  assert.equal((await download("999")).status, 404, "unknown booking");
  assert.equal((await download("abc")).status, 404);
  assert.equal((await download("")).status, 404);
  const all = await rows();
  const mine = all[0];
  const theirs = all.at(-1);
  assert.equal((await download(`${mine.id},${theirs.id}`)).status, 404, "mixed apartments");
  await post("cancel", { booking_ids: mine.id.toString() });
  assert.equal((await download(mine.id)).status, 404, "cancelled");
});

test("the booking page offers the download after booking and on each reservation, and no feed", async () => {
  await reset();
  const res = await book(480, "A3");
  const location = new URL(res.headers.get("location"), "http://localhost");
  assert.equal(location.searchParams.get("m"), "booked");
  const html = await (await boardFor("A3", `&m=booked&reservation=${(await ids())}`)).text();
  const expectedIds = await ids();
  const links = [...html.matchAll(/href="\/bygg\/event\.ics\?booking_ids=([\d,]+)"/g)].map((m) => m[1]);
  assert.equal(links.length, 2, "below the schedule and on the reservation card");
  assert.ok(links.every((l) => l === expectedIds));
  assert.match(html, /class="booked-calendar"/);
  const later = await (await boardFor("A3")).text();
  assert.equal([...later.matchAll(/event\.ics/g)].length, 1, "only the card once the confirmation is gone");
  assert.doesNotMatch(html, /webcal:|calendar-url|Inkluder andres|Lag ny lenke/);
  assert.equal((await mf.dispatchFetch("http://localhost/bygg/cal/abc.ics")).status, 404, "the feed route is gone");
});
