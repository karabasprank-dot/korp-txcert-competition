import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetStore, type Budget } from "../scripts/hackathon/budget-store.js";
import { erc20, native, token } from "./fixtures.js";
const config = (): Budget => ({
  id: "demo",
  chainId: 84532,
  agent: native().from,
  asset: token,
  limit: "150",
  startsAt: 100,
  endsAt: 200,
});
const request = (nonce: string, amount = 100n) => {
  const r = erc20("transfer", amount);
  r.transaction.nonce = nonce;
  return r;
};
describe("persistent signer budget", () => {
  it("rejects cumulative overspend across separately opened connections and restart", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "korp-budget-")),
      "budget.sqlite",
    );
    const a = new BudgetStore(path, config()),
      b = new BudgetStore(path, config());
    a.reserve(request("0"), "0", 101);
    expect(() => b.reserve(request("1"), "1", 101)).toThrow("BUDGET_EXCEEDED");
    expect(b.reserved()).toBe("100");
    a.close();
    b.close();
    const c = new BudgetStore(path, config());
    expect(() => c.reserve(request("0", 1n), "0", 101)).toThrow(
      "NONCE_ALREADY_RESERVED",
    );
    c.reserve(request("1", 50n), "1", 101);
    expect(c.reserved()).toBe("150");
    c.close();
  });
  it("pins configuration across reopening", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "korp-budget-")),
      "budget.sqlite",
    );
    new BudgetStore(path, config()).close();
    expect(() => new BudgetStore(path, { ...config(), limit: "999" })).toThrow(
      "BUDGET_CONFIGURATION_CHANGED",
    );
  });
  it("rejects wrong window, nonce, identity, asset, approvals and chain without consuming budget", () => {
    const s = new BudgetStore(":memory:", config());
    for (const time of [99, 200, NaN])
      expect(() => s.reserve(request("0"), "0", time)).toThrow(
        "BUDGET_WINDOW_CLOSED",
      );
    expect(() => s.reserve(request("0"), "1", 101)).toThrow(
      "PENDING_NONCE_MISMATCH",
    );
    const wrong = request("0");
    wrong.from = "0x4444444444444444444444444444444444444444";
    expect(() => s.reserve(wrong, "0", 101)).toThrow("BUDGET_CONTEXT_MISMATCH");
    const n = native();
    n.transaction.nonce = "0";
    expect(() => s.reserve(n, "0", 101)).toThrow("BUDGET_ASSET_MISMATCH");
    const approval = erc20("approve");
    approval.transaction.nonce = "0";
    expect(() => s.reserve(approval, "0", 101)).toThrow(
      "BUDGET_ACTION_UNSUPPORTED",
    );
    expect(() =>
      s.reserve({ ...request("0"), chainId: 8453 }, "0", 101),
    ).toThrow("BUDGET_CONTEXT_MISMATCH");
    expect(s.reserved()).toBe("0");
    s.close();
  });
  it("accounts native amounts without numeric precision loss", () => {
    const n = native();
    n.transaction.nonce = "0";
    n.transaction.value = "9007199254740993";
    n.policy.maxNativeValueWei = n.transaction.value;
    const s = new BudgetStore(":memory:", {
      ...config(),
      asset: "native",
      limit: n.transaction.value,
    });
    s.reserve(n, "0", 101);
    expect(s.reserved()).toBe(n.transaction.value);
    s.close();
  });
});
