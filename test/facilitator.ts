import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
const payer = privateKeyToAccount(generatePrivateKey());
export class TestFacilitator implements FacilitatorClient {
  constructor(
    readonly network: "eip155:84532" | "eip155:8453" = "eip155:84532",
  ) {}
  idempotent = false;
  verified = 0;
  settled = 0;
  reject = false;
  failSettlement = false;
  unavailable = false;
  seen = new Set<string>();
  async getSupported() {
    if (this.unavailable) throw new Error("offline");
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: this.network,
          extra: {},
        },
      ],
      extensions: ["bazaar"],
      signers: { "eip155:*": [payer.address] },
    };
  }
  async verify(p: PaymentPayload, r: PaymentRequirements) {
    this.verified++;
    return {
      isValid:
        !this.reject &&
        p.accepted.amount === r.amount &&
        p.accepted.payTo === r.payTo,
      payer: payer.address,
      invalidReason: this.reject ? "invalid_signature" : undefined,
    };
  }
  async settle(p: PaymentPayload) {
    this.settled++;
    const nonce = JSON.stringify(p.payload);
    if (this.failSettlement || (!this.idempotent && this.seen.has(nonce)))
      return {
        success: false,
        network: this.network,
        transaction: "",
        errorReason: "settlement_failed",
      };
    this.seen.add(nonce);
    return {
      success: true,
      network: this.network,
      transaction: "0x" + "a".repeat(64),
      payer: payer.address,
    };
  }
}
