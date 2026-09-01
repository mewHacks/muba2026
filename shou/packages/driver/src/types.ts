// The shared interface between Dev A (chain) and Dev B (AI & surface).
// See shou-architecture.md §4. Dev B only ever imports from this file —
// never Move, never @mysten/sui directly.

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

/** Output of Gonka Router scoring — Dev B produces this, Dev A only ever consumes it. */
export interface RiskAssessment {
  tier: RiskTier;
  truthScore: number; // 0–100, Gonka's Truth Score
  requestId: string; // Gonka Request ID — must be displayed in UI per submission reqs
  category: string; // e.g. "urgency + unknown recipient"
  messageHash: string; // sha256 of the source message — never the message itself
}

/** Dev B's extension calls this after every scored message. Dev A implements it. */
export interface CircuitBreakerAPI {
  submitRisk(sessionId: string, risk: RiskAssessment): Promise<void>;
}

export type TransferStatus =
  | 'PENDING'
  | 'AUTO_UNLOCK_SCHEDULED'
  | 'NEEDS_APPROVAL'
  | 'BLOCKED_DENYLIST'
  | 'BLOCKED_BY_GUARDIAN'
  | 'EXECUTED';

/**
 * The chain-facing client. Dev A implements this against the deployed
 * `shou::policy` / `shou::redflag` Move modules; Dev A's Circuit
 * Breaker and Dev B's dashboard both call it — it's the only way either
 * side touches Sui.
 */
export interface ShouClient {
  createPolicy(
    approvers: string[],
    threshold: number,
    cooldownMs: number,
  ): Promise<{ policyId: string }>;

  createGuard(policyId: string): Promise<{ guardId: string }>;

  /** Locks funds into a request. `risk` is already scored — this never re-evaluates it. */
  requestTransfer(
    policyId: string,
    guardId: string,
    denyListId: string,
    amount: number,
    recipient: string,
    risk: RiskAssessment,
  ): Promise<{ requestId: string; tier: RiskTier; unlockAtMs: number; status: TransferStatus }>;

  /** Only meaningful for HIGH-tier requests; a no-op on release for LOW/MEDIUM. */
  approveTransfer(requestId: string, policyId: string, approver: string): Promise<{ status: TransferStatus }>;

  /** Guardian-only. Cancels a pending transfer and refunds the owner. */
  blockTransfer(requestId: string, policyId: string, approver: string): Promise<{ status: TransferStatus }>;

  /** Callable by anyone once unlocked — release doesn't require the owner's own tx. */
  executeTransfer(requestId: string, policyId: string): Promise<{ status: TransferStatus }>;

  getTransferStatus(requestId: string): Promise<{ status: TransferStatus; approvals: string[] }>;

  /** Layer 3 — lands a Gonka-scored plausibility directly as an on-chain soft ban. */
  reportRedFlag(
    denyListId: string,
    address: string,
    plausibilityScore: number,
  ): Promise<{ banned: true }>;

  isRecipientBanned(denyListId: string, address: string): Promise<boolean>;
}
