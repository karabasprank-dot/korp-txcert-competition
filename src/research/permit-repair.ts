import {
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import {
  permitExposureInputSchema,
  verifyPermitSignatures,
  type PermitExposureInput,
} from "./permit-exposure.js";

const VERSION = "korp-repair-planner-v1" as const;
const MAX48 = (1n << 48n) - 1n;
const MAX160 = (1n << 160n) - 1n;
const MAX256 = (1n << 256n) - 1n;
const JUMP = 65535n;
export const REPAIR_LIMITS = {
  maxCandidates: 10000,
  maxStates: 100000,
  maxActions: 64,
} as const;

export class RepairLimitError extends Error {
  readonly code = "REPAIR_SEARCH_LIMIT";
  constructor(message: string) {
    super(`REPAIR_SEARCH_LIMIT: ${message}`);
    this.name = "RepairLimitError";
  }
}

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as Address);
const integer = (max: bigint) =>
  z
    .string()
    .max(max.toString().length)
    .regex(/^(0|[1-9][0-9]*)$/)
    .refine(
      (value) =>
        value.length <= max.toString().length &&
        /^(0|[1-9][0-9]*)$/.test(value) &&
        BigInt(value) <= max,
      "Integer exceeds supported range",
    );
const cost = integer(MAX256).refine(
  (value) => value !== "0",
  "Action costs must be positive",
);
const pair = z.object({ token: address, spender: address }).strict();
const key = (token: string, spender: string) => `${token}:${spender}`;
const id = z.string().min(1).max(100);

export const permitRepairInputSchema = z
  .object({
    inventory: permitExposureInputSchema,
    unwantedPermitIds: z.array(id).max(12),
    wantedSequence: z.array(id).max(12),
    clearAllowanceSlots: z.array(pair).max(16).default([]),
    costs: z
      .object({ invalidateNonce: cost, clearAllowance: cost })
      .strict()
      .default({ invalidateNonce: "1", clearAllowance: "1" }),
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = new Set(input.inventory.permits.map((permit) => permit.id));
    for (const field of ["unwantedPermitIds", "wantedSequence"] as const) {
      const seen = new Set<string>();
      for (const [i, value] of input[field].entries()) {
        if (!ids.has(value))
          ctx.addIssue({
            code: "custom",
            path: [field, i],
            message: "Unknown permit id",
          });
        if (seen.has(value))
          ctx.addIssue({
            code: "custom",
            path: [field, i],
            message: "Duplicate permit id",
          });
        seen.add(value);
      }
    }
    const slots = new Set(
      input.inventory.slots.map((slot) => key(slot.token, slot.spender)),
    );
    const seen = new Set<string>();
    for (const [i, slot] of input.clearAllowanceSlots.entries()) {
      const value = key(slot.token, slot.spender);
      if (!slots.has(value))
        ctx.addIssue({
          code: "custom",
          path: ["clearAllowanceSlots", i],
          message: "Missing snapshot slot",
        });
      if (seen.has(value))
        ctx.addIssue({
          code: "custom",
          path: ["clearAllowanceSlots", i],
          message: "Duplicate clear slot",
        });
      seen.add(value);
    }
  });

export type PermitRepairInput = z.input<typeof permitRepairInputSchema>;
type NormalizedInput = z.output<typeof permitRepairInputSchema>;
type Slot = PermitExposureInput["slots"][number];
type FrontierSlot = Pick<Slot, "token" | "spender" | "nonce">;

export const permitRepairAbi = [
  {
    type: "function",
    name: "invalidateNonces",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "newNonce", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "lockdown",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "approvals",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "spender", type: "address" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

type Transaction = {
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value: "0";
};
export type RepairAction =
  | {
      kind: "invalidateNonces";
      token: Address;
      spender: Address;
      newNonce: string;
      cost: string;
      transaction: Transaction;
    }
  | {
      kind: "lockdown";
      token: Address;
      spender: Address;
      cost: string;
      transaction: Transaction;
    };

type Explanation = {
  code: string;
  message: string;
  permitIds: string[];
  slotKeys: string[];
  witness: string[];
  frontier: FrontierSlot[];
};
export interface RepairPlan {
  version: typeof VERSION;
  inputHash: Hex;
  status: "unchanged" | "repairable" | "impossible";
  actions: RepairAction[];
  totalCost: string | null;
  wantedWitness: string[];
  expectedSlots: Slot[];
  search: {
    candidateCount: number;
    stateCount: number;
    candidateSpace: number;
    limits: typeof REPAIR_LIMITS;
  };
  explanation: Explanation;
  modelLimits: string[];
}

const MODEL_LIMITS = [
  "Caller-supplied snapshot and signature inventory: completeness, current chain state, finality, and owner account code are not verified.",
  "Official unchanged Permit2 AllowanceTransfer semantics and EOA signatures only; the supplied block timestamp stays frozen.",
  "Every proposed owner action must land before any third-party action. Separate EOA transactions are not atomic and can be front-run; this planner does not protect the execution race.",
  "After repairs, unwanted permits must be unreachable under every order of supplied permits. Unknown signatures, new signatures, later time, new owner actions, and reorgs are outside the guarantee.",
  "Wanted sequence means permit acceptance in exactly the supplied order immediately after repair, without other permits interleaved. It does not prove swap/order fulfillment or liveness against competing actors.",
  "Requested clear slots must have literal stored amount zero, including expired positive allowances, initially and after every reachable supplied permit prefix.",
  "Repair actions are nonce invalidations and per-slot lockdowns only. Nonce increases can unlock permissions, so every candidate is checked for all reachable supplied grants.",
  "Costs are positive synthetic per-invalidation-call and per-cleared-slot units, not gas estimates. Canonical thresholds include current nonce, signed nonce, and signed nonce plus one, with minimal repeated jumps of at most 65535.",
  "Exact search stops with an explicit error beyond 10000 candidate plans, 100000 explored states, or 64 actions. A search-limit error is not an impossibility result.",
  "Calldata is unsigned. No RPC, signing, broadcasting, token transfer, or deployment is performed.",
] as const;

type Grant = {
  id: string;
  deadlineValid: boolean;
  entries: { slot: number; nonce: bigint; amount: bigint }[];
};
type Prepared = {
  input: NormalizedInput;
  base: bigint[];
  grants: Grant[];
  clear: Set<number>;
  unwanted: Set<string>;
  hash: Hex;
};

async function prepare(raw: unknown): Promise<Prepared> {
  const input = permitRepairInputSchema.parse(raw);
  // Reuse the exposure map's fail-closed EOA/domain signature check without
  // also running its exposure search, whose result the planner never used.
  await verifyPermitSignatures(input.inventory);
  const indices = new Map(
    input.inventory.slots.map((slot, i) => [key(slot.token, slot.spender), i]),
  );
  const now = BigInt(input.inventory.asOfTimestamp);
  return {
    input,
    base: input.inventory.slots.map((slot) => BigInt(slot.nonce)),
    grants: input.inventory.permits.map((permit) => ({
      id: permit.id,
      deadlineValid: now <= BigInt(permit.sigDeadline),
      entries: permit.details.map((entry) => ({
        slot: indices.get(key(entry.token, permit.spender))!,
        nonce: BigInt(entry.nonce),
        amount: BigInt(entry.amount),
      })),
    })),
    clear: new Set(
      input.clearAllowanceSlots.map((slot) =>
        indices.get(key(slot.token, slot.spender))!,
      ),
    ),
    unwanted: new Set(input.unwantedPermitIds),
    hash: keccak256(toHex(JSON.stringify(input))),
  };
}

function frontierSlots(p: Prepared, frontier: bigint[]): FrontierSlot[] {
  return p.input.inventory.slots.map((slot, i) => ({
    token: slot.token,
    spender: slot.spender,
    nonce: frontier[i]!.toString(),
  }));
}
function explanation(
  p: Prepared,
  code: string,
  message: string,
  permitIds: string[] = [],
  slots: number[] = [],
  witness: string[] = [],
  frontier = p.base,
): Explanation {
  return {
    code,
    message,
    permitIds,
    slotKeys: slots.map((i) => {
      const slot = p.input.inventory.slots[i]!;
      return key(slot.token, slot.spender);
    }),
    witness,
    frontier: frontierSlots(p, frontier),
  };
}
function enabled(grant: Grant, frontier: bigint[]) {
  return (
    grant.deadlineValid &&
    grant.entries.every((entry) => frontier[entry.slot] === entry.nonce)
  );
}
function nextFrontier(grant: Grant, frontier: bigint[]) {
  const next = [...frontier];
  for (const entry of grant.entries) next[entry.slot] = entry.nonce + 1n;
  return next;
}

/** Wanted replay forces each slot's initial nonce to the nonce of its first
 * wanted use; all later uses must form its contiguous incrementing sequence. */
function wantedRequirements(p: Prepared): {
  required: Map<number, bigint>;
  failure?: Explanation;
} {
  const required = new Map<number, bigint>();
  const next = new Map<number, bigint>();
  const prefix: string[] = [];
  for (const id of p.input.wantedSequence) {
    const grant = p.grants.find((entry) => entry.id === id)!;
    prefix.push(id);
    if (p.unwanted.has(id))
      return {
        required,
        failure: explanation(
          p,
          "WANTED_UNWANTED_CONFLICT",
          `Permit ${id} is both required to execute and required to be unreachable.`,
          [id],
          grant.entries.map((entry) => entry.slot),
          prefix,
        ),
      };
    if (!grant.deadlineValid)
      return {
        required,
        failure: explanation(
          p,
          "WANTED_SIGNATURE_EXPIRED",
          `Wanted permit ${id} has an expired signature deadline at the supplied timestamp. Owner repair actions cannot change that deadline.`,
          [id],
          [],
          prefix,
        ),
      };
    for (const entry of grant.entries) {
      if (p.clear.has(entry.slot) && entry.amount > 0n)
        return {
          required,
          failure: explanation(
            p,
            "WANTED_CLEAR_CONFLICT",
            `Wanted permit ${id} writes a positive stored amount into a slot required to stay zero.`,
            [id],
            [entry.slot],
            prefix,
          ),
        };
      const expected = next.get(entry.slot);
      if (expected !== undefined && expected !== entry.nonce)
        return {
          required,
          failure: explanation(
            p,
            "WANTED_ORDER_CONFLICT",
            `Wanted permit ${id} requires nonce ${entry.nonce}, but preceding wanted permits leave nonce ${expected} in this slot.`,
            [id],
            [entry.slot],
            prefix,
          ),
        };
      if (expected === undefined) {
        if (entry.nonce < p.base[entry.slot]!)
          return {
            required,
            failure: explanation(
              p,
              "WANTED_NONCE_ALREADY_PASSED",
              `Wanted permit ${id} needs nonce ${entry.nonce}, below the observed nonce ${p.base[entry.slot]}; supported owner actions cannot lower it.`,
              [id],
              [entry.slot],
              prefix,
            ),
          };
        required.set(entry.slot, entry.nonce);
      }
      next.set(entry.slot, entry.nonce + 1n);
    }
  }
  return { required };
}

function inspect(
  p: Prepared,
  start: bigint[],
  work: { states: number },
): Explanation | undefined {
  const visited = new Set<string>();
  const visit = (
    frontier: bigint[],
    mask: number,
    path: string[],
  ): Explanation | undefined => {
    const state = `${mask}|${frontier.join(",")}`;
    if (visited.has(state)) return;
    visited.add(state);
    if (++work.states > REPAIR_LIMITS.maxStates)
      throw new RepairLimitError(
        `State exploration exceeds ${REPAIR_LIMITS.maxStates}; no impossibility conclusion was produced.`,
      );
    for (const [i, grant] of p.grants.entries()) {
      if ((mask & (1 << i)) !== 0 || !enabled(grant, frontier)) continue;
      const witness = [...path, grant.id];
      if (p.unwanted.has(grant.id))
        return explanation(
          p,
          "UNWANTED_REACHABLE",
          `Unwanted permit ${grant.id} can execute after the supplied permit prefix ${witness.join(" → ")}.`,
          [grant.id],
          grant.entries.map((entry) => entry.slot),
          witness,
          start,
        );
      const writes = grant.entries.filter(
        (entry) => p.clear.has(entry.slot) && entry.amount > 0n,
      );
      if (writes.length)
        return explanation(
          p,
          "CLEAR_SLOT_REGRANT",
          `Permit ${grant.id} can restore a positive stored allowance in a slot required to remain zero, after prefix ${witness.join(" → ")}.`,
          [grant.id],
          writes.map((entry) => entry.slot),
          witness,
          start,
        );
      const failure = visit(
        nextFrontier(grant, frontier),
        mask | (1 << i),
        witness,
      );
      if (failure) return failure;
    }
  };
  return visit(start, 0, []);
}

function lockSlots(p: Prepared) {
  return [...p.clear]
    .filter((i) => BigInt(p.input.inventory.slots[i]!.currentAllowance) > 0n)
    .sort((a, b) => a - b);
}

function actionsFor(
  p: Prepared,
  frontier: bigint[],
  locks: number[],
): RepairAction[] {
  const actions: RepairAction[] = [];
  const transaction = (data: Hex): Transaction => ({
    chainId: p.input.inventory.domain.chainId,
    from: p.input.inventory.owner,
    to: p.input.inventory.domain.verifyingContract,
    data,
    value: "0",
  });
  for (const [i, target] of frontier.entries()) {
    const slot = p.input.inventory.slots[i]!;
    let current = p.base[i]!;
    while (current < target) {
      current = current + JUMP < target ? current + JUMP : target;
      if (actions.length >= REPAIR_LIMITS.maxActions)
        throw new RepairLimitError(
          "The selected repair needs more than 64 owner actions.",
        );
      actions.push({
        kind: "invalidateNonces",
        token: slot.token,
        spender: slot.spender,
        newNonce: current.toString(),
        cost: p.input.costs.invalidateNonce,
        transaction: transaction(
          encodeFunctionData({
            abi: permitRepairAbi,
            functionName: "invalidateNonces",
            args: [slot.token, slot.spender, Number(current)],
          }),
        ),
      });
    }
  }
  for (const i of locks) {
    const slot = p.input.inventory.slots[i]!;
    if (actions.length >= REPAIR_LIMITS.maxActions)
      throw new RepairLimitError(
        "The selected repair needs more than 64 owner actions.",
      );
    actions.push({
      kind: "lockdown",
      token: slot.token,
      spender: slot.spender,
      cost: p.input.costs.clearAllowance,
      transaction: transaction(
        encodeFunctionData({
          abi: permitRepairAbi,
          functionName: "lockdown",
          args: [[{ token: slot.token, spender: slot.spender }]],
        }),
      ),
    });
  }
  return actions;
}

function expectedSlots(
  p: Prepared,
  frontier: bigint[],
  locks: number[],
): Slot[] {
  const cleared = new Set(locks);
  return p.input.inventory.slots.map((slot, i) => ({
    ...slot,
    nonce: frontier[i]!.toString(),
    currentAllowance: cleared.has(i) ? "0" : slot.currentAllowance,
  }));
}

function solve(p: Prepared): RepairPlan {
  const requirements = wantedRequirements(p);
  const search: RepairPlan["search"] = {
    candidateCount: 0,
    stateCount: 0,
    candidateSpace: 0,
    limits: { ...REPAIR_LIMITS },
  };
  const result = (
    status: RepairPlan["status"],
    failure: Explanation,
    frontier = p.base,
    locks: number[] = [],
    actions: RepairAction[] = [],
  ): RepairPlan => ({
    version: VERSION,
    inputHash: p.hash,
    status,
    actions,
    totalCost:
      status === "impossible"
        ? null
        : actions
            .reduce((sum, action) => sum + BigInt(action.cost), 0n)
            .toString(),
    wantedWitness: status === "impossible" ? [] : [...p.input.wantedSequence],
    expectedSlots: expectedSlots(p, frontier, locks),
    search,
    explanation: failure,
    modelLimits: [...MODEL_LIMITS],
  });
  if (requirements.failure) return result("impossible", requirements.failure);

  const locks = lockSlots(p);
  const work = { states: 0 };
  // The cost-zero case is globally optimal regardless of the candidate space.
  const wantedAlready = [...requirements.required].every(
    ([slot, nonce]) => p.base[slot] === nonce,
  );
  let firstFailure: Explanation | undefined;
  if (wantedAlready && locks.length === 0) {
    search.candidateCount++;
    firstFailure = inspect(p, p.base, work);
    search.stateCount = work.states;
    if (!firstFailure) {
      search.candidateSpace = 1;
      return result(
        "unchanged",
        explanation(
          p,
          "ALREADY_SATISFIES",
          "No owner action is needed: all supplied constraints already hold.",
        ),
      );
    }
  }

  const options = p.base.map((current, slot) => {
    const required = requirements.required.get(slot);
    if (required !== undefined) return [required];
    const values = new Set<string>([current.toString()]);
    for (const grant of p.grants)
      for (const entry of grant.entries)
        if (entry.slot === slot)
          for (const candidate of [entry.nonce, entry.nonce + 1n])
            if (candidate >= current && candidate <= MAX48)
              values.add(candidate.toString());
    return [...values].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  });
  let space = 1n;
  for (const choices of options) space *= BigInt(choices.length);
  if (space > BigInt(REPAIR_LIMITS.maxCandidates))
    throw new RepairLimitError(
      `Canonical candidate space is ${space}, above ${REPAIR_LIMITS.maxCandidates}; no impossibility conclusion was produced.`,
    );
  search.candidateSpace = Number(space);

  const candidates: { frontier: bigint[]; calls: bigint }[] = [];
  const enumerate = (i: number, frontier: bigint[], calls: bigint) => {
    if (i === options.length) {
      candidates.push({ frontier, calls });
      return;
    }
    for (const target of options[i]!)
      enumerate(
        i + 1,
        [...frontier, target],
        calls + (target - p.base[i]! + JUMP - 1n) / JUMP,
      );
  };
  enumerate(0, [], 0n);
  // Lockdowns are forced and identical across candidates, and the positive
  // invalidation cost is common to all slots. Call-count order is cost order.
  candidates.sort((a, b) =>
    a.calls < b.calls ? -1 : a.calls > b.calls ? 1 : 0,
  );
  let outsideActionBound = false;
  for (const candidate of candidates) {
    if (
      candidate.calls + BigInt(locks.length) >
      BigInt(REPAIR_LIMITS.maxActions)
    ) {
      outsideActionBound = true;
      continue;
    }
    if (
      wantedAlready &&
      locks.length === 0 &&
      candidate.calls === 0n &&
      firstFailure
    )
      continue;
    if (++search.candidateCount > REPAIR_LIMITS.maxCandidates)
      throw new RepairLimitError(
        "Candidate evaluation limit reached; no impossibility conclusion was produced.",
      );
    const failure = inspect(p, candidate.frontier, work);
    search.stateCount = work.states;
    if (failure) {
      firstFailure ??= failure;
      continue;
    }
    const actions = actionsFor(p, candidate.frontier, locks);
    return result(
      actions.length === 0 ? "unchanged" : "repairable",
      explanation(
        p,
        "MINIMUM_COST_REPAIR",
        "This is a minimum synthetic-cost repair within the supported owner actions. The wanted permit sequence accepts, every unwanted supplied permit is unreachable, and requested slots remain stored zero.",
        [],
        [],
        p.input.wantedSequence,
        candidate.frontier,
      ),
      candidate.frontier,
      locks,
      actions,
    );
  }
  if (outsideActionBound)
    throw new RepairLimitError(
      "No repair was found within 64 owner actions; additional canonical candidates require more actions. This is not an impossibility result.",
    );
  const failure =
    firstFailure ??
    explanation(
      p,
      "NO_SUPPORTED_REPAIR",
      "No candidate satisfies the supplied constraints.",
    );
  return result("impossible", {
    ...failure,
    code: `IMPOSSIBLE_${failure.code}`,
    message: `Impossible within the supported repair actions: all ${search.candidateSpace} canonical frontiers compatible with the exact wanted sequence fail. Example: ${failure.message}`,
  });
}

export async function planPermitRepair(input: unknown): Promise<RepairPlan> {
  return solve(await prepare(input));
}

const slotSchema = z
  .object({
    token: address,
    spender: address,
    nonce: integer(MAX48),
    currentAllowance: integer(MAX160 - 1n),
    expiration: integer(MAX48),
  })
  .strict();
const resultInteger = z
  .string()
  .max(160)
  .regex(/^(0|[1-9][0-9]*)$/);
const transactionSchema = z
  .object({
    chainId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    from: address,
    to: address,
    data: z
      .string()
      .max(2000)
      .regex(/^0x[0-9a-fA-F]*$/),
    value: z.literal("0"),
  })
  .strict();
const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("invalidateNonces"),
      token: address,
      spender: address,
      newNonce: integer(MAX48),
      cost,
      transaction: transactionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("lockdown"),
      token: address,
      spender: address,
      cost,
      transaction: transactionSchema,
    })
    .strict(),
]);
const planSchema = z
  .object({
    version: z.literal(VERSION),
    inputHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    status: z.enum(["unchanged", "repairable", "impossible"]),
    actions: z.array(actionSchema).max(REPAIR_LIMITS.maxActions),
    totalCost: resultInteger.nullable(),
    wantedWitness: z.array(id).max(12),
    expectedSlots: z.array(slotSchema).max(16),
    search: z
      .object({
        candidateCount: z
          .number()
          .int()
          .min(0)
          .max(REPAIR_LIMITS.maxCandidates),
        stateCount: z.number().int().min(0).max(REPAIR_LIMITS.maxStates),
        candidateSpace: z
          .number()
          .int()
          .min(0)
          .max(REPAIR_LIMITS.maxCandidates),
        limits: z
          .object({
            maxCandidates: z.literal(REPAIR_LIMITS.maxCandidates),
            maxStates: z.literal(REPAIR_LIMITS.maxStates),
            maxActions: z.literal(REPAIR_LIMITS.maxActions),
          })
          .strict(),
      })
      .strict(),
    explanation: z
      .object({
        code: z.string().max(100),
        message: z.string().max(5000),
        permitIds: z.array(id).max(12),
        slotKeys: z.array(z.string().max(100)).max(16),
        witness: z.array(id).max(12),
        frontier: z
          .array(
            z
              .object({
                token: address,
                spender: address,
                nonce: integer(MAX48),
              })
              .strict(),
          )
          .max(16),
      })
      .strict(),
    modelLimits: z.array(z.string().max(1000)).max(16),
  })
  .strict();

/** Recompute the canonical optimum and separately replay every returned owner
 * action and wanted grant. Invalid inventory throws; altered results return false. */
export async function verifyPermitRepair(
  input: unknown,
  plan: unknown,
): Promise<boolean> {
  const p = await prepare(input);
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) return false;
  const expected = solve(p);
  if (JSON.stringify(expected) !== JSON.stringify(parsed.data)) return false;
  if (expected.status === "impossible") return true;
  const replay = p.input.inventory.slots.map((slot) => ({ ...slot }));
  for (const action of expected.actions) {
    const slot = replay.find(
      (entry) =>
        entry.token === action.token && entry.spender === action.spender,
    );
    if (!slot) return false;
    if (action.kind === "lockdown") slot.currentAllowance = "0";
    else {
      const delta = BigInt(action.newNonce) - BigInt(slot.nonce);
      if (delta <= 0n || delta > JUMP) return false;
      slot.nonce = action.newNonce;
    }
  }
  if (JSON.stringify(replay) !== JSON.stringify(expected.expectedSlots))
    return false;
  for (const i of p.clear)
    if (replay[i]!.currentAllowance !== "0") return false;
  const frontier = replay.map((slot) => BigInt(slot.nonce));
  for (const id of expected.wantedWitness) {
    const grant = p.grants.find((entry) => entry.id === id)!;
    if (!enabled(grant, frontier)) return false;
    for (const entry of grant.entries) frontier[entry.slot] = entry.nonce + 1n;
  }
  return true;
}

/** Compare a caller-supplied after-action snapshot with exact expected storage.
 * This checks values only; it does not establish transaction inclusion/finality. */
export async function checkRepairSnapshot(
  input: unknown,
  plan: unknown,
  observedSlots: unknown,
): Promise<{ matches: boolean; mismatches: string[]; limits: string[] }> {
  const limits = [
    "Observed slots are caller supplied; no RPC, block proof, transaction inclusion, or finality verification is performed.",
    "The snapshot must be immediately after all repair actions and before wanted permits or third-party actions; every supplied slot's nonce, amount, and expiration must match exactly.",
  ];
  if (!(await verifyPermitRepair(input, plan)))
    return {
      matches: false,
      mismatches: ["Repair result verification failed."],
      limits,
    };
  const verified = planSchema.parse(plan);
  if (verified.status === "impossible")
    return {
      matches: false,
      mismatches: ["An impossible result has no executable repair to observe."],
      limits,
    };
  const parsed = z.array(slotSchema).max(16).safeParse(observedSlots);
  if (!parsed.success)
    return {
      matches: false,
      mismatches: [
        "Observed snapshot is malformed or contains unsupported fields.",
      ],
      limits,
    };
  const observed = new Map<string, z.infer<typeof slotSchema>>();
  const mismatches: string[] = [];
  for (const slot of parsed.data) {
    const value = key(slot.token, slot.spender);
    if (observed.has(value))
      mismatches.push(`Duplicate observed slot ${value}.`);
    observed.set(value, slot);
  }
  for (const expected of verified.expectedSlots) {
    const value = key(expected.token, expected.spender);
    const actual = observed.get(value);
    if (!actual) {
      mismatches.push(`Missing observed slot ${value}.`);
      continue;
    }
    for (const field of ["nonce", "currentAllowance", "expiration"] as const)
      if (actual[field] !== expected[field])
        mismatches.push(
          `${value} ${field}: expected ${expected[field]}, observed ${actual[field]}.`,
        );
    observed.delete(value);
  }
  for (const value of observed.keys())
    mismatches.push(`Unexpected observed slot ${value}.`);
  return { matches: mismatches.length === 0, mismatches, limits };
}
