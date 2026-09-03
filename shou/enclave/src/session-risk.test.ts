// The session-laundering guard, verified end to end against a live server.
//
// The attack this pins down: score a scam conversation to HIGH, then ask
// for an attestation under a DIFFERENT session id. If the lookup is keyed
// on the caller-supplied session id, the HIGH is not found and the
// enclave signs a LOW — the AI layer is bypassed by changing one string.
//
//   node --experimental-strip-types src/session-risk.test.ts
//
// Runs against a real HTTP server with a stubbed scorer, so it exercises
// the actual request path rather than the internals.

import assert from 'node:assert/strict';

process.env.SHOU_TEST_SCORER = '1';
process.env.SHOU_NO_AUTOSTART = '1';
process.env.PORT = '0';

const { startServer } = await import('./server.ts');
const { port, close } = await startServer();
const base = `http://127.0.0.1:${port}`;

const POLICY = '0x00000000000000000000000000000000000000000000000000000000000000cc';
const RECIPIENT = '0x00000000000000000000000000000000000000000000000000000000000000c1';

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

const attest = (sessionId: string, amount = 1000) =>
  post('/attest_transfer', { sessionId, policyId: POLICY, recipient: RECIPIENT, amount });

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n     ${(error as Error).message}`);
  }
};

// A scam conversation is scored HIGH under session "real".
const scored = await post('/process_data', {
  message: 'URGENT: your account is frozen, send the gift card codes now',
  sessionId: 'real',
  policyId: POLICY,
  recipient: RECIPIENT,
  amount: 1000,
});
check('the scam message scores HIGH', () => assert.equal(scored.tier, 'HIGH'));

const sameSession = await attest('real');
check('attesting under the same session reports HIGH', () =>
  assert.equal(sameSession.tier, 'HIGH'),
);

// THE ATTACK. Same policy, a session id the server has never seen.
const laundered = await attest('attacker-fresh-id');
check('a fresh session id CANNOT launder the HIGH away', () =>
  assert.equal(
    laundered.tier,
    'HIGH',
    `session laundering succeeded: got ${String(laundered.tier)}, expected HIGH`,
  ),
);

// A different policy must not inherit an unrelated policy's verdict —
// otherwise one scam anywhere would freeze every wallet.
const otherPolicy = await post('/attest_transfer', {
  sessionId: 'unrelated',
  policyId: '0x0000000000000000000000000000000000000000000000000000000000000099',
  recipient: RECIPIENT,
  amount: 1000,
});
check('an unrelated policy is unaffected', () => assert.equal(otherPolicy.tier, 'LOW'));

// A verdict must survive even when the client sends no session id at all.
const noSession = await post('/process_data', {
  message: 'URGENT: wire the money now or you will be arrested',
  policyId: '0x0000000000000000000000000000000000000000000000000000000000000077',
  recipient: RECIPIENT,
  amount: 1000,
});
check('a message with no sessionId still scores', () => assert.equal(noSession.tier, 'HIGH'));

const recovered = await post('/attest_transfer', {
  sessionId: 'anything',
  policyId: '0x0000000000000000000000000000000000000000000000000000000000000077',
  recipient: RECIPIENT,
  amount: 1000,
});
check('a verdict recorded without a sessionId is still found', () =>
  assert.equal(recovered.tier, 'HIGH'),
);

await close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
