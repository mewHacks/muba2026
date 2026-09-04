# @shou/dashboard — the guardian dashboard

The son's screen. Three tabs over one JSON API:

| Tab | What it is |
|---|---|
| **Transfers** | Every transfer raised against the policy. An approver can release one, or stop it and refund her. |
| **Reported addresses** | The community deny list, read from the `DenyList` table on-chain. Read-only unless the signer holds the `OracleCap`. |
| **Set the rules** | Creates a `SeniorityPolicy` — guardians, threshold, both amount limits, cooling-off, deny list. |

```bash
npm install
npm start            # http://127.0.0.1:4200
npm test             # 21 tests, no network
```

It reads `shou/demo-ids.json` and `shou/.env`, so with the demo seeded it
needs no configuration. Overrides: `SHOU_POLICY_ID`, `SHOU_PACKAGE_ID`,
`SHOU_DENY_LIST`, `SHOU_COIN_TYPE`, `SHOU_PRIVATE_KEY`, `PORT`.

**To approve or block you must be the guardian.** The approver list is
fixed at policy creation, so either create a policy on the Set the rules
tab with your own address, or reseed:

```bash
SHOU_GUARDIAN_ADDRESS=0x… node --experimental-strip-types packages/driver/src/seed-demo.ts
```

If the key it signs with is not on the approver list, the page says so at
the top and hides the buttons rather than letting every approval fail
with an opaque `ENotApprover` from the chain.

## Three rules shape the whole UI

**Plain English, never a tier number.** The reader is an adult child at
work, not an operator. `risk_tier: 2` tells him nothing; *"the money has
stopped and is waiting for you"* tells him what he needs. Every card also
states **what happens if he does nothing** — a guardian who assumes
inaction means "approved" will ignore it on purpose, and one who assumes
it means "she is stuck" will answer. Both readings are wrong unless the
screen says which it is.

**No conversation, ever.** This page shows an amount, a recipient and a
state. It does not show what his mother was told. A product that protects
her by handing her family a transcript of her private messages has traded
one harm for another — and family members are themselves a leading
vector for elder financial abuse. The server does not serve message
content and never talks to the enclave or the circuit breaker at all, so
there is no code path by which a conversation could reach it. The full
scoring detail lives in the extension popup, on **her** screen, because
that is her own conversation being shown back to her.

**Nothing that spends gas happens without being asked.** Approve, stop
and create-policy each open a confirmation naming the amount, the
recipient and the network, and saying that it costs gas and cannot be
undone. The server refuses any of the three that did not come through it
(`confirm: true` in the body), so the guard is not only in the browser.

## Where the escalation claim becomes visible

When a transfer is held, the card says *who* held it — her own limits, or
the check on her phone. That distinction is the whole "the AI's verdict
is a floor, never a ceiling" claim.

It is **derived, not asserted**. The chain stores only the effective tier
(`max(amount_tier, claimed)`), so the claimed tier is genuinely not
recoverable from the object, and `TransferRequested` does not carry it
either — `TransferRequestView.claimedTier` is therefore `null` in
practice. What *is* recoverable is whether her own ceilings reach the
effective tier by themselves. When they do, the hold stands whatever the
scorer said, including if it was wrong, offline or compromised — which
is the claim actually worth making. See `holdReason` in `src/logic.ts`.

## Reports are not bans

`redflag::report` is gated on an `OracleCap` minted by the package
publisher and held by the scoring service. The server asks the chain
whether its signer owns one (`findOracleCap`) and the page offers a
reporting control only if it does. Ours does not, so the tab is
read-only and says why.

The list itself is read from the **`DenyList` table**, not from
`AddressBanned` events. The events are the obvious source and the wrong
one twice over: they carry no deny-list id, so a package guarding two
lists would blend them, and `clear` emits a separate event that does not
amend the first — so an events-only list would show addresses a reviewer
has already exonerated. Events are still read for one thing they alone
can say: how many times an address has been reported, since `report`
overwrites the entry and the table remembers only the latest. That count
is labelled as corroboration and is package-wide.

Each row states the **ban ceiling** in words, because "banned" alone is
the wrong claim: amounts at or below the ceiling still go through on
purpose, so a report that turns out to be wrong slows someone down
instead of cutting them off. A ceiling of zero is styled differently from
a soft one — the two enforcement states must not scan alike.

## Policy setup, and what it does not do

The form checks every abort in `new_policy` before anyone pays gas to
discover it — `ETooFewApprovers`, `EThresholdTooLow`, `EThresholdTooHigh`,
`ECeilingsInverted` — plus two the contract does not enforce but a person
needs: a duplicate guardian (two entries for one person are not two
approvals) and a zero cooldown (which would release a MEDIUM transfer the
instant it was created). Amounts are converted against the selected coin
type, so a ceiling typed in USDC is 6 decimals and one typed in SUI is 9;
excess precision is rejected rather than rounded, because rounding
"5.0000001" to "5.00" sets a limit the person did not ask for.

**It is signed by this server's local key, not by the elder.** That key
becomes the policy owner, and the owner is the only address that can
later cancel a held transfer. In the product she owns it herself through
her Google sign-in; that path currently signs an enclave attestation and
does not submit transactions, and wiring Enoki sponsored execution is not
done. The form says this above the first field rather than implying she
signed it.

Creating a policy here points this process at the new one. It does **not**
write `demo-ids.json`, so the extension and circuit breaker still use the
old policy until you set `SHOU_POLICY_ID` or reseed. The page says so
after a successful creation.

## Architecture

```
public/index.html + src/app.ts   the page — fetches /api/*, signs nothing
src/logic.ts                     decimals, the mirrored escalation rule, form validation
src/logic.test.ts                21 tests over exactly those
server.ts                        thin shell over @shou/driver
```

The page never imports `@mysten/sui` and holds no key. Every decision is
an ordinary on-chain call, so this process has no authority of its own:
stop it and escrowed funds are unaffected — she can still cancel and be
refunded.

`logic.ts` exists apart from `app.ts` for one reason: those are the
functions that can be wrong about money. Reading a USDC amount with nine
decimals shows $5 where $5,000 is meant, and mirroring the contract's
escalation rule incorrectly tells a guardian her own limits held a
transfer when the model did. Both are testable, so both are tested —
against the same boundary cases as `move/tests/policy_tests.move`, since
a mirror that is never compared against the original drifts.

**Why the server holds a key at all.** In production the guardian signs
in with Enoki zkLogin in the browser and this would be static hosting.
For the demo it signs with a local keypair, which is why it binds to
`127.0.0.1` rather than `0.0.0.0`: anyone who can reach the port can
approve transfers as the guardian.

### API

| Route | |
|---|---|
| `GET /api/config` | guardian address, whether it is an approver, threshold, both ceilings, cooldown, ids, whether the signer holds an `OracleCap` |
| `GET /api/requests` | every request against the policy, newest first |
| `GET /api/redflags` | the deny list, read from the table |
| `POST /api/approve` | `{requestId, confirm}` → `policy::approve` |
| `POST /api/block` | `{requestId, confirm}` → `policy::block_and_refund` |
| `POST /api/policy` | validated policy arguments + `confirm` → `policy::create_policy` |

The three mutating routes carry four guards, each closing a different
door: **POST only**, so no URL is a mutation and no `<img>` tag can be
one; **JSON only**, which a cross-origin form cannot set without a
preflight this server never answers; an **Origin check** for anything
that still gets through; and an explicit **`confirm: true`**, which is
how the server refuses a call that skipped the dialog.

## The seam

Reading needed four things that did not exist on `ShouClient`. All are
additive — `types.ts` gained optional fields and one method, and nothing
that already compiled stopped compiling:

- `getPolicy(policyId)` — the threshold and approver set. The request
  object carries the approvals but not the number required, so without
  this the page cannot say "1 of 2".
- `listTransferRequests(policyId, limit)` — found via
  `TransferRequested` events, then **re-read from the objects
  themselves**, because the event records only the state at creation: an
  approval or a block afterwards does not amend it. The object is the
  truth; the event is only how we find it. The filter is per *package*,
  so the policy id is checked on every row — one deployment can guard
  several elders, and a guardian must not see another family's transfers.
- `listRedFlags(denyListId, limit)` — the deny list, from the table. If
  the table reports entries and none can be read it throws, because
  rendering that as "no addresses are reported" would state the opposite
  of the truth.
- `TransferState.digest` (optional) and `createPolicy`'s optional
  `digest` — a screen that says "blocked" with nothing to check is asking
  to be believed. The digest is how a guardian, or a judge, confirms on
  an explorer that the click reached the chain.

`SuiShouClient.findOracleCap()` is on the class only, not the interface:
it is a question about one signer's holdings rather than part of the
chain contract the two halves of the app agreed on.

## What could not be verified from here

The deny list on the seeded testnet deployment is genuinely empty
(`banned.size == 0`, checked directly), because nothing has held the
`OracleCap` long enough to report an address. The table read is therefore
exercised against a real but empty list. The decoding of a populated
entry is covered by `packages/driver/src/redflag.test.ts` against both
transport shapes, so it is not first exercised in front of an audience —
but no populated list has been rendered on testnet.

A real approve or block is a one-way on-chain call and has not been run
as part of this work.
