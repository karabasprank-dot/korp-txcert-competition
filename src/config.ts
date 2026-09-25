import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { address } from "./schemas/index.js";
export const NETWORKS = {
  "eip155:84532": {
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  "eip155:8453": {
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
} as const;
export const loopback = (url: URL) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const configSchema = z.object({
  ENVIRONMENT: z.enum(["local", "testnet", "mainnet"]),
  NETWORK: z.enum(["eip155:84532", "eip155:8453"]),
  ENABLE_MAINNET: z.enum(["false", "true"]),
  X402_MODE: z.enum(["development", "facilitator"]),
  SERVICE_URL: z.string().url(),
  PAY_TO_ADDRESS: address,
  ATTESTOR_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  DEVELOPMENT_PAYMENT_TOKEN: z.string().min(32).optional(),
  X402_FACILITATOR_URL: z.enum([
    "https://x402.org/facilitator",
    "https://facilitator.payai.network",
  ]),
  TX_CHECK_PRICE: z.literal("0.01"),
});
export type Bindings = Record<string, unknown> & {
  PAYMENT_LEDGER?: DurableObjectNamespace;
};
export function parseConfig(env: Bindings) {
  const c = configSchema.parse(env),
    url = new URL(c.SERVICE_URL);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /replace|example/i.test(url.hostname)
  )
    throw new Error("Invalid service origin");
  if (c.ENVIRONMENT !== "local" && (url.protocol !== "https:" || loopback(url)))
    throw new Error("Deployed service requires public HTTPS");
  const mainnet = c.ENVIRONMENT === "mainnet";
  if (
    mainnet !== (c.NETWORK === "eip155:8453") ||
    mainnet !== (c.ENABLE_MAINNET === "true")
  )
    throw new Error("Network and explicit mainnet authorization must agree");
  if (
    mainnet &&
    (c.X402_MODE !== "facilitator" ||
      c.X402_FACILITATOR_URL !== "https://facilitator.payai.network" ||
      !env.PAYMENT_LEDGER)
  )
    throw new Error("Mainnet requires PayAI and the durable payment ledger");
  if (c.ENVIRONMENT === "local" && !loopback(url))
    throw new Error("Local requires loopback");
  if (
    c.X402_MODE === "development" &&
    (c.ENVIRONMENT !== "local" || !c.DEVELOPMENT_PAYMENT_TOKEN)
  )
    throw new Error("Simulation requires local environment and token");
  const account = privateKeyToAccount(c.ATTESTOR_PRIVATE_KEY as Hex);
  if (account.address.toLowerCase() === c.PAY_TO_ADDRESS.toLowerCase())
    throw new Error("Attestor must differ from treasury");
  if (
    /^0x0{40}$/i.test(c.PAY_TO_ADDRESS) ||
    c.PAY_TO_ADDRESS.toLowerCase() ===
      "0x000000000000000000000000000000000000dead"
  )
    throw new Error("Invalid receiving address");
  return {
    ...c,
    SERVICE_URL: url.origin,
    attestor: account.address,
    chainId: NETWORKS[c.NETWORK].chainId,
    mainnet,
  };
}
export type Config = ReturnType<typeof parseConfig>;
