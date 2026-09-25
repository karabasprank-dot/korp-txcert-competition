import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { Certificate, CheckRequest } from "../schemas/index.js";
import { transactionHash, policyHash } from "./canonicalize.js";
import { evaluate } from "./policy.js";
import { typedCertificate } from "./certificate.js";
export async function issueCertificate(
  request: CheckRequest,
  key: Hex,
  service: string,
  now = Math.floor(Date.now() / 1000),
): Promise<Certificate> {
  if (
    evaluate(request).decision !== "PASS" ||
    ![84532, 8453].includes(request.chainId)
  )
    throw new Error("Only supported-chain PASS can be certified");
  const account = privateKeyToAccount(key);
  const c = {
    version: 1 as const,
    issuedAt: now,
    expiresAt: now + 60,
    chainId: request.chainId,
    transactionHash: transactionHash(request),
    policyHash: policyHash(request.policy),
    decision: "PASS" as const,
    attestor: account.address,
    service,
  };
  return { ...c, signature: await account.signTypedData(typedCertificate(c)) };
}
