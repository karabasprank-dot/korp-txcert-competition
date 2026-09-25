# Korp Outcome Check

September 25, 2026. Experimental, AI-assisted, unaudited. Owner-side payment support is Base Sepolia test USDC only.

**Problem:** a successful payment and HTTP 200 do not tell an agent whether the purchased API result meets its requirements. A timeout can also tempt the agent to pay again while the first payment has already settled.

**Working improvement:** bind a task to owner-approved request bytes, payment terms and deterministic output requirements before signing. Limit the task to one authorization attempt. Record a response hash and acceptance-check report. Independently reconcile a nominated transaction against the pinned test USDC's authorization nonce and transfer events, canonical block and finalized head using an owner-selected RPC. Missing responses and HTTP errors remain distinct from payment success.

Try the hosted, read-only checker: https://korp-txcert-live-testnet.mute-cell-557f.workers.dev/outcomes

## Example
An agent purchases a Base Sepolia USDC price quote. The owner specifies chainId=84532, asset=USDC, an allowed numeric range, and data no older than 30 seconds. The provider returns HTTP 200 with an Ethereum quote or a ten-minute-old timestamp. Korp reports exactly which checks fail and commits the contract and response hashes. A retry with a fresh payment nonce under the same task ID is blocked before the raw signer is called—even if the overall budget has room.

A field saying `asset=USDC` is just a field: it does not verify a token contract or real market price. A provider can fabricate an otherwise valid response. This feature detects explicitly specified, machine-checkable mismatches, not arbitrary fraud or semantic correctness.

## Owner-side integration

```ts
import { TaskPayments, payApprovedTask } from './scripts/pilot/task-payments.js';
import { PaymentBudget } from './scripts/pilot/payment-budget.js';

// Owner-only trusted service: do not expose approve(), the DB, the raw signer
// or test key path to an agent. Maintain one durable shared DB, not one per retry.
const tasks = new TaskPayments('/persistent/tasks.sqlite');
const budget = new PaymentBudget('/persistent/budget.sqlite', OWNER_BUDGET);
const request = {
  url: 'https://korp-txcert-sepolia.mute-cell-557f.workers.dev/v1/certify',
  method: 'POST' as const,
  body: JSON.stringify(EXACT_CERTIFICATION_REQUEST),
};
tasks.approve({
  id: 'owner-issued-task-123', request,
  payer: TEST_PAYER_ADDRESS, receiver: OWNER_PINNED_RECEIVER, amount: '10000',
  contract: {
    version: 1, statuses: [200],
    rules: [{ kind: 'type', path: [], value: 'object' }],
  },
});
const result = await payApprovedTask(tasks, budget, 'owner-issued-task-123', request, TEST_ONLY_KEY_PATH);
console.log(result.payment); // hashes/observations, not authorization headers
// Keep response contents private if you retain them for independent reproduction.
// The default object check is deliberately weak: set checks specific to your API.
// For TxCert also run the existing cryptographic certificate verification.

// After a timeout, do not reset the task or create a new ID to pay again.
// Read-only reconciliation, supplied with an owner-selected viem PublicClient:
const evidence = await tasks.reconcile('owner-issued-task-123', TRANSACTION_HASH, TESTNET_RPC_CLIENT);
```

The existing buyer client restricts payments to 0.01 test USDC, a pinned recipient and one origin. Adapting other APIs or SDKs requires integration work. The new wrapper pins the actual URL/method/body/content type; it does not accept arbitrary additional headers.

## Output requirements
`outcomeContractSchema` supports up to 20 rules, path depth 8:

- `equals`: exact primitive equality (case-sensitive, no numeric coercion).
- `type`: object, array, string, finite number or boolean.
- `range`: inclusive finite numeric bounds.
- `freshness`: integer Unix timestamp in seconds, bounded age and future tolerance.

Prototype-related paths, arbitrary code, remote schema resolution and regular expressions are unsupported. JSON body limits and strict unknown-field validation bound work. HTTP and JSON checks run separately. A missing response is unknown, not proof of merchant failure.

`evaluateOutcome(contract, responseBody, httpStatus, observedAt)` runs locally without payment, network access or a key. `verifyOutcomeReport(contract, responseBody, report)` reproduces the computation and detects mismatch in supplied evidence; it does **not** authenticate the observer or merchant. The hosted POST `/api/outcome-check` accepts `{contract,body,httpStatus}` and uses its own observation time. The hosted demo does not sign, broadcast, prove payment or issue refunds. Downloaded reports omit raw response content; a verifier needs the retained content to recompute its digest. Hashes of predictable data are not encryption.

## Evidence boundaries
- Owner approval and contract are enforced by an owner-controlled database, not a blockchain contract or merchant signature.
- Two processes sharing the same SQLite file cannot reserve two authorizations for one approved task ID. Separate databases, changed IDs, writable owner storage or direct key access defeat this boundary. An authenticated task dispatcher is the integrator's responsibility.
- A claim is persisted before calling the budget guard. Validation failure, signer failure or crash can leave an unpaid task held. This intentional false positive has no automatic reset, refund, replay or retry path. Losing/restoring an old database can lose protection.
- Reconciliation checks chain 84532, tx hash, success, canonical receipt block, finalized head, pinned token emitter, matching payer+nonce and payer+receiver+amount events. RPC remains a trust dependency. Nonfinalized or uncertain RPC evidence is rejected, never treated as permission to pay again.
- An HTTP response, a provider-reported transaction hash, acceptance-check result and chain evidence are distinct. Reports explicitly set `merchantAuthorshipVerified=false` and `usefulDeliveryVerified=false`. Buyer-supplied observations must not be used as public accusations, reputation penalties or automatic refund verdicts.
- No escrow, arbitration, insurance, clawback, production signer service or all-chain payment support is claimed.

## Prior art and product hypothesis
Retry/idempotency, payment budgets, signed delivery receipts and escrow already exist. We do **not** claim world-first invention or absence of competition:

- FortiSwap documents same-authorization retries and payment identifiers: https://docs.fortiblox.com/docs/fortiswap/agents
- x402-receipts binds payment to request/response fingerprints and supports delivery receipts: https://github.com/StelarDigital/x402-receipts
- Its delivery-receipt extension proposal: https://github.com/x402-foundation/x402/issues/2833
- x402 specification separates payment verification and settlement: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md

Our proposed distinction is the combined owner-side workflow: precommitted acceptance requirements, persistent per-task authorization hold, and replayable checks alongside chain evidence. This is a product hypothesis, not a proven moat or claim that competitors lack these capabilities. Evaluate with developers buying time-sensitive structured crypto data. Ask whether these failure cases already cost them money and whether their current tooling handles them. Do not pitch a generic spending-limit competitor as a new invention.

## Verification
Run `npm run check`. Tests cover independent connections/restart, fresh-nonce duplicate attempts with spare budget, altered owner approval, altered acceptance rules, wrong payment fields, failures and mainnet rejection, receipt nonce/asset/amount/chain/reorg/finality checks, missing responses, failed HTTP 200 output, malformed/stale/future/wrong-chain data, report replay and hosted validation.

These new failure cases use local deterministic fixtures and mocked chain receipts. The two earlier public Base Sepolia payment receipts remain real recorded evidence of the previous budget pilot; they are **not** a new on-chain run of Outcome Check. No new payments were made for this feature.
