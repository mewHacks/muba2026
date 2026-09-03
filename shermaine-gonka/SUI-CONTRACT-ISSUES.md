# Sui contract review — WITHDRAWN

**Do not send the earlier version of this file to Dev A.** Every issue it raised
was already fixed, in `765fd86` "Harden policy/redflag after security review;
redeploy". The review was written against a stale read of the contract, and I
did not re-check it against the branch before circulating it. This file now
records what is actually true, verified against the source on 2026-09-03 with
all 38 Move tests passing.

## The four claims, and what the code actually does

**1. "The contract trusts a caller-supplied `risk_tier`."** False, twice over.

There are two submission paths. `submit_transfer_attested` calls
`enclave.verify(attestation, signature, clock)` and then binds the signature to
this exact transfer:

```move
assert!(attestation.policy_id() == object::id(policy), EAttestationMismatch);
assert!(attestation.recipient() == recipient, EAttestationMismatch);
assert!(attestation.amount() == payment.value(), EAttestationMismatch);
```

So a score issued for a small payment to a known contact cannot be replayed to
wave through a large one to a stranger. That is cryptographic verification of the
AI verdict, and it already exists — landed in `03481ff`.

The unattested `submit_transfer` does take a claimed tier, but applies
`max_tier(amount_tier(policy, amount), risk_tier)`. The claim can only ever make
the outcome *stricter*, so lying about it buys an attacker nothing. Pinned by
`large_amount_declared_low_still_needs_approval` and
`mid_amount_declared_low_still_gets_cooldown`.

**2. "`threshold` can be 0, so a HIGH transfer executes with no approvals."**
False. `policy.move:124` asserts `threshold > 0` (`EThresholdTooLow`), and
`threshold <= approvers.length()` on the next line. Pinned by
`create_policy_aborts_on_zero_threshold` and `create_policy_aborts_on_threshold_too_high`.

**3. "Duplicate approvers can meet the threshold."** False.
`policy.move:343` asserts `!request.approvals.contains(&caller)`
(`EAlreadyApproved`). Pinned by `cannot_approve_twice`.

**4. "Red Flag is an open global denial of service."** False on both halves.

`report` requires `_oracle: &OracleCap`, so a stranger cannot ban anyone. And the
ban is *soft*: `blocks_amount` returns `amount > ban_ceiling`, so a banned
recipient still accepts everyday amounts. Pinned by
`soft_ban_permits_amounts_at_or_below_ceiling` and
`banned_recipient_still_allows_daily_necessities`.

## What this changes for the pitch

The line I previously told you to use —

> "the prototype produces a transfer-bound risk assessment that the next contract
> revision will authorize through a scoped oracle capability"

— understates what is built. The scoped oracle capability exists
(`create_oracle_cap`), the enclave signature is verified on chain, and the
attestation is bound to policy, recipient and amount.

**You can say the contract cryptographically verifies the AI verdict**, provided
you are precise that this is the *attested* path and that the enclave is
Nitro-*compatible* rather than Nitro-*attested* — key registration is AdminCap-gated
because there is no AWS attestation document outside a real enclave, and the
contract labels that `PRODUCTION GAP` itself.

## The one real gap, and it is not in the contract

The chain side is ahead of the AI side, not behind it. What is missing is that
nothing yet calls `submit_transfer_attested` with a *live* attestation produced by
the scorer — the enclave signs one, but the end-to-end wiring from the browser
through to that entry function has not been exercised on testnet, because that
needs a funded key and seeded object ids.

That is an integration task, not a contract fix, and it is the honest thing to
name if a judge asks what is incomplete.
