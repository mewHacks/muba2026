// Types and defaults shared by the content script, the service worker
// and the two extension pages.
//
// NOTE ON WHAT IS ABSENT FROM `Verdict`: the message. The service worker
// keeps a verdict per conversation so the popup can show it, and that
// record holds a tier, a score and a hash — never the text. The popup
// showing her own conversation back to her is not a reason to store it:
// the page she is reading it on already has it.

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Settings {
  /** The circuit breaker. The extension never calls the enclave directly. */
  circuitBreakerUrl: string;
  /** Guardian dashboard, for the popup's link and the options auto-fill. */
  dashboardUrl: string;
  /**
   * The policy this elder's wallet runs under. Sent with every score so
   * the enclave files the verdict against it — see the comment on /risk
   * in packages/circuit-breaker/src/server.ts for why a missing policy id
   * quietly weakens the whole thing.
   */
  policyId: string;
  enabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  circuitBreakerUrl: 'http://127.0.0.1:4000',
  dashboardUrl: 'http://127.0.0.1:4200',
  policyId: '',
  enabled: true,
};

export interface Verdict {
  tier: RiskTier;
  category: string;
  reasoning: string;
  truthScore: number | null;
  gonkaRequestIds: string[];
  /** Counts by kind of what on-device redaction stripped. Never values. */
  redacted: Record<string, number>;
  messageHash: string;
  atMs: number;
}

export interface SessionRecord {
  sessionId: string;
  /** Host the conversation is on — "web.whatsapp.com". Not the contact. */
  site: string;
  /** Worst verdict seen in this conversation, and the most recent one. */
  worst: Verdict;
  latest: Verdict;
  scored: number;
}

/** content -> worker */
export interface ScoreRequest {
  type: 'shou:score';
  sessionId: string;
  site: string;
  /** Already redacted, on this device, before this message was posted. */
  redactedText: string;
  redacted: Record<string, number>;
}

/** popup -> worker */
export interface StateRequest {
  type: 'shou:state';
}

export type Message = ScoreRequest | StateRequest;

export interface ScoreResponse {
  ok: boolean;
  verdict?: Verdict;
  error?: string;
}

export interface StateResponse {
  settings: Settings;
  sessions: SessionRecord[];
  /** Last transport failure, so the popup can say "not scoring" out loud. */
  lastError: string | null;
}

export const TIER_EMOJI: Record<RiskTier, string> = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🔴' };

/**
 * What she is told. Consequences, not mechanics — the same rule the
 * circuit breaker's explain() follows, and the same reason: "tier 2
 * policy escalation" tells an 80-year-old nothing at all.
 */
export const TIER_PLAIN: Record<RiskTier, string> = {
  LOW: 'Nothing unusual in this chat.',
  MEDIUM: 'Something about this chat looks off. A transfer here will wait, and your trusted contact will be told.',
  HIGH: 'This looks like a scam. If you try to send money now, someone you trust has to approve it first.',
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

/** Gonka's submission criteria ask for the request id to be traceable on screen. */
export const receiptUrlFor = (id: string): string => `https://api.gonkarouter.io/v1/receipts/${id}`;
