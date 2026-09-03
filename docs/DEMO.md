# SHOU — demo flow

Ports and startup are in [RUNBOOK.md](RUNBOOK.md). This is what to *show*,
in what order, and what to say.

The spine of the pitch is one argument:

> Detection is not enough. A warning does not stop a coerced person from
> sending money. Authority cannot sit with the elder (she is being
> manipulated right now) or with her family (that is a leading vector for
> elder financial abuse). So it sits with **her own rules, pre-committed
> while she was calm, enforced by the chain.**
>
> The AI decides. The chain enforces. And the AI can only ever tighten the
> rules, never loosen them.

---

## Act 1 — the human story (browser, ~60s)

<http://localhost:3000>

1. **Sign in with Google.** No seed phrase, no extension, no 24 words. Say
   it plainly: *"an 80-year-old is never going to write down a seed phrase.
   This is zkLogin — she signs in the way she signs into everything else."*
2. **Paste the scam message** into the textarea → **Check Circuit Breaker**
   → 🔴 HIGH.
3. **Now edit it to something harmless and run it again → LOW.** Do not skip
   this. It is the difference between a demo and a hardcoded animation, and
   a judge who suspects the former will not ask — they will just mark you
   down.
4. **Simulate Scammed Transfer** — the enclave signs a verdict bound to this
   exact policy, recipient and amount. Say: *"that signature happened inside
   the enclave. The message never left it — only a hash and a tier."*

---

## Act 2 — the proof (terminal, ~60s)

Everything above is a UI. This is the part that is real.

```bash
node --experimental-strip-types packages/driver/src/e2e.ts
```

Seven steps against live testnet, moving real USDC. The two lines to point at:

```
[5] chain assigned tier=HIGH, status=NEEDS_APPROVAL
[6] release attempted with no approval -> refused, EThresholdNotMet
```

*"That is not our server refusing. That is the Sui network refusing."*

---

## Act 3 — the kill shot (terminal, ~45s)

This is the moment that separates you from every other AI-scam-detection
project in the room.

```bash
node --experimental-strip-types packages/driver/src/demo-escalation.ts
```

```
The AI has been compromised. It reports every transfer as safe.
  sending        : 6.00 USDC
  AI says        : LOW risk, truth score 100
  her own ceiling: 5.00 USDC
  chain assigned : HIGH
  status         : NEEDS_APPROVAL
```

Say: *"We told the contract a large transfer was completely safe. It
escalated it anyway. The AI's verdict is a floor, never a ceiling — so you
do not have to trust our model, our prompt, or our uptime. Her own limits
hold even if the AI is wrong, or lying."*

**This is your answer to the question you will definitely be asked:** *"what
if your AI hallucinates?"*

---

## Act 4 — the security story (~30s, only if asked or if time allows)

Do not bury this. It is unusually strong for a hackathon:

> *"We found a fund-theft bug in our own deployed contract and fixed it.
> `execute` returned the coin to whoever called it, and `TransferRequest` is
> a shared object — so anyone could have waited for a transfer to unlock and
> redirected the money to themselves. The event log would still have shown
> the intended recipient, so it would have looked like a normal payment."*

Proof, if they want it — calling it directly on the live package now fails:

```
NonEntryFunctionInvoked
```

Five security issues found and fixed across three deployments, each with a
regression test. 38 Move tests passing.

---

## What to say about the gaps — before they ask

Both of these are strengths if you raise them first, and damaging if a judge
finds them.

**No AWS Nitro instance.** The Nautilus signing and on-chain signature
verification are fully real. What is missing is the attestation *document* —
so key registration is admin-gated rather than proven by AWS. It is labelled
`PRODUCTION GAP` in the contract itself. Say: *"signature verification is
real; the key's provenance is currently asserted by us, not by AWS."*

**Gonka Router is 404ing**, so scoring falls back to a heuristic that labels
itself `DEV MODE heuristic — not a real classifier` on screen. If it is
still down at demo time, say so out loud before anyone reads it off your
screen. The architecture point stands either way: the scorer runs *inside*
the enclave, which is why the message never leaves the device unprotected.

**Never claim a live TEE, and never claim Gonka is running if it isn't.** The
Sui judge is a Mysten engineer; Nautilus is a Mysten product. One follow-up
question collapses it, and it costs you the credibility that the rest of
this work has genuinely earned.

---

## If something breaks mid-demo

`EInvalidSignature` means the enclave restarted and its on-chain
registration is dead:

```bash
SHOU_ENCLAVE_CONFIG=<id> SHOU_ADMIN_CAP=<id> \
node --experimental-strip-types packages/driver/src/reregister-enclave.ts
```

`e2e.ts` re-registers itself on step 1, so **when in doubt, run the terminal
demo** — it is the most self-healing thing you have. Rehearse Act 2 and Act 3
until they are muscle memory; those two need only the enclave, not the
browser.
