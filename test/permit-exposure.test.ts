import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  parseSignature,
  serializeCompactSignature,
  signatureToCompactSignature,
  type Address,
  type Hex,
} from "viem";
import {
  analyzePermitExposure,
  permitBatchTypedData,
  permitExposureInputSchema,
  verifyExposureCertificate,
  type ExposurePermit,
  type PermitExposureInput,
} from "../src/research/permit-exposure.js";

const x = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const y = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const z = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const spender = "0x1111111111111111111111111111111111111111" as Address;
const otherSpender = "0x2222222222222222222222222222222222222222" as Address;
const domain = {
  chainId: 31337,
  verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address,
};

function detail(token: Address, amount: number, nonce = 0, expiration = 2) {
  return {
    token,
    amount: String(amount),
    nonce: String(nonce),
    expiration: String(expiration),
  };
}

function batch(
  id: string,
  details: ExposurePermit["details"],
  changes: Partial<Omit<ExposurePermit, "id" | "details" | "signature">> = {},
): Omit<ExposurePermit, "signature"> {
  return { id, spender, sigDeadline: "2", details, ...changes };
}

async function fixture(
  batches: Omit<ExposurePermit, "signature">[],
  overrides: Partial<Omit<PermitExposureInput, "owner" | "permits">> = {},
): Promise<PermitExposureInput> {
  // Keys are newly generated in memory and are never serialized or written.
  const account = privateKeyToAccount(generatePrivateKey());
  const tokens = [
    ...new Set(
      batches.flatMap((permit) => permit.details.map((entry) => entry.token)),
    ),
  ];
  const uniqueSlots = new Map<string, PermitExposureInput["slots"][number]>();
  for (const permit of batches)
    for (const entry of permit.details)
      uniqueSlots.set(`${entry.token}:${permit.spender}`, {
        token: entry.token,
        spender: permit.spender,
        nonce: "0",
        currentAllowance: "0",
        expiration: "2",
      });
  const input: PermitExposureInput = {
    domain,
    owner: account.address,
    asOfTimestamp: 1,
    assets: tokens.map((token) => ({ token, weight: "1" })),
    slots: [...uniqueSlots.values()],
    permits: [],
    ...overrides,
  };
  input.permits = await Promise.all(
    batches.map(async (permit) => ({
      ...permit,
      signature: await account.signTypedData(
        permitBatchTypedData(input.domain, permit),
      ),
    })),
  );
  return input;
}

/** Test oracle: enumerate every full permutation, try each permit in order, and
 * skip failures. Every successful subsequence appears in some permutation. It
 * does not share the production DFS, compiled actions, or frontier helpers. */
function permutationOracle(input: PermitExposureInput): bigint {
  let best = 0n;
  const permutation = (prefix: number[], remaining: number[]) => {
    if (remaining.length > 0) {
      for (const index of remaining)
        permutation(
          [...prefix, index],
          remaining.filter((candidate) => candidate !== index),
        );
      return;
    }
    const state = new Map(
      input.slots.map((slot) => [
        `${slot.token.toLowerCase()}:${slot.spender.toLowerCase()}`,
        BigInt(slot.nonce),
      ]),
    );
    let total = 0n;
    for (const index of prefix) {
      const permit = input.permits[index]!;
      if (BigInt(permit.sigDeadline) < BigInt(input.asOfTimestamp)) continue;
      if (
        !permit.details.every(
          (entry) =>
            state.get(
              `${entry.token.toLowerCase()}:${permit.spender.toLowerCase()}`,
            ) === BigInt(entry.nonce),
        )
      )
        continue;
      for (const entry of permit.details) {
        state.set(
          `${entry.token.toLowerCase()}:${permit.spender.toLowerCase()}`,
          BigInt(entry.nonce) + 1n,
        );
        if (
          entry.expiration === "0" ||
          BigInt(entry.expiration) >= BigInt(input.asOfTimestamp)
        ) {
          const weight = input.assets.find(
            (asset) => asset.token.toLowerCase() === entry.token.toLowerCase(),
          )!.weight;
          total += BigInt(entry.amount) * BigInt(weight);
        }
      }
    }
    if (total > best) best = total;
  };
  permutation(
    [],
    input.permits.map((_, index) => index),
  );
  return best;
}

describe("Korp Exposure Map", () => {
  it("computes the atomic triangle: naive 18, per-slot nonce maximum 9, actual 6", async () => {
    const input = await fixture([
      batch("A", [detail(x, 3), detail(y, 3)]),
      batch("B", [detail(y, 3), detail(z, 3)]),
      batch("C", [detail(x, 3), detail(z, 3)]),
    ]);
    const result = await analyzePermitExposure(input);
    expect(result.maxAdditional).toBe("6");
    expect(result.baselineAllowance).toBe("0");
    expect(result.maxTotal).toBe("6");
    expect(result.naive.sumOfSignedGrants).toBe("18");
    expect(result.naive.perSlotNonceMax).toBe("9");
    expect(result.witness).toEqual(["A"]);
    expect(result.reachableStateCount).toBe(4);
    expect(result.unit).toBe("synthetic-budget-units");
    expect(await verifyExposureCertificate(input, result)).toBe(true);
    // A different optimal witness is equally valid.
    expect(
      await verifyExposureCertificate(input, { ...result, witness: ["C"] }),
    ).toBe(true);
  });

  it("counts sequential regrants, not only the largest allowance ever signed", async () => {
    const input = await fixture([
      batch("second", [detail(x, 7, 1)]),
      batch("first", [detail(x, 5, 0)]),
    ]);
    const result = await analyzePermitExposure(input);
    expect(result.maxAdditional).toBe("12");
    expect(result.witness).toEqual(["first", "second"]);
    expect(await verifyExposureCertificate(input, result)).toBe(true);
    expect(
      await verifyExposureCertificate(input, {
        ...result,
        witness: ["second", "first"],
      }),
    ).toBe(false);
  });

  it("rejects an unreachable ordering cycle even though no exact nonce resource is shared", async () => {
    const input = await fixture([
      batch("A", [detail(x, 3, 0), detail(y, 3, 1)]),
      batch("B", [detail(x, 3, 1), detail(y, 3, 0)]),
    ]);
    const result = await analyzePermitExposure(input);
    expect(result.maxAdditional).toBe("0");
    expect(result.naive.perSlotNonceMax).toBe("12");
    expect(result.witness).toEqual([]);
    expect(result.reachableStateCount).toBe(1);
  });

  it("allows an expired allowance grant to advance a nonce and unlock a later grant", async () => {
    const input = await fixture(
      [
        batch("expired-grant", [detail(x, 100, 0, 1)]),
        batch("next", [detail(x, 8, 1, 3)]),
      ],
      { asOfTimestamp: 2 },
    );
    const result = await analyzePermitExposure(input);
    expect(result.maxAdditional).toBe("8");
    expect(result.witness).toEqual(["expired-grant", "next"]);
    expect(result.naive.sumOfSignedGrants).toBe("8");
  });

  it("honors inclusive signature/allowance deadlines and expiration-zero grant semantics", async () => {
    const input = await fixture(
      [
        batch("equal", [detail(x, 3, 0, 2)]),
        batch("zero", [detail(x, 4, 1, 0)]),
      ],
      { asOfTimestamp: 2 },
    );
    expect((await analyzePermitExposure(input)).maxAdditional).toBe("7");
    expect(
      (await analyzePermitExposure({ ...input, asOfTimestamp: 3 }))
        .maxAdditional,
    ).toBe("0");
    const before = await fixture(
      [
        batch("expired-signature", [detail(x, 10, 0, 3)], { sigDeadline: "1" }),
        batch("blocked-next", [detail(x, 20, 1, 3)]),
      ],
      { asOfTimestamp: 2 },
    );
    expect((await analyzePermitExposure(before)).maxAdditional).toBe("0");
  });

  it("preserves existing allowance when its permit nonce is consumed, with independent spender slots", async () => {
    const input = await fixture(
      [
        batch("already-used", [detail(x, 90, 0)]),
        batch("regrant", [detail(x, 7, 1)]),
        batch("other-spender", [detail(x, 3, 0)], { spender: otherSpender }),
      ],
      {
        assets: [{ token: x, weight: "2" }],
        slots: [
          {
            token: x,
            spender,
            nonce: "1",
            currentAllowance: "5",
            expiration: "1",
          },
          {
            token: x,
            spender: otherSpender,
            nonce: "0",
            currentAllowance: "2",
            expiration: "1",
          },
        ],
      },
    );
    const result = await analyzePermitExposure(input);
    expect(result.baselineAllowance).toBe("14");
    expect(result.maxAdditional).toBe("20");
    expect(result.maxTotal).toBe("34");
    expect(result.witness).not.toContain("already-used");
    expect(result.naive.perSlotNonceMax).toBe("20");
  });

  it("treats snapshot expiration zero as literal stored state, and handles empty inventories", async () => {
    const input = await fixture([], {
      assets: [
        { token: x, weight: "3" },
        { token: y, weight: "4" },
      ],
      slots: [
        {
          token: x,
          spender,
          nonce: "0",
          currentAllowance: "5",
          expiration: "0",
        },
        {
          token: y,
          spender,
          nonce: "1",
          currentAllowance: "7",
          expiration: "1",
        },
      ],
    });
    const result = await analyzePermitExposure(input);
    expect(result.baselineAllowance).toBe("28");
    expect(result.maxAdditional).toBe("0");
    expect(result.reachableStateCount).toBe(1);
    expect(await verifyExposureCertificate(input, result)).toBe(true);
  });

  it("normalizes address case before verifying signatures and identifying duplicate slots", async () => {
    const input = await fixture([batch("A", [detail(x, 3)])]);
    const changed = structuredClone(input);
    const uppercase = (address: string) =>
      `0x${address.slice(2).toUpperCase()}`;
    changed.owner = uppercase(changed.owner) as Address;
    changed.assets[0]!.token = uppercase(x) as Address;
    changed.permits[0]!.details[0]!.token = uppercase(x) as Address;
    expect((await analyzePermitExposure(changed)).maxAdditional).toBe("3");
    changed.slots.push({
      ...changed.slots[0]!,
      token: uppercase(x) as Address,
    });
    await expect(analyzePermitExposure(changed)).rejects.toThrow(
      "Duplicate snapshot slot",
    );
  });

  it("fails closed for invalid signatures, changed domains and payload tampering", async () => {
    const input = await fixture([batch("A", [detail(x, 3)])]);
    for (const change of [
      (copy: PermitExposureInput) => {
        copy.domain.chainId++;
      },
      (copy: PermitExposureInput) => {
        copy.domain.verifyingContract = otherSpender;
      },
      (copy: PermitExposureInput) => {
        copy.owner = privateKeyToAccount(generatePrivateKey()).address;
      },
      (copy: PermitExposureInput) => {
        copy.permits[0]!.details[0]!.amount = "4";
      },
      (copy: PermitExposureInput) => {
        copy.permits[0]!.signature = `0x${"00".repeat(64)}1b`;
      },
    ]) {
      const changed = structuredClone(input);
      change(changed);
      await expect(analyzePermitExposure(changed)).rejects.toThrow(
        "EXPOSURE_INVALID_SIGNATURE",
      );
      await expect(verifyExposureCertificate(changed, {})).rejects.toThrow(
        "EXPOSURE_INVALID_SIGNATURE",
      );
    }
    // Even an expired, presently unusable entry must have a genuine signature.
    const invalidExpired = structuredClone(input);
    invalidExpired.asOfTimestamp = 3;
    invalidExpired.permits[0]!.signature = `0x${"00".repeat(64)}1b`;
    await expect(analyzePermitExposure(invalidExpired)).rejects.toThrow(
      "EXPOSURE_INVALID_SIGNATURE",
    );
  });

  it("rejects normalized recovery ids 0/1 that Permit2's raw ecrecover does not accept", async () => {
    const input = await fixture([batch("A", [detail(x, 3)])]);
    for (const v of ["00", "01"]) {
      const changed = structuredClone(input);
      changed.permits[0]!.signature = `${changed.permits[0]!.signature.slice(0, -2)}${v}`;
      await expect(analyzePermitExposure(changed)).rejects.toThrow(
        "Permit2 65-byte signatures require v = 27 or 28",
      );
    }
  });

  it("accepts Permit2's 64-byte EIP-2098 signatures for both recovery ids", async () => {
    const parities = new Set<number>();
    // Each fresh key yields a random parity; stop once both have been exercised.
    for (let i = 0; i < 64 && parities.size < 2; i++) {
      const input = await fixture([
        batch("A", [detail(x, 3), detail(y, 4)]),
        batch("B", [detail(x, 5, 1)]),
      ]);
      const compact = structuredClone(input);
      for (const permit of compact.permits) {
        const parsed = parseSignature(permit.signature as Hex);
        parities.add(parsed.yParity!);
        permit.signature = serializeCompactSignature(
          signatureToCompactSignature(parsed),
        );
        expect(permit.signature).toHaveLength(130);
      }
      const expected = await analyzePermitExposure(input);
      const result = await analyzePermitExposure(compact);
      expect(result.maxTotal).toBe(expected.maxTotal);
      expect(result.witness).toEqual(expected.witness);
      await expect(verifyExposureCertificate(compact, result)).resolves.toBe(
        true,
      );

      // Flipping the vs top bit selects the other recovery id and signer.
      const flipped = structuredClone(compact);
      const vs = BigInt(`0x${flipped.permits[0]!.signature.slice(66)}`);
      flipped.permits[0]!.signature = `${flipped.permits[0]!.signature.slice(0, 66)}${(vs ^ (1n << 255n)).toString(16).padStart(64, "0")}`;
      await expect(analyzePermitExposure(flipped)).rejects.toThrow(
        "EXPOSURE_INVALID_SIGNATURE",
      );
    }
    expect(parities).toEqual(new Set([0, 1]));
  });

  it("rejects incomplete snapshots, unknown fields and unsupported integers before solving", async () => {
    const input = await fixture([batch("A", [detail(x, 3)])]);
    const invalid: unknown[] = [
      { ...input, slots: [] },
      { ...input, assets: [] },
      { ...input, guessedBalance: "100" },
      { ...input, domain: { ...input.domain, version: "1" } },
      { ...input, assets: [{ token: x, weight: "0" }] },
      { ...input, assets: [{ token: x, weight: "1e6" }] },
      { ...input, assets: [{ token: x, weight: "01" }] },
      { ...input, asOfTimestamp: NaN },
      { ...input, asOfTimestamp: 1.5 },
      { ...input, domain: { ...input.domain, chainId: 0 } },
      {
        ...input,
        slots: [
          {
            ...input.slots[0]!,
            currentAllowance: ((1n << 160n) - 1n).toString(),
          },
        ],
      },
      {
        ...input,
        permits: [
          {
            ...input.permits[0]!,
            details: [
              {
                ...input.permits[0]!.details[0]!,
                amount: ((1n << 160n) - 1n).toString(),
              },
            ],
          },
        ],
      },
      {
        ...input,
        permits: [
          {
            ...input.permits[0]!,
            details: [
              {
                ...input.permits[0]!.details[0]!,
                nonce: ((1n << 48n) - 1n).toString(),
              },
            ],
          },
        ],
      },
      {
        ...input,
        permits: [
          {
            ...input.permits[0]!,
            details: [{ ...input.permits[0]!.details[0]!, extra: true }],
          },
        ],
      },
      { ...input, permits: [{ ...input.permits[0]!, signature: "0x1234" }] },
      {
        ...input,
        permits: [
          { ...input.permits[0]!, details: [detail(x, 3), detail(x, 4, 1)] },
        ],
      },
      {
        ...input,
        permits: Array.from({ length: 13 }, (_, i) => ({
          ...input.permits[0]!,
          id: `p${i}`,
        })),
      },
      { ...input, permits: [input.permits[0], input.permits[0]] },
    ];
    for (const bad of invalid)
      await expect(analyzePermitExposure(bad)).rejects.toThrow();
    expect(
      permitExposureInputSchema.safeParse({ ...input, extra: true }).success,
    ).toBe(false);
  });

  it("uses exact bigint arithmetic for large finite allowances and declared weights", async () => {
    const amount = ((1n << 160n) - 2n).toString();
    const weight = ((1n << 256n) - 1n).toString();
    const input = await fixture(
      [batch("large", [{ token: x, amount, nonce: "0", expiration: "2" }])],
      { assets: [{ token: x, weight }] },
    );
    const result = await analyzePermitExposure(input);
    expect(result.maxAdditional).toBe(
      (BigInt(amount) * BigInt(weight)).toString(),
    );
    expect(await verifyExposureCertificate(input, result)).toBe(true);
  });

  it("agrees with a separate exhaustive permutation oracle on generated small inventories", async () => {
    // Deterministic scenario selection; signing keys remain freshly random.
    let seed = 1937;
    const next = (max: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % max;
    };
    for (let trial = 0; trial < 12; trial++) {
      const batches = Array.from({ length: 5 }, (_, i) => {
        const chosen = [x, y, z].filter(() => next(2) === 1);
        if (chosen.length === 0) chosen.push(x);
        return batch(
          `p${i}`,
          chosen.map((token) => detail(token, next(8), next(3), next(4))),
          {
            sigDeadline: String(next(4)),
            spender: next(2) === 0 ? spender : otherSpender,
          },
        );
      });
      const input = await fixture(batches, { asOfTimestamp: 2 });
      const result = await analyzePermitExposure(input);
      expect(result.maxAdditional).toBe(permutationOracle(input).toString());
      expect(BigInt(result.maxAdditional)).toBeLessThanOrEqual(
        BigInt(result.naive.sumOfSignedGrants),
      );
      expect(BigInt(result.maxAdditional)).toBeLessThanOrEqual(
        BigInt(result.naive.perSlotNonceMax),
      );
      expect(await verifyExposureCertificate(input, result)).toBe(true);
    }
  });

  it("memoizes the full 12-independent-permit case within 4096 reachable states", async () => {
    const batches = Array.from({ length: 12 }, (_, i) =>
      batch(`p${i}`, [detail(x, 1)], {
        spender: `0x${(i + 100).toString(16).padStart(40, "0")}` as Address,
      }),
    );
    const result = await analyzePermitExposure(await fixture(batches));
    expect(result.maxAdditional).toBe("12");
    expect(result.reachableStateCount).toBe(4096);
  });

  it("rejects forged certificate values, invalid witnesses, missing limits and inventory mismatches", async () => {
    const input = await fixture([
      batch("A", [detail(x, 3), detail(y, 3)]),
      batch("B", [detail(y, 3), detail(z, 3)]),
    ]);
    const result = await analyzePermitExposure(input);
    for (const changed of [
      { ...result, maxAdditional: "12" },
      { ...result, maxTotal: "0" },
      { ...result, baselineAllowance: "1" },
      { ...result, inputHash: `0x${"00".repeat(32)}` },
      { ...result, witness: ["A", "B"] },
      { ...result, witness: ["A", "A"] },
      { ...result, witness: ["missing"] },
      { ...result, witness: [] },
      { ...result, reachableStateCount: 99 },
      { ...result, naive: { ...result.naive, sumOfSignedGrants: "100" } },
      { ...result, modelLimits: [] },
      { ...result, verifiedOnChain: true },
    ])
      expect(await verifyExposureCertificate(input, changed)).toBe(false);
    expect(
      await verifyExposureCertificate({ ...input, asOfTimestamp: 2 }, result),
    ).toBe(false);
    await expect(
      verifyExposureCertificate({ ...input, slots: [] }, result),
    ).rejects.toThrow();
  });
});
