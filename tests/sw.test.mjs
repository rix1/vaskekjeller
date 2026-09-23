import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script, createContext } from "node:vm";

// public/sw.js is registered as a classic script (navigator.serviceWorker.register("/sw.js")),
// so the build output must parse and run without module syntax.
test("compiled service worker runs as a classic script and shows pushed notifications", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vaskekjeller-sw-"));
  try {
    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "client/tsconfig.sw.json", "--outDir", temp]);
    const script = new Script(await readFile(join(temp, "sw.js"), "utf8"), { filename: "sw.js" });

    const listeners = {};
    const shown = [];
    const self = {
      addEventListener: (type, fn) => (listeners[type] = fn),
      registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    };
    script.runInContext(createContext({ self }));

    const message = { title: "Ny kommentar", body: "Tir. 29. sep. 10:00–12:00: «ferdig kl. 11»", url: "/demo", tag: "note-x", renotify: true };
    const waits = [];
    listeners.push({ data: { json: () => message }, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);

    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, message.title);
    assert.equal(shown[0].options.body, message.body);
    assert.equal(shown[0].options.tag, "note-x");
    assert.equal(shown[0].options.renotify, true);
    assert.equal(shown[0].options.data.url, "/demo");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
