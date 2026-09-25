import { describe, expect, it } from "vitest";
import report from "../docs/research/permit-repair-chain.json";
import { analyzePermitExposure } from "../src/research/permit-exposure.js";
import {
  checkRepairSnapshot,
  planPermitRepair,
  verifyPermitRepair,
} from "../src/research/permit-repair.js";

describe("Repair Planner against recorded official Permit2 local EVM executions", () => {
  for (const name of ["selective", "combined"] as const) {
    it(`verifies the ${name} plan, actual calldata, and resulting storage`, async () => {
      const evidence = report.scenarios[name];
      const fresh = await planPermitRepair(evidence.plannerInput);
      expect(fresh.status).toBe("repairable");
      expect(fresh.totalCost).toBe(name === "selective" ? "1" : "2");
      expect(
        await verifyPermitRepair(evidence.plannerInput, evidence.plan),
      ).toBe(true);
      const observed = await checkRepairSnapshot(
        evidence.plannerInput,
        evidence.plan,
        evidence.afterRepair.slots,
      );
      expect(observed.matches).toBe(true);
      for (const [i, action] of evidence.plan.actions.entries()) {
        const executed = report.receipts.find(
          (r) => r.label === `${name}: planner action ${i} ${action.kind}`,
        );
        expect(executed?.receipt.status).toBe("success");
        expect(executed?.calldata).toBe(action.transaction.data);
        expect(executed?.from.toLowerCase()).toBe(
          action.transaction.from.toLowerCase(),
        );
        expect(executed?.to.toLowerCase()).toBe(
          action.transaction.to.toLowerCase(),
        );
      }
    });
  }

  it("recognizes shared-slot impossibility and records both signatures reverting", async () => {
    const evidence = report.scenarios.shared;
    const fresh = await planPermitRepair(evidence.plannerInput);
    expect(fresh.status).toBe("impossible");
    expect(fresh.actions).toEqual([]);
    expect(await verifyPermitRepair(evidence.plannerInput, evidence.plan)).toBe(
      true,
    );
    for (const label of [
      "shared: unwanted rejects",
      "shared: wanted also rejects",
    ]) {
      const failed = report.receipts.find((r) => r.label === label);
      expect(failed?.receipt.status).toBe("reverted");
      expect(failed?.expectedError).toBe("InvalidNonce()");
    }
  });

  it("accounts for an unused signed permit restoring a locked-down allowance", async () => {
    const evidence = report.scenarios.lockdownRestore;
    expect((await analyzePermitExposure(evidence.input)).maxTotal).toBe("12");
    expect((await analyzePermitExposure(evidence.afterLockdown)).maxTotal).toBe(
      evidence.drawnAfterLockdown,
    );
    expect(evidence.afterLockdown.slots[0]!.nonce).toBe("0");
    expect(evidence.afterLockdown.slots[0]!.currentAllowance).toBe("0");
    expect(evidence.afterPermit.slots[0]!.nonce).toBe("1");
    expect(evidence.afterPermit.slots[0]!.currentAllowance).toBe("7");
    expect(
      report.receipts.find(
        (r) => r.label === "lockdown_restore: draw restored X7",
      )?.receipt.status,
    ).toBe("success");
  });

  it("distinguishes invalidating signatures from clearing current spend authority", async () => {
    const retained = report.scenarios.invalidationRetains;
    expect(
      (await analyzePermitExposure(retained.afterInvalidation)).maxTotal,
    ).toBe(retained.drawnAfterInvalidation);
    expect(retained.drawnAfterInvalidation).toBe("5");
    const closed = report.scenarios.combined;
    expect((await analyzePermitExposure(closed.afterRepair)).maxTotal).toBe(
      "0",
    );
    expect(closed.drawnAfterRepair).toBe("0");
    expect(
      report.receipts.find(
        (r) => r.label === "combined: retained allowance cannot draw",
      )?.expectedError,
    ).toBe("InsufficientAllowance(uint256)");
  });

  it("records the contract's strict-increase and per-call jump boundary", () => {
    const expected = new Map([
      ["bounds: equal zero rejects", "InvalidNonce()"],
      ["bounds: jump 65536 rejects", "ExcessiveInvalidation()"],
      ["bounds: equal 65535 rejects", "InvalidNonce()"],
      ["bounds: decreasing nonce rejects", "InvalidNonce()"],
    ]);
    for (const [label, error] of expected) {
      const receipt = report.receipts.find((r) => r.label === label);
      expect(receipt?.receipt.status).toBe("reverted");
      expect(receipt?.expectedError).toBe(error);
      expect(BigInt(receipt!.receipt.blockNumber)).toBeGreaterThan(0n);
    }
    expect(
      report.receipts.find((r) => r.label === "bounds: jump 65535 succeeds")
        ?.receipt.status,
    ).toBe("success");
    expect(
      report.receipts.find((r) => r.label === "bounds: next increment succeeds")
        ?.receipt.status,
    ).toBe("success");
    expect(report.scenarios.bounds.finalNonce).toBe("65536");
    expect(report.publicTransactions).toBe(0);
    expect(report.realFundsMoved).toBe("0");
    expect(report.provenance.repositories.permit2.revision).toBe(
      "cc56ad0f3439c502c246fc5cfcc3db92bb8b7219",
    );
  });
});
