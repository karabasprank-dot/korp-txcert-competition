import { describe, it, expect } from "vitest";
import {
  evaluateOutcome,
  verifyOutcomeReport,
  type OutcomeContract,
} from "../src/core/outcome-contract.js";
import { createLiveTestnet } from "../src/live-testnet.js";
const contract: OutcomeContract = {
  version: 1,
  statuses: [200],
  rules: [
    { kind: "equals", path: ["chainId"], value: 84532 },
    { kind: "equals", path: ["asset"], value: "USDC" },
    { kind: "range", path: ["price"], min: 0.9, max: 1.1 },
    {
      kind: "freshness",
      path: ["updatedAt"],
      maxAgeSeconds: 30,
      futureToleranceSeconds: 0,
    },
  ],
};
const good = { chainId: 84532, asset: "USDC", price: 1, updatedAt: 990 };
describe("preapproved outcome contract", () => {
  it("accepts matching data while explicitly refusing to claim truth or authorship", () => {
    const body = JSON.stringify(good),
      report = evaluateOutcome(contract, body, 200, 1000);
    expect(report.decision).toBe("checks_passed");
    expect(report.usefulDeliveryVerified).toBe(false);
    expect(report.merchantAuthorshipVerified).toBe(false);
    expect(verifyOutcomeReport(contract, body, report)).toBe(true);
    expect(
      verifyOutcomeReport(contract, body, {
        ...report,
        decision: "checks_failed",
      }),
    ).toBe(false);
    expect(
      verifyOutcomeReport(
        contract,
        JSON.stringify({ ...good, price: 2 }),
        report,
      ),
    ).toBe(false);
    expect(
      verifyOutcomeReport({ ...contract, statuses: [201] }, body, report),
    ).toBe(false);
  });
  it("rejects stale, future, wrong-chain, wrong-asset and wrongly typed responses despite HTTP 200", () => {
    for (const change of [
      { chainId: 1 },
      { asset: "SCAM" },
      { price: 100 },
      { price: "1" },
      { updatedAt: 900 },
      { updatedAt: 1001 },
      { updatedAt: 990.5 },
    ])
      expect(
        evaluateOutcome(
          contract,
          JSON.stringify({ ...good, ...change }),
          200,
          1000,
        ).decision,
      ).toBe("checks_failed");
    for (const body of ["not json", "{}", "null", "[]", '{"price":1e999}'])
      expect(evaluateOutcome(contract, body, 200, 1000).decision).toBe(
        "checks_failed",
      );
    expect(
      evaluateOutcome(contract, JSON.stringify(good), 503, 1000).decision,
    ).toBe("checks_failed");
    expect(evaluateOutcome(contract, null, null, 1000).decision).toBe(
      "response_missing",
    );
    expect(() => evaluateOutcome(contract, null, 200, 1000)).toThrow();
  });
  it("bounds policy work and rejects prototype traversal, unknown operators and fields", () => {
    for (const rules of [
      [{ kind: "type", path: ["__proto__"], value: "object" }],
      [{ kind: "regex", path: ["x"], value: ".*" }],
      Array(21).fill(contract.rules[0]),
    ])
      expect(() =>
        evaluateOutcome(
          { ...contract, rules } as OutcomeContract,
          "{}",
          200,
          1000,
        ),
      ).toThrow();
    expect(() =>
      evaluateOutcome(
        { ...contract, extra: true } as OutcomeContract,
        "{}",
        200,
        1000,
      ),
    ).toThrow();
    expect(() =>
      evaluateOutcome(contract, "a".repeat(262145), 200, 1000),
    ).toThrow();
    expect(() => evaluateOutcome(contract, "{}", 200, NaN)).toThrow();
    expect(() =>
      evaluateOutcome(
        {
          version: 1,
          statuses: [200],
          rules: [{ kind: "type", path: ["constructor"], value: "object" }],
        } as OutcomeContract,
        "{}",
        200,
        1000,
      ),
    ).toThrow();
  });
  it("serves a read-only checker with strict input, missing-result classification and no RPC dependency", async () => {
    const app = createLiveTestnet(async () => {
      throw Error("RPC_MUST_NOT_BE_CALLED");
    });
    const post = (data: unknown) =>
      app.request("/api/outcome-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
    const response = await post({
      contract,
      body: JSON.stringify({
        ...good,
        updatedAt: Math.floor(Date.now() / 1000),
      }),
      httpStatus: 200,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ decision: "checks_passed" });
    expect(
      await (await post({ contract, body: null, httpStatus: null })).json(),
    ).toMatchObject({ decision: "response_missing" });
    expect((await post({ contract, body: null, httpStatus: 200 })).status).toBe(
      400,
    );
    expect(
      (await post({ contract, body: "{}", httpStatus: 200, unknown: true }))
        .status,
    ).toBe(400);
  });
});
