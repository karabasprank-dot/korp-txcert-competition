# Korp TxCert — live testnet and competition prototype

Experimental owner-policy certificates and persistent signer budgets for AI-agent transactions. AI-assisted and unaudited.

- [Live four-testnet policy checker](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev) — Base, Ethereum, Arbitrum and Optimism Sepolia; read-only, no signing or broadcasting.
- [Recorded budget proof lab](https://korp-txcert-proof-lab.mute-cell-557f.workers.dev) — local/offline evidence.
- [Real Base Sepolia test-USDC payment](https://sepolia.basescan.org/tx/0x253006ca04b98c1870b152f6e13f510ea4a2e2092c19893ce65ebbae7b6c1c61) — 0.01 test USDC; certificate verified and replay protection passed on September 25, 2026. Operator test, not revenue.

## New: Korp Outcome Check

An agent can pay successfully and still receive stale data, the wrong chain, or broken output. [Try the live read-only demo](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/outcomes).

The source now combines preapproved output requirements, one persistent authorization attempt per owner-issued task, and read-only payment-receipt reconciliation. A fresh nonce after a timeout does not create permission to pay again. Reports separate payment evidence from response observations and deterministic acceptance checks. They do not prove merchant authorship or useful delivery, issue refunds, or establish fraud.

New code: `src/core/outcome-contract.ts`, `scripts/pilot/task-payments.ts`. Integration, limits and competing approaches: `docs/pilot/OUTCOME-CHECK.md`. New cases are tested using local fixtures; the earlier testnet receipts below are a separate budget experiment. No claim of world-first invention. `docs/pilot/INVENTION-RESEARCH.md` describes a harder private-failure-evidence research direction; it is not implemented.

## Enforced x402 API-payment budget

The owner-controlled Node signer now enforces a cumulative Base Sepolia test-USDC authorization budget before signing. Two 0.01 test-USDC purchases settled; the third was blocked before authorization and remained blocked after a database restart. See [public pilot evidence](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/pilot.html) and `docs/pilot/README.md` inside the archive. This is a separate gasless x402 authorization path, not the unfinished hosted native-transfer signer. No production funds or customer adoption are claimed.

## Reproduce
Extract `korp-txcert-source.zip` (source structure preserved). Node 24 and Python 3. Run `npm install --ignore-scripts`, `npm run check`, `npm run demo:chain` and `npm run demo:competition`. The snapshot includes 186 passing tests, live Worker/UI, testnet payment verification script, and public evidence.

Deploy the read-only checker to your Cloudflare account with `npx wrangler deploy --config live-testnet/wrangler.jsonc`. No keys are needed for that Worker. See `docs/hackathon/LIVE-TESTNET.md` inside the archive for evidence and limits.

## Scope
The public checker evaluates caller-supplied native-transfer rules and reads RPC data. It does not enforce independent owner permissions or persistent spending budgets. The separate Node/SQLite budget signer is exercised on a local EVM with simulated native currency. A hosted signer-to-public-chain budget flow is not implemented. The separate Base Sepolia certificate service has a verified public test payment; that does not prove budget-controlled transfers on four chains.

Extends existing Korp TxCert work. OpenAI Codex assisted implementation, tests and documentation. No production keys, private documents, environment files or internal account configuration included. No open-source license grant selected; supplied for competition review. Dependency licenses remain their owners'.
