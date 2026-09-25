import { readFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { NETWORKS, loopback } from "../src/config.js";
export function serviceOrigin(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    u.pathname !== "/" ||
    (u.protocol !== "https:" && !loopback(u))
  )
    throw new Error("Use a public HTTPS service origin or local loopback");
  return u.origin;
}
export async function buyerFetch(
  origin: string,
  payTo: string,
  keyFile: string,
  observePaymentSignature?: (signature: string) => void,
  signerGuard?: (signer: ClientEvmSigner) => ClientEvmSigner,
) {
  const key = (await readFile(keyFile, "utf8")).trim() as Hex;
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() === payTo.toLowerCase())
    throw new Error("Never use the treasury as test payer");
  const client = new x402Client()
    .register(
      "eip155:84532",
      new ExactEvmScheme(signerGuard ? signerGuard(account) : account),
    )
    .registerPolicy((version, requirements) =>
      version === 2
        ? requirements.filter(
            (r) =>
              r.network === "eip155:84532" &&
              r.scheme === "exact" &&
              r.amount === "10000" &&
              r.asset.toLowerCase() ===
                NETWORKS["eip155:84532"].usdc.toLowerCase() &&
              r.payTo.toLowerCase() === payTo.toLowerCase() &&
              r.maxTimeoutSeconds <= 60,
          )
        : [],
    );
  const fixedFetch: typeof fetch = (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.origin !== origin) throw new Error("Cross-origin request rejected");
    // Optional test hook: callers must keep the authorization in memory only.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const signature = headers.get("PAYMENT-SIGNATURE");
    if (signature) observePaymentSignature?.(signature);
    return fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  };
  return wrapFetchWithPayment(fixedFetch, client);
}
