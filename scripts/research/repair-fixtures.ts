import { writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { permitBatchTypedData } from "../../src/research/permit-exposure.js";
import { planPermitRepair } from "../../src/research/permit-repair.js";

// Public examples are expired, synthetic and unfunded. No secret is serialized.
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
    id: "selective",
    title: "Remove one permission. Keep the wanted order.",
    description:
      "Unwanted uses X + Y. Wanted uses X + Z. Advancing Y's nonce disables Unwanted while Wanted can still execute. Advancing X would break both.",
    input: {
      inventory: {
        ...base,
        permits: [
          await signed("Unwanted", [detail(1), detail(2)]),
          await signed("Wanted", [detail(1), detail(3)]),
        ],
      },
      unwantedPermitIds: ["Unwanted"],
      wantedSequence: ["Wanted"],
    },
  },
  {
    id: "shared",
    title: "Two signatures share the same cancellation scope",
    description:
      "Both signatures require X at nonce 0. Every supported nonce invalidation that blocks Unwanted also blocks Wanted. Clearing today's allowance does not invalidate either signature.",
    input: {
      inventory: {
        ...base,
        permits: [
          await signed("Unwanted", [detail(1)]),
          await signed("Wanted", [detail(1, "0", "2")]),
        ],
      },
      unwantedPermitIds: ["Unwanted"],
      wantedSequence: ["Wanted"],
    },
  },
  {
    id: "later",
    title: "The unwanted permission becomes usable later",
    description:
      "Wanted advances X to nonce 1. That enables Unwanted, which also needs Y at nonce 0. The planner must block the later permission while keeping Wanted executable.",
    input: {
      inventory: {
        ...base,
        permits: [
          await signed("Wanted", [detail(1)]),
          await signed("Unwanted", [detail(1, "1"), detail(2)]),
        ],
      },
      unwantedPermitIds: ["Unwanted"],
      wantedSequence: ["Wanted"],
    },
  },
  {
    id: "clear",
    title: "Clear the allowance and prevent its restoration",
    description:
      "X has five units of stored allowance and an unused permit can restore it. This requires both a nonce invalidation and lockdown. Wanted uses Y and stays executable.",
    input: {
      inventory: {
        ...base,
        slots: slots.map((s, i) =>
          i === 0 ? { ...s, currentAllowance: "5" } : s,
        ),
        permits: [
          await signed("Restore-X", [detail(1)]),
          await signed("Wanted", [detail(2)]),
        ],
      },
      unwantedPermitIds: ["Restore-X"],
      wantedSequence: ["Wanted"],
      clearAllowanceSlots: [{ token: address(1), spender }],
    },
  },
  {
    id: "unchanged",
    title: "Already blocked; preserve a valid sequence",
    description:
      "Unwanted's nonce was already consumed. Wanted-1 and Wanted-2 can execute in the requested order. No repair is needed for these supplied constraints.",
    input: {
      inventory: {
        ...base,
        slots: slots.map((s, i) => (i === 0 ? { ...s, nonce: "1" } : s)),
        permits: [
          await signed("Unwanted", [detail(1)]),
          await signed("Wanted-1", [detail(2)]),
          await signed("Wanted-2", [detail(2, "1")]),
        ],
      },
      unwantedPermitIds: ["Unwanted"],
      wantedSequence: ["Wanted-1", "Wanted-2"],
    },
  },
];
const results = [];
for (const e of examples)
  results.push({ ...e, expected: await planPermitRepair(e.input) });
const output = {
  generatedAt: new Date().toISOString(),
  mode: "expired synthetic EOA signatures; historical timestamp 1; no funds",
  examples: results,
};
for (const path of [
  "docs/research/repair-fixtures.json",
  "live-testnet/assets/repair-fixtures.json",
])
  writeFileSync(path, JSON.stringify(output, null, 2) + "\n");
console.log(
  JSON.stringify(
    results.map((e) => ({
      id: e.id,
      status: e.expected.status,
      cost: e.expected.totalCost,
      actions: e.expected.actions.map((a) => a.kind),
    })),
  ),
);
