import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "public/**",
      "coverage/**",
      ".wrangler/**",
      // Generated browser bundle; its TypeScript entry point and core are linted.
      "live-testnet/assets/exposure.js",
      "live-testnet/assets/repair.js",
    ],
  },
  {
    files: ["examples/*.mjs"],
    languageOptions: { globals: { structuredClone: "readonly" } },
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
