// The demo moment: lie to the contract and watch it refuse anyway.
//
// Everything else we show depends on the AI being right. This shows what
// happens when it is wrong — or compromised, or replaced by an attacker
// who controls the whole scoring pipeline.
//
// We submit a transfer far above the elder's own high-risk ceiling and
// tell the chain it is LOW risk. The chain escalates it to HIGH regardless,
// because `submit_transfer` takes max_tier(amount_tier, reported_tier):
// the AI's verdict is a FLOOR, never a ceiling. It can tighten. It can
// never loosen.
//
// That is the honest answer to "what if your AI hallucinates?" — you do not
// have to trust it. Her own pre-committed limits are enforced independently.
//
//   node --experimental-strip-types packages/driver/src/demo-escalation.ts
//
// Needs SHOU_PACKAGE_ID, SHOU_DENY_LIST and SHOU_POLICY_ID (or a
// shou/demo-ids.json written by seed-demo.ts).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiShouClient, TESTNET_USDC } from './client.ts';
import type { RiskAssessment } from './types.ts';

function demoIds(): Record<string, string> {
  try {
    return JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../demo-ids.json'), 'utf8'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function loadKeypair(): Ed25519Keypair {
  const fromEnv = process.env.SHOU_PRIVATE_KEY;
  if (fromEnv) return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(fromEnv).secretKey);
  const keystore = JSON.parse(
    readFileSync(join(homedir(), '.sui', 'sui_config', 'sui.keystore'), 'utf8'),
  ) as string[];
  return Ed25519Keypair.fromSecretKey(
    new Uint8Array(Buffer.from(keystore[0]!, 'base64').subarray(1)),
  );
}

const ids = demoIds();
const packageId = process.env.SHOU_PACKAGE_ID ?? ids.packageId;
const denyListId = process.env.SHOU_DENY_LIST ?? ids.denyListId;
const policyId = process.env.SHOU_POLICY_ID ?? ids.policyId;
const coinType = process.env.SHOU_COIN_TYPE ?? ids.coinType ?? TESTNET_USDC;

if (!packageId || !denyListId || !policyId) {
  console.error(
    'Missing ids. Run seed-demo.ts first, or set SHOU_PACKAGE_ID, SHOU_DENY_LIST and SHOU_POLICY_ID.',
  );
  process.exit(1);
}

const decimals = coinType === TESTNET_USDC ? 1_000_000 : 1_000_000_000;
const unit = coinType === TESTNET_USDC ? 'USDC' : 'SUI';
// Deliberately above the seeded high-risk ceiling of 5.
const amount = Number(process.env.SHOU_AMOUNT ?? 6 * decimals);

const client = new SuiShouClient({ packageId, network: 'testnet', signer: loadKeypair() });

console.log('The AI has been compromised. It reports every transfer as safe.\n');
console.log(`  sending          : ${(amount / decimals).toFixed(2)} ${unit}`);
console.log(`  AI says          : LOW risk, truth score 100`);
console.log(`  her own ceiling  : 5.00 ${unit} — above this, a guardian must approve\n`);

// A maximally dishonest assessment: the best possible score, on a transfer
// well above her ceiling.
const compromised: RiskAssessment = {
  tier: 'LOW',
  truthScore: 100,
  requestId: `compromised-${Date.now()}`,
  category: 'looks completely fine, trust me',
  messageHash: '00'.repeat(32),
};

const request = await client.requestTransfer(
  policyId,
  denyListId,
  amount,
  process.env.SHOU_RECIPIENT ??
    '0x00000000000000000000000000000000000000000000000000000000000000c1',
  compromised,
  coinType,
);

console.log(`  request          : ${request.requestId}`);
console.log(`  chain assigned   : ${request.tier}`);
console.log(`  status           : ${request.status}\n`);

if (request.tier === 'HIGH') {
  console.log('The chain overruled the AI.');
  console.log('The money is locked until a guardian approves — exactly as if');
  console.log('the AI had flagged it. Her own limits do not depend on the AI');
  console.log('being right, or even on it being honest.');
} else {
  console.error(`UNEXPECTED: tier is ${request.tier}, expected HIGH.`);
  console.error('Escalation did not fire — check the policy ceilings.');
  process.exit(1);
}
