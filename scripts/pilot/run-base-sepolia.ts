import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import {
  createPublicClient,
  http,
  parseAbiItem,
  parseEventLogs,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { buyerFetch } from "../client.js";
import { PaymentBudget, TEST_USDC } from "./payment-budget.js";
import { example } from "../../src/discovery.js";
import { responseSchema } from "../../src/schemas/index.js";
import { verifyCertificate } from "../../src/core/certificate.js";

// Fixed public test service and test USDC only. This is not a mainnet client.
const service = "https://korp-txcert-sepolia.mute-cell-557f.workers.dev";
const receiver = "0xC7a0E085544c116dDf9f996108c553eeCE62E443";
const attestor = "0xe67BC8514160Bc426684f48926cc0096524fe14f";
const [keyFile, directory] = process.argv.slice(2);
if (!keyFile || !directory)
  throw Error(
    "Usage: npm run pilot:testnet -- TEST_PAYER_KEY_FILE NEW_EVIDENCE_DIRECTORY",
  );
await mkdir(directory, { recursive: true, mode: 0o700 });
const configFile = join(directory, "owner-budget.json");
try {
  await access(configFile);
  throw Error(
    "RUN_ALREADY_EXISTS: inspect evidence; never blindly restart a paid run",
  );
} catch (e) {
  if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT"))
    throw e;
}
const payer = privateKeyToAccount(
  (await readFile(keyFile, "utf8")).trim() as Hex,
).address;
const now = Math.floor(Date.now() / 1000);
const config = {
  payer,
  receiver,
  limit: "20000",
  perPayment: "10000",
  startsAt: now - 1,
  endsAt: now + 3600,
};
await writeFile(configFile, JSON.stringify(config, null, 2), {
  flag: "wx",
  mode: 0o600,
});
const dbPath = join(directory, "budget.sqlite");
let budget = new PaymentBudget(dbPath, config),
  sentAuthorizations = 0;
const rpc = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org", {
    timeout: 15000,
    retryCount: 0,
  }),
});
const evidence: {
  at: string;
  mode: string;
  status: string;
  payments: unknown[];
  reserved: string;
  sentAuthorizations: number;
  blockedBeforePayment: boolean;
  blockedAfterRestart: boolean;
} = {
  at: new Date().toISOString(),
  mode: "operator-test; Base Sepolia; no real money",
  status: "running",
  payments: [],
  reserved: "0",
  sentAuthorizations: 0,
  blockedBeforePayment: false,
  blockedAfterRestart: false,
};
const save = async () => {
  evidence.reserved = budget.reserved();
  evidence.sentAuthorizations = sentAuthorizations;
  await writeFile(
    join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
};
const client = () =>
  buyerFetch(
    service,
    receiver,
    keyFile,
    () => {
      sentAuthorizations++;
    },
    (signer) => budget.guard(signer),
  );
const call = async (index: number) => {
  const request = structuredClone(example);
  request.transaction.nonce = String(index);
  const paid = await client();
  return {
    request,
    response: await paid(service + "/v1/certify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  };
};
try {
  assert.equal(await rpc.getChainId(), 84532);
  for (let i = 0; i < 2; i++) {
    const { request, response } = await call(i);
    const header = response.headers.get("PAYMENT-RESPONSE");
    const receipt = header ? JSON.parse(atob(header)) : null;
    // Save public settlement identifiers BEFORE assertions; never save authorization headers.
    const record = {
      httpStatus: response.status,
      transaction:
        typeof receipt?.transaction === "string" ? receipt.transaction : null,
      certificateVerified: false,
      onchainConfirmed: false,
    };
    evidence.payments.push(record);
    await save();
    assert.equal(
      response.status,
      200,
      "Stop and inspect saved receipt before any retry",
    );
    assert(
      receipt?.success &&
        receipt.network === "eip155:84532" &&
        /^0x[0-9a-fA-F]{64}$/.test(receipt.transaction),
    );
    const result = responseSchema.parse(await response.json());
    assert(
      (await verifyCertificate(result.certificate, request, attestor, service))
        .valid,
    );
    record.certificateVerified = true;
    await save();
    const confirmed = await rpc.waitForTransactionReceipt({
      hash: receipt.transaction,
      timeout: 60000,
    });
    assert.equal(confirmed.status, "success");
    const transfers = parseEventLogs({
      abi: [
        parseAbiItem(
          "event Transfer(address indexed from, address indexed to, uint256 value)",
        ),
      ],
      logs: confirmed.logs,
    });
    assert(
      transfers.some(
        (l) =>
          l.address.toLowerCase() === TEST_USDC.toLowerCase() &&
          l.args.from.toLowerCase() === payer.toLowerCase() &&
          l.args.to.toLowerCase() === receiver.toLowerCase() &&
          l.args.value === 10000n,
      ),
    );
    record.onchainConfirmed = true;
    await save();
  }
  const before = sentAuthorizations;
  await assert.rejects(() => call(2), /BUDGET_EXCEEDED/);
  assert.equal(sentAuthorizations, before);
  evidence.blockedBeforePayment = true;
  await save();
  budget.close();
  budget = new PaymentBudget(dbPath, config);
  await assert.rejects(() => call(3), /BUDGET_EXCEEDED/);
  assert.equal(sentAuthorizations, before);
  assert.equal(budget.reserved(), "20000");
  evidence.blockedAfterRestart = true;
  evidence.status = "PASS";
  await save();
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.status = "STOPPED_INSPECT_RECEIPTS";
  await save();
  throw error;
} finally {
  budget.close();
}
