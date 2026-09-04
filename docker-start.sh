#!/usr/bin/env bash
set -e

echo ""
echo "========================================"
echo "  SHOU — one-click demo environment"
echo "========================================"
echo ""

cd /app

# ── Check if we have a real Gonka API key ──
if [ -n "$GONKA_API_KEY" ]; then
  echo "  [+] GONKA_API_KEY found — using real AI scoring (DeepSeek + MiniMax)"
  SCORER_FLAG=""
else
  echo "  [!] No GONKA_API_KEY — falling back to dev heuristic"
  echo "      The UI will label scores as 'DEV MODE heuristic — not a real classifier'"
  SCORER_FLAG="SHOU_TEST_SCORER=1"
fi
echo ""

# ── Start all 4 services in the background ──

echo "[1/4] Starting enclave (TEE scoring) on :3100..."
cd /app/enclave
eval "$SCORER_FLAG node --experimental-strip-types src/server.ts" &
ENCLAVE_PID=$!

echo "[2/4] Starting circuit breaker on :4000..."
cd /app/packages/circuit-breaker
node --experimental-strip-types src/server.ts &
CB_PID=$!

# Give the enclave a moment to be ready before the dashboard tries to reach it
sleep 1

echo "[3/4] Starting zkLogin demo (sign-in + transfer panel) on :3000..."
cd /app/packages/zklogin-demo
npm start &
DEMO_PID=$!

echo "[4/4] Starting guardian dashboard on :4200..."
cd /app/packages/dashboard
npm start &
DASH_PID=$!

# ── Serve the extension dist/ folder for download ──
echo ""
echo "[+] Serving Chrome extension at http://localhost:3000/extension.zip"

cd /app
# Create a zip of the extension dist folder
cd /app/packages/extension/dist
# Use tar since zip may not be available
tar czf /app/extension.tar.gz .
cd /app

# Start a tiny static server for the extension download + a landing page
node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/extension') {
    res.writeHead(200, {'content-type': 'text/html'});
    res.end(\`
      <!doctype html><html><head><meta charset='utf-8'><title>SHOU Demo</title>
      <style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;background:#0A0D14;color:#fff}
      a{color:#3898FF;font-size:18px}h1{font-size:28px}p{color:#868C98;line-height:1.6}
      code{background:#1a1a2e;padding:2px 6px;border-radius:4px;color:#3898FF}</style>
      </head><body>
      <h1>SHOU Demo is running</h1>
      <p>Everything is ready. Here's what to open:</p>
      <ul style='line-height:2;color:#868C98'>
        <li><a href='http://localhost:3000'>localhost:3000</a> — Sign-in + transfer panel</li>
        <li><a href='http://localhost:4200'>localhost:4200</a> — Guardian dashboard</li>
        <li><a href='/extension.tar.gz' download>Download Chrome extension</a> — then load unpacked in Chrome</li>
      </ul>
      <p style='margin-top:32px'>To install the extension: download, extract, then go to <code>chrome://extensions</code>, enable Developer mode, click Load unpacked, select the extracted folder.</p>
      </body></html>
    \`);
    return;
  }
  if (req.url === '/extension.tar.gz') {
    const file = fs.readFileSync('/app/extension.tar.gz');
    res.writeHead(200, {'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="shou-extension.tar.gz"'});
    res.end(file);
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});
server.listen(3080, () => console.log('Landing page on http://localhost:3080'));
" &
LANDING_PID=$!

# ── Wait for services to be ready ──
echo ""
echo "Waiting for services to start..."
sleep 3

# Health checks
check() {
  local url="$1" name="$2"
  if curl -s -m 5 "$url" | grep -q "ok\|policyId\|status" 2>/dev/null; then
    echo "  [OK] $name"
  else
    echo "  [..] $name (still starting...)"
  fi
}

echo ""
echo "========================================"
echo "  All services started!"
echo "========================================"
echo ""
echo "  Landing page:     http://localhost:3080"
echo "  Sign-in + wallet: http://localhost:3000"
echo "  Guardian dashboard: http://localhost:4200"
echo "  Extension zip:     http://localhost:3080/extension.tar.gz"
echo ""
echo "  To install the Chrome extension:"
echo "    1. Download from the link above"
echo "    2. Extract the tar.gz"
echo "    3. Go to chrome://extensions"
echo "    4. Enable Developer mode (top right)"
echo "    5. Click 'Load unpacked' and select the extracted folder"
echo "    6. Open extension Settings, click 'Fetch policy id'"
echo ""
echo "  Logs are live below. Press Ctrl+C to stop everything."
echo "========================================"
echo ""

# Tail all service logs
wait
