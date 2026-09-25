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
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

// This executable only connects to the loopback Anvil process it starts. It has
// no remote-RPC setting, reads no wallet files, and never serializes private keys.
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const reference = join(root, "scripts/research/permit2-reference");
const sha256 = (value: string | Buffer) =>
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
for (const [path, record] of Object.entries(provenance.files).sort()) {
  const content = readFileSync(join(reference, path));
  assert.equal(
    sha256(content),
    record.sha256,
    `Reference source changed: ${path}`,
  );
  if (path.endsWith(".sol"))
    sources[path] = { content: readFileSync(join(reference, path), "utf8") };
}
const sourceBundleSha256 = sha256(JSON.stringify(sources));
const compilerSettings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "london",
  outputSelection: {
    "*": {
      "*": [
        "abi",
        "evm.bytecode.object",
        "evm.deployedBytecode.object",
        "evm.deployedBytecode.immutableReferences",
      ],
    },
  },
};
type ContractArtifact = {
  abi: Abi;
  evm: {
    bytecode: { object: string };
    deployedBytecode: {
      object: string;
      immutableReferences: Record<string, unknown>;
    };
  };
};
type Artifacts = {
  sourceBundleSha256: string;
  compiler: { version: string; soljsonSha256: string };
  settings: typeof compilerSettings;
  contracts: Record<string, ContractArtifact>;
};
const artifactPath = join(reference, "compiled.json");
let artifacts: Artifacts;
if (process.env.KORP_SOLC_MODULE) {
  const solc = require(process.env.KORP_SOLC_MODULE) as {
    version(): string;
    compile(input: string): string;
  };
  assert(
    solc.version().startsWith("0.8.17+commit.8df45f5f"),
    "Requires official solc 0.8.17",
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources,
        settings: compilerSettings,
      }),
    ),
  ) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, ContractArtifact>>;
  };
  const errors = output.errors?.filter((e) => e.severity === "error") ?? [];
  assert.equal(
    errors.length,
    0,
    errors.map((e) => e.formattedMessage).join("\n"),
  );
  artifacts = {
    sourceBundleSha256,
    compiler: {
      version: solc.version(),
      soljsonSha256: sha256(
        readFileSync(
          join(
            dirname(require.resolve(process.env.KORP_SOLC_MODULE)),
            "soljson.js",
          ),
        ),
      ),
    },
    settings: compilerSettings,
    contracts: {
      AllowanceTransfer:
        output.contracts["permit2/src/AllowanceTransfer.sol"]![
          "AllowanceTransfer"
        ]!,
      MockERC20:
        output.contracts["permit2/test/mocks/MockERC20.sol"]!["MockERC20"]!,
    },
  };
  writeFileSync(artifactPath, serialize(artifacts));
} else {
  artifacts = JSON.parse(readFileSync(artifactPath, "utf8")) as Artifacts;
}
assert.equal(
  artifacts.sourceBundleSha256,
  sourceBundleSha256,
  "Recompile changed source bundle",
);
assert.deepEqual(artifacts.settings, compilerSettings);
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
const port = 20000 + Math.floor(Math.random() * 10000);
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
const client = createPublicClient({ chain: foundry, transport });
const test = createTestClient({ chain: foundry, mode: "anvil", transport });
const freshAccount = () => privateKeyToAccount(generatePrivateKey());
type Signer = ReturnType<typeof freshAccount>;
const receipts: unknown[] = [];
const deployments: unknown[] = [];
const permitAbi = parseAbi([
  "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permitBatch, bytes signature)",
  "function transferFrom((address from, address to, uint160 amount, address token)[] transferDetails)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const types = {
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
  PermitBatch: [
    { name: "details", type: "PermitDetails[]" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
} as const;
const invalidNonceSelector = keccak256(toHex("InvalidNonce()")).slice(0, 10);

async function transact(
  label: string,
  signer: Signer,
  to: Address,
  data: Hex,
  expected: "success" | "reverted" = "success",
) {
  const wallet = createWalletClient({
    chain: foundry,
    account: signer,
    transport,
  });
  // Fixed gas deliberately allows reverting transactions to be mined, rather
  // than stopping at eth_estimateGas; the report includes actual failed receipts.
  const hash = await wallet.sendTransaction({ to, data, gas: 3_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, expected, label);
  let revertData: string | undefined;
  if (expected === "reverted") {
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
      "Local failed-transaction trace unavailable",
    );
    revertData = trace.result.returnValue.startsWith("0x")
      ? trace.result.returnValue
      : `0x${trace.result.returnValue}`;
    assert.equal(
      revertData.slice(0, 10),
      invalidNonceSelector,
      `${label}: expected InvalidNonce()`,
    );
  }
  receipts.push({
    label,
    from: signer.address,
    to,
    calldata: data,
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
  const deployer = freshAccount();
  const spender = freshAccount();
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
    tokens[symbol] = await deploy("MockERC20", [`Fake ${symbol}`, symbol, 0]);
  const expiration = Number((await client.getBlock()).timestamp) + 86_400;
  const domain = {
    name: "Permit2",
    chainId: 31337,
    verifyingContract: permit2,
  } as const;
  const signedBatches: unknown[] = [];
  type Detail = {
    token: Address;
    amount: bigint;
    expiration: number;
    nonce: number;
  };
  async function signBatch(
    label: string,
    owner: Signer,
    entries: [keyof typeof tokens, number][],
  ) {
    const details: Detail[] = entries.map(([symbol, nonce]) => ({
      token: tokens[symbol],
      amount: 3n,
      expiration,
      nonce,
    }));
    const message = {
      details,
      spender: spender.address,
      sigDeadline: BigInt(expiration),
    };
    const typed = {
      domain,
      types,
      primaryType: "PermitBatch" as const,
      message,
    };
    const signature = await owner.signTypedData(typed);
    assert(
      await verifyTypedData({ ...typed, address: owner.address, signature }),
    );
    signedBatches.push({
      label,
      owner: owner.address,
      ...typed,
      signature,
      digest: hashTypedData(typed),
    });
    const data = encodeFunctionData({
      abi: permitAbi,
      functionName: "permit",
      args: [owner.address, message, signature],
    });
    return { label, data, entries };
  }
  async function setup(label: string) {
    const owner = freshAccount(),
      recipient = freshAccount().address;
    await test.setBalance({ address: owner.address, value: 10n ** 20n });
    for (const [symbol, token] of Object.entries(tokens)) {
      await transact(
        `${label}: mint fake ${symbol}`,
        deployer,
        token,
        encodeFunctionData({
          abi: tokenAbi,
          functionName: "mint",
          args: [owner.address, 100n],
        }),
      );
      await transact(
        `${label}: base approval ${symbol}`,
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
  async function snapshot(owner: Signer, recipient: Address) {
    const state: Record<string, unknown> = {};
    for (const [symbol, token] of Object.entries(tokens)) {
      const [amount, expiry, nonce] = await client.readContract({
        address: permit2,
        abi: permitAbi,
        functionName: "allowance",
        args: [owner.address, token, spender.address],
      });
      state[symbol] = {
        nonce,
        amount: String(amount),
        expiration: expiry,
        ownerBalance: String(
          await client.readContract({
            address: token,
            abi: tokenAbi,
            functionName: "balanceOf",
            args: [owner.address],
          }),
        ),
        recipientBalance: String(
          await client.readContract({
            address: token,
            abi: tokenAbi,
            functionName: "balanceOf",
            args: [recipient],
          }),
        ),
      };
    }
    return state;
  }
  async function draw(
    label: string,
    owner: Signer,
    recipient: Address,
    symbols: (keyof typeof tokens)[],
  ) {
    await transact(
      label,
      spender,
      permit2,
      encodeFunctionData({
        abi: permitAbi,
        functionName: "transferFrom",
        args: [
          symbols.map((symbol) => ({
            from: owner.address,
            to: recipient,
            amount: 3n,
            token: tokens[symbol],
          })),
        ],
      }),
    );
  }
  async function balances(recipient: Address) {
    return Promise.all(
      Object.values(tokens).map((token) =>
        client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [recipient],
        }),
      ),
    );
  }

  const triangle = await setup("triangle");
  const A = await signBatch("triangle A: X0 Y0", triangle.owner, [
    ["X", 0],
    ["Y", 0],
  ]);
  const B = await signBatch("triangle B: Y0 Z0", triangle.owner, [
    ["Y", 0],
    ["Z", 0],
  ]);
  const C = await signBatch("triangle C: X0 Z0", triangle.owner, [
    ["X", 0],
    ["Z", 0],
  ]);
  await transact(A.label, spender, permit2, A.data);
  await draw("triangle: draw X3 Y3", triangle.owner, triangle.recipient, [
    "X",
    "Y",
  ]);
  const triangleAfterA = await snapshot(triangle.owner, triangle.recipient);
  for (const batch of [B, C]) {
    await transact(batch.label, spender, permit2, batch.data, "reverted");
    assert.deepEqual(
      await snapshot(triangle.owner, triangle.recipient),
      triangleAfterA,
    );
  }
  assert.deepEqual(await balances(triangle.recipient), [3n, 3n, 0n]);

  const sequential = await setup("sequential");
  // Both generations are signed before either permit is submitted.
  const first = await signBatch("sequential round 0: X0 Y0", sequential.owner, [
    ["X", 0],
    ["Y", 0],
  ]);
  const second = await signBatch(
    "sequential round 1: X1 Y1",
    sequential.owner,
    [
      ["X", 1],
      ["Y", 1],
    ],
  );
  const sequentialSnapshots = [];
  for (const batch of [first, second]) {
    await transact(batch.label, spender, permit2, batch.data);
    await draw(
      `${batch.label}: draw X3 Y3`,
      sequential.owner,
      sequential.recipient,
      ["X", "Y"],
    );
    sequentialSnapshots.push(
      await snapshot(sequential.owner, sequential.recipient),
    );
  }
  assert.deepEqual(await balances(sequential.recipient), [6n, 6n, 0n]);

  const cyclic = await setup("cyclic");
  const cycles = [
    await signBatch("cyclic A: X0 Y1", cyclic.owner, [
      ["X", 0],
      ["Y", 1],
    ]),
    await signBatch("cyclic B: Y0 Z1", cyclic.owner, [
      ["Y", 0],
      ["Z", 1],
    ]),
    await signBatch("cyclic C: Z0 X1", cyclic.owner, [
      ["Z", 0],
      ["X", 1],
    ]),
  ];
  const cyclicBefore = await snapshot(cyclic.owner, cyclic.recipient);
  for (const batch of cycles) {
    await transact(batch.label, spender, permit2, batch.data, "reverted");
    // First detail would pass, second fails: the first update must roll back.
    assert.deepEqual(
      await snapshot(cyclic.owner, cyclic.recipient),
      cyclicBefore,
    );
  }
  assert.deepEqual(await balances(cyclic.recipient), [0n, 0n, 0n]);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "PASS",
    mode: "ISOLATED_ANVIL",
    publicTransactions: 0,
    realFundsMoved: "0",
    chainId: 31337,
    contractScope:
      "Unmodified official AllowanceTransfer module deployed locally; not the canonical combined Permit2 deployment",
    unit: "Raw fake token units, 0 decimals; equal unit weights are an explicit demo assumption, not market valuation",
    provenance: {
      ...provenance,
      sourceBundleSha256,
      compiler: artifacts.compiler,
      compilerSettings,
      compiledArtifactSha256: sha256(readFileSync(artifactPath)),
      anvilPackageVersion: (
        require("@foundry-rs/anvil/package.json") as { version: string }
      ).version,
    },
    addresses: { permit2, spender: spender.address, tokens },
    scenarios: {
      triangle: {
        owner: triangle.owner.address,
        recipient: triangle.recipient,
        collectible: "6",
        perSlotMaximumOvercount: "9",
        afterAAndFailedAlternatives: triangleAfterA,
        verdict:
          "A grants and draws 6; B and C each mined and reverted with InvalidNonce",
      },
      sequential: {
        owner: sequential.owner.address,
        recipient: sequential.recipient,
        collectible: "12",
        afterEachRound: sequentialSnapshots,
        verdict:
          "Pre-signed nonce 0 and nonce 1 batches both execute; 6 fake units drawn per round",
      },
      cyclic: {
        owner: cyclic.owner.address,
        recipient: cyclic.recipient,
        collectible: "0",
        unchangedState: cyclicBefore,
        verdict:
          "All three batches mined and reverted with InvalidNonce; matching first-detail writes rolled back",
      },
    },
    signedBatches,
    deployments,
    receipts,
    limitations: [
      "Finite hand-picked witnesses validate these protocol cases; this harness does not establish an optimizer theorem",
      "No public-network transaction, production wallet, facilitator, real asset, reorg, or finality test",
      "Nonce wraparound, administrative nonce invalidation, owner direct approvals, smart-contract signatures, and arbitrary future capabilities are outside these fixtures",
      "The local chain is ephemeral; receipts are recorded evidence, not publicly queryable explorer records",
    ],
  };
  const reportPath = join(root, "docs/research/permit-exposure-chain.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, serialize(report));
  console.log(
    serialize({
      status: "PASS",
      triangle: "6",
      sequential: "12",
      cyclic: "0",
      minedFailedTransactions: 5,
      report: reportPath,
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
