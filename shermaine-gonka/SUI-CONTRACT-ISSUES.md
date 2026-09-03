# Three contract issues to raise with Dev A today

Read against `shou/move/sources/policy.move` and `redflag.move` at commit `9b774fc`.
These are not style notes — the first two are the kind of thing a Mysten Labs judge finds
by reading the Move for ninety seconds, and the third is a claim we would be making on
stage that the code does not support.

---

## 1. The risk tier is supplied by the caller (highest priority)

```move
public fun submit_transfer<T>(..., risk_tier: u8, ...) {
    assert!(ctx.sender() == policy.owner, ENotOwnerOrApprover);
    ...
}
```

Nothing binds `risk_tier` to an actual Gonka assessment. The policy owner — the elder,
who during a live scam is being coached by the attacker — can submit any transfer as
`TIER_LOW`. So the sentence "the contract enforces the AI's verdict" is currently false:
it enforces whichever tier the caller typed.

**Hackathon-sized fix.** Add a `RiskOracleCap` minted at policy creation and held by the
scoring service; require `&RiskOracleCap` in `submit_transfer` and check it matches the
policy. About twenty lines, and it demos.

**Say the production path out loud** rather than pretending the cap is the final answer:
verify an ed25519 signature over the attestation this service already produces
(`assessmentId, policyId, sender, recipient, amount, tier, expiresAt`), so a LOW result
cannot be replayed for a different recipient, a larger amount, or a later attempt.
The payload is already built in `gonka/src/attestation.ts` — it needs a signature and an
on-chain `ed25519_verify`, not a new design.

---

## 2. Anyone can ban any address, for gas

```move
entry fun report(list: &mut DenyList, addr: address, plausibility_score: u8, clock: &Clock)
```

No capability, no threshold, no verification. And `submit_transfer` asserts
`!redflag::is_banned(deny_list, recipient)` — so any stranger can permanently block any
recipient for **every** SHOU user, and only a `StaffCap` can undo it. That is a global
denial of service on the product, callable by anyone.

**Fix, in order of preference:**

1. **Cut Red Flag from the demo entirely.** It is not needed to prove the transfer-protection
   flow, and it is the weakest surface in the package.
2. If it stays: split it. `submit_report` emits an event that anyone may call;
   `apply_ban` requires `StaffCap` and creates the deny-list entry. A score threshold alone
   is not enough while the caller supplies the score.

---

## 3. Our pitch describes an elder override that does not exist

What the code actually does:

| Tier | Release condition |
|---|---|
| LOW | `unlock_at = now`, executes immediately |
| MEDIUM | cooldown elapses, then anyone may execute |
| HIGH | `approvals >= threshold`. **Time never releases it.** |
| any | `block` sets `blocked = true` permanently and refunds the owner |

So there is no "the elder can push it through after the timer" for HIGH, and a guardian's
block is final for that transfer.

**Keep the code, fix the sentence.** The current behaviour is the more defensible one:
letting an actively coerced person override a HIGH hold hands the scammer the override.
And the design is genuinely good — `block_and_refund` sends funds back to `policy.owner`,
so a guardian can stop a transfer and return the money but can never redirect or keep it.

The honest line for the pitch: **"A guardian can stop a transfer and give the money back.
A guardian can never move it, take it, or release a cooldown early."**

**One gap worth closing:** a HIGH request that no guardian ever approves or blocks holds
the funds forever. Add an expiry — after N hours the owner can reclaim — so the failure
mode is a refund, not a permanent lock.

---

## Smaller ones

- `threshold` may be `0`, which makes a HIGH transfer executable with no approvals at all.
  Assert `threshold > 0` in `new_policy`.
- `pause` lets any approver pause indefinitely with no owner recourse. Cap the pause window.
