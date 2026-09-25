import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// The shared about page (/om): it renders, the landing page and every building's footer link to it,
// it is framed like every other page, and no building can take the "om" address.
// Same harness as bookings.test.mjs: the real Hono routes against an isolated SQLite database.
let worker, signup, bindings, db, temp, sqlite;
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
const ctx = { waitUntil: (promise) => promise.catch(() => {}) };
const get = (path, cookie = "") => worker.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }), bindings, ctx);

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-about-tests-"));
  await build({
    entryPoints: { worker: "src/index.tsx", signup: "src/signup.ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    outdir: temp,
    outExtension: { ".js": ".mjs" },
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
  ({ default: worker } = await import(pathToFileURL(join(temp, "worker.mjs")).href));
  signup = await import(pathToFileURL(join(temp, "signup.mjs")).href);
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

test("/om renders the about page with every section and the contact address", async () => {
  const response = await get("/om");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="nb">/);
  assert.match(html, /<link rel="stylesheet" href="\/landing.css"/);
  assert.match(html, /<h1>Spørsmål og svar<\/h1>/);
  for (const id of ["kom-i-gang", "varsler", "kalender", "data"]) {
    assert.match(html, new RegExp(`<section class="about-section" id="${id}"`), id);
    assert.match(html, new RegExp(`<a href="#${id}">`), `table of contents links to ${id}`);
  }
  for (const q of ["Hvordan velger jeg leilighet?", "Hvordan legger jeg den på Hjem-skjermen?", "Når får jeg varsel?", "Hvordan skrur jeg av varsler?", "Hvorfor bare Apple Kalender?", "Hva lagres ikke?", "Hva er gjenopprettingskoden?"])
    assert.match(html, new RegExp(`<summary>${q.replace(/\?/g, "\\?")}</summary>`), q);
  assert.match(html, /<a href="mailto:hjelp@vaskekjeller.no">hjelp@vaskekjeller.no<\/a>/);
  assert.doesNotMatch(html, /gmail/);
});

test("/om is framed like every other page", async () => {
  const response = await get("/om");
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'self'");
});

test("the landing page and every building's footer link to /om", async () => {
  assert.match(await (await get("/")).text(), /<footer class="landing-foot">[\s\S]*<a href="\/om">Om Vaskekjeller<\/a>[\s\S]*<\/footer>/);
  for (const path of ["/lofotgata", "/demo"]) {
    const html = await (await get(path)).text();
    assert.match(html, /<footer class="foot resident-foot">[\s\S]*<a href="\/om">Om Vaskekjeller<\/a>[\s\S]*<\/footer>/, path);
  }
});

test("no building can take the om address", () => {
  assert.ok(signup.RESERVED_SLUGS.has("om"));
  assert.equal(signup.slugProblem("om"), "Denne adressen er reservert. Velg en annen.");
});

test("/om stays the about page even if a building named om existed", async () => {
  sqlite.exec("INSERT INTO tenants (slug, name, admin_password_hash) VALUES ('om', 'Om', 'unused')");
  assert.match(await (await get("/om")).text(), /<h1>Spørsmål og svar<\/h1>/);
  sqlite.exec("DELETE FROM tenants WHERE slug = 'om'");
});
