// Tiny static server for the zkLogin demo.
//
// It reads GOOGLE_CLIENT_ID and NEXT_PUBLIC_ENOKI_API_KEY from .env and
// serves them to the browser at /config.json. Both are *public* values
// by design — a Google client ID is visible in the OAuth redirect URL,
// and Enoki's public key is explicitly "intended to be used within
// client-side apps". Nothing secret is served here.
//
// ENOKI_PRIVATE_KEY and CLIENT_SECRET are deliberately NOT read: the
// private key authorises spending your sponsorship budget and belongs
// server-side only, and zkLogin never needs the client secret because
// it uses response_type=id_token (no token exchange).

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

function loadEnv() {
  // Walk up to the repo root .env.
  for (const path of ['../../../.env', '../../.env', '../.env', '.env']) {
    try {
      const raw = readFileSync(join(HERE, path), 'utf8');
      const env = {};
      for (const line of raw.split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
      return env;
    } catch {
      /* keep looking */
    }
  }
  return {};
}

// Real on-chain object ids, written by packages/driver/src/seed-demo.ts.
// The page refuses to prepare a transfer without these rather than falling
// back to a placeholder id — a signed attestation for a policy that does
// not exist looks perfectly healthy right up until it is submitted.
function loadDemoIds() {
  for (const path of ['../../demo-ids.json', '../../../demo-ids.json']) {
    try {
      return JSON.parse(readFileSync(join(HERE, path), 'utf8'));
    } catch {
      /* keep looking */
    }
  }
  return {};
}

const env = loadEnv();
const demo = loadDemoIds();
const config = {
  googleClientId: env.GOOGLE_CLIENT_ID ?? '',
  enokiApiKey: env.NEXT_PUBLIC_ENOKI_API_KEY ?? '',
  network: 'testnet',
  redirectUrl: `http://localhost:${PORT}/auth/callback`,
  policyId: demo.policyId ?? '',
  denyListId: demo.denyListId ?? '',
  packageId: demo.packageId ?? '',
};

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// Her real limits, read from the guardian dashboard, which reads them from
// the chain. Fetched HERE rather than in the browser because :4200 binds to
// 127.0.0.1 and answers no CORS preflight, so the page cannot reach it.
//
// This exists because the transfer panel used to hard-code "$1.00" in four
// places. The whole premise is that she sets her own limits, so a screen
// that states a number she did not choose is describing a different product.
// When the dashboard is down these stay null and the page says "her limit"
// rather than inventing a figure.
const DASHBOARD_URL = process.env.SHOU_DASHBOARD_URL ?? 'http://127.0.0.1:4200';
async function fetchCeilings() {
  try {
    const response = await fetch(`${DASHBOARD_URL}/api/config`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return {};
    const body = await response.json();
    return {
      reviewCeiling: body.reviewCeiling ?? null,
      highRiskCeiling: body.highRiskCeiling ?? null,
      cooldownMs: body.cooldownMs ?? null,
      policyOwner: body.owner ?? null,
    };
  } catch {
    // The dashboard is not running. Not an error here — this server's job
    // is sign-in, and the page degrades to describing the rule without a
    // number rather than failing.
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ...config, ...(await fetchCeilings()) }));
  }

  // The OAuth callback lands here with the JWT in the URL *fragment*,
  // which never reaches the server — the browser reads it. So this just
  // serves the same page again and the client finishes the flow.
  let file = url.pathname === '/' || url.pathname === '/auth/callback' ? '/index.html' : url.pathname;
  if (file.startsWith('/auth/')) {
    file = file.replace(/^\/auth/, '');
  }

  // Traversal guard. `new URL()` already normalises `..` out of the path,
  // so `/../server.mjs` never reaches here — but that is this code being
  // correct by accident. Resolve the path and confirm it really is inside
  // public/, so it stays correct if the parsing above ever changes.
  const root = resolve(HERE, 'public');
  const target = resolve(root, '.' + file);
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = readFileSync(target);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`zkLogin demo on http://localhost:${PORT}`);
  const missing = [
    !config.googleClientId && 'GOOGLE_CLIENT_ID',
    !config.enokiApiKey && 'NEXT_PUBLIC_ENOKI_API_KEY',
  ].filter(Boolean);
  if (missing.length) console.warn(`WARNING: missing from .env: ${missing.join(', ')}`);
  else console.log('config loaded: client id and Enoki public key both present');
  if (config.policyId) console.log(`demo policy: ${config.policyId}`);
  else
    console.warn(
      'WARNING: no demo-ids.json — the transfer panel will refuse to prepare.\n' +
        '  Run: node --experimental-strip-types packages/driver/src/seed-demo.ts',
    );
});
