# SHOU — how to run everything

Four servers on four ports, plus the extension, then either the scripted proof
or the browser demo. Every command below is copy-paste from the repo root.

| Service | Port | Why it must be that port |
|---|---|---|
| zkLogin demo | 3000 | The Google OAuth origin and redirect are registered against :3000 in the Enoki portal. Changing it breaks sign-in. |
| enclave | 3100 | Moved off 3000 to stop it colliding with the above. |
| circuit breaker | 4000 | Talks to the enclave; the browser talks to it. |
| guardian dashboard | 4200 | Nothing is registered against it; it just has to miss the three above. Binds to 127.0.0.1 only — it signs as the guardian. |

Current deployment (`shou/demo-ids.json` is the source of truth, regenerated
per deploy — it is gitignored, so run the seeder after any republish):

```
package    0xdd78bd78aebe0694629773e85e66c37ac8dd9f287d166d052b2656090661ed1f
denyList   0x2d84887eb54755afa56a5a0b77256001d6d396aeb89c89db95f858fd3c1dd2fc
adminCap   0xcf19f6d6a67e033787d47f9b2896f9cb1baa64d49b515d7a5f120a647b599a7e
```

---

## 0. One command that says whether everything is fine

```bash
cd shou && ./verify.sh          # checks tests + whatever is already running
cd shou && ./verify.sh --full   # also starts any service that is not up
```

20 checks: every test suite, every typecheck, the extension build, all three
services, and the scoring path end to end with a real scam and a real clean
message. Exits non-zero if anything failed, so it works as a pre-demo gate.

It cannot check two things, and says so: the extension inside a real Chrome
profile, and an actual approve/block (a real on-chain call that costs gas —
do that once on testnet before demo day, not during it).

---

## 1. Tests — no servers needed

```bash
cd shou
sui move test --path move                                        # 38 tests
node --experimental-strip-types packages/driver/src/recovery.test.ts   # 6
node --experimental-strip-types packages/redact/src/redact.test.ts     # 7
node --experimental-strip-types enclave/src/session-risk.test.ts       # 6
cd packages/gonka-client && npm test                             # 12
cd packages/extension && npm test                                # 22
```

The gonka-client suite covers the scoring arithmetic AND the deterministic
lexicons with no router and no key: a model that times out must not count as
a vote for LOW, a hard floor must not be talkable down, an inference outage
must hold a suspicious transfer while leaving ordinary traffic alone, and the
scripts that actually circulate (Bukit Aman, CCID, LHDN, SPRM) must trip the
authority rule. That last set exists because `verify.sh` caught a textbook
Macau scam scoring MEDIUM: `bukit aman` was missing from the lexicon, so the
authority+urgency floor never fired. The deterministic layer carries the whole
verdict whenever the router is slow, which on this router is often.

The last one starts its own enclave on an ephemeral port, so it does not
clash with a running one. It is the anti-laundering proof: score a scam to
HIGH, then ask for an attestation under a *different* session id and check
the HIGH is still found.

---

## 2. The servers — three terminals

```bash
# terminal 1 — enclave on :3100
cd shou/enclave && npm start

# terminal 2 — circuit breaker on :4000
cd shou/packages/circuit-breaker && npm start

# terminal 3 — zkLogin demo on :3000 (npm start rebuilds the bundle first)
cd shou/packages/zklogin-demo && npm start

# terminal 4 — guardian dashboard on :4200 (also rebuilds first)
cd shou/packages/dashboard && npm start
```

The dashboard prints the address it signs with. If that address is not on the
policy's approver list the page says so and hides the buttons — reseed with
your own address as guardian (§4) rather than debugging a Move abort.

**If you have no Gonka key**, start the enclave with the heuristic scorer
instead, so everything downstream still works. (The 404 that blocked this
earlier is resolved — the URL and the fully-qualified model ids were both
wrong. With a key in `.env`, the real models are used.)

```bash
cd shou/enclave && SHOU_TEST_SCORER=1 npm start
```

That scorer labels itself in its own output — `"DEV MODE heuristic — not a
real classifier"` — so nothing on screen claims to be a model verdict when
it is not.

Check they are all up:

```bash
curl -s localhost:3100/health_check   # {"status":"ok",...}
curl -s localhost:4000/health         # {"status":"ok"}  <- also proves it reaches the enclave
curl -s localhost:3000/config.json    # must show a non-empty policyId
curl -s 127.0.0.1:4200/api/config     # "approver": true is the one to check
```

If `policyId` is empty, the page will refuse to prepare a transfer. Run the
seeder (§4) and restart terminal 3.

---

## 3. The scripted proof — the strongest single artifact

Needs the enclave (:3100) running. Moves real testnet USDC.

```bash
cd shou
SHOU_PACKAGE_ID=0xdd78bd78aebe0694629773e85e66c37ac8dd9f287d166d052b2656090661ed1f \
SHOU_ADMIN_CAP=0xcf19f6d6a67e033787d47f9b2896f9cb1baa64d49b515d7a5f120a647b599a7e \
SHOU_DENY_LIST=0x2d84887eb54755afa56a5a0b77256001d6d396aeb89c89db95f858fd3c1dd2fc \
node --experimental-strip-types packages/driver/src/e2e.ts
```

Seven steps, ending in a real balance change. The two that matter:

```
[5] chain assigned tier=HIGH, status=NEEDS_APPROVAL
[6] release attempted with no approval -> refused, EThresholdNotMet
```

Add `SHOU_COIN_TYPE=0x2::sui::SUI` to run it in SUI instead.

---

## 4. Seeding real ids for the dashboard and the browser demo

```bash
cd shou
SHOU_PACKAGE_ID=… SHOU_ADMIN_CAP=… SHOU_DENY_LIST=… \
node --experimental-strip-types packages/driver/src/seed-demo.ts
```

Writes `shou/demo-ids.json`: a live policy plus a pending HIGH-tier transfer
sitting in escrow, which is what the guardian dashboard needs to show
something real. Cooldown defaults to 2 minutes so the MEDIUM path is
demoable; set `SHOU_COOLDOWN_MS` for a realistic value.

---

## 5. Browser demo

Open <http://localhost:3000>, sign in with Google, then in the transfer card:

1. **Check Circuit Breaker** — scores the message in the textarea. Edit it:
   a benign message scores LOW. That it responds to the actual text is the
   point; do not skip showing this.
2. **Simulate Scammed Transfer** — the enclave signs a verdict bound to this
   exact policy, recipient and amount.

Nothing here touches the chain — it signs only. The on-chain half is §3.

---

## 6. The Chrome extension

```bash
cd shou/packages/extension
npm install && npm run build      # or npm run watch while editing
```

`chrome://extensions` → Developer mode → **Load unpacked** →
`shou/packages/extension/dist`. Needs the enclave and circuit breaker up (§2).

Then open its **Settings** and press *Fetch policy id from dashboard* — it
reads the live id from :4200, so nobody demos against a policy id copied
yesterday. **Test connection** checks the circuit breaker and reports whether
the enclave behind it is reachable, which are two different fixes.

Open a chat in WhatsApp Web. Each incoming message gets a 🟢/🟡/🔴 badge; the
toolbar badge shows the worst verdict in the conversation, and the popup has
the Truth Score, the reasoning and every Gonka Request ID.

Scoring is *refused* with no policy id set, rather than filed against a
placeholder — the enclave keys verdicts by policy so that a swapped session id
cannot launder a HIGH away, and the zero address would defeat that silently.

---

## 7. When it breaks

**`EInvalidSignature` on every attestation.** The enclave restarted and
generated a new key, so the `Enclave` object registered on-chain is dead.
Re-register:

```bash
cd shou
SHOU_ENCLAVE_CONFIG=<config id> SHOU_ADMIN_CAP=<cap id> \
node --experimental-strip-types packages/driver/src/reregister-enclave.ts
```

**`EADDRINUSE`.** Something already holds the port: `lsof -ti :3100 | xargs kill -9`.

**Browser calls fail with a CORS error.** The circuit breaker only allows
`localhost:3000`, `127.0.0.1:3000` and extension origins — deliberately, since
it is an unauthenticated front door to the enclave. To add one:
`SHOU_ALLOWED_ORIGINS=http://localhost:5173 npm start`.

**`Gonka Router … returned 404` or `400 invalid_model`.** This was the original
blocker and it is resolved; if it reappears, the URL or the model ids are
wrong. Only fully-qualified ids are accepted — the two in the live path are
`deepseek-ai/DeepSeek-V4-Flash-0731` and `MiniMaxAI/MiniMax-M2.7`. Short forms
(`minimax`, `Kimi-K2.6`) return `400 invalid_model`. Fall back to
`SHOU_TEST_SCORER=1` (§2) and keep demoing.

**Scoring takes ~15s, or says "not cross-verified".** Expected on a cold,
novel message. The two model calls share one 14-second deadline and run
sequentially — concurrent calls to this router return HTTP 429, and when they
do not, they throttle badly (the same DeepSeek call: 2,472ms alone, 17,560ms
alongside one other). If under 4s remain after the classifier answers, the
second opinion is skipped and the reasoning trace says so. Nothing is wrong.

**The first scored message says `classifier unavailable`, later ones work.**
Cold start on the router, not a bug in the enclave. Measured 3 Sep 2026:
DeepSeek 26.7s cold, then 0.68s repeated and 1.79s for a novel prompt. The
14-second deadline cannot absorb that, so the first verdict falls to
deterministic rules. **Warm it before you present:**

```bash
cd shou && set -a && . ./.env && set +a
curl -s -o /dev/null -w '%{time_total}s\n' -X POST \
  https://api.gonkarouter.io/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer $GONKA_API_KEY" \
  -d '{"model":"deepseek-ai/DeepSeek-V4-Flash-0731","max_tokens":20,"messages":[{"role":"user","content":"warm"}]}'
```

Run it until it returns in ~2s, then start the demo. Note the router also
caches identical prompts, so re-running a saved scenario is a cache hit and
looks faster than a judge typing their own sentence will.

**Kimi returns nothing / HTTP 524.** Expected — it is not in the live path.
Only DeepSeek and MiniMax are called. As of 3 Sep 2026 Kimi does not answer
this router at all (524 after 126s), which is why.

**The page says "No policy id".** `demo-ids.json` is missing — run §4, then
restart the zkLogin server.

**UI changes not showing.** `public/app.js` is a build artifact. `npm start`
rebuilds it; editing `src/app.ts` alone changes nothing in the browser. Same
for the extension: `dist/` is built, and Chrome needs a reload of the
extension on top of that.

**No badges appear in WhatsApp Web.** Open the page console. The content
script prints which half failed — no conversation panel found, or a panel with
no readable messages. Both mean the selectors have rotted; they are all in
`packages/extension/src/adapters.ts`.

**Badges say "not checked".** The extension reached nothing. Check
`curl -s localhost:4000/health`, then that the extension's circuit-breaker URL
matches. It never invents a LOW on failure, so this is the honest symptom
rather than a hidden one.

**The dashboard is empty but a transfer exists.** The event filter is per
package and the policy id is checked on every row, so a request raised against
a *different* policy will not show. Confirm the dashboard's policy id matches
the one the transfer was raised against.

**The dashboard hides its buttons.** The signing key is not on that policy's
approver list. Reseed with `SHOU_GUARDIAN_ADDRESS=<you>` (§4).
