# Questions for the Mysten Labs engineer (Raphael)

Context to give him in one line: *SHOU is an on-chain guardian for an elderly user's stablecoin wallet — a Move policy object enforces tiered approval on transfers, an AI risk score arrives from a Nautilus-style enclave, and the chain independently escalates on amount so a scam the AI never saw is still caught.*

Everything below came out of actually building it. Blockers are real and reproducible, not hypothetical.

---

## A. Blockers hit while building (highest value — ask these first)

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
- **B4.** The enclave key is ephemeral and dies on restart, so every restart needs a re-registration transaction. Is that the intended lifecycle, or is Seal the answer for key persistence?

---

## C. Track 01 fit — the one that could cost us points

**C1. We're demoing with SUI, not a stablecoin.** Track 01 is "Payments & Stablecoins" and our contracts are generic over `Coin<T>`, but every test moves SUI. Is there a canonical **testnet USDC** (or similar) we should be using, with a faucet? This feels like it matters for track fit and we'd rather fix it than argue around it.

**C2.** Our `requestTransfer` splits the payment from the gas coin, which only works because the coin type *is* SUI. For a real stablecoin the caller must supply coin objects explicitly. Is there a cleaner idiomatic pattern for "take N of coin type T from the sender" inside a PTB?

**C3.** Can one project be submitted to **both** Sui tracks, or must we pick one? Thetanuts' brief says explicitly that one entry can take both of theirs; the Sui section doesn't say either way. We're currently targeting Track 01 only.

---

## D. zkLogin + sponsored transactions (not yet built — Day 2 debt)

Both are named "helpful features" for Track 01 and our whole UX claim ("Google sign-in, no seed phrase, no gas") rests on them.

- **D1.** For a hackathon, is there a **hosted salt service** for testnet, or do we run our own? Docs are clear that losing the salt permanently loses the address, so we've planned an SSO-style salt service — is that still the recommendation?
- **D2.** Is the Mysten **prover** available for testnet, and are there rate limits we'd hit during a live demo?
- **D3.** Sponsored transactions: hosted sponsor/paymaster for testnet, or roll our own relayer? Smallest correct implementation for a demo?
- **D4.** Does a zkLogin signer compose cleanly with our shared-object PTBs, or are there gotchas with `maxEpoch` expiring mid-demo?

---

## E. Design review — worth 5 minutes of his opinion

- **E1.** The chain derives its own risk tier from the transfer amount and takes `max(amount_tier, claimed_tier)`, so an off-chain scorer can escalate but never de-escalate. Is that a sound way to bound trust in an off-chain oracle, or is there a better Sui-native idiom?
- **E2.** We bind `deny_list_id` into the policy at creation because otherwise a caller could pass in *any* `DenyList` and shed an active ban. We hit this as a real vulnerability. Is per-object ID binding the idiomatic fix, or is there a registry/witness pattern we should use instead?
- **E3.** We deleted a separate `WalletGuard` object after discovering anyone could mint a second, unpaused one for the same policy. General question: what's the recommended way to express "there is exactly one of these per policy" in Move?
- **E4.** Funds live in `Balance<T>` inside a shared `TransferRequest`. HIGH-tier requests whose approvers never respond would have locked funds forever, so we added an owner-only cancel. Any better pattern for escrow-with-timeout on Sui?

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
