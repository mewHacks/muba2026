# Gonka latency: measured, not guessed

Measured 2026-09-03 against api.gonkarouter.io from the branch copy. Every number
below came from a real call, not an estimate.

## Model ids

Only the fully-qualified ids answer. The short forms return HTTP 400 `invalid_model`:

| works                                | fails                    |
|--------------------------------------|--------------------------|
| `deepseek-ai/DeepSeek-V4-Flash-0731`  | `DeepSeek-V4-Flash`, `deepseek/DeepSeek-V4-Flash` |
| `moonshotai/Kimi-K2.6`                | `Kimi-K2.6`              |
| `MiniMaxAI/MiniMax-M2.7`              | `MiniMax-M2.7`, `minimax/MiniMax-M2.7` |

These are now the hardcoded defaults in `gonka.ts`, so a missing `.env` var no
longer silently falls back to an id that cannot work.

## The router caches responses

This is the single most important fact for the demo.

- **Identical prompt, repeated:** first call 29,225ms, then **288ms**.
- **Novel prompt every time:** 16,787 / 12,143 / 20,532 / 18,667ms. No warm-up
  effect at all.

So the 70-300ms figures you see when re-running the same scenario are cache hits,
not real inference speed. A rehearsed demo will look fast. A judge typing a
sentence nobody has run before will not.

## Cold latency (novel prompt, median of 3)

| role       | model                   | cold runs (ms)          | median  |
|------------|-------------------------|-------------------------|---------|
| classifier | DeepSeek-V4-Flash-0731  | 11220, 1961, 7013       | ~7,000  |
| verifier   | Kimi-K2.6               | 24437, 14108, 23153     | ~23,000 |
| explainer  | MiniMax-M2.7            | timeout, 21172, timeout  | ~21,000 |

A genuinely cold assessment is `max(classifier, verifier) + explainer`, because
the first two run in parallel and the explainer runs after them:

    max(7s, 23s) + 21s  ~= 44s

That is the honest number for an unseen input. The 17.8s I measured on scenario 1
was partly cached.

## The bug this exposed

`callGonka` defaulted to `timeoutMs: 20000` — *below* the median cold latency of
two of the three models. Most cold Kimi and MiniMax calls were aborting, then
retrying and paying the full cost again. Raised to 45,000ms.

Note the interaction with `retries = 1`: worst case per call is now ~90s. Reduce
retries before a live demo if you would rather fail fast than hang.

## What to decide before demo day

The explainer is the whole problem: it is serial, it is the slowest model, and it
runs on every single request including LOW-tier ones that need no explanation.

Three options, cheapest first:

1. **Pre-warm the cache.** Run the exact demo inputs a few minutes before you
   present. They come back in ~300ms. Legitimate — it is the router's own cache —
   but it only covers inputs you chose, so it does not survive a judge typing
   their own sentence.
2. **Skip the explainer for LOW.** A LOW verdict already falls back to canned
   copy. This cuts the slowest call off the majority of requests for free, and
   costs nothing in the demo narrative.
3. **Move the explainer to DeepSeek.** ~7s instead of ~21s, and it produced usable
   JSON in 3/3 runs on the explainer prompt. Costs you the "three distinct models"
   line for the Gonka rubric, so it is a trade, not a win.

Options 1 and 2 combine and neither weakens the pitch. I would do both and leave
option 3 alone.

## Degradation works

Worth knowing: when the explainer times out, the pipeline does not fail. It falls
back to canned tier-appropriate copy and sets `degraded`. Verified in
`committee.ts`. Losing the explainer makes SHOU blunter, never wrong.

---

# Update: model substitution is real, and it happened

Confirmed on a live `/api/assess` call. We requested `moonshotai/Kimi-K2.6` for the
verifier role and the router **served `MiniMaxAI/MiniMax-M2.7`** instead. The
substitution detector caught it and set `degraded`:

    "degraded": "Router served a different model than requested for: moonshotai/Kimi-K2.6."

Two consequences:

1. **You can now assert substitution on stage as fact, with a receipt.** The earlier
   caution ("I couldn't confirm from Gonka's docs that the router substitutes") is
   resolved — it does. That the detector caught it is a genuine differentiator; most
   teams will not know which model actually answered them.
2. **It quietly breaks the independence claim.** When Kimi is substituted to MiniMax,
   the verifier and the explainer are the *same model*, so "two independent models
   cross-verified this" is false for that request. The pipeline is right to flag it.
   Say "two models, and we detect and disclose when the router gives us only one"
   rather than claiming independence unconditionally.

## The 83s request, explained

That live call took 83,189ms end to end, which reproduces the ~81s figure:

    verifier: Kimi times out at 45s -> 0.5s backoff -> retry, substituted to MiniMax, 17s
    explainer: MiniMax, 20.7s
    total ~= 45 + 0.5 + 17 + 20.7 = 83s

So raising the timeout to 45s traded *failure* for *latency*. Before, Kimi aborted
twice at 20s and the verifier signal was dropped. Now it succeeds but costs a minute.
Neither is demo-ready. Before demo day set `retries: 0` on the verifier, or drop Kimi
for the live path — it is the single least reliable leg.

# Offline safety net: measured across all 24 cases

`npm run offline` forces every model call to fail and scores on deterministic rules
alone. No network, no cost, instant — run it as a regression check.

    OFFLINE: 13/24 tiers correct, 0 false positives on legitimate transfers

**All 8 legitimate transfers stay LOW with Gonka fully down.** That is the number
that matters: losing the network never causes SHOU to block a real payment.

Be precise about the other half, though. The 11 misses are all scams that degrade
*downward* — `loan` and `job` fall to LOW, meaning offline they would execute. So the
honest claim is:

> With Gonka down, SHOU still catches the textbook scams — impersonated authority,
> OTP and seed-phrase requests — and never blocks a legitimate transfer. It does get
> blunter on the subtle ones, which is what the models are there for.

Not "blunter, never unsafe". Offline it does miss subtle scams, and saying so is
stronger than being caught claiming otherwise.

## Lexicon brittleness, fixed

The `AUTHORITY_URGENCY_SECRECY` floor requires an urgency hit. `URGENCY` contained
`"sekarang juga"` but not bare `"sekarang"`, so a Macau-scam message using the
shorter, more common wording scored MEDIUM/61 instead of HIGH/80 — the floor never
fired. The shipped `macau` case says "SEKARANG JUGA" so it was unaffected, but a
judge typing their own Malay sentence would have hit the gap.

Broadened `URGENCY` with bare `sekarang`, `jangan tunggu`, `现在`, `快点`, `hurry`
and friends. Verified: all three phrasings now reach HIGH/80 via the floor, and the
24-case sweep is unchanged at 13/24 with **0 false positives** — the fix adds
coverage without costing precision.
