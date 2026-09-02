// The signing half of SHOU's TEE layer.
//
// This module defines the exact bytes that shou::enclave verifies. The
// BCS layout below MUST mirror the `RiskAttestation` struct in
// shou/move/sources/enclave.move field-for-field and in order — if they
// drift, every signature silently stops verifying on-chain. The Move
// test in tests/enclave_tests.move verifies a fixture produced here,
// which is what keeps the two definitions honest.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { bcs } from '@mysten/sui/bcs';

/** Domain separator — must equal INTENT_RISK_SCORE in enclave.move. */
export const INTENT_RISK_SCORE = 0;

export const RiskTierCode = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
export type RiskTierName = keyof typeof RiskTierCode;

export const RiskAttestationBcs = bcs.struct('RiskAttestation', {
  intent: bcs.u8(),
  timestamp_ms: bcs.u64(),
  message_hash: bcs.vector(bcs.u8()),
  policy_id: bcs.Address,
  recipient: bcs.Address,
  amount: bcs.u64(),
  risk_tier: bcs.u8(),
  truth_score: bcs.u8(),
});

export interface RiskAttestationFields {
  timestampMs: number;
  /** sha256 of the scored message. The message itself never leaves here. */
  messageHash: Uint8Array;
  policyId: string;
  recipient: string;
  amount: bigint | number;
  riskTier: number;
  truthScore: number;
}

export function serializeAttestation(fields: RiskAttestationFields): Uint8Array {
  return RiskAttestationBcs.serialize({
    intent: INTENT_RISK_SCORE,
    timestamp_ms: BigInt(fields.timestampMs),
    message_hash: Array.from(fields.messageHash),
    policy_id: fields.policyId,
    recipient: fields.recipient,
    amount: BigInt(fields.amount),
    risk_tier: fields.riskTier,
    truth_score: fields.truthScore,
  }).toBytes();
}

/**
 * The enclave's ephemeral keypair. Generated in memory at startup and
 * never written to disk — that is the whole point: the host OS cannot
 * read enclave memory, so nobody, including us, can sign as the enclave
 * or reconstruct it after a restart. A restart means re-registering the
 * new public key on-chain.
 */
export interface EnclaveKeypair {
  /** 32 raw bytes, the form shou::enclave stores and ed25519_verify expects. */
  publicKeyRaw: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function generateEnclaveKeypair(): EnclaveKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // Node hands back DER/SPKI; the last 32 bytes are the raw ed25519 key.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyRaw = new Uint8Array(spki.subarray(spki.length - 32));
  return {
    publicKeyRaw,
    sign: (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}

/** Rebuilds a keypair from a stored seed. Test/fixture use only. */
export function keypairFromPkcs8(pkcs8Der: Uint8Array): EnclaveKeypair {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8Der), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return {
    publicKeyRaw: new Uint8Array(spki.subarray(spki.length - 32)),
    sign: (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
