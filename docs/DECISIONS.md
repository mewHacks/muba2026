# SHOU — build record

Technology choices, the design decisions that carry weight, and every blocker
we hit with how it was resolved or worked around.

Shareable version: <https://claude.ai/code/artifact/2aaabe8e-7705-404d-b688-f35887fd79d8>

| | |
|---|---|
| Network | Sui Testnet |
| Tests | 57 passing (38 Move, 6 multisig, 7 redaction, 6 session-binding) |
| Critical security bugs found and fixed | 5 |
| Deployments | 3 (republished; struct/visibility changes forbid upgrades) |
| Open blockers | 1 — Gonka Router |

---

## 1. What we used, and for what

| Layer | Technology | Function | Why this one |
|---|---|---|---|
| Policy engine | Sui Move, 2024 edition | Tiered transfers, escrow, guardian approval, deny list | Shared objects let several people act on one wallet without anyone taking custody. Capabilities let us model "may block" separately from "may spend". |
| Asset | Testnet USDC | The money being guarded | Elders think in dollars. A guard denominated in a volatile token protects nothing. |
| Client | `@mysten/sui` 2.28, `SuiGrpcClient` | Builds and submits transactions | JSON-RPC is deprecated on public fullnodes. We were on 1.45 and had to migrate mid-build. |
| Coin handling | `coinWithBalance` | Takes N of any coin type from the sender | `splitCoins(tx.gas, …)` silently only works for SUI — it broke the moment we moved to USDC. |
| Private compute | Nautilus pattern, ed25519, BCS | Scores messages, signs a verdict bound to one transfer | The message is scored where nobody can read it; only a hash, a tier and a signature leave. The chain verifies that signature itself. |
| Scoring model | Gonka Router | Classifies scam messages | Called from *inside* the enclave. If the extension called it directly the message would leave the device unprotected, and the privacy claim would be a promise rather than a property. |
| Sign-in | zkLogin + Enoki | Wallet access via Google | An 80-year-old will not write down twelve words. |
| Recovery | Weighted multisig 2·1·1, threshold 2 | Keeps funds reachable if zkLogin dies | Weights, not counts: she alone meets the threshold; her son alone never does; two relatives together can recover. |
| Privacy | Idempotent regex redaction | Strips PII before anything is scored | Runs twice — client and enclave — so a stale or bypassed client cannot cause raw PII to be scored. |
| Glue | Circuit breaker (Node HTTP) | Carries verdicts between extension and enclave | Deliberately dumb: holds no message text, makes no judgements. Compromising it yields hashes and tiers, not conversations. |
| Runtime | Node `--experimental-strip-types` | Runs TypeScript with no build step | One fewer moving part in a three-day build. The browser bundle still goes through esbuild. |

---

## 2. The decisions that carry weight

**The AI can tighten the rules; it can never loosen them.**
`submit_transfer` takes `max_tier(amount_tier, reported_tier)`. Tell the
contract a large transfer is low-risk and it escalates anyway. This is the
answer to *"what if your AI is wrong, or compromised?"* — you do not have to
trust it.

**Her pre-committed policy holds the authority — not her, not her family.**
Authority cannot rest with the elder (she is being manipulated at that exact
moment) nor with relatives (family members are a leading vector for elder
financial abuse). Guardians can block a transfer and refund it to her; they
can never redirect it.

**Non-custodial by construction, not by promise.**
`AdminCap` appears nowhere in `policy.move`. There is no code path by which we
move her money — checkable in source rather than asserted in a pitch.

**Keep the verdict, never the message.**
Attestations bind to one transfer, but messages are scored minutes before any
transfer exists. Caching text outside the enclave would put plaintext where the
host can read it. The enclave retains a tier and a hash; entries expire.

**Risk is filed against the policy, not the caller's session id.**
The session id comes from the caller. Keyed on that alone, a compromised
extension could score a scam HIGH, then request the attestation under a fresh
id and get a clean LOW.

**Never return a coin to whoever called you.**
Sui's composability guidance says public functions should return objects rather
than transfer internally. Applied to a `Coin<T>` held by a *shared* object,
that guidance produces a theft vector — and it produced ours. Anything holding
value in a shared object is `public(package)`, with an entry wrapper that fixes
the destination.

---

## 3. What broke, and what we did

The pattern worth noting: the three worst bugs were the same mistake — trusting
an input the contract should have decided for itself — and none were caught by
unit tests.

### Phase 1 — Contracts

| Blocker | Resolution | Status |
|---|---|---|
| **CRITICAL — the contract believed whatever risk level the caller claimed.** Proven, not theorised: we moved 0.5 SUI to an attacker address on live testnet with zero approvals by declaring the transfer low-risk. | Escalate on amount on-chain, so the caller's claim is a floor rather than the whole truth. | Fixed |
| **CRITICAL — `execute` handed the coin to whoever called it.** `TransferRequest` is shared, so anyone could wait for a transfer to unlock and route the money to themselves; the event still named the intended recipient, so it looked like a successful payment. | `public(package)` + entry wrapper. Calling it directly on the live package now fails with `NonEntryFunctionInvoked`. | Fixed |
| **CRITICAL — objects could be substituted at call time.** Any `DenyList` was accepted; anyone could mint a second, unpaused wallet guard. | Bound `deny_list_id` into the policy at creation; deleted the guard object entirely and folded pause into the policy. | Fixed |
| Funds could be locked forever — a HIGH transfer whose guardians never responded stranded the money. | Owner-only `cancel_and_refund`. | Fixed |
| Smaller authority bugs: unauthenticated reporting, a threshold of zero accepted, all-or-nothing bans, an approver able to unpause, and a `VecMap` deny list that would hit Sui's 256 KB object cap. | All fixed; bans became soft ceilings, storage became a `Table`. | Fixed |
| The Move testing guidance said cleanup after an expected abort is dead code; the compiler rejected every such test with "unused value without drop". | **We trusted the compiler.** | Fixed |
| Struct and visibility changes forbid package upgrades, so each such fix forced a full republish and churned every object id. | Accepted the churn; wrote a seeding script that regenerates a live policy and pending transfer after each deploy. | Worked around |

### Phase 2 — The enclave

| Blocker | Resolution | Status |
|---|---|---|
| Valid signatures rejected as being from the future — Sui's on-chain `Clock` trails wall-clock time. **All 37 unit tests passed straight through this**; it only appeared against a real network. | 60-second skew tolerance. | Fixed |
| A restart silently killed every attestation. The key is generated in memory and never persisted (correct for a real TEE), so a restart leaves a dead key registered on-chain and everything aborts with a cryptic `EInvalidSignature`. | Re-registration script plus a loud startup warning. | Fixed |
| One environment variable did two unrelated jobs — the test-scorer flag also suppressed auto-start, so the enclave could not run standalone on the fallback scorer. | Split into two flags. | Fixed |
| No AWS Nitro instance, so there is no attestation *document*; key registration is admin-gated rather than hardware-proven. Signing and on-chain verification are fully real. | Labelled `PRODUCTION GAP` in the contract source and stated aloud in the demo. | Stated limitation |
| A signed attestation can be replayed inside its 5-minute window. Not exploitable today — each use needs the owner's signature, her own coins, and passes the ceilings regardless — but critical the moment an attested LOW may skip escalation. | Documented and queued. | Open, accepted |

### Phase 3 — SDK and client

| Blocker | Resolution | Status |
|---|---|---|
| JSON-RPC is deprecated on public fullnodes, and failed quietly rather than loudly. | Migrated the driver to `SuiGrpcClient`; SDK 1.45 → 2.28. | Fixed |
| Three response-shape bugs only a real network revealed: gRPC effects omit `objectType`; `idOperation` is `Created`, not `CREATED`; `getObject` needs `include: { json: true }` or returns raw BCS. | Fixed each. | Fixed |
| On-chain types are fully qualified (`0x0000…0002::sui::SUI`), so matching against `0x2::sui::SUI` never hit. | Normalise before comparing. | Fixed |
| The shared interface omitted the coin type — a USDC approval from the second developer's dashboard would have silently built the wrong Move call and aborted on-chain. | Added `coinType` to the interface. | Fixed |
| Two packages pinned different SDK majors. | The circuit breaker never imported the SDK, so the dependency was deleted rather than upgraded; the enclave moved to 2.28, and we regenerated the cross-language fixture to *prove* the BCS byte layout still matched the Move serialiser. | Fixed |

### Phase 4 — Sign-in and recovery

| Blocker | Resolution | Status |
|---|---|---|
| **zkLogin is a derived address** — no seed phrase, not exportable, losing the salt is fatal. Flagged by a mentor. That makes it unsuitable *alone* for money that matters. | Kept zkLogin for sign-in; put funds behind a weighted multisig so the address survives zkLogin failing. | Design changed |
| Sign-in reported "signed out" with no error. Our own bug: the address lives on the flow's zkLogin state, not the session object we read. | Found by **adding a diagnostics panel rather than guessing** — it printed the session keys and the answer was immediate. | Fixed |
| OAuth rejected the client with `invalid_client_id`. | The Enoki portal needs *both* the allowed origin and the Google client id; either alone fails with the same opaque message. | Fixed |
| The multisig signer's types disagreed with its implementation (variadic in code, single-element tuple in types), so two-party signing would not compile. | Combined the partial signatures directly. | Worked around |

### Phase 5 — Demo hardening

| Blocker | Resolution | Status |
|---|---|---|
| **CRITICAL — the interface invented model output when the backend returned none**: a truth score of 90, a request id of `req-1`, a confident sentence of reasoning. With the model provider down, a judge would have seen fabricated AI output presented as real. | The page now says "not returned". | Fixed |
| The risk check ignored what you typed and always sent a hardcoded scam string, so a benign message still scored HIGH. A demo that cannot fail proves nothing. | Reads the textarea; the page invites you to try a harmless message. | Fixed |
| The demo pointed at a policy that does not exist — the id was hardcoded to the Move unit-test fixture address, so attestations signed cleanly and would fail only on submission. | Read from seeded ids; refuse to proceed without them. | Fixed |
| Wildcard CORS on the unauthenticated front door to the enclave: any site the elder opened could score into her session and pull signed attestations. **The scam site could drive the thing built to catch it.** | Restricted to our own origins. | Fixed |
| Two services both defaulted to port 3000, so whichever started second died. | Sign-in keeps 3000 (the OAuth origin is registered against it); the enclave moved to 3100. | Fixed |
| A fix that quietly defeated another fix: the risk endpoint forwarded a placeholder policy id, filing verdicts under the zero address while the transfer step looked up the real policy. | Caught by running the whole chain rather than the pieces. | Fixed |
| Redaction left people identifiable — the card rule ate a trailing space, the phone rule only partially matched international numbers, and a partially redacted phone number still identifies someone. | Fixed both rules. | Fixed |
| Editing the source changed nothing in the browser, because the page loads a bundled artifact — so a fixed bug appeared unfixed. | Documented in the runbook as the first thing to check. | Fixed |

### Phase 6 — Environment

| Blocker | Resolution | Status |
|---|---|---|
| A hung module import, blocking forever at zero CPU, looked exactly like a Node 26 loader deadlock — we went as far as downloading an older Node to test the theory. **The real cause was the tooling sandbox blocking a module load; Node and the SDK were both fine.** Recorded because the wrong diagnosis was very convincing. | Diagnosis corrected. | Resolved |
| A crashed git process left a stale lock and an empty branch ref; every file showed as newly added. | The lock's contents held the intended commit; restored with `update-ref`. No commits lost. | Fixed |

---

## 4. Still open

**Blocking — owned by the AI side of the team.** The Gonka Router returns 404
for both models. Everything around it works: the enclave, redaction, session
binding, the circuit breaker, the attestation and its on-chain verification.
The model call itself fails, so scoring falls back to a keyword heuristic that
labels itself *"DEV MODE heuristic — not a real classifier"* on screen.

The honest framing is a good one: the fallback misses subtle openers like *"may
I confirm you purchased something for RM2000 online?"* precisely because it is
keyword matching. **That gap is the argument for putting a real model inside
the enclave.**

**Queued, not blocking.** Attestation replay within the freshness window; no way
to revoke a compromised enclave key; the policy pins a deny list but not an
enclave config; and the upgrade capability is still live — burned on submission
day, deliberately last.

---

Everything here was verified by running it, not from recollection. Where
something is unproven — the enclave's hardware attestation, the model provider
— it is marked as such rather than rounded up.
