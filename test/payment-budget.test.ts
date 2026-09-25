import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { ClientEvmSigner } from "@x402/evm";
import {
  PaymentBudget,
  TEST_USDC,
  paymentTypes,
} from "../scripts/pilot/payment-budget.js";
const payer = "0x2222222222222222222222222222222222222222";
const receiver = "0x3333333333333333333333333333333333333333";
const config = () => ({
  payer,
  receiver,
  limit: "20000",
  perPayment: "10000",
  startsAt: 100,
  endsAt: 300,
});
const input = (nonce = 1) => ({
  domain: {
    name: "USDC",
    version: "2",
    chainId: 84532,
    verifyingContract: TEST_USDC,
  },
  types: structuredClone(paymentTypes),
  primaryType: "TransferWithAuthorization",
  message: {
    from: payer,
    to: receiver,
    value: 10000n,
    validAfter: 0n,
    validBefore: 160n,
    nonce: `0x${nonce.toString(16).padStart(64, "0")}`,
  },
});
const raw = () =>
  ({
    address: payer,
    signTypedData: vi.fn(async () => "0x1234" as const),
  }) satisfies ClientEvmSigner;
describe("x402 signing budget", () => {
  it("blocks a third authorization before signing, across connections and restart", async () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "korp-payment-budget-")),
      "budget.sqlite",
    );
    const a = new PaymentBudget(file, config()),
      b = new PaymentBudget(file, config()),
      s = raw();
    await Promise.all([
      a.guard(s, () => 101).signTypedData(input(1)),
      b.guard(s, () => 101).signTypedData(input(2)),
    ]);
    expect(a.reserved()).toBe("20000");
    await expect(a.guard(s, () => 101).signTypedData(input(3))).rejects.toThrow(
      "BUDGET_EXCEEDED",
    );
    expect(s.signTypedData).toHaveBeenCalledTimes(2);
    a.close();
    b.close();
    const reopened = new PaymentBudget(file, config());
    await expect(
      reopened.guard(s, () => 102).signTypedData(input(4)),
    ).rejects.toThrow("BUDGET_EXCEEDED");
    expect(s.signTypedData).toHaveBeenCalledTimes(2);
    reopened.close();
    expect(
      () => new PaymentBudget(file, { ...config(), limit: "30000" }),
    ).toThrow("BUDGET_CONFIGURATION_CHANGED");
  });
  it("rejects wrong domains, recipient, payer, type, fields, values and expiry without reservation", async () => {
    const b = new PaymentBudget(":memory:", config()),
      s = raw(),
      guard = b.guard(s, () => 101);
    const changes = [
      { domain: { ...input().domain, chainId: 8453 } },
      { domain: { ...input().domain, verifyingContract: receiver } },
      { domain: { ...input().domain, name: "Fake USDC" } },
      { domain: { ...input().domain, salt: input().message.nonce } },
      { primaryType: "Permit" },
      { types: { ...paymentTypes, Extra: [] } },
      ...[
        { to: payer },
        { from: receiver },
        { value: 10001n },
        { value: 0n },
        { value: -1n },
        { validAfter: 1n },
        { validBefore: 101n },
        { validBefore: 162n },
        { extra: "x" },
      ].map((change) => ({ message: { ...input().message, ...change } })),
    ];
    for (const change of changes)
      await expect(
        guard.signTypedData({ ...input(), ...change }),
      ).rejects.toThrow();
    expect(b.reserved()).toBe("0");
    expect(s.signTypedData).not.toHaveBeenCalled();
    b.close();
  });
  it("never refunds a failed signing attempt and prevents reuse of its nonce", async () => {
    const b = new PaymentBudget(":memory:", config()),
      s = raw();
    s.signTypedData.mockRejectedValueOnce(Error("UNCERTAIN"));
    await expect(b.guard(s, () => 101).signTypedData(input())).rejects.toThrow(
      "UNCERTAIN",
    );
    expect(b.reserved()).toBe("10000");
    await expect(b.guard(s, () => 101).signTypedData(input())).rejects.toThrow(
      "AUTHORIZATION_ALREADY_RESERVED",
    );
    expect(s.signTypedData).toHaveBeenCalledTimes(1);
    b.close();
  });
  it("snapshots input and retains reservations if expiry occurs during signing", async () => {
    let now = 101;
    const b = new PaymentBudget(":memory:", config()),
      request = input();
    const s: ClientEvmSigner = {
      address: payer,
      signTypedData: async (data) => {
        request.message.to = payer;
        expect(data.message.to).toBe(receiver);
        now = 161;
        return "0x1234";
      },
    };
    await expect(b.guard(s, () => now).signTypedData(request)).rejects.toThrow(
      "AUTHORIZATION_EXPIRED_DURING_SIGNING",
    );
    expect(b.reserved()).toBe("10000");
    b.close();
  });
  it("rejects budgets outside their window and authorizations outliving the window", async () => {
    const b = new PaymentBudget(":memory:", { ...config(), endsAt: 150 }),
      s = raw();
    for (const now of [99, 150, NaN])
      await expect(
        b.guard(s, () => now).signTypedData(input()),
      ).rejects.toThrow("BUDGET_WINDOW_CLOSED");
    await expect(b.guard(s, () => 101).signTypedData(input())).rejects.toThrow(
      "AUTHORIZATION_EXPIRY_REJECTED",
    );
    expect(() => b.guard({ ...s, address: receiver })).toThrow(
      "PAYER_MISMATCH",
    );
    b.close();
  });
});
