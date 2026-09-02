// The whole design rests on three properties holding at once. A weighting
// that gets any one of them wrong is either unusable or unsafe, so this
// verifies all three with real signatures rather than trusting the maths.
//
//   node --experimental-strip-types --test src/recovery.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { buildRecoveryMultisig, canAuthorise, recoveryAddress } from './recovery.ts';

const elder = new Ed25519Keypair();
const guardian = new Ed25519Keypair();
const second = new Ed25519Keypair();

const members = {
  elder: elder.getPublicKey(),
  guardian: guardian.getPublicKey(),
  second: second.getPublicKey(),
};

const message = new TextEncoder().encode('send 200 USDC to the clinic');

test('the elder signs alone — every day, without her family', async () => {
  const multisig = buildRecoveryMultisig(members);
  const signer = multisig.getSigner(elder);
  const { signature } = await signer.signPersonalMessage(message);
  assert.ok(await multisig.verifyPersonalMessage(message, signature));
});

test('the guardian CANNOT act alone — this is the family-abuse guard', async () => {
  const multisig = buildRecoveryMultisig(members);
  const guardianOnly = (await guardian.signPersonalMessage(message)).signature;

  // Weight 1 against a threshold of 2. Either combining refuses outright,
  // or whatever it produces must fail verification. Both are acceptable;
  // silently accepting it is not.
  let accepted = false;
  try {
    const combined = multisig.combinePartialSignatures([guardianOnly]);
    accepted = await multisig.verifyPersonalMessage(message, combined);
  } catch {
    accepted = false;
  }
  assert.equal(accepted, false, 'guardian alone was able to authorise a transaction');
});

test('guardian + second together CAN recover — when zkLogin is gone', async () => {
  const multisig = buildRecoveryMultisig(members);
  // Two separate people on two separate devices, exactly as a real
  // recovery happens — they never share a process.
  const guardianSig = (await guardian.signPersonalMessage(message)).signature;
  const secondSig = (await second.signPersonalMessage(message)).signature;

  const combined = multisig.combinePartialSignatures([guardianSig, secondSig]);
  assert.ok(await multisig.verifyPersonalMessage(message, combined));
});

test('the address does not depend on zkLogin surviving', () => {
  // Same member set, same address, every time. The address derives from
  // the key set — not from the elder's signer working — which is what
  // makes recovery possible at all.
  assert.equal(recoveryAddress(members), recoveryAddress(members));
  assert.match(recoveryAddress(members), /^0x[0-9a-f]{64}$/);
});

test('changing any member changes the wallet', () => {
  const other = new Ed25519Keypair();
  assert.notEqual(
    recoveryAddress(members),
    recoveryAddress({ ...members, second: other.getPublicKey() }),
  );
});

test('canAuthorise matches the on-chain weighting', () => {
  assert.ok(canAuthorise(['elder']));
  assert.ok(canAuthorise(['guardian', 'second']));
  assert.ok(!canAuthorise(['guardian']));
  assert.ok(!canAuthorise(['second']));
  // Duplicates must not stack — one party signing twice is still one party.
  assert.ok(!canAuthorise(['guardian', 'guardian']));
});
