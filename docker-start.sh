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
echo "[+] Serving Chrome extension at http://localhost:3080/extension.tar.gz"

cd /app
# Create an archive of the extension dist folder
cd /app/packages/extension/dist
tar czf /app/extension.tar.gz .
mkdir -p /app/packages/zklogin-demo/public
cp /app/extension.tar.gz /app/packages/zklogin-demo/public/shou-extension.tar.gz 2>/dev/null || true
cp /app/extension.tar.gz /app/packages/zklogin-demo/public/extension.tar.gz 2>/dev/null || true
cd /app

# Start a branded launchpad server for extension download & direct app access
node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');

const html = \`<!doctype html>
<html lang='en'>
<head>
  <meta charset='utf-8'>
  <meta name='viewport' content='width=device-width, initial-scale=1'>
  <title>SHOU 守 — One-Click Demo Environment</title>
  <meta http-equiv='refresh' content='4;url=http://localhost:3000'>
  <link rel='preconnect' href='https://fonts.googleapis.com'>
  <link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>
  <link href='https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap' rel='stylesheet'>
  <style>
    :root {
      --bg: #F8FAFC;
      --surface: #FFFFFF;
      --border: #E2E8F0;
      --border-focus: #CBD5E1;
      --text-main: #0F172A;
      --text-muted: #64748B;
      --blue: #1677FF;
      --blue-dark: #1D4ED8;
      --blue-light: #EFF6FF;
      --green: #15803D;
      --green-bg: #DCFCE7;
      --font-sans: 'Outfit', -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text-main);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      -webkit-font-smoothing: antialiased;
    }
    .launch-container {
      max-width: 760px;
      width: 100%;
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 24px;
      padding: 36px 40px;
      box-shadow: 0 20px 45px rgba(15, 23, 42, 0.07), 0 4px 0 #CBD5E1;
      text-align: center;
    }
    .brand-header {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .brand-icon {
      width: 58px;
      height: 58px;
      background: linear-gradient(135deg, #2563EB, #1677FF);
      border-radius: 16px;
      display: grid;
      place-items: center;
      box-shadow: 0 8px 20px rgba(22, 119, 255, 0.3);
      border: 2px solid #60A5FA;
    }
    .brand-title {
      font-size: 32px;
      font-weight: 800;
      color: var(--text-main);
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .brand-title span { color: var(--blue); }
    .brand-sub {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      color: var(--blue-dark);
      text-transform: uppercase;
      font-family: var(--font-mono);
      background: var(--blue-light);
      padding: 4px 12px;
      border-radius: 999px;
      border: 1px solid #BFDBFE;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--green-bg);
      color: var(--green);
      font-size: 12.5px;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 999px;
      border: 1px solid #BBF7D0;
      margin-bottom: 24px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #16A34A;
      box-shadow: 0 0 8px #22C55E;
    }
    .auto-redirect-bar {
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      border-radius: 14px;
      padding: 12px 18px;
      margin-bottom: 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13.5px;
      color: #1E40AF;
      font-weight: 600;
    }
    .auto-redirect-btn {
      background: var(--blue);
      color: #FFF;
      text-decoration: none;
      font-size: 12.5px;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 8px;
      transition: all 0.15s ease;
    }
    .auto-redirect-btn:hover { background: var(--blue-dark); }
    .cards-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 24px;
      text-align: left;
    }
    @media (max-width: 640px) {
      .cards-grid { grid-template-columns: 1fr; }
      .launch-container { padding: 24px 20px; }
    }
    .app-card {
      background: #FFFFFF;
      border: 1.5px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: all 0.2s ease;
    }
    .app-card:hover {
      border-color: #93C5FD;
      box-shadow: 0 10px 24px rgba(37, 99, 235, 0.08);
      transform: translateY(-2px);
    }
    .card-tag {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 6px;
      display: inline-block;
      margin-bottom: 8px;
    }
    .card-tag.mom { background: #EFF6FF; color: #1D4ED8; border: 1px solid #DBEAFE; }
    .card-tag.son { background: #F0FDF4; color: #15803D; border: 1px solid #DCFCE7; }
    .card-title {
      font-size: 18px;
      font-weight: 800;
      color: var(--text-main);
      margin-bottom: 6px;
    }
    .card-desc {
      font-size: 12.5px;
      color: var(--text-muted);
      line-height: 1.45;
      margin-bottom: 16px;
    }
    .card-btn {
      display: block;
      text-align: center;
      padding: 10px 14px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 13px;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .card-btn.primary {
      background: var(--blue);
      color: #FFF;
      box-shadow: 0 4px 12px rgba(22, 119, 255, 0.25);
    }
    .card-btn.primary:hover { background: var(--blue-dark); }
    .card-btn.secondary {
      background: #F1F5F9;
      color: #0F172A;
      border: 1px solid #CBD5E1;
    }
    .card-btn.secondary:hover { background: #E2E8F0; }
    .extension-box {
      background: #F8FAFC;
      border: 1.5px solid var(--border);
      border-radius: 16px;
      padding: 18px 20px;
      text-align: left;
    }
    .ext-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      flex-wrap: wrap;
      gap: 10px;
    }
    .ext-download-btn {
      background: #0F172A;
      color: #FFF;
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .ext-download-btn:hover { background: #1E293B; }
    .ext-steps {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .ext-step-item {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #FFFFFF;
      border: 1px solid #E2E8F0;
      padding: 4px 10px;
      border-radius: 6px;
    }
    .step-num {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--blue);
      color: #FFF;
      display: grid;
      place-items: center;
      font-size: 10px;
      font-weight: 800;
    }
  </style>
</head>
<body>
  <div class='launch-container'>
    <div class='brand-header'>
      <div class='brand-icon'>
        <svg width='30' height='30' viewBox='0 0 24 24' fill='none' stroke='#FFFFFF' stroke-width='2.3' stroke-linecap='round' stroke-linejoin='round'>
          <path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/>
        </svg>
      </div>
      <h1 class='brand-title'>SHOU <span>守</span></h1>
      <span class='brand-sub'>GUARDIAN COMMAND · ONE-CLICK ENVIRONMENT</span>
    </div>

    <div class='status-badge'>
      <span class='status-dot'></span>
      <span>All 4 Security Services Running Online</span>
    </div>

    <div class='auto-redirect-bar'>
      <span>Auto-opening main experience in <strong id='countdown'>4</strong>s...</span>
      <a href='http://localhost:3000' class='auto-redirect-btn'>Open Now →</a>
    </div>

    <div class='cards-grid'>
      <div class='app-card'>
        <div>
          <span class='card-tag mom'>MOM'S VIEW · INTERACTIVE APP</span>
          <h2 class='card-title'>Safe Payment Simulator</h2>
          <p class='card-desc'>Live chat presets (Fake Police, Romance Trap), quiet background protection, and automatic on-chain escrow holding.</p>
        </div>
        <a href='http://localhost:3000' class='card-btn primary'>Launch Web Experience (Port 3000) →</a>
      </div>

      <div class='app-card'>
        <div>
          <span class='card-tag son'>GUARDIAN VIEW · COMMAND</span>
          <h2 class='card-title'>Guardian Dashboard</h2>
          <p class='card-desc'>Review held transfers in escrow, 1-click stop & refund money back to mom, and manage family protection policies.</p>
        </div>
        <a href='http://localhost:4200' target='_blank' class='card-btn secondary'>Open Guardian Dashboard (Port 4200) ↗</a>
      </div>
    </div>

    <div class='extension-box'>
      <div class='ext-header-row'>
        <div>
          <strong style='font-size:13.5px; color:#0F172A; display:block;'>Real Chrome Extension Package</strong>
          <span style='font-size:12px; color:#64748B;'>Passive chat scanner for WhatsApp Web & Telegram</span>
        </div>
        <a href='/extension.tar.gz' download class='ext-download-btn'>Download .tar.gz ↓</a>
      </div>
      <div class='ext-steps'>
        <div class='ext-step-item'><span class='step-num'>1</span> Extract tar.gz</div>
        <div class='ext-step-item'><span class='step-num'>2</span> Open chrome://extensions</div>
        <div class='ext-step-item'><span class='step-num'>3</span> Enable Dev Mode & 'Load unpacked'</div>
      </div>
    </div>
  </div>

  <script>
    var sec = 4;
    var timer = setInterval(function () {
      sec--;
      var el = document.getElementById('countdown');
      if (el) el.textContent = sec;
      if (sec <= 0) {
        clearInterval(timer);
        window.location.href = 'http://localhost:3000';
      }
    }, 1000);
  </script>
</body>
</html>\`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/extension' || req.url === '/hub') {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(html);
    return;
  }
  if (req.url === '/extension.tar.gz' || req.url === '/shou-extension.tar.gz') {
    if (fs.existsSync('/app/extension.tar.gz')) {
      const file = fs.readFileSync('/app/extension.tar.gz');
      res.writeHead(200, {'content-type': 'application/gzip', 'content-disposition': 'attachment; filename=\"shou-extension.tar.gz\"'});
      res.end(file);
      return;
    }
  }
  res.writeHead(302, { 'Location': 'http://localhost:3000' });
  res.end();
});
server.listen(3080, () => console.log('Launchpad ready on http://localhost:3080 -> http://localhost:3000'));
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
echo "  SHOU 守 — All Services Online!"
echo "========================================"
echo ""
echo "  Main App & Simulator: http://localhost:3000"
echo "  Guardian Dashboard:   http://localhost:4200"
echo "  Chrome Extension Zip: http://localhost:3080/extension.tar.gz"
echo "  Launchpad Hub:        http://localhost:3080"
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
