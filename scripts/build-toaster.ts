// Bundles client/toaster.ts (Sonner on Preact's React-compat layer) into public/toaster.js.
//   node scripts/build-toaster.ts [outfile]
import { build } from "esbuild";

export const outfile = process.argv[2] ?? "public/toaster.js";
const result = await build({
  entryPoints: ["client/toaster.ts"],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  alias: { react: "preact/compat", "react-dom": "preact/compat" },
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  logLevel: "warning",
});
console.log(`${outfile}: ${(Object.values(result.metafile.outputs)[0]!.bytes / 1024).toFixed(1)} kB`);
