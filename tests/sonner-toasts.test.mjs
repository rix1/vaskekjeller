import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Toasts are Sonner (client/toaster.ts), bundled on its own with Preact's React-compat layer and loaded by
// client/app.ts on the first toast. Behaviour was checked in a real browser; this guards the generated bundle (a public build output).
test("the toaster bundle builds, contains Sonner and stays small", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vaskekjeller-toaster-"));
  try {
    const outfile = join(dir, "toaster.js");
    execFileSync("node", ["scripts/build-toaster.ts", outfile], { stdio: "pipe" });
    const bundle = await readFile(outfile);
    const source = bundle.toString();
    assert.match(source, /data-sonner-toast/);
    assert.doesNotMatch(source, /react-dom|from"react"/);
    assert.ok(gzipSync(bundle).length < 30_000, `toaster.js is ${gzipSync(bundle).length} bytes gzipped`);
    assert.match(source, /^import|export\{/m, "an ES module exposing notify and dismissNotice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
