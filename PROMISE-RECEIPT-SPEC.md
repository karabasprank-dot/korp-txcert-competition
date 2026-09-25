# Korp Promise Receipt

September 25, 2026. Experimental design and local demo; unaudited. Novelty and demand remain hypotheses.

A buyer should be able to show that a merchant's signed response violates an agreed, mechanical requirement without publishing unrelated response values. The proposed contribution is binding those terms to an EIP-3009 payment authorization **through its nonce**, then carrying that binding into a selectively disclosed breach witness. EIP-712 signatures, hashes and Merkle proofs are existing primitives.

## Protocol

**1. Agree before authorizing.** The merchant signs canonical, versioned EIP-712 acceptance terms containing chain ID, test-USDC contract, payer, payee, integer token amount, authorization validity, salted request commitment, ordered fixed-field disclosure manifest, and one primitive equality rule. Pin the merchant's expected signing address independently; a recovered address alone does not establish its identity. The rule names one manifest field and an expected string, boolean, null or safe integer. Equality preserves type and uses no coercion. Missing differs from null.

Prototype v0 fixes four top-level scalar field names and a two-level ordered Merkle tree. The manifest fixes field positions, order and tree size. Reject duplicate or ambiguous paths, unsupported values and malformed terms. The private request commitment uses an independently generated salt and unambiguous encoding of the exact request representation. Its opening remains private unless the dispute requires it. The buyer checks the merchant signature and approves the exact terms before signing any payment authorization.

**2. Commit through the nonce.** Let `termsHash` be the EIP-712 digest of those terms. Derive:

```text
paymentNonce = H(encode(NONCE_DOMAIN_V1,
                       termsHash,
                       H(merchantTermsSignature),
                       ownerSalt32))
```

`H` and `encode` must be fixed by the versioned implementation and vectors; concatenating ambiguous strings is invalid. `ownerSalt32` is fresh, cryptographically random and private until opening. The merchant signature's exact bytes are committed. The buyer's ordinary EIP-3009 signature covers this nonce and the matching payment fields, thereby approving the commitment. Changes to terms, signature or salt produce a different nonce.

In a future settled integration, a matching `AuthorizationUsed` event can anchor this commitment without an additional anchor transaction. This gives an existence bound at settlement, not an independent timestamp for negotiations. Require successful, canonical, sufficiently finalized settlement, the expected chain/token emitter, matching authorizer/nonce and matching transfer parties/amount. An authorization signature or isolated event is insufficient settlement evidence.

**3. Commit the response.** The merchant builds one salted leaf per manifest position and signs a versioned EIP-712 receipt containing `termsHash`, `paymentNonce` and `responseRoot`. Each leaf binds its index/path, presence flag, typed primitive value and independent random salt. An absent field has an explicit missing encoding, not an omitted leaf or a null value. Domain-separate leaves from internal nodes; fix padding, ordering and proof length. The buyer checks that the received response and openings reproduce the signed root before accepting the receipt.

**4. Reveal one breach.** A witness includes the acceptance terms and merchant signature, nonce opening, buyer authorization, merchant response-root signature, and the failed field's salted opening and Merkle siblings. Verification recomputes every binding and checks that this committed field is missing or differs from the agreed primitive. A matching field does not establish breach. Reject changed terms, fabricated response roots, altered leaves, incompatible domains and substituted authorizations.

Use the CSPRNG salt helper for every request, owner nonce and field; distinct predictable salts do not protect private values. This is selective disclosure, not zero knowledge. The witness reveals the terms, rule, payment metadata, manifest names/order, index, tree size and failed value. Sibling hashes conceal other values under hash-security and fresh-salt assumptions; metadata and correlations may still disclose information. Do not publish salts or openings for unrelated fields. The receipt supports attribution of the committed statement, not arbitrary claims about the merchant.

## Boundaries and demo

The demo uses ephemeral local buyer/merchant keys and synthetic data. It verifies a signed authorization and breach witness. **It transfers no tokens, contacts no wallet and does not verify settlement.** A successful demo must remain labeled as such. The public vectors use an expired authorization from an unfunded ephemeral buyer. They contain a bearer payment signature; never publish an active funded authorization. The research export helper rejects nonexpired authorizations using a five-minute local-clock margin, which is not a substitute for independent chain-time checks in production.

The merchant must cooperate by signing both terms and the response root. A missing signature or absent response yields unavailable evidence, not proven non-delivery. A signed missing-field leaf proves only what that signed response commits. No semantic truth, price accuracy, timeliness of receipt, usefulness or honest external data is established. There is no ZK circuit, escrow, automatic refund, clawback or penalty.

Scope authorization uniqueness by chain, token and payer. Fresh salts prevent accidental nonce reuse; durable buyer state must prevent fresh-nonce duplicate purchases and unsafe retries. Replaying the same witness cannot represent another purchase. Deduplicate evidence by authorization identity, and retain originals privately. Key compromise, equivocation, unavailable openings and untrusted RPC evidence remain explicit failure modes.

## Closest reviewed work

- [x402-receipts](https://github.com/StelarDigital/x402-receipts/blob/main/SPEC.md) already signs payment/request/response bindings and supports buyer countersignatures and Merkle batches of whole receipts, anchored with EAS. Its reviewed spec does not describe acceptance-derived authorization nonces.
- [PEAC](https://github.com/peacprotocol/peac/blob/main/docs/interop/SIGNED-RECORDS-INTEROP-MATRIX.md) records x402 observations and mandate-digest references; the reviewed matrix does not describe this nonce commitment.
- [W3C BBS](https://www.w3.org/TR/vc-di-bbs/) already provides signed selective disclosure and unlinkable derived proofs. This design does not claim unlinkability.
- [TLSNotary](https://tlsnotary.org/docs/faq/) authenticates selectively disclosed TLS data through a participating verifier/notary. Here authenticity depends on explicit merchant application signatures.
- [ZK contingent payments/services](https://eprint.iacr.org/2017/566.pdf) already links verified goods or services to payment through fair-exchange protocols. This proposal supplies evidence, not conditional payment enforcement.

## Adoption and falsifiable gates

Proposed buyer gateway: verify merchant terms, request owner approval, retain nonce openings, then export a minimal witness. Proposed merchant/API gateway: sign acceptance offers, commit declared response fields and return signed receipts. Proposed verifier gateway: independently check witnesses and clearly separate authorization from settlement status. These are integration proposals, not deployed services.

Demand gate: interview five structured-data API buyers and three merchants; continue only if two buyers identify recurring costly disputes and one merchant agrees to a signing pilot. Compare integration effort and useful evidence against ordinary signed receipts.

Novelty gate: publish reproducible vectors and the exact nonce-commitment claim; actively seek a prior implementation of that same mechanism. An earlier equivalent defeats the narrow novelty hypothesis. Independent reviewers must reject tampering, cross-payment substitution and false breach witnesses. Search coverage alone cannot establish global novelty or patentability.

## Reproduce the implemented experiment

Run `npm run check`, then `node --import tsx scripts/research/promise-demo.ts`. The second command generates new synthetic keys in memory and writes only public expired test evidence to `docs/pilot/promise-receipt-demo.json`. It does not update the deployed fixture automatically. Core implementation: `src/core/promise-receipt.ts`; tests: `test/promise-receipt.test.ts`. The hosted demo uses a fixed copy of these vectors and independently runs the verifier for original, rewritten-promise and fabricated-response cases.

Exact v0 nonce encoding: `keccak256(abi.encode(keccak256(utf8("KORP_PROMISE_NONCE_V0")), hashTypedData(acceptanceTypedData(terms)), keccak256(merchantSignature), nonceSalt))`. The terms hash uses the schema-ordered JSON representation produced by `normalized` in the TypeScript reference; this is a v0 interoperability constraint, not a claim of universal JSON canonicalization. All integers must be safe and strings are compared byte-for-byte without Unicode normalization. Published vectors are authoritative for v0 compatibility.

The verifier requires externally pinned payer, payee and merchant addresses. In the public demo these are explicitly synthetic fixture identities, not an identity directory. A repeated witness is the same evidence, not another incident. Merchant cooperation and an SDK adapter that preserves the derived nonce are required before an actual x402 integration. No interoperability claim with unmodified clients or facilitators is made.
