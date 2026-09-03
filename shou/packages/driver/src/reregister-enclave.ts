// Recovery for the failure that will otherwise ruin a demo.
//
// The enclave generates its signing key in memory at startup and never
// persists it — correct behaviour for a real TEE, where a restart is
// supposed to mean a new key. But it means that any restart (laptop
// sleep, Ctrl-C, a crash) leaves the OLD public key registered on-chain
// while the enclave signs with a NEW one.
//
// Every attestation then fails with `EInvalidSignature`: a cryptic Move
// abort that looks like a bug in the contract rather than what it is.
// The fix is thirty seconds of work if you know, and a lost demo if you
// do not.
//
//   node --experimental-strip-types src/reregister-enclave.ts
//
// Reads SHOU_ENCLAVE_CONFIG (an existing EnclaveConfig object) and
// SHOU_ADMIN_CAP, fetches the enclave's CURRENT public key from its
// /get_attestation endpoint, registers it, and prints the new Enclave
// object id to use for the rest of the demo.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiShouClient } from './client.ts';

const ENCLAVE_URL = process.env.ENCLAVE_URL ?? 'http://localhost:3000';

function packageId(): string {
  if (process.env.SHOU_PACKAGE_ID) return process.env.SHOU_PACKAGE_ID;
  const toml = readFileSync(join(import.meta.dirname, '../../../move/Published.toml'), 'utf8');
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

const configId = process.env.SHOU_ENCLAVE_CONFIG;
const adminCapId = process.env.SHOU_ADMIN_CAP;
if (!configId || !adminCapId) {
  console.error('set SHOU_ENCLAVE_CONFIG and SHOU_ADMIN_CAP');
  process.exit(1);
}

const live = (await fetch(`${ENCLAVE_URL}/get_attestation`).then((r) => r.json())) as {
  publicKey: string;
};
console.log(`enclave is currently signing with: ${live.publicKey}`);

const client = new SuiShouClient({
  packageId: packageId(),
  network: 'testnet',
  signer: loadKeypair(),
});

const { enclaveId } = await client.registerEnclave(configId, adminCapId, live.publicKey);

console.log(`\nre-registered. use this Enclave object from now on:\n  ${enclaveId}\n`);
console.log('Note: the previously registered Enclave object still exists but its key is dead.');
