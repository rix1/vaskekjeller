import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Toasts are Sonner (client/toaster.ts), bundled on its own with Preact's React-compat layer and loaded by
// client/app.ts on the first toast. Behaviour was checked in a real browser; this guards the build and the wiring.
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

test("the page script loads the toaster lazily and the build step produces it", async () => {
  const app = await readFile("client/app.ts", "utf8");
  assert.match(app, /"\/toaster\.js"/);
  const config = await readFile("wrangler.jsonc", "utf8");
  assert.match(config, /node scripts\/build-toaster\.ts/);
});

test("Angre is a quiet text button and auto-hiding toasts carry a timer line", async () => {
  const css = await readFile("public/style.css", "utf8");
  const action = css.match(/\[data-button\]\.vk-toast-action\.vk-toast-action \{([^}]*)\}/)?.[1] ?? "";
  assert.match(action, /background: none/);
  assert.match(action, /text-decoration: underline/);
  assert.match(css, /\.vk-timer \{[^}]*animation: vk-timer/);
  const toaster = await readFile("client/toaster.ts", "utf8");
  assert.match(toaster, /AUTO_HIDE_MS = 4000/);
  assert.match(toaster, /tone === "error" \? Infinity/);
  const app = await readFile("client/app.ts", "utf8");
  assert.match(app, /BOOKING_TOAST_MS = 5000/);
});
