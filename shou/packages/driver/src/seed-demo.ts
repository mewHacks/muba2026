// Seeding script for Dev B (and demo day rehearsal).
//
// Creates an on-chain SeniorityPolicy and a pending HIGH-tier TransferRequest,
// then writes the IDs to shou/demo-ids.json so the Guardian Dashboard
// and extension can immediately bind to real testnet objects.
//
// Run:
//   node --experimental-strip-types src/seed-demo.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiShouClient, TESTNET_USDC } from './client.ts';
import type { RiskAssessment } from './types.ts';

function readPublishedPackageId(): string {
  if (process.env.SHOU_PACKAGE_ID) return process.env.SHOU_PACKAGE_ID;
  const toml = readFileSync(
    join(import.meta.dirname, '../../../move/Published.toml'),
    'utf8',
  );
  const match = toml.match(/published-at\s*=\s*"(0x[0-9a-f]+)"/);
  if (!match) throw new Error('no published-at in Published.toml');
  return match[1]!;
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

async function main(): Promise<void> {
  const packageId = readPublishedPackageId();
  const signer = loadKeypair();
  const sender = signer.toSuiAddress();
  const coinType = process.env.SHOU_COIN_TYPE ?? TESTNET_USDC;
  const isUsdc = coinType === TESTNET_USDC;
  const unit = isUsdc ? 'USDC' : 'SUI';

  console.log(`=== SHOU Demo Seeder ===`);
  console.log(`Package ID : ${packageId}`);
  console.log(`Deployer   : ${sender}`);
  console.log(`Coin Type  : ${unit} (${coinType})`);

  const client = new SuiShouClient({
    packageId,
    network: 'testnet',
    signer,
  });

  let denyListId = process.env.SHOU_DENY_LIST;
  const adminCapId = process.env.SHOU_ADMIN_CAP;

  if (!denyListId) {
    if (adminCapId) {
      console.log('Creating fresh DenyList on-chain...');
      const dl = await client.createDenyList(adminCapId);
      denyListId = dl.denyListId;
      console.log(`Created DenyList: ${denyListId}`);
    } else {
      // No placeholder here. 0x…d1 is not a real object, so createPolicy
      // would fail deep inside the transaction with an object-not-found
      // error that reads like an RPC problem. Say what is missing instead.
      throw new Error(
        'Set SHOU_DENY_LIST to an existing DenyList, or SHOU_ADMIN_CAP to create one.',
      );
    }
  }

  // Guardian: defaults to deployer so the developer can self-approve during demo tests.
  const guardianAddress = process.env.SHOU_GUARDIAN_ADDRESS ?? sender;

  console.log(`Creating SeniorityPolicy for elder with guardian: ${guardianAddress}...`);
  // Amount limits: review ceiling = $1, high risk ceiling = $5 (or in SUI units)
  const reviewCeiling = isUsdc ? 1_000_000 : 1_000_000_000;
  const highRiskCeiling = isUsdc ? 5_000_000 : 5_000_000_000;

  const { policyId } = await client.createPolicy(
    [guardianAddress],
    1, // 1-of-1 guardian approval
    // A real deployment wants hours here. A demo does not: a 24h cooldown
    // means the MEDIUM path — transfer waits, then clears — cannot be shown
    // on stage at all, and MEDIUM is the tier that best demonstrates the
    // product. Two minutes by default; override for a realistic setup.
    Number(process.env.SHOU_COOLDOWN_MS ?? 120_000),
    denyListId,
    reviewCeiling,
    highRiskCeiling,
  );
  console.log(`Policy created: ${policyId}`);

  // Seeded demo transfer: 2.00 USDC to scammer address
  const scammerRecipient =
    process.env.SHOU_SCAMMER_RECIPIENT ??
    '0x00000000000000000000000000000000000000000000000000000000000000c1';
  const transferAmount = isUsdc ? 2_000_000 : 2_000_000_000;

  console.log(`Submitting sample HIGH-tier transfer request held in escrow...`);
  const simulatedHighRisk: RiskAssessment = {
    tier: 'HIGH',
    truthScore: 12,
    requestId: `seed-${Date.now()}`,
    category: 'urgency + impersonation scam',
    messageHash: '00'.repeat(32),
  };

  let pendingRequestId = '';
  try {
    const request = await client.requestTransfer(
      policyId,
      denyListId,
      transferAmount,
      scammerRecipient,
      simulatedHighRisk,
      coinType,
    );
    pendingRequestId = request.requestId;
    console.log(`Pending TransferRequest created on-chain: ${pendingRequestId}`);
    console.log(`Status: ${request.status}, Tier: ${request.tier}`);
  } catch (err) {
    console.warn('Could not submit seeded transfer on testnet (insufficient balance or missing gas):', err);
    pendingRequestId = 'needs-faucet-funding';
  }

  const output = {
    packageId,
    network: 'testnet',
    coinType,
    denyListId,
    policyId,
    guardianAddress,
    pendingTransferRequestId: pendingRequestId,
    sampleScammerRecipient: scammerRecipient,
    seededAt: new Date().toISOString(),
  };

  const outPath = join(import.meta.dirname, '../../../demo-ids.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSuccessfully wrote demo IDs to: ${outPath}`);
  console.log(`Dev B can load demo-ids.json into the Dashboard!\n`);
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
