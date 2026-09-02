# SHOU — Technical Architecture & Task Split

Companion to [shou-idea.md](shou-idea.md) (problem/product PRD). This doc is implementation-level: repo layout, module boundaries, the one interface that lets two people build in parallel without blocking each other, and a day-by-day task list per developer.

---

## 1. Component map

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  DEV B — AI & surface        │        │  DEV A — chain & policy       │
│                               │        │                                │
│  Chrome Extension             │  risk  │  Circuit Breaker service       │
│  (content script + badge)     │ event  │  (Node, stateless glue)        │
│         │                     │──────▶ │         │                      │
│         ▼                     │        │         ▼                      │
│  Gonka Router client          │        │  @shou/driver (TS package)    │
│  (Layer 0 + Layer 3 scoring)  │        │         │                      │
│                               │        │         ▼                      │
│  Guardian Dashboard (web)     │◀─────  │  Sui Move contracts             │
│  Red Flag report UI           │ events │  (testnet)                      │
└─────────────────────────────┘        └──────────────────────────────┘
```

**The seam is one function call.** Everything Dev B builds ends in a call to `submitRisk()`. Everything Dev A builds starts from receiving that call. Neither side needs the other's code to run their own half — only the shared type definitions, agreed on Day 1 morning (Section 4).

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Chain | Sui testnet, Move 2024 edition | Per PRD |
| On-chain client | `@mysten/sui`, `@mysten/zklogin` | Standard SDKs |
| AI | Gonka Router HTTP API (gonkarouter.io) | Mandatory for Gonka track |
| Extension | Manifest V3, vanilla content script + small React popup | No build-tool overkill for a badge and a form |
| Backend glue | Node + Express, single process | One service, not microservices — nothing here needs more |
| Dashboard | Next.js (or plain React, whichever the team already has scaffolding for) | Only real requirement: reads on-chain events + calls the driver |
| Off-chain storage | SQLite or a single Postgres table for the Red Flag queue and message-hash log | No content stored — see PRD §9 — so this is small |

Skipped: message queue, container orchestration, multi-service split. `ponytail: single Node process is enough at hackathon scale — split into services only if the demo needs independent scaling, which it won't.`

## 3. Repo layout

```
shou/
  move/
    sources/
      policy.move          # SeniorityPolicy, TransferRequest (pause lives on the policy)
      redflag.move          # DenyList, BanEntry, AdminCap/StaffCap/OracleCap
    tests/
      policy_tests.move
      redflag_tests.move
  enclave/                # DEV A — TEE runtime: keys, signing, attestation,
    src/                  #   session binding. Imports Dev B's scorer; owns
      attestation.ts      #   none of the scoring logic itself.
      server.ts
      sign-fixture.ts
  packages/
    gonka-client/           # DEV B — Gonka Router scoring. Runs INSIDE the
      src/scorer.ts         #   enclave (see note in §7), not in the extension.
    driver/                 # DEV A — shared TS client, the seam both sides import
      src/
        client.ts
        types.ts
    circuit-breaker/         # DEV A — glue service
      src/server.ts
    extension/                # DEV B
      manifest.json
      src/
        content-script.ts
        background.ts
        badge.tsx
    dashboard/                  # DEV B (or split if time allows) — guardian web UI
      src/
    redflag-service/             # DEV B — report intake + Gonka scoring + queue
      src/
  docs/
    shou-idea.md
    shou-architecture.md
```

## 4. The shared interface (the one file both devs must agree on)

**Source of truth: [`shou/packages/driver/src/types.ts`](../shou/packages/driver/src/types.ts).** Read it there rather than from a copy in this doc — an out-of-date copy here is worse than none, since it is exactly the file that silently desyncs the two halves.

What Dev B needs to know about it:

- `RiskAssessment` is what Dev B **produces** (tier, Truth Score, Gonka Request ID, category, message hash). Dev A only ever consumes it.
- `CircuitBreakerAPI.submitRisk(sessionId, risk)` is the single call the extension makes. Everything Dev B builds ends here.
- `ShouClient` is the chain-facing side. Dev B's dashboard calls it; Dev B never imports Move or `@mysten/sui` directly.
- **The tier you submit is not necessarily the tier you get.** The contract independently escalates on amount and returns the stricter result, so always read `tier` off the returned `TransferState` rather than assuming your own value held.
- There is no `BLOCKED_DENYLIST` status: a banned recipient aborts before a request object exists, so that surfaces as a thrown error, not a state.

Dev A never imports Gonka Router — `RiskAssessment` arrives already scored.

## 5. Move module design

**Deployed to testnet and adversarially tested.** A security review found four critical issues in the first deployment; all are fixed, each has a regression test, and each fix was re-verified on-chain rather than only in unit tests.

| | |
|---|---|
| Package ID | `0xca22881f7d75c28f9df1a5e4f4572056f60a67c5d3fa29186ff71a8938464953` |
| Modules | `policy`, `redflag`, `enclave` |
| Tests | 37/37 passing (`sui move test`) |

`shou/move/Published.toml` tracks this per-environment and is committed — build against the ID there, not this table.

### What the review found, and what changed

| Issue | Why it mattered | Fix |
|---|---|---|
| `risk_tier` was taken purely from the caller | A large transfer declared LOW executed with **zero** approvals and no cooldown — proved on testnet by moving 0.5 SUI to an attacker address under a policy that required guardian approval. Worse for real users: a **phone scam** never touches WhatsApp, so the AI honestly reports LOW and the money leaves instantly. | `review_ceiling` / `high_risk_ceiling` on the policy; the chain derives its own tier from the amount and takes the stricter of the two. The AI can escalate, never de-escalate. |
| Any `DenyList` was accepted | An attacker could hand in a second, empty list and shed an active ban entirely. | `deny_list_id` bound into the policy at creation; verified on-chain (`EWrongDenyList`). |
| Anyone could mint a second `WalletGuard` | A fresh guard is unpaused and still "belongs to" the policy, so any pause was one object away from meaningless. | `WalletGuard` **deleted**; pause state moved into the policy itself, which cannot be re-minted. |
| HIGH-tier funds could be locked forever | Only an approver could `block`, so if guardians lost their keys the elder's money was stuck in the shared object permanently. | Owner-only `cancel_and_refund`. Refunds to the owner, so it grants an attacker nothing. |
| `report` had no access control | Anyone could ban any address and cut off a legitimate merchant. | Gated behind `OracleCap`, held by the Gonka scoring service — matching Flow C, where the AI scores *before* a ban lands. |
| `threshold = 0` was accepted | Silently turned M-of-N into 0-of-N, disabling HIGH-tier approval entirely. | `assert!(threshold > 0)`. |
| `VecMap` deny list | Saturates Sui's 256KB object cap at a few thousand bans, after which no new ban can be recorded. | `Table` (dynamic fields, no cap). |
| Ban was all-or-nothing | The PRD promises a *soft* ban that "allows daily necessities"; the code blocked everything. | `ban_ceiling` per entry — amounts at or below it still go through. |
| Any approver could undo a pause | One approver could clear the owner's emergency stop by pausing "until now". | `pause` is monotonic (extend-only); `unpause` is owner-only. |

### TEE layer (`shou::enclave` + `shou/enclave/`)

Nautilus-pattern attestation, so §9's privacy claim is enforced rather than promised. Message text is scored inside the enclave and discarded; only a sha256 hash, a tier and a Truth Score leave it.

- `EnclaveConfig` holds the PCR measurements (PCR0 boot / PCR1 code / PCR2 config) of the scoring code; `Enclave` holds the ephemeral public key generated in enclave memory at startup.
- Every score is signed over a BCS `RiskAttestation` **bound to the exact policy, recipient and amount**, so a verdict for a small payment to a known contact cannot be replayed to wave through a large one to a stranger. Verified: `tampered_amount_invalidates_the_signature`.
- Scores expire after 5 minutes — a stale verdict says nothing about the transfer in front of you.
- `policy::request_transfer_attested` is the attested path. Both paths are safe but for different reasons: unattested, a claimed tier can only ever make things *stricter*; attested, the tier is provably the output of the published scoring code, so a **low** score can be trusted too — which is what keeps ordinary payments frictionless instead of treating every one as suspect.

**Verified, not assumed:** `genuine_enclave_signature_verifies` checks a real ed25519 signature produced by the enclave against the bytes Move reconstructs. That test is also the guard against the TS and Move BCS layouts silently drifting apart — the failure mode where every real signature stops verifying on-chain and nothing else tells you.

**PRODUCTION GAP, stated plainly:** a complete Nautilus deployment passes the raw AWS attestation document to `register_enclave` and verifies its COSE signature and certificate chain on-chain — that is what proves the key came from an enclave running the measured code. That parsing lives in Mysten's Nautilus Move library and is not reimplemented here; registration is AdminCap-gated instead. **Signature verification is fully real; the *provenance* of the registered key currently rests on the admin rather than on AWS's root of trust.** Do not describe this as a verified enclave in the pitch until that swap is made and it is running on a Nitro instance.

**The demo moment this earns:** tell the contract a large transfer is LOW risk, and watch it refuse anyway. That is the difference between "our AI decides" and "the elder's own policy decides, and the chain enforces it" — and it is the honest answer to *"what if your AI is wrong, or compromised?"*

`shou/packages/driver/src/client.ts` implements `ShouClient` against this deployment and typechecks clean (`npx tsc --noEmit`; `skipLibCheck` works around an upstream `@mysten/sui@1.45.2` declaration bug, not a project issue).

**Known gap for Dev B:** `requestTransfer` can only split from the gas coin when the coin type is SUI. For a real stablecoin the caller must pass `paymentCoinIds`; the client throws a clear error rather than silently building a broken transaction.

## 6. Sequence — Flow B (the demo)

```
Elder's WhatsApp Web
   │ new message
   ▼
content-script.ts ──▶ scorer.ts ──▶ Gonka Router (3-model consensus)
                                        │ RiskAssessment { tier: HIGH, ... }
                                        ▼
                              badge.tsx renders 🔴 + Truth Score + Request ID
                                        │
                    (elder opens wallet, requests transfer — same session)
                                        ▼
                        POST /risk  (Circuit Breaker, Dev A)
                                        │ submitRisk(sessionId, risk)
                                        ▼
                     driver.requestTransfer(policyId, amount, recipient, risk)
                                        │
                                        ▼
                        Move: submit_transfer() → tier=HIGH → status=NEEDS_APPROVAL
                                        │ emits TransferPending
                                        ▼
                     Dashboard (listening on events) shows guardian the request
                                        │ guardian clicks Approve
                                        ▼
                     driver.approveTransfer(requestId, guardianAddr)
                                        │
                                        ▼
                        Move: approve() → threshold met → execute() → funds move
                                        │ emits TransferExecuted
                                        ▼
                     Dashboard shows "released" ; extension badge clears
```

## 7. Task distribution

Two developers, ~5–6 working days. Ownership by file path so there's no ambiguity about who touches what.

| Day | Dev A — chain & policy | Dev B — AI & surface | Shared |
|---|---|---|---|
| **1** | `move/sources/policy.move`, `move/sources/redflag.move` — full structs + entry fns + events. `move/tests/*` covering all 4 tiers, denylist, wrong-approver, double-approval. | `packages/gonka-client/src/scorer.ts` — Gonka Router HTTP wrapper, returns `RiskAssessment`. Build against a labeled test-message set (scam + benign), no extension yet. | Agree `packages/driver/src/types.ts` (Section 4) before splitting up. |
| **2** | `sui move test` green. Deploy to testnet. `packages/driver/src/client.ts` implementing `ShouClient` against the deployed package. zkLogin + sponsored tx wired — **run our own salt service** (SSO-style: app stores/returns `user_salt` keyed to the OAuth login), not user-managed salt. Confirmed via docs.sui.io: the zkLogin address is only as recoverable as the salt — lose the salt and the address is gone even with valid OAuth login, so a self-managed salt would silently break the "lost-device recovery" claim in shou-idea.md §5. | `packages/extension/` — Manifest V3 scaffold, `content-script.ts` reading a **scripted** WhatsApp Web DOM (per PRD §14, not live-scraping robustness), `badge.tsx` rendering tier/score/Request ID. | ✅ Dev A's side demoable standalone (scripted risk input → chain). ✅ Dev B's side demoable standalone (message → badge). Neither blocks the other. |
| **3** | `packages/circuit-breaker/src/server.ts` — implements `CircuitBreakerAPI.submitRisk`, correlates session risk × pending transfer, calls `driver.requestTransfer`. | `packages/dashboard/` — guardian view: pending requests (via on-chain event listener), approve button calling `driver.approveTransfer`. | **First real integration point** — Dev B's extension POSTs to Dev A's `/risk` endpoint. Test together. |
| **4** | Hash-anchoring: transfer/message hashes written on-chain for the audit trail (PRD §9). | `packages/redflag-service/` — report intake form, calls `scorer.ts`-style Gonka agent scoring, calls `driver.reportRedFlag`, staff queue view ranked by `amount × plausibility`. | |
| **5** | Buffer / bug-fix on chain side. Help wire Flow C denylist enforcement into `submit_transfer`. | Buffer / bug-fix on extension + dashboard. Polish badge UI (Truth Score, reasoning line, Request ID all visibly rendered — Gonka video requirement). | Joint: full Flow B and Flow C rehearsal, live. |
| **6** | — | — | README, demo video, submission. |

**Why this split holds up under time pressure:** Day 2 already leaves each side independently demoable (PRD §5's decoupling argument). If Day 3's integration slips, both developers still have something real to show separately rather than two unfinished halves of one thing.

### Ownership note added after the TEE landed

The TEE moved *where* Dev B's scorer runs, without changing what it is.

- **Dev B still owns all scoring** — `packages/gonka-client/src/scorer.ts`: endpoint, models, prompts, consensus rule, Truth Score. Unchanged deliverable.
- **It now executes inside the enclave** rather than in the extension, because a message that reaches Gonka straight from the browser never passes through a TEE, which would reduce §9's privacy claim to a promise. The extension POSTs to the circuit breaker, which forwards to the enclave, which calls Dev B's scorer.
- **Dev A owns the enclave runtime only** — `shou/enclave/`: keypair generation, BCS serialization, signing, attestation freshness, session binding, the three Nautilus endpoints.
- **The seam is the `Scorer` type** in `gonka-client/src/scorer.ts`, exactly as `types.ts` is the seam on the chain side. Same rule applies: changing its shape breaks the other half, so re-sync before doing it.

Practical consequence for Dev B: your code runs somewhere with no disk and no log aggregation. Return a verdict; never write message text anywhere.

**Blocker for Dev B to resolve with Jack:** a live call to `https://gonkarouter.io/api/v1/chat/completions` with model `kimi` returned **HTTP 404**. Those were Dev A's guesses, not documented values — confirm the real base URL and exact model IDs before building on them.

**Standup discipline for 2 people on a tight clock:** 10 minutes each morning, one question each — "did the interface in `types.ts` change?" If yes, both stop and re-sync before writing more code against it. That file is the only thing that can silently desync the two halves.
