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
      policy.move          # SeniorityPolicy, TransferRequest, WalletGuard
      redflag.move          # DenyList, BanEntry, StaffCap
    tests/
      policy_tests.move
      redflag_tests.move
  packages/
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
    gonka-client/              # DEV B — Layer 0 + Layer 3 scoring wrapper
      src/
        scorer.ts
        types.ts
    dashboard/                  # DEV B (or split if time allows) — guardian web UI
      src/
    redflag-service/             # DEV B — report intake + Gonka scoring + queue
      src/
  docs/
    shou-idea.md
    shou-architecture.md
```

## 4. The shared interface (write this first, together, Day 1 morning)

This is the only file both developers need to agree on before splitting up. Put it in `packages/driver/src/types.ts`.

```ts
// packages/driver/src/types.ts

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

/** Output of Gonka Router scoring — Dev B produces this, Dev A only ever consumes it. */
export interface RiskAssessment {
  tier: RiskTier;
  truthScore: number;      // 0–100, Gonka's Truth Score
  requestId: string;       // Gonka Request ID — must be displayed in UI per submission reqs
  category: string;        // e.g. "urgency + unknown recipient"
  messageHash: string;     // sha256 of the source message — never the message itself
}

/** Dev B's extension calls this after every scored message. Dev A implements it. */
export interface CircuitBreakerAPI {
  submitRisk(sessionId: string, risk: RiskAssessment): Promise<void>;
}

/** The chain-facing client. Dev A implements against Move; Dev A's Circuit Breaker
 *  and Dev B's dashboard both call this — it's the only way either side touches Sui. */
export interface ShouClient {
  createPolicy(owner: string, approvers: string[], threshold: number,
               cooldownMs: number, highRiskCeiling: number): Promise<{ policyId: string }>;

  submitTransferRequest(policyId: string, amount: number, recipient: string,
                         risk: RiskAssessment): Promise<{
    requestId: string;
    tier: RiskTier;
    unlockAtMs: number;
    status: 'PENDING' | 'AUTO_UNLOCK_SCHEDULED' | 'NEEDS_APPROVAL' | 'BLOCKED_DENYLIST';
  }>;

  approveTransfer(requestId: string, approver: string): Promise<{ status: string }>;

  getTransferStatus(requestId: string): Promise<{ status: string; approvals: string[] }>;

  reportRedFlag(address: string, evidence: { description: string; txHash?: string }):
    Promise<{ plausibilityScore: number; banStatus: 'SOFT_BANNED' | 'QUEUED' }>;
}
```

Dev B never imports Move or `@mysten/sui` — only this file's types, plus a thin HTTP wrapper Dev A exposes (`POST /risk` on the Circuit Breaker service, implementing `submitRisk`). Dev A never imports Gonka Router — only `RiskAssessment` arrives as an input, already scored.

## 5. Move module design

**Implemented and passing — `shou/move/`, 16/16 tests green (`sui move build && sui move test`).** This replaced the original `abort 0` stub; the shape below is what's actually deployed, not a plan.

**Deployed to testnet, round-tripped for real** (not just published — a full `create_policy` → `create_guard` → `create_deny_list` → `request_transfer` → `execute_and_send` sequence was run against these live objects, confirming `funds: "0"` / `executed: true` on the final object read):

| | |
|---|---|
| Package ID | `0x924fb6c20412093e657aeb5086a2da9f093b06c257815236d74a0846afa14b38` |
| Modules | `policy`, `redflag` |
| `AdminCap` (owner: deployer) | `0x347c0654d38c5791ef752dbf5c900d2a56b66f80f5c3ef094e56706e355c2c0b` |
| `UpgradeCap` | `0x8d756c1ccf6562b01ac0aed79098a29082a1d292d4e7232ba7de687efb1ac20b` |

`shou/move/Published.toml` tracks this per-environment and is committed — anyone building against testnet reads the package ID from there, not from this table (this table exists so Dev B doesn't have to go find it).

`shou/packages/driver/src/client.ts` implements `ShouClient` against this deployment — typechecks clean (`npx tsc --noEmit`, `skipLibCheck: true` needed to work around an unrelated upstream `@mysten/sui@1.45.2` declaration bug, not a project issue) and every method was exercised by the round-trip above via direct `sui client call`/`ptb` (the same calls `client.ts` makes), before wiring the SDK version.

```move
module shou::policy;

// Errors use #[error] + EPascalCase (naming-conventions skill) — omitted
// here for brevity, see shou/move/sources/policy.move for the full list.

const TIER_LOW: u8 = 0;
const TIER_MEDIUM: u8 = 1;
const TIER_HIGH: u8 = 2;

public struct SeniorityPolicy has key {
    id: UID,
    owner: address,
    approvers: vector<address>,
    threshold: u8,
    cooldown_ms: u64,
}

public struct TransferRequest<phantom T> has key {
    id: UID,
    policy_id: ID,
    recipient: address,
    risk_tier: u8,          // 0=LOW 1=MEDIUM 2=HIGH — set from RiskAssessment.tier
    approvals: vector<address>,
    unlock_at_ms: u64,
    executed: bool,
    blocked: bool,
    funds: Balance<T>,
}

// Self-serve panic button: owner or any registered approver can pause new
// submissions. Doesn't affect transfers already pending. ponytail: no
// automatic Circuit-Breaker-triggered pause yet — add a scoped capability
// for that service when it exists.
public struct WalletGuard has key {
    id: UID,
    owner: address,
    policy_id: ID,
    paused_until_ms: u64,
}

// Events past-tense per naming-conventions — dashboard listens on these
// instead of polling.
public struct PolicyCreated has copy, drop { policy_id: ID, owner: address }
public struct TransferRequested has copy, drop { request_id: ID, policy_id: ID, tier: u8, unlock_at_ms: u64 }
public struct TransferReleaseApproved has copy, drop { request_id: ID, approver: address }
public struct TransferBlocked has copy, drop { request_id: ID, blocked_by: address }
public struct TransferExecuted has copy, drop { request_id: ID, amount: u64, recipient: address }
public struct WalletPaused has copy, drop { owner: address, paused_until_ms: u64 }

// Composable core (returns objects/values) + entry wrapper (shares/sends)
// for each action — composable-move-functions skill.
public fun new_policy(approvers: vector<address>, threshold: u8, cooldown_ms: u64, ctx: &mut TxContext): SeniorityPolicy;
entry fun create_policy(approvers: vector<address>, threshold: u8, cooldown_ms: u64, ctx: &mut TxContext);

public fun new_guard(policy: &SeniorityPolicy, ctx: &mut TxContext): WalletGuard;
entry fun create_guard(policy: &SeniorityPolicy, ctx: &mut TxContext);
entry fun pause(guard: &mut WalletGuard, policy: &SeniorityPolicy, until_ms: u64, ctx: &TxContext);

// LOW-tier requests still go through this object rather than paying out
// inline: unlock_at_ms is "now", so a client chains request_transfer +
// execute in one PTB for an instant release — no special-cased code path.
public fun submit_transfer<T>(policy: &SeniorityPolicy, guard: &WalletGuard, deny_list: &DenyList,
    payment: Coin<T>, recipient: address, risk_tier: u8, clock: &Clock, ctx: &mut TxContext): TransferRequest<T>;
entry fun request_transfer<T>(/* same params */): (); // wraps submit_transfer + shares

entry fun approve<T>(request: &mut TransferRequest<T>, policy: &SeniorityPolicy, ctx: &TxContext);

// Guardian cancels a pending transfer — "guardian can only stop, not
// approve faster" (shou-idea.md §7). Returns funds; entry wrapper sends
// them to the owner.
public fun block<T>(request: &mut TransferRequest<T>, policy: &SeniorityPolicy, ctx: &mut TxContext): Coin<T>;
entry fun block_and_refund<T>(request: &mut TransferRequest<T>, policy: &SeniorityPolicy, ctx: &mut TxContext);

// HIGH needs `threshold` approvals; LOW/MEDIUM need the cooldown elapsed.
// Callable by anyone once unlocked, not just the owner.
public fun execute<T>(request: &mut TransferRequest<T>, policy: &SeniorityPolicy, clock: &Clock, ctx: &mut TxContext): Coin<T>;
entry fun execute_and_send<T>(request: &mut TransferRequest<T>, policy: &SeniorityPolicy, clock: &Clock, ctx: &mut TxContext);
```

```move
module shou::redflag;

// Minted once at package `init` to the publisher. Required to mint any
// StaffCap — without this gate, anyone could mint themselves one and
// clear a scammer's own ban.
public struct AdminCap has key, store { id: UID }
public struct StaffCap has key, store { id: UID }

public struct BanEntry has store, drop { plausibility_score: u8, reported_at_ms: u64 }
public struct DenyList has key { id: UID, banned: VecMap<address, BanEntry> }

public struct AddressBanned has copy, drop { addr: address, plausibility_score: u8 }
public struct AddressCleared has copy, drop { addr: address }

public fun new_staff_cap(_admin: &AdminCap, ctx: &mut TxContext): StaffCap;
entry fun create_staff_cap(admin: &AdminCap, recipient: address, ctx: &mut TxContext);

// Anyone can report — Layer 3 landing on-chain. plausibility_score comes
// from Gonka Router, already scored off-chain; this only enforces the
// resulting state. Re-reporting an already-banned address refreshes the
// score rather than erroring — repeat reports are corroborating evidence.
entry fun report(list: &mut DenyList, addr: address, plausibility_score: u8, clock: &Clock);
entry fun clear(list: &mut DenyList, _staff: &StaffCap, addr: address);
public fun is_banned(list: &DenyList, addr: address): bool;
```

Full source: [shou/move/sources/policy.move](../shou/move/sources/policy.move), [shou/move/sources/redflag.move](../shou/move/sources/redflag.move). Tests: [shou/move/tests/](../shou/move/tests/).

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
                     driver.submitTransferRequest(policyId, amount, recipient, risk)
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
| **3** | `packages/circuit-breaker/src/server.ts` — implements `CircuitBreakerAPI.submitRisk`, correlates session risk × pending transfer, calls `driver.submitTransferRequest`. | `packages/dashboard/` — guardian view: pending requests (via on-chain event listener), approve button calling `driver.approveTransfer`. | **First real integration point** — Dev B's extension POSTs to Dev A's `/risk` endpoint. Test together. |
| **4** | Hash-anchoring: transfer/message hashes written on-chain for the audit trail (PRD §9). | `packages/redflag-service/` — report intake form, calls `scorer.ts`-style Gonka agent scoring, calls `driver.reportRedFlag`, staff queue view ranked by `amount × plausibility`. | |
| **5** | Buffer / bug-fix on chain side. Help wire Flow C denylist enforcement into `submit_transfer`. | Buffer / bug-fix on extension + dashboard. Polish badge UI (Truth Score, reasoning line, Request ID all visibly rendered — Gonka video requirement). | Joint: full Flow B and Flow C rehearsal, live. |
| **6** | — | — | README, demo video, submission. |

**Why this split holds up under time pressure:** Day 2 already leaves each side independently demoable (PRD §5's decoupling argument). If Day 3's integration slips, both developers still have something real to show separately rather than two unfinished halves of one thing.

**Standup discipline for 2 people on a tight clock:** 10 minutes each morning, one question each — "did the interface in `types.ts` change?" If yes, both stop and re-sync before writing more code against it. That file is the only thing that can silently desync the two halves.
