#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# SHOU — one-click demo (no Docker needed, just Node 22+)
#
# Usage:  ./start-demo.sh
#
# What it does:
#   1. Installs all npm dependencies
#   2. Builds the extension, dashboard, and zklogin-demo bundles
#   3. Starts all 4 services
#   4. Tells you how to load the extension in Chrome
# ─────────────────────────────────────────────────────────────────────

set -e
cd "$(dirname "$0")/shou"

echo ""
echo "========================================"
echo "  SHOU — one-click demo"
echo "========================================"
echo ""

# ── 1. Install deps ──
echo "[1/3] Installing dependencies..."
for d in enclave packages/*/; do
  echo "  - $d"
  [ -d "$d/node_modules" ] || (cd "$d" && npm install --no-audit --no-fund)
done

# ── 2. Build bundles ──
echo ""
echo "[2/3] Building..."
echo "  - extension"
(cd packages/extension && npm run build >/dev/null 2>&1)
echo "  - dashboard"
(cd packages/dashboard && npm run build >/dev/null 2>&1)
echo "  - zklogin-demo"
(cd packages/zklogin-demo && npm run build >/dev/null 2>&1)

# ── 3. Start services ──
echo ""
echo "[3/3] Starting services..."

# Check for Gonka API key — use real models if available
if [ -n "$GONKA_API_KEY" ]; then
  echo "  [+] GONKA_API_KEY found — real AI scoring (DeepSeek + MiniMax)"
  SCORER_ENV=""
else
  echo "  [!] No GONKA_API_KEY — using dev heuristic (labeled on screen)"
  SCORER_ENV="SHOU_TEST_SCORER=1"
fi

(cd enclave && eval "$SCORER_ENV exec node --experimental-strip-types src/server.ts") &
PID_ENCLAVE=$!

(cd packages/circuit-breaker && exec node --experimental-strip-types src/server.ts) &
PID_CB=$!

sleep 1

(cd packages/zklogin-demo && exec npm start) &
PID_DEMO=$!

(cd packages/dashboard && exec npm start) &
PID_DASH=$!

trap 'kill $PID_ENCLAVE $PID_CB $PID_DEMO $PID_DASH 2>/dev/null' EXIT INT TERM

# ── Done ──
echo ""
echo "========================================"
echo "  Ready!"
echo "========================================"
echo ""
echo "  Sign-in + wallet:    http://localhost:3000"
echo "  Guardian dashboard: http://localhost:4200"
echo "  Enclave health:     http://localhost:3100/health_check"
echo "  Circuit breaker:    http://localhost:4000/health"
echo ""
echo "  Chrome extension:   $(pwd)/packages/extension/dist"
echo ""
echo "  To install the extension:"
echo "    1. Go to chrome://extensions"
echo "    2. Enable Developer mode (top right)"
echo "    3. Click 'Load unpacked'"
echo "    4. Select: $(pwd)/packages/extension/dist"
echo "    5. Click the extension icon, go to Settings"
echo "    6. Click 'Fetch policy id from dashboard'"
echo ""
echo "  Press Ctrl+C to stop all services."
echo "========================================"
echo ""

wait
