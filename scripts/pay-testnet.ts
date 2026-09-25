import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { example } from "../src/discovery.js";
import {
  requestSchema,
  responseSchema,
  address,
} from "../src/schemas/index.js";
import { verifyCertificate } from "../src/core/certificate.js";
import { NETWORKS } from "../src/config.js";
import { buyerFetch, serviceOrigin } from "./client.js";
import { smoke } from "./smoke.js";
const [url, payTo, attestor, keyFile] = process.argv.slice(2);
if (!url || !payTo || !attestor || !keyFile)
  throw new Error(
    "Usage: npm run pay:testnet -- SERVICE_URL EXPECTED_PAY_TO EXPECTED_ATTESTOR work/test-payer.key",
  );
const origin = serviceOrigin(url);
address.parse(payTo);
address.parse(attestor);
await smoke(origin, payTo, attestor);
let paymentSignature: string | undefined;
const paid = await buyerFetch(origin, payTo, keyFile, (signature) => {
    paymentSignature = signature;
  }),
  request = requestSchema.parse(example);
const res = await paid(origin + "/v1/certify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(request),
});
assert.equal(
  res.status,
  200,
  "Paid check failed; do not retry blindly after an indeterminate settlement",
);
const receipt = JSON.parse(atob(res.headers.get("PAYMENT-RESPONSE") ?? "")) as {
  success: boolean;
  simulated?: boolean;
  transaction: string;
  network: string;
  payer?: string;
};
assert.equal(receipt.success, true);
assert(!receipt.simulated);
assert.equal(receipt.network, "eip155:84532");
assert.match(receipt.transaction, /^0x[0-9a-fA-F]{64}$/);
type ReplayEvidence = {
  variant: "same-body" | "changed-body";
  status: "pending" | "passed" | "failed";
  httpStatus?: number;
  responseWasJson?: boolean;
  certificateReturned?: boolean;
  cachedOriginal?: boolean;
};
const evidence: {
  at: string;
  service: string;
  receipt: { success: true; transaction: string; network: string };
  paymentConfirmed: boolean;
  certificateVerified: boolean;
  certificate?: unknown;
  chainBlock?: string;
  replayChecks: ReplayEvidence[];
  verified: boolean;
} = {
  at: new Date().toISOString(),
  service: origin,
  // Persist public settlement identifiers only, never arbitrary response fields.
  receipt: {
    success: true,
    transaction: receipt.transaction,
    network: receipt.network,
  },
  paymentConfirmed: false,
  certificateVerified: false,
  replayChecks: [],
  verified: false,
};
await mkdir("work", { recursive: true });
const saveEvidence = () =>
  writeFile("work/testnet-evidence.json", JSON.stringify(evidence, null, 2));
// Save the first settlement identifier before any further assertions. If a later
// check fails, inspect this payment instead of creating another authorization.
await saveEvidence();
const result = responseSchema.parse(await res.json());
assert(result.certificate);
evidence.certificate = result.certificate;
await saveEvidence();
assert(
  (
    await verifyCertificate(
      result.certificate,
      request,
      attestor as Address,
      origin,
    )
  ).valid,
);
const online = await fetch(origin + "/v1/certificate/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ request, certificate: result.certificate }),
  redirect: "error",
  signal: AbortSignal.timeout(20000),
});
assert.equal(online.status, 200);
assert.equal(((await online.json()) as { valid: boolean }).valid, true);
assert(
  !(
    await verifyCertificate(
      result.certificate,
      request,
      attestor as Address,
      origin,
      result.certificate.expiresAt,
    )
  ).valid,
);
evidence.certificateVerified = true;
await saveEvidence();
const rpc = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org", {
    timeout: 15000,
    retryCount: 0,
  }),
});
const chainReceipt = await rpc.waitForTransactionReceipt({
  hash: receipt.transaction as Hex,
  timeout: 60000,
});
assert.equal(chainReceipt.status, "success");
const { parseEventLogs } = await import("viem");
const transfers = parseEventLogs({
  abi: [
    parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ),
  ],
  logs: chainReceipt.logs,
});
assert(
  transfers.some(
    (log) =>
      log.address.toLowerCase() ===
        NETWORKS["eip155:84532"].usdc.toLowerCase() &&
      log.args.to.toLowerCase() === payTo.toLowerCase() &&
      log.args.value === 10000n,
  ),
  "No matching 0.01 test USDC transfer to pinned treasury",
);
evidence.paymentConfirmed = true;
evidence.chainBlock = chainReceipt.blockNumber.toString();
await saveEvidence();

assert(
  paymentSignature,
  "Payment confirmed but no authorization captured; inspect work/testnet-evidence.json before any new payment",
);
const signature = paymentSignature;
const changedRequest = requestSchema.parse({
  ...request,
  transaction: { ...request.transaction, value: "999" },
});
for (const [variant, replayRequest] of [
  ["same-body", request],
  ["changed-body", changedRequest],
] as const) {
  const check: ReplayEvidence = { variant, status: "pending" };
  evidence.replayChecks.push(check);
  await saveEvidence();
  try {
    // Raw fetch is intentional: a 402 must not generate a new payment.
    const replay = await fetch(origin + "/v1/certify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": signature,
      },
      body: JSON.stringify(replayRequest),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    check.httpStatus = replay.status;
    let body: unknown;
    try {
      body = await replay.json();
      check.responseWasJson = true;
    } catch {
      check.responseWasJson = false;
    }
    check.certificateReturned =
      typeof body === "object" &&
      body !== null &&
      "certificate" in body &&
      body.certificate !== null &&
      body.certificate !== undefined;
    check.cachedOriginal =
      variant === "same-body" &&
      replay.status === 200 &&
      replay.headers.get("X-Korp-Idempotent-Replay") === "true" &&
      JSON.stringify(body) === JSON.stringify(result);
    check.status =
      check.cachedOriginal ||
      ([402, 409].includes(replay.status) &&
        check.responseWasJson &&
        !check.certificateReturned)
        ? "passed"
        : "failed";
    await saveEvidence();
    assert.equal(
      check.status,
      "passed",
      `Replay validation ${variant} failed (HTTP ${replay.status}); first payment is confirmed in work/testnet-evidence.json. Do not pay again to retry this check.`,
    );
  } catch (error) {
    check.status = "failed";
    await saveEvidence();
    throw error;
  }
}
const extensionHeader = res.headers.get("EXTENSION-RESPONSES");
if (extensionHeader) {
  const ext = JSON.parse(atob(extensionHeader));
  assert.notEqual(ext.bazaar?.status, "rejected");
}
evidence.verified = true;
await saveEvidence();
console.log(
  JSON.stringify(
    {
      status: "PASS",
      transaction: receipt.transaction,
      explorer: "https://sepolia.basescan.org/tx/" + receipt.transaction,
      evidence: "work/testnet-evidence.json",
      replay:
        "same-body recovered or rejected; changed-body rejected; no second payment",
      discovery:
        "Run npm run discover separately; settlement alone does not prove listing.",
    },
    null,
    2,
  ),
);
