import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const result = await build({
  entryPoints: ["scripts/sdk-entry.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  packages: "external",
  write: false,
  target: "es2022",
  banner: {
    js: "// Korp TxCert signer adapter. Requires viem 2.56.5 and zod 4.6.5.\n// No network calls, custody or transaction broadcasting. Review before integration.",
  },
});
const code = result.outputFiles[0]!.text;
if (/privateKeyToAccount|function issueCertificate|fetch\(/.test(code))
  throw new Error("Unexpected signing or network code in verifier SDK");
await mkdir("public", { recursive: true });
await mkdir("src/generated", { recursive: true });
await writeFile("public/korp-signer.mjs", code);
const demo = await readFile("examples/owner-demo.mjs", "utf8");
const guide = await readFile("docs/OWNER-INTEGRATION.md", "utf8");
await writeFile("public/owner-demo.mjs", demo);
await writeFile(
  "src/generated/signer-sdk.json",
  JSON.stringify({
    code,
    sha256: createHash("sha256").update(code).digest("hex"),
    demo,
    guide,
    demoSha256: createHash("sha256").update(demo).digest("hex"),
  }),
);
console.log(
  "Built public signer SDK; sha256=" +
    createHash("sha256").update(code).digest("hex"),
);
