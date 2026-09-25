import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, erc20Abi } from "viem";
import type { CheckRequest } from "../src/schemas/index.js";
import { example } from "../src/discovery.js";
export const key = generatePrivateKey(),
  otherKey = generatePrivateKey();
export const attestor = privateKeyToAccount(key).address;
export const env = {
  ENVIRONMENT: "testnet",
  NETWORK: "eip155:84532",
  ENABLE_MAINNET: "false",
  X402_MODE: "facilitator",
  SERVICE_URL: "https://korp-test.workers.dev",
  PAY_TO_ADDRESS: "0xC7a0E085544c116dDf9f996108c553eeCE62E443",
  ATTESTOR_PRIVATE_KEY: key,
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  TX_CHECK_PRICE: "0.01",
};
export const localEnv = {
  ...env,
  ENVIRONMENT: "local",
  X402_MODE: "development",
  SERVICE_URL: "http://127.0.0.1:8787",
  DEVELOPMENT_PAYMENT_TOKEN: "test-only-development-token-of-32-characters",
};
export const recipient = "0x3333333333333333333333333333333333333333";
export const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const native = () => structuredClone(example) as CheckRequest;
export function erc20(
  action: "transfer" | "approve" | "transferFrom" = "transfer",
  amount = 100n,
): CheckRequest {
  const r = native();
  r.transaction.to = token;
  r.transaction.value = "0";
  r.transaction.data =
    action === "transferFrom"
      ? encodeFunctionData({
          abi: erc20Abi,
          functionName: action,
          args: [r.from as `0x${string}`, recipient, amount],
        })
      : encodeFunctionData({
          abi: erc20Abi,
          functionName: action,
          args: [recipient, amount],
        });
  r.policy.expectedAction = action;
  r.policy.allowedSpenders = [recipient];
  r.policy.maxTokenSpend = [{ token, amount: "100" }];
  return r;
}
