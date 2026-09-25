import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// The admin activity log and closing/deleting a building, against the real Hono handlers and an
// isolated SQLite database, in the same style as admin.test.mjs.
let worker, crypto, audit, db, temp, sqlite;
const SECRET = "isolated-test-only";
const ADMIN_PASSWORD = "correct horse";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IP = "203.0.113.77";

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

const env = () => ({ DB: db, SESSION_SECRET: SECRET, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" });
const fetchApp = (path, init = {}) =>
  worker.fetch(new Request(`http://localhost/bygg${path ? `/${path}` : ""}`, { redirect: "manual", ...init }), env(), {
    waitUntil: (promise) => promise.catch(() => {}),
  });
const headers = (cookie, extra = {}) => ({ Cookie: cookie ?? "", "User-Agent": IPHONE_UA, "CF-Connecting-IP": IP, ...extra });
const cookieFrom = (response, name) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`));
const post = (path, body, cookie) =>
  fetchApp(path, {
    method: "POST",
    headers: headers(cookie, { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost" }),
    body: new URLSearchParams(body),
  });
const get = (path, cookie) => fetchApp(path, { headers: headers(cookie) });
const tenant = () => sqlite.prepare("SELECT * FROM tenants WHERE id = 1").get();
const log = () =>
  sqlite
    .prepare("SELECT action, detail, device FROM audit_log WHERE tenant_id = 1 ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
const details = () => log().map((e) => e.detail);
const location = (response) => new URL(response.headers.get("location"), "http://localhost");
const sqlTime = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19).replace("T", " ");
const DAY = 86_400_000;
const runCron = () => worker.scheduled({}, env(), { waitUntil() {} });

async function login(password = ADMIN_PASSWORD) {
  return cookieFrom(await post("admin/login", { password }), "vk_admin");
}

let admin;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-audit-tests-"));
  await build({
    entryPoints: { worker: "src/index.tsx", crypto: "src/crypto.ts", audit: "src/audit.ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    outdir: temp,
    outExtension: { ".js": ".mjs" },
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  });
  worker = (await import(pathToFileURL(join(temp, "worker.mjs")).href)).default;
  crypto = await import(pathToFileURL(join(temp, "crypto.mjs")).href);
  audit = await import(pathToFileURL(join(temp, "audit.mjs")).href);
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
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
  for (const file of (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(await readFile(join("migrations", file), "utf8"));
  }
});

beforeEach(async () => {
  sqlite.exec("DELETE FROM tenants; DELETE FROM visitor_hashes;");
  const hash = await crypto.hashPassword(ADMIN_PASSWORD);
  sqlite
    .prepare("INSERT INTO tenants (id, slug, name, admin_password_hash) VALUES (1, 'bygg', 'Lofotgata 5', ?), (2, 'other', 'Nabo', ?)")
    .run(hash, hash);
  sqlite.exec(
    `INSERT INTO machines (id, tenant_id, kind, name) VALUES (1, 1, 'washer', 'Vask 1'), (2, 1, 'dryer', 'Tørk 1'), (3, 1, 'washer', 'Vask 2'),
       (4, 2, 'washer', 'Nabovask')`,
  );
  admin = await login();
});

after(async () => {
  sqlite?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

test("a settings save logs one entry per changed field, before → after, and nothing when unchanged", async () => {
  const schedule = { section: "tider", day_start: "08:00", day_end: "20:00", slot_min: "120", horizon: "14", max_active: "0" };
  await post("admin/settings", schedule, admin);
  assert.deepEqual(log(), [], "an unchanged save logs nothing");

  await post("admin/settings", { ...schedule, slot_min: "90" }, admin);
  assert.deepEqual(log(), [{ action: "settings", detail: "Lengde per tid: 120 → 90 min", device: "iPhone · Safari" }]);

  await post("admin/settings", { ...schedule, slot_min: "90", day_start: "07:00", horizon: "21", max_active: "2" }, admin);
  assert.deepEqual(details().slice(1), [
    "Første tid starter: 08:00 → 07:00",
    "Kan booke dager frem: 14 → 21",
    "Maks aktive tider per leilighet: ubegrenset → 2",
  ]);

  await post("admin/settings", { section: "generelt", name: "Lofotgata 7" }, admin);
  assert.equal(details().at(-1), "Navn: «Lofotgata 5» → «Lofotgata 7»");

  await post("admin/settings", { section: "leiligheter", apartments: "A1\nA2\nB1" }, admin);
  assert.equal(details().at(-1), "Leiligheter: la til A1, A2, B1 (3 i alt)");
  await post("admin/settings", { section: "leiligheter", apartments: "A1\nB1\nB2" }, admin);
  assert.equal(details().at(-1), "Leiligheter: la til B2; fjernet A2 (3 i alt)");
  await post("admin/settings", { section: "leiligheter", apartments: "" }, admin);
  assert.equal(details().at(-1), "Leiligheter: fjernet listen (3). Alle numre er tillatt.");
});

test("a rejected settings save logs nothing", async () => {
  const response = await post("admin/settings", { section: "generelt", name: "" }, admin);
  assert.equal(response.status, 422);
  assert.deepEqual(log(), []);
});

test("machines: added, renamed, retyped, moved, switched off and on each log one entry", async () => {
  await post("admin/machines", { name: "Tørk 2", kind: "dryer" }, admin);
  await post("admin/machines/1", { name: "Vask A", kind: "washer" }, admin);
  await post("admin/machines/3", { name: "Vask 2", kind: "dryer" }, admin);
  await post("admin/machines/3", { name: "Vask 2", kind: "dryer" }, admin); // unchanged
  await post("admin/machines/2/move", { dir: "up" }, admin);
  await post("admin/machines/1/active", { active: "0" }, admin);
  await post("admin/machines/1/active", { active: "0" }, admin); // already off
  await post("admin/machines/1/active", { active: "1" }, admin);
  assert.deepEqual(details(), [
    "La til maskin «Tørk 2» (Tørketrommel)",
    "Endret navn på maskin «Vask 1» → «Vask A»",
    "Endret type for «Vask 2»: Vaskemaskin → Tørketrommel",
    "Flyttet maskin «Tørk 1» opp",
    "Slo av maskin «Vask A»",
    "Slo på maskin «Vask A»",
  ]);
  assert.ok(log().every((e) => e.action === "machine"));
});

test("resident password on, changed and off, and the admin password change, each log one entry", async () => {
  await post("admin/access", { access_password: "dør1234" }, admin);
  await post("admin/access", { access_password: "dør5678" }, admin);
  await post("admin/access/off", {}, admin);
  await post("admin/access/off", {}, admin); // already off
  const response = await post("admin/admin-password", { admin_password: "nytt passord", admin_password_confirm: "nytt passord" }, admin);
  assert.equal(response.status, 303);
  assert.deepEqual(log(), [
    { action: "access-password", detail: "Slo på beboerpassord", device: "iPhone · Safari" },
    { action: "access-password", detail: "Endret beboerpassordet", device: "iPhone · Safari" },
    { action: "access-password", detail: "Slo av beboerpassord", device: "iPhone · Safari" },
    { action: "admin-password", detail: "Byttet adminpassordet", device: "iPhone · Safari" },
  ]);
  const text = JSON.stringify(sqlite.prepare("SELECT * FROM audit_log").all());
  assert.doesNotMatch(text, /dør1234|dør5678|nytt passord/, "passwords are never logged");
});

test("an admin cancelling a booking logs who and when; residents' own bookings are not logged", async () => {
  const date = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  sqlite.prepare("INSERT INTO bookings (id, tenant_id, machine_id, date, start_min, end_min, apartment) VALUES (7, 1, 1, ?, 600, 720, 'A3')").run(date);
  const response = await post("admin/bookings/7/cancel", {}, admin);
  assert.equal(response.status, 303);
  const weekday = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
  assert.deepEqual(log(), [{ action: "booking", detail: `Avbestilte Leil. A3, ${weekday} 10:00–12:00 (Vask 1)`, device: "iPhone · Safari" }]);

  // A resident booking and cancelling adds nothing.
  const resident = cookieFrom(await post("apartment", { apartment: "B2" }), "vk_apt");
  const booked = await post("book", { date, start: "600", mode: "1" }, resident);
  assert.equal(location(booked).searchParams.get("m"), "booked");
  const [row] = sqlite.prepare("SELECT id FROM bookings WHERE apartment = 'B2'").all();
  await post("cancel", { booking_id: String(row.id) }, resident);
  assert.ok(sqlite.prepare("SELECT cancelled_at FROM bookings WHERE id = ?").get(row.id).cancelled_at);
  assert.equal(log().length, 1);
});

test("the settings page lists the activity newest first with the device, in its own section", async () => {
  await post("admin/access", { access_password: "dør1234" }, admin);
  await post("admin/settings", { section: "generelt", name: "Nytt navn" }, admin);
  const page = await (await get("admin/settings", admin)).text();
  assert.match(page, /<a href="#aktivitet">Aktivitet<\/a>/);
  const section = page.slice(page.indexOf('id="aktivitet"'), page.indexOf('id="tilgang"'));
  assert.ok(section.indexOf("Navn: «Lofotgata 5» → «Nytt navn»") < section.indexOf("Slo på beboerpassord"), "newest first");
  assert.match(section, /I dag/);
  assert.match(section, /iPhone · Safari/);
});

test("the activity section shows every retained entry in one list, with no paging", async () => {
  const insert = sqlite.prepare("INSERT INTO audit_log (tenant_id, created_at, action, detail, device) VALUES (1, ?, 'settings', ?, 'Mac · Firefox')");
  for (let i = 0; i < 105; i++) insert.run(sqlTime(-i * 60_000), `Endring ${i}`);
  const page = await (await get("admin/settings", admin)).text();
  assert.match(page, /Endring 0</);
  assert.match(page, /Endring 104</);
  assert.doesNotMatch(page, /Vis alle/);
});

test("only a coarse device label is stored: no IP address and no raw User-Agent", async () => {
  await post("admin/settings", { section: "generelt", name: "Nytt navn" }, admin);
  await post("admin/access", { access_password: "dør1234" }, admin);
  const columns = sqlite.prepare("PRAGMA table_info(audit_log)").all().map((c) => c.name);
  assert.deepEqual(columns, ["id", "tenant_id", "created_at", "action", "detail", "device"]);
  const rows = sqlite.prepare("SELECT * FROM audit_log").all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const text = JSON.stringify(row);
    assert.ok(!text.includes(IP), "no IP address");
    assert.ok(!text.includes("Mozilla") && !text.includes("AppleWebKit") && !text.includes("18_5"), "no raw User-Agent");
    assert.equal(row.device, "iPhone · Safari");
  }
});

test("device labels are coarse", () => {
  const cases = [
    [IPHONE_UA, "iPhone · Safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1", "iPhone · Chrome"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36", "Android-mobil · Chrome"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36", "Android-mobil · Samsung Internet"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15", "Mac · Safari"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:140.0) Gecko/20100101 Firefox/140.0", "Mac · Firefox"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36 Edg/138.0", "Windows · Edge"],
    ["curl/8.7.1", "Ukjent enhet"],
    [undefined, "Ukjent enhet"],
  ];
  for (const [ua, label] of cases) assert.equal(audit.deviceLabel(ua), label, ua);
});

test("the nightly job prunes activity older than 12 months", async () => {
  const insert = sqlite.prepare("INSERT INTO audit_log (tenant_id, created_at, action, detail, device) VALUES (1, ?, 'settings', ?, 'Mac · Safari')");
  insert.run(sqlTime(-400 * DAY), "13 måneder gammel");
  insert.run(sqlTime(-370 * DAY), "litt over ett år");
  insert.run(sqlTime(-330 * DAY), "11 måneder gammel");
  insert.run(sqlTime(-DAY), "i går");
  await runCron();
  assert.deepEqual(details(), ["11 måneder gammel", "i går"]);
});

// ---------------------------------------------------------------------------
// Closing and deleting
// ---------------------------------------------------------------------------

test("the danger zone sits at the bottom of the access section and needs the building's name", async () => {
  const page = await (await get("admin/settings", admin)).text();
  const access = page.slice(page.indexOf('id="tilgang"'));
  assert.match(access, /class="danger-zone"/);
  assert.match(access, /href="#steng" data-dialog="steng"/);
  assert.match(page, /<dialog id="steng"[^>]*>[\s\S]*action="\/bygg\/admin\/close"[\s\S]*data-confirm-name="Lofotgata 5"/);
});

test("closing needs the building's name; a wrong name changes nothing", async () => {
  for (const wrong of ["", "Lofotgata", "Nabo"]) {
    const response = await post("admin/close", { confirm_name: wrong }, admin);
    assert.equal(response.status, 422, `«${wrong}»`);
    const page = await response.text();
    assert.match(page, /<dialog id="steng"[^>]*open=""/);
    assert.match(page, /Navnet stemmer ikke\. Skriv «Lofotgata 5» for å bekrefte\./);
  }
  assert.equal(tenant().closed_at, null);
  assert.deepEqual(log(), []);
  assert.equal((await get("")).status, 200);
});

test("closing takes the booking page, resident routes and feeds offline at once; admin still works", async () => {
  sqlite.prepare("UPDATE tenants SET access_password_hash = NULL WHERE id = 1").run();
  const response = await post("admin/close", { confirm_name: "  lofotgata   5 " }, admin);
  assert.equal(response.status, 303);
  assert.equal(location(response).pathname, "/bygg/admin");
  assert.equal(location(response).searchParams.get("m"), "closed");
  assert.ok(tenant().closed_at);
  assert.equal(log().length, 1);
  assert.equal(log()[0].action, "building");
  assert.match(log()[0].detail, /^Stengte vaskekjelleren\. Slettes permanent \S+ \d+\. \S+ \(etter 7 dager\)\.$/);

  const board = await get("");
  assert.equal(board.status, 410);
  assert.match(await board.text(), /Denne vaskekjelleren er stengt/);
  for (const path of ["login", "kalender.ics", "feed/abc123.ics"]) assert.equal((await get(path)).status, 410, path);
  const apt = cookieFrom(await fetchApp("apartment", { method: "POST" }), "vk_apt");
  assert.equal(apt, undefined);
  for (const path of ["apartment", "book", "cancel", "wait", "message"]) assert.equal((await post(path, { apartment: "A1" })).status, 410, path);
  assert.equal((await fetchApp("push/subscribe", { method: "POST", headers: { Origin: "http://localhost" }, body: "{}" })).status, 410);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0);

  // Other buildings are unaffected.
  const other = await worker.fetch(new Request("http://localhost/other"), env(), { waitUntil() {} });
  assert.equal(other.status, 200);

  // Admin login still works and shows the reopen / delete-now panel with the deletion date.
  const fresh = await login();
  assert.ok(fresh);
  const panel = await get("admin", fresh);
  assert.equal(panel.status, 200);
  const html = await panel.text();
  const purgeOn = audit.purgeDate(tenant().closed_at, "Europe/Oslo");
  const date = new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${purgeOn}T00:00:00Z`),
  );
  assert.ok(html.includes(`Stengt – slettes permanent ${date}`), html);
  assert.match(html, /Gjenåpne/);
  assert.match(html, /Slett permanent nå/);
  assert.doesNotMatch(html, /id="aktivitet"/, "the closed page shows no activity log");

  // Everything else on the admin page leads back to that choice and changes nothing.
  const settings = await get("admin/settings", fresh);
  assert.equal(settings.status, 303);
  assert.equal(location(settings).pathname, "/bygg/admin");
  await post("admin/settings", { section: "generelt", name: "Hacked" }, fresh);
  assert.equal(tenant().name, "Lofotgata 5");
});

test("reopening restores the booking page and is logged", async () => {
  await post("admin/close", { confirm_name: "Lofotgata 5" }, admin);
  assert.equal((await get("")).status, 410);
  const response = await post("admin/reopen", {}, admin);
  assert.equal(response.status, 303);
  assert.equal(location(response).searchParams.get("m"), "reopened");
  assert.equal(tenant().closed_at, null);
  assert.equal((await get("")).status, 200);
  assert.equal((await get("admin/settings", admin)).status, 200);
  assert.equal(details().at(-1), "Gjenåpnet vaskekjelleren");
});

/** Rows for tenant 1 in every table with a tenant_id column, including tables added later. */
function tenantRows(id = 1) {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((t) => t.name)
    .filter((name) => sqlite.prepare(`PRAGMA table_info(${name})`).all().some((c) => c.name === "tenant_id"));
  assert.ok(tables.length >= 8, `found ${tables.join(", ")}`);
  return Object.fromEntries(tables.map((name) => [name, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE tenant_id = ?`).get(id).n]));
}

function seedEverything(id) {
  const date = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  const machine = id === 1 ? 1 : 4;
  sqlite.prepare("INSERT INTO bookings (tenant_id, machine_id, date, start_min, end_min, apartment) VALUES (?, ?, ?, 600, 720, 'A1')").run(id, machine, date);
  sqlite.prepare("INSERT INTO waitlist (tenant_id, machine_id, date, start_min, apartment) VALUES (?, ?, ?, 600, 'B1')").run(id, machine, date);
  sqlite
    .prepare("INSERT INTO push_subscriptions (tenant_id, apartment, endpoint, p256dh, auth) VALUES (?, 'A1', ?, 'k', 'a')")
    .run(id, `https://push.example/${id}`);
  sqlite.prepare("INSERT INTO daily_stats (tenant_id, day, views) VALUES (?, ?, 3)").run(id, date);
  sqlite.prepare("INSERT INTO visitor_hashes (tenant_id, day, hash) VALUES (?, ?, 'h')").run(id, date);
  sqlite.prepare("INSERT INTO message_counts (tenant_id, date, start_min, holder, sender, sent) VALUES (?, ?, 600, 'A1', 'B1', 1)").run(id, date);
  sqlite.prepare("INSERT INTO audit_log (tenant_id, action, detail, device) VALUES (?, 'settings', 'x', 'Mac · Safari')").run(id);
  sqlite.prepare("INSERT INTO calendar_feeds (tenant_id, apartment, token) VALUES (?, 'A1', ?)").run(id, `feed-${id}`);
}

test("delete-now needs a closed building and the name again, then deletes everything", async () => {
  seedEverything(1);
  seedEverything(2);

  // Not while open.
  const open = await post("admin/delete", { confirm_name: "Lofotgata 5" }, admin);
  assert.equal(open.status, 303);
  assert.ok(tenant());

  await post("admin/close", { confirm_name: "Lofotgata 5" }, admin);
  const wrong = await post("admin/delete", { confirm_name: "Lofotgata 6" }, admin);
  assert.equal(wrong.status, 422);
  const page = await wrong.text();
  assert.match(page, /<dialog id="slett-na"[^>]*open=""/);
  assert.match(page, /Navnet stemmer ikke/);
  assert.ok(tenant());
  assert.ok(Object.values(tenantRows(1)).every((n) => n > 0), JSON.stringify(tenantRows(1)));

  const response = await post("admin/delete", { confirm_name: "lofotgata 5" }, admin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Vaskekjelleren er slettet/);
  assert.match(cookieFrom(response, "vk_admin") ?? "", /^vk_admin=$/);
  assert.equal(tenant(), undefined);
  assert.deepEqual(Object.values(tenantRows(1)), Object.values(tenantRows(1)).map(() => 0), JSON.stringify(tenantRows(1)));
  assert.ok(Object.values(tenantRows(2)).every((n) => n > 0), "the other building is untouched");
  assert.equal((await get("")).status, 404);
});

test("the nightly job deletes a building 7 days after it was closed, not before", async () => {
  seedEverything(1);
  seedEverything(2);
  sqlite.prepare("UPDATE tenants SET closed_at = ? WHERE id = 1").run(sqlTime(-7 * DAY + 60 * 60_000));
  await runCron();
  assert.ok(tenant(), "6 days 23 hours: kept");
  assert.ok(Object.values(tenantRows(1)).every((n) => n > 0));

  sqlite.prepare("UPDATE tenants SET closed_at = ? WHERE id = 1").run(sqlTime(-7 * DAY - 60_000));
  await runCron();
  assert.equal(tenant(), undefined, "7 days: deleted");
  assert.ok(Object.values(tenantRows(1)).every((n) => n === 0), JSON.stringify(tenantRows(1)));
  assert.ok(sqlite.prepare("SELECT 1 FROM tenants WHERE id = 2").get(), "an open building is never deleted");
  assert.ok(Object.values(tenantRows(2)).some((n) => n > 0));
});

test("the deletion date is the night of the first nightly run at least 7 days after closing", () => {
  // The cron runs at 02:17 UTC (04:17 in Oslo in summer).
  assert.equal(audit.purgeDate("2026-09-23 14:00:00", "Europe/Oslo"), "2026-10-01");
  assert.equal(audit.purgeDate("2026-09-23 01:00:00", "Europe/Oslo"), "2026-09-30");
  assert.equal(audit.purgeDate("2026-09-23 02:17:00", "Europe/Oslo"), "2026-09-30");
});
