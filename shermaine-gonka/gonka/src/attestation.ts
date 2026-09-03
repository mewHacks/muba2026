import { createHmac, randomUUID } from "node:crypto";
import type { Attestation, RiskTier } from "./types.js";
import { POLICY_VERSION } from "./rules.js";
import { PROMPT_VERSION } from "./gonka.js";

/**
 * An assessment is only meaningful for ONE transfer.
 *
 * Today shou::policy::submit_transfer takes `risk_tier: u8` straight from the caller,
 * so a LOW tier can simply be asserted. This module builds the payload that has to be
 * bound and verified instead, so a LOW result cannot be borrowed for a different
 * recipient, a different amount, or a later attempt.
 *
 * Hackathon-feasible enforcement: a RiskOracleCap held by this service and required by
 * submit_transfer. Production: ed25519_verify over exactly these fields on-chain.
 */

const TTL_MS = 5 * 60 * 1000;

/**
 * HMAC, not a bare hash. A plain SHA-256 of "your parcel is held at customs" is
 * trivially reversed by hashing a dictionary of known scam lines, so a bare digest
 * on-chain leaks the message. The key never leaves this service.
 */
export function messageCommitment(message: string): string {
  const key = process.env.SHOU_COMMITMENT_KEY ?? "dev-only-key-set-SHOU_COMMITMENT_KEY";
  return createHmac("sha256", key).update(message.normalize("NFKC").trim().toLowerCase()).digest("hex");
}

export function buildAttestation(params: {
  policyId: string;
  sender: string;
  recipient: string;
  amountMYR: number;
  tier: RiskTier;
  message: string;
}): Attestation {
  const now = Date.now();
  return {
    assessmentId: randomUUID(),
    policyId: params.policyId,
    sender: params.sender,
    recipient: params.recipient,
    amountMYR: params.amountMYR,
    tier: params.tier,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    policyVersion: POLICY_VERSION,
    promptVersion: PROMPT_VERSION,
    messageCommitment: messageCommitment(params.message),
  };
}

/** Canonical bytes the Move side should sign over / bind the capability to. */
export const attestationDigest = (a: Attestation): string =>
  createHmac("sha256", process.env.SHOU_COMMITMENT_KEY ?? "dev-only-key")
    .update([a.assessmentId, a.policyId, a.sender, a.recipient, String(a.amountMYR), a.tier, a.expiresAt].join("|"))
    .digest("hex");
