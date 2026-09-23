// Resident-to-holder push messages ("Send melding"). Same isolated harness as bookings.test.mjs:
// the real Hono routes on SQLite, with a fake push service that decrypts what the worker sends.
import { test, before, after, mock } from "node:test";
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
    db.prepare("DELETE FROM message_counts"),
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

const shortDay = (date) => {
  const day = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}`;
};
const message = (booking_id, fields = {}, apartment = "B2") => post("message", { booking_id, preset: "done-soon", ...fields }, apartment);

test("a message pushes to the holder's devices and puts the sender on the waitlist", async () => {
  await reset();
  await book(600);
  const [washer] = (await active()).results;
  await subscribe("A3", "a3-phone");
  await subscribe("A3", "a3-laptop");
  await subscribe("B2"); // the sender's own devices get nothing
  await subscribe("C1");

  const response = await message(washer.id, { preset: "forgot-clothes", note: "  Ligger i kurven  " });
  assert.equal(flash(response), "message-sent");
  assert.match(response.headers.get("location"), new RegExp(`date=${tomorrow}`));
  await settle();
  assert.deepEqual(pushed.map((p) => p.endpoint.split("/").pop()).sort(), ["a3-laptop", "a3-phone"]);
  for (const { message: m } of pushed) {
    assert.equal(m.title, `Leil. B2 om ${shortDay(tomorrow)} 10:00–12:00`);
    assert.equal(m.body, "Du har glemt klær i maskinen «Ligger i kurven»\nSvar med en kommentar – de som venter får beskjed.");
    assert.equal(m.url, `/demo?date=${tomorrow}&note=${washer.id}#reservation-${washer.id}`);
    assert.equal(m.tag, `message-${tomorrow}-600-B2`);
    assert.equal(m.renotify, true);
  }
  assert.equal(await db.prepare("SELECT notifications FROM daily_stats").first("notifications"), 2);
  const waits = db.prepare("SELECT machine_id, apartment FROM waitlist ORDER BY machine_id").all();
  assert.deepEqual(
    (await waits).results.map((w) => [w.machine_id, w.apartment]),
    [
      [1, "B2"],
      [2, "B2"],
    ],
    "the sender waits for every machine in the reservation",
  );
  const sent = await (
    await mf.dispatchFetch(`http://localhost${response.headers.get("location")}`, { headers: { Cookie: "vk_apt=B2" } })
  ).text();
  assert.match(sent, /Meldingen er sendt\.<\/p><p class="toast-detail">Du står nå på ventelisten og får beskjed når kommentaren endres\./);
  assert.match(
    sent,
    new RegExp(
      `action="/demo/unwait-reservation[^"]*" class="toast-action"><input type="hidden" name="booking_id" value="${washer.id}"/><button class="toast-button">Forlat venteliste`,
    ),
    "the sender can leave right away",
  );
  assert.doesNotMatch(sent, /av 3 sendt/);

  // The holder's reply goes to the sender like to any other waiter.
  const holderIds = async () =>
    (await active()).results
      .filter((b) => b.apartment === "A3")
      .map((b) => b.id)
      .join(",");
  pushed = [];
  await post("note", { booking_ids: await holderIds(), note: "Ferdig om 5 min" });
  await settle();
  assert.deepEqual(
    pushed.map((p) => p.endpoint.split("/").pop()),
    ["B2"],
  );

  // Leaving after the message leaves the messaged reservation's machines, not other waits at that time.
  await book(600, "C1", "3");
  await post("wait", { machine_id: 3, date: tomorrow, start: 600 }, "B2");
  assert.equal(flash(await post("unwait-reservation", { booking_id: washer.id }, "B2")), "unwaited");
  assert.deepEqual(
    sqlite
      .prepare("SELECT machine_id FROM waitlist WHERE apartment = 'B2'")
      .all()
      .map((w) => w.machine_id),
    [3],
  );
  pushed = [];
  await post("note", { booking_ids: await holderIds(), note: "Ferdig nå" });
  await settle();
  assert.equal(pushed.length, 0);
});

test("leaving one machine's waitlist keeps the other machines", async () => {
  await reset();
  await book(600);
  const [washer] = (await active()).results;
  await subscribe("A3");
  await message(washer.id);
  assert.equal(flash(await post("unwait", { machine_id: 1, date: tomorrow, start: 600 }, "B2")), "unwaited");
  assert.deepEqual(
    sqlite
      .prepare("SELECT machine_id FROM waitlist WHERE apartment = 'B2'")
      .all()
      .map((w) => w.machine_id),
    [2],
  );
});

test("for 2 hours after a slot ends, only the forgot-clothes message can be sent, without the waitlist", async () => {
  await reset();
  const day = "2030-01-15";
  // 10:30 in Oslo (UTC+1 in January): A3's 08:00–10:00 slot ended half an hour ago.
  mock.timers.enable({ apis: ["Date"], now: new Date(`${day}T09:30:00Z`) });
  try {
    await insertBooking(day, 1, "A3");
    await insertBooking(day, 2, "A3");
    const [washer] = (await active()).results;
    await subscribe("A3");
    const slot = (await board(day, "B2")).match(/08:00<span class="time-dash">–<\/span>10:00[\s\S]*?<\/article>/)?.[0] ?? "";
    assert.match(slot, /Send melding til leil\. A3/);
    assert.match(slot, /value="forgot-clothes"/);
    assert.doesNotMatch(slot, /value="done-soon"|value="take-dryer"|action="\/demo\/wait/);

    assert.equal(flash(await message(washer.id)), "over");
    const response = await message(washer.id, { preset: "forgot-clothes", note: "Ligger i kurven" });
    assert.equal(flash(response), "message-sent-over");
    await settle();
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].message.title, `Leil. B2 om ${shortDay(day)} 08:00–10:00`);
    assert.equal(pushed[0].message.body, "Du har glemt klær i maskinen «Ligger i kurven»");
    assert.equal(pushed[0].message.url, `/demo?date=${day}`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM waitlist").get().n, 0);
    const sent = await (
      await mf.dispatchFetch(`http://localhost${response.headers.get("location")}`, { headers: { Cookie: "vk_apt=B2" } })
    ).text();
    assert.match(sent, />Meldingen er sendt\.<\/p>/);
    assert.doesNotMatch(sent, /unwait-reservation/);

    // 11:59 is still inside the window; from 12:00 it is closed.
    mock.timers.setTime(new Date(`${day}T10:59:00Z`).getTime());
    assert.equal(flash(await message(washer.id, { preset: "forgot-clothes" })), "message-sent-over");
    mock.timers.setTime(new Date(`${day}T11:00:00Z`).getTime());
    assert.equal(flash(await message(washer.id, { preset: "forgot-clothes" })), "over");
    assert.doesNotMatch(await board(day, "B2"), /Send melding/);
  } finally {
    mock.timers.reset();
  }
});

test("tapping the message opens the holder's comment field", async () => {
  await reset();
  await book(600);
  const [washer, dryer] = (await active()).results;
  const html = await (
    await mf.dispatchFetch(`http://localhost/demo?date=${tomorrow}&note=${dryer.id}`, { headers: { Cookie: "vk_apt=A3" } })
  ).text();
  assert.match(html, new RegExp(`id="reservation-${washer.id}"[\\s\\S]*?<details open="">\\s*<summary>Legg til kommentar`));
  assert.match(html, /<input name="note"[^>]*autofocus=""/);
  assert.doesNotMatch(await board(tomorrow, "A3"), /<details open="">\s*<summary>Legg til kommentar/);
});

test("only 3 messages per apartment per reservation; only the count is stored", async () => {
  await reset();
  await book(600);
  const [washer, dryer] = (await active()).results;
  await subscribe("A3");
  assert.equal(flash(await message(washer.id)), "message-sent");
  assert.equal(flash(await message(dryer.id, { preset: "take-dryer" })), "message-sent");
  assert.equal(flash(await message(washer.id, { note: "Hei der" })), "message-sent");
  assert.equal(flash(await message(washer.id)), "message-limit");
  assert.equal(flash(await message(washer.id, {}, "C1")), "message-sent", "another apartment has its own limit");
  await settle();
  assert.equal(pushed.length, 4);
  assert.deepEqual(
    sqlite
      .prepare("SELECT * FROM message_counts ORDER BY sender")
      .all()
      .map((r) => ({ ...r })),
    [
      { tenant_id: 1, date: tomorrow, start_min: 600, holder: "A3", sender: "B2", sent: 3 },
      { tenant_id: 1, date: tomorrow, start_min: 600, holder: "A3", sender: "C1", sent: 1 },
    ],
  );
  // Message text is not stored anywhere.
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const { name } of tables) {
    const dump = JSON.stringify(sqlite.prepare(`SELECT * FROM "${name}"`).all());
    assert.doesNotMatch(dump, /ferdig snart|tørketrommelen\?|Hei der/, `${name} holds no message text`);
  }
});

test("a reservation receives at most 10 messages in total across senders", async () => {
  await reset();
  await book(600);
  const [washer] = (await active()).results;
  await subscribe("A3");
  for (const sender of ["B1", "B2", "B3"]) {
    for (let i = 0; i < 3; i++) assert.equal(flash(await message(washer.id, {}, sender)), "message-sent");
  }
  assert.equal(flash(await message(washer.id, {}, "C1")), "message-sent");
  const full = await message(washer.id, {}, "C2");
  assert.equal(flash(full), "message-full");
  assert.equal(flash(await message(washer.id, {}, "C1")), "message-full");
  assert.equal(flash(await message(washer.id, {}, "B1")), "message-limit");
  await settle();
  assert.equal(pushed.length, 10);
  assert.equal(sqlite.prepare("SELECT SUM(sent) AS n FROM message_counts").get().n, 10);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE apartment = 'C2'").get().n, 0);
  const html = await (
    await mf.dispatchFetch(`http://localhost${full.headers.get("location")}`, { headers: { Cookie: "vk_apt=C2" } })
  ).text();
  assert.match(html, /class="toast error"[^]*?Denne tiden har allerede fått 10 meldinger\./);
});

test("the apartment cookie is validated like a saved apartment", async () => {
  await reset();
  await book(600);
  const [washer] = (await active()).results;
  await subscribe("A3");
  const long = "X".repeat(21);
  assert.equal(flash(await message(washer.id, {}, long)), "no-apt");
  assert.doesNotMatch(await board(tomorrow, long), new RegExp(long));
  assert.equal(flash(await message(washer.id, {}, "b%202")), "message-sent");
  await db.prepare("UPDATE tenants SET apartments = 'A3\nB2'").run();
  try {
    assert.equal(flash(await message(washer.id, {}, "C1")), "no-apt");
  } finally {
    await db.prepare("UPDATE tenants SET apartments = NULL").run();
  }
  await settle();
  assert.deepEqual(
    pushed.map((p) => p.message.title.split(" om ")[0]),
    ["Leil. B2"],
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message_counts WHERE sender <> 'B2'").get().n, 0);
});

test("messages to your own, cancelled, or past bookings are rejected", async () => {
  await reset();
  await book(600);
  const [washer] = (await active()).results;
  await subscribe("A3");
  assert.equal(flash(await message(washer.id, {}, "A3")), "invalid");
  assert.equal(flash(await message(999999)), "invalid");
  const day = localDate(-1);
  await insertBooking(day, 1, "A3");
  const past = (await active()).results.find((b) => b.date === day);
  assert.equal(flash(await message(past.id)), "over");
  assert.equal(flash(await message(past.id, { preset: "forgot-clothes" })), "over", "yesterday is past the 2-hour window");
  await post("cancel", { booking_ids: String(washer.id) }, "A3");
  assert.equal(flash(await message(washer.id)), "invalid");
  await settle();
  assert.equal(pushed.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message_counts").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE apartment = 'B2'").get().n, 0);
});

test("an unknown preset or a note over 140 characters is rejected", async () => {
  await reset();
  await book(600);
  const [washer] = (await active()).results;
  await subscribe("A3");
  assert.equal(flash(await message(washer.id, { preset: "hello" })), "invalid");
  assert.equal(flash(await message(washer.id, { preset: "toString" })), "invalid");
  assert.equal(flash(await message(washer.id, { preset: "" })), "invalid");
  assert.equal(flash(await message(washer.id, { note: "x".repeat(141) })), "invalid");
  assert.equal(flash(await message(washer.id, { note: ` ${"x".repeat(140)} ` })), "message-sent");
  await settle();
  assert.equal(pushed.length, 1);
});

test("a holder without notifications shows a notice and cannot be messaged", async () => {
  await reset();
  await book(600);
  await book(480, "C1");
  const [washer] = (await active()).results;
  await subscribe("C1");
  const html = await board(tomorrow, "B2");
  assert.match(html, /Leil\. A3 har ikke varsler på\./);
  assert.match(html, /Send melding til leil\. C1/);
  assert.doesNotMatch(html, /Send melding til leil\. A3/);
  assert.doesNotMatch(await board(tomorrow, "A3"), /Send melding til leil\. A3/, "no message form on your own booking");
  assert.doesNotMatch(await board(tomorrow), /Send melding/, "choose an apartment first");

  assert.equal(flash(await message(washer.id)), "no-push");
  await settle();
  assert.equal(pushed.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM message_counts").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM waitlist").get().n, 0);
});
