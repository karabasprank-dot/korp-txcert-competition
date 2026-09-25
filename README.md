# Korp TxCert — competition source snapshot

Experimental owner-policy certificates and a persistent budget signer for AI-agent transactions. AI-assisted development; unaudited. No customer or revenue claims.

Live recorded proof lab: https://korp-txcert-proof-lab.mute-cell-557f.workers.dev

## Source and reproduction
Extract `korp-txcert-source.zip`. This initial repository delivery contains a source archive preserving the project directory structure. It is not yet a browsable source tree or production deployment package.

Node 24 and Python 3 are required. Run `npm install --ignore-scripts`, then `npm run check`, `npm run demo:chain`, and `npm run demo:competition`.

The local-chain harness starts a loopback-only Anvil instance and stops it on completion. Two simulated native transfers execute; cumulative overspending is rejected before signing and after a database restart. No real funds or remote chain RPC are used. The offline token demo uses synthetic USDC intent; it does not settle USDC.

## Scope and disclosure
This extends existing Korp TxCert work. September 25 additions: SQLite budget adapter, nine-scenario demo, local EVM integration, proof-lab viewer. OpenAI Codex assisted code, tests and documentation. Generic spending controls already exist; portability of owner-policy evidence is a hypothesis needing user validation.

No production keys, environment files, internal deployment configuration or personal documents are included. The production payment service is separate. Gas, token behavior, distributed replicas and facilitator settlement are not covered by these demos. Uncertain reservations require reconciliation.

No open-source license grant has been selected yet; code is supplied for competition review. Dependency licenses remain their owners'.
