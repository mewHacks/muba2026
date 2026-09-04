// The shared interface between Dev A (chain) and Dev B (AI & surface).
// See shou-architecture.md §4. Dev B only ever imports from this file —
// never Move, never @mysten/sui directly.

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

/** Output of Gonka Router scoring — Dev B produces this, Dev A only ever consumes it. */
export interface RiskAssessment {
  tier: RiskTier;
  // 0-100, and it is a RISK score despite the name: HIGHER MEANS MORE
  // DANGEROUS. `tierFor()` maps a high value to HIGH, and the enclave keeps
  // the worst verdict in a session with Math.max. A real scam scores ~86-91;
  // a benign family message scores 0. Rendering it as a trustworthiness
  // figure inverts it — the elder page did exactly that and showed
  // "Truth Score: 86/100" next to a scam warning.
  truthScore: number;
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
  /**
   * Digest of the transaction that produced this state, when this state is
   * the result of one. Absent from a plain `getTransferStatus` read, which
   * observes the object rather than changing it.
   *
   * Optional, and additive: a caller that ignores it is unaffected. It
   * exists because a UI that says "approved" without a digest is asking to
   * be taken on trust — the digest is how a guardian (or a judge) confirms
   * on an explorer that the click really reached the chain.
   */
  digest?: string;
}

/**
 * A policy as the guardian dashboard needs to read it. Separate from the
 * write-side arguments of `createPolicy` because the dashboard needs the
 * threshold and the approver set to say "1 of 2 people have approved" —
 * the request object carries the approvals but not the number required.
 */
export interface PolicyView {
  policyId: string;
  owner: string;
  approvers: string[];
  threshold: number;
  cooldownMs: number;
  reviewCeiling: string;
  highRiskCeiling: string;
  pausedUntilMs: number;
}

/**
 * One row of the guardian dashboard: a request plus the facts a guardian
 * needs to decide on it.
 *
 * `claimedTier` is what the caller (or the enclave) submitted and `tier`
 * is what the chain assigned. When they differ the chain escalated on its
 * own — that difference is the whole "the AI's verdict is a floor" claim,
 * so it is surfaced rather than smoothed over.
 *
 * Note what is absent: the message, and any description of it. A guardian
 * gets a tier and an amount, never a transcript of what her mother was
 * told. See shou-idea.md §9.
 */
export interface TransferRequestView extends TransferState {
  requestId: string;
  policyId: string;
  recipient: string;
  /** Base units of the coin type — 6 decimals for USDC. */
  amount: string;
  claimedTier: RiskTier | null;
  truthScore: number | null;
  /** Checkpoint time of the requesting transaction, or null if not yet checkpointed. */
  requestedAtMs: number | null;
  /** Address that submitted the request — the elder. */
  requestedBy: string;
}

/**
 * One address on the community deny list, as a read-only list needs it.
 *
 * Everything here is read back from the `DenyList` table itself, not from
 * the report events — the events record what was asked for at the time,
 * and a later `clear` does not amend them. An address that has been
 * cleared by staff simply does not appear.
 *
 * `reportCount` is the exception and is labelled as such: it counts
 * `AddressBanned` events for this address across the whole package,
 * because the event carries no deny-list id to filter on. It is
 * corroboration ("this has been reported three times"), not the ban.
 */
export interface RedFlagView {
  address: string;
  /** 0-100, decided off-chain by the Gonka scoring service before the ban landed. */
  plausibilityScore: number;
  /**
   * Base units of the coin. This is the "soft" in soft ban: a transfer of
   * this amount or less to this address still goes through. Left as a
   * string because 0 and u64::MAX are both meaningful and the latter does
   * not survive a JS number.
   */
  banCeiling: string;
  /** When the most recent report was recorded on-chain. */
  reportedAtMs: number;
  /** See the note above: package-wide event count, not a per-list tally. */
  reportCount: number;
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
  ): Promise<{ policyId: string; digest?: string }>;

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

  /** Read-side, for the guardian dashboard: the threshold and approver set. */
  getPolicy(policyId: string): Promise<PolicyView>;

  /**
   * Every transfer request ever raised against `policyId`, newest first.
   *
   * Sourced from `TransferRequested` events and then re-read from the
   * objects themselves, because the event only records the state at
   * creation — an approval or a block that happened afterwards does not
   * amend it. The object is the truth; the event is only how we find it.
   */
  listTransferRequests(policyId: string, limit?: number): Promise<TransferRequestView[]>;

  /** True only if a transfer of `amount` to `address` would be blocked. */
  isAmountBlocked(denyListId: string, address: string, amount: number): Promise<boolean>;

  /**
   * Read-side of Layer 3: every address currently banned on `denyListId`.
   *
   * Enumerated from the `Table` inside the DenyList object rather than
   * from `AddressBanned` events, because the events are a log of requests
   * and the table is the state that `policy::submit_transfer` actually
   * consults. A cleared address is gone from one and still present in the
   * other.
   */
  listRedFlags(denyListId: string, limit?: number): Promise<RedFlagView[]>;
}
