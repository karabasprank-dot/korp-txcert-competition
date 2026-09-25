import { writeFileSync } from "node:fs";
import { makePromiseFixture } from "./promise-fixture.js";
import {
  acceptanceTypedData,
  verifyPromiseBreach,
  exportExpiredPromiseProof,
} from "../../src/core/promise-receipt.js";

const { proof, trust, merchant } = await makePromiseFixture();
const original = await verifyPromiseBreach(proof, trust);
if (!original.valid) throw Error("Expected signed breach to verify");
const rewritten = structuredClone(proof);
rewritten.terms.rule.equals = 1;
rewritten.merchantSignature = await merchant.signTypedData(
  acceptanceTypedData(rewritten.terms),
);
const changedPromise = await verifyPromiseBreach(rewritten, trust);
if (changedPromise.valid)
  throw Error("Merchant rewrote a payment-bound promise");
const fabricated = structuredClone(proof);
fabricated.disclosure.value = 56;
const fakeResponse = await verifyPromiseBreach(fabricated, trust);
if (fakeResponse.valid) throw Error("Buyer forged a response");
const exportable = await exportExpiredPromiseProof(
  proof,
  trust,
  Math.floor(Date.now() / 1000),
);
const serialized = JSON.stringify(exportable);
for (const secret of [
  "SYNTHETIC_PRIVATE_CUSTOMER",
  "SYNTHETIC_PRIVATE_POSITION",
  "SYNTHETIC_PRIVATE_NOTE",
])
  if (serialized.includes(secret))
    throw Error("Unrelated private field disclosed");
const report = {
  at: new Date().toISOString(),
  mode: "local cryptographic experiment; unfunded ephemeral keys; expired authorization; no settlement or network calls",
  prototype: "Korp Promise Receipt v0",
  proof: exportable,
  tamperedProofs: {
    rewrittenMerchantPromise: rewritten,
    fabricatedBuyerResponse: fabricated,
  },
  trust,
  result: original,
  adversarialChecks: {
    rewrittenMerchantPromise: changedPromise,
    fabricatedBuyerResponse: fakeResponse,
  },
  undisclosedSyntheticValuesAbsent: true,
  limits: [
    "Not proof of settlement",
    "Not zero knowledge or unlinkable",
    "No refund or arbitration",
    "Seller must participate",
    "Novelty not established",
  ],
};
writeFileSync(
  "docs/pilot/promise-receipt-demo.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    valid: original.valid,
    changedPromiseRejected: !changedPromise.valid,
    fakeResponseRejected: !fakeResponse.valid,
    unrelatedValuesDisclosed: false,
    settlementVerified: false,
  }),
);
