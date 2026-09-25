import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  getAddress,
  parseSignature,
  serializeCompactSignature,
  signatureToCompactSignature,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  permitBatchTypedData,
  type ExposurePermit,
  type PermitExposureInput,
} from "../src/research/permit-exposure.js";
import {
  checkRepairSnapshot,
  permitRepairAbi,
  permitRepairInputSchema,
  planPermitRepair,
  RepairLimitError,
  verifyPermitRepair,
  type PermitRepairInput,
} from "../src/research/permit-repair.js";

const x = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const y = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const z = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const spender = "0x1111111111111111111111111111111111111111" as Address;
const domain = {
  chainId: 31337,
  verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address,
};
const slotKey = (token: string, account: string) =>
  `${token.toLowerCase()}:${account.toLowerCase()}`;
const detail = (token: Address, amount: number, nonce = 0, expiration = 2) => ({
  token,
  amount: String(amount),
  nonce: String(nonce),
  expiration: String(expiration),
});
const batch = (
  id: string,
  details: ExposurePermit["details"],
  override: Partial<Omit<ExposurePermit, "id" | "details" | "signature">> = {},
): Omit<ExposurePermit, "signature"> => ({
  id,
  spender,
  sigDeadline: "2",
  details,
  ...override,
});

async function fixture(
  batches: Omit<ExposurePermit, "signature">[],
  overrides: Partial<Omit<PermitExposureInput, "owner" | "permits">> = {},
): Promise<PermitRepairInput> {
  // Ephemeral keys and long-expired synthetic timestamps: no real capability or
  // private key is persisted, transmitted, or broadcast by these tests.
  const account = privateKeyToAccount(generatePrivateKey());
  const tokens = [
    ...new Set(
      batches.flatMap((permit) => permit.details.map((entry) => entry.token)),
    ),
  ];
  const slots = new Map<string, PermitExposureInput["slots"][number]>();
  for (const permit of batches)
    for (const entry of permit.details)
      slots.set(slotKey(entry.token, permit.spender), {
        token: entry.token,
        spender: permit.spender,
        nonce: "0",
        currentAllowance: "0",
        expiration: "2",
      });
  const inventory: PermitExposureInput = {
    domain,
    owner: account.address,
    asOfTimestamp: 1,
    assets: tokens.map((token) => ({ token, weight: "1" })),
    slots: [...slots.values()],
    permits: [],
    ...overrides,
  };
  inventory.permits = await Promise.all(
    batches.map(async (permit) => ({
      ...permit,
      signature: await account.signTypedData(
        permitBatchTypedData(inventory.domain, permit),
      ),
    })),
  );
  return { inventory, unwantedPermitIds: [], wantedSequence: [] };
}

/** Independent small-model oracle. Enumerates candidate integers, directly
 * simulates wanted grants, then enumerates every permutation of known permits.
 * It shares no production reachability or nonce-candidate helpers. */
function oracleMinimum(input: PermitRepairInput): bigint | null {
  const normalized = permitRepairInputSchema.parse(input);
  const inventory = normalized.inventory;
  const now = BigInt(inventory.asOfTimestamp);
  const keys = inventory.slots.map((slot) => slotKey(slot.token, slot.spender));
  const clear = new Set(
    normalized.clearAllowanceSlots.map((slot) =>
      slotKey(slot.token, slot.spender),
    ),
  );
  let best: bigint | null = null;
  const simulate = (
    order: ExposurePermit[],
    state: bigint[],
    assertAll: boolean,
    safety: boolean,
  ) => {
    for (const permit of order) {
      const eligible =
        now <= BigInt(permit.sigDeadline) &&
        permit.details.every(
          (entry) =>
            state[keys.indexOf(slotKey(entry.token, permit.spender))] ===
            BigInt(entry.nonce),
        );
      if (!eligible) {
        if (assertAll) return false;
        continue;
      }
      if (
        safety &&
        (normalized.unwantedPermitIds.includes(permit.id) ||
          permit.details.some(
            (entry) =>
              clear.has(slotKey(entry.token, permit.spender)) &&
              BigInt(entry.amount) > 0n,
          ))
      )
        return false;
      for (const entry of permit.details) {
        const i = keys.indexOf(slotKey(entry.token, permit.spender));
        state[i] = BigInt(entry.nonce) + 1n;
      }
    }
    return true;
  };
  const permutations = (values: ExposurePermit[]): ExposurePermit[][] =>
    values.length === 0
      ? [[]]
      : values.flatMap((value, i) =>
          permutations(values.filter((_, j) => i !== j)).map((suffix) => [
            value,
            ...suffix,
          ]),
        );
  const orders = permutations(inventory.permits);
  const selected = (i: number, values: bigint[]) => {
    if (i < inventory.slots.length) {
      const current = BigInt(inventory.slots[i]!.nonce);
      // Fixtures use nonces 0..2; enumerate ALL integers through 3 rather than
      // production canonical representatives to test their completeness.
      for (let nonce = current; nonce <= 3n; nonce++)
        selected(i + 1, [...values, nonce]);
      return;
    }
    const wanted = normalized.wantedSequence.map((id) =>
      inventory.permits.find((permit) => permit.id === id)!,
    );
    if (!simulate(wanted, [...values], true, false)) return;
    if (!orders.every((order) => simulate(order, [...values], false, true)))
      return;
    let cost = 0n;
    for (const [index, slot] of inventory.slots.entries()) {
      const difference = values[index]! - BigInt(slot.nonce);
      cost +=
        ((difference + 65534n) / 65535n) *
        BigInt(normalized.costs.invalidateNonce);
      if (clear.has(keys[index]!) && BigInt(slot.currentAllowance) > 0n)
        cost += BigInt(normalized.costs.clearAllowance);
    }
    if (best === null || cost < best) best = cost;
  };
  selected(0, []);
  return best;
}

describe("Korp Repair Planner", () => {
  it("finds one shared batch invalidation instead of two separate cuts", async () => {
    const input = await fixture([
      batch("bad-a", [detail(x, 4), detail(y, 4)]),
      batch("bad-b", [detail(x, 5), detail(z, 5)]),
    ]);
    input.unwantedPermitIds = ["bad-a", "bad-b"];
    const result = await planPermitRepair(input);
    expect(result.status).toBe("repairable");
    expect(result.totalCost).toBe("1");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      kind: "invalidateNonces",
      token: x,
      spender,
      newNonce: "1",
    });
    const transaction = result.actions[0]!.transaction;
    expect(transaction.from).toBe(input.inventory.owner.toLowerCase());
    expect(transaction.to).toBe(domain.verifyingContract);
    expect(transaction.chainId).toBe(domain.chainId);
    expect(transaction.value).toBe("0");
    expect(
      decodeFunctionData({ abi: permitRepairAbi, data: transaction.data }),
    ).toMatchObject({
      functionName: "invalidateNonces",
      args: [getAddress(x), spender, 1],
    });
    expect(await verifyPermitRepair(input, result)).toBe(true);
  });

  it("selectively blocks a shared batch while preserving the specified wanted batch", async () => {
    const input = await fixture([
      batch("unwanted", [detail(x, 3), detail(y, 3)]),
      batch("wanted", [detail(y, 3), detail(z, 3)]),
    ]);
    input.unwantedPermitIds = ["unwanted"];
    input.wantedSequence = ["wanted"];
    const result = await planPermitRepair(input);
    expect(result.status).toBe("repairable");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ token: x, newNonce: "1" });
    expect(result.wantedWitness).toEqual(["wanted"]);
    expect(result.expectedSlots.find((slot) => slot.token === y)!.nonce).toBe(
      "0",
    );
  });

  it("plans identically when the inventory uses 64-byte EIP-2098 signatures", async () => {
    const input = await fixture([
      batch("unwanted", [detail(x, 3), detail(y, 3)]),
      batch("wanted", [detail(y, 3), detail(z, 3)]),
    ]);
    input.unwantedPermitIds = ["unwanted"];
    input.wantedSequence = ["wanted"];
    const compact = structuredClone(input);
    for (const permit of compact.inventory.permits)
      permit.signature = serializeCompactSignature(
        signatureToCompactSignature(parseSignature(permit.signature as Hex)),
      );
    const expected = await planPermitRepair(input);
    const result = await planPermitRepair(compact);
    expect(result.actions).toEqual(expected.actions);
    expect(result.expectedSlots).toEqual(expected.expectedSlots);
    expect(await verifyPermitRepair(compact, result)).toBe(true);
  });

  it("reports the concrete same-nonce impossibility when cancelling one would break the wanted permit", async () => {
    const input = await fixture([
      batch("bad", [detail(x, 9)]),
      batch("wanted", [detail(x, 3)]),
    ]);
    input.unwantedPermitIds = ["bad"];
    input.wantedSequence = ["wanted"];
    const result = await planPermitRepair(input);
    expect(result.status).toBe("impossible");
    expect(result.totalCost).toBeNull();
    expect(result.actions).toEqual([]);
    expect(result.explanation.message).toContain(
      "Impossible within the supported repair actions",
    );
    expect(result.explanation.witness).toEqual(["bad"]);
    expect(result.explanation.slotKeys).toContain(slotKey(x, spender));
    expect(result.search.candidateSpace).toBe(1);
    expect(await verifyPermitRepair(input, result)).toBe(true);
  });

  it("detects unwanted grants reachable after a neutral predecessor, and rejects the unlocking intermediate threshold", async () => {
    const input = await fixture([
      batch("neutral", [detail(x, 0)]),
      batch("bad", [detail(x, 7, 1)]),
    ]);
    input.unwantedPermitIds = ["bad"];
    const result = await planPermitRepair(input);
    expect(result.status).toBe("repairable");
    // Setting nonce 1 would skip neutral and directly ENABLE bad.
    expect(result.actions[0]).toMatchObject({ newNonce: "2" });
    expect(result.search.candidateCount).toBe(3);
    expect(await verifyPermitRepair(input, result)).toBe(true);
  });

  it("can enable a future wanted grant using the signed nonce candidate, not only nonce+1", async () => {
    const input = await fixture([batch("wanted", [detail(x, 4, 2)])]);
    input.wantedSequence = ["wanted"];
    const result = await planPermitRepair(input);
    expect(result.status).toBe("repairable");
    expect(result.actions[0]).toMatchObject({ newNonce: "2" });
    expect(result.wantedWitness).toEqual(["wanted"]);
  });

  it("requires wanted permits to execute together in exact order, not merely each individually", async () => {
    const input = await fixture([
      batch("one", [detail(x, 3)]),
      batch("other", [detail(x, 4)]),
    ]);
    input.wantedSequence = ["one", "other"];
    const result = await planPermitRepair(input);
    expect(result.status).toBe("impossible");
    expect(result.explanation.code).toBe("WANTED_ORDER_CONFLICT");
    expect(result.explanation.message).toContain(
      "preceding wanted permits leave nonce 1",
    );
    expect(result.explanation.witness).toEqual(["one", "other"]);
  });

  it("requires nonce invalidation plus lockdown to keep a restorable existing allowance zero", async () => {
    const input = await fixture([batch("restore", [detail(x, 7)])], {
      slots: [
        {
          token: x,
          spender,
          nonce: "0",
          currentAllowance: "5",
          expiration: "2",
        },
      ],
    });
    input.clearAllowanceSlots = [{ token: x, spender }];
    input.costs = { invalidateNonce: "7", clearAllowance: "3" };
    const result = await planPermitRepair(input);
    expect(result.totalCost).toBe("10");
    expect(result.actions.map((action) => action.kind)).toEqual([
      "invalidateNonces",
      "lockdown",
    ]);
    expect(result.expectedSlots[0]).toMatchObject({
      nonce: "1",
      currentAllowance: "0",
      expiration: "2",
    });
    expect(
      decodeFunctionData({
        abi: permitRepairAbi,
        data: result.actions[1]!.transaction.data,
      }).functionName,
    ).toBe("lockdown");
    expect(
      (await checkRepairSnapshot(input, result, result.expectedSlots)).matches,
    ).toBe(true);
  });

  it("uses literal stored zero for expired existing amounts and expired positive regrants", async () => {
    const input = await fixture(
      [batch("expired-positive", [detail(x, 7, 0, 1)])],
      {
        asOfTimestamp: 2,
        slots: [
          {
            token: x,
            spender,
            nonce: "0",
            currentAllowance: "5",
            expiration: "1",
          },
        ],
      },
    );
    input.clearAllowanceSlots = [{ token: x, spender }];
    const result = await planPermitRepair(input);
    expect(result.actions.map((action) => action.kind)).toEqual([
      "invalidateNonces",
      "lockdown",
    ]);
    expect(result.totalCost).toBe("2");
    const wanted = { ...input, wantedSequence: ["expired-positive"] };
    const conflict = await planPermitRepair(wanted);
    expect(conflict.status).toBe("impossible");
    expect(conflict.explanation.code).toBe("WANTED_CLEAR_CONFLICT");
  });

  it("allows zero-valued wanted grants on clear slots and preserves a sequential wanted grant order", async () => {
    const input = await fixture(
      [batch("first", [detail(x, 0)]), batch("next", [detail(x, 0, 1)])],
      {
        slots: [
          {
            token: x,
            spender,
            nonce: "0",
            currentAllowance: "8",
            expiration: "0",
          },
        ],
      },
    );
    input.clearAllowanceSlots = [{ token: x, spender }];
    input.wantedSequence = ["first", "next"];
    const result = await planPermitRepair(input);
    expect(result.actions.map((action) => action.kind)).toEqual(["lockdown"]);
    expect(result.wantedWitness).toEqual(["first", "next"]);
    expect(await verifyPermitRepair(input, result)).toBe(true);
  });

  it("leaves currently safe constraints unchanged and honors inclusive signature deadlines", async () => {
    const input = await fixture(
      [batch("expired", [detail(x, 9)], { sigDeadline: "1" })],
      { asOfTimestamp: 2 },
    );
    input.unwantedPermitIds = ["expired"];
    expect((await planPermitRepair(input)).status).toBe("unchanged");
    const atBoundary = {
      ...input,
      inventory: { ...input.inventory, asOfTimestamp: 1 },
    };
    expect((await planPermitRepair(atBoundary)).status).toBe("repairable");
    const wantedExpired = {
      ...input,
      unwantedPermitIds: [],
      wantedSequence: ["expired"],
    };
    expect((await planPermitRepair(wantedExpired)).explanation.code).toBe(
      "WANTED_SIGNATURE_EXPIRED",
    );
  });

  it("preserves unrelated existing allowances and expiration when only a nonce is invalidated", async () => {
    const input = await fixture([batch("bad", [detail(x, 9)])], {
      slots: [
        {
          token: x,
          spender,
          nonce: "0",
          currentAllowance: "5",
          expiration: "2",
        },
      ],
    });
    input.unwantedPermitIds = ["bad"];
    const result = await planPermitRepair(input);
    expect(result.actions.map((action) => action.kind)).toEqual([
      "invalidateNonces",
    ]);
    expect(result.expectedSlots[0]).toMatchObject({
      nonce: "1",
      currentAllowance: "5",
      expiration: "2",
    });
  });

  it("splits large nonce changes into minimal legal jumps and prices every invalidation call", async () => {
    const input = await fixture([batch("wanted", [detail(x, 4, 65536)])]);
    input.wantedSequence = ["wanted"];
    input.costs = { invalidateNonce: "4", clearAllowance: "2" };
    const result = await planPermitRepair(input);
    expect(result.actions).toMatchObject([
      { kind: "invalidateNonces", newNonce: "65535" },
      { kind: "invalidateNonces", newNonce: "65536" },
    ]);
    expect(result.totalCost).toBe("8");
    expect(await verifyPermitRepair(input, result)).toBe(true);
  });

  it("supports legal terminal invalidation to UINT48_MAX without confusing it with nonce wrap", async () => {
    const nonce = ((1n << 48n) - 2n).toString();
    const input = await fixture(
      [batch("bad", [{ token: x, amount: "1", nonce, expiration: "2" }])],
      {
        slots: [
          { token: x, spender, nonce, currentAllowance: "0", expiration: "2" },
        ],
      },
    );
    input.unwantedPermitIds = ["bad"];
    const result = await planPermitRepair(input);
    expect(result.actions[0]).toMatchObject({
      newNonce: ((1n << 48n) - 1n).toString(),
    });
    expect(await verifyPermitRepair(input, result)).toBe(true);
    expect(
      (await checkRepairSnapshot(input, result, result.expectedSlots)).matches,
    ).toBe(true);
  });

  it("reports explicit search limits instead of false impossibility for too many candidates or actions", async () => {
    const batches = Array.from({ length: 9 }, (_, i) =>
      batch(`p${i}`, [detail(x, 1, 1)], {
        spender: `0x${(i + 10).toString(16).padStart(40, "0")}` as Address,
      }),
    );
    const many = await fixture(batches);
    many.clearAllowanceSlots = [{ token: x, spender: batches[0]!.spender }];
    many.inventory.slots[0]!.currentAllowance = "1";
    await expect(planPermitRepair(many)).rejects.toThrow(RepairLimitError);
    await expect(planPermitRepair(many)).rejects.toThrow("candidate space");
    const far = await fixture([batch("wanted", [detail(x, 1, 65535 * 65)])]);
    far.wantedSequence = ["wanted"];
    await expect(planPermitRepair(far)).rejects.toThrow("more actions");
  });

  it("fails closed for malformed constraints, unknown data, costs and signature tampering", async () => {
    const input = await fixture([batch("A", [detail(x, 3)])]);
    for (const malformed of [
      { ...input, unwantedPermitIds: ["missing"] },
      { ...input, wantedSequence: ["A", "A"] },
      { ...input, unwantedPermitIds: ["A", "A"] },
      { ...input, clearAllowanceSlots: [{ token: y, spender }] },
      {
        ...input,
        clearAllowanceSlots: [
          { token: x, spender },
          { token: x, spender },
        ],
      },
      { ...input, costs: { invalidateNonce: "0", clearAllowance: "1" } },
      { ...input, costs: { invalidateNonce: "1e2", clearAllowance: "1" } },
      {
        ...input,
        costs: { invalidateNonce: "1", clearAllowance: "1", gasPrice: "1" },
      },
      { ...input, extra: true },
      { ...input, inventory: { ...input.inventory, slots: [] } },
    ])
      await expect(planPermitRepair(malformed)).rejects.toThrow();
    const altered = structuredClone(input);
    altered.inventory.permits[0]!.details[0]!.amount = "9";
    await expect(planPermitRepair(altered)).rejects.toThrow(
      "EXPOSURE_INVALID_SIGNATURE",
    );
    await expect(verifyPermitRepair(altered, {})).rejects.toThrow(
      "EXPOSURE_INVALID_SIGNATURE",
    );
    expect(
      permitRepairInputSchema.safeParse({
        ...input,
        costs: { invalidateNonce: "abc", clearAllowance: "1" },
      }).success,
    ).toBe(false);
  });

  it("recomputes plans and rejects altered calldata, claims, owner, costs and witnesses", async () => {
    const input = await fixture([batch("bad", [detail(x, 3)])]);
    input.unwantedPermitIds = ["bad"];
    const result = await planPermitRepair(input);
    for (const altered of [
      { ...result, totalCost: "0" },
      { ...result, status: "unchanged" },
      { ...result, actions: [] },
      { ...result, wantedWitness: ["bad"] },
      { ...result, modelLimits: [] },
      { ...result, search: { ...result.search, candidateCount: 0 } },
      {
        ...result,
        actions: [
          {
            ...result.actions[0]!,
            transaction: { ...result.actions[0]!.transaction, data: "0x" },
          },
        ],
      },
      {
        ...result,
        actions: [
          {
            ...result.actions[0]!,
            transaction: { ...result.actions[0]!.transaction, from: spender },
          },
        ],
      },
      {
        ...result,
        expectedSlots: [{ ...result.expectedSlots[0]!, nonce: "0" }],
      },
      { ...result, signed: true },
    ])
      expect(await verifyPermitRepair(input, altered)).toBe(false);
    expect(
      await verifyPermitRepair(
        { ...input, costs: { invalidateNonce: "2", clearAllowance: "1" } },
        result,
      ),
    ).toBe(false);
  });

  it("compares caller-supplied after-state exactly including nonce, amount, expiration and slot completeness", async () => {
    const input = await fixture([batch("bad", [detail(x, 3)])], {
      slots: [
        {
          token: x,
          spender,
          nonce: "0",
          currentAllowance: "5",
          expiration: "2",
        },
      ],
    });
    input.unwantedPermitIds = ["bad"];
    input.clearAllowanceSlots = [{ token: x, spender }];
    const result = await planPermitRepair(input);
    for (const observed of [
      [],
      [{ ...result.expectedSlots[0]!, nonce: "0" }],
      [{ ...result.expectedSlots[0]!, currentAllowance: "5" }],
      [{ ...result.expectedSlots[0]!, expiration: "0" }],
      [result.expectedSlots[0], result.expectedSlots[0]],
      [{ ...result.expectedSlots[0]!, extra: true }],
    ])
      expect((await checkRepairSnapshot(input, result, observed)).matches).toBe(
        false,
      );
    const checked = await checkRepairSnapshot(
      input,
      result,
      result.expectedSlots,
    );
    expect(checked.matches).toBe(true);
    expect(checked.limits.join(" ")).toContain("caller supplied");
    expect(checked.limits.join(" ")).toContain("no RPC");
  });

  it("matches an independent all-integer/permutation oracle on small adversarial inventories", async () => {
    const cases = [
      [
        batch("A", [detail(x, 2), detail(y, 2)]),
        batch("B", [detail(y, 4)]),
        batch("C", [detail(x, 3, 1)]),
      ],
      [
        batch("A", [detail(x, 0)]),
        batch("B", [detail(x, 7, 1)]),
        batch("C", [detail(y, 4)]),
      ],
      [
        batch("A", [detail(x, 1, 1), detail(y, 1, 0)]),
        batch("B", [detail(x, 1, 0), detail(y, 1, 1)]),
        batch("C", [detail(x, 1, 2)]),
      ],
      [
        batch("A", [detail(x, 4)]),
        batch("B", [detail(x, 5)]),
        batch("C", [detail(y, 0, 2)]),
      ],
    ];
    for (const [index, batches] of cases.entries()) {
      const input = await fixture(batches);
      input.unwantedPermitIds = ["B"];
      if (index === 0 || index === 3) input.wantedSequence = ["A"];
      if (index === 1) input.clearAllowanceSlots = [{ token: x, spender }];
      const expected = oracleMinimum(input);
      const result = await planPermitRepair(input);
      expect(result.totalCost).toBe(
        expected === null ? null : expected.toString(),
      );
      expect(result.status === "impossible").toBe(expected === null);
      expect(await verifyPermitRepair(input, result)).toBe(true);
    }
  });
});
