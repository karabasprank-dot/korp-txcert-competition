// Offline demonstration only: three new unfunded identities, no RPC or broadcast.
import assert from "node:assert/strict";
import { log } from "node:console";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import {
  policyHash,
  transactionHash,
  typedOwnerPolicy,
  ownerApprovalDigest,
  typedCertificate,
  signWithOwnerPolicy,
} from "./korp-signer.mjs";

const owner = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const attestor = privateKeyToAccount(generatePrivateKey());
const now = Math.floor(Date.now() / 1000);
const service = "https://demo.invalid";
const request = {
  chainId: 84532,
  from: agent.address,
  transaction: {
    to: "0x3333333333333333333333333333333333333333",
    data: "0x",
    value: "1000",
    nonce: "0",
  },
  policy: {
    expectedAction: "native-transfer",
    allowedRecipients: ["0x3333333333333333333333333333333333333333"],
    allowedSpenders: [],
    maxNativeValueWei: "1000",
    maxTokenSpend: [],
    allowUnlimitedApproval: false,
    allowUnknownCalls: false,
  },
};
const authorization = {
  version: 1,
  policyId: keccak256(toHex("demo-policy")),
  revision: "1",
  owner: owner.address,
  agent: agent.address,
  chainId: 84532,
  service,
  attestor: attestor.address,
  policyHash: policyHash(request.policy),
  validAfter: now - 1,
  validUntil: now + 3600,
};
const approval = {
  authorization,
  policy: structuredClone(request.policy),
  signature: await owner.signTypedData(typedOwnerPolicy(authorization)),
};
const trust = {
  owner: owner.address,
  agent: agent.address,
  chainId: 84532,
  service,
  attestor: attestor.address,
  approvalDigest: ownerApprovalDigest(authorization),
};
const fixtureCertificate = async (r) => {
  const c = {
    version: 1,
    issuedAt: now,
    expiresAt: now + 60,
    chainId: 84532,
    transactionHash: transactionHash(r),
    policyHash: policyHash(r.policy),
    decision: "PASS",
    attestor: attestor.address,
    service,
  };
  return { ...c, signature: await attestor.signTypedData(typedCertificate(c)) };
};
let claimed = false,
  calls = 0;
const hooks = {
  claimNonce: async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  },
  sign: async (r) => {
    calls++;
    return agent.signTransaction({
      chainId: 84532,
      to: r.transaction.to,
      data: r.transaction.data,
      value: BigInt(r.transaction.value),
      nonce: Number(r.transaction.nonce),
      gas: 21000n,
      type: "eip1559",
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000n,
    });
  },
};
const certificate = await fixtureCertificate(request);
const input = { request, certificate, approval };
const signed = await signWithOwnerPolicy(input, trust, hooks, () => now);
assert.match(signed, /^0x02/);
await assert.rejects(
  signWithOwnerPolicy(input, trust, hooks, () => now),
  /NONCE_UNAVAILABLE/,
);
const changed = structuredClone(request);
changed.policy.maxNativeValueWei = "1000000";
changed.transaction.value = "1001";
await assert.rejects(
  signWithOwnerPolicy(
    {
      request: changed,
      certificate: await fixtureCertificate(changed),
      approval,
    },
    trust,
    hooks,
    () => now,
  ),
  /OWNER_POLICY_MISMATCH/,
);
assert.equal(calls, 1);
log(
  JSON.stringify(
    {
      status: "PASS",
      approvedTransactionSignedLocally: true,
      alteredPolicyRejected: true,
      duplicateNonceRejected: true,
      networkCalls: 0,
      fundsMoved: 0,
      note: "Synthetic certificate and unfunded disposable keys. Signed transaction discarded, never broadcast. Single-process nonce store is demo-only.",
    },
    null,
    2,
  ),
);
