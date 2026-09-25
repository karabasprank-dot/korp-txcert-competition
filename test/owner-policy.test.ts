import { describe, it, expect, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import {
  typedOwnerPolicy,
  ownerApprovalDigest,
  verifyOwnerApproval,
  signWithOwnerPolicy,
  type OwnerApproval,
  type SignerTrust,
} from "../src/core/owner-policy.js";
import { issueCertificate } from "../src/core/issue-certificate.js";
import { policyHash } from "../src/core/canonicalize.js";
import { native, key, attestor, env } from "./fixtures.js";
const now = 100000;
async function fixture() {
  const owner = privateKeyToAccount(generatePrivateKey()),
    request = native();
  const authorization = {
    version: 1 as const,
    policyId: keccak256(toHex("daily-native-payments")),
    revision: "1",
    owner: owner.address,
    agent: request.from,
    chainId: request.chainId,
    service: env.SERVICE_URL,
    attestor,
    policyHash: policyHash(request.policy),
    validAfter: now - 1,
    validUntil: now + 3600,
  };
  const approval: OwnerApproval = {
    authorization,
    policy: structuredClone(request.policy),
    signature: await owner.signTypedData(typedOwnerPolicy(authorization)),
  };
  const trust: SignerTrust = {
    owner: owner.address,
    agent: request.from,
    chainId: request.chainId,
    service: env.SERVICE_URL,
    attestor,
    approvalDigest: ownerApprovalDigest(authorization),
  };
  return {
    owner,
    request,
    approval,
    trust,
    certificate: await issueCertificate(request, key, env.SERVICE_URL, now),
  };
}
describe("owner policy approvals", () => {
  it("rejects an owner identity reused as the agent", async () => {
    const f = await fixture();
    f.request.from =
      f.trust.agent =
      f.approval.authorization.agent =
        f.owner.address;
    f.trust.approvalDigest = ownerApprovalDigest(f.approval.authorization);
    f.approval.signature = await f.owner.signTypedData(
      typedOwnerPolicy(f.approval.authorization),
    );
    expect(
      (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).reason,
    ).toBe("ROLES_MUST_BE_SEPARATE");
  });
  it("verifies an owner-approved policy with independent trust", async () => {
    const f = await fixture();
    expect(
      await verifyOwnerApproval(f.approval, f.request, f.trust, now),
    ).toEqual({ valid: true, reason: "VERIFIED" });
  });
  it("rejects loosened rules even with a legitimate Korp certificate", async () => {
    const f = await fixture();
    f.request.policy.maxNativeValueWei = "999999";
    f.request.transaction.value = "1001";
    f.certificate = await issueCertificate(
      f.request,
      key,
      env.SERVICE_URL,
      now,
    );
    const sign = vi.fn();
    await expect(
      signWithOwnerPolicy(
        f,
        f.trust,
        { sign, claimNonce: async () => true },
        () => now,
      ),
    ).rejects.toThrow("OWNER_POLICY_MISMATCH");
    expect(sign).not.toHaveBeenCalled();
  });
  it("rejects replacement policy and hash signed by an agent instead of owner", async () => {
    const f = await fixture();
    f.approval.signature = await privateKeyToAccount(
      generatePrivateKey(),
    ).signTypedData(typedOwnerPolicy(f.approval.authorization));
    expect(
      (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).reason,
    ).toBe("INVALID_OWNER_SIGNATURE");
  });
  it.each(["owner", "agent", "attestor"] as const)(
    "rejects changed %s",
    async (field) => {
      const f = await fixture();
      f.approval.authorization[field] =
        privateKeyToAccount(generatePrivateKey()).address;
      expect(
        (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).valid,
      ).toBe(false);
    },
  );
  it.each([
    "policyId",
    "revision",
    "validAfter",
    "validUntil",
    "service",
    "chainId",
  ] as const)("binds signed %s", async (field) => {
    const f = await fixture();
    const a = f.approval.authorization;
    if (field === "policyId") a.policyId = keccak256(toHex("other"));
    if (field === "revision") a.revision = "2";
    if (field === "validAfter") a.validAfter--;
    if (field === "validUntil") a.validUntil++;
    if (field === "service") a.service = "https://other.test";
    if (field === "chainId") a.chainId = 8453;
    expect(
      (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).valid,
    ).toBe(false);
  });
  it.each([now - 2, now + 3600, Number.NaN])(
    "rejects invalid time %s",
    async (time) => {
      const f = await fixture();
      expect(
        (await verifyOwnerApproval(f.approval, f.request, f.trust, time)).valid,
      ).toBe(false);
    },
  );
  it("rejects approvals over thirty days even if signed and pinned", async () => {
    const f = await fixture();
    f.approval.authorization.validUntil = now + 31 * 86400;
    f.trust.approvalDigest = ownerApprovalDigest(f.approval.authorization);
    f.approval.signature = await f.owner.signTypedData(
      typedOwnerPolicy(f.approval.authorization),
    );
    expect(
      (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).valid,
    ).toBe(false);
  });
  it("deactivates old approvals by pinning the new digest", async () => {
    const f = await fixture();
    f.trust.approvalDigest = ownerApprovalDigest({
      ...f.approval.authorization,
      revision: "2",
    });
    expect(
      (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).reason,
    ).toBe("OWNER_APPROVAL_NOT_ACTIVE");
  });
  it("rejects unknown fields and a policy inconsistent with the signed hash", async () => {
    const f = await fixture();
    expect(
      (
        await verifyOwnerApproval(
          { ...f.approval, bypass: true },
          f.request,
          f.trust,
          now,
        )
      ).valid,
    ).toBe(false);
    f.approval.policy.maxNativeValueWei = "9999";
    expect(
      (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).valid,
    ).toBe(false);
  });
  it("verifies Base approval and prevents Sepolia reuse", async () => {
    const f = await fixture();
    f.request.chainId =
      f.trust.chainId =
      f.approval.authorization.chainId =
        8453;
    f.trust.approvalDigest = ownerApprovalDigest(f.approval.authorization);
    f.approval.signature = await f.owner.signTypedData(
      typedOwnerPolicy(f.approval.authorization),
    );
    expect(
      (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).valid,
    ).toBe(true);
    f.request.chainId = 84532;
    expect(
      (await verifyOwnerApproval(f.approval, f.request, f.trust, now)).valid,
    ).toBe(false);
  });
});
describe("independent signer adapter", () => {
  it("allows one exact transaction and rejects simultaneous nonce reuse", async () => {
    const f = await fixture(),
      claimed = new Set<string>(),
      sign = vi.fn(async () => "signed");
    const hooks = {
      sign,
      claimNonce: async (_chain: number, _agent: string, nonce: string) => {
        if (claimed.has(nonce)) return false;
        claimed.add(nonce);
        return true;
      },
    };
    const results = await Promise.allSettled([
      signWithOwnerPolicy(f, f.trust, hooks, () => now),
      signWithOwnerPolicy(f, f.trust, hooks, () => now),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it("rejects missing nonce before calling the signer", async () => {
    const f = await fixture();
    delete f.request.transaction.nonce;
    await expect(
      signWithOwnerPolicy(
        f,
        f.trust,
        { sign: vi.fn(), claimNonce: vi.fn() },
        () => now,
      ),
    ).rejects.toThrow("NONCE_REQUIRED");
  });
  it.each(["certificate", "request"] as const)(
    "rejects tampered %s without claiming a nonce",
    async (field) => {
      const f = await fixture(),
        claimNonce = vi.fn();
      if (field === "certificate")
        f.certificate.signature = "0x" + "00".repeat(65);
      else f.request.transaction.value = "999";
      await expect(
        signWithOwnerPolicy(
          f,
          f.trust,
          { sign: vi.fn(), claimNonce },
          () => now,
        ),
      ).rejects.toThrow();
      expect(claimNonce).not.toHaveBeenCalled();
    },
  );
  it("rejects expiry while waiting for the nonce store", async () => {
    const f = await fixture();
    let time = now;
    const sign = vi.fn();
    await expect(
      signWithOwnerPolicy(
        f,
        f.trust,
        {
          sign,
          claimNonce: async () => {
            time += 60;
            return true;
          },
        },
        () => time,
      ),
    ).rejects.toThrow("INVALID_TIME_WINDOW");
    expect(sign).not.toHaveBeenCalled();
  });
  it("snapshots caller data before asynchronous validation", async () => {
    const f = await fixture(),
      original = structuredClone(f.request),
      sign = vi.fn(async (r) => r);
    const result = signWithOwnerPolicy(
      f,
      f.trust,
      { sign, claimNonce: async () => true },
      () => now,
    );
    f.request.transaction.value = "999999";
    f.request.policy.maxNativeValueWei = "999999";
    await expect(result).resolves.toEqual(original);
  });
  it("fails closed on unavailable nonce storage", async () => {
    const f = await fixture(),
      sign = vi.fn();
    await expect(
      signWithOwnerPolicy(
        f,
        f.trust,
        {
          sign,
          claimNonce: async () => {
            throw new Error("store down");
          },
        },
        () => now,
      ),
    ).rejects.toThrow("store down");
    expect(sign).not.toHaveBeenCalled();
  });
});
