import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

let mf, db, temp, sqlite, vapidKeys;
// Background work (push fan-out) the route handed to waitUntil; tests await it.
const pending = [];
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
    db.prepare("DELETE FROM push_subscriptions"),
    db.prepare("DELETE FROM daily_stats"),
    db.prepare("UPDATE tenants SET max_active_bookings = 0, day_start_min = 480"),
    db.prepare("UPDATE machines SET active = 1"),
  ]);
  await settle();
  devices.clear();
  pushed = [];
};
const settle = async () => {
  while (pending.length) await pending.shift();
};
const b64url = (bytes) => Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString("base64url");

// A fake push service: each subscription is a real P-256 key pair, so payloads
// sent by the worker can be decrypted (RFC 8291) and inspected.
const devices = new Map();
let pushed = [];
async function subscribe(apartment, name = apartment) {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const device = {
    keys,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    auth: crypto.getRandomValues(new Uint8Array(16)),
  };
  const endpoint = `https://push.example.invalid/${name}`;
  devices.set(endpoint, device);
  await db
    .prepare("INSERT INTO push_subscriptions (tenant_id, apartment, endpoint, p256dh, auth) VALUES (1, ?, ?, ?, ?)")
    .bind(apartment, endpoint, b64url(device.publicKey), b64url(device.auth))
    .run();
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
  pushed.push({ endpoint: String(url), message: await decrypt(device, new Uint8Array(init.body)) });
  return new Response(null, { status: 201 });
};
const wait = (apartment, machine, start) =>
  db
    .prepare("INSERT INTO waitlist (tenant_id, machine_id, date, start_min, apartment) VALUES (1, ?, ?, ?, ?)")
    .bind(machine, tomorrow, start, apartment)
    .run();
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
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  vapidKeys = {
    publicKey: b64url(await crypto.subtle.exportKey("raw", vapidPair.publicKey)),
    privateKey: (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)).d,
  };
  const bindings = {
    DB: db,
    SESSION_SECRET: "isolated-test-only",
    VAPID_PUBLIC_KEY: vapidKeys.publicKey,
    VAPID_PRIVATE_KEY: vapidKeys.privateKey,
    VAPID_SUBJECT: "mailto:test@example.invalid",
  };
  mf = {
    dispatchFetch: (url, init) =>
      worker.fetch(new Request(url, init), bindings, {
        waitUntil: (promise) => pending.push(promise.catch(() => {})),
      }),
  };
  const schema = await readFile("migrations/0001_init.sql", "utf8");
  sqlite.exec(schema);
  await db.prepare(await readFile("migrations/0002_booking_overlap.sql", "utf8")).run();
  sqlite.exec(await readFile("migrations/0004_message_counts.sql", "utf8"));
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

// Dates in the tenant's timezone (Europe/Oslo), shifted by whole days.
const localDate = (offset = 0) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const board = async (date, apartment) =>
  (
    await mf.dispatchFetch(`http://localhost/demo${date ? `?date=${date}` : ""}`, {
      headers: apartment ? { Cookie: `vk_apt=${apartment}` } : {},
    })
  ).text();
const insertBooking = (date, machine, apartment, note = null, cancelled = false) =>
  db
    .prepare(
      `INSERT INTO bookings (tenant_id,machine_id,date,start_min,end_min,apartment,note,cancelled_at) VALUES (1,?,?,480,600,?,?,${cancelled ? "datetime('now')" : "NULL"})`,
    )
    .bind(machine, date, apartment, note)
    .run();
const stripDates = (html) => [...html.matchAll(/data-date="([\d-]+)"/g)].map((m) => m[1]);
const selectedDate = (html) => /data-date="([\d-]+)"[^>]*aria-current="date"/.exec(html)?.[1];

test("past days show who used each machine, read-only, without cancelled bookings", async () => {
  await reset();
  const day = localDate(-3);
  await insertBooking(day, 1, "D4", "Tøy ligger i tørketrommelen");
  await insertBooking(day, 2, "Z9", null, true);
  const html = await board(day);
  assert.equal(selectedDate(html), day);
  assert.match(html, /Leil\. D4/);
  assert.match(html, /Tøy ligger i tørketrommelen/);
  assert.doesNotMatch(html, /leil\. Z9/i);
  assert.doesNotMatch(html, /action="\/demo\/(book|wait|unwait)/);
  assert.doesNotMatch(html, /reserve-button/);
  assert.match(html, new RegExp(`data-date="${day}"[^>]*aria-label="[^"]*, passert"[^>]*>.*?<small>Passert</small>`));
});

test("past days still show bookings on since-deactivated machines and outside today's opening hours", async () => {
  await reset();
  const day = localDate(-2);
  await insertBooking(day, 2, "E5", "Glemte tøy i tørketrommelen");
  await db.prepare("UPDATE machines SET active = 0 WHERE id = 2").run();
  let html = await board(day);
  assert.match(html, /class="usage-machine">Tørketrommel</);
  assert.match(html, /Leil\. E5/);
  assert.match(html, /Glemte tøy i tørketrommelen/);

  await db.prepare("UPDATE tenants SET day_start_min = 600").run();
  html = await board(day);
  assert.match(html, /08:00<span class="time-dash">–<\/span>10:00/);
  assert.match(html, /Leil\. E5/);

  await db.prepare("UPDATE machines SET active = 0").run();
  assert.match(await board(day), /Leil\. E5/);
});

test("writes to past slots are still rejected", async () => {
  await reset();
  const day = localDate(-1);
  await insertBooking(day, 1, "A3");
  const id = String((await active()).results[0].id);
  assert.equal(flash(await post("book", { date: day, start: 480, mode: "pair-1-2" })), "invalid");
  assert.equal(flash(await post("wait", { machine_id: 2, date: day, start: 480 })), "invalid");
  assert.equal(flash(await post("note", { booking_ids: id, note: "for sent" })), "over");
  assert.equal(flash(await post("cancel", { booking_ids: id })), "over");
  const rows = (await active()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, null);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM waitlist").first("n"), 0);
});

test("the date strip shows Monday-to-Sunday weeks within the 14-day look-back and horizon", async () => {
  await reset();
  const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const today = await board();
  assert.equal(selectedDate(today), localDate());
  const week = stripDates(today);
  assert.equal(week.length, 7);
  assert.equal(weekday(week[0]), 1);
  assert.equal(weekday(week[6]), 0);
  assert.ok(week.includes(localDate()));

  const first = await board(localDate(-14));
  assert.equal(selectedDate(first), localDate(-14));
  assert.match(first, /aria-label="Forrige uke" aria-disabled="true"/);
  for (const d of stripDates(first).filter((d) => d < localDate(-14))) {
    assert.match(first, new RegExp(`<span class="date-item unavailable" data-date="${d}"`));
  }
  // Outside the window falls back to today.
  assert.equal(selectedDate(await board(localDate(-15))), localDate());
  assert.equal(selectedDate(await board(localDate(14))), localDate());
  const last = await board(localDate(13));
  assert.equal(selectedDate(last), localDate(13));
  assert.match(last, /aria-label="Neste uke" aria-disabled="true"/);
});

const boardFor = (apartment) =>
  mf.dispatchFetch(`http://localhost/demo?date=${tomorrow}&mode=pair-1-2`, {
    headers: apartment ? { Cookie: `vk_apt=${apartment}` } : {},
  });

test("saving an apartment validates it, sets the cookie and keeps the view", async () => {
  await db.prepare("UPDATE tenants SET apartments = 'A3\nB2'").run();
  try {
    const bad = await post("apartment", { apartment: "Z9" });
    assert.equal(flash(bad), "bad-apt");
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
  const first = await (await boardFor()).text();
  assert.match(first, /Hei, nabo\./);
  assert.doesNotMatch(first, /apartment-menu/);

  const saved = await (await boardFor("A3")).text();
  assert.doesNotMatch(saved, /Hei, nabo\./);
  assert.match(saved, /<details class="apartment-menu">/);
  assert.match(saved, /class="apartment-popover"[\s\S]*action="\/demo\/apartment\?date=/);
});

test("reservation card shows how many other households are waiting", async () => {
  await reset();
  await book(480, "A3", "1");
  assert.doesNotMatch(await board(tomorrow, "A3"), /venter på denne tiden|note-hint/);

  await wait("B2", 1, 480);
  let html = await board(tomorrow, "A3");
  assert.match(html, /<strong>1 venter på denne tiden<\/strong> – legg til en kommentar/);
  assert.match(html, /1 venter – de får beskjed om kommentaren din\./);

  await wait("C1", 1, 480);
  await wait("D4", 1, 480);
  await wait("A3", 1, 480); // the holder's own apartment never counts
  await wait("E5", 1, 600); // a different slot does not count
  html = await board(tomorrow, "A3");
  assert.match(html, /<strong>3 venter på denne tiden<\/strong>/);
  assert.match(html, /3 venter – de får beskjed/);
  assert.doesNotMatch(await board(tomorrow, "B2"), /venter på denne tiden/, "waiters do not see the holder's count");
});

test("a paired reservation counts each waiting household once across both machines", async () => {
  await reset();
  await book(480);
  await wait("B2", 1, 480);
  await wait("B2", 2, 480);
  await wait("C1", 2, 480);
  let html = await board(tomorrow, "A3");
  assert.match(html, /<strong>2 venter på denne tiden<\/strong>/);
  await post("note", { booking_ids: (await active()).results.map((b) => b.id).join(","), note: "Ferdig kl. 9" });
  html = await board(tomorrow, "A3");
  assert.match(html, /2 venter på denne tiden<\/strong> – endre kommentaren/);
});

test("adding or changing a comment notifies each waiting household's devices once", async () => {
  await reset();
  await book(600);
  const ids = (await active()).results.map((b) => b.id).join(",");
  await wait("B2", 1, 600);
  await wait("B2", 2, 600);
  await wait("C1", 2, 600);
  await wait("A3", 1, 600);
  await wait("D4", 1, 480); // another slot
  await subscribe("B2", "b2-phone");
  await subscribe("B2", "b2-laptop");
  await subscribe("C1");
  await subscribe("A3");
  await subscribe("D4");
  await subscribe("E5"); // not waiting at all

  assert.equal(flash(await post("note", { booking_ids: ids, note: "ferdig kl. 11" })), "note");
  await settle();
  assert.deepEqual(pushed.map((p) => p.endpoint.split("/").pop()).sort(), ["C1", "b2-laptop", "b2-phone"]);
  const day = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${tomorrow}T00:00:00Z`),
  );
  const expected = `${day.charAt(0).toUpperCase()}${day.slice(1)} 10:00–12:00: «ferdig kl. 11»`;
  for (const { message } of pushed) {
    assert.equal(message.body, expected);
    assert.equal(message.tag, `note-${tomorrow}-600-A3`);
    assert.equal(message.url, `/demo?date=${tomorrow}`);
  }
  assert.equal(await db.prepare("SELECT notifications FROM daily_stats").first("notifications"), 3);

  pushed = [];
  await post("note", { booking_ids: ids, note: "ferdig kl. 10:30" });
  await settle();
  assert.equal(pushed.length, 3);
  assert.ok(pushed.every((p) => p.message.tag === `note-${tomorrow}-600-A3`), "edits replace the earlier notification");
  assert.ok(pushed.every((p) => p.message.renotify === true), "a replaced notification alerts again");
});

test("comments from different households on the same slot do not replace each other", async () => {
  await reset();
  await book(600, "A3", "1");
  await book(600, "B2", "2");
  await wait("C1", 1, 600);
  await wait("C1", 2, 600);
  await subscribe("C1");
  const note = async (apartment, text) => {
    const ids = (await active()).results.filter((b) => b.apartment === apartment).map((b) => b.id);
    await post("note", { booking_ids: ids.join(","), note: text }, apartment);
    await settle();
  };

  await note("A3", "ferdig kl. 11");
  await note("B2", "ferdig kl. 11:30");
  await note("A3", "ferdig kl. 10:30");
  assert.deepEqual(
    pushed.map((p) => p.message.tag),
    [`note-${tomorrow}-600-A3`, `note-${tomorrow}-600-B2`, `note-${tomorrow}-600-A3`],
  );
});

test("clearing or re-saving an unchanged comment sends nothing", async () => {
  await reset();
  await book(600, "A3", "1");
  const ids = (await active()).results.map((b) => b.id).join(",");
  await wait("B2", 1, 600);
  await subscribe("B2");
  await post("note", { booking_ids: ids, note: "ferdig kl. 11" });
  await settle();
  assert.equal(pushed.length, 1);

  pushed = [];
  await post("note", { booking_ids: ids, note: "  ferdig kl. 11 " });
  await post("note", { booking_ids: ids, note: "" });
  await settle();
  assert.equal(pushed.length, 0);
  assert.equal((await active()).results[0].note, null);
});
