> Update: a narrower **nonce-bound Promise Receipt** experiment is implemented locally in `src/core/promise-receipt.ts`; see `PROMISE-RECEIPT-SPEC.md`. It uses merchant signatures and salted selective disclosure, not ZK. The broader privacy research below is preserved as the original proposal; no global novelty claim.

# Invention research: private evidence of a failed paid task

Research proposal, not implemented; September 25, 2026. No claim of novelty established.

The current Outcome Check is an engineering improvement using existing ideas. Spending limits, retry guards, delivery receipts, escrow and zero-knowledge conditional payments are prior art. Do not market their combination as a world-first invention.

## Candidate problem
A company buys crypto data with an agent. A stale or wrong-network result breaks the contract, but publishing the full request or response exposes its customer, positions or trading plans. The company needs narrowly scoped evidence that a specific requirement was violated, linked to a particular payment, without revealing unrelated content.

Proposed research objective: a verifiable counterexample to an acceptance contract committed before payment, derived from an authenticated merchant response, disclosing only the violated requirement and enough public payment evidence to identify the purchase. A proof should not let either party rewrite requirements after seeing the result.

## Hard questions that must be solved
1. Response authenticity: a buyer can fabricate a bad response. A hash from a buyer is not proof of merchant authorship. Need merchant-signed request/response commitments or an authenticated transport witness, with explicit trust assumptions.
2. Precommitment: the acceptance contract, request commitment and merchant identity must be bound to the payment before authorization. A local SQLite record alone is not public proof of ordering.
3. Private values: a hash alone is not zero knowledge and low-entropy values can be guessed. Need a reviewed commitment/proof construction; do not invent new cryptography casually.
4. Verifiable failure scope: wrong chain, missing required field or stale signed timestamp is easier than 'this answer was useful'. A claimed timestamp still needs a trusted reference or agreed merchant warranty.
5. Silence: absence of a response is not cryptographic proof of non-delivery. Timeouts need an agreed observable protocol; never auto-penalize a merchant from one buyer's timeout.
6. Enforcement: evidence does not claw back an ordinary token transfer. Refunds require a separately agreed mechanism or merchant cooperation. No automatic custody or escrow is part of today's build.

## Smallest honest experiment
Use synthetic private request/response fields and a locally generated test merchant key. Bind an owner-approved acceptance rule to a merchant-signed response commitment. Prove one concrete mismatch while hiding unrelated fields, then test fabricated responses, changed rules, another payment, replay, missing responses and dictionary attacks. Establish which information leaks and what assumptions remain. No real money, live customer data or production keys.

This experiment has NOT been built. First compare exact claims and threat models against existing implementations before spending more time. The current prototype is a fixture/test harness for those questions, not a ZK proof system.

## Prior art to examine
- Signed x402 delivery receipts: https://github.com/StelarDigital/x402-receipts
- x402 delivery-receipt extension proposal: https://github.com/x402-foundation/x402/issues/2833
- Escrow/SLA/audit-trail implementation: https://github.com/yzzzbtc/x402-assured
- Earlier zero-knowledge contingent payments and payments for services: https://acmccs.github.io/papers/p229-campanelliA.pdf
- x402 protocol specification: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md

Search coverage cannot prove that no one has built something. A defensible invention claim would require a concrete mechanism, a precise comparison with prior art and reproducible evidence of an advantage. Patentability is not established by this note.
