import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Admin settings routes against the real Hono handlers and an isolated SQLite database,
// in the same style as bookings.test.mjs.
let worker, crypto, db, temp, sqlite;
const SECRET = "isolated-test-only";
const ADMIN_PASSWORD = "correct horse";

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

const fetchApp = (path, init = {}) =>
  worker.fetch(
    new Request(`http://localhost/demo${path ? `/${path}` : ""}`, { redirect: "manual", ...init }),
    { DB: db, SESSION_SECRET: SECRET, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" },
    { waitUntil: (promise) => promise.catch(() => {}) },
  );
const cookieFrom = (response, name) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`));
const post = (path, body, cookie) =>
  fetchApp(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost", Cookie: cookie ?? "" },
    body: new URLSearchParams(body),
  });
const get = (path, cookie) => fetchApp(path, { headers: { Cookie: cookie ?? "" } });
const tenant = () => sqlite.prepare("SELECT * FROM tenants WHERE id = 1").get();
const machines = () => sqlite.prepare("SELECT id, name, kind, sort_order, active FROM machines ORDER BY sort_order, kind DESC, id").all();
const location = (response) => new URL(response.headers.get("location"), "http://localhost");

async function login(password = ADMIN_PASSWORD) {
  const response = await post("admin/login", { password });
  return cookieFrom(response, "vk_admin");
}

let admin;
const schedule = (overrides = {}) => ({
  section: "tider",
  day_start: "08:00",
  day_end: "20:00",
  slot_min: "120",
  horizon: "14",
  max_active: "0",
  ...overrides,
});

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-admin-tests-"));
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
  crypto = await import(pathToFileURL(join(temp, "crypto.mjs")).href);
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
  for (const file of (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(await readFile(join("migrations", file), "utf8"));
  }
});

beforeEach(async () => {
  sqlite.exec("DELETE FROM machines; DELETE FROM tenants;");
  sqlite
    .prepare("INSERT INTO tenants (id, slug, name, admin_password_hash) VALUES (1, 'demo', 'Test', ?)")
    .run(await crypto.hashPassword(ADMIN_PASSWORD));
  sqlite.exec(
    "INSERT INTO machines (id, tenant_id, kind, name) VALUES (1, 1, 'washer', 'Vask 1'), (2, 1, 'dryer', 'Tørk 1'), (3, 1, 'washer', 'Vask 2')",
  );
  admin = await login();
});

after(async () => {
  sqlite?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

test("settings routes require an admin session", async () => {
  const response = await post("admin/settings", { section: "generelt", name: "Hacked" });
  assert.equal(response.status, 303);
  assert.equal(location(response).pathname, "/demo/admin/login");
  assert.equal(tenant().name, "Test");
});

test("schedule saves with each slot length in the picker", async () => {
  for (const slot of [30, 60, 90, 120, 180]) {
    const response = await post("admin/settings", schedule({ slot_min: String(slot) }), admin);
    assert.equal(response.status, 303, `slot ${slot}`);
    assert.equal(location(response).searchParams.get("m"), "saved");
    assert.equal(location(response).hash, "#tider");
    assert.equal(tenant().slot_min, slot);
  }
  const page = await (await get("admin/settings", admin)).text();
  assert.match(page, /4 tider per dag: 08–11, 11–14, 14–17, 17–20\./);
});

test("schedule rejects lengths outside the picker and shows the error next to the field", async () => {
  const response = await post("admin/settings", schedule({ slot_min: "45" }), admin);
  assert.equal(response.status, 422);
  const page = await response.text();
  assert.match(page, /id="slot_min-error"[^>]*>Velg en av lengdene\./);
  assert.match(page, /name="slot_min"[^>]*aria-invalid="true"/);
  assert.equal(tenant().slot_min, 120);

  const reversed = await post("admin/settings", schedule({ day_start: "20:00", day_end: "08:00" }), admin);
  assert.equal(reversed.status, 422);
  const reversedPage = await reversed.text();
  assert.match(reversedPage, /name="day_end"[^>]*aria-invalid="true"/);
  // Without JavaScript the error toast links to the card that failed.
  assert.match(reversedPage, /class="toast error" role="alert">[\s\S]*?<a href="#tider">/);
  // The submitted values are kept so the admin can correct them.
  assert.match(reversedPage, /name="day_start"[^>]*value="20:00"/);
  assert.equal(tenant().day_start_min, 480);

  const tooLong = await post("admin/settings", schedule({ day_start: "08:00", day_end: "10:00", slot_min: "180" }), admin);
  assert.equal(tooLong.status, 422);
  assert.match(await tooLong.text(), /lengre enn åpningstiden/);
});

test("a rejected slot length renders the error page promptly", { timeout: 5000 }, async () => {
  for (const slot_min of ["0", "-30", "", "0.5"]) {
    const response = await post("admin/settings", schedule({ slot_min }), admin);
    assert.equal(response.status, 422, `slot ${JSON.stringify(slot_min)}`);
    const page = await response.text();
    assert.match(page, /Velg en av lengdene\./);
    assert.match(page, /id="slot-preview"[^>]*>Velg en lengde per tid\./);
  }
  assert.equal(tenant().slot_min, 120);
});

test("each settings card only changes its own fields", async () => {
  assert.equal((await post("admin/settings", { section: "generelt", name: "  Borettslaget  " }, admin)).status, 303);
  assert.equal(tenant().name, "Borettslaget");
  assert.equal(tenant().slot_min, 120);
  assert.equal((await post("admin/settings", { section: "generelt", name: " " }, admin)).status, 422);
  assert.equal(tenant().name, "Borettslaget");
});

test("apartment list is normalized, deduplicated, and counted", async () => {
  const response = await post("admin/settings", { section: "leiligheter", apartments: "a1\nA2\n a 1 \nb3, B3" }, admin);
  assert.equal(response.status, 303);
  assert.equal(location(response).hash, "#leiligheter");
  assert.equal(tenant().apartments, "A1\nA2\nB3");
  const page = await (await get("admin/settings", admin)).text();
  assert.match(page, /3 leiligheter/);

  // Duplicates are flagged while they are still in the text box.
  const invalid = await post("admin/settings", { section: "leiligheter", apartments: `A1\nA1\n${"X".repeat(21)}` }, admin);
  assert.equal(invalid.status, 422);
  assert.match(await invalid.text(), /Duplikater: A1\./);

  await post("admin/settings", { section: "leiligheter", apartments: "" }, admin);
  assert.equal(tenant().apartments, null);
});

test("machines move up and down, including from equal legacy sort orders", async () => {
  assert.deepEqual(
    machines().map((m) => m.id),
    [1, 3, 2],
  );
  const response = await post("admin/machines/2/move", { dir: "up" }, admin);
  assert.equal(response.status, 303);
  assert.equal(location(response).hash, "#maskiner");
  assert.deepEqual(
    machines().map((m) => [m.id, m.sort_order]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  );
  await post("admin/machines/1/move", { dir: "down" }, admin);
  assert.deepEqual(
    machines().map((m) => m.id),
    [2, 1, 3],
  );
  // Moving past either end is a no-op.
  await post("admin/machines/2/move", { dir: "up" }, admin);
  await post("admin/machines/3/move", { dir: "down" }, admin);
  assert.deepEqual(
    machines().map((m) => m.id),
    [2, 1, 3],
  );
});

test("machines switch off and on, and are renamed in place", async () => {
  const off = await post("admin/machines/3/active", { active: "0" }, admin);
  assert.equal(location(off).searchParams.get("m"), "machine-off");
  assert.equal(machines().find((m) => m.id === 3).active, 0);
  const toast = await (await get("admin/settings?m=machine-off", admin)).text();
  assert.match(toast, /class="toast success auto" role="status">[\s\S]*?Maskinen er slått av\./);
  await post("admin/machines/3/active", { active: "1" }, admin);
  assert.equal(machines().find((m) => m.id === 3).active, 1);

  const renamed = await post("admin/machines/3", { name: " Vask 3 ", kind: "dryer" }, admin);
  assert.equal(renamed.status, 303);
  const row = machines().find((m) => m.id === 3);
  assert.deepEqual([row.name, row.kind, row.active], ["Vask 3", "dryer", 1]);

  const empty = await post("admin/machines/3", { name: "", kind: "dryer" }, admin);
  assert.equal(empty.status, 422);
  assert.match(await empty.text(), /id="machine-3-error"[^>]*>Gi maskinen et navn\./);
});

test("adding a machine appends it; errors reopen the dialog", async () => {
  const response = await post("admin/machines", { name: "Vask 4", kind: "washer" }, admin);
  assert.equal(location(response).searchParams.get("m"), "machine-added");
  assert.equal(machines().at(-1).name, "Vask 4");

  const invalid = await post("admin/machines", { name: "", kind: "washer" }, admin);
  assert.equal(invalid.status, 422);
  assert.match(await invalid.text(), /<dialog id="legg-til-maskin"[^>]* open=""/);
});

test("resident password: set, view, verify residents, change, and turn off", async () => {
  const set = await post("admin/access", { access_password: " 1234-dør " }, admin);
  assert.equal(set.status, 303);
  assert.equal(location(set).searchParams.get("m"), "access-on");
  const stored = tenant();
  assert.match(stored.access_password_enc, /^v1\./);
  assert.doesNotMatch(stored.access_password_enc, /1234/);
  // The encrypted value round-trips and is bound to this tenant.
  assert.equal(await crypto.decryptText(SECRET, stored.access_password_enc, "tenant:1:access-password"), "1234-dør");
  assert.equal(await crypto.decryptText(SECRET, stored.access_password_enc, "tenant:2:access-password"), null);
  assert.equal(await crypto.decryptText("another-secret", stored.access_password_enc, "tenant:1:access-password"), null);
  // The admin's own device stays signed in as a resident.
  assert.ok(cookieFrom(set, "vk_access"));

  const settings = await get("admin/settings", admin);
  assert.equal(settings.headers.get("cache-control"), "no-store");
  assert.match(await settings.text(), /<span class="secret-plain">1234-dør<\/span>/);

  // Residents are verified against the hash, and their cookie is bound to it.
  assert.equal(location(await get("")).pathname, "/demo/login");
  assert.equal(location(await post("login", { password: "wrong" })).searchParams.get("m"), "wrong-password");
  const resident = cookieFrom(await post("login", { password: "1234-dør" }), "vk_access");
  assert.equal((await get("", resident)).status, 200);

  const changed = await post("admin/access", { access_password: "5678" }, admin);
  assert.equal(location(changed).searchParams.get("m"), "access-changed");
  assert.equal((await get("", resident)).status, 302, "old resident cookies stop working");
  assert.match(await (await get("admin/settings", admin)).text(), /secret-plain">5678</);

  const off = await post("admin/access/off", {}, admin);
  assert.equal(location(off).searchParams.get("m"), "access-off");
  assert.equal(tenant().access_password_hash, null);
  assert.equal(tenant().access_password_enc, null);
  assert.equal((await get("")).status, 200);
});

test("an empty resident password is rejected instead of removing the password", async () => {
  await post("admin/access", { access_password: "1234" }, admin);
  const before = tenant();
  const response = await post("admin/access", { access_password: "   " }, admin);
  assert.equal(response.status, 422);
  const page = await response.text();
  assert.match(page, /Skriv inn et passord\./);
  assert.match(page, /<dialog id="beboerpassord"[^>]* open=""/);
  assert.equal(tenant().access_password_hash, before.access_password_hash);
  assert.equal(tenant().access_password_enc, before.access_password_enc);
});

test("a resident password set before this change asks for a new one to be viewable", async () => {
  sqlite.prepare("UPDATE tenants SET access_password_hash = ?").run(await crypto.hashPassword("legacy"));
  const page = await (await get("admin/settings", admin)).text();
  assert.match(page, /Sett et nytt passord for å kunne vise det\./);
  assert.doesNotMatch(page, /secret-plain/);
  // Legacy residents keep working until the password is changed.
  assert.equal((await get("", cookieFrom(await post("login", { password: "legacy" }), "vk_access"))).status, 200);
});

test("admin password keeps its rules: min 8 chars, hashed, other sessions logged out", async () => {
  const short = await post("admin/admin-password", { admin_password: "short", admin_password_confirm: "short" }, admin);
  assert.equal(short.status, 422);
  assert.match(await short.text(), /Adminpassordet må ha minst 8 tegn\./);

  const mismatch = await post("admin/admin-password", { admin_password: "new password", admin_password_confirm: "new passwrd" }, admin);
  assert.equal(mismatch.status, 422);
  assert.match(await mismatch.text(), /Passordene er ikke like\./);
  assert.ok(await crypto.verifyPassword(ADMIN_PASSWORD, tenant().admin_password_hash));

  const unconfirmed = await post("admin/admin-password", { admin_password: "new password" }, admin);
  assert.equal(unconfirmed.status, 422);
  assert.match(await unconfirmed.text(), /Passordene er ikke like\./);
  assert.ok(await crypto.verifyPassword(ADMIN_PASSWORD, tenant().admin_password_hash));

  const changed = await post("admin/admin-password", { admin_password: "new password", admin_password_confirm: "new password" }, admin);
  assert.equal(changed.status, 303);
  assert.equal(location(changed).searchParams.get("m"), "admin-password");
  assert.match(tenant().admin_password_hash, /^pbkdf2\$/);
  assert.ok(await crypto.verifyPassword("new password", tenant().admin_password_hash));
  const fresh = cookieFrom(changed, "vk_admin");
  assert.equal((await get("admin/settings", fresh)).status, 200);
  assert.equal(location(await get("admin/settings", admin)).pathname, "/demo/admin/login");
  assert.doesNotMatch(await (await get("admin/settings", fresh)).text(), /new password/);
  assert.equal(await login(ADMIN_PASSWORD), undefined);
  assert.ok(await login("new password"));
});

test("a dialog reopened after an error closes without JavaScript", async () => {
  const cases = [
    ["machines", { name: " ", kind: "washer" }, "legg-til-maskin", "maskiner"],
    ["access", { access_password: " " }, "beboerpassord", "tilgang"],
    ["admin-password", { admin_password: "new password", admin_password_confirm: "other" }, "adminpassord", "tilgang"],
  ];
  for (const [path, body, dialog, section] of cases) {
    const response = await post(`admin/${path}`, body, admin);
    assert.equal(response.status, 422, path);
    const sheet = (await response.text()).match(new RegExp(`<dialog id="${dialog}"[^>]* open=""[\\s\\S]*?</dialog>`))?.[0];
    assert.ok(sheet, `${dialog} is open`);
    const closers = [...sheet.matchAll(/<a href="([^"]*)"[^>]*data-dialog-close/g)].map((m) => m[1]);
    assert.deepEqual(closers, [`/demo/admin/settings#${section}`, `/demo/admin/settings#${section}`], dialog);
    const closed = await get(closers[0].slice("/demo/".length).split("#")[0], admin);
    assert.equal(closed.status, 200);
    assert.doesNotMatch(await closed.text(), /<dialog[^>]* open=""/);
  }
});

test("a machine error keeps the other settings fields intact", async () => {
  const response = await post("admin/machines/3", { name: "", kind: "washer" }, admin);
  assert.equal(response.status, 422);
  const page = await response.text();
  assert.match(page, /<input name="name" required="" maxlength="80" value="Test"/);
  assert.match(page, /class="toast error" role="alert">[\s\S]*?<a href="#maskin-3">/);
  const added = await post("admin/machines", { name: "x".repeat(61), kind: "dryer" }, admin);
  const addedPage = await added.text();
  assert.match(addedPage, /<input name="name" required="" maxlength="80" value="Test"/);
  assert.match(addedPage, /value="dryer" checked=""/);
});
