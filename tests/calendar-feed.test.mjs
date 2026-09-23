import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { pbkdf2Sync, randomBytes } from "node:crypto";

// Calendar subscription: the secret per-apartment .ics feed and its popover controls.
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
  await db.batch([db.prepare("DELETE FROM bookings"), db.prepare("DELETE FROM waitlist"), db.prepare("DELETE FROM calendar_feeds")]);
};
const wait = (apartment, machine, start) =>
  db
    .prepare("INSERT INTO waitlist (tenant_id, machine_id, date, start_min, apartment) VALUES (1, ?, ?, ?, ?)")
    .bind(machine, tomorrow, start, apartment)
    .run();
const flash = (response) => new URL(response.headers.get("location"), "http://localhost").searchParams.get("m");
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-calendar-tests-"));
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

// Cookie from a resident login, sent with every board load once the password is on.
let access = "";
const boardFor = (apartment) =>
  mf.dispatchFetch(`http://localhost/demo?date=${tomorrow}&mode=pair-1-2`, {
    headers: { Cookie: [apartment && `vk_apt=${apartment}`, access].filter(Boolean).join("; ") },
  });
/** Sets (or with no argument removes) the resident password the way the app stores it, and logs in. */
const residentPassword = async (password) => {
  const salt = randomBytes(16);
  const hash = password && `pbkdf2$1$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 1, 32, "sha256").toString("base64url")}`;
  await db.prepare("UPDATE tenants SET access_password_hash = ?").bind(hash ?? null).run();
  access = "";
  if (!password) return;
  const login = await mf.dispatchFetch("http://localhost/demo/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost" },
    body: new URLSearchParams({ password }),
    redirect: "manual",
  });
  access = login.headers.get("set-cookie").split(";")[0];
};
const feedUrl = async (apartment = "A3") => {
  const html = await (await boardFor(apartment)).text();
  return /id="calendar-url" readonly="" value="([^"]+)"/.exec(html)?.[1];
};
const fetchFeed = (url, headers = {}) => mf.dispatchFetch(url, { headers });
/** Unfolds RFC 5545 continuation lines and splits the feed into VEVENT property maps. */
const events = (ics) =>
  ics
    .replace(/\r\n /g, "")
    .split("BEGIN:VEVENT\r\n")
    .slice(1)
    .map((block) => Object.fromEntries(block.split("\r\n").map((line) => [line.split(":")[0], line.slice(line.indexOf(":") + 1)])));

test("the apartment feed lists own bookings with machines, comment, waiting count and a link", async () => {
  await reset();
  await book(480, "A3");
  const ids = (await active()).results.map((b) => b.id).join(",");
  await post("note", { booking_ids: ids, note: "Ferdig før 10, lover; tøy\\sokker" });
  await wait("B2", 1, 480);
  await wait("B2", 2, 480);
  await wait("C1", 2, 480);
  await book(600, "D4", "1");

  const url = await feedUrl();
  assert.match(url, /^http:\/\/localhost\/demo\/cal\/[\w-]{40,}\.ics$/);
  const res = await fetchFeed(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.match(res.headers.get("cache-control"), /max-age=900/);
  const ics = await res.text();
  assert.match(ics, /\r\n /, "long lines are folded");
  assert.ok(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75));
  assert.match(ics, /\r\nREFRESH-INTERVAL;VALUE=DURATION:PT15M\r\n/);
  assert.match(ics, /\r\nX-PUBLISHED-TTL:PT15M\r\n/);
  assert.match(ics, /\r\nX-WR-TIMEZONE:Europe\/Oslo\r\n/);

  const [own, ...rest] = events(ics);
  assert.equal(rest.length, 0, "other apartments stay out by default");
  assert.equal(own.SUMMARY, "Vask & tørk");
  assert.equal(own.TRANSP, "OPAQUE");
  assert.equal(own.URL, `http://localhost/demo?date=${tomorrow}`);
  const oslo = (min) => new Date(`${tomorrow}T0${min / 60}:00:00+02:00`).getTime();
  const utc = (v) => Date.parse(v.replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, "$1-$2-$3T$4:$5:$6Z"));
  // Oslo is UTC+1 or +2; the booking is 08:00–10:00 local either way.
  assert.ok([0, 3600000].includes(utc(own.DTSTART) - oslo(480)), own.DTSTART);
  assert.equal(utc(own.DTEND) - utc(own.DTSTART), 2 * 3600000);
  assert.equal(
    own.DESCRIPTION,
    `Vaskemaskin + Tørketrommel\\nKommentar: Ferdig før 10\\, lover\\; tøy\\\\sokker\\n2 naboer venter på denne tiden.\\nSe dagen: http://localhost/demo?date=${tomorrow}`,
  );
});

test("including others marks their bookings free, and the toggle updates the same link", async () => {
  await reset();
  await book(480, "A3");
  await book(600, "D4", "1");
  const ids = (await active()).results.filter((b) => b.apartment === "D4").map((b) => b.id).join(",");
  await post("note", { booking_ids: ids, note: "Henter tøyet kl. 12" }, "D4");
  const url = await feedUrl();

  const on = await post("calendar/others", { include_others: "1" });
  assert.equal(flash(on), "cal-others-on");
  assert.equal(await feedUrl(), url, "the link stays the same");
  const opened = await (await boardFor("A3")).text();
  assert.match(opened, /<details class="apartment-menu">/, "flash-less views keep the popover closed");
  const redirected = await mf.dispatchFetch(`http://localhost${on.headers.get("location")}`, { headers: { Cookie: "vk_apt=A3" } });
  const withFlash = await redirected.text();
  assert.match(withFlash, /<details class="apartment-menu" open="">/);
  assert.match(withFlash, /role="switch" aria-checked="true"/);

  const [own, other] = events(await (await fetchFeed(url)).text());
  assert.equal(own.TRANSP, "OPAQUE");
  assert.equal(other.SUMMARY, "Opptatt: Vask (Leil. D4)");
  assert.equal(other.TRANSP, "TRANSPARENT");
  assert.match(other.DESCRIPTION, /^Leil\. D4 · Vaskemaskin\\nKommentar: Henter tøyet kl\. 12\\n/);
  assert.notEqual(own.UID, other.UID);

  assert.equal(flash(await post("calendar/others", { include_others: "0" })), "cal-others-off");
  assert.equal(events(await (await fetchFeed(url)).text()).length, 1);
});

test("unknown and replaced links are 404; a new link keeps the setting", async () => {
  await reset();
  assert.equal((await fetchFeed("http://localhost/demo/cal/not-a-real-token-at-all-xyz.ics")).status, 404);
  assert.equal((await fetchFeed("http://localhost/demo/cal/.ics")).status, 404);
  const old = await feedUrl();
  assert.equal((await fetchFeed(old)).status, 200);
  // A token only opens its own building's feed.
  await db.prepare("INSERT INTO tenants (id,slug,name,admin_password_hash) VALUES (2,'other','Annen','unused')").run();
  try {
    assert.equal((await fetchFeed(old.replace("/demo/", "/other/"))).status, 404);
  } finally {
    await db.prepare("DELETE FROM tenants WHERE id = 2").run();
  }

  await post("calendar/others", { include_others: "1" });
  assert.equal(flash(await post("calendar/new-link", {})), "cal-new-link");
  const fresh = await feedUrl();
  assert.notEqual(fresh, old);
  assert.equal((await fetchFeed(old)).status, 404);
  assert.equal((await fetchFeed(fresh)).status, 200);
  assert.match(await (await boardFor("A3")).text(), /role="switch" aria-checked="true"/);
  await post("calendar/others", { include_others: "0" });
});

test("the feed answers If-None-Match with 304 until its bookings change", async () => {
  await reset();
  const url = await feedUrl();
  const first = await fetchFeed(url);
  const etag = first.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  const again = await fetchFeed(url, { "If-None-Match": etag });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), etag);
  await book(480, "A3");
  const changed = await fetchFeed(url, { "If-None-Match": etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
});

test("the feed works without the resident password; managing it does not", async () => {
  await reset();
  await book(480, "A3");
  await residentPassword("1234-dør");
  try {
    const url = await feedUrl();
    access = "";
    assert.equal((await boardFor("A3")).status, 302);
    const res = await fetchFeed(url);
    assert.equal(res.status, 200);
    assert.equal(events(await res.text()).length, 1);
    assert.equal((await post("calendar/others", { include_others: "1" })).status, 401);
    assert.equal((await post("calendar/new-link", {})).status, 401);
    assert.equal((await fetchFeed(url)).status, 200, "the link was not replaced");
  } finally {
    await residentPassword();
  }
});

test("setting, changing or removing the resident password retires every link", async () => {
  await reset();
  await post("calendar/others", { include_others: "1" });
  const before = [await feedUrl("A3"), await feedUrl("D4")];
  try {
    await residentPassword("1234-dør");
    for (const url of before) assert.equal((await fetchFeed(url)).status, 404);
    const first = await feedUrl();
    assert.ok(first && !before.includes(first), "the popover shows a new link");
    assert.equal(await feedUrl(), first, "the new link is stable across page loads");
    assert.equal((await fetchFeed(first)).status, 200);
    assert.match(await (await boardFor("A3")).text(), /role="switch" aria-checked="true"/, "the setting survives");

    await residentPassword("1234-dør"); // saved again, even unchanged
    assert.equal((await fetchFeed(first)).status, 404);
    const second = await feedUrl();
    assert.equal((await fetchFeed(second)).status, 200);

    await residentPassword();
    assert.equal((await fetchFeed(second)).status, 404);
    const third = await feedUrl();
    assert.ok(![...before, first, second].includes(third));
    assert.equal((await fetchFeed(third)).status, 200);
  } finally {
    await residentPassword();
  }
});
