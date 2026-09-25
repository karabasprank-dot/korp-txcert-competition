import { keccak256, toHex, verifyTypedData, type Address } from "viem";
import { z } from "zod";

const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const VERSION = "korp-exposure-map-v1" as const;
const UNIT = "synthetic-budget-units" as const;

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((address) => address.toLowerCase() as Address);

// Canonical decimal strings avoid rounding, exponent notation, and JSON bigint issues.
const uint = (max: bigint) =>
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

const amountSchema = uint(MAX_UINT160 - 1n);
// Incrementing uint48.max wraps in Permit2; that behavior is outside this model.
const nonceSchema = uint(MAX_UINT48 - 1n);
const expirationSchema = uint(MAX_UINT48);
const detailSchema = z
  .object({
    token: addressSchema,
    amount: amountSchema,
    expiration: expirationSchema,
    nonce: nonceSchema,
  })
  .strict();

const permitSchema = z
  .object({
    id: z.string().min(1).max(100),
    spender: addressSchema,
    sigDeadline: uint(MAX_UINT256),
    details: z.array(detailSchema).min(1).max(16),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .refine(
        (signature) => ["1b", "1c"].includes(signature.slice(-2).toLowerCase()),
        "Permit2 65-byte signatures require v = 27 or 28",
      ),
  })
  .strict();

const slotKey = (token: string, spender: string) => `${token}:${spender}`;

export const permitExposureInputSchema = z
  .object({
    domain: z
      .object({
        chainId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        verifyingContract: addressSchema,
      })
      .strict(),
    owner: addressSchema,
    asOfTimestamp: z.number().int().min(0).max(Number(MAX_UINT48)),
    assets: z
      .array(
        z
          .object({
            token: addressSchema,
            weight: uint(MAX_UINT256).refine(
              (weight) => weight !== "0",
              "Synthetic budget weight must be positive",
            ),
          })
          .strict(),
      )
      .max(16),
    slots: z
      .array(
        z
          .object({
            token: addressSchema,
            spender: addressSchema,
            nonce: nonceSchema,
            currentAllowance: amountSchema,
            expiration: expirationSchema,
          })
          .strict(),
      )
      .max(16),
    permits: z.array(permitSchema).max(12),
  })
  .strict()
  .superRefine((input, ctx) => {
    const assets = new Set<string>();
    for (const [i, asset] of input.assets.entries()) {
      if (assets.has(asset.token))
        ctx.addIssue({
          code: "custom",
          path: ["assets", i, "token"],
          message: "Duplicate asset",
        });
      assets.add(asset.token);
    }
    const slots = new Set<string>();
    for (const [i, slot] of input.slots.entries()) {
      const key = slotKey(slot.token, slot.spender);
      if (slots.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["slots", i],
          message: "Duplicate snapshot slot",
        });
      slots.add(key);
      if (!assets.has(slot.token))
        ctx.addIssue({
          code: "custom",
          path: ["slots", i, "token"],
          message: "Missing synthetic asset weight",
        });
    }
    const ids = new Set<string>();
    for (const [i, permit] of input.permits.entries()) {
      if (ids.has(permit.id))
        ctx.addIssue({
          code: "custom",
          path: ["permits", i, "id"],
          message: "Duplicate permit id",
        });
      ids.add(permit.id);
      const tokens = new Set<string>();
      for (const [j, detail] of permit.details.entries()) {
        if (tokens.has(detail.token))
          ctx.addIssue({
            code: "custom",
            path: ["permits", i, "details", j, "token"],
            message: "Duplicate token in batch is unsupported",
          });
        tokens.add(detail.token);
        if (!slots.has(slotKey(detail.token, permit.spender)))
          ctx.addIssue({
            code: "custom",
            path: ["permits", i, "details", j],
            message: "Missing snapshot slot for token and spender",
          });
      }
    }
  });

export type PermitExposureInput = z.infer<typeof permitExposureInputSchema>;
export type ExposurePermit = PermitExposureInput["permits"][number];

// These are Uniswap Permit2 AllowanceTransfer types, not SignatureTransfer types.
export const permitBatchTypes = {
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
  PermitBatch: [
    { name: "details", type: "PermitDetails[]" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
} as const;

export function permitBatchTypedData(
  domain: PermitExposureInput["domain"],
  permit: Omit<ExposurePermit, "signature">,
) {
  return {
    domain: { name: "Permit2", ...domain },
    types: permitBatchTypes,
    primaryType: "PermitBatch" as const,
    message: {
      details: permit.details.map((detail) => ({
        token: detail.token,
        amount: BigInt(detail.amount),
        expiration: Number(detail.expiration),
        nonce: Number(detail.nonce),
      })),
      spender: permit.spender,
      sigDeadline: BigInt(permit.sigDeadline),
    },
  };
}

const MODEL_LIMITS = [
  "Caller-supplied snapshot and inventory; completeness, chain provenance, finality, and owner account code are not verified.",
  "EOA ECDSA signatures only; no ERC-1271, ERC-6492, or contract-wallet validation.",
  "One fixed chain and Permit2 AllowanceTransfer deployment with official, unchanged contract semantics.",
  "Frozen block timestamp: this is not exposure over future time, reorgs, new signatures, owner nonce invalidations, or policy changes.",
  "Colluding spenders may drain every finite active allowance immediately; future token top-ups and adequate root ERC-20 approval are assumed available.",
  "Ordinary ERC-20 transfer behavior is assumed; rebasing, transfer fees, callbacks, paused tokens, and token-specific restrictions are not modeled.",
  "Initial allowances are drained before permits; every reachable fresh allowance is drained before any later grant.",
  "Weights are explicit synthetic budget units per atomic token unit, not token prices or exchange-rate predictions; gas is excluded.",
  "At most 12 signed batches, 16 snapshot slots and 16 assets; duplicate batch tokens, unlimited allowances, and nonce wrap are unsupported.",
] as const;

export interface ExposureCertificate {
  version: typeof VERSION;
  inputHash: `0x${string}`;
  unit: typeof UNIT;
  maxAdditional: string;
  baselineAllowance: string;
  maxTotal: string;
  witness: string[];
  reachableStateCount: number;
  naive: {
    sumOfSignedGrants: string;
    sumOfSignedGrantsPlusBaseline: string;
    perSlotNonceMax: string;
    perSlotNonceMaxPlusBaseline: string;
  };
  modelLimits: string[];
}

type CompiledPermit = {
  id: string;
  validSignatureTime: boolean;
  updates: { slot: number; nonce: bigint }[];
  draw: bigint;
};

async function prepare(rawInput: unknown) {
  // Zod creates a detached, normalized copy before any signature-verification await.
  const input = permitExposureInputSchema.parse(rawInput);
  for (const permit of input.permits) {
    let verified: boolean;
    try {
      verified = await verifyTypedData({
        address: input.owner,
        ...permitBatchTypedData(input.domain, permit),
        signature: permit.signature as `0x${string}`,
      });
    } catch {
      throw new Error(`EXPOSURE_INVALID_SIGNATURE: ${permit.id}`);
    }
    if (!verified) throw new Error(`EXPOSURE_INVALID_SIGNATURE: ${permit.id}`);
  }

  const now = BigInt(input.asOfTimestamp);
  const weights = new Map(
    input.assets.map((asset) => [asset.token, BigInt(asset.weight)]),
  );
  const slotIndices = new Map(
    input.slots.map((slot, i) => [slotKey(slot.token, slot.spender), i]),
  );
  const initial = input.slots.map((slot) => BigInt(slot.nonce));
  let baseline = 0n;
  for (const slot of input.slots) {
    // Snapshot expiration is actual stored state: zero is NOT reset to now here.
    if (now <= BigInt(slot.expiration))
      baseline += BigInt(slot.currentAllowance) * weights.get(slot.token)!;
  }
  let naiveSum = 0n;
  const perSlotNonce = new Map<string, bigint>();
  const permits: CompiledPermit[] = input.permits.map((permit) => {
    const validSignatureTime = now <= BigInt(permit.sigDeadline);
    let draw = 0n;
    const updates = permit.details.map((detail) => {
      const slot = slotIndices.get(slotKey(detail.token, permit.spender))!;
      const expiration = BigInt(detail.expiration);
      // Permit2 converts a zero grant expiration into the current timestamp.
      const amount =
        validSignatureTime && (expiration === 0n || now <= expiration)
          ? BigInt(detail.amount) * weights.get(detail.token)!
          : 0n;
      draw += amount;
      // A past nonce cannot execute again; unreachable future nonces remain in
      // these conservative comparisons even if no known predecessor reaches them.
      if (BigInt(detail.nonce) >= initial[slot]!) {
        const key = `${slot}:${detail.nonce}`;
        perSlotNonce.set(
          key,
          amount > (perSlotNonce.get(key) ?? 0n)
            ? amount
            : (perSlotNonce.get(key) ?? 0n),
        );
      }
      return { slot, nonce: BigInt(detail.nonce) };
    });
    naiveSum += draw;
    return { id: permit.id, validSignatureTime, updates, draw };
  });
  return { input, initial, baseline, naiveSum, perSlotNonce, permits };
}

function executable(permit: CompiledPermit, frontier: bigint[]) {
  return (
    permit.validSignatureTime &&
    permit.updates.every(({ slot, nonce }) => frontier[slot] === nonce)
  );
}

function advance(permit: CompiledPermit, frontier: bigint[]) {
  const next = [...frontier];
  for (const { slot, nonce } of permit.updates) next[slot] = nonce + 1n;
  return next;
}

function solve(
  prepared: Awaited<ReturnType<typeof prepare>>,
): ExposureCertificate {
  const { input, initial, permits, baseline, naiveSum, perSlotNonce } =
    prepared;
  const memo = new Map<string, { amount: bigint; witness: string[] }>();
  const dfs = (
    mask: number,
    frontier: bigint[],
  ): { amount: bigint; witness: string[] } => {
    const key = `${mask}|${frontier.join(",")}`;
    const cached = memo.get(key);
    if (cached) return cached;
    let best = { amount: 0n, witness: [] as string[] };
    for (const [i, permit] of permits.entries()) {
      if ((mask & (1 << i)) !== 0 || !executable(permit, frontier)) continue;
      const suffix = dfs(mask | (1 << i), advance(permit, frontier));
      const amount = permit.draw + suffix.amount;
      if (amount > best.amount)
        best = { amount, witness: [permit.id, ...suffix.witness] };
    }
    memo.set(key, best);
    return best;
  };
  const best = dfs(0, initial);
  const quotient = [...perSlotNonce.values()].reduce(
    (sum, amount) => sum + amount,
    0n,
  );
  return {
    version: VERSION,
    inputHash: keccak256(toHex(JSON.stringify(input))),
    unit: UNIT,
    maxAdditional: best.amount.toString(),
    baselineAllowance: baseline.toString(),
    maxTotal: (baseline + best.amount).toString(),
    witness: best.witness,
    reachableStateCount: memo.size,
    naive: {
      sumOfSignedGrants: naiveSum.toString(),
      sumOfSignedGrantsPlusBaseline: (baseline + naiveSum).toString(),
      perSlotNonceMax: quotient.toString(),
      perSlotNonceMaxPlusBaseline: (baseline + quotient).toString(),
    },
    modelLimits: [...MODEL_LIMITS],
  };
}

/** Exact maximum inside the deliberately bounded, frozen-timestamp model. */
export async function analyzePermitExposure(
  input: unknown,
): Promise<ExposureCertificate> {
  return solve(await prepare(input));
}

const certificateInteger = z
  .string()
  .max(200)
  .regex(/^(0|[1-9][0-9]*)$/);
const certificateSchema = z
  .object({
    version: z.literal(VERSION),
    inputHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    unit: z.literal(UNIT),
    maxAdditional: certificateInteger,
    baselineAllowance: certificateInteger,
    maxTotal: certificateInteger,
    witness: z.array(z.string().min(1).max(100)).max(12),
    reachableStateCount: z.number().int().min(1).max(4096),
    naive: z
      .object({
        sumOfSignedGrants: certificateInteger,
        sumOfSignedGrantsPlusBaseline: certificateInteger,
        perSlotNonceMax: certificateInteger,
        perSlotNonceMaxPlusBaseline: certificateInteger,
      })
      .strict(),
    modelLimits: z.array(z.string()).max(16),
  })
  .strict();

/**
 * Revalidates the inventory, recomputes the maximum, and independently replays
 * the claimed maximizing order. This is a reproducibility check, not a proof of
 * chain state or a cryptographic succinct proof. Invalid input always throws.
 */
export async function verifyExposureCertificate(
  input: unknown,
  certificate: unknown,
): Promise<boolean> {
  const prepared = await prepare(input);
  const parsed = certificateSchema.safeParse(certificate);
  if (!parsed.success) return false;
  const claimed = parsed.data;
  const expected = solve(prepared);
  // Substituting the claimed order permits any valid maximizing witness, while
  // still comparing every numeric result, input binding, and model limitation.
  if (
    JSON.stringify({ ...expected, witness: claimed.witness }) !==
    JSON.stringify(claimed)
  )
    return false;

  const frontier = [...prepared.initial];
  const used = new Set<string>();
  let additional = 0n;
  for (const id of claimed.witness) {
    const permit = prepared.permits.find((candidate) => candidate.id === id);
    if (!permit || used.has(id) || !executable(permit, frontier)) return false;
    used.add(id);
    // Replay uses its own in-place frontier update, separate from DFS advance.
    for (const { slot, nonce } of permit.updates) frontier[slot] = nonce + 1n;
    additional += permit.draw;
  }
  return additional.toString() === claimed.maxAdditional;
}
