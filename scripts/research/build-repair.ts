import { build } from "esbuild";
await build({
  entryPoints: ["scripts/research/repair-browser.ts"],
  outfile: "live-testnet/assets/repair.js",
  bundle: true,
  platform: "browser",
  target: ["safari15", "chrome100"],
  format: "esm",
  minify: true,
  legalComments: "eof",
});
console.log("Built local-browser repair planner.");
