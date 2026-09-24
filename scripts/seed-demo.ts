// Creates or resets the demo buildings (/visning and /demo) with bookings around today, like the nightly cron.
//   node scripts/seed-demo.ts [--remote]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEMO_SLUGS, demoSeed, demoToday } from "../src/demo.ts";

const { values } = parseArgs({ options: { remote: { type: "boolean", default: false } } });

const literal = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
// The statements use only positional "?" parameters, never inside string literals.
const sql = DEMO_SLUGS.flatMap((slug) => demoSeed(slug, demoToday()))
  .map((s) => {
    let i = 0;
    return `${s.sql.replace(/\?/g, () => literal(s.params[i++]!))};`;
  })
  .join("\n");
const file = join(mkdtempSync(join(tmpdir(), "vk-")), "demo.sql");
writeFileSync(file, sql);
execFileSync("npx", ["wrangler", "d1", "execute", "vaskekjeller", values.remote ? "--remote" : "--local", "--file", file], { stdio: "inherit" });
console.log(`\nSeeded ${DEMO_SLUGS.map((slug) => `/${slug}`).join(" and ")} for ${demoToday()}`);
