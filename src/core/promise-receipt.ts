import { z } from "zod";
import {
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { address, hash, uint } from "../schemas/index.js";

// Research protocol v0: Base Sepolia, four scalar fields, one equality promise.
// No network calls, custody, settlement verification, refunds or live-key access.
export const PROMISE_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const scalar = z.union([
  z.string().max(1024),
  z.number().int().safe(),
  z.boolean(),
  z.null(),
]);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
/** Generate every owner, request and field salt independently; keep undisclosed
 * salts secret. Distinctness alone cannot establish cryptographic entropy. */
export function newPromiseSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
const field = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  .refine((s) => !["constructor", "prototype", "__proto__"].includes(s));
const termsSchema = z
  .strictObject({
    version: z.literal(1),
    chainId: z.literal(84532),
    asset: z.literal(PROMISE_TOKEN),
    payer: address,
    payTo: address,
    merchantSigner: address,
    amount: uint.refine((v) => BigInt(v) > 0n),
    validAfter: uint,
    validBefore: uint,
    requestCommitment: hash,
    fields: z
      .array(field)
      .length(4)
      .refine((v) => new Set(v).size === 4),
    rule: z.strictObject({
      fieldIndex: z.number().int().min(0).max(3),
      equals: scalar,
    }),
  })
  .refine(
    (t) =>
      BigInt(t.validBefore) > BigInt(t.validAfter) &&
      t.payer.toLowerCase() !== t.payTo.toLowerCase() &&
      t.payer.toLowerCase() !== t.merchantSigner.toLowerCase(),
  );
export type PromiseTerms = z.infer<typeof termsSchema>;
const disclosureSchema = z
  .strictObject({
    index: z.number().int().min(0).max(3),
    present: z.boolean(),
    value: scalar,
    salt: hash,
    siblings: z.array(hash).length(2),
  })
  .refine((w) => w.present || w.value === null);
export type Disclosure = z.infer<typeof disclosureSchema>;
const proofSchema = z.strictObject({
  terms: termsSchema,
  merchantSignature: signature,
  nonceSalt: hash,
  authorizationSignature: signature,
  responseRoot: hash,
  deliverySignature: signature,
  disclosure: disclosureSchema,
});
export type PromiseBreachProof = z.infer<typeof proofSchema>;
const termsTypes = {
  Acceptance: [{ name: "termsHash", type: "bytes32" }],
} as const;
const deliveryTypes = {
  Delivery: [
    { name: "termsHash", type: "bytes32" },
    { name: "paymentNonce", type: "bytes32" },
    { name: "responseRoot", type: "bytes32" },
  ],
} as const;
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const domain = {
  name: "Korp Promise Receipt",
  version: "0.1",
  chainId: 84532,
  verifyingContract: PROMISE_TOKEN,
} as const;
function normalized(input: PromiseTerms) {
  const t = termsSchema.parse(input);
  return {
    ...t,
    payer: t.payer.toLowerCase(),
    payTo: t.payTo.toLowerCase(),
    merchantSigner: t.merchantSigner.toLowerCase(),
    requestCommitment: t.requestCommitment.toLowerCase(),
  };
}
export function promiseTermsHash(input: PromiseTerms): Hex {
  return keccak256(toHex(JSON.stringify(normalized(input))));
}
export function acceptanceTypedData(terms: PromiseTerms) {
  return {
    domain,
    types: termsTypes,
    primaryType: "Acceptance" as const,
    message: { termsHash: promiseTermsHash(terms) },
  };
}
/** A fresh owner-generated random salt is required; never use a sequential ID.
 * Including the merchant signature commits its existence, not just the text. */
export function promiseNonce(
  terms: PromiseTerms,
  merchantSignature: string,
  nonceSalt: string,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        keccak256(toHex("KORP_PROMISE_NONCE_V0")),
        hashTypedData(acceptanceTypedData(terms)),
        keccak256(signature.parse(merchantSignature) as Hex),
        hash.parse(nonceSalt) as Hex,
      ],
    ),
  );
}
export function authorizationTypedData(
  terms: PromiseTerms,
  merchantSignature: string,
  nonceSalt: string,
) {
  const t = normalized(terms);
  return {
    domain: {
      name: "USDC",
      version: "2",
      chainId: 84532,
      verifyingContract: PROMISE_TOKEN,
    } as const,
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: t.payer as Address,
      to: t.payTo as Address,
      value: BigInt(t.amount),
      validAfter: BigInt(t.validAfter),
      validBefore: BigInt(t.validBefore),
      nonce: promiseNonce(t, merchantSignature, nonceSalt),
    },
  };
}
export function deliveryTypedData(
  terms: PromiseTerms,
  merchantSignature: string,
  nonceSalt: string,
  responseRoot: string,
) {
  return {
    domain,
    types: deliveryTypes,
    primaryType: "Delivery" as const,
    message: {
      termsHash: promiseTermsHash(terms),
      paymentNonce: promiseNonce(terms, merchantSignature, nonceSalt),
      responseRoot: hash.parse(responseRoot) as Hex,
    },
  };
}
export function privateRequestCommitment(requestBytes: string, salt: string) {
  z.string().max(32768).parse(requestBytes);
  return keccak256(
    concatHex([
      "0x02",
      hash.parse(salt) as Hex,
      keccak256(toHex(requestBytes)),
    ]),
  );
}
function leaf(
  index: number,
  fieldName: string,
  present: boolean,
  value: z.infer<typeof scalar>,
  salt: string,
): Hex {
  return keccak256(
    concatHex([
      "0x00",
      hash.parse(salt) as Hex,
      keccak256(toHex(JSON.stringify([index, fieldName, present, value]))),
    ]),
  );
}
function parent(left: Hex, right: Hex): Hex {
  return keccak256(concatHex(["0x01", left, right]));
}
/** Merchant adapter commits four declared scalar fields, not raw JSON/TLS bytes.
 * Missing fields have explicit salted leaves. Unlisted fields are not attested. */
export function commitResponse(
  termsInput: PromiseTerms,
  response: Record<string, unknown>,
  salts: string[] = Array.from({ length: 4 }, () => newPromiseSalt()),
) {
  const terms = normalized(termsInput);
  const secrets = z
    .array(hash)
    .length(4)
    .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === 4)
    .parse(salts);
  if (
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  )
    throw Error("RESPONSE_MUST_BE_OBJECT");
  const leaves = terms.fields.map((name, index) => {
    const present = Object.hasOwn(response, name);
    const value = present ? scalar.parse(response[name]) : null;
    const salt = secrets[index]!;
    return {
      index,
      present,
      value,
      salt,
      digest: leaf(index, name, present, value, salt),
    };
  });
  const level = [
    parent(leaves[0]!.digest, leaves[1]!.digest),
    parent(leaves[2]!.digest, leaves[3]!.digest),
  ];
  const root = parent(level[0]!, level[1]!);
  return {
    root,
    disclose(index: number): Disclosure {
      z.number().int().min(0).max(3).parse(index);
      const item = leaves[index]!;
      return {
        index,
        present: item.present,
        value: item.value,
        salt: item.salt,
        siblings: [
          leaves[index ^ 1]!.digest,
          level[Math.floor(index / 2) ^ 1]!,
        ],
      };
    },
  };
}

/** The proof includes a bearer payment signature. Never publish an active one.
 * This research export permits only expired test authorizations, with a 5-minute
 * local-clock margin. A production exporter needs independently verified chain
 * time/consumption; this is not a live payment SDK. */
export async function exportExpiredPromiseProof(
  input: unknown,
  trust: { payer: string; payTo: string; merchantSigner: string },
  now: number,
) {
  z.number().int().nonnegative().safe().parse(now);
  const p = proofSchema.parse(input);
  if (BigInt(p.terms.validBefore) + 300n > BigInt(now))
    throw Error("ACTIVE_AUTHORIZATION_MUST_NOT_BE_PUBLISHED");
  const result = await verifyPromiseBreach(p, trust);
  if (!result.valid) throw Error("INVALID_BREACH_PROOF");
  return p;
}
/** Local public-key verifier. A valid result proves only the narrowly specified
 * signed contradiction, NOT settlement, business identity or refund entitlement. */
export async function verifyPromiseBreach(
  input: unknown,
  trust: { payer: string; payTo: string; merchantSigner: string },
) {
  try {
    const p = proofSchema.parse(input),
      t = normalized(p.terms);
    if (
      address.parse(trust.payer).toLowerCase() !== t.payer ||
      address.parse(trust.payTo).toLowerCase() !== t.payTo ||
      address.parse(trust.merchantSigner).toLowerCase() !== t.merchantSigner
    )
      throw Error("UNTRUSTED_PARTICIPANTS");
    if (
      !(await verifyTypedData({
        ...acceptanceTypedData(t),
        address: t.merchantSigner as Address,
        signature: p.merchantSignature as Hex,
      }))
    )
      throw Error("INVALID_ACCEPTANCE_SIGNATURE");
    if (
      !(await verifyTypedData({
        ...authorizationTypedData(t, p.merchantSignature, p.nonceSalt),
        address: t.payer as Address,
        signature: p.authorizationSignature as Hex,
      }))
    )
      throw Error("PAYMENT_AUTHORIZATION_NOT_BOUND_TO_PROMISE");
    if (
      !(await verifyTypedData({
        ...deliveryTypedData(
          t,
          p.merchantSignature,
          p.nonceSalt,
          p.responseRoot,
        ),
        address: t.merchantSigner as Address,
        signature: p.deliverySignature as Hex,
      }))
    )
      throw Error("INVALID_DELIVERY_SIGNATURE");
    const w = p.disclosure;
    if (w.index !== t.rule.fieldIndex) throw Error("WRONG_PROMISED_FIELD");
    let current = leaf(w.index, t.fields[w.index]!, w.present, w.value, w.salt),
      position = w.index;
    for (const sibling of w.siblings) {
      current =
        position % 2 === 0
          ? parent(current, sibling as Hex)
          : parent(sibling as Hex, current);
      position = Math.floor(position / 2);
    }
    if (current.toLowerCase() !== p.responseRoot.toLowerCase())
      throw Error("INVALID_DISCLOSURE_PATH");
    if (w.present && w.value === t.rule.equals)
      throw Error("NO_BREACH_DISCLOSED");
    return {
      valid: true as const,
      claim: "merchant_signed_field_violates_payment_bound_promise" as const,
      field: t.fields[w.index]!,
      expected: t.rule.equals,
      observed: w.present ? w.value : null,
      missing: !w.present,
      paymentNonce: promiseNonce(t, p.merchantSignature, p.nonceSalt),
      otherFieldValuesDisclosed: false,
      settlementVerified: false,
      refundEntitlementVerified: false,
    };
  } catch (error) {
    return {
      valid: false as const,
      reason: error instanceof Error ? error.message : "INVALID_PROOF",
    };
  }
}
