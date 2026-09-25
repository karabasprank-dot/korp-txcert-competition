import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  decodeEventLog,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";
import type { ClientEvmSigner } from "@x402/evm";
import { address, hash, uint } from "../../src/schemas/index.js";
import { PaymentBudget, TEST_USDC } from "./payment-budget.js";
import { buyerFetch } from "../client.js";
import {
  defaultOutcomeContract,
  evaluateOutcome,
  outcomeContractSchema,
} from "../../src/core/outcome-contract.js";

const requestSchema = z
  .strictObject({
    url: z.string().url().max(2048),
    method: z.literal("POST"),
    body: z.string().max(32768),
  })
  .superRefine((r, ctx) => {
    const u = new URL(r.url);
    if (u.protocol !== "https:" || u.username || u.password || u.hash)
      ctx.addIssue({
        code: "custom",
        message: "HTTPS request without credentials or fragment required",
      });
  });
export type TaskRequest = z.infer<typeof requestSchema>;
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const approvalSchema = z.strictObject({
  id: idSchema,
  request: requestSchema,
  payer: address,
  receiver: address,
  amount: uint.refine((v) => BigInt(v) > 0n),
  contract: outcomeContractSchema.default(defaultOutcomeContract),
});
export type TaskApproval = z.input<typeof approvalSchema>;
const recordSchema = z.strictObject({
  id: idSchema,
  request_digest: hash,
  payer: address,
  receiver: address,
  amount: uint,
  state: z.enum(["approved", "payment_uncertain", "response_received"]),
  nonce: hash.nullable(),
  response_digest: hash.nullable(),
  http_status: z.number().int().nullable(),
  settlement_reported: hash.nullable(),
  contract_json: z.string().nullable(),
  outcome_json: z.string().nullable(),
});
export type TaskPaymentRecord = z.infer<typeof recordSchema>;
const paymentEvents = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
export type PaymentEvidenceReader = Pick<
  PublicClient,
  "getChainId" | "getTransactionReceipt" | "getBlock"
>;
const digest = (value: string) => keccak256(toHex(value));
export function taskRequestDigest(request: TaskRequest) {
  const r = requestSchema.parse(request);
  // Exact bytes, including whitespace and query order. Never persist the body.
  return digest(JSON.stringify([r.method, r.url, "application/json", r.body]));
}

/** Owner-side only. Agent must not have access to approve(), raw signer or DB.
 * Claims are durable before signing. Nothing automatically reopens a task.
 * This records observed outcomes, not proof of useful service delivery. */
export class TaskPayments {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS task_payments (
        id TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
        payer TEXT NOT NULL, receiver TEXT NOT NULL, amount TEXT NOT NULL,
        state TEXT NOT NULL, nonce TEXT, response_digest TEXT,
        http_status INTEGER, settlement_reported TEXT,
        contract_json TEXT, outcome_json TEXT
      );`);
    const columns = this.db
      .prepare("PRAGMA table_info(task_payments)")
      .all()
      .map((row) => row.name);
    for (const name of ["contract_json", "outcome_json"])
      if (!columns.includes(name))
        this.db.exec(`ALTER TABLE task_payments ADD COLUMN ${name} TEXT`);
  }
  close() {
    this.db.close();
  }
  approve(input: TaskApproval) {
    const a = approvalSchema.parse(input);
    const expected = {
      id: a.id,
      request_digest: taskRequestDigest(a.request),
      payer: a.payer.toLowerCase(),
      receiver: a.receiver.toLowerCase(),
      amount: a.amount,
      contract_json: JSON.stringify(a.contract),
    };
    if (expected.payer === expected.receiver) throw Error("PAYER_IS_RECEIVER");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_payments
      (id,request_digest,payer,receiver,amount,contract_json,state) VALUES(?,?,?,?,?,?,'approved')`,
      )
      .run(
        expected.id,
        expected.request_digest,
        expected.payer,
        expected.receiver,
        expected.amount,
        expected.contract_json,
      );
    const existing = this.status(a.id);
    for (const key of Object.keys(expected) as (keyof typeof expected)[])
      if (existing[key] !== expected[key]) throw Error("TASK_APPROVAL_CHANGED");
    // Re-approval of identical input never resets an already attempted task.
    return existing;
  }
  status(id: string): TaskPaymentRecord {
    const row = this.db
      .prepare("SELECT * FROM task_payments WHERE id=?")
      .get(idSchema.parse(id));
    if (!row) throw Error("TASK_NOT_APPROVED");
    return recordSchema.parse(row);
  }
  assertRequest(id: string, request: TaskRequest) {
    const row = this.status(id);
    if (!row.contract_json)
      throw Error("TASK_HAS_NO_PREAPPROVED_OUTCOME_CONTRACT");
    if (row.request_digest !== taskRequestDigest(request))
      throw Error("TASK_REQUEST_CHANGED");
    if (row.state !== "approved")
      throw Error("TASK_ALREADY_ATTEMPTED_RECONCILE_FIRST");
    return row;
  }
  guard(
    id: string,
    request: TaskRequest,
    budget: PaymentBudget,
    raw: ClientEvmSigner,
    clock = () => Math.floor(Date.now() / 1000),
  ): ClientEvmSigner {
    const approved = this.assertRequest(id, request);
    const bounded = budget.guard(raw, clock);
    if (bounded.address.toLowerCase() !== approved.payer)
      throw Error("PAYER_MISMATCH");
    return {
      address: bounded.address,
      signTypedData: async (input) => {
        const copy = structuredClone(input);
        const message = copy.message;
        if (
          String(message.from).toLowerCase() !== approved.payer ||
          String(message.to).toLowerCase() !== approved.receiver ||
          String(message.value) !== approved.amount
        )
          throw Error("TASK_PAYMENT_CHANGED");
        const nonce = hash.parse(message.nonce).toLowerCase();
        // Single SQLite statement is atomic across processes using this DB.
        // Claim before calling ANY signing hook, including the budget guard.
        const claimed = this.db
          .prepare(
            `UPDATE task_payments SET state='payment_uncertain',nonce=?
          WHERE id=? AND state='approved' AND request_digest=?`,
          )
          .run(nonce, id, approved.request_digest);
        if (claimed.changes !== 1)
          throw Error("TASK_ALREADY_ATTEMPTED_RECONCILE_FIRST");
        // Even validation failures stay held: safe false positive, never a new payment.
        return bounded.signTypedData(copy);
      },
    };
  }
  observeResponse(
    id: string,
    status: number,
    body: string,
    reportedTx?: string,
  ) {
    z.number().int().min(100).max(599).parse(status);
    z.string().max(262144).parse(body);
    const tx =
      reportedTx === undefined ? null : hash.parse(reportedTx).toLowerCase();
    const responseDigest = digest(body);
    const row = this.status(id);
    if (row.state === "approved") throw Error("NO_PAYMENT_ATTEMPT");
    if (!row.contract_json)
      throw Error("TASK_HAS_NO_PREAPPROVED_OUTCOME_CONTRACT");
    if (row.state === "response_received") {
      if (
        row.response_digest !== responseDigest ||
        row.http_status !== status ||
        row.settlement_reported !== tx
      )
        throw Error("RESPONSE_EVIDENCE_CONFLICT");
      return row;
    }
    const result = this.db
      .prepare(
        `UPDATE task_payments
      SET state='response_received', response_digest=?, http_status=?, settlement_reported=?, outcome_json=?
      WHERE id=? AND state='payment_uncertain'`,
      )
      .run(
        responseDigest,
        status,
        tx,
        JSON.stringify(
          evaluateOutcome(
            outcomeContractSchema.parse(JSON.parse(row.contract_json)),
            body,
            status,
            Math.floor(Date.now() / 1000),
          ),
        ),
        id,
      );
    if (result.changes !== 1) throw Error("RESPONSE_EVIDENCE_CONFLICT");
    return this.status(id);
  }
  async reconcile(id: string, transaction: string, rpc: PaymentEvidenceReader) {
    const row = this.status(id);
    if (!row.nonce) throw Error("NO_PAYMENT_ATTEMPT");
    const tx = hash.parse(transaction) as Hex;
    if ((await rpc.getChainId()) !== 84532)
      throw Error("EVIDENCE_CHAIN_REJECTED");
    const receipt = await rpc.getTransactionReceipt({ hash: tx });
    if (
      receipt.transactionHash.toLowerCase() !== tx.toLowerCase() ||
      receipt.status !== "success"
    )
      throw Error("EVIDENCE_RECEIPT_REJECTED");
    const canonical = await rpc.getBlock({ blockNumber: receipt.blockNumber });
    const finalized = await rpc.getBlock({ blockTag: "finalized" });
    if (
      !canonical.hash ||
      canonical.hash !== receipt.blockHash ||
      finalized.number === null ||
      finalized.number < receipt.blockNumber
    )
      throw Error("EVIDENCE_NOT_FINALIZED_OR_REORGED");
    let authorization = false,
      transfer = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== TEST_USDC.toLowerCase() || log.removed)
        continue;
      try {
        const event = decodeEventLog({
          abi: paymentEvents,
          data: log.data,
          topics: log.topics,
        });
        if (event.eventName === "AuthorizationUsed")
          authorization ||=
            event.args.authorizer.toLowerCase() === row.payer &&
            event.args.nonce.toLowerCase() === row.nonce;
        if (event.eventName === "Transfer")
          transfer ||=
            event.args.from.toLowerCase() === row.payer &&
            event.args.to.toLowerCase() === row.receiver &&
            String(event.args.value) === row.amount;
      } catch {
        /* An unrelated token event cannot establish payment. */
      }
    }
    if (!authorization || !transfer)
      throw Error("EVIDENCE_DOES_NOT_MATCH_TASK");
    // Read-only recovery. A payment proof never issues another authorization.
    return {
      taskId: id,
      transaction: tx,
      chainId: 84532,
      amount: row.amount,
      requestDigest: row.request_digest,
      responseDigest: row.response_digest,
      acceptanceReport: row.outcome_json
        ? (JSON.parse(row.outcome_json) as ReturnType<typeof evaluateOutcome>)
        : null,
      outcome:
        row.state === "payment_uncertain"
          ? "paid_response_missing"
          : row.http_status !== null &&
              row.http_status >= 200 &&
              row.http_status < 300
            ? "paid_response_observed"
            : "paid_http_error_observed",
      usefulDeliveryVerified: false,
      evidence: "finalized_receipt_from_owner_selected_rpc",
      canAuthorizeAgain: false,
    } as const;
  }
}

/** Trusted-host integration: agents may request an existing owner-approved ID;
 * they cannot supply signing callbacks, approve IDs or change the stored intent.
 * No additional headers, alternate paths or request bodies are forwarded. */
export async function payApprovedTask(
  ledger: TaskPayments,
  budget: PaymentBudget,
  id: string,
  request: TaskRequest,
  testKeyFile: string,
) {
  const snapshot = requestSchema.parse(request);
  const approval = ledger.assertRequest(id, snapshot);
  const paid = await buyerFetch(
    new URL(snapshot.url).origin,
    approval.receiver,
    testKeyFile,
    undefined,
    (raw) => ledger.guard(id, snapshot, budget, raw),
  );
  const response = await paid(snapshot.url, {
    method: snapshot.method,
    headers: { "content-type": "application/json" },
    body: snapshot.body,
  });
  // Bound response capture. No response or authorization contents are persisted.
  const reader = response.body?.getReader();
  let body = "",
    bytes = 0;
  const decoder = new TextDecoder();
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 262144) throw Error("RESPONSE_TOO_LARGE");
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel();
    }
  }
  if (ledger.status(id).state !== "approved")
    ledger.observeResponse(id, response.status, body);
  return { status: response.status, body, payment: ledger.status(id) };
}
