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

const PORT = Number(process.env.PORT ?? 3000);
const GONKA_URL = process.env.GONKA_ROUTER_URL ?? 'https://gonkarouter.io/api/v1/chat/completions';
const GONKA_API_KEY = process.env.GONKA_API_KEY;
const GONKA_MODELS = (process.env.GONKA_MODELS ?? 'minimax,kimi').split(',');

// Generated in enclave memory at startup; never leaves, never persisted.
// A restart produces a new key and requires re-registering on-chain.
const keypair = generateEnclaveKeypair();

// Dev B's scorer, or the dev stand-in when no credentials are present.
const scoreMessage: Scorer = GONKA_API_KEY
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
  tier: RiskTierName;
  truthScore: number;
  category: string;
  gonkaRequestIds: string[];
  lastMessageHash: Uint8Array;
  updatedAtMs: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, SessionRisk>();

function recordSessionRisk(sessionId: string, score: ScoreResult, messageHash: Uint8Array): void {
  const existing = sessions.get(sessionId);
  // Keep the worst verdict seen in the window: a scammer who softens
  // their language right before asking for money must not be able to
  // wash out the earlier red flags.
  const keepExisting =
    existing && RiskTierCode[existing.tier] >= RiskTierCode[score.tier];
  sessions.set(sessionId, {
    tier: keepExisting ? existing!.tier : score.tier,
    truthScore: Math.max(existing?.truthScore ?? 0, score.truthScore),
    category: keepExisting ? existing!.category : score.category,
    gonkaRequestIds: [...(existing?.gonkaRequestIds ?? []), ...score.gonkaRequestIds].slice(-8),
    lastMessageHash: messageHash,
    updatedAtMs: Date.now(),
  });
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

      // The only place plaintext exists. Hash first so the rest of the
      // function never needs to touch it again.
      const messageHash = new Uint8Array(createHash('sha256').update(body.message).digest());
      const score = await scoreMessage(body.message);
      if (body.sessionId) recordSessionRisk(body.sessionId, score, messageHash);

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

      // No conversation scored for this session means we have nothing to
      // vouch for. Report LOW rather than refusing: the chain still
      // applies the elder's amount ceilings independently, so an absent
      // AI verdict degrades to "amount rules only" instead of blocking a
      // legitimate payment. This is the phone-scam case.
      const risk = currentSessionRisk(body.sessionId);
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

server.listen(PORT, () => {
  console.log(`SHOU enclave listening on :${PORT}`);
  console.log(`enclave public key: ${toHex(keypair.publicKeyRaw)}`);
  if (!GONKA_API_KEY) console.warn('WARNING: GONKA_API_KEY unset — scoring uses the dev heuristic');
});
