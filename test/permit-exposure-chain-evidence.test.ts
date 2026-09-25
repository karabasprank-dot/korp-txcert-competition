import { describe, expect, it } from "vitest";
import report from "../docs/research/permit-exposure-chain.json";
import { analyzePermitExposure } from "../src/research/permit-exposure.js";

describe("Exposure Map against recorded official Permit2 local EVM executions", () => {
  for (const name of ["triangle", "sequential", "cyclic"] as const) {
    it(`matches ${name} using the actual recorded EIP-712 signatures`, async () => {
      const batches = report.signedBatches.filter((b) =>
        b.label.startsWith(name + " "),
      );
      expect(batches.length).toBeGreaterThan(0);
      const first = batches[0]!;
      const tokens = [
        ...new Set(
          batches.flatMap((b) => b.message.details.map((d) => d.token)),
        ),
      ];
      const result = await analyzePermitExposure({
        domain: {
          chainId: first.domain.chainId,
          verifyingContract: first.domain.verifyingContract,
        },
        owner: first.owner,
        asOfTimestamp: Math.floor(Date.parse(report.generatedAt) / 1000),
        assets: tokens.map((token) => ({ token, weight: "1" })),
        // Each scenario starts with fresh owners and zero Permit2 allowances/nonces.
        slots: tokens.map((token) => ({
          token,
          spender: first.message.spender,
          nonce: "0",
          currentAllowance: "0",
          expiration: "0",
        })),
        permits: batches.map((b) => ({
          id: b.label,
          spender: b.message.spender,
          sigDeadline: b.message.sigDeadline,
          details: b.message.details.map((d) => ({
            ...d,
            nonce: String(d.nonce),
            expiration: String(d.expiration),
          })),
          signature: b.signature,
        })),
      });
      expect(result.maxTotal).toBe(report.scenarios[name].collectible);
      expect(report.publicTransactions).toBe(0);
    });
  }
});
