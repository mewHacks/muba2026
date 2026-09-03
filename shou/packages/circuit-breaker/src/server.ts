// SHOU Layer 1 — the circuit breaker.
//
// This is the glue that makes a flagged conversation actually stop money
// moving, rather than just turning a badge red. It is deliberately dumb:
// it holds no message text, makes no risk judgements of its own, and
// cannot weaken a verdict. Scoring happens in the enclave; enforcement
// happens on-chain. This service only carries signed verdicts between
// the two and correlates them by session.
//
// Why it holds nothing sensitive: message plaintext goes straight
// through to the enclave and is never retained here, so compromising
// this process yields conversation *hashes* and risk tiers, not
// conversations.

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4000);
const ENCLAVE_URL = process.env.ENCLAVE_URL ?? 'http://localhost:3100';

interface EnclaveAttestation {
  timestampMs: number;
  messageHash: string;
  policyId: string;
  recipient: string;
  amount: string;
  riskTier: number;
  truthScore: number;
}

interface AttestTransferResponse {
  attestation: EnclaveAttestation;
  signature: string;
  tier: 'LOW' | 'MEDIUM' | 'HIGH';
  category: string;
  gonkaRequestIds: string[];
  hadSessionRisk: boolean;
}

async function enclaveFetch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${ENCLAVE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`enclave ${path} returned ${response.status}: ${detail}`);
  }
  return (await response.json()) as T;
}

/**
 * CORS, restricted to our own local pages.
 *
 * NOT `*`. This service is an unauthenticated front door to the enclave —
 * it forwards to /process_data and /attest_transfer. With a wildcard, any
 * site the elder happens to open could reach it from her browser: score
 * messages into her session and pull signed attestations for a recipient
 * and amount of the caller's choosing. The scam site itself could drive
 * the very thing meant to catch it.
 *
 * Extension origins are allowed through too, since the real client is a
 * browser extension rather than a page.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.SHOU_ALLOWED_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed =
    origin &&
    (ALLOWED_ORIGINS.has(origin) ||
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('moz-extension://'));
  if (!allowed) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    vary: 'Origin',
  };
}

const server = createServer(async (req, res) => {
  const CORS_HEADERS = corsHeaders(req.headers.origin);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(body));
  };

  const readBody = async (): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  };

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/health') {
      const enclave = await fetch(`${ENCLAVE_URL}/health_check`).then(
        (r) => r.ok,
        () => false,
      );
      return json(enclave ? 200 : 503, { status: enclave ? 'ok' : 'enclave unreachable' });
    }

    // Dev B's extension posts every new message here. We forward it to
    // the enclave without inspecting or storing it, and return the
    // advisory score for the inline badge.
    if (req.method === 'POST' && req.url === '/risk') {
      const body = await readBody();
      if (!body.sessionId || !body.message) {
        return json(400, { error: 'sessionId and message are required' });
      }
      const scored = await enclaveFetch<Record<string, unknown>>('/process_data', {
        sessionId: body.sessionId,
        message: body.message,
        // The recipient and amount really are placeholders here — the badge
        // does not gate money, and the binding values arrive at transfer
        // time. The POLICY id is not a placeholder: the enclave files each
        // verdict against a policy so that a swapped session id cannot
        // launder a HIGH away. Sending zeroes here would file every verdict
        // under the zero address and quietly defeat that, so pass the real
        // one whenever the caller knows it.
        policyId:
          body.policyId ??
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        recipient: '0x0000000000000000000000000000000000000000000000000000000000000000',
        amount: '0',
      });
      // `reasoning` is returned here because /risk drives the badge on the
      // ELDER'S OWN screen, showing her own conversation back to her.
      // It is deliberately absent from /transfer/prepare, which is what
      // the guardian sees — a guardian gets a risk tier, never a
      // description of what was said. See shou-idea.md §9.
      return json(200, {
        tier: scored.tier,
        category: scored.category,
        reasoning: scored.reasoning,
        truthScore: (scored.attestation as EnclaveAttestation | undefined)?.truthScore,
        gonkaRequestIds: scored.gonkaRequestIds,
      });
    }

    // The elder is about to send money. Ask the enclave to bind the
    // session's standing verdict to this exact transfer and sign it;
    // the caller submits that to `policy::request_transfer_attested`.
    if (req.method === 'POST' && req.url === '/transfer/prepare') {
      const body = await readBody();
      const { sessionId, policyId, recipient, amount } = body as Record<string, string>;
      if (!sessionId || !policyId || !recipient || amount === undefined) {
        return json(400, {
          error: 'sessionId, policyId, recipient and amount are required',
        });
      }

      const attested = await enclaveFetch<AttestTransferResponse>('/attest_transfer', {
        sessionId,
        policyId,
        recipient,
        amount,
      });

      return json(200, {
        ...attested,
        // Surfaced so the "Plain English" guardian screen can explain
        // *why* a transfer is about to be held, before the user signs.
        explanation: explain(attested),
      });
    }

    return json(404, { error: 'not found' });
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'internal error' });
  }
});

/**
 * The plain-English line the elder sees before signing. Deliberately
 * describes consequences, not mechanics — "your daughter needs to
 * approve" beats "tier 2 policy escalation".
 */
function explain(attested: AttestTransferResponse): string {
  if (!attested.hadSessionRisk) {
    return 'No recent conversation was checked for this transfer. Your own limits still apply.';
  }
  switch (attested.tier) {
    case 'HIGH':
      return `This chat looks like a scam (${attested.category}). Someone you trust has to approve before any money moves.`;
    case 'MEDIUM':
      return `Something about this chat looked off (${attested.category}). The transfer will wait, and your trusted contact has been told.`;
    default:
      return 'This conversation looked normal. Your own limits still apply to the amount.';
  }
}

server.listen(PORT, () => {
  console.log(`SHOU circuit breaker listening on :${PORT} (enclave: ${ENCLAVE_URL})`);
});
