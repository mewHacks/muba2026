#!/usr/bin/env bash
# SHOU — one command that says whether everything is fine.
#
# Run it before a demo, and after any change. It checks the things that
# actually break: a service that is down, a test that regressed, and the
# scoring path end to end. It does NOT need a browser.
#
#   ./verify.sh          checks tests + whatever services are running
#   ./verify.sh --full   also starts any service that is not up
#
# Exit code is 0 only if every check passed, so it works in a pre-demo
# checklist or a git hook.

set -uo pipefail
cd "$(dirname "$0")"

PASS=0; FAIL=0; SKIP=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; SKIP=$((SKIP+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Amounts are the strongest scam signal and identify nobody, so redaction
# keeps them — these fixtures check that as well as the tiers.
SCAM='Madam Wong, this is Inspector Danial from Bukit Aman. Your account 5591023847 is linked to money laundering. Transfer RM8500 within the hour to avoid arrest. Do not tell your children. Call 011-2288 4471.'
CLEAN='Dinner is at 7pm. Do you need anything from the market?'
POLICY=$(python3 -c "import json;print(json.load(open('demo-ids.json'))['policyId'])" 2>/dev/null || echo '')

up() { lsof -ti :"$1" >/dev/null 2>&1; }

# ── 1. tests ────────────────────────────────────────────────────────
head_ "1 · Tests"

count() { grep -oE 'pass [0-9]+' | head -1 | grep -oE '[0-9]+'; }
check_suite() {
  local name="$1" expected="$2" got
  got=$(eval "$3" 2>/dev/null | count)
  if [ "${got:-0}" = "$expected" ]; then ok "$name — $got/$expected"
  else bad "$name — got ${got:-0}, expected $expected"; fi
}

check_suite "redaction"          7 "node --experimental-strip-types packages/redact/src/redact.test.ts"
check_suite "recovery multisig"  6 "node --experimental-strip-types packages/driver/src/recovery.test.ts"
check_suite "scoring arithmetic" 12 "(cd packages/gonka-client && npm test)"
check_suite "extension adapters" 22 "(cd packages/extension && npm test)"

n=$(node --experimental-strip-types enclave/src/session-risk.test.ts 2>/dev/null | grep -c '^ok')
[ "$n" = "6" ] && ok "enclave session binding — 6/6" || bad "enclave session binding — got $n, expected 6"

if command -v sui >/dev/null 2>&1; then
  if (cd move && sui move test 2>&1 | grep -q 'Total tests: 38; passed: 38'); then ok "Move contracts — 38/38"
  else bad "Move contracts — not 38/38"; fi
else skip "Move contracts — sui CLI not on PATH"; fi

# ── 2. typecheck and build ──────────────────────────────────────────
head_ "2 · Typecheck and build"
for p in driver dashboard extension; do
  if [ -x "packages/$p/node_modules/.bin/tsc" ]; then
    if (cd "packages/$p" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json >/dev/null 2>&1)
      then ok "packages/$p typechecks"; else bad "packages/$p has type errors"; fi
  else skip "packages/$p — run npm install"; fi
done

if (cd packages/extension && npm run build >/dev/null 2>&1); then
  missing=$(python3 - <<'PY'
import json, pathlib
m = json.loads(pathlib.Path('packages/extension/manifest.json').read_text())
d = pathlib.Path('packages/extension/dist')
refs = [m['background']['service_worker'], m['action']['default_popup'], m['options_page']]
refs += m['content_scripts'][0]['js'] + list(m['icons'].values())
print(','.join(r for r in refs if not (d / r).exists()))
PY
)
  [ -z "$missing" ] && ok "extension builds, manifest refs resolve" || bad "extension manifest points at missing: $missing"

  # A raw NUL makes the bundle test as binary: `file` says "data" and grep
  # silently reports no matches. Caught once already; keep it caught.
  nuls=$(python3 -c "
import pathlib
print(sum(p.read_bytes().count(b'\x00') for p in pathlib.Path('packages/extension/dist').rglob('*.js')))")
  [ "$nuls" = "0" ] && ok "bundle is text (no raw NUL bytes)" || bad "bundle contains $nuls raw NUL bytes"
else bad "extension build failed"; fi

# ── 3. services ─────────────────────────────────────────────────────
head_ "3 · Services"

if [ "${1:-}" = "--full" ]; then
  set -a; . ./.env 2>/dev/null; set +a
  up 3100 || (cd enclave && nohup node --experimental-strip-types src/server.ts >/tmp/shou-enclave.log 2>&1 &)
  up 4000 || (cd packages/circuit-breaker && nohup npm start >/tmp/shou-cb.log 2>&1 &)
  up 4200 || (cd packages/dashboard && nohup npm start >/tmp/shou-dash.log 2>&1 &)
  for _ in $(seq 1 30); do up 3100 && up 4000 && up 4200 && break; sleep 1; done
fi

enclave=$(curl -s -m 5 localhost:3100/health_check 2>/dev/null)
if echo "$enclave" | grep -q '"status":"ok"'; then
  ok "enclave :3100"
  echo "$enclave" | grep -q '"gonkaConfigured":true' \
    && ok "  Gonka key present (real models)" \
    || skip "  no Gonka key — scoring uses the dev heuristic"
else bad "enclave :3100 not responding"; fi

curl -s -m 5 localhost:4000/health 2>/dev/null | grep -q '"status":"ok"' \
  && ok "circuit breaker :4000 (and it reaches the enclave)" \
  || bad "circuit breaker :4000 not responding, or cannot reach the enclave"

cfg=$(curl -s -m 10 127.0.0.1:4200/api/config 2>/dev/null)
if echo "$cfg" | grep -q '"policyId"'; then
  ok "dashboard :4200"
  echo "$cfg" | grep -q '"approver":true' \
    && ok "  signing key IS an approver on this policy" \
    || bad "  signing key is NOT an approver — reseed with SHOU_GUARDIAN_ADDRESS=<you>"
else bad "dashboard :4200 not responding"; fi

# ── 4. scoring, end to end ──────────────────────────────────────────
head_ "4 · Scoring (exactly what the extension does)"

if up 4000 && [ -n "$POLICY" ]; then
  score() {
    python3 - "$1" "$2" <<'PY'
import json, sys, urllib.request, subprocess, re
msg, policy = sys.argv[1], sys.argv[2]
# Redact on-device first, the way the content script does.
out = subprocess.run(
    ['node', '--experimental-strip-types', '-e',
     "import {redact} from './packages/redact/src/redact.ts';"
     "const r=redact(process.argv[1]);console.log(JSON.stringify(r));", '--', msg],
    capture_output=True, text=True)
red = json.loads([l for l in out.stdout.splitlines() if l.startswith('{')][0])
req = urllib.request.Request(
    'http://127.0.0.1:4000/risk',
    data=json.dumps({'sessionId': 'verify-' + str(abs(hash(msg)))[:8],
                     'message': red['text'], 'policyId': policy}).encode(),
    headers={'content-type': 'application/json',
             'origin': 'chrome-extension://verifyverifyverifyverifyverifyve'})
v = json.loads(urllib.request.urlopen(req, timeout=60).read())
print(json.dumps({'tier': v.get('tier'), 'score': v.get('truthScore'),
                  'ids': len(v.get('gonkaRequestIds') or []),
                  'redacted': red['removed'], 'text': red['text']}))
PY
  }

  r=$(score "$SCAM" "$POLICY" 2>/dev/null)
  tier=$(echo "$r" | python3 -c "import json,sys;print(json.load(sys.stdin)['tier'])" 2>/dev/null)
  ids=$(echo  "$r" | python3 -c "import json,sys;print(json.load(sys.stdin)['ids'])" 2>/dev/null)
  txt=$(echo  "$r" | python3 -c "import json,sys;print(json.load(sys.stdin)['text'])" 2>/dev/null)
  [ "$tier" = "HIGH" ] && ok "scam message → 🔴 HIGH" || bad "scam message → ${tier:-no response} (expected HIGH)"
  echo "$txt" | grep -q '\[PHONE\]' && echo "$txt" | grep -q '\[ACCOUNT\]' \
    && ok "  phone and account stripped on-device before sending" \
    || bad "  redaction did not strip phone/account"
  echo "$txt" | grep -q 'RM8500' \
    && ok "  amount kept (the strongest signal, identifies nobody)" \
    || bad "  amount was lost in redaction"
  [ "${ids:-0}" -gt 0 ] && ok "  $ids Gonka request id(s) returned" \
    || skip "  no request ids — scored on deterministic rules (router cold or slow)"

  r=$(score "$CLEAN" "$POLICY" 2>/dev/null)
  tier=$(echo "$r" | python3 -c "import json,sys;print(json.load(sys.stdin)['tier'])" 2>/dev/null)
  [ "$tier" = "LOW" ] && ok "clean message → 🟢 LOW" || bad "clean message → ${tier:-no response} (expected LOW)"
else
  skip "scoring — circuit breaker down, or no policy id in demo-ids.json"
fi

# ── summary ─────────────────────────────────────────────────────────
head_ "Summary"
printf '  %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -eq 0 ]; then
  printf '\n  \033[32mEverything checkable from here is fine.\033[0m\n'
  cat <<'MANUAL'

  Two things only a human can confirm:
    1. Load the extension  chrome://extensions → ↻ on SHOU → reload
       web.whatsapp.com with a chat OPEN. An incoming message should get a
       coloured pill; the toolbar icon should get a ✓/?/! badge.
    2. Approve or block   a held transfer on the dashboard is a real
       on-chain call, so it costs gas and cannot be undone. Do it once on
       testnet before demo day, not during it.
MANUAL
else
  printf '\n  \033[31m%d check(s) failed — see above.\033[0m\n' "$FAIL"
fi
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
