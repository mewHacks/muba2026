// Weighted multisig recovery for the elder's wallet.
//
// WHY THIS EXISTS. A zkLogin address is derived, not a keypair: there is
// no seed phrase, it cannot be exported into another wallet, and access
// dies if any of three things break — her Google account, the per-user
// salt, or our OAuth client ID. That makes zkLogin *alone* unsuitable
// for money that matters, which is exactly what this product holds.
//
// The naive fixes are both wrong:
//   1-of-2 with the guardian -> he can drain her wallet unilaterally,
//     and family members are a leading cause of elder financial abuse.
//   2-of-2 -> she cannot buy groceries without her son. Product dead.
//
// So: weights, not counts.
//
//   elder (zkLogin)          weight 2
//   guardian                 weight 1
//   second family member     weight 1
//   threshold                       2
//
//   elder alone       2 >= 2  -> signs every day, by herself
//   guardian alone    1 <  2  -> CANNOT touch her money
//   guardian + second 2 >= 2  -> recovery when zkLogin dies
//
// Note this is the same rule the Move policy enforces one layer up: a
// guardian can stop a transfer but never take the money. Here that rule
// is expressed at the key level instead of the application level.

import { MultiSigPublicKey } from '@mysten/sui/multisig';
import type { PublicKey } from '@mysten/sui/cryptography';

/** Weight for the elder's own signer — enough to meet the threshold alone. */
export const ELDER_WEIGHT = 2;
/** Weight for each recovery party — deliberately below the threshold. */
export const RECOVERY_WEIGHT = 1;
/** Two recovery parties together equal the elder; one alone is not enough. */
export const THRESHOLD = 2;

export interface RecoveryMembers {
  /**
   * The elder's day-to-day signer. A plain keypair today; once zkLogin is
   * wired this is the zkLogin public identifier from
   * `toZkLoginPublicIdentifier(addressSeed, iss)` — the multisig treats
   * both the same way, which is what lets us build and test this before
   * the OAuth flow exists.
   */
  elder: PublicKey;
  /** The guardian — already an approver on large transfers in the Move policy. */
  guardian: PublicKey;
  /** A second family member. Needed *with* the guardian to recover. */
  second: PublicKey;
}

/**
 * Builds the multisig public key for an elder's wallet.
 *
 * The resulting address does NOT depend on zkLogin continuing to work —
 * it derives from the whole key set. That is the entire point: if her
 * salt is lost or Google locks her out, the address is still reachable.
 */
export function buildRecoveryMultisig(members: RecoveryMembers): MultiSigPublicKey {
  return MultiSigPublicKey.fromPublicKeys({
    threshold: THRESHOLD,
    publicKeys: [
      { publicKey: members.elder, weight: ELDER_WEIGHT },
      { publicKey: members.guardian, weight: RECOVERY_WEIGHT },
      { publicKey: members.second, weight: RECOVERY_WEIGHT },
    ],
  });
}

/** The wallet address the elder's funds actually live at. */
export function recoveryAddress(members: RecoveryMembers): string {
  return buildRecoveryMultisig(members).toSuiAddress();
}

/**
 * True if this combination of members can authorise a transaction.
 * Exposed so a UI can explain *why* an action is or is not possible
 * ("your son alone cannot move this money") rather than just failing.
 */
export function canAuthorise(signers: ('elder' | 'guardian' | 'second')[]): boolean {
  const weights = { elder: ELDER_WEIGHT, guardian: RECOVERY_WEIGHT, second: RECOVERY_WEIGHT };
  const total = [...new Set(signers)].reduce((sum, s) => sum + weights[s], 0);
  return total >= THRESHOLD;
}
