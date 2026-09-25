# Permit2 local evidence reference

This directory contains an unchanged dependency closure of Uniswap's official
`AllowanceTransfer` contract and its `MockERC20` test token. The local harness
deploys the standalone module, **not** the canonical combined Permit2 deployment.
Every token and account is disposable; no public network is used.

- Permit2 revision: [`cc56ad0f3439c502c246fc5cfcc3db92bb8b7219`](https://github.com/Uniswap/permit2/tree/cc56ad0f3439c502c246fc5cfcc3db92bb8b7219).
- Solmate revision: [`8d910d876f51c3b2585c9109409d601f600e68e1`](https://github.com/transmissions11/solmate/tree/8d910d876f51c3b2585c9109409d601f600e68e1), the Permit2 revision's `lib/solmate` gitlink.
- Original source headers and repository licenses are preserved. `provenance.json`
  records the immutable source URL, SHA-256, and Git blob SHA-1 for every file.
- `compiled.json` contains the ABI and bytecode built with solc
  `0.8.17+commit.8df45f5f`, optimizer 200 runs, London target. It records the compiler
  distribution hash and source bundle hash. The harness verifies source hashes
  before using these cached compilation artifacts.

From the project root, with the existing Node dependencies installed:

```sh
node --import tsx scripts/research/permit-exposure-chain.ts
```

This starts its own loopback Anvil with zero default accounts. Keys are generated
in memory and never saved or printed. It deploys the reference contracts, signs
real EIP-712 batches, mines successful and reverted transactions, checks balances,
allowances and rollback, and saves `docs/research/permit-exposure-chain.json`.
The JSON contains public signatures, calldata, receipts, source provenance, and
actual deployed runtime bytecode hashes. No private keys are present. Local
receipts cannot be looked up in a public block explorer.

To independently rebuild the cached bytecode with the pinned compiler:

```sh
npm install --prefix /tmp/korp-permit2-solc-0.8.17 --ignore-scripts --no-audit --no-fund solc@0.8.17
KORP_SOLC_MODULE=/tmp/korp-permit2-solc-0.8.17/node_modules/solc node --import tsx scripts/research/permit-exposure-chain.ts
```

The compiler is temporary and is not added to project dependencies. The optional
`fetch-reference.py` refreshes only the exact pinned public source files and
licenses via HTTPS; it does not execute downloaded source or install packages.

Fixtures (each token amount is three raw fake units, all with equal demo weight):

| Case       | Pre-signed batches              | Observed outcome                                                                    |
| ---------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| Triangle   | A=(X0,Y0), B=(Y0,Z0), C=(X0,Z0) | A then draw transfers 6; B and C revert; per-slot maxima would incorrectly total 9. |
| Sequential | A=(X0,Y0), B=(X1,Y1)            | Apply and draw A, then apply and draw B: total 12.                                  |
| Cyclic     | A=(X0,Y1), B=(Y0,Z1), C=(Z0,X1) | Every batch reverts, including its tentative first-detail update; collectible 0.    |

The fixtures validate specific protocol behavior; they do not prove the Exposure
Map optimizer correct for arbitrary inputs, establish novel cryptography, or test
public-chain finality, reorgs, contract wallets, or unknown future signatures.
