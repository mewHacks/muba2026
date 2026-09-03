# SHOU — how to run everything

Three servers on three ports, then either the scripted proof or the browser
demo. Every command below is copy-paste from the repo root.

| Service | Port | Why it must be that port |
|---|---|---|
| zkLogin demo | 3000 | The Google OAuth origin and redirect are registered against :3000 in the Enoki portal. Changing it breaks sign-in. |
| enclave | 3100 | Moved off 3000 to stop it colliding with the above. |
| circuit breaker | 4000 | Talks to the enclave; the browser talks to it. |

Current deployment (`shou/demo-ids.json` is the source of truth, regenerated
per deploy — it is gitignored, so run the seeder after any republish):

```
package    0x96b8a4b313fe2fa5f7a06501a3cd4e8b1084746d0dda5565c0460fbda63836b3
denyList   0x54065b3de7e9b8cd3eb9c994e9be6ad406540657ee0b2d38548a9e56d0c3a453
adminCap   0x6b7bfe442feabc9e3ff535d7962a8d5016357f4b47a1f17d0948ee68c35dade3
```

---

## 1. Tests — no servers needed

```bash
cd shou
sui move test --path move                                        # 38 tests
node --experimental-strip-types packages/driver/src/recovery.test.ts   # 6
node --experimental-strip-types packages/redact/src/redact.test.ts     # 7
node --experimental-strip-types enclave/src/session-risk.test.ts       # 6
```

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
```

**If the Gonka Router is down** (it currently 404s), start the enclave with
the heuristic scorer instead, so everything downstream still works:

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
```

If `policyId` is empty, the page will refuse to prepare a transfer. Run the
seeder (§4) and restart terminal 3.

---

## 3. The scripted proof — the strongest single artifact

Needs the enclave (:3100) running. Moves real testnet USDC.

```bash
cd shou
SHOU_PACKAGE_ID=0x96b8a4b313fe2fa5f7a06501a3cd4e8b1084746d0dda5565c0460fbda63836b3 \
SHOU_ADMIN_CAP=0x6b7bfe442feabc9e3ff535d7962a8d5016357f4b47a1f17d0948ee68c35dade3 \
SHOU_DENY_LIST=0x54065b3de7e9b8cd3eb9c994e9be6ad406540657ee0b2d38548a9e56d0c3a453 \
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

## 6. When it breaks

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

**`Gonka Router … returned 404`.** The endpoint or model ids are wrong. Fall
back to `SHOU_TEST_SCORER=1` (§2) and keep demoing.

**The page says "No policy id".** `demo-ids.json` is missing — run §4, then
restart the zkLogin server.

**UI changes not showing.** `public/app.js` is a build artifact. `npm start`
rebuilds it; editing `src/app.ts` alone changes nothing in the browser.
