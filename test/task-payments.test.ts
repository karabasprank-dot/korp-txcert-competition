import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  encodeEventTopics,
  encodeAbiParameters,
  parseAbi,
  type Hex,
} from "viem";
import type { ClientEvmSigner } from "@x402/evm";
import {
  PaymentBudget,
  TEST_USDC,
  paymentTypes,
} from "../scripts/pilot/payment-budget.js";
import {
  TaskPayments,
  payApprovedTask,
  type PaymentEvidenceReader,
} from "../scripts/pilot/task-payments.js";
import { buyerFetch } from "../scripts/client.js";
vi.mock("../scripts/client.js", () => ({ buyerFetch: vi.fn() }));
const payer = "0x2222222222222222222222222222222222222222";
const receiver = "0x3333333333333333333333333333333333333333";
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const request = {
  url: "https://example.com/v1/certify",
  method: "POST" as const,
  body: '{"private":"task-input"}',
};
const approval = {
  id: "invoice-123",
  request,
  payer,
  receiver,
  amount: "10000",
};
const config = {
  payer,
  receiver,
  limit: "100000",
  perPayment: "10000",
  startsAt: 100,
  endsAt: 300,
};
const input = (n = 1) => ({
  domain: {
    name: "USDC",
    version: "2",
    chainId: 84532,
    verifyingContract: TEST_USDC,
  },
  types: paymentTypes,
  primaryType: "TransferWithAuthorization",
  message: {
    from: payer,
    to: receiver,
    value: 10000n,
    validAfter: 0n,
    validBefore: 160n,
    nonce: hex(n),
  },
});
const signer = () =>
  ({
    address: payer,
    signTypedData: vi.fn(async () => "0x1234" as const),
  }) satisfies ClientEvmSigner;
function setup(path = ":memory:") {
  const ledger = new TaskPayments(path),
    budget = new PaymentBudget(":memory:", config),
    raw = signer();
  ledger.approve(approval);
  return {
    ledger,
    budget,
    raw,
    guard: ledger.guard(approval.id, request, budget, raw, () => 101),
  };
}
const events = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
function receipt() {
  return {
    transactionHash: hex(10),
    status: "success",
    blockNumber: 20n,
    blockHash: hex(20),
    logs: [
      {
        address: TEST_USDC,
        removed: false,
        data: "0x",
        topics: encodeEventTopics({
          abi: events,
          eventName: "AuthorizationUsed",
          args: { authorizer: payer, nonce: hex(1) },
        }),
      },
      {
        address: TEST_USDC,
        removed: false,
        data: encodeAbiParameters([{ type: "uint256" }], [10000n]),
        topics: encodeEventTopics({
          abi: events,
          eventName: "Transfer",
          args: { from: payer, to: receiver },
        }),
      },
    ],
  };
}
function reader(
  r = receipt(),
  chain = 84532,
  canonical = hex(20),
  finalized = 25n,
) {
  return {
    getChainId: vi.fn(async () => chain),
    getTransactionReceipt: vi.fn(async () => r),
    getBlock: vi.fn(async (arg: { blockTag?: string }) =>
      arg.blockTag
        ? { number: finalized, hash: hex(25) }
        : { number: 20n, hash: canonical },
    ),
  } as unknown as PaymentEvidenceReader;
}
describe("owner-approved task payments", () => {
  it("allows one authorization across connections, fresh nonces and restart despite unused budget", async () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "korp-task-")),
      "tasks.sqlite",
    );
    const { ledger, budget, raw, guard } = setup(file),
      other = new TaskPayments(file);
    const otherGuard = other.guard(
      approval.id,
      request,
      budget,
      raw,
      () => 101,
    );
    const results = await Promise.allSettled([
      guard.signTypedData(input(1)),
      otherGuard.signTypedData(input(2)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(raw.signTypedData).toHaveBeenCalledTimes(1);
    expect(budget.reserved()).toBe("10000");
    ledger.close();
    other.close();
    const restarted = new TaskPayments(file);
    restarted.approve(approval);
    expect(() =>
      restarted.guard(approval.id, request, budget, raw, () => 102),
    ).toThrow("TASK_ALREADY_ATTEMPTED");
    expect(restarted.status(approval.id).state).toBe("payment_uncertain");
    restarted.close();
    budget.close();
    expect(readFileSync(file).includes(Buffer.from("task-input"))).toBe(false);
    expect(readFileSync(file).includes(Buffer.from("0x1234"))).toBe(false);
  });
  it("requires owner approval and rejects changed intent and quote before raw signing", async () => {
    const { ledger, budget, raw, guard } = setup();
    expect(() => ledger.assertRequest("invented-id", request)).toThrow(
      "TASK_NOT_APPROVED",
    );
    for (const change of [
      { body: "{}" },
      { url: "https://elsewhere.com/v1/certify" },
    ])
      expect(() =>
        ledger.guard(
          approval.id,
          { ...request, ...change },
          budget,
          raw,
          () => 101,
        ),
      ).toThrow("TASK_REQUEST_CHANGED");
    for (const change of [
      { amount: "20000" },
      { receiver: payer },
      { request: { ...request, body: "{}" } },
    ])
      expect(() => ledger.approve({ ...approval, ...change })).toThrow();
    for (const change of [{ to: payer }, { from: receiver }, { value: 20000n }])
      await expect(
        guard.signTypedData({
          ...input(),
          message: { ...input().message, ...change },
        }),
      ).rejects.toThrow("TASK_PAYMENT_CHANGED");
    expect(raw.signTypedData).not.toHaveBeenCalled();
    expect(ledger.status(approval.id).state).toBe("approved");
    ledger.close();
    budget.close();
  });
  it("holds uncertain signing failures, including the next authorization from the same closure", async () => {
    const { ledger, budget, raw, guard } = setup();
    raw.signTypedData.mockRejectedValueOnce(Error("SIGNER_TIMEOUT"));
    await expect(guard.signTypedData(input())).rejects.toThrow(
      "SIGNER_TIMEOUT",
    );
    await expect(guard.signTypedData(input(2))).rejects.toThrow(
      "TASK_ALREADY_ATTEMPTED",
    );
    expect(raw.signTypedData).toHaveBeenCalledTimes(1);
    expect(budget.reserved()).toBe("10000");
    ledger.close();
    budget.close();
  });
  it("keeps mainnet rejected by the underlying guard and conservatively holds task", async () => {
    const { ledger, budget, raw, guard } = setup();
    await expect(
      guard.signTypedData({
        ...input(),
        domain: { ...input().domain, chainId: 8453 },
      }),
    ).rejects.toThrow();
    expect(raw.signTypedData).not.toHaveBeenCalled();
    expect(budget.reserved()).toBe("0");
    expect(ledger.status(approval.id).state).toBe("payment_uncertain");
    ledger.close();
    budget.close();
  });
  it("records response hashes without treating merchant reports as settlement or useful delivery", async () => {
    const { ledger, budget, guard } = setup();
    expect(() => ledger.observeResponse(approval.id, 200, "ok")).toThrow(
      "NO_PAYMENT_ATTEMPT",
    );
    await guard.signTypedData(input());
    ledger.observeResponse(approval.id, 200, "private result", hex(999));
    expect(ledger.status(approval.id).settlement_reported).toBe(hex(999));
    expect(() => ledger.observeResponse(approval.id, 200, "different")).toThrow(
      "RESPONSE_EVIDENCE_CONFLICT",
    );
    const proof = await ledger.reconcile(approval.id, hex(10), reader());
    expect(proof.outcome).toBe("paid_response_observed");
    expect(proof.usefulDeliveryVerified).toBe(false);
    expect(proof.canAuthorizeAgain).toBe(false);
    ledger.close();
    budget.close();
  });
  it("identifies a finalized payment with lost response or error response", async () => {
    const { ledger, budget, guard } = setup();
    await guard.signTypedData(input());
    expect(
      (await ledger.reconcile(approval.id, hex(10), reader())).outcome,
    ).toBe("paid_response_missing");
    ledger.observeResponse(approval.id, 503, "unavailable");
    expect(
      (await ledger.reconcile(approval.id, hex(10), reader())).outcome,
    ).toBe("paid_http_error_observed");
    expect(ledger.status(approval.id).state).toBe("response_received");
    ledger.close();
    budget.close();
  });
  it("rejects wrong chain, tx, reorg, nonfinalized receipt, unrelated payment and RPC failure", async () => {
    const { ledger, budget, guard } = setup();
    await guard.signTypedData(input());
    const noNonce = receipt();
    noNonce.logs.shift();
    const noTransfer = receipt();
    noTransfer.logs.pop();
    const wrongToken = receipt();
    wrongToken.logs.forEach((l) => (l.address = receiver));
    const wrongAmount = receipt();
    wrongAmount.logs[1]!.data = encodeAbiParameters(
      [{ type: "uint256" }],
      [20000n],
    );
    const wrongNonce = receipt();
    wrongNonce.logs[0]!.topics = encodeEventTopics({
      abi: events,
      eventName: "AuthorizationUsed",
      args: { authorizer: payer, nonce: hex(2) },
    });
    const removed = receipt();
    removed.logs.forEach((l) => (l.removed = true));
    for (const rpc of [
      reader(receipt(), 8453),
      reader({ ...receipt(), transactionHash: hex(11) }),
      reader({ ...receipt(), status: "reverted" }),
      reader(receipt(), 84532, hex(21)),
      reader(receipt(), 84532, hex(20), 19n),
      ...[
        noNonce,
        noTransfer,
        wrongToken,
        wrongAmount,
        wrongNonce,
        removed,
      ].map((r) => reader(r)),
    ])
      await expect(
        ledger.reconcile(approval.id, hex(10), rpc),
      ).rejects.toThrow();
    const down = reader();
    vi.mocked(down.getTransactionReceipt).mockRejectedValueOnce(
      Error("RPC_DOWN"),
    );
    await expect(ledger.reconcile(approval.id, hex(10), down)).rejects.toThrow(
      "RPC_DOWN",
    );
    expect(ledger.status(approval.id).state).toBe("payment_uncertain");
    ledger.close();
    budget.close();
  });
  it("pins the actual HTTP request and wires the task guard into the payment client", async () => {
    const { ledger, budget: initialBudget, raw } = setup();
    initialBudget.close();
    const now = Math.floor(Date.now() / 1000);
    const budget = new PaymentBudget(":memory:", {
      ...config,
      startsAt: now - 1,
      endsAt: now + 100,
    });
    const actual = vi.fn(async (url, init) => {
      expect(url).toBe(request.url);
      expect(init.body).toBe(request.body);
      return new Response("result", { status: 200 });
    });
    vi.mocked(buyerFetch).mockImplementationOnce(
      async (_origin, _receiver, _file, _observe, wrap) => {
        expect(wrap).toBeTypeOf("function");
        const bounded = wrap!(raw);
        await bounded.signTypedData({
          ...input(),
          message: { ...input().message, validBefore: BigInt(now + 30) },
        });
        return actual;
      },
    );
    const result = await payApprovedTask(
      ledger,
      budget,
      approval.id,
      request,
      "unused-test-path",
    );
    expect(result.payment.state).toBe("response_received");
    expect(raw.signTypedData).toHaveBeenCalledTimes(1);
    await expect(
      payApprovedTask(ledger, budget, approval.id, request, "unused-test-path"),
    ).rejects.toThrow("TASK_ALREADY_ATTEMPTED");
    expect(actual).toHaveBeenCalledTimes(1);
    ledger.close();
    budget.close();
  });
  it("binds acceptance requirements before payment and records a failed 200 response", async () => {
    const { ledger, budget, raw } = setup();
    const contract = {
      version: 1 as const,
      statuses: [200],
      rules: [{ kind: "equals" as const, path: ["chainId"], value: 84532 }],
    };
    const id = "quote-job";
    ledger.approve({ ...approval, id, contract });
    await ledger
      .guard(id, request, budget, raw, () => 101)
      .signTypedData(input());
    expect(() =>
      ledger.approve({
        ...approval,
        id,
        contract: {
          ...contract,
          rules: [{ kind: "equals", path: ["chainId"], value: 1 }],
        },
      }),
    ).toThrow("TASK_APPROVAL_CHANGED");
    ledger.observeResponse(id, 200, '{"chainId":1}');
    const report = await ledger.reconcile(id, hex(10), reader());
    expect(report.acceptanceReport?.decision).toBe("checks_failed");
    expect(report.usefulDeliveryVerified).toBe(false);
    ledger.close();
    budget.close();
  });
});
