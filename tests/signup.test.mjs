import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Signup, onboarding, recovery codes and the share step against the real Hono handlers and an
// isolated SQLite database, in the same style as admin.test.mjs.
let worker, lib, db, temp, sqlite;
const SECRET = "isolated-test-only";
const PASSWORD = "correct horse";
const realFetch = globalThis.fetch;

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

let env;
const baseEnv = () => ({ DB: db, SESSION_SECRET: SECRET, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "", TURNSTILE_SITE_KEY: "" });

/** A tiny cookie jar per "browser". */
function browser({ origin = "http://localhost", ip = "203.0.113.7", headers: extra = {} } = {}) {
  const jar = new Map();
  const fetchApp = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", ip);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    if (jar.size) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await worker.fetch(new Request(`${origin}${path}`, { redirect: "manual", ...init, headers }), env, {
      waitUntil: (promise) => promise.catch(() => {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (!value || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  return {
    jar,
    get: (path) => fetchApp(path),
    post: (path, body) =>
      fetchApp(path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
        body: new URLSearchParams(body),
      }),
  };
}

const location = (response) => new URL(response.headers.get("location"), "http://localhost");
const auditLog = (tenantId) =>
  sqlite.prepare("SELECT action, detail, device FROM audit_log WHERE tenant_id = ? ORDER BY id").all(tenantId);
const tenant = (slug) => sqlite.prepare("SELECT * FROM tenants WHERE slug = ?").get(slug);
const machines = (tenantId) =>
  sqlite.prepare("SELECT kind, name, active FROM machines WHERE tenant_id = ? ORDER BY sort_order, id").all(tenantId);
const signupBody = (overrides = {}) => ({
  navn: "Lofotgata Borettslag",
  adresse: "lofotgata",
  username: "lofotgata-admin",
  admin_password: PASSWORD,
  admin_password_confirm: PASSWORD,
  ...overrides,
});

async function signUp(b = browser(), overrides = {}) {
  const response = await b.post("/ny/passord", signupBody(overrides));
  assert.equal(response.status, 303, await response.clone().text());
  return { b, response, slug: overrides.adresse ?? "lofotgata" };
}

/** Stubs Siteverify and records what the worker sent to it. */
function siteverify(reply) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    calls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-signup-tests-"));
  await build({
    entryPoints: { worker: "src/index.tsx", signup: "src/signup.ts", recovery: "src/recovery.ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    outdir: temp,
    outExtension: { ".js": ".mjs" },
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  });
  worker = (await import(pathToFileURL(join(temp, "worker.mjs")).href)).default;
  lib = {
    ...(await import(pathToFileURL(join(temp, "signup.mjs")).href)),
    ...(await import(pathToFileURL(join(temp, "recovery.mjs")).href)),
  };
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

beforeEach(() => {
  env = baseEnv();
  sqlite.exec("DELETE FROM audit_log; DELETE FROM bookings; DELETE FROM calendar_feeds; DELETE FROM machines; DELETE FROM tenants; DELETE FROM signup_counts;");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  sqlite?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Web addresses
// ---------------------------------------------------------------------------

test("slugify turns Norwegian names into web addresses", () => {
  assert.equal(lib.slugify("Borettslaget Lofotgata 12"), "borettslaget-lofotgata-12");
  assert.equal(lib.slugify("Kjærlighetsstien Øst/Vest"), "kjaerlighetsstien-ost-vest");
  assert.equal(lib.slugify("Åsgården"), "asgarden");
  assert.equal(lib.slugify("Grünerløkka Brl."), "grunerlokka-brl");
  assert.equal(lib.slugify("  --Hei!!  "), "hei");
  assert.equal(lib.slugify("x".repeat(60)).length, lib.SLUG_MAX);
});

test("address rules: format, length and reserved words", () => {
  assert.equal(lib.slugProblem("lofotgata-12"), undefined);
  assert.match(lib.slugProblem("ab"), /minst 3 tegn/);
  assert.match(lib.slugProblem("Lofotgata"), /små bokstaver/);
  assert.match(lib.slugProblem("lofot--gata"), /Bindestrek/);
  assert.match(lib.slugProblem("-lofot"), /Bindestrek/);
  for (const reserved of ["admin", "ny", "om", "cal", "api", "demo", "visning", "static", "assets"])
    assert.match(lib.slugProblem(reserved), /reservert/, reserved);
});

test("the suggested address skips taken and reserved ones", async () => {
  const b = browser();
  let page = await (await b.get("/ny/adresse?navn=Lofotgata")).text();
  assert.match(page, /name="adresse"[^>]*value="lofotgata"/);
  assert.match(page, /Ledig\./);
  await signUp();
  page = await (await b.get("/ny/adresse?navn=Lofotgata")).text();
  assert.match(page, /value="lofotgata-2"/);
  page = await (await b.get("/ny/adresse?navn=Admin")).text();
  assert.match(page, /value="admin-2"/);
  page = await (await b.get("/ny/adresse?navn=%C3%98")).text();
  assert.match(page, /value="vask-o"/);
});

test("the live check reports free, taken, reserved and malformed addresses", async () => {
  await signUp();
  const check = async (slug) => (await browser().get(`/ny/sjekk?adresse=${encodeURIComponent(slug)}`)).json();
  assert.deepEqual(await check("nabogata"), { free: true, message: "Ledig." });
  assert.equal((await check("lofotgata")).free, false);
  assert.match((await check("lofotgata")).message, /allerede i bruk/);
  assert.match((await check("admin")).message, /reservert/);
  assert.match((await check("lofot_gata")).message, /små bokstaver/);
  assert.equal((await check("Nabogata")).free, true, "typed capitals are lowercased");
});

// ---------------------------------------------------------------------------
// Steps 1–3
// ---------------------------------------------------------------------------

test("the first steps are plain GET forms that work without JavaScript", async () => {
  const b = browser();
  const name = await b.get("/ny");
  assert.equal(name.status, 200);
  const namePage = await name.text();
  assert.match(namePage, /<form method="get" action="\/ny\/adresse"/);
  assert.match(namePage, /STEG 1 AV 8/);

  const noName = await b.get("/ny/adresse?navn=+");
  assert.equal(noName.status, 422);
  assert.match(await noName.text(), /Skriv inn et navn\./);

  const address = await (await b.get("/ny/adresse?navn=Lofotgata")).text();
  assert.match(address, /<form method="get" action="\/ny\/passord"/);
  assert.match(address, /<input type="hidden" name="navn" value="Lofotgata"/);
  assert.match(address, /localhost\/<\/span>|<span>localhost<\/span>\//);

  const password = await (await b.get("/ny/passord?navn=Lofotgata&adresse=lofotgata")).text();
  assert.match(password, /<form method="post" action="\/ny\/passord"/);
  assert.match(password, /localhost\/lofotgata/);
  // Locally without a Turnstile secret there is no widget.
  assert.doesNotMatch(password, /cf-turnstile|challenges\.cloudflare\.com/);
});

test("a taken or invalid address sends you back to the address step", async () => {
  await signUp();
  const b = browser({ ip: "198.51.100.1" });
  for (const slug of ["lofotgata", "admin", "a b"]) {
    const response = await b.get(`/ny/passord?navn=X&adresse=${encodeURIComponent(slug)}`);
    assert.equal(response.status, 422, slug);
    assert.match(await response.text(), /STEG 2 AV 8/);
  }
  const post = await b.post("/ny/passord", signupBody());
  assert.equal(post.status, 422);
  assert.match(await post.text(), /allerede i bruk/);
});

test("signup creates the building with a washer and a dryer and signs you in as admin", async () => {
  const { b, response } = await signUp();
  assert.equal(location(response).pathname, "/lofotgata/admin/kom-i-gang/tider");
  const t = tenant("lofotgata");
  assert.equal(t.name, "Lofotgata Borettslag");
  assert.equal(t.close_if_unused, 1);
  assert.match(t.admin_password_hash, /^pbkdf2\$/);
  assert.deepEqual(
    machines(t.id).map((m) => [m.kind, m.name, m.active]),
    [
      ["washer", "Vaskemaskin", 1],
      ["dryer", "Tørketrommel", 1],
    ],
  );
  assert.ok(b.jar.has("vk_admin"));
  const hours = await b.get("/lofotgata/admin/kom-i-gang/tider");
  assert.equal(hours.status, 200);
  assert.match(await hours.text(), /Lofotgata Borettslag er opprettet/);
  // And the admin can log in with the chosen password.
  const login = await browser().post("/lofotgata/admin/login", { password: PASSWORD });
  assert.equal(location(login).pathname, "/lofotgata/admin");
});

test("a short or mismatched admin password creates nothing", async () => {
  const b = browser();
  let response = await b.post("/ny/passord", signupBody({ admin_password: "short", admin_password_confirm: "short" }));
  assert.equal(response.status, 422);
  assert.match(await response.text(), /minst 8 tegn/);
  response = await b.post("/ny/passord", signupBody({ admin_password_confirm: "something else" }));
  assert.equal(response.status, 422);
  assert.match(await response.text(), /Passordene er ikke like/);
  assert.equal(tenant("lofotgata"), undefined);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM signup_counts").get().n, 0);
});

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

test("a deployment without Turnstile keys keeps signup closed", async () => {
  const b = browser({ origin: "https://vask.example" });
  const page = await b.get("/ny");
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Registreringen er ikke åpen ennå/);
  assert.equal((await b.post("/ny/passord", signupBody())).status, 503);
  env.TURNSTILE_SECRET_KEY = "secret";
  assert.equal((await b.get("/ny")).status, 503, "the site key is missing");
  assert.equal(tenant("lofotgata"), undefined);
});

test("local dev skips Turnstile only on localhost without a secret, never on a real Cloudflare request", async () => {
  // wrangler dev rewrites the URL to the custom domain; the loopback client address shows it is local.
  const local = browser({ origin: "http://www.vaskekjeller.no", ip: "127.0.0.1" });
  assert.equal((await local.get("/ny")).status, 200);
  const lan = browser({ origin: "http://www.vaskekjeller.no", ip: "192.168.1.20" });
  assert.equal((await lan.get("/ny")).status, 503, "other devices on the network need the test keys");
  // Cloudflare sets cf-ray (and the real cf-connecting-ip) on every request, so forged headers can't open signup.
  const forged = browser({ origin: "https://www.vaskekjeller.no", ip: "127.0.0.1", headers: { "cf-ray": "8a1b2c3d4e5f-OSL" } });
  assert.equal((await forged.get("/ny")).status, 503);
  assert.equal((await forged.post("/ny/passord", signupBody())).status, 503);
  const forgedLocalhost = browser({ headers: { "cf-ray": "8a1b2c3d4e5f-OSL" } });
  assert.equal((await forgedLocalhost.get("/ny")).status, 503);
  assert.equal(tenant("lofotgata"), undefined);
});

test("with Turnstile on, the form carries the widget and the server verifies the token", async () => {
  env.TURNSTILE_SITE_KEY = "0x4AAAAsitekey";
  env.TURNSTILE_SECRET_KEY = "0x4AAAAsecret";
  const b = browser({ origin: "https://vask.example" });
  const page = await (await b.get("/ny/passord?navn=Lofotgata&adresse=lofotgata")).text();
  assert.match(page, /<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async="" defer=""><\/script>/);
  assert.match(page, /class="cf-turnstile" data-sitekey="0x4AAAAsitekey" data-action="signup"/);

  let calls = siteverify({ success: true, action: "signup", hostname: "vask.example" });
  let response = await b.post("/ny/passord", signupBody());
  assert.equal(response.status, 403, "no token");
  assert.equal(calls.length, 0);

  response = await b.post("/ny/passord", signupBody({ "cf-turnstile-response": "token-1" }));
  assert.equal(response.status, 303);
  assert.deepEqual(calls, [{ secret: "0x4AAAAsecret", response: "token-1", remoteip: "203.0.113.7" }]);
  assert.ok(tenant("lofotgata"));
});

test("Turnstile answers for another site, another action, a failure or no answer are rejected", async () => {
  env.TURNSTILE_SITE_KEY = "0x4AAAAsitekey";
  env.TURNSTILE_SECRET_KEY = "0x4AAAAsecret";
  const b = browser({ origin: "https://vask.example" });
  for (const reply of [
    { success: true, action: "signup", hostname: "evil.example" },
    { success: true, action: "login", hostname: "vask.example" },
    { success: false, "error-codes": ["timeout-or-duplicate"] },
    new Error("network down"),
  ]) {
    siteverify(reply);
    const response = await b.post("/ny/passord", signupBody({ "cf-turnstile-response": "token" }));
    assert.equal(response.status, 403, JSON.stringify(reply?.message ?? reply));
    assert.match(await response.text(), /robot/);
  }
  assert.equal(tenant("lofotgata"), undefined);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM signup_counts").get().n, 0, "failed checks use no signups");
});

test("Cloudflare's test secret passes without the hostname and action checks", async () => {
  env.TURNSTILE_SITE_KEY = "1x00000000000000000000BB";
  env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
  siteverify({ success: true, hostname: "example.com", action: "" });
  await signUp(browser({ origin: "http://192.168.1.20:8787" }), { "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" });
});

// ---------------------------------------------------------------------------
// Signups per network per day
// ---------------------------------------------------------------------------

test("each network can create 3 buildings a day, counted without storing the address", async () => {
  const home = browser({ ip: "203.0.113.7" });
  for (const slug of ["en-gard", "to-gard", "tre-gard"]) await signUp(home, { adresse: slug });
  const fourth = await home.post("/ny/passord", signupBody({ adresse: "fire-gard" }));
  assert.equal(fourth.status, 429);
  assert.match(await fourth.text(), /for mange vaskekjellere fra dette nettverket/);
  assert.equal(tenant("fire-gard"), undefined);
  await signUp(browser({ ip: "198.51.100.1" }), { adresse: "fire-gard" });

  const rows = sqlite.prepare("SELECT * FROM signup_counts").all();
  assert.deepEqual(
    rows.map((r) => r.created).sort(),
    [1, 3],
  );
  for (const row of rows) {
    assert.match(row.network, /^[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(row), /203\.0\.113|198\.51\.100/);
  }
});

test("IPv6 addresses in the same /64 count as one network", async () => {
  assert.equal(lib.networkOf("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2");
  assert.equal(lib.networkOf("2001:0db8:0001:0002::9"), "2001:db8:1:2");
  assert.equal(lib.networkOf("2001:db8::1"), "2001:db8:0:0");
  assert.equal(lib.networkOf("203.0.113.7"), "203.0.113.7");
  for (const [i, slug] of ["en-gard", "to-gard", "tre-gard"].entries()) await signUp(browser({ ip: `2001:db8:1:2::${i + 1}` }), { adresse: slug });
  assert.equal((await browser({ ip: "2001:db8:1:2:ffff::1" }).post("/ny/passord", signupBody({ adresse: "fire-gard" }))).status, 429);
});

test("the daily cron drops old signup counts", async () => {
  sqlite.exec("INSERT INTO signup_counts (day, network, created) VALUES ('2020-01-01', 'old', 1), ('2999-01-01', 'future', 1)");
  await worker.scheduled({}, env);
  assert.deepEqual(
    sqlite.prepare("SELECT network FROM signup_counts").all().map((r) => r.network),
    ["future"],
  );
});

// ---------------------------------------------------------------------------
// Steps 4–8
// ---------------------------------------------------------------------------

test("onboarding pages need the new building's admin session", async () => {
  await signUp();
  const stranger = browser();
  for (const step of ["tider", "maskiner", "beboere", "kode", "del"]) {
    const response = await stranger.get(`/lofotgata/admin/kom-i-gang/${step}`);
    assert.equal(response.status, 303, step);
    assert.equal(location(response).pathname, "/lofotgata/admin/login");
  }
});

test("opening hours and slot length save and move on to machines", async () => {
  const { b } = await signUp();
  const bad = await b.post("/lofotgata/admin/kom-i-gang/tider", { day_start: "20:00", day_end: "08:00", slot_min: "90" });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Siste tid må slutte etter/);
  const ok = await b.post("/lofotgata/admin/kom-i-gang/tider", { day_start: "07:00", day_end: "22:00", slot_min: "90" });
  assert.equal(location(ok).pathname, "/lofotgata/admin/kom-i-gang/maskiner");
  const t = tenant("lofotgata");
  assert.deepEqual([t.day_start_min, t.day_end_min, t.slot_min], [420, 1320, 90]);
});

test("machine counts add, number, switch off and switch back on machines", async () => {
  const { b } = await signUp();
  const id = tenant("lofotgata").id;
  const page = await (await b.get("/lofotgata/admin/kom-i-gang/maskiner")).text();
  assert.match(page, /name="washer"[^>]*value="1"/);
  assert.match(page, /name="dryer"[^>]*value="1"/);

  let response = await b.post("/lofotgata/admin/kom-i-gang/maskiner", { washer: "2", dryer: "0" });
  assert.equal(location(response).pathname, "/lofotgata/admin/kom-i-gang/beboere");
  assert.deepEqual(
    machines(id).map((m) => [m.name, m.active]),
    [
      ["Vaskemaskin 1", 1],
      ["Vaskemaskin 2", 1],
      ["Tørketrommel", 0],
    ],
  );

  await b.post("/lofotgata/admin/kom-i-gang/maskiner", { washer: "1", dryer: "1" });
  assert.deepEqual(
    machines(id).map((m) => [m.name, m.active]),
    [
      ["Vaskemaskin", 1],
      ["Tørketrommel", 1],
      ["Vaskemaskin 2", 0],
    ],
    "the dryer comes back instead of a new one",
  );

  for (const body of [{ washer: "0", dryer: "0" }, { washer: "11", dryer: "1" }, { washer: "", dryer: "1" }]) {
    response = await b.post("/lofotgata/admin/kom-i-gang/maskiner", body);
    assert.equal(response.status, 422, JSON.stringify(body));
  }
});

test("renamed machines keep their names when the count changes", async () => {
  const { b } = await signUp();
  const id = tenant("lofotgata").id;
  sqlite.prepare("UPDATE machines SET name = 'Den gamle' WHERE tenant_id = ? AND kind = 'washer'").run(id);
  await b.post("/lofotgata/admin/kom-i-gang/maskiner", { washer: "2", dryer: "1" });
  assert.deepEqual(
    machines(id).map((m) => m.name),
    ["Den gamle", "Vaskemaskin 2", "Tørketrommel"],
  );
});

test("the resident password is optional, readable, and the next step shows a new recovery code once", async () => {
  const { b } = await signUp();
  const empty = await b.post("/lofotgata/admin/kom-i-gang/beboere", { passord: "ja", access_password: " " });
  assert.equal(empty.status, 422);
  assert.equal(tenant("lofotgata").recovery_code_hash, null, "no code before the step is done");

  sqlite.prepare("INSERT INTO calendar_feeds (tenant_id, apartment, token) VALUES (?, 'A1', 'feed-token')").run(tenant("lofotgata").id);
  const response = await b.post("/lofotgata/admin/kom-i-gang/beboere", { passord: "ja", access_password: "1234-dør" });
  assert.equal(location(response).pathname, "/lofotgata/admin/kom-i-gang/kode");
  const t = tenant("lofotgata");
  assert.equal(sqlite.prepare("SELECT password_key FROM calendar_feeds").get().password_key, "retired", "old calendar links stop working");
  assert.ok(t.access_password_hash && t.access_password_enc);
  assert.ok(b.jar.has("vk_access"), "the admin's device stays signed in as a resident");
  assert.match(await (await b.get("/lofotgata/admin/kom-i-gang/beboere")).text(), /value="1234-dør"/);

  const code = /id="recovery-code-value">([^<]+)</.exec(await (await b.get("/lofotgata/admin/kom-i-gang/kode")).text())?.[1];
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
  assert.equal(await lib.recoveryHash(t.id, code), t.recovery_code_hash);
  assert.doesNotMatch(JSON.stringify(tenant("lofotgata")), new RegExp(code));

  const file = await b.get("/lofotgata/admin/gjenopprettingskode.txt");
  assert.match(file.headers.get("content-disposition"), /attachment; filename="vaskekjeller-lofotgata-gjenopprettingskode\.txt"/);
  assert.equal(file.headers.get("cache-control"), "no-store");
  const text = await file.text();
  assert.match(text, new RegExp(code));
  assert.match(text, /Lagre denne – den er eneste måte å nullstille adminpassordet på\./);
  assert.match(text, /http:\/\/localhost\/lofotgata\/admin\/nullstill/);

  // Going back to step 6 keeps the code; "Fortsett" hides it for good.
  await b.post("/lofotgata/admin/kom-i-gang/beboere", { passord: "nei" });
  assert.equal(tenant("lofotgata").recovery_code_hash, t.recovery_code_hash);
  assert.equal(tenant("lofotgata").access_password_hash, null);
  const done = await b.post("/lofotgata/admin/kom-i-gang/kode", { lagret: "1" });
  assert.equal(location(done).pathname, "/lofotgata/admin/kom-i-gang/del");
  const again = await (await b.get("/lofotgata/admin/kom-i-gang/kode")).text();
  assert.doesNotMatch(again, new RegExp(code));
  assert.match(again, /Koden er allerede vist/);
  assert.equal(location(await b.get("/lofotgata/admin/gjenopprettingskode.txt")).pathname, "/lofotgata/admin/settings");
});

test("the share step has ready messages for residents and admins, without the admin password", async () => {
  const { b } = await signUp();
  await b.post("/lofotgata/admin/kom-i-gang/beboere", { passord: "ja", access_password: "1234-dør" });
  const response = await b.get("/lofotgata/admin/kom-i-gang/del");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const page = await response.text();
  const message = (id) => /<textarea id="([^"]+)"[^>]*>([^<]*)<\/textarea>/g;
  const texts = Object.fromEntries([...page.matchAll(message())].map((m) => [m[1], m[2]]));
  const residents = texts["melding-beboere"];
  const admins = texts["melding-admin"];
  assert.match(residents, /Åpne: http:\/\/localhost\/lofotgata\n/);
  assert.match(residents, /Passord: 1234-dør/);
  assert.match(residents, /velger du leilighetsnummeret ditt/);
  assert.match(residents, /Hjem-skjermen/);
  assert.match(residents, /varsler/);
  assert.match(admins, /Adminsiden: http:\/\/localhost\/lofotgata\/admin/);
  assert.match(admins, /Passordet får du av meg\./);
  assert.match(admins, /gjenopprettingskoden/);
  assert.doesNotMatch(page, new RegExp(PASSWORD));
  assert.match(page, /data-copy="#melding-beboere"/);
  assert.match(page, /data-share="#melding-beboere"/);
  assert.match(page, /data-copy="#melding-admin"/);
  assert.match(page, /<a href="\/lofotgata" class="button">/, "app links stay relative");

  await b.post("/lofotgata/admin/kom-i-gang/beboere", { passord: "nei" });
  const open = await (await b.get("/lofotgata/admin/kom-i-gang/del")).text();
  assert.doesNotMatch(open, /Passord:/);
});

// ---------------------------------------------------------------------------
// Recovery codes in admin
// ---------------------------------------------------------------------------

async function withCode() {
  const { b } = await signUp();
  await b.post("/lofotgata/admin/kom-i-gang/beboere", { passord: "nei" });
  const code = /id="recovery-code-value">([^<]+)</.exec(await (await b.get("/lofotgata/admin/kom-i-gang/kode")).text())[1];
  await b.post("/lofotgata/admin/kom-i-gang/kode", { lagret: "1" });
  return { b, code };
}

test("the admin login links to the reset, which rejects a wrong code", async () => {
  await withCode();
  const login = await (await browser().get("/lofotgata/admin/login")).text();
  assert.match(login, /href="\/lofotgata\/admin\/nullstill">Glemt adminpassordet\?/);
  const b = browser();
  assert.equal((await b.get("/lofotgata/admin/nullstill")).status, 200);
  const wrong = await b.post("/lofotgata/admin/nullstill", {
    recovery_code: "0000-0000-0000-0000-0000",
    admin_password: "new password",
    admin_password_confirm: "new password",
  });
  assert.equal(wrong.status, 422);
  assert.match(await wrong.text(), /Koden stemmer ikke/);
  assert.equal(location(await browser().post("/lofotgata/admin/login", { password: PASSWORD })).pathname, "/lofotgata/admin");
});

test("the recovery code resets the admin password once and is replaced by a new one", async () => {
  const { code } = await withCode();
  const old = tenant("lofotgata");
  const b = browser();
  const response = await b.post("/lofotgata/admin/nullstill", {
    // Typed sloppily: lowercase, spaces instead of dashes.
    recovery_code: code.toLowerCase().replace(/-/g, " "),
    admin_password: "new password",
    admin_password_confirm: "new password",
  });
  assert.equal(response.status, 303);
  const target = location(response);
  assert.equal(target.pathname, "/lofotgata/admin/settings");
  assert.equal(target.searchParams.get("vis"), "kode");
  const now = tenant("lofotgata");
  assert.notEqual(now.recovery_code_hash, old.recovery_code_hash);
  assert.notEqual(now.admin_password_hash, old.admin_password_hash);

  const settings = await (await b.get(`${target.pathname}${target.search}`)).text();
  const fresh = /id="recovery-code-value">([^<]+)</.exec(settings)?.[1];
  assert.ok(fresh && fresh !== code);
  assert.match(settings, /<dialog id="gjenopprettingskode"[^>]*open=""/);

  assert.equal(location(await browser().post("/lofotgata/admin/login", { password: PASSWORD })).pathname, "/lofotgata/admin/login");
  assert.equal(location(await browser().post("/lofotgata/admin/login", { password: "new password" })).pathname, "/lofotgata/admin");
  const reused = await browser().post("/lofotgata/admin/nullstill", {
    recovery_code: code,
    admin_password: "third password",
    admin_password_confirm: "third password",
  });
  assert.equal(reused.status, 422, "the old code is used up");
});

test("a double-submitted reset with the same code succeeds once, and the winner sees the new code", async () => {
  const { code } = await withCode();
  const id = tenant("lofotgata").id;
  const before = auditLog(id).length;
  const tabs = [browser(), browser()];
  const responses = await Promise.all(
    tabs.map((b, i) =>
      b.post("/lofotgata/admin/nullstill", {
        recovery_code: code,
        admin_password: `new password ${i}`,
        admin_password_confirm: `new password ${i}`,
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [303, 422]);
  const winner = responses.findIndex((r) => r.status === 303);
  const loser = 1 - winner;
  assert.equal(auditLog(id).length, before + 1, "one reset, one log entry");

  const settings = await (await tabs[winner].get(`${location(responses[winner]).pathname}?vis=kode`)).text();
  const fresh = /id="recovery-code-value">([^<]+)</.exec(settings)?.[1];
  assert.ok(fresh, "the winner stays logged in and sees the new code");
  assert.equal(await lib.recoveryHash(id, fresh), tenant("lofotgata").recovery_code_hash);
  assert.equal(location(await tabs[loser].get("/lofotgata/admin/settings")).pathname, "/lofotgata/admin/login");
  assert.equal(
    location(await browser().post("/lofotgata/admin/login", { password: `new password ${winner}` })).pathname,
    "/lofotgata/admin",
  );
});

test("admins can make a new code from the settings; the old one stops working", async () => {
  const { b, code } = await withCode();
  assert.equal(location(await browser().post("/lofotgata/admin/recovery", {})).pathname, "/lofotgata/admin/login");
  let settings = await (await b.get("/lofotgata/admin/settings")).text();
  assert.match(settings, /Gjenopprettingskode/);
  assert.match(settings, /data-dialog="ny-gjenopprettingskode"[^>]*>\s*Lag ny/);
  assert.doesNotMatch(settings, /recovery-code-value/);

  const response = await b.post("/lofotgata/admin/recovery", {});
  const target = location(response);
  assert.equal(target.searchParams.get("m"), "recovery-new");
  settings = await (await b.get(`${target.pathname}${target.search}`)).text();
  const fresh = /id="recovery-code-value">([^<]+)</.exec(settings)[1];
  assert.notEqual(fresh, code);
  assert.equal(await lib.recoveryHash(tenant("lofotgata").id, fresh), tenant("lofotgata").recovery_code_hash);
  assert.equal(await lib.recoveryHash(tenant("lofotgata").id, code) === tenant("lofotgata").recovery_code_hash, false);

  await b.post("/lofotgata/admin/recovery/lagret", { lagret: "1" });
  assert.doesNotMatch(await (await b.get("/lofotgata/admin/settings?vis=kode")).text(), /recovery-code-value/);
});

test("a code made on one device is not shown on another", async () => {
  const { b } = await withCode();
  await b.post("/lofotgata/admin/recovery", {});
  const other = browser();
  await other.post("/lofotgata/admin/login", { password: PASSWORD });
  assert.doesNotMatch(await (await other.get("/lofotgata/admin/settings?vis=kode")).text(), /recovery-code-value/);
});

test("recovery codes: format, typing mistakes and hashing", async () => {
  const code = lib.newRecoveryCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
  assert.notEqual(code, lib.newRecoveryCode());
  assert.equal(lib.normalizeRecoveryCode("abcd efgh-ijkl mnop-qrs0"), "ABCDEFGH1JK1MN0PQRS0");
  assert.equal(await lib.recoveryHash(1, code), await lib.recoveryHash(1, code.toLowerCase()));
  assert.notEqual(await lib.recoveryHash(1, code), await lib.recoveryHash(2, code));
});

// ---------------------------------------------------------------------------
// Activity log and the cleanup of unused buildings
// ---------------------------------------------------------------------------

test("signup, onboarding and recovery codes are written to the activity log", async () => {
  const { b } = await signUp();
  const id = tenant("lofotgata").id;
  await b.post("/lofotgata/admin/kom-i-gang/tider", { day_start: "07:00", day_end: "22:00", slot_min: "90" });
  await b.post("/lofotgata/admin/kom-i-gang/tider", { day_start: "07:00", day_end: "22:00", slot_min: "90" });
  await b.post("/lofotgata/admin/kom-i-gang/maskiner", { washer: "1", dryer: "1" });
  await b.post("/lofotgata/admin/kom-i-gang/maskiner", { washer: "2", dryer: "1" });
  await b.post("/lofotgata/admin/kom-i-gang/beboere", { passord: "ja", access_password: "1234" });
  await b.post("/lofotgata/admin/recovery", {});
  assert.deepEqual(
    auditLog(id).map((e) => [e.action, e.detail]),
    [
      ["building", "Opprettet vaskekjelleren «Lofotgata Borettslag»"],
      ["settings", "Tider: 07:00–22:00, 90 min per tid"],
      ["machine", "Maskiner: 2 vaskemaskiner, 1 tørketrommel"],
      ["access-password", "Slo på beboerpassord"],
      ["recovery-code", "Laget gjenopprettingskode"],
      ["recovery-code", "Laget ny gjenopprettingskode. Den gamle virker ikke lenger."],
    ],
    "unchanged steps log nothing",
  );
  const settings = await (await b.get("/lofotgata/admin/settings")).text();
  assert.match(settings, /Laget ny gjenopprettingskode\. Den gamle virker ikke lenger\./);
});

test("a password reset with the recovery code is written to the activity log", async () => {
  const { code } = await withCode();
  const id = tenant("lofotgata").id;
  await browser().post("/lofotgata/admin/nullstill", {
    recovery_code: code,
    admin_password: "new password",
    admin_password_confirm: "new password",
  });
  assert.deepEqual({ ...auditLog(id).at(-1) }, {
    action: "admin-password",
    detail: "Nullstilte adminpassordet med gjenopprettingskoden. Koden er byttet ut med en ny.",
    device: "Ukjent enhet",
  });
});

test("the daily cron closes a self-signup building nobody booked in 30 days, once", async () => {
  await signUp();
  for (const slug of ["brukt-gard", "ung-gard"]) await signUp(browser({ ip: `198.51.100.${slug.length}` }), { adresse: slug });
  sqlite.exec(`
    INSERT INTO tenants (slug, name, admin_password_hash, created_at) VALUES ('for-hand', 'For hand', 'x', datetime('now', '-60 days'));
    UPDATE tenants SET created_at = datetime('now', '-31 days') WHERE slug IN ('lofotgata', 'brukt-gard');
    UPDATE tenants SET created_at = datetime('now', '-29 days') WHERE slug = 'ung-gard';
  `);
  const used = tenant("brukt-gard");
  // Any booking counts as use, even one that was cancelled later.
  sqlite
    .prepare("INSERT INTO bookings (tenant_id, machine_id, date, start_min, end_min, apartment, cancelled_at) SELECT ?, id, '2026-01-01', 480, 600, 'A1', datetime('now') FROM machines WHERE tenant_id = ? LIMIT 1")
    .run(used.id, used.id);

  await worker.scheduled({}, env);
  const t = tenant("lofotgata");
  assert.ok(t.closed_at, "unused for 30 days");
  assert.equal(t.close_if_unused, 0);
  const entry = auditLog(t.id).at(-1);
  assert.equal(entry.device, "Automatisk opprydding");
  assert.match(entry.detail, /^Stengte vaskekjelleren fordi ingen har booket de første 30 dagene\. Slettes permanent .+ \(etter 7 dager\)/);
  for (const slug of ["brukt-gard", "ung-gard", "for-hand"]) assert.equal(tenant(slug).closed_at, null, slug);

  // Closed through the usual grace period: the page is offline, and the admin can reopen it.
  assert.equal((await browser().get("/lofotgata")).status, 410);
  const admin = browser();
  await admin.post("/lofotgata/admin/login", { password: PASSWORD });
  await admin.post("/lofotgata/admin/reopen", {});
  assert.equal(tenant("lofotgata").closed_at, null);
  await worker.scheduled({}, env);
  assert.equal(tenant("lofotgata").closed_at, null, "a reopened building is not closed again");
});

test("an automatically closed building is deleted after the grace period like any other", async () => {
  await signUp();
  sqlite.exec("UPDATE tenants SET created_at = datetime('now', '-31 days')");
  await worker.scheduled({}, env);
  assert.ok(tenant("lofotgata").closed_at);
  await worker.scheduled({}, env);
  assert.ok(tenant("lofotgata"), "not deleted before the grace period");
  sqlite.exec("UPDATE tenants SET closed_at = datetime('now', '-8 days')");
  await worker.scheduled({}, env);
  assert.equal(tenant("lofotgata"), undefined);
});
