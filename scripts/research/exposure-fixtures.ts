import { writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  analyzePermitExposure,
  permitBatchTypedData,
} from "../../src/research/permit-exposure.js";

// Deliberately expired authorizations, made by an unfunded ephemeral account.
// No key is serialized, and no RPC or wallet connection is used.
const owner = privateKeyToAccount(generatePrivateKey());
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const domain = { chainId: 31337, verifyingContract: address(100) };
const spender = address(101);
const assets = [1, 2, 3].map((n) => ({ token: address(n), weight: "1" }));
const slots = assets.map(({ token }) => ({
  token,
  spender,
  nonce: "0",
  currentAllowance: "0",
  expiration: "2",
}));
const detail = (n: number, nonce = "0", amount = "3") => ({
  token: address(n),
  amount,
  expiration: "2",
  nonce,
});
async function signed(id: string, details: ReturnType<typeof detail>[]) {
  const permit = { id, spender, sigDeadline: "2", details };
  return {
    ...permit,
    signature: await owner.signTypedData(permitBatchTypedData(domain, permit)),
  };
}
const base = { domain, owner: owner.address, asOfTimestamp: 1, assets, slots };
const examples = [
  {
    id: "triangle",
    title: "Three conflicting batches",
    description:
      "A uses X+Y, B uses Y+Z, C uses X+Z. Any two collide on a nonce. All weights are one synthetic risk unit.",
    input: {
      ...base,
      permits: [
        await signed("A", [detail(1), detail(2)]),
        await signed("B", [detail(2), detail(3)]),
        await signed("C", [detail(1), detail(3)]),
      ],
    },
  },
  {
    id: "sequential",
    title: "A second grant restores spending",
    description:
      "After draining A, nonce 1 enables B and restores the allowances. Counting only the final allowance misses the earlier withdrawal.",
    input: {
      ...base,
      permits: [
        await signed("A", [detail(1), detail(2)]),
        await signed("B", [detail(1, "1"), detail(2, "1")]),
      ],
    },
  },
  {
    id: "cycle",
    title: "Valid signatures, impossible order",
    description:
      "A needs Y at nonce 1, but B needs X at nonce 1. Both start at zero. Neither batch can execute, although both signatures verify.",
    input: {
      ...base,
      permits: [
        await signed("A", [detail(1), detail(2, "1")]),
        await signed("B", [detail(1, "1"), detail(2)]),
      ],
    },
  },
  {
    id: "latent",
    title: "Zero allowance can be restored",
    description:
      "The current allowance is zero, but an unused signed permit can restore seven units. A wallet balance of zero would not invalidate that signature either.",
    input: {
      ...base,
      permits: [await signed("Old-permit", [detail(1, "0", "7")])],
    },
  },
  {
    id: "remaining",
    title: "Used permit, live allowance",
    description:
      "The nonce advanced, so the old permit cannot execute again. Five units of its existing allowance are still available to the spender.",
    input: {
      ...base,
      slots: slots.map((s, i) =>
        i === 0 ? { ...s, nonce: "1", currentAllowance: "5" } : s,
      ),
      permits: [await signed("Used-permit", [detail(1, "0", "5")])],
    },
  },
];
const results = [];
for (const example of examples)
  results.push({
    ...example,
    expected: await analyzePermitExposure(example.input),
  });
const output = {
  generatedAt: new Date().toISOString(),
  mode: "synthetic expired EOA signatures; historical timestamp 1; no money",
  examples: results,
};
for (const path of [
  "docs/research/exposure-fixtures.json",
  "live-testnet/assets/exposure-fixtures.json",
])
  writeFileSync(path, JSON.stringify(output, null, 2) + "\n");
console.log(
  JSON.stringify(
    results.map((r) => ({
      id: r.id,
      maximum: r.expected.maxTotal,
      witness: r.expected.witness,
    })),
  ),
);
