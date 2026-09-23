// Generates a VAPID key pair for web push.
//   node scripts/gen-vapid.ts            → prints keys
//   node scripts/gen-vapid.ts --dev-vars → also writes .dev.vars for local dev
import { existsSync, writeFileSync } from "node:fs";
import { b64url } from "../src/crypto.ts";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!;

if (process.argv.includes("--dev-vars")) {
  if (existsSync(".dev.vars")) {
    console.error(".dev.vars already exists – not overwriting.");
    process.exit(1);
  }
  const sessionSecret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  writeFileSync(".dev.vars", `SESSION_SECRET=${sessionSecret}\nVAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`);
  console.log("Wrote .dev.vars");
} else {
  console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}`);
  console.log("\nSet them in production with:\n  npx wrangler secret put VAPID_PUBLIC_KEY\n  npx wrangler secret put VAPID_PRIVATE_KEY");
}
