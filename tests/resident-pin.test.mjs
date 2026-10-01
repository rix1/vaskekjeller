import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// The resident PIN: validation, the 4-box markup, the login rate limit, and old free-text passwords.
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
    new Request(`http://localhost/bygg${path ? `/${path}` : ""}`, { redirect: "manual", ...init }),
    { DB: db, SESSION_SECRET: SECRET, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" },
    { waitUntil: (promise) => promise.catch(() => {}) },
  );
const cookieFrom = (response, name) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`));
const post = (path, body, cookie, ip = "203.0.113.1") =>
  fetchApp(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost", Cookie: cookie ?? "", "cf-connecting-ip": ip },
    body: new URLSearchParams(body),
  });
const get = (path, cookie) => fetchApp(path, { headers: { Cookie: cookie ?? "" } });
const tenant = () => sqlite.prepare("SELECT * FROM tenants WHERE id = 1").get();
const location = (response) => new URL(response.headers.get("location"), "http://localhost");
const attempts = () => sqlite.prepare("SELECT key, attempts FROM login_attempts").all();

let admin;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-pin-tests-"));
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
  sqlite.exec("DELETE FROM login_attempts; DELETE FROM machines; DELETE FROM tenants;");
  sqlite
    .prepare("INSERT INTO tenants (id, slug, name, admin_password_hash) VALUES (1, 'bygg', 'Test', ?)")
    .run(await crypto.hashPassword(ADMIN_PASSWORD));
  sqlite.exec("INSERT INTO machines (id, tenant_id, kind, name) VALUES (1, 1, 'washer', 'Vask 1')");
  admin = cookieFrom(await post("admin/login", { password: ADMIN_PASSWORD }), "vk_admin");
});

after(async () => {
  sqlite?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

const setPin = (pin) => post("admin/access", { access_password: pin }, admin);

test("the admin sets a PIN of exactly four digits; anything else is refused", async () => {
  for (const bad of ["", "123", "12345", "abcd", "12a4", "1234-dør"]) {
    const response = await setPin(bad);
    assert.equal(response.status, 422, bad);
    assert.equal(tenant().access_password_hash, null, bad);
  }
  assert.equal((await setPin(" 12 34 ")).status, 303, "spaces from a pasted code are ignored");
  const t = tenant();
  assert.equal(t.access_pin, 1);
  assert.equal(await crypto.decryptText(SECRET, t.access_password_enc, "tenant:1:access-password"), "1234");
  await post("admin/access/off", {}, admin);
  assert.equal(tenant().access_pin, 0);
});

test("the login page shows four boxes for a PIN and a text field for an old password", async () => {
  await setPin("4821");
  const pin = await (await get("login")).text();
  assert.match(pin, /data-pin="true"/);
  assert.match(pin, /inputmode="numeric"/);
  assert.match(pin, /autocomplete="one-time-code"/);
  assert.match(pin, /src="\/pin\.js"/);
  assert.doesNotMatch(pin, /type="password"/);

  sqlite
    .prepare("UPDATE tenants SET access_pin = 0, access_password_hash = ?")
    .run(await crypto.hashPassword("gammelt passord"));
  const legacy = await (await get("login")).text();
  assert.match(legacy, /type="password"/);
  assert.doesNotMatch(legacy, /data-pin/);
});

test("the settings dialog and the wizard step offer a Generate button", async () => {
  const page = await (await get("admin/settings", admin)).text();
  assert.match(page, /<dialog id="beboerpassord"[\s\S]*?data-pin="true"[^>]*data-generate=""/);
});

test("a PIN logs a resident in; a wrong one does not", async () => {
  await setPin("4821");
  const wrong = await post("login", { password: "1111" });
  assert.equal(location(wrong).searchParams.get("m"), "wrong-password");
  assert.equal(cookieFrom(wrong, "vk_access"), undefined);
  const right = await post("login", { password: "4821" });
  assert.equal(location(right).pathname, "/bygg");
  assert.ok(cookieFrom(right, "vk_access"));
});

test("an old free-text password keeps working until the admin sets a PIN", async () => {
  sqlite
    .prepare("UPDATE tenants SET access_password_hash = ?")
    .run(await crypto.hashPassword("gammelt passord"));
  assert.ok(cookieFrom(await post("login", { password: "gammelt passord" }), "vk_access"));
  assert.equal(location(await post("login", { password: "feil" })).searchParams.get("m"), "wrong-password");
  await setPin("4821");
  assert.equal(location(await post("login", { password: "gammelt passord" })).searchParams.get("m"), "wrong-password");
  assert.ok(cookieFrom(await post("login", { password: "4821" }), "vk_access"));
});

test("five wrong tries lock one network out of the building, even with the right PIN", async () => {
  await setPin("4821");
  for (let i = 0; i < 5; i++)
    assert.equal(location(await post("login", { password: `000${i}` })).searchParams.get("m"), "wrong-password");
  const locked = await post("login", { password: "4821" });
  assert.equal(location(locked).searchParams.get("m"), "too-many-attempts");
  assert.equal(cookieFrom(locked, "vk_access"), undefined);
  // Another network is not affected.
  assert.ok(cookieFrom(await post("login", { password: "4821" }, undefined, "198.51.100.7"), "vk_access"));
  // The refused try is not counted again.
  assert.ok(attempts().every((a) => a.attempts <= 5));
});

test("correct logins don't use up the allowance", async () => {
  await setPin("4821");
  for (let i = 0; i < 12; i++) assert.ok(cookieFrom(await post("login", { password: "4821" }), "vk_access"));
  assert.ok(attempts().every((a) => a.attempts === 0));
});

test("one building-wide cap stops guessing spread over many networks", async () => {
  await setPin("4821");
  for (let i = 0; i < 40; i++) await post("login", { password: "0000" }, undefined, `192.0.2.${i}`);
  const late = await post("login", { password: "4821" }, undefined, "198.51.100.99");
  assert.equal(location(late).searchParams.get("m"), "too-many-attempts");
});

test("the raw address is never stored", async () => {
  await setPin("4821");
  await post("login", { password: "0000" });
  assert.ok(attempts().length > 0);
  assert.ok(attempts().every((a) => !a.key.includes("203.0.113")));
});
