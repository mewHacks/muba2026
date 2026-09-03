/**
 * SHOU — AI layer types.
 *
 * SUPERSET of shou/packages/driver/src/types.ts. The five original fields
 * (tier, truthScore, requestId, category, messageHash) are preserved exactly so
 * Dev A's ShouClient.requestTransfer() keeps compiling. Everything else is additive
 * and lives off-chain.
 */

export type RiskTier = "LOW" | "MEDIUM" | "HIGH";
export type Language = "en" | "ms" | "zh" | "ta";

/** Transaction metadata. Scored by deterministic code, never by a model. */
export interface TxContext {
  amountMYR: number;
  recipientLabel: string;
  recipientIsNew: boolean;
  usualMaxMYR: number;
  transfersLastHour: number;
  localHour: number;
}

export interface Reason {
  /** Stable machine code, safe to log and to key UI copy off. */
  code: string;
  /** 0-100 contribution to the final score. */
  severity: number;
  /** Plain sentence safe to show the user. Never contains message content. */
  safeText: string;
  source: "deterministic" | "message_model" | "verifier_model";
}

export interface TraceStep {
  role: "classifier" | "verifier" | "explainer" | "adjudicator";
  roleLabel: string;
  requestedModel: string;
  /** What the router actually served. If it differs, we did not get the model we asked for. */
  servedModel: string;
  substituted: boolean;
  score?: number;
  finding: string;
  gonkaRequestId: string;
  /** Public, unauthenticated. Proves the call HAPPENED on Gonka. Not that it was right. */
  receiptUrl: string;
  latencyMs: number;
  error?: string;
}

/** Mirrors what shou::policy enforces, so the demo is coherent before the chain is wired. */
export interface ContractAction {
  action: "EXECUTE" | "COOLDOWN" | "GUARDIAN_APPROVAL";
  cooldownHours: number;
  guardianNotified: boolean;
  ruleFired: string;
}

/**
 * Bound to one specific transfer. The point of every field here is that a stale or
 * borrowed LOW assessment cannot be replayed against a different recipient or amount.
 */
export interface Attestation {
  assessmentId: string;
  policyId: string;
  sender: string;
  recipient: string;
  amountMYR: number;
  tier: RiskTier;
  issuedAt: string;
  expiresAt: string;
  policyVersion: string;
  promptVersion: string;
  /** HMAC, not a bare hash — a bare SHA-256 of a short scam message is brute-forceable. */
  messageCommitment: string;
}

export interface RiskAssessment {
  // ---- fields Dev A's driver already expects (do not rename) ----
  tier: RiskTier;
  truthScore: number;
  requestId: string;
  category: string;
  messageHash: string;
  // --------------------------------------------------------------

  riskScore: number;
  confidence: number;
  reasons: Reason[];
  explanation: string;
  explanationLocalised: string;
  language: Language;

  crossVerification: {
    classifierScore: number | null;
    verifierScore: number | null;
    /** Both models saw the SAME message. This is real cross-verification. */
    delta: number | null;
    conflicted: boolean;
    adjudicated: boolean;
  };

  deterministic: {
    transactionScore: number;
    indicatorFloor: number;
    hardFloorFired: string | null;
  };

  traces: TraceStep[];
  attestation: Attestation;
  contractAction: ContractAction;
  redactedInput: string;
  redactedCount: number;
  latencyMs: number;
  degraded?: string;
}
