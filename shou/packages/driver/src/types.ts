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

/**
 * Note there is no BLOCKED_DENYLIST state: a banned recipient aborts
 * inside submit_transfer, so no TransferRequest object is ever created to
 * carry that status. The caller sees a thrown error instead.
 */
export type TransferStatus =
  | 'PENDING' // LOW tier, unlocked, just not executed yet
  | 'AUTO_UNLOCK_SCHEDULED' // MEDIUM tier, cooldown still running
  | 'NEEDS_APPROVAL' // HIGH tier, below approval threshold
  | 'APPROVED' // HIGH tier, threshold met, awaiting execution
  | 'BLOCKED' // guardian blocked it, or the owner cancelled it
  | 'EXECUTED';

/** Exactly what the enclave signed. Produced by POST /attest_transfer. */
export interface EnclaveAttestation {
  timestampMs: number;
  messageHash: string;
  policyId: string;
  recipient: string;
  amount: string;
  riskTier: number;
  truthScore: number;
}

export interface TransferState {
  status: TransferStatus;
  approvals: string[];
  /** The tier the CHAIN assigned, which may be stricter than the one submitted. */
  tier: RiskTier;
  unlockAtMs: number;
}

/**
 * The chain-facing client. Dev A implements this against the deployed
 * shou::policy / shou::redflag Move modules; Dev A's Circuit Breaker and
 * Dev B's dashboard both call it — it's the only way either side touches
 * Sui.
 */
export interface ShouClient {
  /**
   * `denyListId` is bound into the policy permanently — a transfer can
   * only ever be checked against this exact list, so an attacker cannot
   * swap in an empty one to shed a ban.
   *
   * The two ceilings are the elder's own amount limits, enforced on-chain
   * independently of any AI score: at or above `reviewCeiling` a transfer
   * gets a cooldown, at or above `highRiskCeiling` it needs guardian
   * approval — even if the scorer says the conversation looked fine.
   */
  createPolicy(
    approvers: string[],
    threshold: number,
    cooldownMs: number,
    denyListId: string,
    reviewCeiling: number,
    highRiskCeiling: number,
  ): Promise<{ policyId: string }>;

  /**
   * Locks funds into a request. The returned `tier` is what the CHAIN
   * decided, which may be stricter than `risk.tier` — never assume the
   * submitted tier is the effective one.
   */
  requestTransfer(
    policyId: string,
    denyListId: string,
    amount: number,
    recipient: string,
    risk: RiskAssessment,
    coinType?: string,
  ): Promise<{ requestId: string } & TransferState>;

  /** Registers the PCR measurements of the enclave build. Admin-gated. */
  registerEnclaveConfig(
    adminCapId: string,
    name: string,
    pcr0: string,
    pcr1: string,
    pcr2: string,
  ): Promise<{ configId: string }>;

  /** Binds a running enclave's public key to a config. Admin-gated. */
  registerEnclave(
    configId: string,
    adminCapId: string,
    publicKeyHex: string,
  ): Promise<{ enclaveId: string }>;

  /**
   * The attested path: the tier comes from a score the enclave signed,
   * bound to this exact policy/recipient/amount. Prefer this over
   * requestTransfer — an unattested LOW is ignored by the chain, an
   * attested one is trusted, which is what keeps ordinary payments
   * frictionless.
   */
  requestTransferAttested(
    policyId: string,
    denyListId: string,
    enclaveId: string,
    attestation: EnclaveAttestation,
    signatureHex: string,
    coinType?: string,
  ): Promise<{ requestId: string } & TransferState>;

  // NOTE ON `coinType`: it defaults to SUI. If the transfer is in USDC
  // (which it is, for the real product) you MUST pass the coin type — a
  // missing one silently builds the Move call with the wrong type
  // argument and aborts on-chain. It is declared here rather than left
  // as an implementation detail precisely so it cannot be missed.

  /** Approver-only. Only affects release for HIGH-tier requests. */
  approveTransfer(requestId: string, policyId: string, coinType?: string): Promise<TransferState>;

  /** Approver-only. Stops a pending transfer and refunds the owner. */
  blockTransfer(requestId: string, policyId: string, coinType?: string): Promise<TransferState>;

  /**
   * Owner-only escape hatch. Without it, a HIGH-tier request whose
   * approvers never respond would lock the owner's funds permanently.
   * Refunds to the owner, so it grants an attacker nothing.
   */
  cancelTransfer(requestId: string, policyId: string, coinType?: string): Promise<TransferState>;

  /** Callable by anyone once the tier's release condition is met. */
  executeTransfer(requestId: string, policyId: string, coinType?: string): Promise<TransferState>;

  getTransferStatus(requestId: string): Promise<TransferState>;

  /** Owner or approver; only ever extends an existing pause. */
  pause(policyId: string, untilMs: number): Promise<void>;

  /** Owner only. */
  unpause(policyId: string): Promise<void>;

  /**
   * Layer 3 — lands a Gonka-scored plausibility as an on-chain soft ban.
   * Requires the OracleCap held by the scoring service, so an arbitrary
   * user cannot ban a legitimate merchant. `banCeiling` is the "soft" in
   * soft ban: amounts at or below it still go through.
   */
  reportRedFlag(
    denyListId: string,
    address: string,
    plausibilityScore: number,
    banCeiling: number,
  ): Promise<{ banned: true }>;

  /** True only if a transfer of `amount` to `address` would be blocked. */
  isAmountBlocked(denyListId: string, address: string, amount: number): Promise<boolean>;
}
