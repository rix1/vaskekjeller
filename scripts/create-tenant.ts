// Creates a building (tenant) with one washer and one dryer.
//   node scripts/create-tenant.ts --slug vaskekjeller --name "Borettslaget" [--remote]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/crypto.ts";
import { isDemoSlug } from "../src/demo.ts";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    remote: { type: "boolean", default: false },
  },
});

if (!values.slug || !/^[a-z0-9-]+$/.test(values.slug) || !values.name) {
  console.error('Usage: node scripts/create-tenant.ts --slug <a-z0-9-> --name "<name>" [--remote]');
  process.exit(1);
}
// The nightly demo reset would take over a building with a demo's slug.
if (isDemoSlug(values.slug)) {
  console.error(`/${values.slug} is a demo building.`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Admin password (min 8 chars): ");
rl.close();
if (password.length < 8) {
  console.error("Password too short.");
  process.exit(1);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sql = `
INSERT INTO tenants (slug, name, admin_password_hash) VALUES (${q(values.slug)}, ${q(values.name)}, ${q(await hashPassword(password))});
INSERT INTO machines (tenant_id, kind, name, sort_order)
  SELECT id, 'washer', 'Vaskemaskin', 1 FROM tenants WHERE slug = ${q(values.slug)};
INSERT INTO machines (tenant_id, kind, name, sort_order)
  SELECT id, 'dryer', 'Tørketrommel', 2 FROM tenants WHERE slug = ${q(values.slug)};
`;
const file = join(mkdtempSync(join(tmpdir(), "vk-")), "tenant.sql");
writeFileSync(file, sql);
execFileSync("npx", ["wrangler", "d1", "execute", "vaskekjeller", values.remote ? "--remote" : "--local", "--file", file], { stdio: "inherit" });
console.log(`\nCreated /${values.slug}`);
