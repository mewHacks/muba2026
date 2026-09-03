// The service worker. The only part of the extension that talks to the
// network, and it talks to exactly one host: the circuit breaker.
//
// WHY THE FETCH LIVES HERE AND NOT IN THE CONTENT SCRIPT. A fetch from
// a content script carries the PAGE's origin (https://web.whatsapp.com),
// which the circuit breaker correctly refuses — its CORS allow-list is
// deliberately not `*`, because it is an unauthenticated front door to
// the enclave. A fetch from the worker carries chrome-extension://<id>,
// which the allow-list does admit. So the trust boundary the circuit
// breaker draws is the reason for this split, not a convenience.
//
// It also means a compromised page cannot reach the enclave: it can ask
// this worker to score a message, and that is the entire surface.

import {
  DEFAULT_SETTINGS,
  loadSettings,
  type Message,
  type ScoreResponse,
  type SessionRecord,
  type StateResponse,
  type Verdict,
} from './shared.ts';

const TIER_CODE = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

/**
 * Verdicts per conversation, in worker memory only.
 *
 * Deliberately not chrome.storage: a record of which conversations
 * scored HIGH, surviving restarts on her disk, is a list of who has been
 * trying to scam her — useful to exactly one other party. The enclave
 * already keeps the authoritative session state, with a TTL.
 */
const sessions = new Map<string, SessionRecord>();
let lastError: string | null = null;

/** Worst verdict wins, matching the enclave's own rule and the chain's. */
function keepWorse(previous: Verdict, next: Verdict): Verdict {
  return TIER_CODE[next.tier] >= TIER_CODE[previous.tier] ? next : previous;
}

async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The toolbar badge reflects the WORST live verdict, not the newest.
 *
 * A scammer who turns friendly right before asking for money would
 * otherwise walk the badge back to green in the seconds that matter
 * most. Same reasoning as recordSessionRisk() in the enclave.
 */
function paintBadge(): void {
  let worst: 'LOW' | 'MEDIUM' | 'HIGH' | null = null;
  for (const record of sessions.values()) {
    if (!worst || TIER_CODE[record.worst.tier] > TIER_CODE[worst]) worst = record.worst.tier;
  }
  const style = {
    HIGH: { text: '!', colour: '#b3261e' },
    MEDIUM: { text: '?', colour: '#8a5800' },
    LOW: { text: '✓', colour: '#0f7b4f' },
  } as const;
  if (!worst) {
    void chrome.action.setBadgeText({ text: '' });
    return;
  }
  void chrome.action.setBadgeText({ text: style[worst].text });
  void chrome.action.setBadgeBackgroundColor({ color: style[worst].colour });
}

async function score(request: {
  sessionId: string;
  site: string;
  redactedText: string;
  redacted: Record<string, number>;
}): Promise<ScoreResponse> {
  const settings = await loadSettings();
  if (!settings.enabled) return { ok: false, error: 'SHOU is switched off in its options' };

  // A missing policy id is not a detail to paper over. The enclave files
  // each verdict against a policy so that a swapped session id cannot
  // launder a HIGH away; sending the zero address files every verdict
  // under nothing and quietly defeats that. Refuse and say why.
  if (!settings.policyId) {
    return {
      ok: false,
      error: 'No policy id set. Open SHOU options and fetch it from the dashboard.',
    };
  }

  const body = {
    sessionId: request.sessionId,
    message: request.redactedText,
    policyId: settings.policyId,
  };

  let payload: {
    tier?: 'LOW' | 'MEDIUM' | 'HIGH';
    category?: string;
    reasoning?: string;
    truthScore?: number;
    gonkaRequestIds?: string[];
    error?: string;
  };
  try {
    const response = await fetch(`${settings.circuitBreakerUrl.replace(/\/$/, '')}/risk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    payload = (await response.json()) as typeof payload;
    if (!response.ok) throw new Error(payload.error ?? `circuit breaker returned ${response.status}`);
  } catch (error) {
    // Fails CLOSED in the honest sense: no verdict at all, and the badge
    // says "not checked". It does NOT invent a LOW. The chain still
    // applies her own amount ceilings with no verdict present, which is
    // the documented degraded behaviour rather than a silent gap.
    lastError = error instanceof Error ? error.message : String(error);
    return { ok: false, error: lastError };
  }
  lastError = null;

  if (!payload.tier) return { ok: false, error: 'circuit breaker returned no tier' };

  const verdict: Verdict = {
    tier: payload.tier,
    category: payload.category ?? 'unknown',
    reasoning: payload.reasoning ?? '',
    truthScore: typeof payload.truthScore === 'number' ? payload.truthScore : null,
    gonkaRequestIds: payload.gonkaRequestIds ?? [],
    redacted: request.redacted,
    messageHash: await hashOf(request.redactedText),
    atMs: Date.now(),
  };

  const existing = sessions.get(request.sessionId);
  sessions.set(request.sessionId, {
    sessionId: request.sessionId,
    site: request.site,
    worst: existing ? keepWorse(existing.worst, verdict) : verdict,
    latest: verdict,
    scored: (existing?.scored ?? 0) + 1,
  });
  paintBadge();

  return { ok: true, verdict };
}

chrome.runtime.onMessage.addListener((message: Message, _sender, respond) => {
  if (message.type === 'shou:score') {
    void score(message).then(respond);
    return true; // keeps the port open for the async reply
  }
  if (message.type === 'shou:state') {
    void loadSettings().then((settings) => {
      const state: StateResponse = {
        settings,
        // Newest conversation first — the popup shows the one she is in.
        sessions: [...sessions.values()].sort((a, b) => b.latest.atMs - a.latest.atMs),
        lastError,
      };
      respond(state);
    });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  // Write the defaults once so the options page opens populated rather
  // than empty, which reads as broken.
  void chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
    void chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...stored });
  });
});
