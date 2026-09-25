import { z } from "zod";
import { isAddress, maxUint256 } from "viem";

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine(
    (v): boolean => isAddress(v, { strict: true }),
    "Invalid address checksum",
  );
export const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(
    (v) =>
      v.length <= 78 && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= maxUint256,
    "Exceeds uint256",
  );
export const hex = z
  .string()
  .max(8194)
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/);
export const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const addresses = z
  .array(address)
  .max(100)
  .refine(
    (a) => new Set(a.map((v) => v.toLowerCase())).size === a.length,
    "Duplicate address",
  );
export const policySchema = z.strictObject({
  expectedAction: z.enum([
    "native-transfer",
    "transfer",
    "transferFrom",
    "approve",
    "swap",
    "unknown",
  ]),
  allowedRecipients: addresses,
  allowedSpenders: addresses,
  maxNativeValueWei: uint,
  maxTokenSpend: z
    .array(z.strictObject({ token: address, amount: uint }))
    .max(100)
    .refine(
      (a) => new Set(a.map((v) => v.token.toLowerCase())).size === a.length,
      "Duplicate token",
    ),
  allowUnlimitedApproval: z.boolean(),
  allowUnknownCalls: z.boolean(),
});
export const requestSchema = z.strictObject({
  chainId: z.union([z.literal(84532), z.literal(8453)]),
  from: address,
  transaction: z.strictObject({
    to: address,
    data: hex,
    value: uint,
    nonce: uint.optional(),
  }),
  policy: policySchema,
});
export const certificateSchema = z.strictObject({
  version: z.literal(1),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  chainId: z.union([z.literal(84532), z.literal(8453)]),
  transactionHash: hash,
  policyHash: hash,
  decision: z.literal("PASS"),
  attestor: address,
  service: z.string().url().max(2048),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export const verifySchema = z.strictObject({
  certificate: certificateSchema,
  request: requestSchema,
});
export const checkSchema = z.strictObject({
  id: z.string(),
  status: z.enum(["PASS", "WARN", "BLOCK"]),
});
export const responseSchema = z.strictObject({
  version: z.literal("1"),
  decision: z.enum(["PASS", "WARN", "BLOCK"]),
  chainId: z.number().int(),
  transactionHash: hash,
  policyHash: hash,
  decoded: z.record(z.string(), z.string()),
  checks: z.array(checkSchema),
  certificate: certificateSchema.nullable(),
});
export type CheckRequest = z.infer<typeof requestSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Certificate = z.infer<typeof certificateSchema>;
