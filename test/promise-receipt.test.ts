import { describe, it, expect } from "vitest";
import { createLiveTestnet } from "../src/live-testnet.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  acceptanceTypedData,
  commitResponse,
  promiseNonce,
  verifyPromiseBreach,
  exportExpiredPromiseProof,
} from "../src/core/promise-receipt.js";
import {
  makePromiseFixture,
  freshSalt,
} from "../scripts/research/promise-fixture.js";
describe("nonce-bound merchant promise and selective breach witness", () => {
  it("exposes only the fixed synthetic cases through the hosted verifier", async () => {
    const app = createLiveTestnet(async () => {
      throw Error("NO_NETWORK_ALLOWED");
    });
    for (const scenario of [
      "original",
      "rewritten-promise",
      "fabricated-response",
    ]) {
      const response = await app.request("/api/promise-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { valid: scenario === "original" },
        settlementVerified: false,
      });
    }
    const bad = await app.request("/api/promise-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "original", proof: "untrusted input" }),
    });
    expect(bad.status).toBe(400);
  });
  it("exports only expired evidence and rejects active bearer authorizations", async () => {
    const { proof, trust } = await makePromiseFixture();
    await expect(exportExpiredPromiseProof(proof, trust, 1)).rejects.toThrow(
      "ACTIVE_AUTHORIZATION",
    );
    await expect(exportExpiredPromiseProof(proof, trust, 301)).rejects.toThrow(
      "ACTIVE_AUTHORIZATION",
    );
    expect(await exportExpiredPromiseProof(proof, trust, 302)).toEqual(proof);
  });
  it("verifies one signed counterexample without exposing the other values or claiming settlement", async () => {
    const { proof, trust } = await makePromiseFixture();
    expect(await verifyPromiseBreach(proof, trust)).toMatchObject({
      valid: true,
      expected: 84532,
      observed: 1,
      settlementVerified: false,
      refundEntitlementVerified: false,
    });
    expect(JSON.stringify(proof)).not.toContain("SYNTHETIC_PRIVATE");
    expect(proof.disclosure.siblings).toHaveLength(2);
  });
  it("rejects a matching result and supports an explicitly committed missing field", async () => {
    const good = await makePromiseFixture({ chainId: 84532 });
    expect(await verifyPromiseBreach(good.proof, good.trust)).toMatchObject({
      valid: false,
      reason: "NO_BREACH_DISCLOSED",
    });
    const missing = await makePromiseFixture({ customer: "private" });
    expect(
      await verifyPromiseBreach(missing.proof, missing.trust),
    ).toMatchObject({ valid: true, missing: true });
    const noReceipt = structuredClone(missing.proof);
    noReceipt.deliverySignature = "0x";
    expect((await verifyPromiseBreach(noReceipt, missing.trust)).valid).toBe(
      false,
    );
  });
  it("rejects merchant rewriting and re-signing the promise after buyer authorization", async () => {
    const { proof, trust, merchant } = await makePromiseFixture();
    for (const mutate of [
      (p: typeof proof) => {
        p.terms.rule.equals = 1;
      },
      (p: typeof proof) => {
        p.terms.amount = "20000";
      },
      (p: typeof proof) => {
        p.terms.validBefore = "3";
      },
      (p: typeof proof) => {
        p.terms.requestCommitment = freshSalt();
      },
      (p: typeof proof) => {
        p.terms.fields[1] = "otherField";
      },
    ]) {
      const p = structuredClone(proof);
      mutate(p);
      p.merchantSignature = await merchant.signTypedData(
        acceptanceTypedData(p.terms),
      );
      expect(await verifyPromiseBreach(p, trust)).toMatchObject({
        valid: false,
        reason: "PAYMENT_AUTHORIZATION_NOT_BOUND_TO_PROMISE",
      });
    }
  });
  it("rejects fabricated values, salt, sibling path, presence and field position", async () => {
    const { proof, trust } = await makePromiseFixture();
    for (const change of [
      { value: 56 },
      { salt: freshSalt() },
      { siblings: [freshSalt(), freshSalt()] },
      { present: false, value: null },
      { index: 1 },
    ]) {
      const p = structuredClone(proof);
      p.disclosure = { ...p.disclosure, ...change };
      expect((await verifyPromiseBreach(p, trust)).valid).toBe(false);
    }
  });
  it("rejects another payment salt, substituted signed response and arbitrary trust keys", async () => {
    const a = await makePromiseFixture(),
      b = await makePromiseFixture();
    expect(
      (
        await verifyPromiseBreach(
          { ...a.proof, nonceSalt: freshSalt() },
          a.trust,
        )
      ).valid,
    ).toBe(false);
    expect(
      (
        await verifyPromiseBreach(
          {
            ...a.proof,
            responseRoot: b.proof.responseRoot,
            deliverySignature: b.proof.deliverySignature,
          },
          a.trust,
        )
      ).valid,
    ).toBe(false);
    expect(
      (
        await verifyPromiseBreach(a.proof, {
          ...a.trust,
          merchantSigner: privateKeyToAccount(generatePrivateKey()).address,
        })
      ).valid,
    ).toBe(false);
  });
  it("domain-separates and changes the nonce with fresh entropy, rejects unknown fields/mainnet", async () => {
    const { proof, trust } = await makePromiseFixture();
    expect(
      promiseNonce(proof.terms, proof.merchantSignature, proof.nonceSalt),
    ).not.toBe(promiseNonce(proof.terms, proof.merchantSignature, freshSalt()));
    expect(
      (await verifyPromiseBreach({ ...proof, extra: true }, trust)).valid,
    ).toBe(false);
    expect(
      (
        await verifyPromiseBreach(
          { ...proof, terms: { ...proof.terms, chainId: 8453 } },
          trust,
        )
      ).valid,
    ).toBe(false);
    expect(() =>
      commitResponse(proof.terms, { chainId: 1 }, Array(4).fill(freshSalt())),
    ).toThrow();
    expect(() =>
      commitResponse(
        proof.terms,
        { chainId: { unbounded: "object" } },
        Array.from({ length: 4 }, freshSalt),
      ),
    ).toThrow();
  });
});
