# SHOU — PRD (Sui: Payments & Stablecoins + Gonka: AI for Society)

*SHOU — **S**cam-**H**alting **O**n-chain **U**tility. Also 守 (shǒu), Chinese for "to guard, keep watch, defend." Working name during early design was "Kawal" (Malay for the same thing) — kept the meaning, renamed for the room this pitches to.*

One-liner: **"Detects the scam while it's happening. Slows the money down. Never shows anyone the conversation."**

Status: draft PRD, pre-build. Owner: Hana. Last updated: 2026-09-02.

---

## 1. Problem

- US, FBI IC3 2024: adults 60+ filed the most fraud complaints of any age group (147,000+) and reported **$4.8–4.9B in losses, up 43% year over year**; crypto-related scams alone cost this group **$2.8B**. Average loss per victim: **$83,000**. ([AARP](https://www.aarp.org/money/scams-fraud/fbi-report-fraud-2024/), [TRM Labs](https://www.trmlabs.com/resources/blog/a-record-breaking-year-for-cybercrime-key-findings-from-the-fbis-2024-ic3-report))
- Malaysia, Bukit Aman: senior citizens lost **RM552.5M to online scams from 2021–2023** (5,533 victims) — a smaller share of victims than other age groups, but a disproportionately larger loss per victim. ([FMT](https://www.freemalaysiatoday.com/category/nation/2024/05/27/senior-citizens-lost-half-a-billion-ringgit-to-online-fraud-over-3-years)) 2024 alone: **RM40.6M** in elderly financial-scam losses, the highest of the past five years. Love scams targeting elderly women hit **RM45.9M in 2024**, up from RM43.9M in 2023 — **Facebook and WhatsApp are the two most-used contact points**. ([Malay Mail](https://www.malaymail.com/news/malaysia/2025/01/10/lonely-hearts-exploited-love-scams-prey-on-elderly-women-causing-rm459m-in-losses-in-2024-facebook-whatsapp-apps-of-choice-to-find-victims/162742))

**Target user, precisely:** not "elderly people," which is too broad to build UX for — the SEA family where an adult child works abroad or earns in crypto/stablecoins and sends money home to a parent who isn't crypto-native herself. She doesn't choose to hold stablecoins; her family routes money to her that way because it's cheaper and faster than a bank wire (see the $8.9T-in-6-months 2025 stablecoin remittance volume figure). She experiences the wallet as "money that appears," never as a crypto decision — which is exactly why zkLogin (Google sign-in, no seed phrase) is load-bearing, not decorative.

**The failure mode every existing tool misses:** the moment a scam works is the moment the victim is under live social-engineering pressure — urgency, authority, secrecy ("don't tell your family, the bank asked me not to say"). No elderly victim, mid-scam, is going to calmly copy-paste the conversation into a fact-checker. By the time a family member finds out, the transfer already happened.

What exists today misses this by design:
- **Family monitoring apps (Life360, Bark)** watch location and generic device activity, not conversation content or transaction risk. They don't know a scam is happening; they'd only notice the money is gone.
- **Generic fact-checkers** require the victim to self-report a claim, mid-attack, which is exactly the moment they're least able to.
- **Bank fraud holds** trigger on transaction patterns alone, with no visibility into the manipulation driving the transfer — high false-positive rate, no context to show a reviewer.

## 2. Solution overview

Four layers, each answering one failure mode above:

| Layer | What it does | Answers |
|---|---|---|
| **0 — Passive detection** | Chrome extension reads the DOM of the elder's own chat app (WhatsApp Web, etc.) in real time, scores each message via Gonka Router multi-model consensus, shows an inline 🟢/🟡/🔴 badge in the elder's language. | Victim can't self-report mid-scam — so nothing asks them to. |
| **1 — Circuit breaker** | A flagged live conversation correlating with an unusual outgoing transfer triggers a wallet-level pause, not just a warning. | A red badge the victim ignores under pressure still isn't the money moving. |
| **2 — Seniority Mode** | High-risk transfers need trusted-family co-approval, enforced as a Sui Move policy object — not a UI checkbox the elder can be talked past. | Family monitoring today only sees the money is already gone. |
| **3 — Red Flag reporting** | Anyone can report a scammer's wallet address; an LLM scores the evidence in under a minute, applies a soft ban (blocks suspicious transfers, allows daily necessities) pending staff review. | Reported scammers keep operating on other victims while a manual review queue backs up. |

## 3. Goals / non-goals

**Goals (hackathon scope):**
- Detect scam-pattern messages passively, with no action required from the elder, above a defensible accuracy bar on a labeled test set we build.
- Demonstrably slow down a coerced transfer without needing the elder to recognize the scam themselves.
- Keep conversation content out of every human's hands — family, staff, and us — end to end.
- Resolve "who has final authority" (Section 7) as a concrete, judge-defensible policy, not a hand-wave.

**Non-goals (out of scope for this build):**
- Not a general antivirus / malware scanner.
- Not a bank-grade transaction-monitoring replacement — this augments a wallet's existing risk controls, it doesn't replace KYC/AML.
- Not multi-chat-app at launch — WhatsApp Web only for the demo (see Section 10).
- Not a criminal justice tool — Red Flag soft-bans a wallet's transfer capability; it does not freeze funds, dox anyone, or replace police reporting.

## 4. Users

| Persona | Who | Wants |
|---|---|---|
| **Elder (primary)** | 60+, owns the wallet, may have low tech fluency, is the one under active social pressure during an attack. | To be protected without being infantilized — the app should intervene on the *scam*, not treat every transfer as suspect. |
| **Guardian (family)** | Adult child / trusted contact, added during onboarding, not present during the attack. | To be pulled in only when it matters, with enough signal to decide fast, never the raw conversation. |
| **Reporter** | Anyone (elder, guardian, or an unrelated victim) who encountered a scam wallet. | A fast, low-friction way to flag an address before it hits someone else. |
| **Staff reviewer** | Platform-side, reviews Red Flag queue. | A ranked queue by severity, not a firehose. |

## 5. Track fit

**Gonka — AI for Society.** Passive DOM-based conversation risk scoring and Red Flag evidence scoring both run entirely through Gonka Router — this is Layer 0 and Layer 3, not a bolt-on. It's genuine public-value AI (elder financial abuse), global (not Malaysia-locked), and the mechanism — passive detection instead of reactive self-report — is the part that doesn't already exist in the "chatbot fact-checker" pattern most entries will pitch. *(Adaptation needed: Gonka's preferred submission shape is URL/text-in → Truth Score + reasoning trace + Request ID. Our Layer 0 input is a live DOM stream, not a URL — map each scored message to that same Truth-Score-and-Request-ID shape so the submission still fits their preferred format even though the trigger is passive.)*

**Sui — Track 01, Payments & Stablecoins.** Track 01 asks something SHOU can answer without a stretch: "effective Sui/stablecoin use," and its own Ideas list names **"stablecoin wallets, treasury, escrow"** — which is a literal, undefended description of what `SeniorityPolicy` and `TransferRequest` do.

**Why Sui specifically, not a database with the same rules in it** — the stub-it-out test, run honestly:

| Piece | Remove Sui — still works? |
|---|---|
| Gonka scoring, Circuit Breaker glue | Yes, unaffected — this is why it's a separate track submission (Gonka), not evidence against Sui here |
| `SeniorityPolicy` / `TransferRequest` / `WalletGuard` tiered approval, cooldown, denylist | **No** — this is the thing being submitted to Track 01 |
| zkLogin | **No**, not without re-centralizing custody in our own backend |
| Sponsored transactions | **No**, not without the elder needing to hold gas |

Three reasons the chain matters here, not just "logic lives in a `TransferRequest` object instead of a Postgres row":

1. **The asset is already there.** The target user (§1) receives money as stablecoins because her family routes it that way, not because SHOU chose to put a Web2 idea on-chain. Protecting stablecoins that already live on Sui is the payments-track use case as-written, not an add-on to it.
2. **Tamper-evidence a database can't give you.** A guardian threshold or cooldown window enforced in our own backend is one `UPDATE` statement away from us — the operator — quietly changing it. Enforced as a Move object, it isn't; the elder's own pre-committed policy (§7) is only credible as "can't be walked through live" if even we can't bypass it.
3. **Non-custodial without the UX cost.** zkLogin is the one piece here with no clean Web2 equivalent: OAuth-simple sign-in *and* self-custody in the same primitive. Recreating "elder logs in with Google, no seed phrase" in Web2 means either a seed phrase (dealbreaker for this user) or SHOU holding the keys (recreates the custody risk the whole product exists to avoid).

**Deliberate decoupling — resilience against a partial build.** Layers 0 and 3 (Gonka Router scoring) run entirely off-chain and need zero Sui code to demo; Layers 1–2 (circuit breaker, Seniority Mode) need zero Gonka Router calls to demo — the transfer-tier logic accepts a risk score as input regardless of who produced it. This is why the two submissions split cleanly: **Gonka (AI for Society)** gets Layers 0+3 on their own merits, **Sui Track 01** gets Layers 1+2 on theirs. If the extension's live DOM read is flaky on demo day, the Sui-side submission still stands on its own with a scripted risk score. If Gonka Router quota or latency is a problem during the Gonka-track demo, that submission doesn't depend on the Sui contract being deployed at all. Two submissions, two independently-complete demos, from one build — and neither has to defend an AI-Sui entanglement that doesn't exist.

## 6. Architecture

```
WhatsApp Web (elder's browser)
        │  DOM MutationObserver, new messages only
        ▼
Chrome Extension (content script)
        │  batches + redacts PII before leaving device where possible
        ▼
Gonka Router — Layer 0 consensus scorer
   3 models vote: scam-pattern classifier → 🟢/🟡/🔴 + Truth Score + Request ID
        │  score + hash of message (not the message) →
        ▼
SHOU backend (TEE-hosted inference broker)
        │  message content decrypted only inside enclave, never logged, never stored
        │  emits: risk_score, category, hash-anchor record → Sui (Layer 0 audit trail)
        ▼
Circuit Breaker service
        │  watches: live 🔴 conversation × outgoing transfer request, same session window
        ▼
Sui Move — Escrow/Policy layer
   ├─ WalletGuard object: pause flag, cooldown timer
   ├─ SeniorityPolicy object: approver set, M-of-N threshold, denylist
   └─ zkLogin-authenticated PTBs, sponsored (gasless)
        ▲
Guardian app (family) ── sees: risk category, amount, recipient novelty — never raw text
Staff console ── Red Flag queue, ranked by amount × plausibility score
```

**Why TEE, concretely:** message content must be scored by a model but must never be visible to us as operators — that's the actual privacy claim, not decoration. The enclave decrypts, scores, and discards; only a hash + risk category + Gonka Request ID leave the enclave. Anyone (family, auditor, us) can verify a hash matches a disputed message later without ever having stored the message.

## 7. Seniority Mode — conflict resolution (the flagged concern)

**The wrong two answers, and why both fail:**
- *Elder has absolute final override* — defeats the entire product. A scammer coaching the victim in real time ("just click confirm anyway, that's a normal warning") walks straight through it.
- *Guardian has absolute veto* — a competent adult doesn't lose financial autonomy because a family member disagrees with a legitimate purchase. This is also the paternalism failure mode that makes families avoid these tools in the first place.

**The actual mechanism: present-elder vs. past-elder-policy, tiered by risk.**

The elder sets her own policy while *not* under duress, at onboarding. In the moment of a live attack, that pre-committed policy — not a family member in real time — is what has authority. Family is a notified co-signer only at the threshold the elder herself chose.

| Tier | Trigger | Resolution | Who acts |
|---|---|---|---|
| **Low** | No active flagged conversation, amount under elder's own threshold | Proceeds immediately | Elder alone |
| **Medium** | Flagged 🟡 conversation correlates with a transfer, OR amount above threshold | Cooldown timer (elder-configured, default 24h) + guardian notified with risk category. No guardian action required — transfer proceeds automatically after cooldown unless actively blocked. | Elder's past policy; guardian can only *stop*, not *approve faster* |
| **High** | Flagged 🔴 conversation directly correlated, or amount above the elder's high-risk ceiling | M-of-N guardian co-approval required on-chain (`SeniorityPolicy`, elder-set threshold, e.g. 1-of-2) before the transfer PTB can execute | Guardian(s), per elder's own pre-set threshold |
| **Denylisted** | Recipient address matches an active Red Flag soft-ban | Hard block. Not overridable by elder or guardian in the moment — this one is a determination about the *recipient*, not a judgment about the elder, so present-moment consent (which may be coerced) can't waive it. | Nobody, until the denylist entry is cleared by staff review |

Elder can always **change her own policy** (thresholds, approvers, cooldown length) — but a policy change itself is written with a cooldown before it takes effect, so a scammer can't walk the victim through "just lower your guardian threshold first."

```move
public struct SeniorityPolicy has key {
    id: UID,
    owner: address,
    approvers: vector<address>,   // elder-chosen, not assignable by guardians themselves
    threshold: u8,                 // M of N
    cooldown_ms: u64,              // elder-chosen
    high_risk_ceiling: u64,
    policy_change_cooldown_ms: u64,
}

public struct TransferRequest has key {
    id: UID,
    policy_id: ID,
    amount: u64,
    recipient: address,
    risk_tier: u8,                 // set by Circuit Breaker from Gonka Router score
    approvals: vector<address>,
    unlock_at_ms: u64,
}
```

This is the part of the pitch that answers a judge asking "so who's actually in charge here" with a specific, defensible mechanism instead of "the family, I guess."

## 8. Key flows

**Flow A — passive detection, no attack:** elder chats normally on WhatsApp Web → extension scores each message 🟢 → nothing surfaces beyond a small persistent badge. Zero friction is the point; a tool elders resent gets uninstalled.

**Flow B — live scam, transfer blocked:** conversation trends 🔴 ("send RM5,000 to secure your account," urgency language) → elder opens wallet to send → Circuit Breaker sees flagged-conversation × transfer correlation in the same session → transfer enters High tier regardless of amount → guardian notified with risk category + amount + recipient novelty ("first time sending to this address") → guardian approves/blocks → PTB only executes on threshold met.

**Flow C — Red Flag report:** guardian or elder reports a wallet address post-incident → Gonka Router agent scores the evidence (transaction hash, recipient address, written description — text only, since Gonka Router does not currently support image input) → soft ban applied within the minute (blocks transfers *to* that address across all SHOU users, daily-necessity-sized transfers elsewhere unaffected) → staff queue ranked by `amount_at_risk × plausibility_score` → staff confirms or lifts.

## 9. Privacy design

- Raw message text exists only: (a) in the elder's own browser DOM, momentarily, and (b) inside the TEE during scoring. Never in application logs, never in the backend DB, never sent to guardians or staff.
- What persists: a SHA-256 hash of the message (for later dispute verification), the risk category, the Gonka Request ID, and a timestamp. Hash-anchored on Sui — tamper-evident, not content-revealing.
- Guardian and staff UI surfaces: risk tier, amount, recipient novelty, timestamp. Never message text.
- If an elder disputes a block later, she — not the guardian, not staff — can choose to reveal the underlying message to a specific reviewer. Default is closed.

## 10. Commercial viability

Who pays, and why now — not a hackathon afterthought:

- **The buyer is the bank/e-wallet/remittance operator, not the elder.** Regulation just turned elder-scam losses from "sad but not our liability" into a direct balance-sheet cost for financial institutions:
  - **Singapore's Shared Responsibility Framework** (live 16 Dec 2024): a bank bears the *full* scam loss if it breached a duty — including running real-time fraud surveillance and offering a 12-hour cooling-off period after new-device login/token activation. No liability cap. ([MAS](https://www.mas.gov.sg/news/media-releases/2024/mas-and-imda-announce-implementation-of-shared-responsibility-framework-from-16-december-2024), [Herbert Smith Freehills Kramer](https://www.hsfkramer.com/notes/data/2024-posts/financial-institutions-and-telcos-required-to-share-responsibility-for-phishing-scams-in-singapore))
  - **UK PSR APP fraud reimbursement** (live 7 Oct 2024): sending and receiving banks split scam losses 50/50, mandatory reimbursement within 5 business days, up to £85,000 per claim. ([PSR](https://www.psr.org.uk/information-for-consumers/app-fraud-reimbursement-protections/), [Hogan Lovells](https://www.hoganlovells.com/en/publications/app-fraud-mandatory-reimbursement-uk-psr-publishes-final-policy-for-7-october-2024-go-live-date))
  - Malaysia (BNM) is watching both models. A bank facing this liability shift now has a direct financial reason to pay for a pre-transfer risk layer instead of eating the reimbursement after the fact — SHOU is the "real-time fraud surveillance + cooling-off" duty from the Singapore framework, productized.
- **Revenue model:** B2B2C SaaS — license Seniority Mode + the Circuit Breaker as an embeddable risk layer to a wallet/remittance app (per-active-guarded-account fee), not a consumer subscription competing with free antivirus-style tools. A bank/e-wallet pays because it now reduces their own reimbursement exposure, not out of goodwill.
- **Secondary, smaller revenue:** the diaspora-family angle from Section 1 supports a direct-to-consumer tier too (a working-abroad adult child pays a few dollars a month to protect a parent's account) — same precedent as Life360's guardian-pays model, just for money instead of location.
- **Why now, not five years ago:** the regulatory liability shift is 2024–2025, live in two major jurisdictions already. This is a market that didn't financially exist for banks until last year.

## 11. Regulatory & compliance — blockers and how we handle them

Named honestly, because a hand-waved compliance section is worse than a short one that admits the real blocker:

- **WhatsApp's Terms of Service prohibit automated/scraped access to WhatsApp Web** — this is the single biggest blocker in the whole pitch, and it's real, not hypothetical. DOM-reading via a content script for a hackathon demo (self-hosted test conversation, our own accounts) doesn't touch a real user at scale, but it is **not a viable production integration** as specified. Production path: **WhatsApp Business API** (Meta-sanctioned, message content available via webhook to a business account the user has explicitly connected) instead of scraping the consumer client — same detection logic, different message source, fully ToS-compliant. State this plainly in the pitch; a judge who knows WhatsApp's ToS will ask, and "we know, here's the compliant production path" lands far better than pretending the scraping approach ships as-is.
- **Data protection (Malaysia PDPA / GDPR-shaped regimes elsewhere):** reading a private conversation, even passively, is processing personal data of two people — the elder *and* whoever she's talking to, who never consented to SHOU reading anything. Mitigation: TEE-only content access with no persistence (Section 9) narrows this to processing-not-storage, and the production WhatsApp Business API path above requires the elder's explicit opt-in connection, which supplies her side of consent; the counterparty's data is processed only transiently for risk-scoring, a narrower claim than "we retain and analyze your messages."
- **Not a money transmitter:** SHOU never custodies funds — the elder's own zkLogin key authorizes every transfer; SHOU only vetoes or delays via the Move policy she pre-set. This keeps it out of money-transmission licensing territory that a custodial escrow product (like our Pact idea) would have to face head-on.
- **Guardianship / capacity law:** Seniority Mode deliberately never makes a competency determination — the elder opts in and sets her own thresholds while not under duress (Section 7, Section 13). This sidesteps needing formal legal guardianship status for the "family" role, which varies by jurisdiction and would otherwise be a real blocker to launching anywhere without a lawyer first.

## 12. Hackathon MVP — what actually gets built

Full architecture above is the pitch. Build order, riskiest and most-demoable first:

| Day | Build | Demo state |
|---|---|---|
| 1 | Sui Move: `SeniorityPolicy`, `TransferRequest`, cooldown + M-of-N approval + denylist. Unit tests for every tier. | Contract proven |
| 2 | TS driver + testnet deploy. zkLogin + sponsored tx for elder and guardian accounts. | ✅ Demoable: scripted transfer through all 4 tiers |
| 3 | Chrome extension: DOM read on WhatsApp Web (static test conversation, not live scraping edge cases), Gonka Router scoring, inline badge. | ✅ Live 🟢/🟡/🔴 on real WhatsApp Web UI |
| 4 | Circuit Breaker service wiring extension score → transfer tier. Guardian approval UI. | ✅ Flow B end-to-end |
| 5 | Red Flag report + Gonka agent scoring + soft-ban denylist enforcement. | ✅ Flow C end-to-end |
| 6 | Demo polish, hash-anchoring on-chain, README, 2-min video (Gonka's stated submission requirement), staged demo script. | Submission |

**For the Gonka video specifically:** their preferred shape is Truth Score (0–100%) + reasoning trace + Request ID, visibly on screen. Make sure the extension badge UI and the Red Flag review screen literally render all three — a numeric score, a short reasoning line, and the Gonka Request ID string — not just a colored dot. That's a UI requirement traceable straight to a submission requirement, not a nice-to-have.

**Cut list if behind schedule — each leaves a working demo:**
1. **Multi-app support** → WhatsApp Web only; say so, don't fake it.
2. **TEE** → run the broker on a normal server for the demo, keep the hash-anchoring and the "message never persisted" property (true without hardware attestation, just not hardware-*proven*); name Nautilus as the upgrade path, don't claim it's running unless it is.
3. **Guardian mobile app** → web dashboard only.
4. **Live DOM scraping robustness** → scripted/replayed conversation for the demo instead of live WhatsApp Web quirks. Say it's scripted.

Non-negotiable for the demo: the 4-tier policy actually enforced on-chain (this is the whole "would anyone trust this" argument), and one full pass through Flow B live.

## 13. Success metrics (for the pitch, not instrumented at hackathon scale)

- Time from scam-pattern message to 🔴 flag: target < 2s (Gonka Router consensus latency).
- False-positive rate on a labeled test set of scam vs. benign urgent messages (e.g., "wire me rent money" from a real family member) — this number matters more than raw accuracy, because false positives are what get the tool uninstalled.
- % of High-tier transfers where guardian responds inside the cooldown window (demo can only assert intended design here, not real data).

## 14. Risks

| Risk | Mitigation |
|---|---|
| DOM scraping breaks on WhatsApp Web layout changes, and isn't ToS-compliant for production anyway | Scripted conversation for the live demo; production path is the WhatsApp Business API, not scraping — see Section 11. |
| False positives erode trust, elder disables extension | Default-closed friction (Medium tier is a *delay*, not a block); elder sets her own thresholds. |
| Guardian threshold can itself be a coercion vector ("lower your guardian threshold for me") | Policy changes carry their own cooldown (Section 7) — can't be walked through live. |
| Red Flag soft-ban abused to grief a legitimate wallet | Plausibility scoring + staff review before anything beyond a soft, necessity-preserving ban; ranked queue, not auto-permanent. |
| Gonka Router doesn't serve a model needed for DOM-text classification | Confirm model availability against gonkarouter.io before Day 3, not after. |

## 15. Open questions

- Does Gonka Router's context window/latency profile handle a live message stream, or does it expect single-shot text-in? Confirm at the 27 Aug workshop.
- What counts as "daily necessities" for the soft-ban carve-out — a flat amount ceiling, or merchant-category detection? (Flat ceiling for hackathon scope.)
- Legal capacity note for the pitch: Seniority Mode requires the elder to opt in and set her own thresholds at onboarding — this is deliberate, so the product doesn't need to make a competency determination it has no authority to make.
