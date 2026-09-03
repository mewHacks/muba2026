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
import { dirname, extname, join } from 'node:path';
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(config));
  }

  // The OAuth callback lands here with the JWT in the URL *fragment*,
  // which never reaches the server — the browser reads it. So this just
  // serves the same page again and the client finishes the flow.
  const file = url.pathname === '/' || url.pathname === '/auth/callback' ? '/index.html' : url.pathname;

  try {
    const body = readFileSync(join(HERE, 'public', file));
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
