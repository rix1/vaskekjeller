// Booking reminders: which bookings are due, and that each is reminded once. Runs src/reminder.ts on SQLite
// with the real migrations; D1 is mirrored by a thin wrapper and the push sender is a recording stub.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

let temp, sqlite, sendReminders, db;
const sent = [];
const send = async (tenant, subs, message) => {
  sent.push({ tenant, subs: subs.length, message });
  return { devices: subs.length, sent: subs.length, gone: 0, failed: 0 };
};

function statement(sql) {
  let bindings = [];
  return {
    bind(...v) {
      bindings = v;
      return this;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...bindings), success: true, meta: {} };
    },
    run() {
      return { meta: { changes: Number(sqlite.prepare(sql).run(...bindings).changes) } };
    },
  };
}

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vk-reminder-"));
  const out = join(temp, "reminder.mjs");
  await build({ entryPoints: ["src/reminder.ts"], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
  ({ sendReminders } = await import(pathToFileURL(out).href));
  sqlite = new DatabaseSync(":memory:");
  for (const f of (await readdir("migrations")).sort()) sqlite.exec(await readFile(join("migrations", f), "utf8"));
  db = { prepare: statement, batch: async (stmts) => stmts.map((s) => s.run()) };
});
after(() => rm(temp, { recursive: true, force: true }));

// Oslo is UTC+2 in July 2026, so a 12:00 booking starts at 10:00Z.
const NOW = new Date("2026-07-01T09:52:00Z"); // 11:52 Oslo, 8 minutes before a 12:00 booking
const setup = (slug = "bygg", extra = {}) => {
  sqlite.exec("DELETE FROM bookings; DELETE FROM push_subscriptions; DELETE FROM machines; DELETE FROM tenants;");
  sqlite.prepare("INSERT INTO tenants (id, slug, name, admin_password_hash) VALUES (1, ?, 'Bygg', 'x')").run(slug);
  sqlite.exec("INSERT INTO machines (id, tenant_id, kind, name) VALUES (1, 1, 'washer', 'Vaskemaskin'), (2, 1, 'dryer', 'Tørketrommel')");
  sqlite.exec("INSERT INTO push_subscriptions (tenant_id, apartment, endpoint, p256dh, auth) VALUES (1, 'A3', 'https://e/1', 'p', 'a')");
  sqlite.prepare("UPDATE tenants SET closed_at = ? WHERE id = 1").run(extra.closed ?? null);
};
const book = (machine, start, apartment = "A3", date = "2026-07-01", created = "2026-06-30 10:00:00") =>
  sqlite
    .prepare("INSERT INTO bookings (tenant_id, machine_id, date, start_min, end_min, apartment, created_at) VALUES (1, ?, ?, ?, ?, ?, ?)")
    .run(machine, date, start, start + 120, apartment, created);

test("reminds once, one push for washer and dryer in the same slot", async () => {
  setup();
  sent.length = 0;
  book(1, 720);
  book(2, 720);
  assert.equal(await sendReminders(db, send, NOW), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.title, "Vasketiden din starter om 8 min");
  assert.match(sent[0].message.body, /Vaskemaskin og Tørketrommel kl\. 12:00–14:00/);
  assert.equal(sent[0].message.url, "/bygg?date=2026-07-01");
  assert.equal(await sendReminders(db, send, new Date(NOW.getTime() + 60_000)), 0);
  assert.equal(sent.length, 1);
});

test("skips bookings outside the window, cancelled, fresh, closed and demo buildings", async () => {
  for (const [name, now, mutate] of [
    ["too early", new Date("2026-07-01T09:45:00Z"), () => {}],
    ["already started", new Date("2026-07-01T10:01:00Z"), () => {}],
    ["cancelled", NOW, () => sqlite.exec("UPDATE bookings SET cancelled_at = datetime('now')")],
    ["booked minutes ago", NOW, () => sqlite.prepare("UPDATE bookings SET created_at = '2026-07-01 09:47:00'").run()],
  ]) {
    setup();
    sent.length = 0;
    book(1, 720);
    mutate();
    assert.equal(await sendReminders(db, send, now), 0, name);
    assert.equal(sent.length, 0, name);
  }
  for (const slug of ["visning", "demo"]) {
    setup(slug);
    book(1, 720);
    assert.equal(await sendReminders(db, send, NOW), 0, slug);
  }
  setup("bygg", { closed: "2026-06-30 10:00:00" });
  book(1, 720);
  assert.equal(await sendReminders(db, send, NOW), 0, "closed");
});

test("only the booking apartment's devices are told", async () => {
  setup();
  sent.length = 0;
  book(1, 720, "B1");
  assert.equal(await sendReminders(db, send, NOW), 0);
  assert.equal(sent.length, 0);
});
