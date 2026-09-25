# Owner-approved policies and independent signing

Korp checks an unsigned Base transaction against explicit rules for 0.01 USDC per completed analysis. Only PASS receives a 60-second signed certificate. Certificate verification and these integration files are free. Korp does not hold a buyer's signing key, sign its transaction or broadcast it.

The optional signer adapter adds **owner approval**: the owner signs an EIP-712 policy authorization; the independent signing process pins that authorization's digest. An agent cannot substitute weaker rules, even if it gets a genuine Korp certificate for those rules. The existing HTTP API remains compatible and still accepts caller-supplied policies. Owner enforcement takes place at the signer, not inside the public API.

## Try it without a wallet or funds

Requires Node 22+. Download the SDK and demo into a new directory. Review the downloaded code before running it. These commands do not send payments. Installation requires access to npm.

```sh
mkdir korp-owner-demo
cd korp-owner-demo
npm init -y
npm install --save-exact viem@2.56.5 zod@4.6.5
curl --fail --proto '=https' https://korp-txcert.mute-cell-557f.workers.dev/sdk/korp-signer.mjs -o korp-signer.mjs
curl --fail --proto '=https' https://korp-txcert.mute-cell-557f.workers.dev/sdk/owner-demo.mjs -o owner-demo.mjs
node owner-demo.mjs
```

Expected: PASS; the permitted transaction is signed locally; modified rules and a repeated nonce are rejected. The demo generates three disposable unfunded identities in memory. It uses synthetic certificates, makes no network calls, stores no keys and never broadcasts the signed transaction. Its in-memory nonce flag is NOT a production nonce store.

Published artifact hashes: [/sdk/manifest.json](/sdk/manifest.json). A hash fetched from the same server is only a consistency check. Pin a separately reviewed copy/hash in production; never dynamically import unreviewed network code into a signer.

## Probe the actual service for free

```sh
curl --fail --proto '=https' https://korp-txcert.mute-cell-557f.workers.dev/examples.json -o examples.json
curl -i --proto '=https' https://korp-txcert.mute-cell-557f.workers.dev/v1/certify
```

GET returns HTTP 402 with requirements for a POST request. It does not accept or process a payment. Examples contain allowed transfer, excessive amount and unlimited approval cases with deterministic expected results. For a paid POST, copy a complete `request` object from an example, keep the exact owner-approved rules, and use an x402 v2 buyer. A completed BLOCK/WARN also costs 0.01 USDC. Invalid requests are rejected before settlement.

Use `https://korp-txcert-sepolia.mute-cell-557f.workers.dev` and chain 84532 for test USDC. Mainnet uses chain 8453, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, price `10000` atomic units and receiver `0xC7a0E085544c116dDf9f996108c553eeCE62E443`. Independently check these terms before authorizing payment. Do not blindly retry an indeterminate settlement.

## Integrate into a real signer

1. **Owner process:** review the exact policy, agent wallet, chain, service and attestor. Construct authorization fields using `policyHash(policy)` and sign `typedOwnerPolicy(authorization)` with an owner-controlled EOA wallet. `policyId` is a bytes32 identifier; `revision` is an integer string. Approval validity is bounded to 30 days. No owner key is sent to Korp. Smart-contract owners/EIP-1271 are not supported by this offline adapter.
2. **Protected signer configuration:** pin `owner`, `agent`, `chainId`, `service`, `attestor` and `approvalDigest: ownerApprovalDigest(authorization)`. Provision this through an owner-controlled channel. Never derive trusted values from an agent request or an untrusted certificate. Keep the owner, agent and attestor identities separate.
3. **Agent process:** submit the unsigned transaction and exact approved policy to Korp. It may hold the public approval, policy and certificate, but cannot modify the signer's trusted configuration. Include an explicit wallet nonce.
4. **Signer process:** use `verifyOwnerApproval` before paying if possible, then `signWithOwnerPolicy({request, certificate, approval}, trust, hooks)`. The adapter verifies owner signature, active approval digest, rule hash, chain, agent, attestor, service and expiry, then verifies the certificate offline. The transaction passed to the signing hook is a validated snapshot.
5. **Wallet hooks:** implement `claimNonce` as a persistent atomic compare-and-set across every signer replica. Check the wallet's pending nonce and reject already claimed nonces. The `sign` hook must be inside the isolated signer and use the validated snapshot. Enforce gas/fee caps, balances and any other wallet controls separately. Korp certifies neither gas fields nor cumulative budgets. Do not expose the raw signing method to the agent.

```js
import { signWithOwnerPolicy } from './korp-signer.mjs';

// trustedConfig is loaded from OWNER-controlled configuration, not the request.
const signedTransaction = await signWithOwnerPolicy(
  { request, certificate, approval },
  trustedConfig,
  {
    claimNonce: (chainId, agent, nonce) => walletNonceStore.claimExpectedNonce(chainId, agent, nonce),
    sign: checkedRequest => isolatedWallet.signCheckedRequest(checkedRequest),
  },
);
// Broadcast is a separate wallet decision. These wallet hooks are integration
// interfaces, not implemented storage/signing products supplied by Korp.
```

## Updates, revocation and failures

To approve new rules, increment revision, sign a new authorization and replace the pinned digest through the owner's secure configuration channel. Old approvals then fail for newly evaluated requests. Stop/drain in-flight signing during configuration rotation when immediate revocation is required: the adapter snapshots configuration at invocation. There is no onchain revocation registry or remote revocation lookup.

Nonce claims remain consumed if verification after the claim, signing or delivery fails. Reconcile with the wallet's onchain/pending state before recovery; automatic release could allow duplicate signing. The adapter rechecks expiry after a slow nonce claim. Any delay inside an HSM/signing hook needs its own expiry/configuration check immediately before signing.

The default clock uses local Unix seconds. Synchronize signer clocks. Do not override the clock in production with a test timestamp. Reject errors rather than bypassing the adapter.

A certificate attests conformity to supported rules. It does not prove economic safety, contract correctness or successful execution. There is no external security audit or uptime SLA. Local checking may be sufficient for some developers; Korp's proposed value is a portable signed policy result across signing systems.
