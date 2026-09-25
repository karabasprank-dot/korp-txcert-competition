# Three-minute demonstration script

## 0:00–0:25 — The buyer and problem
“For developers operating agents that spend funds, individual transaction checks are only part of the problem. We need to bind each decision to the owner's exact policy and keep the signer from exceeding a cumulative budget.”

## 0:25–1:05 — Show the failure case
Open index.html. Show the 100 USDC simulated budget and 60 USDC individual ceiling. Replay 30, 30, then 50. Explain that the third transaction can pass an individual check while failing the total budget. The signer refuses it. Clearly label this panel as offline simulated token intent.

## 1:05–1:45 — Show actual integration evidence
Run `npm run demo:chain`. Show the actual Hono certificate handler feeding an independently controlled signer and an isolated local EVM. Show two successful receipts, the recipient balance of 60 simulated native wei, and the rejected third transfer. These are local chain receipts, not public testnet transactions or real payments.

## 1:45–2:20 — Show hostile and failure cases
Replay the changed owner policy, expired certificate, reused nonce, database restart and signing outage. Explain that ambiguous signing failures retain their reservations; a production operator must reconcile them instead of blindly refunding capacity.

## 2:20–3:00 — Explain fit and remaining work
“Wallet providers already offer spending policies. Our hypothesis is that teams working across signer integrations want independently verifiable, portable policy evidence. This prototype demonstrates one integration, not universal wallet compatibility. Next are external developer feedback, public testnet token execution and independent security review.”

## Commercial hypothesis
First prospective customer: a developer operating an agent with repeat stablecoin payments and an owner who needs a reviewable record of authorization. Existing certification endpoint charges per check; team reporting/integration is a proposed future offering. No paying-customer or revenue claims are supported by this demo.

## Submission evidence checklist
- Include source and reproduction commands, dependency lockfile and both generated reports.
- Disclose existing TxCert code and AI-assisted development.
- Record founder pitch separately; do not impersonate the owner.
- Keep confidential deployment files, credentials and wallet keys out of any public archive.
- Entry registration, organizer eligibility and final submission remain outstanding.
