# Korp Exposure Map: research boundary and prior art

Research review: September 25, 2026. This note defines a bounded experiment and its validation obligations. It does not establish novelty, priority, patentability, an audit result, or protection of a live wallet. Implementation and test status must be reported separately from this research note.

The prototype analyzes the maximum gross withdrawal permitted by a supplied inventory of EOA-signed **Permit2 AllowanceTransfer PermitBatch** messages and an initial allowance/nonce snapshot. It asks what cooperating spenders could collectively withdraw under a declared replenishment model, considering competing signatures, sequential nonce requirements, existing allowances, and atomic batches. It does not create another payment authorization mechanism.

The current result contains a maximizing witness and an input hash. Verification reruns the same compiler and solver, then separately replays the witness. It is a reproducibility check, not an independently implemented optimality verifier. Exporting exhaustive-state evidence for a separate checker remains a research objective.

The narrow research question is whether a dedicated compiler from authentic Permit2 messages to a small nonce-transition model, paired with an independently checkable exhaustive result, can make this analysis more transparent and practical than general contract-analysis tools. A bounded search did not identify the exact proposed end-to-end artifact. That absence is not evidence that nobody has implemented it.

## What the proposed contribution actually is

The candidate engineering contribution has three parts:

1. Verify the supplied typed-data signatures, preserve the real Permit2 nonce scopes and atomic update semantics, and compile the accepted subset to explicit transitions.
2. Compute an exact optimum over the reachable bounded state space, including zero-reward transitions that unlock later grants.
3. Return a maximizing order executable within the model; investigate exporting sufficient exhaustive-state evidence for a separate checker to establish the upper bound.

The optimizing search, dynamic programming, weighted set packing, signatures, nonce accounting, and proof certificates are not claimed as inventions. The compiler's fidelity and the usefulness of the resulting artifact are the questions to test. A trace proving that a withdrawal total is achievable is only a **lower-bound witness**. It does not establish maximality unless every alternative allowed by the declared model is also accounted for.

## Protocol model

Uniswap separates reusable AllowanceTransfer approvals from one-use SignatureTransfer authorizations. This project concerns the former. The actual scope of one ordered nonce is `(chainId, Permit2 contract, owner, token, spender)`, not merely the token or owner. Each batch has one spender and a signed ordered array of token details. Same numeric nonces for different spenders or tokens do not conflict. See the [official AllowanceTransfer documentation](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer) and [interface definitions](https://github.com/Uniswap/permit2/blob/main/src/interfaces/IAllowanceTransfer.sol).

For a deliberately restricted finite model:

- Fix a chain, verified Permit2 implementation, owner, snapshot, and evaluation timestamp `T`.
- Accept a bounded, explicitly supplied inventory. Verify the exact PermitBatch typed-data hash, its domain, and the claimed EOA signer. Reject unsupported inputs rather than silently removing them and retaining a complete-inventory claim.
- Maintain a nonce frontier for every relevant `(owner, token, spender)` slot. A batch is enabled only when all its required nonces match the current frontier; its successful execution advances all those slots atomically.
- Account for currently usable existing allowances before replacements. Subsequent permits replace slot amounts; they do not add to the stored allowance. However, the adversary may drain a usable allowance before the replacement, so gross withdrawals across sequential grants can add.
- Assume the modeled spenders can actually exercise their allowances and can cooperate. A contract spender may impose additional restrictions, so treating every spender as freely controlled is a stated worst-case assumption.
- Declare whether token-level approvals to Permit2 are unlimited, separately budgeted, or unsupported. These approvals are a distinct constraint from Permit2's internal allowances.
- Declare the replenishment model. Unrestricted replenishment makes this a measure of executable authorization capacity, not a prediction of current-wallet loss. Current balance, future deposits, and net loss are different quantities.

The domain includes the name `Permit2`, chain ID, and verifying-contract address; the PermitBatch hash also commits to detail ordering, spender, and signature deadline. Signature verification must match the accepted subset of the contract's behavior. EIP-1271 contract signatures are state-dependent and outside an EOA-only claim. Relevant primary implementations are [EIP712.sol](https://github.com/Uniswap/permit2/blob/main/src/EIP712.sol), [PermitHash.sol](https://github.com/Uniswap/permit2/blob/main/src/libraries/PermitHash.sol), and [SignatureVerification.sol](https://github.com/Uniswap/permit2/blob/main/src/libraries/SignatureVerification.sol).

**Smart-account owners are unsupported.** Permit2 uses ECDSA only when the owner address has no code; otherwise it calls the owner's ERC-1271 `isValidSignature`. That includes EOAs delegated under EIP-7702, whose address carries a delegation designator after the upgrade. For such an owner this model's ECDSA check can accept a signature the contract would reject, and the analysis says nothing about signatures the delegate would accept. Confirm the owner has no code at the analyzed block (`eth_getCode` returns `0x`) before relying on a result. Both 65-byte and 64-byte EIP-2098 signature encodings are accepted, matching `SignatureVerification`.

### Semantics that a faithful compiler must preserve

The [AllowanceTransfer implementation](https://github.com/Uniswap/permit2/blob/main/src/AllowanceTransfer.sol) checks `sigDeadline` when submitting a permit. It checks allowance expiration when transferring, not when installing a permit. Consequently, a zero-amount or already-expired grant can still advance nonces and unlock a later grant. `approve` and `lockdown` do not invalidate pending signatures; nonce invalidation does not zero an existing allowance. A batch reverts completely if any detail fails.

The [Allowance library](https://github.com/Uniswap/permit2/blob/main/src/libraries/Allowance.sol) maps expiration `0` to the execution timestamp and increments the 48-bit nonce with unchecked arithmetic. The finite monotone-frontier model must therefore explicitly exclude wrapping paths or model them. An amount equal to `uint160.max` is a nondecrementing allowance: with unlimited funding and no transfer-count bound, it means unbounded gross capacity, not that integer as a finite total.

Repeated token details inside a batch are another boundary: the contract processes them sequentially. Consecutive nonce values for the same slot can be valid, but intermediate amounts are overwritten before an EOA-signed permit returns. There is no opportunity to drain between those internal writes. A prototype should either model this order exactly or reject repeated slots with an explicit unsupported-input result.

## Why pairwise conflict counting is insufficient

For all examples below, every shared letter refers to the same owner, spender, chain, and Permit2 deployment; `X0=3` means a grant of three X units requiring X's current nonce to be zero. Initial amounts are zero, relevant deadlines are valid, no nonce wraps, funding is sufficient, and amounts are finite. Numeric totals use illustrative unit weights; they are not USD values.

| Fixture | Input | Correct model result | What it distinguishes |
| --- | --- | --- | --- |
| Three competing batches | `A=(X0=3,Y0=3)`, `B=(Y0=3,Z0=3)`, `C=(X0=3,Z0=3)` | At most one batch executes: total score 6, not the sum 18. | Atomic multi-slot conflicts. This restricted case is ordinary weighted set packing. |
| Sequential grants | `A=(X0=3)`, `B=(X1=4)` | Drain A before installing B: gross X capacity 7. | A maximum-per-slot calculation misses sequential authorization. |
| Cyclic prerequisites | `A=(X0=3,Y1=3)`, `B=(X1=3,Y0=3)`; initial frontier `(0,0)` | Neither batch can execute; total 0. | Distinct consumed nonce slots alone do not establish reachability. |
| Necessary zero grant | `A=(X0=0)`, `B=(X1=4)` | A enables B: gross X capacity 4. | Discarding nonprofitable transitions makes the result unsound. |
| Existing approval plus replacement | Current X allowance 2 at nonce 0; `A=(X0=3)` | Existing allowance can be drained first: gross X capacity 5. | Current approvals and signed future permissions must be analyzed together. |

The general problem is a bounded transition-system optimization, not merely a conflict graph. Weighted set packing already captures the special case where every usable message competes only at an initial frontier and no message enables another. The proposed compiler must expose this reduction honestly. Generalized packing and allocation solvers are established; see the [HP Labs report on generalized knapsack solvers and combinatorial allocation](https://shiftleft.com/mirrors/www.hpl.hp.com/techreports/2004/HPL-2004-21.pdf).

Different token amounts form a vector. A single scalar objective requires explicit nonnegative valuation weights with specified units and rounding. Per-token maxima computed separately may require mutually incompatible execution orders and must not be displayed as a jointly achievable portfolio. A scalar maximizing witness may be displayed with its actual jointly achieved token vector.

## Exactness and evidence obligations

Under finite allowances, unrestricted replenishment, unrestricted modeled spending, fixed `T`, and ordinary decrementing token approvals, draining a usable allowance before replacing it cannot hurt future nonce reachability. This supplies a possible normalization: drain existing permissions initially, then drain each successful batch's resulting permissions before the next batch. The compiler must prove the normalization for its accepted subset; it cannot assume it for arbitrary token contracts or callbacks.

A checker can validate an exhaustive recurrence over normalized states: the optimum at a frontier is the maximum of stopping and every enabled batch's immediate reward plus the optimum at its successor. It must recompute enabled transitions from the verified input inventory, check all successor references, confirm state deduplication, and reject omitted alternatives. A maximizing path alone, a hash of a result, or a solver's self-reported `optimal` flag is insufficient evidence of an upper bound.

The certificate must bind the entire input inventory, exact snapshot assumptions, timestamp, objective weights, supported-subset version, and result. Duplicate copies or alternative encodings of the same authorization must not create extra capacity. Public ECDSA verification authenticates a message; it does not authenticate the claimed initial onchain state or establish that the inventory contains every outstanding signature. Results based on supplied snapshots must say so. An exhausted state budget must produce an incomplete/unknown result or clearly separated lower and upper bounds, never an exact label.

Fixed-time, zero-gas-cost scheduling is an abstraction. Block capacity, fees, transaction inclusion, defensive revocations, changing token behavior, timestamps, unavailable replenishment, and future owner actions can alter a live outcome. A model trace should not be labeled a presently executable mainnet attack without independent execution validation against an authenticated state.

## Prior-art matrix

The table records concrete overlap, not merely projects with related names. Linked repositories on `main` or `master` are mutable; a reproducible release should pin the exact upstream commits it validates against. These sources were reviewed as documentation, code, or papers, not exercised against production wallets.

| Primary source | Established work and overlap | Boundary of the present candidate |
| --- | --- | --- |
| [Uniswap Permit2 source](https://github.com/Uniswap/permit2) and the specific implementation links above | Signed batches, ordered allowance nonces, atomic updates, expirations, and allowance revocation are the protocol itself. | The candidate consumes these semantics; it does not invent them. Compiler correctness is the main obligation. |
| [ERC-2612](https://eips.ethereum.org/EIPS/eip-2612) | Signed ERC-20 allowance changes with nonce and deadline checks. | Neither signed permissions nor pending-signature risk is new. This experiment handles Permit2's different per-token/per-spender batch state. |
| [Permit2 SignatureTransfer](https://github.com/Uniswap/permit2/blob/main/src/SignatureTransfer.sol) | One-use signed transfers use unordered nonce bitmaps. | This is a different state machine. A result for AllowanceTransfer must not be generalized to all Permit2 signatures. |
| [Resolving the Multiple Withdrawal Attack on ERC20 Tokens, 2019](https://arxiv.org/abs/1907.00903) | A spender can withdraw before an allowance adjustment and again afterward. | Counting sequential gross withdrawals is already known. The candidate extends analysis to a supplied inventory with multi-slot atomic prerequisites. |
| [Penny Wise and Pound Foolish, 2022](https://arxiv.org/abs/2207.01790) | Empirical quantification of unlimited ERC-20 approval risk and wallet/DApp approval behavior. | Approval exposure measurement is established. The scoped question here concerns combinable offchain batches, not a new discovery that approvals are risky. |
| [Revoke.cash Auto-Revoking, 2026](https://revoke.cash/blog/2026/how-auto-revoking-works-under-the-hood) | Approval indexing, exploit/risk/staleness detection, and restricted automated revocation. | The candidate is an inventory analyzer; monitoring and revocation are already implemented products. No remediation guarantee follows from a computed bound. |
| [MetaMask delegation caveat documentation](https://github.com/MetaMask/delegation-framework/blob/main/documents/CaveatEnforcers.md) | Scoped execution restrictions, balance constraints, and separate Permit2 allowance/nonce revocation surfaces. | General capability limits and permission revocation are prior art. This work would explain interactions in one existing authorization protocol. |
| [Clockwork Finance, 2021 preprint / 2023 publication](https://arxiv.org/abs/2109.04347) | A general formal framework models composed contracts and searches for economic extraction, with mechanized reasoning about adversarial behaviors. | This is strong prior art against “first exact maximum-loss analyzer.” The possible distinction is a smaller protocol-specific input/compiler/checker artifact, not a new optimization principle. |
| [ETHRACER: Exploiting the Laws of Order in Smart Contracts, 2018](https://arxiv.org/abs/1810.11605) | Contract event ordering, happens-before relationships, partial-order reduction, and witness traces. | Finding dangerous transaction orders and presenting reproducible witnesses are established. A Permit2-specific state reduction must demonstrate its own fidelity and benefit. |
| [HP Labs generalized knapsack/allocation solvers, 2004](https://shiftleft.com/mirrors/www.hpl.hp.com/techreports/2004/HPL-2004-21.pdf) | Established combinatorial allocation and packing optimization. | The triangle example is not a novel algorithm. Nonce-enabling transitions are why the full compiler cannot stop at that example. |
| [Microsoft CCF programmable governance ballots](https://ccf.dev/main/governance/proposals.html) | Individual ballot programs read KV state and are reevaluated as voting progresses. | Defeats a broad claim that conditional, state-sensitive ballots are new; discussed below as a rejected direction. |
| [Authenticated aggregate index structures](https://open.bu.edu/server/api/core/bitstreams/21e84d67-af20-46c2-83f6-68678277ae22/content) | Dynamic authenticated aggregation includes MIN/MAX over ranges. | Merkle-backed historical boundaries do not by themselves rescue the novelty of trajectory ballots. |

## Rejected directions and why they remain rejected

**Payment nonces as commitments.** [Roundhouse KYA](https://roundhouseai.io/kya) documents placing a signed-document digest in an EIP-3009 payment nonce. The earlier local review also recorded [Warrant SDK 0.1.1](https://pypi.org/project/warrant-sdk/0.1.1/) and [Verifiable Invoice Commitment](https://github.com/javierpmateos/verifiable-invoice-commitment). Their scope is documented in `docs/pilot/PROMISE-PRIOR-ART-UPDATE.md`; this research pass independently reread Roundhouse, while the PyPI page could not be fetched. These examples rule out promoting payment-bound terms or invoice commitments as a newly invented primitive. A different combination would need its own precise evidence.

**Trajectory-bound governance ballots.** The candidate let each voter define a numeric interval that must hold continuously from a signed checkpoint through execution; the first crossing permanently removed support. It catches a state change and restoration that a current-value guard misses. However, CCF's per-member programs can express the same predicate when an application supplies a history accumulator. [DAOkit's extensible condition engine](https://github.com/samouraiworld/gnodaokit) is additional programmable-governance prior art. Authenticated range minima/maxima, per-query starting indices, and permanent runtime-monitor failures are known techniques. A dual-heap first-crossing index might improve a particular workload over replaying every ballot, but no new algorithmic result or quantitative advantage was established here. The direction was not selected as a claimed invention.

**Approval auto-revocation.** Revoke.cash already publishes a functioning architecture for restricted revocation. Binding additional history predicates to permissions is an implementation choice until a specific unaddressed property and advantage are demonstrated.

## Scope exclusions and release conditions

The accepted input profile and result must explicitly disclose unsupported features: SignatureTransfer permits, ERC-2612/EIP-3009 messages, arbitrary call permissions, contract signatures, nonce wrapping, duplicate slot details if not modeled, time-varying schedules, arbitrary token callbacks, fee-on-transfer/rebasing/blacklist behavior, and any absent token-level allowance or balance constraints. Excluding one of these does not prove that it creates zero exposure.

Before a public exactness claim, the project needs adversarial fixtures for wrong domains/signers, modified array order, expiration boundaries, necessary zero/expired predecessors, different-spender nonce isolation, duplicate inventory entries, existing allowances, sequential grants, atomic rollback, cyclic prerequisites, unsupported unlimited grants, numeric precision, and incomplete-search certificates. Differential execution against pinned official Permit2 code would test the compiler boundary; an independently implemented checker would test the exhaustive-result boundary. Passing a few synthetic examples is not a formal proof of the compiler.

Publishing source under the project's official account would establish an accessible, attributable record of this implementation and its publication date. It would not establish first invention, exclusive ownership of the underlying techniques, patent eligibility, or priority over undiscovered work. No public publication, deployment, real-fund action, or production change is asserted by this note. The strongest current claim is a **bounded Permit2 authorization-capacity research prototype with explicit assumptions and checkable results**, with exact implementation status reported separately.
