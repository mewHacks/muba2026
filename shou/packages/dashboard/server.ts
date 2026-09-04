// SHOU — the guardian dashboard server.
//
// This is the son's screen: the place where a held transfer is approved
// or blocked, where the community deny list is read, and where a family
// sets up the rules in the first place. It is a thin shell around
// @shou/driver — every decision is an ordinary on-chain call, so this
// process has no authority of its own. Stop it and the escrowed funds
// are unaffected; she can still cancel and be refunded.
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
import type { PolicyView, RedFlagView, TransferRequestView } from '../driver/src/types.ts';

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
const denyListId = cfg('SHOU_DENY_LIST') ?? demo.denyListId ?? '';
const coinType = cfg('SHOU_COIN_TYPE') ?? demo.coinType ?? TESTNET_USDC;
const network = (cfg('SHOU_NETWORK') as 'testnet' | 'mainnet' | 'devnet' | 'localnet') ?? 'testnet';

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
  signer && packageId ? new SuiShouClient({ packageId, network, signer }) : null;

/**
 * `null` until the first read, then cached: the approver list does not
 * change without a new policy, and the answer decides what the page is
 * allowed to offer rather than only how it looks.
 *
 * Invalidated by a successful /api/policy, which is the one thing in this
 * process that can change which policy is being looked at.
 */
let policy: PolicyView | null = null;
let activePolicyId = policyId;
async function getPolicy(): Promise<PolicyView> {
  if (!client) throw new Error(signerError ?? 'no signer or package id configured');
  if (!activePolicyId) throw new Error('no policy id');
  if (!policy) policy = await client.getPolicy(activePolicyId);
  return policy;
}

/**
 * Whether the signer holds the OracleCap that `redflag::report` requires.
 *
 * Asked once and cached, because the answer decides whether the page
 * offers a reporting control at all. Offering one without the capability
 * would tell a guardian an address had been flagged when the transaction
 * aborted — and he would then stop watching an address he believes is
 * handled. Read-only is the honest state when the cap is absent.
 */
let oracleCapId: string | null | undefined;
async function getOracleCap(): Promise<string | null> {
  if (oracleCapId === undefined) {
    oracleCapId = client ? await client.findOracleCap() : null;
  }
  return oracleCapId;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Routes that change something on-chain, and are guarded as such. */
const MUTATIONS = new Set(['/api/approve', '/api/block', '/api/policy']);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, {
      'content-type': 'application/json',
      // Nothing here is cacheable: every read is chain state that may
      // have changed, and a cached /api/requests would show a guardian a
      // transfer he has already blocked.
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  try {
    if (MUTATIONS.has(url.pathname)) {
      // Four guards, and each closes a different door. This server holds
      // the guardian's signing key, so a GET that approved a transfer
      // would be one <img> tag away from being exploitable.
      //
      //  - POST only: a URL cannot be a mutation, so no <img>, no link,
      //    no prefetch, no address bar.
      //  - JSON only: a cross-origin <form> cannot set this content-type
      //    without a preflight, and this server answers no preflight at
      //    all, so the browser refuses before the request is sent.
      //  - Origin, when present, must be this server: closes the case of
      //    a page that does manage to send a simple request.
      //  - Explicit confirmation in the body: the UI asks the guardian
      //    before every one of these, and the flag is how the server
      //    refuses anything that skipped the asking.
      if (req.method !== 'POST') return json(405, { error: 'POST required' });
      if (!(req.headers['content-type'] ?? '').includes('application/json')) {
        return json(415, { error: 'content-type must be application/json' });
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
        return json(403, { error: `cross-origin request from ${origin} refused` });
      }
      if (!client || !activePolicyId) return json(503, { error: signerError ?? 'not configured' });

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = (chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}) as {
        requestId?: string;
        confirm?: boolean;
        approvers?: string[];
        threshold?: number;
        cooldownMs?: number;
        denyListId?: string;
        reviewCeiling?: string;
        highRiskCeiling?: string;
      };
      if (body.confirm !== true) {
        return json(400, { error: 'this call spends gas on testnet and needs confirm: true' });
      }

      if (url.pathname === '/api/policy') {
        // Re-checked here and not only in the browser: these are the
        // aborts in `new_policy`, and a Move abort reaches a page as an
        // opaque failure that costs gas to discover.
        const approvers = body.approvers ?? [];
        const threshold = Number(body.threshold);
        if (!approvers.length) return json(400, { error: 'at least one guardian is required' });
        if (!Number.isInteger(threshold) || threshold < 1) {
          return json(400, { error: 'threshold must be at least 1' });
        }
        if (threshold > approvers.length) {
          return json(400, { error: 'threshold cannot exceed the number of guardians' });
        }
        const review = BigInt(body.reviewCeiling ?? '0');
        const high = BigInt(body.highRiskCeiling ?? '0');
        if (review <= 0n || high <= 0n) return json(400, { error: 'ceilings must be above zero' });
        if (review > high) {
          return json(400, { error: 'review ceiling cannot exceed the high-risk ceiling' });
        }
        const list = body.denyListId || denyListId;
        if (!list) return json(400, { error: 'a deny list id is required' });

        // Number() on a u64 ceiling is safe here and nowhere else: these
        // are amounts a person typed into a form, not values read back
        // from a chain that may hold u64::MAX.
        const created = await client.createPolicy(
          approvers,
          threshold,
          Number(body.cooldownMs ?? 0),
          list,
          Number(review),
          Number(high),
        );
        // Point this process at what was just created, so the transfers
        // view is about the policy the family now has.
        activePolicyId = created.policyId;
        policy = null;
        return json(200, { ...created, denyListId: list });
      }

      if (!body.requestId) return json(400, { error: 'requestId is required' });
      // The coin type is not optional in practice: omitting it builds the
      // Move call for SUI and aborts on-chain against a USDC request.
      const state =
        url.pathname === '/api/approve'
          ? await client.approveTransfer(body.requestId, activePolicyId, coinType)
          : await client.blockTransfer(body.requestId, activePolicyId, coinType);
      return json(200, { requestId: body.requestId, ...state });
    }

    if (url.pathname === '/api/config') {
      const guardian = signer?.toSuiAddress() ?? null;
      let approver: boolean | null = null;
      let policyView: PolicyView | null = null;
      let error: string | null = signerError;
      // Her actual balance, read from the chain. `null` means the read
      // failed and the page shows a dash — the sidebar used to print a
      // hard-coded "$50.00", which is the single number on this screen a
      // guardian would act on, and the demo address holds no USDC at all.
      let ownerBalance: string | null = null;
      if (client && activePolicyId) {
        try {
          policyView = await getPolicy();
          try {
            ownerBalance = (await client.balanceOf(policyView.owner, coinType)).toString();
          } catch {
            /* a balance we cannot read is shown as unknown, never as a figure */
          }
          // The .env.example says it outright: to test this dashboard you
          // must BE the guardian. Saying so here beats letting every
          // approval fail with an opaque ENotApprover from the chain.
          approver = Boolean(guardian && policyView.approvers.includes(guardian));
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      } else if (!activePolicyId) {
        error =
          'No policy id. Run: node --experimental-strip-types packages/driver/src/seed-demo.ts, ' +
          'or set the rules up on this page.';
      }
      return json(200, {
        guardian,
        approver,
        owner: policyView?.owner ?? null,
        threshold: policyView?.threshold ?? null,
        approvers: policyView?.approvers ?? [],
        cooldownMs: policyView?.cooldownMs ?? null,
        reviewCeiling: policyView?.reviewCeiling ?? null,
        highRiskCeiling: policyView?.highRiskCeiling ?? null,
        pausedUntilMs: policyView?.pausedUntilMs ?? null,
        ownerBalance,
        policyId: activePolicyId,
        packageId,
        denyListId,
        coinType,
        network,
        // Read-only unless the signer genuinely holds the capability the
        // contract requires. See getOracleCap above.
        canReport: Boolean(await getOracleCap()),
        error,
      });
    }

    if (url.pathname === '/api/requests') {
      if (!client || !activePolicyId) return json(503, { error: signerError ?? 'not configured' });
      const [requests, p] = await Promise.all([
        client.listTransferRequests(activePolicyId, Number(url.searchParams.get('limit') ?? 25)),
        getPolicy(),
      ]);
      return json(200, {
        requests,
        threshold: p.threshold,
        reviewCeiling: p.reviewCeiling,
        highRiskCeiling: p.highRiskCeiling,
        nowMs: Date.now(),
      });
    }

    if (url.pathname === '/api/redflags') {
      if (!client) return json(503, { error: signerError ?? 'not configured' });
      if (!denyListId) {
        return json(503, {
          error:
            'No deny list id. Set SHOU_DENY_LIST, or run seed-demo.ts with SHOU_ADMIN_CAP to create one.',
        });
      }
      const flags = await client.listRedFlags(
        denyListId,
        Number(url.searchParams.get('limit') ?? 50),
      );
      return json(200, { flags, denyListId, coinType, nowMs: Date.now() });
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
        '  node --experimental-strip-types packages/driver/src/seed-demo.ts\n' +
        '  (or set the rules up on the Setup tab)',
    );
  } else {
    console.log(`policy: ${policyId}`);
  }
  if (!denyListId) console.warn('WARNING: no deny list id — the reported-addresses tab is empty');
});

export type { PolicyView, RedFlagView, TransferRequestView };
