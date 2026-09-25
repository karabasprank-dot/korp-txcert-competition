import { issueCertificate } from "../src/core/issue-certificate.js";
import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyCertificate } from "../src/core/certificate.js";
import { transactionHash, policyHash } from "../src/core/canonicalize.js";
import { native, erc20, key, otherKey, attestor, env } from "./fixtures.js";
const now = 100000;
describe("certificate trust and binding", () => {
  it("verifies independently with pinned signer", async () => {
    const r = native(),
      c = await issueCertificate(r, key, env.SERVICE_URL, now);
    expect(
      await verifyCertificate(c, r, attestor, env.SERVICE_URL, now),
    ).toEqual({ valid: true, reason: "VERIFIED" });
  });
  for (const field of ["to", "value", "data", "nonce"] as const)
    it(`rejects modified ${field}`, async () => {
      const r = native(),
        c = await issueCertificate(r, key, env.SERVICE_URL, now);
      r.transaction[field] =
        field === "to" ? r.from : field === "data" ? "0x01" : "2";
      expect(
        (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
      ).toBe(false);
    });
  it("rejects modified sender", async () => {
    const r = native(),
      c = await issueCertificate(r, key, env.SERVICE_URL, now);
    r.from = r.transaction.to;
    expect(
      (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
    ).toBe(false);
  });
  it("rejects modified policy", async () => {
    const r = native(),
      c = await issueCertificate(r, key, env.SERVICE_URL, now);
    r.policy.maxNativeValueWei = "2000";
    expect(
      (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
    ).toBe(false);
  });
  it("rejects another attestor", async () => {
    const r = native(),
      c = await issueCertificate(r, otherKey, env.SERVICE_URL, now);
    expect(
      (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
    ).toBe(false);
  });
  it("rejects forged attestor field", async () => {
    const r = native(),
      c = await issueCertificate(r, otherKey, env.SERVICE_URL, now);
    c.attestor = attestor;
    expect(
      (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
    ).toBe(false);
  });
  it("rejects changed service", async () => {
    const r = native(),
      c = await issueCertificate(r, key, env.SERVICE_URL, now);
    c.service = "https://another.test";
    expect(
      (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
    ).toBe(false);
  });
  it.each([now - 1, now + 60, now + 61])(
    "rejects invalid time %s",
    async (time) => {
      const r = native(),
        c = await issueCertificate(r, key, env.SERVICE_URL, now);
      expect(
        (await verifyCertificate(c, r, attestor, env.SERVICE_URL, time)).valid,
      ).toBe(false);
    },
  );
  it("rejects tampered expiry", async () => {
    const r = native(),
      c = await issueCertificate(r, key, env.SERVICE_URL, now);
    c.expiresAt++;
    expect(
      (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
    ).toBe(false);
  });
  it("refuses to sign BLOCK", async () => {
    const r = native();
    r.transaction.value = "2000";
    await expect(
      issueCertificate(r, key, env.SERVICE_URL, now),
    ).rejects.toThrow();
  });
  it("refuses to sign WARN", async () => {
    const r = native();
    r.transaction.data = "0x12345678";
    r.policy.expectedAction = "unknown";
    r.policy.allowUnknownCalls = true;
    await expect(
      issueCertificate(r, key, env.SERVICE_URL, now),
    ).rejects.toThrow();
  });
  it("has no dependency on signer key for offline verification", async () => {
    const r = native(),
      c = await issueCertificate(r, key, env.SERVICE_URL, now);
    expect(
      (
        await verifyCertificate(
          c,
          r,
          privateKeyToAccount(key).address,
          env.SERVICE_URL,
          now,
        )
      ).valid,
    ).toBe(true);
  });
});
describe("canonical hashes", () => {
  it("normalizes address case", () => {
    const a = erc20(),
      b = erc20();
    b.transaction.to = b.transaction.to.toLowerCase();
    expect(transactionHash(a)).toBe(transactionHash(b));
  });
  it("normalizes set order", () => {
    const a = native(),
      b = native();
    a.policy.allowedRecipients.push(a.from);
    b.policy.allowedRecipients.unshift(b.from);
    expect(policyHash(a.policy)).toBe(policyHash(b.policy));
  });
  it("ignores object property order", () => {
    const a = native();
    expect(transactionHash(a)).toBe(
      transactionHash({
        ...a,
        transaction: {
          value: "1000",
          nonce: "0",
          data: "0x",
          to: a.transaction.to,
        },
      }),
    );
  });
  it("binds presence of nonce", () => {
    const a = native(),
      b = native();
    delete b.transaction.nonce;
    expect(transactionHash(a)).not.toBe(transactionHash(b));
  });
  it("binds all policy flags", () => {
    const a = native(),
      b = native();
    b.policy.allowUnlimitedApproval = true;
    expect(policyHash(a.policy)).not.toBe(policyHash(b.policy));
  });
});

it("binds Base mainnet certificate to chain and rejects cross-network reuse", async () => {
  const r = native();
  r.chainId = 8453;
  const c = await issueCertificate(r, key, env.SERVICE_URL, now);
  expect(
    (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
  ).toBe(true);
  r.chainId = 84532;
  expect(
    (await verifyCertificate(c, r, attestor, env.SERVICE_URL, now)).valid,
  ).toBe(false);
});
