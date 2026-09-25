# Korp Research: Exposure Map & TxCert

**Korp Exposure Map** computes the maximum collectible exposure represented by a bounded inventory of signed Permit2 allowance batches. It verifies EOA signatures, explores sequential nonce dependencies, and returns a withdrawal witness. Built on the existing Korp research project. AI-assisted and unaudited; not a claim of first-ever invention.

## Exposure Map — experimental release

[Open the browser-only verifier](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/exposure) · [Research and prior art](EXPOSURE-RESEARCH.md) · [Core source](permit-exposure.ts)

Three batches granting X+Y, Y+Z and X+Z each appear to expose six risk units. Summing the signatures gives 18; summing per-token/nonce maxima gives 9. With the same owner and spender, atomic nonce conflicts mean only one batch can execute: the actual model maximum is 6. Sequential regrants can instead increase exposure, and circular nonce dependencies can prevent every batch from executing. All amounts use explicitly declared synthetic weights, not dollar prices.

The implementation enumerates reachable nonce frontiers for up to 12 batches. Existing finite allowances count even after their originating permit was consumed. Grants with expired allowances or zero amounts can advance nonces and enable a later grant, provided their signature deadlines remain valid. Unsupported data is rejected rather than treated as zero exposure. The result can be recomputed using the same solver, its witness replayed, and an altered claimed maximum rejected; this is not an independent optimality proof.

**Limits:** the inventory and snapshot must be complete and correct; they are not authenticated against a public blockchain. The model freezes time and assumes standard Permit2 semantics, colluding spenders, replenished balances and sufficient token-to-Permit2 approval. It excludes unlimited grants, nonce wrap, duplicate-token batches, new signatures and changing token economics. It does not revoke permissions or certify that a wallet is safe. Browser inputs remain local.

Reproduce: `node --import tsx scripts/research/exposure-fixtures.ts` and `node --import tsx scripts/research/build-exposure.ts`. Local EVM harness: `scripts/research/permit-exposure-chain.ts`; dependency provenance and setup are documented in its reference directory. Public examples contain deliberately expired synthetic signatures and no wallet keys.

**Research status:** the contribution under investigation is a faithful compiler of Permit2 batch semantics with reproducible results and withdrawal witnesses, not new cryptography or a new search algorithm. The [research record](EXPOSURE-RESEARCH.md) documents 12 close prior-art comparisons and rejected ideas. Publication dates our implementation; it does not establish exclusive ownership, patentability, standards approval or worldwide priority.

- [Live four-testnet policy checker](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev) — Base, Ethereum, Arbitrum and Optimism Sepolia; read-only, no signing or broadcasting.
- [Recorded budget proof lab](https://korp-txcert-proof-lab.mute-cell-557f.workers.dev) — local/offline evidence.
- [Real Base Sepolia test-USDC payment](https://sepolia.basescan.org/tx/0x253006ca04b98c1870b152f6e13f510ea4a2e2092c19893ce65ebbae7b6c1c61) — 0.01 test USDC; certificate verified and replay protection passed on September 25, 2026. Operator test, not revenue.

## Research prototype: Korp Promise Receipt

**Make the payment authorization remember the seller's signed promise.** [Try the public verifier](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/promise) · [Protocol and prior-art comparison](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/promise-receipt-spec.md).

A merchant signs acceptance terms. Their digest and signature are committed inside an EIP-3009 nonce. A later merchant-signed response root allows disclosure of one failed equality rule without publishing the unrelated field values. **Correction:** nonce-based payment commitments already appear in Roundhouse KYA, Warrant and VIC. Our earlier search was incomplete. See [the expanded prior-art note](PROMISE-PRIOR-ART-UPDATE.md). No first-invention or patentability claim is made for this prototype.

The implemented local experiment verifies a signed contradiction and rejects both a merchant's re-signed changed promise and a buyer's fabricated value. **The demo uses unfunded synthetic accounts and expired test authorizations, makes no payments and does not verify settlement.** It does not prove semantic truth, identity, fraud or refund entitlement. Merchant participation and further integration/security work are required.

Source: `src/core/promise-receipt.ts`. Reproduce: `node --import tsx scripts/research/promise-demo.ts`. Specification: [PROMISE-RECEIPT-SPEC.md](PROMISE-RECEIPT-SPEC.md). Public test vectors: `docs/pilot/promise-receipt-demo.json`. Developed for Korp with AI assistance; no exclusive-invention claim.

## Korp Outcome Check

An agent can pay successfully and still receive stale data, the wrong chain, or broken output. [Try the live read-only demo](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/outcomes).

The source now combines preapproved output requirements, one persistent authorization attempt per owner-issued task, and read-only payment-receipt reconciliation. A fresh nonce after a timeout does not create permission to pay again. Reports separate payment evidence from response observations and deterministic acceptance checks. They do not prove merchant authorship or useful delivery, issue refunds, or establish fraud.

New code: `src/core/outcome-contract.ts`, `scripts/pilot/task-payments.ts`. Integration, limits and competing approaches: `docs/pilot/OUTCOME-CHECK.md`. New cases are tested using local fixtures; the earlier testnet receipts below are a separate budget experiment. No claim of world-first invention. `docs/pilot/INVENTION-RESEARCH.md` preserves the broader research proposal; the narrower signature-based Promise Receipt prototype above is implemented.

## Enforced x402 API-payment budget

The owner-controlled Node signer now enforces a cumulative Base Sepolia test-USDC authorization budget before signing. Two 0.01 test-USDC purchases settled; the third was blocked before authorization and remained blocked after a database restart. See [public pilot evidence](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/pilot.html) and `docs/pilot/README.md` inside the archive. This is a separate gasless x402 authorization path, not the unfinished hosted native-transfer signer. No production funds or customer adoption are claimed.

## Reproduce
Extract `korp-txcert-source.zip` (source structure preserved). Node 24 and Python 3. Run `npm install --ignore-scripts`, `npm run check`, `npm run demo:chain` and `npm run demo:competition`. The snapshot includes 212 passing tests, live Worker/UI, testnet payment verification script, and public evidence.

Deploy the read-only checker to your Cloudflare account with `npx wrangler deploy --config live-testnet/wrangler.jsonc`. No keys are needed for that Worker. See `docs/hackathon/LIVE-TESTNET.md` inside the archive for evidence and limits.

## Scope
The public checker evaluates caller-supplied native-transfer rules and reads RPC data. It does not enforce independent owner permissions or persistent spending budgets. The separate Node/SQLite budget signer is exercised on a local EVM with simulated native currency. A hosted signer-to-public-chain budget flow is not implemented. The separate Base Sepolia certificate service has a verified public test payment; that does not prove budget-controlled transfers on four chains.

Extends existing Korp TxCert work. OpenAI Codex assisted implementation, tests and documentation. No production keys, private documents, environment files or internal account configuration included. No open-source license grant selected; supplied for competition review. Dependency licenses remain their owners'.
