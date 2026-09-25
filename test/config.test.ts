import { it, expect } from "vitest";
import { parseConfig } from "../src/config.js";
import { env, localEnv, attestor } from "./fixtures.js";
it("accepts testnet and local config", () => {
  expect(parseConfig(env).NETWORK).toBe("eip155:84532");
  expect(parseConfig(localEnv).X402_MODE).toBe("development");
});
it.each([
  { NETWORK: "eip155:8453" },
  { ENABLE_MAINNET: "true" },
  { PAY_TO_ADDRESS: attestor },
  { ATTESTOR_PRIVATE_KEY: "invalid" },
  { X402_MODE: "development" },
  { SERVICE_URL: "https://example.com" },
  { SERVICE_URL: "http://127.0.0.1:8787" },
  { X402_FACILITATOR_URL: "http://169.254.169.254" },
  { SERVICE_URL: "https://name:pass@korp.test" },
  { TX_CHECK_PRICE: "1.00" },
])("fails closed on unsafe configuration %j", (change) => {
  expect(() => parseConfig({ ...env, ...change })).toThrow();
});
