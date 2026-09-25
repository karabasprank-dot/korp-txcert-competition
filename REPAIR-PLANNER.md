# Korp Repair Planner

September 25, 2026. Bounded research specification; implementation and validation status are reported separately. No novelty, first-invention, audit, or live-wallet safety claim is made.

The planner asks: **which modeled Permit2 allowance revocations and nonce increases satisfy the user's constraints at the lowest declared cost?** It considers interactions between atomic signed batches, including cases where invalidating one token's nonce blocks a multi-token batch, and cases where advancing a nonce enables a previously unreachable signature. It uses the finite, fixed-time authorization model described in [Exposure Map research](EXPOSURE-RESEARCH.md).

## Inputs and constraints

`planPermitRepair(input)` accepts:

```ts
{
  inventory: PermitExposureInput,
  unwantedPermitIds: string[],
  wantedSequence: string[],
  clearAllowanceSlots?: { token: Address; spender: Address }[],
  costs?: { invalidateNonce: string; clearAllowance: string }
}
```

The inventory supplies one owner, chain and Permit2 deployment, signed batches, current slot states, and an evaluation timestamp. Original signature checks and supported-input restrictions still apply. Unknown identifiers, unsupported data, or an incomplete required snapshot are errors, not evidence of zero risk.

All three constraints must hold after the proposed repairs:

1. **Unwanted permits:** no listed unwanted permit can execute in any reachable ordering of the supplied signed permits. This includes orderings using other, unlisted permits as prerequisites. A permit with a zero amount or expired allowance can still be an unwanted executable permit if its signature deadline remains valid.
2. **Wanted sequence:** the complete `wantedSequence` must execute directly after repairs, alone and in exactly that order. Testing each wanted permit independently is insufficient. The planner does not insert unlisted prerequisite permits into this witness. It may advance a nonce to make a future wanted permit executable.
3. **Cleared slots:** every requested slot must have literal stored Permit2 `allowance.amount === 0` immediately after repairs and after every prefix of every reachable supplied-permit sequence. This is stronger than zero currently collectible exposure. An expired positive stored allowance still needs clearing; a reachable positive grant violates the condition even when its allowance expiration is past.

The universal checks include the empty sequence. An unwanted permit that is already unreachable needs no action unless a chosen nonce increase makes it reachable. The invariant is checked before any voluntary drain: a spender's ability to drain an allowance back to zero does not satisfy a requirement that it remain zero.

Preserving a wanted sequence establishes a path from the repaired state without intervening adversarial actions. It does not guarantee that an adversary cannot consume competing nonces first, or that the wanted sequence will remain executable indefinitely.

## Permitted repairs and exact search scope

There are two action types:

- `invalidateNonces(token, spender, newNonce)`: increase the owner's stored nonce. It leaves the existing amount and expiration unchanged. Each call must increase the nonce by at most 65,535.
- `lockdown([{ token, spender }])`: clear the stored amount for a requested slot. It leaves the nonce and expiration unchanged. Clearing alone does not prevent a previously signed permit from restoring an allowance.

These effects are defined by [Uniswap's AllowanceTransfer implementation](https://github.com/Uniswap/permit2/blob/main/src/AllowanceTransfer.sol). The planner models individual slot-clearing actions; it does not optimize transaction packing, delegation, root token approvals, new authorizations, or alternative revocation contracts.

For each relevant slot, candidate final nonces are the current nonce and legal thresholds at a supplied signed nonce or one above it. Targets below the current nonce are discarded. Both kinds of threshold matter: invalidating to a future wanted nonce can enable it, while invalidating past a nonce can disable a grant. A larger target is never assumed safer without checking reachability again.

Between adjacent signed-nonce thresholds, values have the same comparisons with all supplied permit requirements. Under this fixed inventory, monotone nonce model, and nonnegative action costs, a lowest representative of each such region does not cost more than a larger equivalent target. Reaching a target uses the minimum number of legal nonce-invalidation calls. Signed-nonce wrapping is outside the model; a legal terminal nonce increase must not be confused with executing a wrapping permit.

The planner enumerates the resulting bounded plans, applies each to a detached snapshot, checks the entire wanted sequence, and explores all reachable supplied-permit orders for the unwanted and literal-zero constraints. Clearing a requested nonzero slot is necessary at the start; clearing an already zero slot cannot help block future signatures. Other slot-clearing actions cannot change nonce reachability and are outside this action set.

Costs are decimal-string **synthetic action costs**, charged per nonce-invalidation call and per cleared slot. They are not gas estimates, token prices, fees, or predictions of transaction inclusion. Optimality means minimum cost among the modeled candidate plans, using these declared costs and restrictions. Ties may have multiple valid solutions.

The working bounds are 10,000 candidate plans, 100,000 explored states, and 64 repair actions. An exceeded work bound must produce an explicit limit error, not `impossible`, and must not leave a partial plan labeled optimal. `impossible` means no plan in the completed bounded model satisfies all constraints; it does not mean no real-world recovery method exists.

## Results and checking

The result records `version`, `inputHash`, `status`, `actions`, `totalCost`, `wantedWitness`, `expectedSlots`, search counts and limits, an explanation, and model limits. Status is `unchanged`, `repairable`, or `impossible`; `totalCost` is null for an impossible result. `unchanged` means the supplied constraints already hold in this model, not that the wallet has no other exposure.

`verifyPermitRepair(input, result)` rechecks the result against its input and model. A result hash binds data; it is not an authenticated blockchain-state proof. Unless a separate implementation is explicitly supplied, verification is a reproducibility check with shared modeling code, not independent proof of compiler correctness.

`checkRepairSnapshot(input, result, observedSlots)` compares an observed slot snapshot with the recorded expectations. Matching supplied values does not prove which transactions occurred, that those values came from a blockchain, or that they remain current. The caller must establish the intended owner, chain, deployment, block and source. A mismatch requires fresh analysis; it must not be silently accepted as a completed repair.

Any transaction output is **unsigned calldata for review**. The planner does not connect a wallet, sign, broadcast, schedule revocations, or authorize someone else to execute the plan. Both Permit2 repair functions act on `msg.sender`'s permissions; a caller cannot repair a different owner merely by supplying that owner's address in a report.

## Timing and trust boundary

All modeled repairs complete before any attacker or other permit execution. This is an analysis assumption, not a guarantee supplied by a list of calldata. Separate EOA transactions are not atomic. Even an atomic owner-authorized batch could be preceded by an attacker transaction, and requires an execution mechanism outside this planner.

The model cannot recover funds already withdrawn or prevent a competing transaction from landing first. Its snapshot and signature inventory are caller-supplied, not authenticated onchain or proven complete. Time, gas, token-to-Permit2 approvals and replenishment assumptions remain those of Exposure Map. New signatures, owner actions, changing contract or token behavior, and chain reorganizations require a new analysis. Wanted-permit preservation concerns authorization execution, not economic delivery or guaranteed token transfers.

## Close prior art

| Primary source | Existing behavior | Boundary of this experiment |
| --- | --- | --- |
| [IDEX error-code record, January 3, 2018](https://gist.github.com/raypulver/642a8b1162f1ec33e10d49dbfba75818) | The published record describes avoiding invalidation of outstanding orders and choosing the minimum nonce above canceled orders. | Selective invalidation while preserving wanted orders is established prior art. The gist is a historical specification artifact, not validation of the present Permit2 optimizer. |
| [Uniswap AllowanceTransfer documentation](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer) and source linked above | Per-owner/token/spender nonces, batch permissions, lockdown, and bounded nonce increases are existing protocol features. | The candidate searches over these primitives; it invents neither revocation nor nonce-based cancellation. |
| [MetaMask ApprovalRevocationEnforcer](https://github.com/MetaMask/delegation-framework/blob/main/src/enforcers/ApprovalRevocationEnforcer.sol) and [caveat documentation](https://github.com/MetaMask/delegation-framework/blob/main/documents/CaveatEnforcers.md) | Restricted delegated revocation distinguishes clearing an allowance from invalidating pending permits. | The planner adds a bounded selection problem; it does not establish a new authority or safe-execution mechanism. |
| [Revoke.cash Auto-Revoking, July 16, 2026](https://revoke.cash/blog/2026/how-auto-revoking-works-under-the-hood) | Approval monitoring and restricted automated revocation are implemented, with explicit best-effort race limitations. | This experiment generates a reviewable plan under a fixed snapshot; it is not a replacement for live monitoring or execution infrastructure. |

General combinatorial optimization and adversarial state-space exploration are also prior art; see the [Exposure Map comparison](EXPOSURE-RESEARCH.md). The research question is whether a faithful, small Permit2-specific planner can explain useful repair tradeoffs and provide reproducible evidence. No exhaustive prior-art search or new algorithmic theorem has established originality. Source publication records this implementation and date; it does not establish worldwide priority or standards approval.
