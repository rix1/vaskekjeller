import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// SEO: only the public pages (/, /om, /ny) are indexable, with canonical, link-preview and structured data;
// every other page is noindex (header and meta). robots.txt and sitemap.xml come from the Worker.
// Same harness as bookings.test.mjs: the real Hono routes against an isolated SQLite database.
let worker, bindings, db, temp, sqlite;
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
  temp = await mkdtemp(join(tmpdir(), "vaskekjeller-seo-tests-"));
  await build({
    entryPoints: { worker: "src/index.tsx" },
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

const SITE = "https://www.vaskekjeller.no";
const PUBLIC = [
  { path: "/", canonical: `${SITE}/` },
  { path: "/om", canonical: `${SITE}/om` },
  { path: "/ny", canonical: `${SITE}/ny` },
];
const attr = (html, selector) => html.match(new RegExp(`<meta ${selector} content="([^"]*)"`))?.[1];
const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/)?.[1];

test("public pages are indexable with a Norwegian title, description, canonical URL and lang=no", async () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const page of PUBLIC) {
    const response = await get(page.path);
    assert.equal(response.status, 200, page.path);
    assert.equal(response.headers.get("X-Robots-Tag"), null, `${page.path} has no noindex header`);
    const html = await response.text();
    assert.match(html, /<html lang="no">/, page.path);
    assert.doesNotMatch(html, /name="robots"/, `${page.path} has no robots meta`);
    assert.match(html, new RegExp(`<link rel="canonical" href="${page.canonical}"/>`), page.path);
    const title = titleOf(html);
    const description = attr(html, 'name="description"');
    assert.ok(title && description && description.length >= 50 && description.length <= 160, `${page.path}: ${description}`);
    assert.equal(html.match(/name="description"/g).length, 1, `${page.path} has one description`);
    titles.add(title);
    descriptions.add(description);
  }
  assert.equal(titles.size, PUBLIC.length, "each public page has its own title");
  assert.equal(descriptions.size, PUBLIC.length, "each public page has its own description");
});

test("public pages carry Open Graph and Twitter card tags with an absolute share image", async () => {
  for (const page of PUBLIC) {
    const html = await (await get(page.path)).text();
    assert.equal(attr(html, 'property="og:url"'), page.canonical, page.path);
    assert.equal(attr(html, 'property="og:type"'), "website");
    assert.equal(attr(html, 'property="og:title"'), titleOf(html));
    assert.equal(attr(html, 'property="og:description"'), attr(html, 'name="description"'));
    assert.equal(attr(html, 'property="og:image"'), `${SITE}/share.png`);
    assert.equal(attr(html, 'property="og:image:width"'), "1200");
    assert.equal(attr(html, 'property="og:image:height"'), "630");
    assert.equal(attr(html, 'name="twitter:card"'), "summary_large_image");
    assert.equal(attr(html, 'name="twitter:image"'), `${SITE}/share.png`);
  }
  // The share image is a static asset of the promised size (PNG header: width and height at bytes 16–23).
  const png = await readFile("public/share.png");
  assert.equal(png.toString("latin1", 1, 4), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
});

test("the landing page describes itself as a WebApplication in JSON-LD", async () => {
  const html = await (await get("/")).text();
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const data = JSON.parse(blocks[0][1]);
  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "WebApplication");
  assert.equal(data.name, "Vaskekjeller");
  assert.equal(data.url, `${SITE}/`);
  assert.equal(data.inLanguage, "no");
  assert.ok(data.description && data.applicationCategory && data.operatingSystem);
  for (const path of ["/om", "/ny"]) assert.doesNotMatch(await (await get(path)).text(), /application\/ld\+json/, path);
});

test("buildings, admin, onboarding, later signup steps and the demo buildings are noindex", async () => {
  for (const path of ["/lofotgata", "/lofotgata/admin", "/lofotgata/admin/kom-i-gang", "/visning", "/demo", "/ny/adresse?navn=Test", "/finnes-ikke"]) {
    const response = await get(path);
    assert.equal(response.headers.get("X-Robots-Tag"), "noindex", path);
    const html = await response.text();
    if (response.headers.get("Content-Type")?.startsWith("text/html")) {
      assert.match(html, /<meta name="robots" content="noindex"\/>/, `${path} has a noindex meta`);
      assert.doesNotMatch(html, /rel="canonical"|property="og:/, `${path} has no public-page tags`);
    }
  }
  // A signup step that re-renders the first step's form with an error is not the public /ny page.
  const invalid = await get("/ny/adresse?navn=");
  assert.equal(invalid.status, 422);
  assert.match(await invalid.text(), /<meta name="robots" content="noindex"\/>/);
});

test("robots.txt allows crawling (so noindex is seen) and points at the sitemap", async () => {
  const response = await get("/robots.txt");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/plain/);
  const body = await response.text();
  assert.match(body, /^User-agent: \*$/m);
  assert.doesNotMatch(body, /^Disallow: \S/m);
  assert.match(body, new RegExp(`^Sitemap: ${SITE}/sitemap.xml$`, "m"));
});

test("sitemap.xml lists exactly the three public pages with absolute URLs", async () => {
  const response = await get("/sitemap.xml");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^application\/xml/);
  const body = await response.text();
  assert.match(body, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(body, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  const locs = [...body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, PUBLIC.map((p) => p.canonical));
});
