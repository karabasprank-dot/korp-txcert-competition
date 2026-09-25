import { z } from "zod";
import {
  hashTypedData,
  keccak256,
  toHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import {
  address,
  hash,
  uint,
  policySchema,
  requestSchema,
  type CheckRequest,
} from "../schemas/index.js";
import { policyHash } from "./canonicalize.js";
import { verifyCertificate } from "./certificate.js";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const origin = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Use an exact HTTPS origin (HTTP loopback allowed for local demos)");
export const authorizationSchema = z.strictObject({
  version: z.literal(1),
  policyId: hash,
  revision: uint,
  owner: address,
  agent: address,
  chainId: z.union([z.literal(84532), z.literal(8453)]),
  service: origin,
  attestor: address,
  policyHash: hash,
  validAfter: timestamp,
  validUntil: timestamp,
});
export const ownerApprovalSchema = z.strictObject({
  authorization: authorizationSchema,
  policy: policySchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export const signerTrustSchema = z.strictObject({
  owner: address,
  agent: address,
  chainId: z.union([z.literal(84532), z.literal(8453)]),
  service: origin,
  attestor: address,
  approvalDigest: hash,
});
export type PolicyAuthorization = z.infer<typeof authorizationSchema>;
export type OwnerApproval = z.infer<typeof ownerApprovalSchema>;
export type SignerTrust = z.infer<typeof signerTrustSchema>;

export const ownerPolicyTypes = {
  PolicyApproval: [
    { name: "version", type: "uint256" },
    { name: "policyId", type: "bytes32" },
    { name: "revision", type: "uint256" },
    { name: "owner", type: "address" },
    { name: "agent", type: "address" },
    { name: "attestor", type: "address" },
    { name: "policyHash", type: "bytes32" },
    { name: "validAfter", type: "uint256" },
    { name: "validUntil", type: "uint256" },
  ],
} as const;

// Prepare this on the owner side and sign with the owner's wallet. No key is
// accepted here. The signature grants policy approval, not token approval.
export function typedOwnerPolicy(input: PolicyAuthorization) {
  const a = authorizationSchema.parse(input);
  return {
    domain: {
      name: "Korp Owner Policy",
      version: "1",
      chainId: a.chainId,
      salt: keccak256(toHex(a.service)),
    },
    types: ownerPolicyTypes,
    primaryType: "PolicyApproval" as const,
    message: {
      version: BigInt(a.version),
      policyId: a.policyId as Hex,
      revision: BigInt(a.revision),
      owner: a.owner as Address,
      agent: a.agent as Address,
      attestor: a.attestor as Address,
      policyHash: a.policyHash as Hex,
      validAfter: BigInt(a.validAfter),
      validUntil: BigInt(a.validUntil),
    },
  };
}
export const ownerApprovalDigest = (a: PolicyAuthorization) =>
  hashTypedData(typedOwnerPolicy(a));

// Trust MUST come from owner-controlled signer configuration, never the agent
// request. Pin the full approval digest so replacing it revokes older approvals.
export async function verifyOwnerApproval(
  input: unknown,
  requestInput: unknown,
  trustInput: unknown,
  now = Math.floor(Date.now() / 1000),
): Promise<{ valid: boolean; reason: string }> {
  const ap = ownerApprovalSchema.safeParse(input),
    rp = requestSchema.safeParse(requestInput),
    tp = signerTrustSchema.safeParse(trustInput);
  if (!ap.success || !rp.success || !tp.success || !Number.isSafeInteger(now))
    return { valid: false, reason: "INVALID_INPUT" };
  const { authorization: a, policy, signature } = ap.data,
    r = rp.data,
    t = tp.data;
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  if (
    eq(a.owner, a.agent) ||
    eq(a.owner, a.attestor) ||
    eq(a.agent, a.attestor)
  )
    return { valid: false, reason: "ROLES_MUST_BE_SEPARATE" };
  if (
    !eq(a.owner, t.owner) ||
    !eq(a.agent, t.agent) ||
    !eq(r.from, t.agent) ||
    a.chainId !== t.chainId ||
    r.chainId !== t.chainId ||
    a.service !== t.service ||
    !eq(a.attestor, t.attestor)
  )
    return { valid: false, reason: "OWNER_CONTEXT_MISMATCH" };
  if (
    a.validAfter > now ||
    a.validUntil <= now ||
    a.validUntil <= a.validAfter ||
    a.validUntil - a.validAfter > 30 * 86400
  )
    return { valid: false, reason: "OWNER_APPROVAL_EXPIRED_OR_INVALID" };
  if (!eq(ownerApprovalDigest(a), t.approvalDigest))
    return { valid: false, reason: "OWNER_APPROVAL_NOT_ACTIVE" };
  if (
    !eq(a.policyHash, policyHash(policy)) ||
    !eq(a.policyHash, policyHash(r.policy))
  )
    return { valid: false, reason: "OWNER_POLICY_MISMATCH" };
  try {
    const valid = await verifyTypedData({
      ...typedOwnerPolicy(a),
      address: t.owner as Address,
      signature: signature as Hex,
    });
    return { valid, reason: valid ? "VERIFIED" : "INVALID_OWNER_SIGNATURE" };
  } catch {
    return { valid: false, reason: "INVALID_OWNER_SIGNATURE" };
  }
}

export type SignerHooks<T> = {
  // A transaction-scoped, atomic compare-and-set across every signer replica.
  // Must fail if nonce differs from wallet pending nonce or was already claimed.
  claimNonce: (
    chainId: number,
    agent: Address,
    nonce: string,
  ) => Promise<boolean>;
  // This lives in the independent signing process. It must also enforce fees,
  // balances and wallet-specific controls outside the TxCert certificate scope.
  sign: (request: CheckRequest) => Promise<T>;
};

// No network calls, private keys or broadcast. The independent signer supplies
// protected hooks. Never give an untrusted agent direct access to these hooks.
export async function signWithOwnerPolicy<T>(
  input: { request: unknown; certificate: unknown; approval: unknown },
  trustInput: unknown,
  hooks: SignerHooks<T>,
  clock: () => number = () => Math.floor(Date.now() / 1000),
): Promise<T> {
  // Snapshot all caller-owned objects before the first await (TOCTOU protection).
  const r = requestSchema.parse(input.request);
  const approval = ownerApprovalSchema.parse(input.approval);
  const certificate = structuredClone(input.certificate);
  const t = signerTrustSchema.parse(trustInput);
  if (r.transaction.nonce === undefined) throw new Error("NONCE_REQUIRED");
  const check = async () => {
    const now = clock();
    const owner = await verifyOwnerApproval(approval, r, t, now);
    if (!owner.valid) throw new Error(owner.reason);
    const cert = await verifyCertificate(
      certificate,
      r,
      t.attestor as Address,
      t.service,
      now,
    );
    if (!cert.valid) throw new Error(cert.reason);
  };
  await check();
  if (
    !(await hooks.claimNonce(
      t.chainId,
      t.agent as Address,
      r.transaction.nonce,
    ))
  )
    throw new Error("NONCE_UNAVAILABLE");
  // A slow nonce store may cross certificate/approval expiry. A failed signing
  // attempt leaves the nonce claimed; reconcile safely instead of auto-release.
  await check();
  return hooks.sign(r);
}
