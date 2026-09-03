// The SHOU enclave server — the code that runs *inside* the AWS Nitro
// Enclave, following the Nautilus three-endpoint design.
//
// The privacy claim in shou-idea.md §9 rests entirely on this file:
//   - message text is scored here and discarded
//   - it is never written to a log, a file, or a database
//   - only a sha256 hash, a tier and a score ever leave
// Anything you add here that persists or prints message text breaks that
// claim, so keep the plaintext confined to scoreMessage().
//
// OWNERSHIP: Dev A owns this file — the enclave runtime, key handling,
// signing, attestation and session binding. Dev A does NOT own what the
// scoring says: that is Dev B's @shou/gonka-client, imported below.
//
// Gonka Router is called from inside this enclave rather than from the
// extension. If the extension called it directly, the message would
// leave the device without ever passing through an enclave, and §9's
// privacy claim would be a promise rather than a measurable property.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { redact } from '../../packages/redact/src/redact.ts';
import {
  RiskTierCode,
  devHeuristicScorer,
  gonkaScorer,
  type RiskTierName,
  type ScoreResult,
  type Scorer,
} from '../../packages/gonka-client/src/scorer.ts';
import {
  generateEnclaveKeypair,
  serializeAttestation,
  toHex,
} from './attestation.ts';

// 3100, not 3000: the zkLogin demo server owns :3000 because the Google
// OAuth origin and redirect URL are registered against it in the Enoki
// portal. Both defaulting to 3000 meant whichever started second died
// with EADDRINUSE — on demo day, most likely this one.
const PORT = Number(process.env.PORT ?? 3100);
const GONKA_URL = process.env.GONKA_ROUTER_URL ?? 'https://gonkarouter.io/api/v1/chat/completions';
const GONKA_API_KEY = process.env.GONKA_API_KEY;
const GONKA_MODELS = (process.env.GONKA_MODELS ?? 'minimax,kimi').split(',');

// Generated in enclave memory at startup; never leaves, never persisted.
// A restart produces a new key and requires re-registering on-chain.
const keypair = generateEnclaveKeypair();

// Dev B's scorer, or the dev stand-in when no credentials are present or testing.
const scoreMessage: Scorer =
  GONKA_API_KEY && process.env.SHOU_TEST_SCORER !== '1'
    ? gonkaScorer({ url: GONKA_URL, apiKey: GONKA_API_KEY, models: GONKA_MODELS })
    : devHeuristicScorer;

/**
 * Per-session risk state, held in ENCLAVE memory only.
 *
 * This exists because of an ordering problem: a signed attestation is
 * bound to (policyId, recipient, amount), but messages are scored
 * minutes before any transfer exists. The alternative — caching message
 * text outside the enclave and re-scoring at transfer time — would put
 * plaintext somewhere the host can read, which is exactly what this
 * whole design is built to avoid.
 *
 * So we keep the *verdict*, never the message. Entries expire, and the
 * plaintext is already gone by the time anything lands here.
 */
interface SessionRisk {
  policyId: string;
  tier: RiskTierName;
  truthScore: number;
  category: string;
  gonkaRequestIds: string[];
  lastMessageHash: Uint8Array;
  updatedAtMs: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
/**
 * Hard cap on live sessions. Without it, an unauthenticated caller can
 * grow this map with unique session ids until the process dies — and a
 * Nitro enclave has far less memory than a laptop, so it dies sooner.
 */
const MAX_SESSIONS = 10_000;
const sessions = new Map<string, SessionRisk>();

function recordSessionRisk(
  sessionId: string,
  policyId: string,
  score: ScoreResult,
  messageHash: Uint8Array,
): void {
  const existing = sessions.get(sessionId);
  // Keep the worst verdict seen in the window: a scammer who softens
  // their language right before asking for money must not be able to
  // wash out the earlier red flags.
  const keepExisting =
    existing && RiskTierCode[existing.tier] >= RiskTierCode[score.tier];
  sessions.set(sessionId, {
    policyId,
    tier: keepExisting ? existing!.tier : score.tier,
    truthScore: Math.max(existing?.truthScore ?? 0, score.truthScore),
    category: keepExisting ? existing!.category : score.category,
    gonkaRequestIds: [...(existing?.gonkaRequestIds ?? []), ...score.gonkaRequestIds].slice(-8),
    lastMessageHash: messageHash,
    updatedAtMs: Date.now(),
  });

  if (sessions.size > MAX_SESSIONS) {
    // Map iterates in insertion order, so the front is the oldest.
    // Drop expired entries first; if none are expired we are under
    // active flooding, so evict the oldest regardless.
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (sessions.size <= MAX_SESSIONS) break;
      if (id !== sessionId && now - entry.updatedAtMs > SESSION_TTL_MS) sessions.delete(id);
    }
    for (const id of sessions.keys()) {
      if (sessions.size <= MAX_SESSIONS) break;
      if (id !== sessionId) sessions.delete(id);
    }
  }
}

function currentSessionRisk(sessionId: string): SessionRisk | undefined {
  const entry = sessions.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAtMs > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return undefined;
  }
  return entry;
}

/**
 * The worst live verdict for this policy, across every session.
 *
 * WHY NOT JUST THE NAMED SESSION. `sessionId` arrives from the caller
 * and this server has no authentication, so anything keyed solely on it
 * can be laundered: score a scam conversation to HIGH, then ask for an
 * attestation under a *fresh* session id and the lookup finds nothing,
 * defaulting to LOW. A compromised extension is enough to do this.
 *
 * The policy id cannot be swapped the same way — it is the thing the
 * attestation is *for*, and the chain checks it against the policy the
 * transfer actually targets. So we take the worst of the named session
 * and every other live session for the same policy. Swapping the session
 * id now buys nothing: the HIGH is still found.
 */
function worstRiskForPolicy(policyId: string, sessionId: string): SessionRisk | undefined {
  let worst = currentSessionRisk(sessionId);
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (entry.policyId !== policyId) continue;
    if (now - entry.updatedAtMs > SESSION_TTL_MS) {
      sessions.delete(id);
      continue;
    }
    if (!worst || RiskTierCode[entry.tier] > RiskTierCode[worst.tier]) worst = entry;
  }
  return worst;
}

const server = createServer(async (req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.method === 'GET' && req.url === '/health_check') {
      return json(200, { status: 'ok', gonkaConfigured: Boolean(GONKA_API_KEY) });
    }

    if (req.method === 'GET' && req.url === '/get_attestation') {
      // In a real Nitro deployment this also returns the AWS-signed
      // attestation document (from /dev/nsm), which is what proves this
      // public key came out of an enclave running measured code. Without
      // a Nitro device there is no document to return, so the on-chain
      // registration is AdminCap-gated instead — see the PRODUCTION GAP
      // note in shou/move/sources/enclave.move.
      return json(200, {
        publicKey: toHex(keypair.publicKeyRaw),
        attestationDocument: null,
        note: 'attestationDocument is null outside a Nitro enclave',
      });
    }

    if (req.method === 'POST' && req.url === '/process_data') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        message?: string;
        sessionId?: string;
        policyId?: string;
        recipient?: string;
        amount?: string | number;
      };

      if (!body.message || !body.policyId || !body.recipient || body.amount === undefined) {
        return json(400, { error: 'message, policyId, recipient and amount are all required' });
      }

      // Redact BEFORE anything else touches the message. The extension
      // is expected to have redacted already; doing it again here means
      // a stale, bypassed or third-party client cannot cause raw PII to
      // be scored. Redaction is idempotent, so double-running is free.
      //
      // Everything downstream — the model call, the hash, the session
      // record — sees only the redacted form. There is no code path in
      // this service that handles the raw message after this line.
      const { text: safeMessage, removed } = redact(body.message);

      const messageHash = new Uint8Array(createHash('sha256').update(safeMessage).digest());
      const score = await scoreMessage(safeMessage);
      // A missing sessionId used to mean the verdict was simply dropped —
      // so a scored HIGH could vanish before the transfer was attested.
      // Fall back to the policy id, which is always present, so a verdict
      // is never lost and worstRiskForPolicy can always find it.
      recordSessionRisk(body.sessionId || body.policyId, body.policyId, score, messageHash);

      const timestampMs = Date.now();
      const fields = {
        timestampMs,
        messageHash,
        policyId: body.policyId,
        recipient: body.recipient,
        amount: BigInt(body.amount),
        riskTier: RiskTierCode[score.tier],
        truthScore: Math.max(0, Math.min(100, Math.round(score.truthScore))),
      };
      const signature = keypair.sign(serializeAttestation(fields));

      // Note what is absent: the message. Only its hash leaves here.
      return json(200, {
        attestation: {
          timestampMs,
          messageHash: toHex(messageHash),
          policyId: body.policyId,
          recipient: body.recipient,
          amount: String(fields.amount),
          riskTier: fields.riskTier,
          truthScore: fields.truthScore,
        },
        signature: toHex(signature),
        // Surfaced for the UI: Gonka's submission criteria require the
        // Truth Score, a reasoning trace and the Request IDs on screen.
        tier: score.tier,
        category: score.category,
        reasoning: score.reasoning,
        gonkaRequestIds: score.gonkaRequestIds,
        // Counts only — which KINDS of identifier were stripped, never
        // their values. Lets the UI show "we removed a phone number and
        // an account number before scoring" as a visible privacy signal.
        redacted: removed,
      });
    }

    if (req.method === 'POST' && req.url === '/attest_transfer') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        sessionId?: string;
        policyId?: string;
        recipient?: string;
        amount?: string | number;
      };

      if (!body.sessionId || !body.policyId || !body.recipient || body.amount === undefined) {
        return json(400, {
          error: 'sessionId, policyId, recipient and amount are all required',
        });
      }

      // No conversation scored for this policy means we have nothing to
      // vouch for. Report LOW rather than refusing: the chain still
      // applies the elder's amount ceilings independently, so an absent
      // AI verdict degrades to "amount rules only" instead of blocking a
      // legitimate payment. This is the phone-scam case.
      //
      // Keyed by POLICY, not by the caller-supplied session id — see
      // worstRiskForPolicy. A fresh session id can no longer launder away
      // a HIGH scored earlier in the same conversation.
      const risk = worstRiskForPolicy(body.policyId, body.sessionId);
      const tier = risk?.tier ?? 'LOW';
      const truthScore = risk?.truthScore ?? 0;
      const messageHash = risk?.lastMessageHash ?? new Uint8Array(32);

      const timestampMs = Date.now();
      const fields = {
        timestampMs,
        messageHash,
        policyId: body.policyId,
        recipient: body.recipient,
        amount: BigInt(body.amount),
        riskTier: RiskTierCode[tier],
        truthScore: Math.max(0, Math.min(100, Math.round(truthScore))),
      };
      const signature = keypair.sign(serializeAttestation(fields));

      return json(200, {
        attestation: {
          timestampMs,
          messageHash: toHex(messageHash),
          policyId: body.policyId,
          recipient: body.recipient,
          amount: String(fields.amount),
          riskTier: fields.riskTier,
          truthScore: fields.truthScore,
        },
        signature: toHex(signature),
        tier,
        category: risk?.category ?? 'no-conversation-scored',
        gonkaRequestIds: risk?.gonkaRequestIds ?? [],
        hadSessionRisk: Boolean(risk),
      });
    }

    return json(404, { error: 'not found' });
  } catch (error) {
    // Deliberately does not echo the request body — an error path that
    // leaks the message would defeat the whole point of this service.
    return json(500, { error: error instanceof Error ? error.message : 'internal error' });
  }
});

export function startServer(port = PORT): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`SHOU enclave listening on :${actualPort}`);
      console.log(`enclave public key: ${toHex(keypair.publicKeyRaw)}`);
      console.log(
        '\n  This key is NEW — it was generated in memory just now, as a real\n' +
          '  TEE would on every restart. Any Enclave object registered on-chain\n' +
          '  against a PREVIOUS key is now dead, and attestations verified\n' +
          '  against it will abort with EInvalidSignature.\n' +
          '  If you have restarted mid-demo, re-register before continuing:\n' +
          '    node --experimental-strip-types ../packages/driver/src/reregister-enclave.ts\n',
      );
      if (!GONKA_API_KEY) console.warn('WARNING: GONKA_API_KEY unset — scoring uses the dev heuristic');
      resolve({
        port: actualPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// Two separate concerns, deliberately two separate switches.
//   SHOU_TEST_SCORER=1  -> score with the dev heuristic, not Gonka.
//   SHOU_NO_AUTOSTART=1 -> do not listen on import; the caller runs
//                          startServer() itself (that is what the tests do).
// These used to be the same flag, which meant you could not run the server
// standalone on the heuristic scorer — the exact thing you want when the
// Gonka Router is down and you still need to demo.
if (process.env.SHOU_NO_AUTOSTART !== '1') {
  startServer();
}
