# Questions for the Mysten Labs engineer (Raphael)

Context to give him in one line: *SHOU is an on-chain guardian for an elderly user's stablecoin wallet — a Move policy object enforces tiered approval on transfers, an AI risk score arrives from a Nautilus-style enclave, and the chain independently escalates on amount so a scam the AI never saw is still caught.*

Everything below came out of actually building it. Blockers are real and reproducible, not hypothetical.

---

## Z. Judging-alignment questions (ask these FIRST — he is also a judge)

How to open, so this reads as mentorship rather than fishing for favour:

> "We've got a working Move package on testnet with 37 tests and one security hole we found and fixed by attacking our own deployment. I've got three days left and I'd rather spend them on what the track actually rewards than guess. Can I run a few tradeoffs past you?"

That earns the right to ask everything below: it shows work first, and asks him to arbitrate tradeoffs rather than hand you answers.

### Tier 1 — his answer changes what you build this week

**Z1. ~~The stablecoin gap.~~ ANSWERED — do not ask.**
Circle's USDC is on Sui testnet at `0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC`, faucet at faucet.circle.com (select Sui Testnet). The driver now uses `coinWithBalance`, which works for any coin type. The demo runs in USDC.

**Z2. Is a guardrail a payments product?** *"SHOU doesn't move money in a new way — it stops money from moving wrongly. Does that read to you as a payments product, or as security tooling sitting in the wrong track?"*
→ Uncomfortable but the highest-value question here. If the answer is "wrong track," you need to know now, not at judging. If the answer is "no, that counts," you can lean into it hard in the pitch.

**Z3. Depth or breadth, with three days left.** *"We have four layers: passive detection, a circuit breaker, the on-chain policy, and scam reporting. The chain layer is deep and adversarially tested; the others are thinner. The brief says complete beats complex — concretely, do you reward one complete vertical slice, or the whole architecture shown shallowly?"*
→ Makes "complete > complex" actionable instead of a slogan.

### Tier 2 — sharpens the pitch itself

**Z4. Does the security demo land?** *"Our strongest moment is telling the contract a large transfer is low-risk and watching it refuse anyway, because the policy escalates on amount independently of the AI. In a 3-minute pitch, does that land — or is it too inside-baseball for a mixed panel?"*
→ Judges know what plays to judges. This is worth more than any amount of guessing.

**Z5. Does honest incompleteness help or hurt?** *"We implemented the Nautilus signing and on-chain verification pattern, but we can't provision a Nitro instance, so key registration is admin-gated and we label that gap explicitly in the code and the deck. Does an honestly-labelled partial implementation read as rigour, or just as incomplete?"*
→ Genuinely uncertain, and his answer decides whether it's worth burning a day on an AWS Nitro deployment.

**Z6. What does commercial viability mean here?** *"We were told commercial viability weighs heaviest. Our buyer is a bank or e-wallet reducing its own scam-reimbursement liability under the 2024 Singapore and UK rules — not the elderly user. Does a B2B2C story satisfy that, or do you want evidence of consumer willingness to pay?"*
→ Targets the criterion the mentors said matters most, and tests whether our §10 argument actually convinces someone scoring it.

### Tier 3 — cheap, and unusually high signal

**Z7.** *"What's the most common way a good project loses points in this track?"*
→ Pet peeves. Best value-per-second question you can ask any judge.

**Z8.** *"Live testnet demo or recorded? Have you seen live demos fail on network flakiness here?"*
→ Practical, and the answer is a decision you have to make anyway.

**Z9. Save this for the very end, after he's seen what we have:** *"If this were your codebase and you had three days, what would you spend them on?"*
→ The single best question in this list, but it only works once he understands the project. Asked cold, it gets a generic answer.

### Do NOT ask

- Anything answered in `tracks.md` — it signals you didn't read the brief and burns goodwill.
- "Do you think we'll win?" / "Is our idea good?" — puts a judge in an awkward spot and gets a non-answer.
- Anything that's really a pitch in disguise. Ask, listen, take notes, stop talking.

### Capture the answers

Write down Z1, Z2 and Z6 verbatim. Those three change the build; the rest change the telling.

---

## A. Blockers hit while building (technical — ask if time allows)

### A1. JSON-RPC is dead on public full nodes, and it broke us silently
Our driver used `SuiClient` from `@mysten/sui` v1.45.2. Every write failed with:

> `Method not found. JSON-RPC on public fullnodes has been deprecated. Please migrate to gRPC or GraphQL endpoints.`

`@mysten/sui@^1.0.0` in package.json resolves to 1.45.x, whose only working transport is the deprecated one. We migrated to `SuiGrpcClient` on **2.28.0**.

**Ask:**
- Is 2.x the version to build on for the hackathon, or is anything still in flux?
- Is there a deprecation timeline we should know about mid-hackathon?
- Anything in 1.x → 2.x that commonly bites people beyond the client swap? (ESM-only and `moduleResolution` caught us.)

### A2. gRPC effects don't return `objectType`, so "which object did I just create?" needs an extra round-trip
With `include: { effects: true, objectTypes: true }`, `changedObjects[]` entries came back with `objectId` and `idOperation` but **`objectType` absent**. To find a newly created `SeniorityPolicy` we now filter `idOperation === 'Created'` then `getObject` each one to read its type.

**Ask:**
- Is that the intended pattern, or are we requesting `objectTypes` wrong?
- Is there a single call that returns created objects **with** their types? This is the single most common thing app code needs after a `moveCall`.
- Minor: `idOperation` is PascalCase `'Created'`, not `'CREATED'`. Is that stable?

### A3. On-chain `Clock` lags wall-clock time, and it rejected valid signatures
Our enclave signs a risk score with `Date.now()`; `enclave::verify` compared it against `clock.timestamp_ms()`. Against real testnet this aborted with our own `EAttestationFromFuture` — the `Clock` only advances per checkpoint, so it trailed the signer. We added a 60s skew tolerance.

**Ask:**
- What skew should we actually allow between an off-chain signer and `Clock`? Is 60s sane, or too generous?
- Is there a canonical pattern for timestamped off-chain attestations on Sui? We'd rather copy the right one than invent it.
- Worst-case observed lag between `Clock` and real time on testnet?

### A4. Struct changes force a full republish, which churns every object ID
We changed fields on `SeniorityPolicy` twice (adding amount ceilings, then binding the deny-list ID). Upgrade rules forbid modifying an existing struct, so each time meant a fresh `publish`, a new package ID, and re-creating every shared object. That also invalidated our published addresses mid-demo-prep.

**Ask:**
- For a project still iterating on struct shape, what's the recommended workflow? Versioned wrapper object? Dynamic fields for the mutable parts?
- Is there a pattern that keeps a stable package identity across shape changes so a demo URL doesn't break?

### A5. Testnet faucet throughput
We burned ~1 SUI across publishes and adversarial testing in one day and are now blocked at 0.04 SUI. The faucet's proof-of-work takes minutes per request.

**Ask:** any higher-throughput option for hackathon teams doing repeated publishes?

---

## B. Nautilus / TEE — where we're genuinely stuck

We implemented the Nautilus **pattern**: `EnclaveConfig` holds PCR0/1/2, `Enclave` holds the enclave's ephemeral public key, and every risk score is an ed25519-signed BCS struct bound to the exact policy, recipient and amount. Signature verification, freshness and replay-binding are all real and tested — including a test that verifies a genuine signature produced by the enclave process.

**What we did NOT do:** parse and verify the AWS attestation document on-chain. So registration is currently `AdminCap`-gated, meaning *signature checking is real but key provenance rests on our admin key, not AWS's root of trust.* We're being explicit about that rather than overclaiming.

**Ask:**
- **B1.** Is the Nautilus Move library published somewhere we can depend on (MVR? git?) for `verify_attestation`, or is vendoring the template the expected path? A concrete dependency line would unblock us immediately.
- **B2.** Can any part of attestation verification be exercised **without** a real Nitro instance — a sample attestation document, a devnet fixture, a test mode? We can't provision AWS Nitro before the deadline.
- **B3.** If we can't get a genuine enclave running: is an honestly-labelled "attestation-ready, key registered by admin" implementation acceptable for judging, or does it read as not-really-TEE? We'd rather be told now.
- **B4.** The enclave key is ephemeral and dies on restart, so every restart needs a re-registration transaction. The Nautilus docs say Seal solves exactly this — storing long-term keys and releasing them only to a properly attested TEE. Is that the recommended lifecycle, and is it realistic to wire up in a few days?

### B5. Should Seal be doing our privacy work instead of regex?

Right now we strip PII with pattern matching (`packages/redact`) before a message is scored, and we store no conversation anywhere. That is simple and testable, but it is our own invention rather than a Sui-native answer.

Seal looks like a better fit for one specific thing in our design: PRD §9 says that if the elder disputes a block, **she** — not her family, not our staff — can choose to reveal the underlying message to a named reviewer. That is an access-control policy over encrypted data, which is precisely what Seal does.

**Ask:**
- Is "encrypt the message with Seal, let a Move policy decide who may decrypt, elder-controlled" the right shape for a selective-disclosure dispute flow?
- Seal's own docs warn it is not for "highly sensitive data". Do private messages of an elderly scam victim fall inside or outside that line, in your view?
- Realistically, is Seal a few-days integration or a rabbit hole for a team with three days left? We will not start it unless you think it lands.

---

## C. Track 01 fit — the one that could cost us points

**C1 and C2 — resolved ourselves, no need to ask.** Testnet USDC is `0xa1ec7fc0...::usdc::USDC` (faucet.circle.com, select Sui Testnet), and `coinWithBalance` from `@mysten/sui/transactions` is the idiomatic way to take N of any coin type from the sender — it finds, merges and splits automatically. Our earlier `splitCoins(tx.gas, ...)` silently only worked for SUI.

**C3.** Can one project be submitted to **both** Sui tracks, or must we pick one? Thetanuts' brief says explicitly that one entry can take both of theirs; the Sui section doesn't say either way. We're currently targeting Track 01 only.

---

## D. zkLogin + sponsored transactions (not yet built — Day 2 debt)

Both are named "helpful features" for Track 01 and our whole UX claim ("Google sign-in, no seed phrase, no gas") rests on them.

- **D1.** For a hackathon, is there a **hosted salt service** for testnet, or do we run our own? Docs are clear that losing the salt permanently loses the address, so we've planned an SSO-style salt service — is that still the recommendation?
- **D2.** Is the Mysten **prover** available for testnet, and are there rate limits we'd hit during a live demo?
- **D3.** Sponsored transactions: hosted sponsor/paymaster for testnet, or roll our own relayer? Smallest correct implementation for a demo?
- **D4.** Does a zkLogin signer compose cleanly with our shared-object PTBs, or are there gotchas with `maxEpoch` expiring mid-demo?
- **D5.** A zkLogin address is derived, not a keypair — no seed phrase, no export, and access dies with the salt or the OAuth client ID. For a product holding an elderly user's remittance, we plan to put the zkLogin signer inside a **multisig** with the guardian holding an ordinary keypair as the recovery path. Is that the pattern you'd recommend, and are there gotchas combining a zkLogin signer with a multisig on shared objects?

---

## E. Design review — worth 5 minutes of his opinion

- **E1.** The chain derives its own risk tier from the transfer amount and takes `max(amount_tier, claimed_tier)`, so an off-chain scorer can escalate but never de-escalate. Is that a sound way to bound trust in an off-chain oracle, or is there a better Sui-native idiom?
- **E2.** We bind `deny_list_id` into the policy at creation because otherwise a caller could pass in *any* `DenyList` and shed an active ban. We hit this as a real vulnerability. Is per-object ID binding the idiomatic fix, or is there a registry/witness pattern we should use instead?
- **E3.** We deleted a separate `WalletGuard` object after discovering anyone could mint a second, unpaused one for the same policy. General question: what's the recommended way to express "there is exactly one of these per policy" in Move?
- **E4.** Funds live in `Balance<T>` inside a shared `TransferRequest`. HIGH-tier requests whose approvers never respond would have locked funds forever, so we added an owner-only cancel. Any better pattern for escrow-with-timeout on Sui?

### E5. Our global deny list is a single hot shared object — how bad is that?

Every transfer, from every user, takes `&DenyList` — one shared object for the whole system. That means every transaction in SHOU sequences through consensus on the same object.

**Ask:**
- How badly does that bite in practice? Is a single global shared object touched by every transaction a known scaling wall on Sui, or is read-only shared access cheaper than we think?
- Better shapes we should consider: a per-policy denylist snapshot, an off-chain membership check with only a proof submitted on-chain, or something with dynamic fields? What would you do?
- This is a "real-world readiness" answer as much as a technical one — we would rather know now than be told at judging.

### E6. Shared vs owned objects — are we over-sharing?

`SeniorityPolicy`, `TransferRequest` and `DenyList` are all shared, because guardians act on them from their own addresses. But most transfers are LOW tier and never involve a guardian at all.

**Ask:** is there a design where the common case uses **owned** objects (fast path, no consensus) and only escalated transfers become shared? Or is shared unavoidable once a second party can act on the object?

### E7. Has anyone built this on Sui already?

**Ask:** *"Guardian-controlled spending limits on a wallet — co-approval above a threshold, cooldowns, an on-chain policy object. Have you seen this on Sui? Is there prior art we should know about, either to differentiate from or to build on?"*

He sees every project in the ecosystem. If this exists, we need to know before a judge tells us. If it does not, that is worth knowing too.

### E8. What would make this feel Sui-native rather than ported?

**Ask:** *"If you looked at our Move code cold, would it read as designed for Sui, or as an EVM-shaped app translated across? What are we not using that we obviously should be?"*

An open invitation for him to point at the primitive we have missed. Ask it late, after he has seen the code.

### E9. Who pays gas for the guardian?

Sponsored transactions solve gas for the elder. But the **guardian** also transacts — approving or blocking a transfer — and he is just as likely to hold no SUI.

**Ask:** does one sponsor cover both parties in this kind of flow, or does each role need its own sponsorship path? Any pattern for "the app sponsors anyone acting on this policy object"?

---

## Quick reference if he asks what's built

| | |
|---|---|
| Package (testnet) | `0xca22881f7d75c28f9df1a5e4f4572056f60a67c5d3fa29186ff71a8938464953` |
| Modules | `policy`, `redflag`, `enclave` |
| Move tests | 37/37 passing |
| Verified on-chain | tier escalation blocks a large "LOW" transfer; deny-list substitution rejected; full LOW request → execute |
| Not yet verified on-chain | the attested TEE path end-to-end (blocked on gas + the clock-skew fix redeploy) |
| Not built | zkLogin, sponsored transactions, stablecoin (using SUI) |

---

## F. Post-security-review questions (NEW — ask these before section E)

These come out of a review that found a fund-theft bug in our own deployed
package. They are the highest-signal questions we have: each one is a real
Move design decision we already made and could still be wrong about.

### F1. Returning `Coin<T>` from a shared object is a theft vector — what's the idiom? ⭐ ASK THIS ONE

We shipped this, on testnet:

```move
public fun execute<T>(request: &mut TransferRequest<T>, ...): Coin<T>
```

`TransferRequest` is shared, and release is intentionally permissionless so
a relayer can trigger it and the elder can stay offline. But because the
coin is *returned*, anyone could watch for the event, wait for the transfer
to unlock, and compose a PTB that calls `execute` and sends the coin to
themselves. Every guard passed. The emitted `TransferExecuted` still named
the intended recipient, so on an explorer it looked like a normal payment.

We fixed it by making `execute` `public(package)` and exposing only
`entry fun execute_and_send`, which pays `request.recipient`.

**The question:** the composability guidance says public functions should
return objects rather than transfer internally, so callers can compose in a
PTB. That guidance is exactly what produced this bug. **Where is the line?**
Is `public(package)` + an entry wrapper the idiomatic answer for anything
holding value in a shared object, or is there a pattern that keeps
composability without letting the caller choose the destination?

*Why this is a good question to ask him: it is a genuine tension in Sui's own
recommended style, we hit it in production, and we can show the fix rejected
on-chain with `NonEntryFunctionInvoked`.*

### F2. One-shot attestations — is a hot potato the right tool?

Our enclave signs a `RiskAttestation` bound to (policy, recipient, amount)
with a 5-minute freshness window. Nothing consumes it: within that window
the same signed bytes verify any number of times.

Today it is not exploitable — every submission still needs the owner's
signature and her own coins, and the amount ceilings apply regardless. But
it is only safe by accident, and it becomes critical the moment we let an
attested LOW skip amount escalation.

**The question:** for one-shot verification, is the idiomatic Sui answer a
hot-potato `VerifiedAttestation` (no abilities, must be consumed by value in
the same PTB), or a `Table` of used message hashes? The hot potato costs no
storage but only protects *within* a transaction — does it actually stop
replay across two separate transactions, or do we need the table?

### F3. How do you revoke a compromised enclave?

`Enclave` is shared and holds the registered public key. There is no
deregister, freeze, or `revoked` flag — so a leaked enclave key stays valid
forever, and our only recourse is migrating every policy to a new package.

**The question:** what does Nautilus do here in production? Is revocation
expected to live in the app layer (a `revoked: bool` an AdminCap can flip),
or does the attestation-document path give you natural expiry via PCR
rotation, so long-lived registrations are the wrong mental model?

### F4. We bind the policy to a DenyList but not to an EnclaveConfig — inconsistent?

An earlier review caught that any `DenyList` could be swapped in, so
`SeniorityPolicy` now stores `deny_list_id` and asserts on it. But
`submit_transfer_attested` takes no `EnclaveConfig` — **any** registered
enclave can sign for **any** policy.

**The question:** should the policy pin an `EnclaveConfig` id the same way,
or is a single trusted enclave registry per package the intended shape? We
are unsure whether per-policy enclave binding is real defence or just
ceremony.

### F5. Cheap, ask if there is time

*"We found a fund-theft bug in our own package by having a second reviewer
read it adversarially. Is there anything in the Sui tooling — a linter,
`sui move prove`, a static check — that would have caught a `public fun`
returning `Coin<T>` from a shared object? Or is that purely a review
problem right now?"*
