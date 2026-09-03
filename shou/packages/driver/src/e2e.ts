// End-to-end proof of the attested (TEE) path, driven entirely through
// client.ts rather than the CLI. This is the script that turns
// "typechecks" into "works".
//
// It walks the demo beat in order:
//   1. register the enclave build + its live public key on-chain
//   2. a scam message arrives and is scored inside the enclave
//   3. the elder tries to send money; the enclave signs a verdict bound
//      to that exact transfer
//   4. the chain accepts the attestation and holds the transfer
//   5. releasing without approval is refused
//   6. a guardian approves, and only then does the money move
//
// Run:
//   node --experimental-strip-types src/e2e.ts
//
// Signer: set SHOU_PRIVATE_KEY (a suiprivkey1... string) to use a
// dedicated key. With nothing set, it falls back to the active address
// in your local Sui CLI keystore, which is the usual dev setup.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiShouClient, TESTNET_USDC } from './client.ts';
import type { EnclaveAttestation } from './types.ts';

const ENCLAVE_URL = process.env.ENCLAVE_URL ?? 'http://localhost:3100';
const PACKAGE_ID = process.env.SHOU_PACKAGE_ID ?? readPublishedPackageId();
// Defaults to real testnet USDC — this is a payments product, and the
// asset the elder actually holds is a stablecoin her family sent, not a
// volatile native token. Override with SHOU_COIN_TYPE to use SUI.
const COIN_TYPE = process.env.SHOU_COIN_TYPE ?? TESTNET_USDC;
const IS_USDC = COIN_TYPE === TESTNET_USDC;
// USDC has 6 decimals, so 2_000_000 = 2.00 USDC.
const AMOUNT = Number(process.env.SHOU_AMOUNT ?? (IS_USDC ? 2_000_000 : 1_000_000));
const UNIT = IS_USDC ? 'USDC' : 'SUI';
const SESSION_ID = `e2e-${Date.now()}`;
// A distinct recipient so the demo shows funds actually LEAVING her
// wallet. Sending to self proves the mechanism but shows no movement on
// screen, which is the thing a judge is watching for.
const RECIPIENT =
  process.env.SHOU_RECIPIENT ??
  '0x00000000000000000000000000000000000000000000000000000000000000c1';

const SCAM_MESSAGE =
  'URGENT: your account has been suspended. Transfer the funds now to secure them, ' +
  'and do not tell your family — the bank asked me not to say.';

function readPublishedPackageId(): string {
  const toml = readFileSync(
    join(import.meta.dirname, '../../../move/Published.toml'),
    'utf8',
  );
  const match = toml.match(/published-at\s*=\s*"(0x[0-9a-f]+)"/);
  if (!match) throw new Error('no published-at in Published.toml — publish the package first');
  return match[1]!;
}

function loadKeypair(): Ed25519Keypair {
  const fromEnv = process.env.SHOU_PRIVATE_KEY;
  if (fromEnv) {
    const { secretKey } = decodeSuiPrivateKey(fromEnv);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  // Local CLI keystore. Never printed, never leaves this process.
  const keystore = JSON.parse(
    readFileSync(join(homedir(), '.sui', 'sui_config', 'sui.keystore'), 'utf8'),
  ) as string[];
  const raw = Buffer.from(keystore[0]!, 'base64');
  return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)));
}

async function enclavePost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${ENCLAVE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`enclave ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

function step(n: number, text: string): void {
  console.log(`\n[${n}] ${text}`);
}

async function main(): Promise<void> {
  const keypair = loadKeypair();
  const me = keypair.toSuiAddress();
  console.log(`package : ${PACKAGE_ID}`);
  console.log(`sender  : ${me}`);
  console.log(`asset   : ${UNIT} (${COIN_TYPE})`);
  console.log(`to      : ${RECIPIENT}`);
  console.log(`amount  : ${(AMOUNT / 1e6).toFixed(2)} ${UNIT}`);

  const client = new SuiShouClient({ packageId: PACKAGE_ID, network: 'testnet', signer: keypair });
  const before = await client.balanceOf(me, COIN_TYPE);

  step(0, 'Enclave health + public key');
  const attestationInfo = (await fetch(`${ENCLAVE_URL}/get_attestation`).then((r) =>
    r.json(),
  )) as { publicKey: string; attestationDocument: string | null };
  console.log(`    enclave pubkey: ${attestationInfo.publicKey}`);
  if (!attestationInfo.attestationDocument) {
    console.log('    NOTE: no AWS attestation document — not running on a Nitro instance.');
    console.log('          Signature verification below is real; key provenance is admin-asserted.');
  }

  const adminCapId = process.env.SHOU_ADMIN_CAP;
  const denyListId = process.env.SHOU_DENY_LIST;
  if (!adminCapId || !denyListId) {
    throw new Error(
      'set SHOU_ADMIN_CAP and SHOU_DENY_LIST (create the deny list once, then reuse it)',
    );
  }

  step(1, 'Register enclave build (PCRs) and its live public key on-chain');
  const { configId } = await client.registerEnclaveConfig(
    adminCapId,
    'shou-risk-scorer-v1',
    // Placeholder measurements: real PCRs come from the Nitro build.
    'aa'.repeat(48),
    'bb'.repeat(48),
    'cc'.repeat(48),
  );
  const { enclaveId } = await client.registerEnclave(configId, adminCapId, attestationInfo.publicKey);
  console.log(`    config=${configId}`);
  console.log(`    enclave=${enclaveId}`);

  step(2, 'A scam message arrives and is scored INSIDE the enclave');
  const scored = await enclavePost<{ tier: string; category: string }>('/process_data', {
    sessionId: SESSION_ID,
    message: SCAM_MESSAGE,
    policyId: '0x0'.padEnd(66, '0'),
    recipient: '0x0'.padEnd(66, '0'),
    amount: '0',
  });
  console.log(`    verdict: ${scored.tier} (${scored.category})`);
  console.log('    the message itself never left the enclave — only a hash and this verdict');

  step(3, 'Create the elder policy (guardian approval above the high ceiling)');
  const { policyId } = await client.createPolicy(
    [me], // self-approve so this script can complete solo; real policies name family
    1,
    60_000,
    denyListId,
    AMOUNT, // review ceiling
    AMOUNT, // high-risk ceiling
  );
  console.log(`    policy=${policyId}`);

  step(4, 'Elder tries to send money — enclave signs a verdict bound to THIS transfer');
  const attested = await enclavePost<{
    attestation: EnclaveAttestation;
    signature: string;
    tier: string;
    hadSessionRisk: boolean;
  }>('/attest_transfer', {
    sessionId: SESSION_ID,
    policyId,
    recipient: RECIPIENT,
    amount: String(AMOUNT),
  });
  console.log(`    signed tier=${attested.tier}, sessionRisk=${attested.hadSessionRisk}`);

  step(5, 'Submit the attested transfer on-chain');
  const request = await client.requestTransferAttested(
    policyId,
    denyListId,
    enclaveId,
    attested.attestation,
    attested.signature,
    COIN_TYPE,
  );
  console.log(`    request=${request.requestId}`);
  console.log(`    chain assigned tier=${request.tier}, status=${request.status}`);

  step(6, 'Try to release it with no approval — this must fail');
  try {
    await client.executeTransfer(request.requestId, policyId, COIN_TYPE);
    console.error('    !! FAILED: the transfer executed without approval');
    process.exitCode = 1;
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const refused = message.includes('EThresholdNotMet');
    console.log(`    refused as expected: ${refused ? 'EThresholdNotMet' : message.slice(0, 120)}`);
    if (!refused) {
      console.error('    !! FAILED: refused for the wrong reason');
      process.exitCode = 1;
      return;
    }
  }

  step(7, 'Guardian approves, then the money moves');
  const approved = await client.approveTransfer(request.requestId, policyId, COIN_TYPE);
  console.log(`    after approval: status=${approved.status}, approvals=${approved.approvals.length}`);
  const executed = await client.executeTransfer(request.requestId, policyId, COIN_TYPE);
  console.log(`    after execute : status=${executed.status}`);

  if (executed.status !== 'EXECUTED') {
    console.error('    !! FAILED: transfer did not reach EXECUTED');
    process.exitCode = 1;
    return;
  }
  const after = await client.balanceOf(me, COIN_TYPE);
  console.log(`\n    sender ${UNIT}: ${(Number(before) / 1e6).toFixed(2)} -> ${(Number(after) / 1e6).toFixed(2)}`);
  console.log('\nOK — attested TEE path verified end to end on testnet.');
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
