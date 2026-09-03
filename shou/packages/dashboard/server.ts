// SHOU — the guardian dashboard server.
//
// This is the son's screen: the place where a held transfer is approved
// or blocked. It is a thin shell around @shou/driver — every decision is
// an ordinary on-chain call to `policy::approve` or
// `policy::block_and_refund`, so this process has no authority of its
// own. Stop it and the escrowed funds are unaffected; she can still
// cancel and be refunded.
//
// WHAT IT DELIBERATELY DOES NOT SERVE: message text, and any description
// of it. The guardian receives a tier and an amount, never a transcript
// of what his mother was told. That is not an oversight — see
// shou-idea.md §9 and the comment on /transfer/prepare in
// packages/circuit-breaker/src/server.ts. This server never talks to the
// enclave or the circuit breaker at all, so there is no code path by
// which a conversation could reach it.
//
// WHY IT HOLDS A KEY AT ALL. In production the guardian signs in with
// Enoki zkLogin in the browser and this server would be static hosting
// (see "Future implementation" in the README). For the demo it signs
// with a local keypair, which is why it binds to 127.0.0.1 and not
// 0.0.0.0: anyone who can reach this port can approve transfers as the
// guardian.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { SuiShouClient, TESTNET_USDC } from '../driver/src/client.ts';
import type { PolicyView, TransferRequestView } from '../driver/src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// 4200: 3000 is the sign-in page (its OAuth origin is registered against
// that port), 3100 the enclave, 4000 the circuit breaker.
const PORT = Number(process.env.PORT ?? 4200);

function loadEnv(): Record<string, string> {
  for (const path of ['../../.env', '../../../.env', '../.env', '.env']) {
    try {
      const raw = readFileSync(join(HERE, path), 'utf8');
      const env: Record<string, string> = {};
      for (const line of raw.split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (match) env[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
      }
      return env;
    } catch {
      /* keep looking */
    }
  }
  return {};
}

/** Written by packages/driver/src/seed-demo.ts. */
function loadDemoIds(): Record<string, string> {
  for (const path of ['../../demo-ids.json', '../../../demo-ids.json']) {
    try {
      return JSON.parse(readFileSync(join(HERE, path), 'utf8')) as Record<string, string>;
    } catch {
      /* keep looking */
    }
  }
  return {};
}

const env = loadEnv();
const demo = loadDemoIds();
const cfg = (name: string): string | undefined => process.env[name] || env[name] || undefined;

const packageId = cfg('SHOU_PACKAGE_ID') ?? demo.packageId ?? '';
const policyId = cfg('SHOU_POLICY_ID') ?? demo.policyId ?? '';
const coinType = cfg('SHOU_COIN_TYPE') ?? demo.coinType ?? TESTNET_USDC;

// Same loader the driver scripts use: an explicit key if given, otherwise
// the local Sui CLI keystore, which is the normal developer setup.
function loadKeypair(): Ed25519Keypair {
  const fromEnv = cfg('SHOU_PRIVATE_KEY');
  if (fromEnv) return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(fromEnv).secretKey);
  const keystore = JSON.parse(
    readFileSync(join(homedir(), '.sui', 'sui_config', 'sui.keystore'), 'utf8'),
  ) as string[];
  return Ed25519Keypair.fromSecretKey(
    new Uint8Array(Buffer.from(keystore[0]!, 'base64').subarray(1)),
  );
}

let signer: Ed25519Keypair | null = null;
let signerError: string | null = null;
try {
  signer = loadKeypair();
} catch (error) {
  signerError = error instanceof Error ? error.message : String(error);
}

const client =
  signer && packageId
    ? new SuiShouClient({
        packageId,
        network: (cfg('SHOU_NETWORK') as 'testnet' | undefined) ?? 'testnet',
        signer,
      })
    : null;

/**
 * `null` until the first read, then cached: the approver list does not
 * change without a new policy, and the answer decides what the page is
 * allowed to offer rather than only how it looks.
 */
let policy: PolicyView | null = null;
async function getPolicy(): Promise<PolicyView> {
  if (!client) throw new Error(signerError ?? 'no signer or package id configured');
  if (!policy) policy = await client.getPolicy(policyId);
  return policy;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  try {
    if (url.pathname === '/api/config') {
      const guardian = signer?.toSuiAddress() ?? null;
      let approver: boolean | null = null;
      let threshold: number | null = null;
      let owner: string | null = null;
      let error: string | null = signerError;
      if (client && policyId) {
        try {
          const p = await getPolicy();
          threshold = p.threshold;
          owner = p.owner;
          // The .env.example says it outright: to test this dashboard you
          // must BE the guardian. Saying so here beats letting every
          // approval fail with an opaque ENotApprover from the chain.
          approver = Boolean(guardian && p.approvers.includes(guardian));
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      } else if (!policyId) {
        error =
          'No policy id. Run: node --experimental-strip-types packages/driver/src/seed-demo.ts';
      }
      return json(200, {
        guardian,
        approver,
        threshold,
        owner,
        policyId,
        packageId,
        coinType,
        network: cfg('SHOU_NETWORK') ?? 'testnet',
        error,
      });
    }

    if (url.pathname === '/api/requests') {
      if (!client || !policyId) return json(503, { error: signerError ?? 'not configured' });
      const [requests, p] = await Promise.all([
        client.listTransferRequests(policyId, Number(url.searchParams.get('limit') ?? 25)),
        getPolicy(),
      ]);
      return json(200, { requests, threshold: p.threshold, nowMs: Date.now() });
    }

    if (url.pathname === '/api/approve' || url.pathname === '/api/block') {
      // POST only, and JSON only. Both matter: a cross-origin form post
      // cannot set content-type to application/json without a preflight,
      // and this server answers no CORS preflight at all — so a page the
      // guardian happens to have open cannot drive an approval on his
      // behalf. This server holds his signing key; a GET that approved a
      // transfer would be one <img> tag away from being exploitable.
      if (req.method !== 'POST') return json(405, { error: 'POST required' });
      if (!(req.headers['content-type'] ?? '').includes('application/json')) {
        return json(415, { error: 'content-type must be application/json' });
      }
      if (!client || !policyId) return json(503, { error: signerError ?? 'not configured' });

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = (chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}) as {
        requestId?: string;
      };
      if (!body.requestId) return json(400, { error: 'requestId is required' });

      // The coin type is not optional in practice: omitting it builds the
      // Move call for SUI and aborts on-chain against a USDC request.
      const state =
        url.pathname === '/api/approve'
          ? await client.approveTransfer(body.requestId, policyId, coinType)
          : await client.blockTransfer(body.requestId, policyId, coinType);
      return json(200, { requestId: body.requestId, ...state });
    }

    const file = url.pathname === '/' ? '/index.html' : url.pathname;
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
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'internal error' });
  }
});

// 127.0.0.1, not 0.0.0.0 — see the note at the top of this file.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`SHOU guardian dashboard on http://127.0.0.1:${PORT}`);
  if (signerError) console.warn(`WARNING: no signer — ${signerError}`);
  else console.log(`signing as guardian: ${signer!.toSuiAddress()}`);
  if (!policyId) {
    console.warn(
      'WARNING: no policy id — run:\n' +
        '  node --experimental-strip-types packages/driver/src/seed-demo.ts',
    );
  } else {
    console.log(`policy: ${policyId}`);
  }
});

export type { PolicyView, TransferRequestView };
