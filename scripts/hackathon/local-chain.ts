import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createTestClient,
  http,
  keccak256,
  toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/index.js";
import { example } from "../../src/discovery.js";
import { requestSchema, type Certificate } from "../../src/schemas/index.js";
import { policyHash } from "../../src/core/canonicalize.js";
import {
  typedOwnerPolicy,
  ownerApprovalDigest,
} from "../../src/core/owner-policy.js";
import { BudgetStore } from "./budget-store.js";
import { signWithBudget } from "./budget-signer.js";

// No configurable remote RPC: this harness can only talk to its own loopback Anvil.
const require = createRequire(import.meta.url);
const arch = process.arch === "x64" ? "amd64" : process.arch;
const platform = process.platform;
const binary = join(
  dirname(
    require.resolve(`@foundry-rs/anvil-${platform}-${arch}/package.json`),
  ),
  "bin",
  platform === "win32" ? "anvil.exe" : "anvil",
);
const port = 19000 + Math.floor(Math.random() * 10000);
const endpoint = `http://127.0.0.1:${port}`;
const node = spawn(
  binary,
  [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--chain-id",
    "84532",
    "--accounts",
    "0",
    "--silent",
  ],
  { stdio: "ignore" },
);
let startupError: Error | undefined;
node.on("error", (e) => {
  startupError = e;
});
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(endpoint, { retryCount: 0, timeout: 1000 }),
});
const test = createTestClient({
  chain: baseSepolia,
  mode: "anvil",
  transport: http(endpoint, { retryCount: 0 }),
});
let store: BudgetStore | undefined;
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (startupError) throw startupError;
    if (node.exitCode !== null) throw new Error("LOCAL_NODE_EXITED");
    try {
      assert.equal(await client.getChainId(), 84532);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert(ready, "Local EVM startup failed");
  const owner = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const attestorKey = generatePrivateKey();
  const attestor = privateKeyToAccount(attestorKey);
  await test.setBalance({ address: agent.address, value: 10n ** 18n });
  const now = Math.floor(Date.now() / 1000),
    service = "http://127.0.0.1:8787";
  const base = requestSchema.parse({ ...example, from: agent.address });
  base.transaction.to = recipient;
  base.transaction.data = "0x";
  base.policy.expectedAction = "native-transfer";
  base.policy.allowedRecipients = [recipient];
  base.policy.maxNativeValueWei = "60";
  const authorization = {
    version: 1 as const,
    policyId: keccak256(toHex("local-evm")),
    revision: "1",
    owner: owner.address,
    agent: agent.address,
    chainId: 84532 as const,
    service,
    attestor: attestor.address,
    policyHash: policyHash(base.policy),
    validAfter: now - 1,
    validUntil: now + 3600,
  };
  const approval = {
    authorization,
    policy: base.policy,
    signature: await owner.signTypedData(typedOwnerPolicy(authorization)),
  };
  const trust = {
    owner: owner.address,
    agent: agent.address,
    chainId: 84532 as const,
    service,
    attestor: attestor.address,
    approvalDigest: ownerApprovalDigest(authorization),
  };
  const config = {
    id: "local-evm-budget",
    chainId: 84532 as const,
    agent: agent.address,
    asset: "native" as const,
    limit: "100",
    startsAt: now - 1,
    endsAt: now + 3600,
  };
  const db = join(mkdtempSync(join(tmpdir(), "korp-evm-")), "budget.sqlite");
  store = new BudgetStore(db, config);
  const paymentToken = toHex(randomBytes(32));
  const env = {
    ENVIRONMENT: "local",
    NETWORK: "eip155:84532",
    ENABLE_MAINNET: "false",
    X402_MODE: "development",
    SERVICE_URL: service,
    PAY_TO_ADDRESS: owner.address,
    ATTESTOR_PRIVATE_KEY: attestorKey,
    DEVELOPMENT_PAYMENT_TOKEN: paymentToken,
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
    TX_CHECK_PRICE: "0.01",
  };
  const app = createApp({ now: () => now });
  const receipts: { hash: string; block: string; status: string }[] = [];
  let signCalls = 0;
  async function pay(amount: string) {
    const request = structuredClone(base);
    request.transaction.value = amount;
    request.transaction.nonce = String(
      await client.getTransactionCount({
        address: agent.address,
        blockTag: "pending",
      }),
    );
    const response = await app.fetch(
      new Request(service + "/v1/certify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Korp-Development-Payment": paymentToken,
        },
        body: JSON.stringify(request),
      }),
      env,
    );
    assert.equal(response.status, 200);
    const { certificate } = (await response.json()) as {
      certificate: Certificate;
    };
    const serializedTransaction = await signWithBudget(
      { request, certificate, approval },
      trust,
      store!,
      {
        pendingNonce: async () =>
          String(
            await client.getTransactionCount({
              address: agent.address,
              blockTag: "pending",
            }),
          ),
        sign: async (r) => {
          signCalls++;
          return agent.signTransaction({
            chainId: 84532,
            to: r.transaction.to as `0x${string}`,
            data: r.transaction.data as `0x${string}`,
            value: BigInt(r.transaction.value),
            nonce: Number(r.transaction.nonce),
            gas: 21000n,
            maxFeePerGas: 2000000000n,
            maxPriorityFeePerGas: 1000000n,
            type: "eip1559",
          });
        },
      },
      () => now,
    );
    const hash = await client.sendRawTransaction({ serializedTransaction });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    receipts.push({
      hash,
      block: String(receipt.blockNumber),
      status: receipt.status,
    });
  }
  await pay("30");
  await pay("30");
  await assert.rejects(pay("50"), /BUDGET_EXCEEDED/);
  store.close();
  store = new BudgetStore(db, config);
  await assert.rejects(pay("50"), /BUDGET_EXCEEDED/);
  assert.equal(await client.getBalance({ address: recipient }), 60n);
  assert.equal(await client.getTransactionCount({ address: agent.address }), 2);
  assert.equal(signCalls, 2);
  assert.equal(store.reserved(), "60");
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "LOCAL_EVM",
    status: "PASS",
    realFundsMoved: "0",
    asset: "simulated native wei",
    certificateSource:
      "Actual Hono /v1/certify handler with development payment",
    chainState: "Isolated Anvil, Sepolia chain ID; not public Sepolia",
    recipientBalance: "60",
    reserved: store.reserved(),
    overspendRejectedBeforeSigning: true,
    restartOverspendRejected: true,
    receipts,
    limitations: [
      "No public testnet settlement",
      "No x402 facilitator payment",
      "Native transfers only in this integration",
      "Not audited; gas excluded from spend budget",
    ],
  };
  writeFileSync(
    new URL("../../docs/hackathon/local-chain-results.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  store?.close();
  node.kill("SIGTERM");
}
