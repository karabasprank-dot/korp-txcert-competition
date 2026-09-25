import type { Address } from "viem";
import { requestSchema, type CheckRequest } from "../../src/schemas/index.js";
import {
  signWithOwnerPolicy,
  type SignerTrust,
} from "../../src/core/owner-policy.js";
import { BudgetStore } from "./budget-store.js";

/** Experimental local signer adapter. All dependencies below are owner-controlled.
 * The caller must not access the raw signing hook or replace the persistent store.
 * This is a reservation ceiling, not a proof of settlement or a gas budget. */
export async function signWithBudget<T>(
  input: { request: unknown; certificate: unknown; approval: unknown },
  trust: SignerTrust,
  store: BudgetStore,
  hooks: {
    pendingNonce: (chain: number, agent: Address) => Promise<string>;
    sign: (request: CheckRequest) => Promise<T>;
  },
  clock: () => number = () => Math.floor(Date.now() / 1000),
): Promise<T> {
  const request = requestSchema.parse(input.request);
  return signWithOwnerPolicy(
    { ...input, request },
    trust,
    {
      claimNonce: async (chain, agent) => {
        const expected = await hooks.pendingNonce(chain, agent);
        store.reserve(request, expected, clock());
        return true;
      },
      sign: async (r) => {
        store.assertActive(clock());
        return hooks.sign(r);
      },
    },
    clock,
  );
}
