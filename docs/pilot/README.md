# Korp x402 budget pilot

Status: experimental, Base Sepolia only, AI-assisted and unaudited. September 25, 2026.

## New: task outcome checks

See [OUTCOME-CHECK.md](OUTCOME-CHECK.md) for preapproved output requirements, a persistent task payment guard and receipt reconciliation. The [live read-only demo](https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/outcomes) detects mismatches in supplied example responses. It does not prove merchant authorship or useful delivery.

## What works
A trusted payment-signing process can cap cumulative EIP-3009 authorizations before the private key signs. The guard accepts only Base Sepolia's pinned test USDC, USDC v2 domain, TransferWithAuthorization type, configured payer/recipient, per-payment cap and <=60-second expiry. SQLite reserves the amount atomically before signing. Nonces cannot be reused. Changed budget settings on reopening are rejected. Reservations remain charged after uncertain errors or expiry; they are not claims of settled spending.

Public-chain experiment: two 0.01 test-USDC API purchases settled; both returned verified TxCert certificates. A third purchase was rejected before transmitting a payment authorization. Reopening the same database still rejected another purchase. Only two authorizations were sent. See base-sepolia-budget-evidence.json and these receipts:

- https://sepolia.basescan.org/tx/0x6bbceb1925b6d8beac7c3b7d6ac9cbdd1b160bfb9cdea24e9b730339d27d81b6
- https://sepolia.basescan.org/tx/0x40cfe7f85560136f9ba67345ed9d63718bee1ca34e4906837f1225c2906d9221

Operator test assets only. Not revenue, customer adoption or evidence of four-chain budget enforcement.

## Run the complete example
Requirements: Node 24, existing dependencies (`npm install --ignore-scripts`), an isolated test payer with at least 0.02 Base Sepolia test USDC. The facilitator settles the gasless authorizations; this payer does not need ETH. Never use a treasury key or seed phrase.

```
npm run check
npm run pilot:testnet -- /absolute/path/to/test-only-payer.key /absolute/path/to/new-pilot-run
```

The script pins the existing Korp Base Sepolia service and recipient, creates a 0.02 test-USDC total budget and 0.01 per-payment cap, verifies both chain receipts and certificate signatures, then proves exhaustion before and after reopening SQLite. It refuses to reuse an existing run directory. If interrupted, inspect evidence.json and the reserved balance before any further authorization. Do not create a new run to bypass an exhausted budget. Each run spends up to 0.02 TEST USDC.

## Integrate into an owner-controlled process

```ts
import { PaymentBudget } from './scripts/pilot/payment-budget.js';
import { buyerFetch } from './scripts/client.js';

// Read this configuration from owner-controlled storage; never from agent input.
const budget = new PaymentBudget('/persistent/payer-budget.sqlite', {
  payer: TEST_PAYER_PUBLIC_ADDRESS,
  receiver: '0xC7a0E085544c116dDf9f996108c553eeCE62E443',
  limit: '20000', perPayment: '10000',
  startsAt: OWNER_SELECTED_START, endsAt: OWNER_SELECTED_END,
});
const paidFetch = await buyerFetch(
  'https://korp-txcert-sepolia.mute-cell-557f.workers.dev',
  '0xC7a0E085544c116dDf9f996108c553eeCE62E443',
  '/private/test-only-payer.key', undefined,
  signer => budget.guard(signer),
);
// The fixed client accepts only the pinned origin and 0.01 test-USDC requirements.
// A trusted server can expose specific API operations to an agent using paidFetch.
// See run-base-sepolia.ts for the complete POST, receipt and certificate checks.
```

## Security and deployment boundary
The guard runs locally/in an owner's trusted Node process. An agent with filesystem access to the key, database or configuration can bypass it. Process isolation, authenticated agent access, backups, revocation and distributed coordination remain deployment responsibilities. This pilot is not a hosted remote-signing service. Do not hand the agent a raw key, unrestricted signing hook, writable database or configuration. Do not run replicas with separate databases. No auto-renewal/reset or automatic refunds. The signer protects the supplied budget; it does not prove the merchant delivered useful output or judge transaction safety.

The payment guard does not require a TxCert certificate before authorizing the API fee: doing so would create a circular payment dependency. It verifies the payment authorization itself. The merchant's returned TxCert is independently verified afterward. The earlier owner-policy/native-transfer budget signer is a separate prototype. Mainnet and arbitrary recipients/assets are deliberately unsupported here.

Free Cloudflare hosts the API and public evidence. Owner-side SQLite signing is not deployed to that public Worker, and the four-chain UI remains read-only. No claim of a production audit or universal wallet compatibility.
