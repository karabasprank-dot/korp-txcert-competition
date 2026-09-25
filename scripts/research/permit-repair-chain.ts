import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  toHex,
  verifyTypedData,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  permitBatchTypedData,
  type ExposurePermit,
  type PermitExposureInput,
} from "../../src/research/permit-exposure.js";
import {
  checkRepairSnapshot,
  planPermitRepair,
  verifyPermitRepair,
} from "../../src/research/permit-repair.js";

// Only the loopback Anvil instance below is reachable. No RPC configuration,
// saved wallet, real account, external provider, or public transaction is used.
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const reference = join(root, "scripts/research/permit2-reference");
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ) + "\n";
const provenance = JSON.parse(
  readFileSync(join(reference, "provenance.json"), "utf8"),
) as {
  repositories: Record<string, { repository: string; revision: string }>;
  files: Record<string, { sha256: string; url: string; gitBlobSha1: string }>;
};
const sources: Record<string, { content: string }> = {};
for (const [path, metadata] of Object.entries(provenance.files).sort()) {
  assert.equal(
    sha256(readFileSync(join(reference, path))),
    metadata.sha256,
    `Changed official source: ${path}`,
  );
  if (path.endsWith(".sol"))
    sources[path] = { content: readFileSync(join(reference, path), "utf8") };
}
type ContractArtifact = { abi: Abi; evm: { bytecode: { object: string } } };
const artifactBytes = readFileSync(join(reference, "compiled.json"));
const artifacts = JSON.parse(
  readFileSync(join(reference, "compiled.json"), "utf8"),
) as {
  sourceBundleSha256: string;
  compiler: { version: string; soljsonSha256: string };
  settings: unknown;
  contracts: Record<string, ContractArtifact>;
};
assert.equal(artifacts.sourceBundleSha256, sha256(JSON.stringify(sources)));
assert(artifacts.compiler.version.startsWith("0.8.17+commit.8df45f5f"));

const arch = process.arch === "x64" ? "amd64" : process.arch;
const binary = join(
  dirname(
    require.resolve(
      `@foundry-rs/anvil-${process.platform}-${arch}/package.json`,
    ),
  ),
  "bin",
  process.platform === "win32" ? "anvil.exe" : "anvil",
);
const port = 30000 + Math.floor(Math.random() * 10000);
const endpoint = `http://127.0.0.1:${port}`;
const node = spawn(
  binary,
  [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--chain-id",
    "31337",
    "--accounts",
    "0",
    "--silent",
  ],
  { stdio: "ignore" },
);
let startupError: Error | undefined;
node.on("error", (error) => {
  startupError = error;
});
const transport = http(endpoint, { retryCount: 0, timeout: 3000 });
const client = createPublicClient({
  chain: foundry,
  transport,
  pollingInterval: 25,
});
const test = createTestClient({ chain: foundry, transport, mode: "anvil" });
const freshAccount = () => privateKeyToAccount(generatePrivateKey());
type Signer = ReturnType<typeof freshAccount>;
const receipts: {
  label: string;
  from: Address;
  to: Address;
  calldata: Hex;
  expectedError?: string;
  revertData?: string;
  receipt: TransactionReceipt;
}[] = [];
const deployments: unknown[] = [];
const permitAbi = parseAbi([
  "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permitBatch, bytes signature)",
  "function transferFrom((address from, address to, uint160 amount, address token)[] transferDetails)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function invalidateNonces(address token, address spender, uint48 newNonce)",
  "function lockdown((address token, address spender)[] approvals)",
]);
const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
async function transact(
  label: string,
  signer: Signer,
  to: Address,
  calldata: Hex,
  expectedError?: string,
) {
  const wallet = createWalletClient({
    account: signer,
    chain: foundry,
    transport,
  });
  // Fixed gas bypasses estimation so expected failures become mined receipts.
  const hash = await wallet.sendTransaction({
    to,
    data: calldata,
    gas: 3_000_000n,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, expectedError ? "reverted" : "success", label);
  let revertData: string | undefined;
  if (expectedError) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "debug_traceTransaction",
        params: [
          hash,
          { disableMemory: true, disableStorage: true, disableStack: true },
        ],
      }),
    });
    const trace = (await response.json()) as {
      result?: { returnValue: string };
      error?: unknown;
    };
    assert(
      !trace.error && trace.result,
      "Failed transaction trace unavailable",
    );
    revertData = trace.result.returnValue.startsWith("0x")
      ? trace.result.returnValue
      : `0x${trace.result.returnValue}`;
    assert.equal(
      revertData.slice(0, 10),
      keccak256(toHex(expectedError)).slice(0, 10),
      label,
    );
  }
  receipts.push({
    label,
    from: signer.address,
    to,
    calldata,
    expectedError,
    revertData,
    receipt,
  });
  return hash;
}

try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (startupError) throw startupError;
    assert.equal(node.exitCode, null, "Anvil exited");
    try {
      assert.equal(await client.getChainId(), 31337);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(ready, "Loopback Anvil did not start");
  const deployer = freshAccount(),
    spender = freshAccount();
  for (const account of [deployer, spender])
    await test.setBalance({ address: account.address, value: 10n ** 20n });
  const deployerWallet = createWalletClient({
    chain: foundry,
    account: deployer,
    transport,
  });
  async function deploy(name: string, args: readonly unknown[] = []) {
    const artifact = artifacts.contracts[name]!;
    const bytecode = `0x${artifact.evm.bytecode.object}` as Hex;
    const hash = await deployerWallet.deployContract({
      abi: artifact.abi,
      bytecode,
      args,
      gas: 5_000_000n,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert(receipt.contractAddress);
    const runtimeBytecode = await client.getBytecode({
      address: receipt.contractAddress,
    });
    assert(runtimeBytecode && runtimeBytecode !== "0x");
    deployments.push({
      name,
      address: receipt.contractAddress,
      receipt,
      creationBytecodeKeccak256: keccak256(bytecode),
      runtimeBytecodeKeccak256: keccak256(runtimeBytecode),
      runtimeBytecode,
    });
    return receipt.contractAddress;
  }
  const permit2 = await deploy("AllowanceTransfer");
  const tokens = {} as Record<"X" | "Y" | "Z", Address>;
  for (const symbol of ["X", "Y", "Z"] as const)
    tokens[symbol] = await deploy("MockERC20", [
      `Fake repair ${symbol}`,
      symbol,
      0,
    ]);
  const domain = { chainId: 31337, verifyingContract: permit2 };
  const timestamp = Number((await client.getBlock()).timestamp);
  const expiration = timestamp + 86_400;
  const signedBatches: {
    scenario: string;
    owner: Address;
    permit: ExposurePermit;
    domain: typeof domain;
    digest: Hex;
  }[] = [];
  type Symbol = keyof typeof tokens;
  async function signed(
    scenario: string,
    id: string,
    owner: Signer,
    entries: [Symbol, number, number][],
  ) {
    const unsigned = {
      id,
      spender: spender.address,
      sigDeadline: String(expiration),
      details: entries.map(([symbol, nonce, amount]) => ({
        token: tokens[symbol],
        nonce: String(nonce),
        amount: String(amount),
        expiration: String(expiration),
      })),
    };
    const typed = permitBatchTypedData(domain, unsigned);
    const signature = await owner.signTypedData(typed);
    assert(
      await verifyTypedData({ ...typed, address: owner.address, signature }),
    );
    const permit = { ...unsigned, signature };
    const digest = hashTypedData(typed);
    signedBatches.push({
      scenario,
      owner: owner.address,
      permit,
      domain,
      digest,
    });
    return permit;
  }
  async function setup(label: string, symbols: Symbol[] = ["X"]) {
    const owner = freshAccount(),
      recipient = freshAccount().address;
    await test.setBalance({ address: owner.address, value: 10n ** 20n });
    for (const symbol of symbols) {
      const token = tokens[symbol];
      await transact(
        `${label}: mint ${symbol}`,
        deployer,
        token,
        encodeFunctionData({
          abi: tokenAbi,
          functionName: "mint",
          args: [owner.address, 100n],
        }),
      );
      await transact(
        `${label}: root approval ${symbol}`,
        owner,
        token,
        encodeFunctionData({
          abi: tokenAbi,
          functionName: "approve",
          args: [permit2, (1n << 256n) - 1n],
        }),
      );
    }
    return { owner, recipient };
  }
  async function slot(owner: Signer, symbol: Symbol) {
    const [amount, expiry, nonce] = await client.readContract({
      address: permit2,
      abi: permitAbi,
      functionName: "allowance",
      args: [owner.address, tokens[symbol], spender.address],
    });
    return {
      token: tokens[symbol],
      spender: spender.address,
      nonce: String(nonce),
      currentAllowance: String(amount),
      expiration: String(expiry),
    };
  }
  async function input(
    owner: Signer,
    permits: ExposurePermit[],
    symbols: Symbol[] = ["X"],
  ): Promise<PermitExposureInput> {
    return {
      domain,
      owner: owner.address,
      asOfTimestamp: Number((await client.getBlock()).timestamp),
      assets: symbols.map((symbol) => ({ token: tokens[symbol], weight: "1" })),
      slots: await Promise.all(symbols.map((symbol) => slot(owner, symbol))),
      permits,
    };
  }
  async function apply(
    label: string,
    owner: Signer,
    permit: ExposurePermit,
    error?: string,
  ) {
    const message = permitBatchTypedData(domain, permit).message;
    return transact(
      label,
      spender,
      permit2,
      encodeFunctionData({
        abi: permitAbi,
        functionName: "permit",
        args: [owner.address, message, permit.signature as Hex],
      }),
      error,
    );
  }
  async function invalidate(
    label: string,
    owner: Signer,
    symbol: Symbol,
    newNonce: number,
    error?: string,
  ) {
    return transact(
      label,
      owner,
      permit2,
      encodeFunctionData({
        abi: permitAbi,
        functionName: "invalidateNonces",
        args: [tokens[symbol], spender.address, newNonce],
      }),
      error,
    );
  }
  async function lockdown(label: string, owner: Signer, symbols: Symbol[]) {
    return transact(
      label,
      owner,
      permit2,
      encodeFunctionData({
        abi: permitAbi,
        functionName: "lockdown",
        args: [
          symbols.map((symbol) => ({
            token: tokens[symbol],
            spender: spender.address,
          })),
        ],
      }),
    );
  }
  async function grant(
    label: string,
    owner: Signer,
    symbol: Symbol,
    amount: number,
  ) {
    return transact(
      label,
      owner,
      permit2,
      encodeFunctionData({
        abi: permitAbi,
        functionName: "approve",
        args: [tokens[symbol], spender.address, BigInt(amount), expiration],
      }),
    );
  }
  async function draw(
    label: string,
    owner: Signer,
    recipient: Address,
    entries: [Symbol, number][],
    error?: string,
  ) {
    return transact(
      label,
      spender,
      permit2,
      encodeFunctionData({
        abi: permitAbi,
        functionName: "transferFrom",
        args: [
          entries.map(([symbol, amount]) => ({
            from: owner.address,
            to: recipient,
            amount: BigInt(amount),
            token: tokens[symbol],
          })),
        ],
      }),
      error,
    );
  }
  async function received(recipient: Address, symbol: Symbol) {
    return String(
      await client.readContract({
        address: tokens[symbol],
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [recipient],
      }),
    );
  }
  async function executeRepair(
    label: string,
    owner: Signer,
    plan: Awaited<ReturnType<typeof planPermitRepair>>,
    permits: ExposurePermit[],
    symbols: Symbol[] = ["X"],
  ) {
    assert.equal(plan.status, "repairable");
    const snapshots = [];
    for (const [i, action] of plan.actions.entries()) {
      assert.equal(action.transaction.chainId, 31337);
      assert.equal(
        action.transaction.from.toLowerCase(),
        owner.address.toLowerCase(),
      );
      assert.equal(action.transaction.to.toLowerCase(), permit2.toLowerCase());
      assert.equal(action.transaction.value, "0");
      await transact(
        `${label}: planner action ${i} ${action.kind}`,
        owner,
        action.transaction.to,
        action.transaction.data,
      );
      snapshots.push(await input(owner, permits, symbols));
    }
    return snapshots;
  }

  // One unique slot in an unwanted batch suffices to invalidate that entire batch,
  // while a desired batch sharing another slot remains available.
  const selective = await setup("selective", ["X", "Y", "Z"]);
  const selectiveU = await signed("selective", "unwanted", selective.owner, [
    ["X", 0, 3],
    ["Y", 0, 3],
  ]);
  const selectiveW = await signed("selective", "wanted", selective.owner, [
    ["Y", 0, 3],
    ["Z", 0, 3],
  ]);
  const selectiveInput = await input(
    selective.owner,
    [selectiveU, selectiveW],
    ["X", "Y", "Z"],
  );
  const selectivePlannerInput = {
    inventory: selectiveInput,
    unwantedPermitIds: ["unwanted"],
    wantedSequence: ["wanted"],
  };
  const selectivePlan = await planPermitRepair(selectivePlannerInput);
  assert(await verifyPermitRepair(selectivePlannerInput, selectivePlan));
  assert.equal(selectivePlan.totalCost, "1");
  await executeRepair(
    "selective",
    selective.owner,
    selectivePlan,
    [selectiveU, selectiveW],
    ["X", "Y", "Z"],
  );
  const selectiveAfterRepair = await input(
    selective.owner,
    [selectiveU, selectiveW],
    ["X", "Y", "Z"],
  );
  assert(
    (
      await checkRepairSnapshot(
        selectivePlannerInput,
        selectivePlan,
        selectiveAfterRepair.slots,
      )
    ).matches,
  );
  await apply(
    "selective: unwanted rejects",
    selective.owner,
    selectiveU,
    "InvalidNonce()",
  );
  assert.deepEqual(
    (await input(selective.owner, [selectiveU, selectiveW], ["X", "Y", "Z"]))
      .slots,
    selectiveAfterRepair.slots,
  );
  await apply("selective: wanted remains usable", selective.owner, selectiveW);
  await draw(
    "selective: wanted draws Y3 Z3",
    selective.owner,
    selective.recipient,
    [
      ["Y", 3],
      ["Z", 3],
    ],
  );
  assert.equal(await received(selective.recipient, "Y"), "3");
  assert.equal(await received(selective.recipient, "Z"), "3");

  const shared = await setup("shared");
  const sharedU = await signed("shared", "unwanted", shared.owner, [
    ["X", 0, 9],
  ]);
  const sharedW = await signed("shared", "wanted", shared.owner, [["X", 0, 3]]);
  const sharedInput = await input(shared.owner, [sharedU, sharedW]);
  const sharedPlannerInput = {
    inventory: sharedInput,
    unwantedPermitIds: ["unwanted"],
    wantedSequence: ["wanted"],
  };
  const sharedPlan = await planPermitRepair(sharedPlannerInput);
  assert(await verifyPermitRepair(sharedPlannerInput, sharedPlan));
  assert.equal(sharedPlan.status, "impossible");
  assert.equal(sharedPlan.actions.length, 0);
  await invalidate("shared: invalidate X to 1", shared.owner, "X", 1);
  await apply(
    "shared: unwanted rejects",
    shared.owner,
    sharedU,
    "InvalidNonce()",
  );
  await apply(
    "shared: wanted also rejects",
    shared.owner,
    sharedW,
    "InvalidNonce()",
  );
  const sharedAfterRepair = await input(shared.owner, [sharedU, sharedW]);

  const restore = await setup("lockdown_restore");
  await grant("lockdown_restore: current X allowance 5", restore.owner, "X", 5);
  const restorer = await signed(
    "lockdown_restore",
    "unused-restorer",
    restore.owner,
    [["X", 0, 7]],
  );
  const restoreInput = await input(restore.owner, [restorer]);
  await lockdown("lockdown_restore: zero current allowance", restore.owner, [
    "X",
  ]);
  const restoreAfterLockdown = await input(restore.owner, [restorer]);
  assert.equal(restoreAfterLockdown.slots[0]!.nonce, "0");
  assert.equal(restoreAfterLockdown.slots[0]!.currentAllowance, "0");
  assert.equal(
    restoreAfterLockdown.slots[0]!.expiration,
    restoreInput.slots[0]!.expiration,
  );
  await apply(
    "lockdown_restore: unused permit restores allowance",
    restore.owner,
    restorer,
  );
  const restoreAfterPermit = await input(restore.owner, [restorer]);
  assert.equal(restoreAfterPermit.slots[0]!.nonce, "1");
  assert.equal(restoreAfterPermit.slots[0]!.currentAllowance, "7");
  await draw(
    "lockdown_restore: draw restored X7",
    restore.owner,
    restore.recipient,
    [["X", 7]],
  );
  assert.equal(await received(restore.recipient, "X"), "7");

  const combined = await setup("combined");
  await grant("combined: current X allowance 5", combined.owner, "X", 5);
  const combinedU = await signed(
    "combined",
    "unused-restorer",
    combined.owner,
    [["X", 0, 7]],
  );
  const combinedInput = await input(combined.owner, [combinedU]);
  const combinedPlannerInput = {
    inventory: combinedInput,
    unwantedPermitIds: ["unused-restorer"],
    wantedSequence: [],
    clearAllowanceSlots: [{ token: tokens.X, spender: spender.address }],
  };
  const combinedPlan = await planPermitRepair(combinedPlannerInput);
  assert(await verifyPermitRepair(combinedPlannerInput, combinedPlan));
  assert.equal(combinedPlan.totalCost, "2");
  const combinedAfterEachAction = await executeRepair(
    "combined",
    combined.owner,
    combinedPlan,
    [combinedU],
  );
  const combinedAfterRepair = await input(combined.owner, [combinedU]);
  assert(
    (
      await checkRepairSnapshot(
        combinedPlannerInput,
        combinedPlan,
        combinedAfterRepair.slots,
      )
    ).matches,
  );
  assert.equal(combinedAfterRepair.slots[0]!.currentAllowance, "0");
  assert.equal(combinedAfterRepair.slots[0]!.nonce, "1");
  await apply(
    "combined: old permit rejects",
    combined.owner,
    combinedU,
    "InvalidNonce()",
  );
  await draw(
    "combined: retained allowance cannot draw",
    combined.owner,
    combined.recipient,
    [["X", 1]],
    "InsufficientAllowance(uint256)",
  );
  assert.equal(await received(combined.recipient, "X"), "0");

  // This is deliberately a separate case: nonce invalidation does not eliminate
  // current spend authority, even when every old signature is now unusable.
  const retained = await setup("invalidation_retains");
  await grant(
    "invalidation_retains: current X allowance 5",
    retained.owner,
    "X",
    5,
  );
  await invalidate(
    "invalidation_retains: invalidate X to 1",
    retained.owner,
    "X",
    1,
  );
  const retainedBeforeDraw = await input(retained.owner, []);
  assert.equal(retainedBeforeDraw.slots[0]!.nonce, "1");
  assert.equal(retainedBeforeDraw.slots[0]!.currentAllowance, "5");
  assert.equal(retainedBeforeDraw.slots[0]!.expiration, String(expiration));
  await draw(
    "invalidation_retains: draw X5 despite invalidation",
    retained.owner,
    retained.recipient,
    [["X", 5]],
  );
  assert.equal(await received(retained.recipient, "X"), "5");

  const bounds = await setup("bounds");
  await invalidate(
    "bounds: equal zero rejects",
    bounds.owner,
    "X",
    0,
    "InvalidNonce()",
  );
  await invalidate(
    "bounds: jump 65536 rejects",
    bounds.owner,
    "X",
    65536,
    "ExcessiveInvalidation()",
  );
  assert.equal((await slot(bounds.owner, "X")).nonce, "0");
  await invalidate("bounds: jump 65535 succeeds", bounds.owner, "X", 65535);
  await invalidate(
    "bounds: equal 65535 rejects",
    bounds.owner,
    "X",
    65535,
    "InvalidNonce()",
  );
  await invalidate(
    "bounds: decreasing nonce rejects",
    bounds.owner,
    "X",
    65534,
    "InvalidNonce()",
  );
  await invalidate("bounds: next increment succeeds", bounds.owner, "X", 65536);
  assert.equal((await slot(bounds.owner, "X")).nonce, "65536");

  const report = {
    generatedAt: new Date().toISOString(),
    status: "PASS",
    mode: "ISOLATED_ANVIL",
    publicTransactions: 0,
    realFundsMoved: "0",
    chainId: 31337,
    contractScope:
      "Unmodified official Permit2 AllowanceTransfer module, not the canonical combined Permit2 deployment",
    provenance: {
      ...provenance,
      sourceBundleSha256: artifacts.sourceBundleSha256,
      compiler: artifacts.compiler,
      compilerSettings: artifacts.settings,
      compiledArtifactSha256: sha256(artifactBytes),
      anvilPackageVersion: (
        require("@foundry-rs/anvil/package.json") as { version: string }
      ).version,
    },
    addresses: { permit2, tokens, spender: spender.address },
    semantics: {
      invalidateNonces: {
        strictlyGreaterThanCurrent: true,
        maximumJumpPerCall: "65535",
        existingAllowanceRetained: true,
        expirationRetained: true,
      },
      lockdown: {
        setsAmountTo: "0",
        nonceRetained: true,
        expirationRetained: true,
        unusedPermitCanRestore: true,
      },
      permit: {
        signedNonceMustEqualCurrent: true,
        incrementsEachDetailNonce: true,
        successfulBatchIsAtomic: true,
      },
    },
    scenarios: {
      selective: {
        input: selectiveInput,
        plannerInput: selectivePlannerInput,
        plan: selectivePlan,
        afterRepair: selectiveAfterRepair,
        canceled: ["unwanted"],
        preserved: ["wanted"],
        wantedDrawn: "6",
        result:
          "Unique X invalidation rejects unwanted X+Y but preserves wanted Y+Z",
      },
      shared: {
        input: sharedInput,
        plannerInput: sharedPlannerInput,
        plan: sharedPlan,
        afterRepair: sharedAfterRepair,
        canceled: ["unwanted", "wanted"],
        result:
          "Slot/nonce invalidation cannot distinguish wanted and unwanted signatures sharing X0",
      },
      lockdownRestore: {
        input: restoreInput,
        afterLockdown: restoreAfterLockdown,
        afterPermit: restoreAfterPermit,
        drawnAfterLockdown: "7",
        result:
          "Lockdown leaves nonce unchanged, and the unused permit restores seven units",
      },
      combined: {
        input: combinedInput,
        plannerInput: combinedPlannerInput,
        plan: combinedPlan,
        afterEachAction: combinedAfterEachAction,
        afterRepair: combinedAfterRepair,
        drawnAfterRepair: "0",
        result:
          "Invalidation rejects the old permit; lockdown separately removes the five retained allowance units",
      },
      invalidationRetains: {
        afterInvalidation: retainedBeforeDraw,
        drawnAfterInvalidation: "5",
        result: "Current allowance remains spendable after nonce invalidation",
      },
      bounds: {
        finalNonce: "65536",
        result:
          "Delta 65535 accepted, 65536 rejected; equality/decrease rejected; later +1 accepted",
      },
    },
    signedBatches,
    deployments,
    receipts,
    limitations: [
      "Known finite signatures and ordinary fake ERC20s only; unknown signatures and future owner actions may create new authority",
      "Operations are sequenced without adversarial interleaving; this is not an atomic repair, cancellation-race prevention, or a public-chain finality test",
      "These local execution witnesses establish protocol behavior, not minimum-cost plan correctness for arbitrary inputs",
      "Shared-slot impossibility is relative to nonce invalidation and lockdown operations; other protocol actions or re-signing are outside that claim",
      "Recorded ephemeral-chain receipts are not public-explorer records; private keys are never saved or printed",
    ],
  };
  const path = join(root, "docs/research/permit-repair-chain.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialize(report));
  console.log(
    serialize({
      status: "PASS",
      scenarios: Object.keys(report.scenarios),
      minedFailures: receipts.filter((r) => r.receipt.status === "reverted")
        .length,
      report: path,
    }),
  );
} finally {
  node.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (node.exitCode !== null) return resolve();
    node.once("exit", () => resolve());
    const timeout = setTimeout(() => {
      node.kill("SIGKILL");
      resolve();
    }, 2000);
    timeout.unref();
  });
}
