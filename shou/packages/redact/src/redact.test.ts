// Two properties have to hold together, and they pull against each
// other: strip everything identifying, keep enough that the scam is
// still detectable. A redactor that passes only the first is useless.
//
//   node --experimental-strip-types --test src/redact.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRedacted, redact } from './redact.ts';

const SCAM =
  'URGENT: your account is suspended. Your TAC is 448210. ' +
  'Transfer RM5,000 to account 5140228877901 immediately and call +60 12-345 6789. ' +
  'Confirm your IC 880214-14-5566 at https://maybank-verify.example.com/login?u=7 ' +
  'or email verify@maybank-secure.example.com. Do not tell your family.';

test('strips every identifying value from a realistic scam message', () => {
  const { text } = redact(SCAM);

  assert.ok(!text.includes('448210'), 'OTP/TAC leaked');
  assert.ok(!text.includes('5140228877901'), 'bank account leaked');
  assert.ok(!text.includes('880214-14-5566'), 'NRIC leaked');
  assert.ok(!text.includes('12-345 6789'), 'phone leaked');
  assert.ok(!text.includes('verify@maybank-secure.example.com'), 'email leaked');
  assert.ok(!text.includes('login?u=7'), 'URL path leaked');
});

test('keeps the signal a scam classifier needs', () => {
  const { text } = redact(SCAM);

  // The amount is the strongest single signal and identifies nobody.
  assert.ok(text.includes('RM5,000'), 'amount was destroyed');
  // Manipulation language must survive untouched.
  assert.ok(/URGENT/i.test(text), 'urgency cue lost');
  assert.ok(/suspended/i.test(text), 'authority cue lost');
  assert.ok(/Do not tell your family/i.test(text), 'secrecy cue lost');
  // The *shape* of the request survives: a payment, to an account,
  // with a callback number and a lookalike domain.
  assert.ok(text.includes('[ACCOUNT]'), 'account placeholder missing');
  assert.ok(text.includes('[PHONE]'), 'phone placeholder missing');
  // A lookalike domain is itself evidence, so the host is kept.
  assert.ok(text.includes('maybank-verify.example.com'), 'domain lost');
});

test('reports what it removed, without the values', () => {
  const { removed } = redact(SCAM);
  assert.ok(Object.keys(removed).length > 0);
  for (const value of Object.values(removed)) {
    assert.equal(typeof value, 'number');
  }
});

test('is idempotent — safe to run on-device and again in the enclave', () => {
  const once = redact(SCAM).text;
  const twice = redact(once).text;
  assert.equal(once, twice);
});

test('leaves an ordinary family message alone', () => {
  const benign = 'Hi Ma, dinner at 7? I will bring the durian you like.';
  assert.equal(redact(benign).text, benign);
});

test('redacts crypto addresses in message text', () => {
  const withWallet = 'send it to 0x4e48678637d9ff9fc151ee5b8083d21910ca280cee592b613addd0b8d9c32ddc now';
  const { text } = redact(withWallet);
  assert.ok(text.includes('[WALLET]'));
  assert.ok(!text.includes('0x4e48'));
});

test('assertRedacted passes on clean text and throws on raw PII', () => {
  assert.doesNotThrow(() => assertRedacted(redact(SCAM).text));
  assert.throws(() => assertRedacted(SCAM), /unredacted PII/);
});

test('an account number keeps its grouping and is still stripped', () => {
  // Regression. The account rule was `\b\d{8,13}\b` — bare digits only —
  // so `512088776655` was stripped but `5140-2288-9911`, the same number
  // written the way a person actually types one, went to the model intact:
  // too short for the 14-19 digit card rule, and invisible to a rule that
  // could not look past the separators.
  for (const written of ['5140-2288-9911', '5140 2288 9911', '512088776655']) {
    const { text } = redact(`Transfer RM8500 to Maybank ${written} now`);
    assert.ok(
      !text.includes('5140') && !text.includes('2288') && !text.includes('9911') && !text.includes('8877'),
      `account digits survived redaction in "${written}": ${text}`,
    );
    // The amount is the strongest scam signal and identifies nobody, so it
    // must NOT be swept up by the widened rule.
    assert.match(text, /8500/, `the amount was destroyed for "${written}": ${text}`);
  }
});
