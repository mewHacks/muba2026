# @shou/extension — the Chrome extension

Reads the conversation she is already in, scores each incoming message
inside the enclave, and shows an inline 🟢/🟡/🔴 badge. She does nothing
differently: no copy-pasting, no button to press.

**This is the demo message source, and it is not ToS-compliant.**
Automated access to the WhatsApp consumer client is prohibited by its
Terms of Service. It is here so this can be shown on our own accounts.
The production source is the WhatsApp Business API behind the same
pipeline — see "Future implementation" in the root README.

## Build and load

```bash
npm install
npm run build          # or: npm run watch
```

Then `chrome://extensions` → Developer mode → **Load unpacked** →
`shou/packages/extension/dist`.

It needs the enclave and the circuit breaker running:

```bash
cd shou/enclave                  && SHOU_TEST_SCORER=1 npm start   # :3100
cd shou/packages/circuit-breaker && npm start                      # :4000
```

Open the extension's **Settings** and press **Fetch policy id from
dashboard** (with the dashboard running on :4200), or paste the
`policyId` from `shou/demo-ids.json`. Scoring is *refused* until a policy
id is set — see below.

```bash
npm test               # 6 tests: host matching, message identity, normalisation
```

## What runs where, and why it is split that way

| File | Context | Job |
|---|---|---|
| `src/content.ts` | the page | reads new incoming messages, **redacts them here**, injects the badge |
| `src/background.ts` | service worker | the only thing that touches the network |
| `src/adapters.ts` | the page | per-site DOM selectors, isolated so a break is a five-line fix |
| `src/popup.ts` | popup | her screen: Truth Score, reasoning, Gonka Request IDs |
| `src/options.ts` | options page | three URLs and the policy id |

Three of those splits are load-bearing rather than tidiness:

**Redaction happens in the content script, not the worker.** `redact()`
is imported from `@shou/redact` — the same module the enclave runs — and
applied before the text is handed to anything, including this
extension's own service worker. Identifying values do not cross the
network because they do not survive that file. The enclave redacts again
on arrival, so a stale or bypassed copy of this extension cannot cause
raw PII to be scored.

**The fetch happens in the service worker, not the content script.** A
fetch from a content script carries the *page's* origin
(`https://web.whatsapp.com`), which the circuit breaker correctly
refuses — its CORS allow-list is deliberately not `*`, because it is an
unauthenticated front door to the enclave. A fetch from the worker
carries `chrome-extension://<id>`, which the allow-list does admit. The
split exists because of the trust boundary the circuit breaker draws.
It also means a compromised page cannot reach the enclave: it can ask
this worker to score a message, and that is the whole surface.

**Only incoming messages are scored.** WhatsApp marks them
`div.message-in`, as against `message-out` for her own. Scoring her own
words would let her quoting a scammer back — *"they want RM5000 by
6pm?"* — raise her own risk tier, which punishes exactly the person who
is starting to catch on.

## Decisions worth knowing before you change it

**No policy id means no scoring.** The enclave files each verdict against
a policy so that a swapped session id cannot launder a HIGH away. Sending
the zero address would file every verdict under nothing and quietly
defeat that, so the worker refuses and the badge says why.

**The conversation id is a hash.** `sessionId` is
`sha256(host + '|' + thread title)`, truncated. The circuit breaker needs
a *stable* key to correlate messages, not a meaningful one, so it never
learns who she talks to.

**The worst verdict wins, not the newest** — both on the toolbar badge
and per conversation. A scammer who turns friendly right before asking
for money would otherwise walk the badge back to green in the seconds
that matter most. Same rule as the enclave's session state and the
chain's tier logic.

**Nothing is written to disk.** Verdicts live in service-worker memory
only. A record of which conversations scored HIGH, surviving restarts on
her laptop, is a list of who has been trying to scam her — useful to
exactly one other party.

**A failure shows as "not checked", never as green.** If the circuit
breaker is unreachable the badge says so and no verdict is invented. The
chain then applies her own amount ceilings with no verdict present,
which is the documented degraded behaviour rather than a silent gap.

**Clean messages get a badge too.** An indicator that appears only on
danger is indistinguishable from one that is broken.

## When the selectors break

They will, and they already did once. In September 2026 WhatsApp Web moved
to `[data-testid="msg-container"]` and the older selectors went to zero:

| selector | matches on the live DOM |
|---|---|
| `#main [data-testid="msg-container"]` | 35 — the current shape |
| `div.message-in` | 0 — gone |
| `[data-id^="false_"]` | 0 — gone from containers |

The symptom was silence: nothing scored, no badges, no error. That is the
failure mode to expect, which is why `src/adapters.dom.test.ts` now pins the
contract against a real DOM — 14 tests over fixtures cut from that markup.

**How direction is decided now**, in priority order:

1. `data-id` if present — WhatsApp's own record, and it states the direction
   outright (`true_…` / `false_…`).
2. Otherwise, a delivery tick: `msg-check`, `msg-dblcheck` or `msg-time`.
   These render on **your own** messages only, so their presence means
   outgoing. Confirmed on the live DOM: an outgoing bubble has exactly one,
   an incoming bubble has none.
3. Otherwise, incoming. Absence of evidence is treated as incoming because a
   missed incoming message is a protection gap, while a wrongly-scored
   outgoing one can only ever hold money still.

The selector union overlaps deliberately, so candidates are deduped by
element identity, by nesting (a container inside a matching row), and by
message key — otherwise one sentence becomes three model calls and three
badges.

`describeFailure()` prints to the page console which half broke — no
conversation panel found, or a panel with no readable messages — but only
after 20 seconds, since at `document_idle` WhatsApp Web has not rendered a
chat yet and an immediate check reported a failure on every single load.

Messenger remains the more fragile of the two: it has no stable equivalent
of any of this, so incoming is inferred from the row's accessible label.
