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
  // Walk up to the repo root .env. Absent in a deployed image on purpose:
  // .env is gitignored, so a host like Railway builds from a checkout that
  // has none. Real process env therefore wins over the file, and is the only
  // source in production — reading the file alone left googleClientId empty
  // and the sign-in page announcing "Not configured" with the variables set.
  const fromFile = {};
  for (const path of ['../../../.env', '../../.env', '../.env', '.env']) {
    try {
      const raw = readFileSync(join(HERE, path), 'utf8');
      for (const line of raw.split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (match) fromFile[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
      break;
    } catch {
      /* keep looking */
    }
  }
  return { ...fromFile, ...stripEmpty(process.env) };
}

// An env var set to the empty string is not a value. Object spread would let
// one shadow a real entry from the file, which is how a blank Railway
// variable silently unconfigures a working local setup.
function stripEmpty(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
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
  // demo-ids.json is gitignored (seed-demo.ts rewrites it per deployment), so
  // it is absent from a deployed image and these fall back to the environment.
  // Without them the page refuses to prepare a transfer at all.
  policyId: demo.policyId ?? env.SHOU_POLICY_ID ?? '',
  denyListId: demo.denyListId ?? env.SHOU_DENY_LIST ?? '',
  packageId: demo.packageId ?? env.SHOU_PACKAGE_ID ?? '',
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
  '.zip': 'application/zip',
};

// Her real limits, read from the guardian dashboard, which reads them from
// the chain. Fetched HERE rather than in the browser because :4200 binds to
// 127.0.0.1 and answers no CORS preflight, so the page cannot reach it.
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
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Dynamic public base URL: preserves the custom domain or Railway host in production
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
  const baseUrl = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : `${proto}://${host}`;

  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    const dynamicConfig = {
      ...config,
      redirectUrl: `${baseUrl}/auth/callback`,
      ...(await fetchCeilings()),
    };
    return res.end(JSON.stringify(dynamicConfig));
  }

  // Direct Chrome extension download
  if (url.pathname === '/shou-extension.zip' || url.pathname === '/extension.zip') {
    const zipPath = resolve(HERE, 'public', 'shou-extension.zip');
    try {
      const zipBody = readFileSync(zipPath);
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="shou-extension.zip"',
        'cache-control': 'public, max-age=300',
      });
      return res.end(zipBody);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Extension package not found. Run: npm run build in extension.');
      return;
    }
  }

  // Proxy Guardian Dashboard or API requests when deployed under a single domain
  if (url.pathname.startsWith('/api/') || url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
    if (url.pathname === '/dashboard') {
      res.writeHead(302, { Location: '/dashboard/' });
      return res.end();
    }
    const targetPath = url.pathname.startsWith('/dashboard/')
      ? url.pathname.replace(/^\/dashboard/, '')
      : url.pathname;
    try {
      const targetUrl = new URL(targetPath + url.search, DASHBOARD_URL);
      const proxyReq = (await import('node:http')).request(targetUrl, {
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.host,
        },
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => {
        res.writeHead(502, { 'content-type': 'text/plain' }).end('Guardian Dashboard is offline or unreachable.');
      });
      req.pipe(proxyReq);
      return;
    } catch {
      res.writeHead(502, { 'content-type': 'text/plain' }).end('Proxy configuration error');
      return;
    }
  }

  // The OAuth callback lands here with the JWT in the URL *fragment*,
  // which never reaches the server — the browser reads it. So this just
  // serves the same page again and the client finishes the flow.
  let file = url.pathname === '/' || url.pathname === '/auth/callback' ? '/index.html' : url.pathname;
  if (file.startsWith('/auth/')) {
    file = file.replace(/^\/auth/, '');
  }

  // Traversal guard
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
