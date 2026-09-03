# SHOU — Gonka risk layer

Off-chain scoring for `shou::policy`. Produces a `RiskAssessment` (superset of
`shou/packages/driver/src/types.ts` — the five original fields are unchanged, so Dev A's
`ShouClient` keeps compiling) plus `tierCode` (0/1/2) for `request_transfer`.

## Pipeline

```
redact locally
   ├─ deterministic transaction anomaly   (arithmetic, no model)
   ├─ deterministic scam indicators        (keyword floors)
   ├─ classifier  DeepSeek ─┐  same redacted message,
   ├─ verifier    Kimi    ──┘  independent, in parallel
   ├─ FUSION (code owns the number, floors cannot be lowered)
   └─ explainer   MiniMax   plain sentence + user's language
                            (also adjudicates, bounded ±15, only on conflict)
```

**Why two models on the same message.** Cross-verification only means something when both
reviewers see identical evidence. An earlier design had one model score the message and
another score the transaction, then called the gap between them "agreement" — that was
wrong, they were measuring different things. Transaction anomaly is now arithmetic:
deterministic, instant, free, and more explainable than an LLM guess.

**Why code owns the score.** Models supply evidence and language. `fuse()` in `rules.ts`
computes the number, and `indicators()` sets floors — a credential request or the
authority + urgency + secrecy signature cannot be scored below its floor by any model.

## What the receipts prove

Every call's `x-request-id` links to `https://api.gonkarouter.io/v1/receipts/<id>`, which is
public and needs no key. It proves **provenance** — this inference ran, on this model, at
this time, on the Gonka network. It does **not** prove the conclusion was correct. Say it
that way in the pitch; a judge who knows the difference will notice if you overclaim.

The client also records the model the router actually **served**. If we asked for Kimi and
got something else, the UI says so, because "two independent models agreed" stops being
true the moment one of them was substituted.

`temperature: 0` lowers variance; it does not guarantee identical output run to run.

## Degraded behaviour (verified)

With Gonka entirely unreachable, the Macau-scam case still returns `HIGH` (score 80) from
the deterministic floor, and `degraded` explains why. Losing the network makes SHOU blunter,
never unsafe. Demo this deliberately — it is a better answer than hoping the wifi holds.

## Run

```bash
cp .env.example .env      # key from https://gonkarouter.io/dashboard
npm install
npm run ping              # which model-id spelling actually answers
npm run eval              # 24 cases; watch the false-positive count
npm run dev               # http://localhost:8787
```

## Interface

`POST /api/assess` → `RiskAssessment & { tierCode: 0|1|2 }`.

The chain consumes `tierCode` only. Everything else is UI and audit, so Dev A can build
against `{"tier":"HIGH","tierCode":2}` without waiting on this service.

`attestation` binds the assessment to one policy, sender, recipient, amount and expiry —
see `SUI-CONTRACT-ISSUES.md` for why `submit_transfer` must verify it rather than trust a
`risk_tier` handed in by the caller.
