import { build } from "esbuild";
await build({
  entryPoints: ["scripts/research/exposure-browser.ts"],
  outfile: "live-testnet/assets/exposure.js",
  bundle: true,
  platform: "browser",
  target: ["safari15", "chrome100"],
  format: "esm",
  minify: true,
  legalComments: "eof",
});
console.log("Built browser-only exposure verifier.");
