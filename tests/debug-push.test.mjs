// The "someone is waiting" push to a booking holder, and the admin push test page (/<slug>/admin/debug) that runs
// both notification flows against a test household. Same harness as push-messages.test.mjs: the real Hono routes
// on SQLite, with a fake push service that decrypts what the worker sends.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

let worker, bindings, db, temp, sqlite, admin;
const ADMIN_PASSWORD = "riktig-hest-batteri";
const TEST_APARTMENT = "TEST (varsler)";
const TEST_NOTE = "Test av varsler – slettes ved opprydding";
// Background work (push fan-out) the route handed to waitUntil; tests await it.
const pending = [];
function statement(sql) {
  let values = [];
  return {
    bind(...v) {
      values = v;
      return this;
    },
    async first(column) {
      const row = sqlite.prepare(sql).get(...values);
      return row ? (column ? row[column] : row) : null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...values);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
    execute() {
      const stmt = sqlite.prepare(sql);
      if (stmt.columns().length) return { results: stmt.all(...values), success: true, meta: {} };
      const result = stmt.run(...values);
      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
  };
}
const settle = async () => {
  while (pending.length) await pending.shift();
};
const fetchApp = async (path, init = {}) => {
  // The board is `/bygg`, so a bare query attaches without a slash.
  const url = `http://localhost/bygg${!path || path.startsWith("?") ? "" : "/"}${path}`;
  const response = await worker.fetch(new Request(url, { redirect: "manual", ...init }), bindings, {
    waitUntil: (promise) => pending.push(promise.catch(() => {})),
  });
  await settle();
  return response;
};
const cookies = (apartment, withAdmin) => [apartment && `vk_apt=${encodeURIComponent(apartment)}`, withAdmin && admin].filter(Boolean).join("; ");
const post = (path, body, apartment = "A3", withAdmin = false) =>
  fetchApp(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost", Cookie: cookies(apartment, withAdmin) },
    body: new URLSearchParams(body),
  });
const postJson = (path, body, apartment = "A3") =>
  fetchApp(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost", Cookie: cookies(apartment, true) },
    body: JSON.stringify(body),
  });
const get = (path, apartment = "A3", withAdmin = true) => fetchApp(path, { headers: { Cookie: cookies(apartment, withAdmin) } });
const location = (response) => new URL(response.headers.get("location"), "http://localhost");
const b64url = (bytes) => Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString("base64url");
const rows = (sql, ...values) => sqlite.prepare(sql).all(...values).map((r) => ({ ...r }));

// Dates in the tenant's timezone (Europe/Oslo), shifted by whole days.
const localDate = (offset = 0) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const tomorrow = localDate(1);
const shortDay = (date) => {
  const day = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}`;
};

// A fake push service: each subscription is a real P-256 key pair, so payloads can be decrypted (RFC 8291).
// `status` lets a test make the push service answer with an error or "gone".
const devices = new Map();
let pushed = [];
async function subscribe(apartment, name = apartment, tenant = 1) {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const device = {
    keys,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    auth: crypto.getRandomValues(new Uint8Array(16)),
    status: 201,
  };
  const endpoint = `https://push.example.invalid/${name}`;
  devices.set(endpoint, device);
  sqlite
    .prepare("INSERT INTO push_subscriptions (tenant_id, apartment, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)")
    .run(tenant, apartment, endpoint, b64url(device.publicKey), b64url(device.auth));
  return device;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
async function decrypt(device, body) {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 21 + body[20]);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, device.keys.privateKey, 256));
  const text = new TextEncoder();
  const ikm = await hkdf(device.auth, secret, Buffer.concat([text.encode("WebPush: info\0"), device.publicKey, asPublic]), 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(21 + body[20])));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))));
}
globalThis.fetch = async (url, init) => {
  const device = devices.get(String(url));
  if (!device) throw new Error(`unexpected fetch ${url}`);
  pushed.push({ endpoint: String(url).split("/").pop(), message: await decrypt(device, new Uint8Array(init.body)) });
  return new Response(device.status === 201 ? null : "nope", { status: device.status });
};

const book = (date, start, machine, apartment, note = null) =>
  sqlite
    .prepare("INSERT INTO bookings (tenant_id, machine_id, date, start_min, end_min, apartment, note) VALUES (1, ?, ?, ?, ?, ?, ?)")
    .run(machine, date, start, start + 120, apartment, note).lastInsertRowid;
const reset = () => {
  sqlite.exec(`DELETE FROM bookings; DELETE FROM waitlist; DELETE FROM push_subscriptions; DELETE FROM daily_stats;
    DELETE FROM message_counts; UPDATE tenants SET booking_horizon_days = 14; UPDATE machines SET active = 1;`);
  devices.clear();
  pushed = [];
};

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-debug-push-tests-"));
  await build({
    entryPoints: { worker: "src/index.tsx", crypto: "src/crypto.ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    outdir: temp,
    outExtension: { ".js": ".mjs" },
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  });
  worker = (await import(pathToFileURL(join(temp, "worker.mjs")).href)).default;
  const { hashPassword } = await import(pathToFileURL(join(temp, "crypto.mjs")).href);
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
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  bindings = {
    DB: db,
    SESSION_SECRET: "isolated-test-only",
    VAPID_PUBLIC_KEY: b64url(await crypto.subtle.exportKey("raw", vapidPair.publicKey)),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)).d,
    VAPID_SUBJECT: "mailto:test@example.invalid",
  };
  const hash = await hashPassword(ADMIN_PASSWORD);
  sqlite
    .prepare("INSERT INTO tenants (id, slug, name, admin_password_hash) VALUES (1, 'bygg', 'Lofotgata 5', ?), (2, 'other', 'Nabo', ?)")
    .run(hash, hash);
  sqlite.exec(
    `INSERT INTO machines (id, tenant_id, kind, name, sort_order) VALUES (1, 1, 'washer', 'Vaskemaskin', 1), (2, 1, 'dryer', 'Tørketrommel', 2),
       (3, 2, 'washer', 'Nabovask', 1)`,
  );
  const login = await post("admin/login", { password: ADMIN_PASSWORD }, "");
  admin = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("vk_admin="));
  assert.ok(admin, "logged in as admin");
});
after(async () => {
  sqlite?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The holder hears when someone joins the waitlist for their slot
// ---------------------------------------------------------------------------

test("joining the waitlist for someone's slot pushes to the holder's devices, once", async () => {
  reset();
  const id = book(tomorrow, 600, 1, "A3");
  await subscribe("A3", "a3-phone");
  await subscribe("A3", "a3-laptop");
  await subscribe("B2"); // the joiner's own devices get nothing
  await subscribe("C1");

  await post("wait", { machine_id: 1, date: tomorrow, start: 600 }, "B2");
  assert.deepEqual(pushed.map((p) => p.endpoint).sort(), ["a3-laptop", "a3-phone"]);
  for (const { message } of pushed) {
    assert.equal(message.title, "Noen venter på tiden din");
    assert.equal(
      message.body,
      `Vaskemaskin ${shortDay(tomorrow)} 10:00–12:00. Trenger du den ikke, avbestill så de får beskjed. En kommentar når dem også.`,
    );
    assert.equal(message.url, `/bygg?date=${tomorrow}&mode=1#reservation-${id}`);
    assert.equal(message.tag, `waiting-${tomorrow}-600-A3`);
    assert.equal(message.renotify, true);
  }
  assert.equal(sqlite.prepare("SELECT notifications FROM daily_stats").get().notifications, 2);

  pushed = [];
  await post("wait", { machine_id: 1, date: tomorrow, start: 600 }, "B2");
  assert.equal(pushed.length, 0, "joining again changes nothing and sends nothing");

  // A second household replaces the notification with the new count.
  await post("wait", { machine_id: 1, date: tomorrow, start: 600 }, "C1");
  assert.deepEqual(pushed.map((p) => p.endpoint).sort(), ["a3-laptop", "a3-phone"]);
  assert.equal(pushed[0].message.title, "2 venter på tiden din");
  assert.equal(pushed[0].message.tag, `waiting-${tomorrow}-600-A3`);
});

test("no holder push for your own slot, a free slot, or a holder without notifications", async () => {
  reset();
  book(tomorrow, 600, 1, "A3");
  book(tomorrow, 720, 1, "C1");
  await subscribe("A3");

  await post("wait", { machine_id: 1, date: tomorrow, start: 600 }, "A3");
  await post("wait", { machine_id: 2, date: tomorrow, start: 600 }, "B2");
  const response = await post("wait", { machine_id: 1, date: tomorrow, start: 720 }, "B2");
  assert.equal(location(response).searchParams.get("m"), "waiting");
  assert.equal(pushed.length, 0);
  assert.equal(rows("SELECT * FROM waitlist").length, 3, "every join is still stored");
});

test("the count covers every machine of the holder's reservation", async () => {
  reset();
  book(tomorrow, 600, 1, "A3");
  book(tomorrow, 600, 2, "A3");
  await subscribe("A3");
  await post("wait", { machine_id: 1, date: tomorrow, start: 600 }, "B2");
  await post("wait", { machine_id: 2, date: tomorrow, start: 600 }, "C1");
  assert.deepEqual(
    pushed.map((p) => [p.message.title, p.message.tag]),
    [
      ["Noen venter på tiden din", `waiting-${tomorrow}-600-A3`],
      ["2 venter på tiden din", `waiting-${tomorrow}-600-A3`],
    ],
  );
  assert.match(pushed[1].message.body, new RegExp(`^Tørketrommel ${shortDay(tomorrow)} 10:00–12:00\\.`));
  assert.match(pushed[1].message.url, new RegExp(`^/bygg\\?date=${tomorrow}&mode=2#reservation-`));
});

test("a message puts the sender on the waitlist without a separate waiting push", async () => {
  reset();
  const washer = book(tomorrow, 600, 1, "A3");
  book(tomorrow, 600, 2, "A3");
  await subscribe("A3");

  await post("message", { booking_id: washer, preset: "done-soon" }, "B2");
  assert.deepEqual(
    pushed.map((p) => p.message.tag),
    [`message-${tomorrow}-600-B2`],
    "the message itself tells the holder",
  );
  assert.equal(rows("SELECT * FROM waitlist WHERE apartment = 'B2'").length, 2);
});

// ---------------------------------------------------------------------------
// Admin push test page
// ---------------------------------------------------------------------------

test("the push test page is for admins only", async () => {
  reset();
  const anonymous = await get("admin/debug", "A3", false);
  assert.equal(anonymous.status, 303);
  assert.equal(location(anonymous).pathname, "/bygg/admin/login");
  for (const path of ["freed", "waiting", "cleanup"]) {
    const response = await post(`admin/debug/${path}`, {}, "A3");
    assert.equal(location(response).pathname, "/bygg/admin/login");
  }
  assert.equal(rows("SELECT * FROM bookings").length, 0);

  const html = await (await get("admin/debug")).text();
  assert.match(html, /<h1>Test varsler<\/h1>/);
  assert.match(html, /Testene kjøres som <strong>Leil\. A3<\/strong>/);
  assert.match(html, /Ingen enheter har varsler på for denne leiligheten ennå\./);
  assert.match(html, /data-apartment="A3"/);
  assert.match(html, /src="\/debug\.js"/);
  assert.doesNotMatch(html, /<button class="button" disabled/);

  const overview = await (await get("admin")).text();
  assert.match(overview, /href="\/bygg\/admin\/debug"/, "linked from the admin overview");
});

test("without a chosen apartment the page points to the booking page and the tests are off", async () => {
  reset();
  const html = await (await get("admin/debug", "")).text();
  assert.match(html, /Denne enheten har ikke valgt leilighet\./);
  assert.equal((html.match(/<button class="button" disabled=""/g) ?? []).length, 2);
  const response = await post("admin/debug/freed", {}, "", true);
  assert.equal(location(response).search, "?test=freed&error=no-apt");
  assert.match(await (await get(`admin/debug${location(response).search}`, "")).text(), /Velg leilighet på bookingsiden/);
});

test("test 1: a test booking the admin waits for is cancelled, the real waitlist push fires, nothing is left", async () => {
  reset();
  await subscribe("A3", "a3-phone");
  await subscribe("B2"); // another resident's device is not involved
  const response = await post("admin/debug/freed", {}, "A3", true);
  const params = location(response).searchParams;
  assert.equal(params.get("test"), "freed");
  assert.equal(params.get("push"), "1.1.0.0");
  const [date, start, end, machine] = params.get("slot").split(".");
  assert.equal(machine, "1", "a washer");
  assert.equal(Number(end) - Number(start), 120);

  assert.deepEqual(
    pushed.map((p) => [p.endpoint, p.message.title, p.message.tag]),
    [["a3-phone", "Vaskemaskin er ledig!", `slot-1-${date}-${start}`]],
  );
  assert.equal(rows("SELECT * FROM bookings").length, 0, "the cancelled test booking is deleted");
  assert.equal(rows("SELECT * FROM waitlist").length, 0, "and so is the admin's waitlist entry");

  const html = await (await get(`admin/debug${location(response).search}`)).text();
  assert.match(html, /Test 1: tiden ble ledig/);
  assert.match(html, /<span class="debug-pill">Sendt<\/span>/);
  assert.match(html, /Sendt til 1 av 1 enhet\./);
  assert.match(html, /TEST \(varsler\) booket Vaskemaskin/);
});

test("test 1 reports no devices, and a failed or expired device", async () => {
  reset();
  let response = await post("admin/debug/freed", {}, "A3", true);
  assert.equal(location(response).searchParams.get("push"), "0.0.0.0");
  let html = await (await get(`admin/debug${location(response).search}`)).text();
  assert.match(html, /<span class="debug-pill">Ingen enheter<\/span>/);
  assert.match(html, /Ikke sendt: Leil\. A3 har ingen enheter med varsler på\./);

  (await subscribe("A3", "a3-broken")).status = 500;
  (await subscribe("A3", "a3-old")).status = 410;
  response = await post("admin/debug/freed", {}, "A3", true);
  assert.equal(location(response).searchParams.get("push"), "2.0.1.1");
  html = await (await get(`admin/debug${location(response).search}`)).text();
  assert.match(html, /<span class="debug-pill">Feilet<\/span>/);
  assert.match(html, /Sendt til 0 av 2 enheter\. 1 var utløpt og er fjernet\. 1 feilet\./);
  assert.deepEqual(
    rows("SELECT endpoint FROM push_subscriptions").map((r) => r.endpoint),
    ["https://push.example.invalid/a3-broken"],
  );
});

test("test 2: the admin books, the test household joins, the holder push fires; cleanup removes only test data", async () => {
  reset();
  await subscribe("A3", "a3-phone");
  // Real bookings the tests must step around and leave alone.
  sqlite.exec("UPDATE tenants SET booking_horizon_days = 3");
  for (const day of [localDate(0), tomorrow]) for (let start = 480; start < 1200; start += 120) book(day, start, 1, "C1");
  const own = book(tomorrow, 480, 2, "A3", "min egen");
  sqlite.prepare("INSERT INTO waitlist (tenant_id, machine_id, date, start_min, apartment) VALUES (1, 2, ?, 600, 'B2')").run(tomorrow);

  const response = await post("admin/debug/waiting", {}, "A3", true);
  const params = location(response).searchParams;
  assert.equal(params.get("push"), "1.1.0.0");
  const [date, start, , machine] = params.get("slot").split(".");
  // Washers are full today and tomorrow; the dryer's slot with someone waiting is skipped.
  assert.equal(machine, "2");
  assert.ok(!(date === tomorrow && start === "600") && !(date === tomorrow && start === "480"));
  const [booking] = rows("SELECT id, apartment, note FROM bookings WHERE note = ?", TEST_NOTE);
  assert.equal(booking.apartment, "A3");
  assert.deepEqual(
    rows("SELECT apartment, machine_id, date, start_min FROM waitlist WHERE apartment = ?", TEST_APARTMENT),
    [{ apartment: TEST_APARTMENT, machine_id: 2, date, start_min: Number(start) }],
  );
  assert.deepEqual(
    pushed.map((p) => [p.endpoint, p.message.title, p.message.url]),
    [["a3-phone", "Noen venter på tiden din", `/bygg?date=${date}&mode=2#reservation-${booking.id}`]],
  );
  const html = await (await get(`admin/debug${location(response).search}`)).text();
  assert.match(html, /Test 2: noen venter på tiden din/);
  assert.match(html, /ligger der til du trykker «Rydd opp»/);

  // The board shows the test household like any other waiter.
  const board = await (await get(`?date=${date}`, "A3", false)).text();
  assert.match(board, /1 venter på denne tiden/);

  const cleanup = await post("admin/debug/cleanup", {}, "A3", true);
  assert.equal(location(cleanup).search, "?test=cleanup");
  assert.equal(rows("SELECT * FROM bookings WHERE note = ? OR apartment = ?", TEST_NOTE, TEST_APARTMENT).length, 0);
  assert.equal(rows("SELECT * FROM waitlist WHERE apartment = ?", TEST_APARTMENT).length, 0);
  assert.equal(rows("SELECT * FROM bookings WHERE apartment = 'C1'").length, 12);
  assert.equal(rows("SELECT * FROM bookings WHERE id = ?", own).length, 1);
  assert.equal(rows("SELECT * FROM waitlist WHERE apartment = 'B2'").length, 1);
  assert.match(await (await get("admin/debug?test=cleanup")).text(), /Alle bookinger og ventelisteplasser fra testene er fjernet\./);
});

test("each test clears the previous one, and cleanup stays inside the building", async () => {
  reset();
  // Test data in another building is not this admin's to remove.
  sqlite
    .prepare("INSERT INTO bookings (tenant_id, machine_id, date, start_min, end_min, apartment, note) VALUES (2, 3, ?, 600, 720, ?, ?)")
    .run(tomorrow, TEST_APARTMENT, TEST_NOTE);
  await post("admin/debug/waiting", {}, "A3", true);
  await post("admin/debug/waiting", {}, "A3", true);
  assert.equal(rows("SELECT * FROM bookings WHERE tenant_id = 1").length, 1, "the second run replaced the first");
  assert.equal(rows("SELECT * FROM waitlist WHERE tenant_id = 1").length, 1);
  await post("admin/debug/freed", {}, "A3", true);
  assert.equal(rows("SELECT * FROM bookings WHERE tenant_id = 1").length, 0);
  assert.equal(rows("SELECT * FROM waitlist WHERE tenant_id = 1").length, 0);
  assert.equal(rows("SELECT * FROM bookings WHERE tenant_id = 2").length, 1);
});

test("no free slot is reported instead of booking over someone", async () => {
  reset();
  sqlite.exec("UPDATE machines SET active = 0 WHERE tenant_id = 1");
  const response = await post("admin/debug/waiting", {}, "A3", true);
  assert.equal(location(response).search, "?test=waiting&error=no-slot");
  assert.match(await (await get(`admin/debug${location(response).search}`)).text(), /Fant ingen ledig tid uten venteliste de neste 14 dagene\./);
  assert.equal(rows("SELECT * FROM bookings").length, 0);
});

test("the page's device check and subscribe", async () => {
  reset();
  await subscribe("B2", "shared-phone");
  let found = await (await postJson("admin/debug/device", { endpoint: "https://push.example.invalid/shared-phone" })).json();
  assert.deepEqual(found, { apartment: "B2" });
  assert.deepEqual(await (await postJson("admin/debug/device", { endpoint: "https://push.example.invalid/nope" })).json(), { apartment: null });

  const device = devices.get("https://push.example.invalid/shared-phone");
  const response = await postJson("admin/debug/subscribe", {
    endpoint: "https://push.example.invalid/shared-phone",
    keys: { p256dh: b64url(device.publicKey), auth: b64url(device.auth) },
  });
  assert.deepEqual(await response.json(), { ok: true });
  found = await (await postJson("admin/debug/device", { endpoint: "https://push.example.invalid/shared-phone" })).json();
  assert.deepEqual(found, { apartment: "A3" }, "the device now gets notifications for the admin's apartment");
  assert.equal(rows("SELECT * FROM push_subscriptions").length, 1);
});
