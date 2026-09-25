import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Landing page and demo buildings: "/" is the landing page, the last-building cookie, the read-only
// showcase (/visning), the presets-only playground (/demo), and the nightly reset.
// Same harness as bookings.test.mjs: the real Hono routes against an isolated SQLite database.
let worker, app, bindings, demo, db, temp, sqlite;
const pending = [];
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
const ctx = { waitUntil: (promise) => pending.push(promise.catch(() => {})) };
const settle = async () => {
  while (pending.length) await pending.shift();
};
const get = (path, cookie = "") => worker.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }), bindings, ctx);
const post = (path, body, cookie = "") =>
  worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost", Cookie: cookie },
      body: new URLSearchParams(body),
      redirect: "manual",
    }),
    bindings,
    ctx,
  );
const flash = (response) => new URL(response.headers.get("location"), "http://localhost").searchParams.get("m");
const rows = (sql, ...params) => sqlite.prepare(sql).all(...params);
const tenantId = (slug) => sqlite.prepare("SELECT id FROM tenants WHERE slug = ?").get(slug)?.id;
const reset = async () => {
  await worker.scheduled({}, bindings, ctx);
  await settle();
};
const osloToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Everything a demo building holds, without row ids, so two seeds can be compared. */
const snapshot = (slug) => {
  const id = tenantId(slug);
  return {
    tenant: rows(
      "SELECT slug, name, day_start_min, day_end_min, slot_min, booking_horizon_days, apartments, read_only, presets_only FROM tenants WHERE id = ?",
      id,
    ),
    machines: rows("SELECT id, kind, name, sort_order, active FROM machines WHERE tenant_id = ? ORDER BY id", id),
    bookings: rows(
      "SELECT machine_id, date, start_min, end_min, apartment, note FROM bookings WHERE tenant_id = ? AND cancelled_at IS NULL ORDER BY date, start_min, machine_id",
      id,
    ),
    waitlist: rows("SELECT machine_id, date, start_min, apartment FROM waitlist WHERE tenant_id = ? ORDER BY date, start_min, machine_id, apartment", id),
  };
};

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-landing-tests-"));
  for (const [entry, name] of [
    ["src/index.tsx", "worker.mjs"],
    ["src/demo.ts", "demo.mjs"],
  ])
    await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      outfile: join(temp, name),
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
  ({ default: worker, app } = await import(pathToFileURL(join(temp, "worker.mjs")).href));
  demo = await import(pathToFileURL(join(temp, "demo.mjs")).href);
  bindings = { DB: db, SESSION_SECRET: "isolated-test-only", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" };
  for (const file of (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort())
    sqlite.exec(await readFile(join("migrations", file), "utf8"));
  sqlite.exec(
    "INSERT INTO tenants (slug, name, admin_password_hash) VALUES ('lofotgata', 'Lofotgata 12', 'unused');" +
      "INSERT INTO machines (tenant_id, kind, name) SELECT id, 'washer', 'Vaskemaskin' FROM tenants WHERE slug = 'lofotgata';",
  );
});
after(async () => {
  sqlite?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

test("the demo buildings are created on their first visit", async () => {
  assert.equal(tenantId("visning"), undefined);
  const response = await get("/visning");
  assert.equal(response.status, 200);
  assert.ok(rows("SELECT id FROM bookings WHERE tenant_id = ?", tenantId("visning")).length > 50);
  assert.equal(tenantId("demo"), undefined, "only the visited demo is created");
  assert.equal((await get("/demo")).status, 200);
});

test("/ is the landing page, not a redirect, with the preview, the demo and signup", async () => {
  const response = await get("/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  const html = await response.text();
  assert.match(html, /Har du en lenke fra styret\? Bruk den/);
  assert.match(html, /<a class="button landing-primary" href="\/ny">\s*Opprett vaskekjeller/);
  assert.match(html, /<a class="button landing-demo" href="\/demo">Prøv demoen/);
  for (const point of ["Ett trykk", "Venteliste med varsel", "Ingen app å installere", "Ingen personopplysninger"]) assert.match(html, new RegExp(point));
  // The preview is the showcase at tomorrow's (nearly full) date, lazy, and hidden from assistive tech and focus.
  const iframe = html.match(/<iframe[^>]*>/)?.[0] ?? "";
  assert.match(iframe, new RegExp(`src="/visning\\?embed=1&amp;date=${addDays(osloToday(), 1)}"`));
  assert.match(iframe, /loading="lazy"/);
  assert.match(iframe, /aria-hidden="true"/);
  assert.match(iframe, /tabindex="-1"/);
  assert.match(iframe, /inert/);
  assert.match(html, /<figure class="phone" role="img" aria-label="Forhåndsvisning av bookingsiden/);
  assert.doesNotMatch(html, /Gå til/);
});

test("pages may only be framed by the site itself", async () => {
  for (const path of ["/", "/visning", "/lofotgata"]) {
    const response = await get(path);
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN", path);
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'self'", path);
  }
});

test("visiting a building remembers it for the landing page's Gå til link; demos don't", async () => {
  const cookie = (await get("/lofotgata")).headers.get("set-cookie") ?? "";
  assert.match(cookie, /vk_last=lofotgata;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  // Any page of the building counts, including a password or admin page, but not a form post or calendar feed.
  assert.match((await get("/lofotgata/admin/login")).headers.get("set-cookie") ?? "", /vk_last=lofotgata/);
  assert.doesNotMatch((await post("/lofotgata/apartment", { apartment: "A1" })).headers.get("set-cookie") ?? "", /vk_last/);
  assert.doesNotMatch((await get("/lofotgata/cal/finnes-ikke.ics")).headers.get("set-cookie") ?? "", /vk_last/);
  for (const path of ["/visning", "/visning?embed=1", "/demo"]) assert.doesNotMatch((await get(path)).headers.get("set-cookie") ?? "", /vk_last/, path);
  assert.doesNotMatch((await get("/finnes-ikke")).headers.get("set-cookie") ?? "", /vk_last/);

  const html = await (await get("/", "vk_last=lofotgata")).text();
  assert.match(html, /<a class="go-last" href="\/lofotgata"><span>Gå til<\/span><span class="go-last-name">Lofotgata 12<\/span>/);
  for (const value of ["finnes-ikke", "visning", "demo", "..%2Fadmin", "<script>"])
    assert.doesNotMatch(await (await get("/", `vk_last=${value}`)).text(), /Gå til/, value);
});

// Every POST route under /<slug>, from the app's own route table: those of the building router and of every
// router mounted below it (admin, onboarding, ...), so a new write route is covered without editing this test.
const writeRoutes = () => app.routes.filter((r) => r.method === "POST" && r.path.startsWith("/:slug/")).map((r) => r.path.slice("/:slug".length));

test("the showcase refuses every write route, before any other check", async () => {
  await reset();
  const id = tenantId("visning");
  const booking = rows("SELECT id FROM bookings WHERE tenant_id = ? AND apartment = 'B2' LIMIT 1", id)[0].id;
  const machine = rows("SELECT id FROM machines WHERE tenant_id = ? LIMIT 1", id)[0].id;
  const routes = [...new Set(writeRoutes())];
  assert.ok(routes.length >= 20, `found ${routes.length} write routes`);
  for (const route of ["/book", "/admin/settings", "/admin/close", "/admin/delete", "/admin/kom-i-gang/maskiner"])
    assert.ok(routes.includes(route), `${route} in ${routes}`);
  const before = JSON.stringify([snapshot("visning"), rows("SELECT * FROM push_subscriptions WHERE tenant_id = ?", id)]);
  const tomorrow = addDays(osloToday(), 1);
  for (const route of routes) {
    const path = `/visning${route.replace(":id", String(machine))}`.replace(/\/$/, "");
    const body = {
      apartment: "B2",
      date: tomorrow,
      start: "600",
      mode: "pair",
      machine_id: String(machine),
      booking_id: String(booking),
      booking_ids: String(booking),
      note: "Ferdig litt før",
      preset: "done-soon",
      password: "x",
      name: "Nytt navn",
    };
    for (const cookie of ["vk_apt=B2", ""]) {
      const response = await post(path, body, cookie);
      assert.equal(response.status, 403, `${path} → ${response.status}`);
    }
  }
  await settle();
  assert.equal(JSON.stringify([snapshot("visning"), rows("SELECT * FROM push_subscriptions WHERE tenant_id = ?", id)]), before);
});

test("the showcase is seen as one apartment and shows no actions", async () => {
  const html = await (await get(`/visning?embed=1&date=${addDays(osloToday(), 1)}`)).text();
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /<details class="apartment-menu"/);
  assert.match(html, /<span class="apartment-chip">.*Leilighet <strong>B2<\/strong>/);
  assert.match(html, /Din tid/);
  assert.match(html, /2 venter på denne tiden/);
  assert.doesNotMatch(html, /\/admin/);
  // Viewing it writes nothing: no calendar link is made for its apartment.
  assert.equal(rows("SELECT COUNT(*) AS n FROM calendar_feeds WHERE tenant_id = ?", tenantId("visning"))[0].n, 0);
  // Embedded: no demo banner or footer.
  assert.doesNotMatch(html, /demo-banner/);
  assert.doesNotMatch(html, /<footer/);
  const page = await (await get("/visning")).text();
  assert.match(page, /Dette er en visning\. Ingenting kan endres her\.<\/span><a href="\/demo">Prøv demoen/);
});

test("the playground books and cancels, but comments and messages are ready-made choices only", async () => {
  await reset();
  const board = await (await get("/demo")).text();
  assert.match(board, /Demo: prøv så mye du vil\. Alt nullstilles hver natt\./);
  assert.doesNotMatch(board, /\/demo\/admin/);
  // Apartments come from a list, so none can be typed.
  assert.equal(flash(await post("/demo/apartment", { apartment: "Tulling" })), "bad-apt");
  assert.equal(flash(await post("/demo/apartment", { apartment: "D1" })), "apartment");

  const tomorrow = addDays(osloToday(), 1);
  const id = tenantId("demo");
  const [washer, dryer] = rows("SELECT id FROM machines WHERE tenant_id = ? ORDER BY sort_order", id).map((m) => m.id);
  const cookie = "vk_apt=D1";
  const mode = `pair-${washer}-${dryer}`;
  assert.equal(flash(await post("/demo/book", { date: tomorrow, start: "600", mode, note: "fritekst" }, cookie)), "invalid");
  assert.equal(flash(await post("/demo/book", { date: tomorrow, start: "600", mode }, cookie)), "booked");
  const ids = rows("SELECT id FROM bookings WHERE tenant_id = ? AND apartment = 'D1' AND cancelled_at IS NULL", id)
    .map((b) => b.id)
    .join(",");

  assert.equal(flash(await post("/demo/note", { booking_ids: ids, note: "Noe stygt" }, cookie)), "invalid");
  assert.equal(flash(await post("/demo/note", { booking_ids: ids, note: "Kan bytte tid, bare spør" }, cookie)), "note");
  assert.ok(rows("SELECT note FROM bookings WHERE id IN (SELECT value FROM json_each(?))", `[${ids}]`).every((b) => b.note === "Kan bytte tid, bare spør"));
  assert.equal(flash(await post("/demo/note", { booking_ids: ids, note: "" }, cookie)), "note");

  // The comment field is a list of choices, and "Send melding" has no free-text addition.
  const html = await (await get(`/demo?date=${tomorrow}`, cookie)).text();
  assert.match(html, /<select name="note"[^>]*><option value="">Ingen kommentar<\/option><option value="Ferdig litt før">/);
  assert.doesNotMatch(html, /<input name="note"/);
  assert.match(html, /Send melding til leil\./);

  const other = rows("SELECT id FROM bookings WHERE tenant_id = ? AND date = ? AND apartment != 'D1' ORDER BY start_min LIMIT 1", id, tomorrow)[0].id;
  assert.equal(flash(await post("/demo/message", { booking_id: String(other), preset: "done-soon", note: "Noe stygt" }, cookie)), "invalid");
  assert.equal(flash(await post("/demo/message", { booking_id: String(other), preset: "done-soon" }, cookie)), "message-sent");
  await settle();

  assert.equal(flash(await post("/demo/cancel", { booking_ids: ids }, cookie)), "cancelled");
  await settle();
});

test("a demo never takes over a device's notifications from a real building", async () => {
  await reset();
  const endpoint = "https://push.example/device-1";
  const keys = { p256dh: "key", auth: "auth" };
  const subscribe = (slug, apartment) =>
    worker.fetch(
      new Request(`http://localhost/${slug}/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost", Cookie: `vk_apt=${apartment}` },
        body: JSON.stringify({ endpoint, keys }),
      }),
      bindings,
      ctx,
    );
  assert.equal((await subscribe("lofotgata", "3B")).status, 200);
  const mapping = () => rows("SELECT t.slug, p.apartment FROM push_subscriptions p JOIN tenants t ON t.id = p.tenant_id WHERE p.endpoint = ?", endpoint);
  assert.deepEqual(mapping().map((r) => ({ ...r })), [{ slug: "lofotgata", apartment: "3B" }]);
  for (const slug of ["demo", "visning"]) assert.equal((await subscribe(slug, "D1")).status, 403, slug);
  assert.deepEqual(mapping().map((r) => ({ ...r })), [{ slug: "lofotgata", apartment: "3B" }]);

  // The playground's board offers no notifications, even on a waitlist; the neighbours can still get a message.
  const id = tenantId("demo");
  const taken = rows("SELECT machine_id, date, start_min FROM bookings WHERE tenant_id = ? AND date > ? AND apartment != 'D1' LIMIT 1", id, osloToday())[0];
  assert.equal(flash(await post("/demo/wait", { machine_id: String(taken.machine_id), date: taken.date, start: String(taken.start_min) }, "vk_apt=D1")), "waiting");
  const board = await (await get(`/demo?date=${taken.date}`, "vk_apt=D1")).text();
  assert.match(board, /Forlat venteliste/);
  assert.doesNotMatch(board, /push-banner/);
  assert.match(board, /Send melding til leil\./);
  sqlite.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
});

test("free text still works in an ordinary building", async () => {
  const tomorrow = addDays(osloToday(), 1);
  const cookie = "vk_apt=A1";
  const machine = rows("SELECT id FROM machines WHERE tenant_id = ?", tenantId("lofotgata"))[0].id;
  assert.equal(flash(await post("/lofotgata/book", { date: tomorrow, start: "600", mode: String(machine) }, cookie)), "booked");
  const id = rows("SELECT id FROM bookings WHERE tenant_id = ?", tenantId("lofotgata"))[0].id;
  assert.equal(flash(await post("/lofotgata/note", { booking_ids: String(id), note: "Hva som helst" }, cookie)), "note");
});

test("the nightly reset is idempotent and undoes what visitors did", async () => {
  await reset();
  const first = snapshot("demo");
  const tomorrow = addDays(osloToday(), 1);
  const [washer] = first.machines;
  assert.equal(flash(await post("/demo/apartment", { apartment: "D2" })), "apartment");
  assert.equal(flash(await post("/demo/book", { date: tomorrow, start: "600", mode: String(washer.id) }, "vk_apt=D2")), "booked");
  await get("/demo", "vk_apt=D2");
  assert.equal(rows("SELECT COUNT(*) AS n FROM calendar_feeds WHERE tenant_id = ?", tenantId("demo"))[0].n, 1);
  assert.notDeepEqual(snapshot("demo"), first);
  await reset();
  assert.deepEqual(snapshot("demo"), first);
  assert.equal(rows("SELECT COUNT(*) AS n FROM calendar_feeds WHERE tenant_id = ?", tenantId("demo"))[0].n, 0);
  assert.deepEqual(snapshot("visning").machines.length, 2);
  // Both demos, each exactly once.
  assert.equal(rows("SELECT COUNT(*) AS n FROM tenants WHERE slug IN ('visning', 'demo')")[0].n, 2);
});

test("the seed is placed relative to today: a nearly full tomorrow, the look-back and horizon filled", async () => {
  const at = (today) => {
    const statements = demo.demoSeed("visning", today);
    const [bookings, waits] = ["INSERT INTO bookings", "INSERT INTO waitlist"].map((sql) => statements.find((s) => s.sql.includes(sql)));
    const offset = (date) => (new Date(`${date}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000;
    const shift = (list) => JSON.parse(list.params[0]).map((r) => ({ ...r, date: offset(r.date) }));
    return { bookings: shift(bookings), waits: shift(waits) };
  };
  const a = at("2026-03-10");
  const b = at("2026-12-30");
  assert.deepEqual(a, b, "the same plan relative to any today, across month and year ends");
  const offsets = a.bookings.map((r) => r.date);
  assert.equal(Math.min(...offsets), -14);
  assert.equal(Math.max(...offsets), 13);
  const tomorrowSlots = new Set(a.bookings.filter((r) => r.date === 1).map((r) => r.start));
  assert.ok(tomorrowSlots.size >= 6, `tomorrow has ${tomorrowSlots.size} booked slots`);
  assert.ok(a.bookings.some((r) => r.date >= 0 && r.apartment === demo.SHOWCASE_VIEWER));
  assert.ok(a.waits.length > 0);
  // Comments in the seed are ready-made ones too.
  assert.ok(a.bookings.filter((r) => r.note).every((r) => demo.NOTE_PRESETS.includes(r.note)));

  // Seeded into the database, the dates follow the real today.
  await reset();
  const dates = snapshot("visning").bookings.map((r) => r.date);
  assert.equal(dates[0], addDays(osloToday(), -14));
  assert.equal(dates.at(-1), addDays(osloToday(), 13));
});

test("signup reserves the demo slugs", async () => {
  for (const slug of ["visning", "demo"]) {
    const check = await (await get(`/ny/sjekk?adresse=${slug}`)).json();
    assert.deepEqual(check, { free: false, message: "Denne adressen er reservert. Velg en annen." }, slug);
  }
});

test("a closed building gets no Gå til link and is not remembered", async () => {
  sqlite.prepare("UPDATE tenants SET closed_at = datetime('now') WHERE slug = 'lofotgata'").run();
  try {
    assert.doesNotMatch(await (await get("/", "vk_last=lofotgata")).text(), /Gå til/);
    assert.doesNotMatch((await get("/lofotgata")).headers.get("set-cookie") ?? "", /vk_last/);
    assert.doesNotMatch((await get("/lofotgata/admin/login")).headers.get("set-cookie") ?? "", /vk_last/);
  } finally {
    sqlite.prepare("UPDATE tenants SET closed_at = NULL WHERE slug = 'lofotgata'").run();
  }
  assert.match(await (await get("/", "vk_last=lofotgata")).text(), /Gå til/);
});

test("the unused-building cleanup never closes the demo buildings", async () => {
  // Even marked as self-signup, old, and without a single booking.
  sqlite.exec(
    "UPDATE tenants SET close_if_unused = 1, created_at = datetime('now', '-60 days') WHERE slug IN ('visning', 'demo');" +
      "DELETE FROM bookings WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('visning', 'demo'));",
  );
  await reset();
  assert.deepEqual(
    rows("SELECT slug, closed_at, close_if_unused FROM tenants WHERE slug IN ('visning', 'demo') ORDER BY slug").map((r) => ({ ...r })),
    [
      { slug: "demo", closed_at: null, close_if_unused: 0 },
      { slug: "visning", closed_at: null, close_if_unused: 0 },
    ],
  );
  assert.equal(rows("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('visning', 'demo'))")[0].n, 0);
  assert.equal((await get("/visning")).status, 200);
});
