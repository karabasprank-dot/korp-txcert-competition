import { keccak256, toHex } from "viem";
import type { CheckRequest, Policy } from "../schemas/index.js";

// Explicit versioned tuples; never depend on JavaScript object insertion order.
export function transactionHash(r: CheckRequest) {
  return keccak256(
    toHex(
      JSON.stringify([
        "korp-tx-v1",
        r.chainId,
        r.from.toLowerCase(),
        r.transaction.to.toLowerCase(),
        r.transaction.value,
        r.transaction.data.toLowerCase(),
        r.transaction.nonce ?? null,
      ]),
    ),
  );
}
export function policyHash(p: Policy) {
  return keccak256(
    toHex(
      JSON.stringify([
        "korp-policy-v1",
        p.expectedAction,
        [...p.allowedRecipients].map((a) => a.toLowerCase()).sort(),
        [...p.allowedSpenders].map((a) => a.toLowerCase()).sort(),
        p.maxNativeValueWei,
        [...p.maxTokenSpend]
          .map((v) => [v.token.toLowerCase(), v.amount])
          .sort((a, b) => a[0]!.localeCompare(b[0]!)),
        p.allowUnlimitedApproval,
        p.allowUnknownCalls,
      ]),
    ),
  );
}
