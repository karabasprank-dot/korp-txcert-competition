import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import type { ClientEvmSigner } from "@x402/evm";
import { address, hash, uint } from "../../src/schemas/index.js";

export const TEST_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const configSchema = z
  .strictObject({
    payer: address,
    receiver: address,
    limit: uint,
    perPayment: uint,
    startsAt: z.number().int().nonnegative().safe(),
    endsAt: z.number().int().nonnegative().safe(),
  })
  .refine(
    (c) =>
      c.endsAt > c.startsAt &&
      BigInt(c.perPayment) > 0n &&
      BigInt(c.limit) >= BigInt(c.perPayment),
    "Invalid budget",
  );
export type PaymentBudgetConfig = z.infer<typeof configSchema>;
export const paymentTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const amount = z
  .union([z.bigint().nonnegative(), uint])
  .transform((v) => BigInt(uint.parse(String(v))));
const messageSchema = z.strictObject({
  from: address,
  to: address,
  value: amount,
  validAfter: amount,
  validBefore: amount,
  nonce: hash,
});
const domainSchema = z.strictObject({
  name: z.literal("USDC"),
  version: z.literal("2"),
  chainId: z.literal(84532),
  verifyingContract: address,
});

/** One owner-controlled database per payer. Never expose the raw signer, key,
 * configuration or database to the agent. Reservations are never auto-refunded,
 * including transport errors, expiry and uncertain settlement. No mainnet. */
export class PaymentBudget {
  private db: DatabaseSync;
  private config: PaymentBudgetConfig;
  constructor(path: string, config: PaymentBudgetConfig) {
    this.config = configSchema.parse(config);
    this.config.payer = this.config.payer.toLowerCase();
    this.config.receiver = this.config.receiver.toLowerCase();
    if (this.config.payer === this.config.receiver)
      throw Error("PAYER_IS_RECEIVER");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS payment_budget (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, reserved TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_nonces (nonce TEXT PRIMARY KEY, digest TEXT NOT NULL, amount TEXT NOT NULL);`);
    const fingerprint = keccak256(toHex(JSON.stringify(this.config)));
    this.db
      .prepare("INSERT OR IGNORE INTO payment_budget VALUES(1,?, '0')")
      .run(fingerprint);
    if (
      this.db.prepare("SELECT fingerprint FROM payment_budget WHERE id=1").get()
        ?.fingerprint !== fingerprint
    ) {
      this.db.close();
      throw Error("BUDGET_CONFIGURATION_CHANGED");
    }
  }
  active(now: number) {
    if (
      !Number.isSafeInteger(now) ||
      now < this.config.startsAt ||
      now >= this.config.endsAt
    )
      throw Error("BUDGET_WINDOW_CLOSED");
  }
  reserved() {
    return uint.parse(
      this.db.prepare("SELECT reserved FROM payment_budget WHERE id=1").get()
        ?.reserved,
    );
  }
  close() {
    this.db.close();
  }
  guard(
    signer: ClientEvmSigner,
    clock = () => Math.floor(Date.now() / 1000),
  ): ClientEvmSigner {
    if (signer.address.toLowerCase() !== this.config.payer)
      throw Error("PAYER_MISMATCH");
    return {
      address: signer.address,
      signTypedData: async (input) => {
        // Snapshot before the first await; sign only the schema checked below.
        const data = structuredClone(input);
        const domain = domainSchema.parse(data.domain),
          message = messageSchema.parse(data.message);
        if (
          domain.verifyingContract.toLowerCase() !== TEST_USDC.toLowerCase() ||
          data.primaryType !== "TransferWithAuthorization" ||
          JSON.stringify(data.types) !== JSON.stringify(paymentTypes)
        )
          throw Error("AUTHORIZATION_TYPE_REJECTED");
        const now = clock();
        this.active(now);
        if (
          message.from.toLowerCase() !== this.config.payer ||
          message.to.toLowerCase() !== this.config.receiver
        )
          throw Error("RECIPIENT_OR_PAYER_REJECTED");
        if (
          message.value <= 0n ||
          message.value > BigInt(this.config.perPayment)
        )
          throw Error("PAYMENT_LIMIT_EXCEEDED");
        if (
          message.validAfter !== 0n ||
          message.validBefore <= BigInt(now) ||
          message.validBefore > BigInt(now + 60) ||
          message.validBefore > BigInt(this.config.endsAt)
        )
          throw Error("AUTHORIZATION_EXPIRY_REJECTED");
        const typed = {
          domain: {
            ...domain,
            verifyingContract: domain.verifyingContract as Address,
          },
          types: paymentTypes,
          primaryType: "TransferWithAuthorization" as const,
          message: {
            ...message,
            from: message.from as Address,
            to: message.to as Address,
            nonce: message.nonce as Hex,
          },
        };
        const digest = hashTypedData(typed);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          if (
            this.db
              .prepare("SELECT 1 FROM payment_nonces WHERE nonce=?")
              .get(message.nonce.toLowerCase())
          )
            throw Error("AUTHORIZATION_ALREADY_RESERVED");
          const reserved = BigInt(this.reserved()) + message.value;
          if (reserved > BigInt(this.config.limit))
            throw Error("BUDGET_EXCEEDED");
          this.db
            .prepare("INSERT INTO payment_nonces VALUES(?,?,?)")
            .run(message.nonce.toLowerCase(), digest, String(message.value));
          this.db
            .prepare("UPDATE payment_budget SET reserved=? WHERE id=1")
            .run(String(reserved));
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
        const signature = await signer.signTypedData(typed);
        this.active(clock());
        if (BigInt(clock()) >= message.validBefore)
          throw Error("AUTHORIZATION_EXPIRED_DURING_SIGNING");
        return signature;
      },
    };
  }
}
