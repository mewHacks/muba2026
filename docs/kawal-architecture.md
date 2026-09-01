# Kawal — Technical Architecture & Task Split

Companion to [kawal-idea.md](kawal-idea.md) (problem/product PRD). This doc is implementation-level: repo layout, module boundaries, the one interface that lets two people build in parallel without blocking each other, and a day-by-day task list per developer.

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
│  Gonka Router client          │        │  @kawal/driver (TS package)    │
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
kawal/
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
    kawal-idea.md
    kawal-architecture.md
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
export interface KawalClient {
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

```move
module kawal::policy {
    use sui::clock::Clock;

    const ELOW_THRESHOLD_BREACH: u64 = 0;
    const ENOT_SUBMITTED: u64 = 1;
    const EDENYLISTED: u64 = 2;
    const EALREADY_APPROVED: u64 = 3;
    const ETHRESHOLD_NOT_MET: u64 = 4;

    public struct SeniorityPolicy has key {
        id: UID,
        owner: address,
        approvers: vector<address>,
        threshold: u8,
        cooldown_ms: u64,
        high_risk_ceiling: u64,
        policy_change_cooldown_ms: u64,
    }

    public struct TransferRequest has key {
        id: UID,
        policy_id: ID,
        amount: u64,
        recipient: address,
        risk_tier: u8,          // 0=LOW 1=MEDIUM 2=HIGH — set from RiskAssessment.tier
        approvals: vector<address>,
        unlock_at_ms: u64,
        executed: bool,
    }

    public struct WalletGuard has key {
        id: UID,
        owner: address,
        paused_until_ms: u64,
    }

    // Events — the dashboard listens on these instead of polling.
    public struct TransferPending has copy, drop { request_id: ID, tier: u8, unlock_at_ms: u64 }
    public struct TransferApproved has copy, drop { request_id: ID, approver: address }
    public struct TransferExecuted has copy, drop { request_id: ID, amount: u64, recipient: address }

    public fun create_policy(/* ... */): SeniorityPolicy { /* ... */ abort 0 }
    public fun submit_transfer(policy: &SeniorityPolicy, amount: u64, recipient: address,
                                risk_tier: u8, clock: &Clock, ctx: &mut TxContext): TransferRequest { abort 0 }
    public fun approve(req: &mut TransferRequest, policy: &SeniorityPolicy, ctx: &TxContext) { abort 0 }
    public fun execute<T>(req: &mut TransferRequest, policy: &SeniorityPolicy,
                           funds: &mut sui::balance::Balance<T>, clock: &Clock, ctx: &mut TxContext) { abort 0 }
}

module kawal::redflag {
    public struct DenyList has key { id: UID }
    public struct StaffCap has key, store { id: UID }

    public struct BanEntry has store {
        plausibility_score: u8,
        reported_at_ms: u64,
        status: u8,   // 0=soft-banned 1=cleared 2=confirmed
    }

    public struct AddressBanned has copy, drop { addr: address, plausibility_score: u8 }

    public fun report(list: &mut DenyList, addr: address, plausibility_score: u8,
                       clock: &sui::clock::Clock) { abort 0 }
    public fun is_banned(list: &DenyList, addr: address): bool { abort 0 }
    public fun clear(_: &StaffCap, list: &mut DenyList, addr: address) { abort 0 }
}
```

Function bodies deliberately left as `abort 0` stubs here — Dev A fills these in Day 1, this section exists so Dev B can see the shape immediately and doesn't wait.

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
| **2** | `sui move test` green. Deploy to testnet. `packages/driver/src/client.ts` implementing `KawalClient` against the deployed package. zkLogin + sponsored tx wired. | `packages/extension/` — Manifest V3 scaffold, `content-script.ts` reading a **scripted** WhatsApp Web DOM (per PRD §14, not live-scraping robustness), `badge.tsx` rendering tier/score/Request ID. | ✅ Dev A's side demoable standalone (scripted risk input → chain). ✅ Dev B's side demoable standalone (message → badge). Neither blocks the other. |
| **3** | `packages/circuit-breaker/src/server.ts` — implements `CircuitBreakerAPI.submitRisk`, correlates session risk × pending transfer, calls `driver.submitTransferRequest`. | `packages/dashboard/` — guardian view: pending requests (via on-chain event listener), approve button calling `driver.approveTransfer`. | **First real integration point** — Dev B's extension POSTs to Dev A's `/risk` endpoint. Test together. |
| **4** | Hash-anchoring: transfer/message hashes written on-chain for the audit trail (PRD §9). | `packages/redflag-service/` — report intake form, calls `scorer.ts`-style Gonka agent scoring, calls `driver.reportRedFlag`, staff queue view ranked by `amount × plausibility`. | |
| **5** | Buffer / bug-fix on chain side. Help wire Flow C denylist enforcement into `submit_transfer`. | Buffer / bug-fix on extension + dashboard. Polish badge UI (Truth Score, reasoning line, Request ID all visibly rendered — Gonka video requirement). | Joint: full Flow B and Flow C rehearsal, live. |
| **6** | — | — | README, demo video, submission. |

**Why this split holds up under time pressure:** Day 2 already leaves each side independently demoable (PRD §5's decoupling argument). If Day 3's integration slips, both developers still have something real to show separately rather than two unfinished halves of one thing.

**Standup discipline for 2 people on a tight clock:** 10 minutes each morning, one question each — "did the interface in `types.ts` change?" If yes, both stop and re-sync before writing more code against it. That file is the only thing that can silently desync the two halves.
