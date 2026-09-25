# Live testnet status — September 25, 2026

Live read-only playground: https://korp-txcert-live-testnet.mute-cell-557f.workers.dev

## Verified
- Cloudflare Worker, free infrastructure; independent of the laptop.
- Base Sepolia, Ethereum Sepolia, Arbitrum Sepolia and Optimism Sepolia: fresh RPC chain IDs, block, native balance and nonce verified. See live-testnet-smoke.json.
- Overspending is rejected before RPC access. Transport/429/5xx failures get one bounded retry; malformed or wrong-chain results fail closed. Network failure is not displayed as transaction approval.
- Separate Base Sepolia x402 service completed a real on-chain **testnet** payment of 0.01 test USDC to the pinned receiver, returned a 60-second attestor certificate, verified it online/offline, recovered an identical replay without a second payment and rejected a changed request with HTTP 409.
- Receipt: https://sepolia.basescan.org/tx/0x253006ca04b98c1870b152f6e13f510ea4a2e2092c19893ce65ebbae7b6c1c61 (block 47274149). Evidence in public-testnet-payment.json. This is an operator test, not customer revenue. The certificate is now expired as designed.
- Typecheck, lint and 168 unit/integration tests passed before deployment.

## Boundaries
The four-network playground only evaluates supplied native-transfer rules and reads chain state. It has no key, wallet connection, certificate issuance, persistent budget enforcement or broadcast capability. It does not establish an independently trusted owner policy.

The budget signer is a separate local SQLite/Node prototype tested on a local EVM. A hosted signer-to-public-chain budget flow is not implemented. The separate test payer currently has no test ETH for direct transfers. Mainnet transfers, Bitcoin, Solana and arbitrary tokens are not claimed as supported by this playground.

The existing Base payment/certificate service remains separate. No mainnet money was spent in this verification.

## Reproduce
Node 24 and Python 3. Run npm install --ignore-scripts, npm run check, npm run demo:chain.
Deploy the read-only playground with npx wrangler deploy --config live-testnet/wrangler.jsonc after logging into your own free Cloudflare account. The public snapshot omits account IDs and credentials.
GET /api/health lists allowed testnets. POST /api/check accepts the existing transaction/policy request schema with an allowed numeric chainId. Other networks are rejected. A BLOCK response intentionally has chain:null. HTTP 503 means chain state unavailable, even if the supplied policy evaluation passes.

Do not run the paid test script against mainnet. It pins Base Sepolia, test USDC and the expected receiver. A test payer key must be supplied locally; none is included here. Inspect any saved settlement receipt before retrying an indeterminate payment.
