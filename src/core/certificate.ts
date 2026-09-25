import {
  keccak256,
  toHex,
  verifyTypedData,
  type Hex,
  type Address,
} from "viem";
import {
  certificateSchema,
  requestSchema,
  type Certificate,
} from "../schemas/index.js";
import { transactionHash, policyHash } from "./canonicalize.js";
import { evaluate } from "./policy.js";
export const certificateTypes = {
  TxCert: [
    { name: "version", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "transactionHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "decision", type: "string" },
    { name: "attestor", type: "address" },
  ],
} as const;
export function typedCertificate(c: Omit<Certificate, "signature">) {
  return {
    domain: {
      name: "Korp TxCert",
      version: "1",
      chainId: c.chainId,
      salt: keccak256(toHex(c.service)),
    },
    types: certificateTypes,
    primaryType: "TxCert" as const,
    message: {
      version: BigInt(c.version),
      issuedAt: BigInt(c.issuedAt),
      expiresAt: BigInt(c.expiresAt),
      chainId: BigInt(c.chainId),
      transactionHash: c.transactionHash as Hex,
      policyHash: c.policyHash as Hex,
      decision: c.decision,
      attestor: c.attestor as Address,
    },
  };
}
// The caller must pin trustedAttestor and service independently of the certificate.
export async function verifyCertificate(
  input: unknown,
  requestInput: unknown,
  trustedAttestor: Address,
  service: string,
  now = Math.floor(Date.now() / 1000),
) {
  const cp = certificateSchema.safeParse(input),
    rp = requestSchema.safeParse(requestInput);
  if (!cp.success || !rp.success)
    return { valid: false, reason: "INVALID_INPUT" };
  const c = cp.data,
    r = rp.data;
  if (
    c.attestor.toLowerCase() !== trustedAttestor.toLowerCase() ||
    c.service !== service
  )
    return { valid: false, reason: "UNTRUSTED_ATTESTOR_OR_SERVICE" };
  if (c.issuedAt > now || c.expiresAt <= now || c.expiresAt - c.issuedAt !== 60)
    return { valid: false, reason: "INVALID_TIME_WINDOW" };
  if (
    c.chainId !== r.chainId ||
    c.transactionHash !== transactionHash(r) ||
    c.policyHash !== policyHash(r.policy)
  )
    return { valid: false, reason: "BINDING_MISMATCH" };
  if (evaluate(r).decision !== "PASS")
    return { valid: false, reason: "POLICY_NOT_PASS" };
  try {
    const valid = await verifyTypedData({
      ...typedCertificate(c),
      address: trustedAttestor,
      signature: c.signature as Hex,
    });
    return { valid, reason: valid ? "VERIFIED" : "INVALID_SIGNATURE" };
  } catch {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }
}
