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

---

# Update 2: the account is throttled, so parallelism is the wrong lever

The plan to run the two models concurrently does not work on this account, and the
reason is not latency — it is the router refusing the concurrency:

    HTTP 429 {"code":"rate_limited","message":"too many concurrent requests for
    this account; lower your parallelism and retry"}

When it does not 429 outright it throttles instead. Same DeepSeek call, same prompt:

| how it was issued            | latency |
|------------------------------|---------|
| alone                        | 2,472ms |
| alongside one other request  | 17,560ms |

So firing both models at once costs about **7x** and buys nothing. The pipeline is now
**sequential under a shared 14s deadline**: the classifier runs first, and the verifier
only runs if enough budget survives. A second opinion that lands after the deadline is
worth less than a verdict that lands on time.

## Measured per-model, 5 novel prompts each

| model                  | median | max     | usable JSON |
|------------------------|--------|---------|-------------|
| DeepSeek-V4-Flash-0731 | 2.6s   | 4.4s    | 5/5         |
| MiniMax-M2.7           | 19.6s  | 30.4s   | 4/5         |
| Kimi-K2.6              | 26.5s  | 30.2s   | 5/5         |

Kimi never once came in under 23s, so it is out of the live path. The verifier is now
MiniMax. Kimi remains a fine model that this router simply serves too slowly.

## The bug this hunt actually turned up

Worth more than the latency work. `clampScore` returned **0** when a model's reply could
not be parsed, and 0 is a real score meaning "certainly not a scam". So a truncated
verifier reply was silently counted as a confident vote for safety and pulled the fused
score *down*.

It was firing constantly. MiniMax is a reasoning model: it emits a `<think>` block
regardless of what the prompt says, and starved of tokens it never reaches the JSON.
Every one of those turned into a 0. That is what the "models disagreed by 95 points"
lines were — the verifier was not disagreeing, it was absent and being counted anyway.

Three fixes:

- `clampScore` returns `null`, never 0, when there is no usable number. A model that did
  not answer is now absent from the fusion instead of voting.
- `parseLenientJson` strips `<think>` blocks, including unterminated ones.
- The verifier budget went from 250 to 1200 tokens. With room to finish, MiniMax is
  accurate — otp 100, macau 95, bill 15, son 10, all correct. Starved, it returned
  nothing. Better to spend tokens and let the deadline drop the call than to accept a
  confident wrong answer.

## Where it landed: `npm run demo-check`

Eight cases, live, with the acceptance criteria asserted rather than eyeballed:

    latency  median=14002ms  max=14003ms  budget=15000ms
    over budget:      0/8
    false positives:  0
    missing receipts: 0
    PASS

Cross-verification landed on 2 of 8; the other 6 timed out and said so in `degraded`.
Nothing silently degraded.

## The trade you still have to make

You cannot have both a sub-15s live path and reliable two-model cross-verification on
this account. The numbers do not allow it: the only fast, reliably-structured model here
is DeepSeek, and the second opinion costs ~24s.

1. **Ship the fast path** (current default). DeepSeek classifies, explains and
   translates in one call; the verifier is best-effort and disclosed when it does not
   land. Demo is always under 15s. Cross-verification appears about a quarter of the time
   live, and reliably in `npm run eval`, where latency does not matter.
2. **Insist on two models live.** Raise the deadline to ~30s and accept that every
   assessment takes about half a minute on stage.

Option 1 is the recommendation, and the Gonka rubric is still satisfiable: run the
multi-model evidence offline and show the receipts. Do not claim live cross-verification
on every request — the `degraded` line will contradict you on stage.

## One design consequence worth knowing

HIGH needs the message *and* the transaction to look bad. With the classifier alone,
weight redistribution caps a message-only signal below 70, so `invest`, `loan` and
`newnumber` land MEDIUM rather than HIGH. MEDIUM still holds the money and notifies
guardians, so this is protective, not a miss — but do not promise HIGH on a scam message
attached to an unremarkable transfer.
