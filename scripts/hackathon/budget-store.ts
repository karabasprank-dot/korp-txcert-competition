import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { keccak256, toHex } from "viem";
import { address, uint, requestSchema } from "../../src/schemas/index.js";
import { evaluate } from "../../src/core/policy.js";

const budgetSchema = z
  .strictObject({
    id: z.string().min(1).max(100),
    chainId: z.literal(84532),
    agent: address,
    asset: z.union([z.literal("native"), address]),
    limit: uint,
    startsAt: z.number().int().nonnegative().safe(),
    endsAt: z.number().int().nonnegative().safe(),
  })
  .refine((b) => b.endsAt > b.startsAt, "Invalid budget window");
export type Budget = z.infer<typeof budgetSchema>;

/** Experimental Sepolia-only reference adapter. Configuration comes from the
 * owner's isolated signer, never agent input. One shared SQLite file per signer
 * wallet; do not distribute copies across replicas. Charges are reservations,
 * not settled spending. Failed/uncertain signatures are NEVER auto-refunded. */
export class BudgetStore {
  private db: DatabaseSync;
  private budget: Budget;
  constructor(path: string, input: Budget) {
    this.budget = budgetSchema.parse(input);
    this.budget.agent = this.budget.agent.toLowerCase();
    this.budget.asset = this.budget.asset.toLowerCase();
    const b = this.budget;
    const fingerprint = keccak256(toHex(JSON.stringify(b)));
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, reserved TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (chain INTEGER NOT NULL, agent TEXT NOT NULL, nonce TEXT NOT NULL,
        budget TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(chain,agent,nonce));`);
    this.db
      .prepare("INSERT OR IGNORE INTO budgets VALUES (?,?,?)")
      .run(b.id, fingerprint, "0");
    const row = this.db
      .prepare("SELECT fingerprint FROM budgets WHERE id=?")
      .get(b.id);
    if (row?.fingerprint !== fingerprint) {
      this.db.close();
      throw new Error("BUDGET_CONFIGURATION_CHANGED");
    }
  }
  /** Call only inside verified signWithOwnerPolicy.claimNonce. expectedNonce
   * must come from a trusted pending-nonce source, not the caller's request. */
  reserve(input: unknown, expectedNonce: string, now: number): void {
    const r = requestSchema.parse(input),
      b = this.budget;
    uint.parse(expectedNonce);
    if (!Number.isSafeInteger(now) || now < b.startsAt || now >= b.endsAt)
      throw new Error("BUDGET_WINDOW_CLOSED");
    if (r.chainId !== b.chainId || r.from.toLowerCase() !== b.agent)
      throw new Error("BUDGET_CONTEXT_MISMATCH");
    if (
      r.transaction.nonce === undefined ||
      r.transaction.nonce !== expectedNonce
    )
      throw new Error("PENDING_NONCE_MISMATCH");
    const result = evaluate(r);
    if (result.decision !== "PASS") throw new Error("POLICY_BLOCKED");
    const d = result.decoded;
    if (d.action !== "native-transfer" && d.action !== "transfer")
      throw new Error("BUDGET_ACTION_UNSUPPORTED");
    const asset =
      d.action === "native-transfer" ? "native" : d.token?.toLowerCase();
    if (asset !== b.asset) throw new Error("BUDGET_ASSET_MISMATCH");
    const amount = BigInt(uint.parse(d.amount));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare("SELECT 1 FROM nonces WHERE chain=? AND agent=? AND nonce=?")
          .get(b.chainId, b.agent, expectedNonce)
      )
        throw new Error("NONCE_ALREADY_RESERVED");
      const row = this.db
        .prepare("SELECT reserved FROM budgets WHERE id=?")
        .get(b.id);
      const reserved = BigInt(uint.parse(row?.reserved));
      if (reserved + amount > BigInt(b.limit))
        throw new Error("BUDGET_EXCEEDED");
      this.db
        .prepare("INSERT INTO nonces VALUES (?,?,?,?,?)")
        .run(b.chainId, b.agent, expectedNonce, b.id, amount.toString());
      this.db
        .prepare("UPDATE budgets SET reserved=? WHERE id=?")
        .run((reserved + amount).toString(), b.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  assertActive(now: number): void {
    if (
      !Number.isSafeInteger(now) ||
      now < this.budget.startsAt ||
      now >= this.budget.endsAt
    )
      throw new Error("BUDGET_WINDOW_CLOSED");
  }
  reserved(): string {
    return uint.parse(
      this.db
        .prepare("SELECT reserved FROM budgets WHERE id=?")
        .get(this.budget.id)?.reserved,
    );
  }
  close(): void {
    this.db.close();
  }
}
