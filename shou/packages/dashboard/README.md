# @shou/dashboard — the guardian dashboard

The son's screen. Lists every transfer raised against a policy and lets
an approver release one or stop it and refund her.

```bash
npm install
npm start            # http://127.0.0.1:4200
```

It reads `shou/demo-ids.json` and `shou/.env`, so with the demo seeded it
needs no configuration. Overrides: `SHOU_POLICY_ID`, `SHOU_PACKAGE_ID`,
`SHOU_COIN_TYPE`, `SHOU_PRIVATE_KEY`, `PORT`.

**To use it you must be the guardian.** The policy's approver list is
fixed at creation, so reseed with your own address:

```bash
SHOU_GUARDIAN_ADDRESS=0x… node --experimental-strip-types packages/driver/src/seed-demo.ts
```

If the key it signs with is not on the approver list, the page says so at
the top and hides the buttons rather than letting every approval fail
with an opaque `ENotApprover` from the chain.

## Two rules shape the whole UI

**Plain English, never a tier number.** The reader is an adult child at
work, not an operator. `risk_tier: 2` tells him nothing; *"this one
looked like a scam, so the money has stopped and is waiting for you"*
tells him what he needs. Every card also states **what happens if he
does nothing** — a guardian who assumes inaction means "approved" will
ignore it on purpose, and one who assumes it means "she is stuck" will
answer. Both readings are wrong unless the screen says which it is.

**No conversation, ever.** This page shows an amount, a recipient and a
state. It does not show what his mother was told. A product that protects
her by handing her family a transcript of her private messages has traded
one harm for another — and family members are themselves a leading
vector for elder financial abuse. The server does not serve message
content and never talks to the enclave or the circuit breaker at all, so
there is no code path by which a conversation could reach it. The full
scoring detail lives in the extension popup, on **her** screen, because
that is her own conversation being shown back to her.

## Where the escalation claim becomes visible

When the chain assigned a stricter tier than was submitted, the card says
so: *"the check on her phone said nothing unusual — her own limits
disagreed and held it anyway"*. That difference is the whole "the AI's
verdict is a floor, never a ceiling" claim, so it is surfaced rather than
smoothed over. `claimedTier` vs `tier` in `TransferRequestView`.

## Architecture

```
public/index.html + src/app.ts   the page — fetches /api/*, signs nothing
server.ts                        thin shell over @shou/driver
```

The page never imports `@mysten/sui` and holds no key. Every decision is
an ordinary on-chain call to `policy::approve` or
`policy::block_and_refund`, so this process has no authority of its own:
stop it and escrowed funds are unaffected — she can still cancel and be
refunded.

**Why the server holds a key at all.** In production the guardian signs
in with Enoki zkLogin in the browser and this would be static hosting.
For the demo it signs with a local keypair, which is why it binds to
`127.0.0.1` rather than `0.0.0.0`: anyone who can reach the port can
approve transfers as the guardian. `/api/approve` and `/api/block` are
POST-and-JSON-only and the server answers no CORS preflight, so a page
he happens to have open cannot drive an approval on his behalf.

### API

| Route | |
|---|---|
| `GET /api/config` | guardian address, whether it is an approver, threshold, ids |
| `GET /api/requests` | every request against the policy, newest first |
| `POST /api/approve` | `{requestId}` → `policy::approve` |
| `POST /api/block` | `{requestId}` → `policy::block_and_refund` |

## The seam

Listing needs two reads that did not exist on `ShouClient`, so they were
added to `packages/driver/src/types.ts` and implemented in `client.ts`:

- `getPolicy(policyId)` — the threshold and approver set. The request
  object carries the approvals but not the number required, so without
  this the page cannot say "1 of 2".
- `listTransferRequests(policyId, limit)` — found via
  `TransferRequested` events, then **re-read from the objects
  themselves**, because the event records only the state at creation: an
  approval or a block that happened afterwards does not amend it. The
  object is the truth; the event is only how we find it.

Both are additive. The event filter is per *package*, so the policy id is
checked on every row — one deployment can guard several elders, and a
guardian must not see another family's transfers.
