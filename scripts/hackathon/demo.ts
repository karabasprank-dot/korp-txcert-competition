import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { example } from "../../src/discovery.js";
import { requestSchema } from "../../src/schemas/index.js";
import { policyHash } from "../../src/core/canonicalize.js";
import { issueCertificate } from "../../src/core/issue-certificate.js";
import {
  typedOwnerPolicy,
  ownerApprovalDigest,
  type OwnerApproval,
  type SignerTrust,
} from "../../src/core/owner-policy.js";
import { BudgetStore } from "./budget-store.js";
import { signWithBudget } from "./budget-signer.js";
const owner = privateKeyToAccount(generatePrivateKey()),
  agent = privateKeyToAccount(generatePrivateKey());
const attestorKey = generatePrivateKey(),
  attestor = privateKeyToAccount(attestorKey);
const now = Math.floor(Date.now() / 1000),
  service = "https://demo.korp.invalid";
const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const recipient = "0x3333333333333333333333333333333333333333";
const base = requestSchema.parse({ ...example, from: agent.address });
base.policy.expectedAction = "transfer";
base.policy.maxTokenSpend = [{ token, amount: "60000000" }];
base.policy.allowedRecipients = [recipient];
base.transaction.value = "0";
base.transaction.to = token;
const authorization = {
  version: 1 as const,
  policyId: keccak256(toHex("hackathon-demo")),
  revision: "1",
  owner: owner.address,
  agent: agent.address,
  chainId: 84532 as const,
  service,
  attestor: attestor.address,
  policyHash: policyHash(base.policy),
  validAfter: now - 1,
  validUntil: now + 3600,
};
const approval: OwnerApproval = {
  authorization,
  policy: base.policy,
  signature: await owner.signTypedData(typedOwnerPolicy(authorization)),
};
const trust: SignerTrust = {
  owner: owner.address,
  agent: agent.address,
  chainId: 84532,
  service,
  attestor: attestor.address,
  approvalDigest: ownerApprovalDigest(authorization),
};
const config = {
  id: "owner-budget-100-usdc",
  chainId: 84532 as const,
  agent: agent.address,
  asset: token,
  limit: "100000000",
  startsAt: now - 1,
  endsAt: now + 3600,
};
const path = join(
  mkdtempSync(join(tmpdir(), "korp-demo-")),
  "reservations.sqlite",
);
let store = new BudgetStore(path, config),
  signatures = 0;
const results: {
  scenario: string;
  outcome: string;
  expected: string;
  reservedAtomic: string;
}[] = [];
async function attempt(
  scenario: string,
  nonce: string,
  amount: bigint,
  expected: string,
  options: { loosen?: boolean; expired?: boolean; failSigning?: boolean } = {},
) {
  const request = structuredClone(base);
  request.transaction.nonce = nonce;
  request.transaction.data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, amount],
  });
  if (options.loosen)
    request.policy.maxTokenSpend = [{ token, amount: "1000000000" }];
  const certificate = await issueCertificate(
    request,
    attestorKey,
    service,
    options.expired ? now - 120 : now,
  );
  let outcome = "SIGNED";
  try {
    await signWithBudget(
      { request, certificate, approval },
      trust,
      store,
      {
        pendingNonce: async () => nonce, // Synthetic trusted chain state for this offline test.
        sign: async (r) => {
          if (options.failSigning) throw new Error("SIGNER_OFFLINE");
          const signed = await agent.signTransaction({
            chainId: 84532,
            to: r.transaction.to as Address,
            data: r.transaction.data as Hex,
            value: 0n,
            nonce: Number(nonce),
            gas: 70000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            type: "eip1559",
          });
          signatures++;
          return signed; // Never broadcast or print signed bytes.
        },
      },
      () => now,
    );
  } catch (e) {
    outcome = e instanceof Error ? e.message : String(e);
  }
  assert.equal(outcome, expected, scenario);
  results.push({
    scenario,
    outcome,
    expected,
    reservedAtomic: store.reserved(),
  });
}
await attempt("First authorized 30 USDC", "0", 30000000n, "SIGNED");
await attempt("Second authorized 30 USDC", "1", 30000000n, "SIGNED");
await attempt(
  "50 USDC would exceed aggregate 100 USDC budget",
  "2",
  50000000n,
  "BUDGET_EXCEEDED",
);
await attempt(
  "Agent loosens owner policy",
  "2",
  50000000n,
  "OWNER_POLICY_MISMATCH",
  { loosen: true },
);
await attempt("Expired certificate", "2", 1000000n, "INVALID_TIME_WINDOW", {
  expired: true,
});
await attempt(
  "Replay already signed nonce",
  "0",
  30000000n,
  "NONCE_ALREADY_RESERVED",
);
store.close();
store = new BudgetStore(path, config);
await attempt(
  "Overspend after signer restart",
  "2",
  50000000n,
  "BUDGET_EXCEEDED",
);
await attempt(
  "Signing outage preserves 10 USDC reservation",
  "2",
  10000000n,
  "SIGNER_OFFLINE",
  { failSigning: true },
);
await attempt(
  "Uncertain signing cannot be retried blindly",
  "2",
  10000000n,
  "NONCE_ALREADY_RESERVED",
);
assert.equal(store.reserved(), "70000000");
assert.equal(signatures, 2);
const report = {
  generatedAt: new Date().toISOString(),
  mode: "OFFLINE_SIMULATION",
  chain: "Base Sepolia",
  fundsTransferred: "0",
  certificateSource: "Synthetic local attestor; not deployed API",
  nonceSource: "Synthetic pending nonce; no RPC",
  signatures,
  reservedAtomic: store.reserved(),
  results,
  limitations: [
    "Not audited or production enabled",
    "No onchain settlement or x402 payment tested",
    "Native/standard ERC20 transfer intent only; token behavior and gas excluded",
    "Same SQLite file required across signer processes; owner protects configuration and signer key",
    "Reservations retained on ambiguous failures; no automatic refund",
  ],
};
store.close();
writeFileSync(
  new URL("../../docs/hackathon/demo-results.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
