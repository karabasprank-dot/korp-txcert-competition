import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  acceptanceTypedData,
  authorizationTypedData,
  commitResponse,
  deliveryTypedData,
  privateRequestCommitment,
  PROMISE_TOKEN,
  type PromiseTerms,
  type PromiseBreachProof,
  newPromiseSalt,
} from "../../src/core/promise-receipt.js";
export const freshSalt = newPromiseSalt;

/** Synthetic unfunded accounts, expired authorization, no network calls.
 * Keys stay in memory. Only public proof/pins are exported by the demo. */
export async function makePromiseFixture(
  responseOverride?: Record<string, unknown>,
) {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const merchant = privateKeyToAccount(generatePrivateKey());
  const payee = privateKeyToAccount(generatePrivateKey()).address;
  const privateRequest =
    '{"customer":"SYNTHETIC_PRIVATE_CUSTOMER","position":"SYNTHETIC_PRIVATE_POSITION"}';
  const terms: PromiseTerms = {
    version: 1,
    chainId: 84532,
    asset: PROMISE_TOKEN,
    payer: buyer.address,
    payTo: payee,
    merchantSigner: merchant.address,
    amount: "10000",
    validAfter: "0",
    validBefore: "2", // Deliberately expired: never executable today.
    requestCommitment: privateRequestCommitment(privateRequest, freshSalt()),
    fields: ["chainId", "customer", "position", "internalNote"],
    rule: { fieldIndex: 0, equals: 84532 },
  };
  const merchantSignature = await merchant.signTypedData(
    acceptanceTypedData(terms),
  );
  const nonceSalt = freshSalt();
  const authorizationSignature = await buyer.signTypedData(
    authorizationTypedData(terms, merchantSignature, nonceSalt),
  );
  const response = responseOverride ?? {
    chainId: 1,
    customer: "SYNTHETIC_PRIVATE_CUSTOMER",
    position: "SYNTHETIC_PRIVATE_POSITION",
    internalNote: "SYNTHETIC_PRIVATE_NOTE",
  };
  const committed = commitResponse(
    terms,
    response,
    Array.from({ length: 4 }, freshSalt),
  );
  const deliverySignature = await merchant.signTypedData(
    deliveryTypedData(terms, merchantSignature, nonceSalt, committed.root),
  );
  const proof: PromiseBreachProof = {
    terms,
    merchantSignature,
    nonceSalt,
    authorizationSignature,
    responseRoot: committed.root,
    deliverySignature,
    disclosure: committed.disclose(0),
  };
  const trust = {
    payer: buyer.address,
    payTo: payee,
    merchantSigner: merchant.address,
  };
  return { proof, trust, buyer, merchant, committed };
}
