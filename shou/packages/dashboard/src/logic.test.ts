// node --experimental-strip-types src/logic.test.ts
//
// The functions under test are the ones that can be wrong about money:
// decimal conversion in both directions, the contract's escalation rule
// mirrored in TypeScript, and the setup form's guards against a policy
// that would lock an elder out of her own funds.
//
// The escalation cases below are deliberately the same boundaries as
// move/tests/policy_tests.move. This file is a mirror of Move logic, and
// a mirror that is never compared against the original drifts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  amountTier,
  banBlocksAmount,
  coinInfo,
  coinLabel,
  consequence,
  describeDuration,
  describePolicy,
  formatAmount,
  holdReason,
  normalizeAddress,
  parseAmount,
  sortRequests,
  stateLabel,
  validatePolicyForm,
} from './logic.ts';
import type { TransferRequestView } from '../../driver/src/types.ts';

const USDC = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const SUI = '0x2::sui::SUI';

// ---- decimals ----

test('USDC is 6 decimals and SUI is 9', () => {
  assert.deepEqual(coinInfo(USDC), { symbol: 'USDC', decimals: 6 });
  assert.deepEqual(coinInfo(SUI), { symbol: 'SUI', decimals: 9 });
  // Fully-qualified SUI, the form on-chain reads come back in.
  assert.deepEqual(
    coinInfo('0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'),
    { symbol: 'SUI', decimals: 9 },
  );
});

test('an unknown coin is not guessed at', () => {
  const weird = '0xabc::wusd::WUSD';
  assert.equal(coinInfo(weird), null);
  assert.equal(coinLabel(weird), 'WUSD');
  // Base units, flagged as raw — never a plausible wrong number.
  assert.deepEqual(formatAmount('1234567', weird), {
    value: '1,234,567',
    unit: 'WUSD',
    raw: true,
  });
});

test('the same base units read differently per coin — the $5 / $5,000 trap', () => {
  assert.equal(formatAmount('5000000', USDC).value, '5.00');
  assert.equal(formatAmount('5000000', SUI).value, '0.00');
  assert.equal(formatAmount('5000000000', SUI).value, '5.00');
  assert.equal(formatAmount('8500000000', USDC).value, '8,500.00');
});

test('formatAmount truncates rather than rounding up to a ceiling', () => {
  // 4.999999 must not read as 5.00 next to a 5.00 approval ceiling.
  assert.equal(formatAmount('4999999', USDC).value, '4.99');
  assert.equal(formatAmount('0', USDC).value, '0.00');
  assert.equal(formatAmount('', USDC).value, '0.00');
});

test('parseAmount is the exact inverse for the coin it is given', () => {
  assert.equal(parseAmount('5', USDC), 5_000_000n);
  assert.equal(parseAmount('5.50', USDC), 5_500_000n);
  assert.equal(parseAmount('0.000001', USDC), 1n);
  assert.equal(parseAmount('1,250', USDC), 1_250_000_000n);
  assert.equal(parseAmount('5', SUI), 5_000_000_000n);
});

test('parseAmount rejects rather than silently truncating precision', () => {
  // Seven places into a six-place coin is a typo, and rounding it would
  // set a limit the person did not ask for.
  const tooPrecise = parseAmount('5.0000001', USDC);
  assert.ok(typeof tooPrecise === 'object' && tooPrecise.error.includes('6 decimal places'));
  assert.ok(typeof parseAmount('', USDC) === 'object');
  assert.ok(typeof parseAmount('-5', USDC) === 'object');
  assert.ok(typeof parseAmount('abc', USDC) === 'object');
  assert.ok(typeof parseAmount('5', '0xabc::wusd::WUSD') === 'object');
});

// ---- addresses ----

test('short addresses normalise to the padded form the chain returns', () => {
  assert.equal(normalizeAddress('0x2'), '0x' + '0'.repeat(63) + '2');
  assert.equal(normalizeAddress('0xABC'), '0x' + '0'.repeat(61) + 'abc');
  assert.equal(normalizeAddress('  0x2  '), '0x' + '0'.repeat(63) + '2');
  assert.equal(normalizeAddress('2'), null);
  assert.equal(normalizeAddress('0x'), null);
  assert.equal(normalizeAddress('0xzz'), null);
  assert.equal(normalizeAddress('0x' + 'a'.repeat(65)), null);
});

// ---- the contract's escalation rule ----

test('amountTier mirrors shou::policy::amount_tier at its boundaries', () => {
  const review = 1_000_000n; // $1
  const high = 5_000_000n; // $5
  assert.equal(amountTier(999_999n, review, high), 'LOW');
  assert.equal(amountTier(1_000_000n, review, high), 'MEDIUM'); // >=, not >
  assert.equal(amountTier(4_999_999n, review, high), 'MEDIUM');
  assert.equal(amountTier(5_000_000n, review, high), 'HIGH'); // >=, not >
  assert.equal(amountTier(8_500_000_000n, review, high), 'HIGH');
});

test('holdReason separates her own limits from the model', () => {
  const review = 1_000_000n;
  const high = 5_000_000n;
  // $2 held at HIGH: the amount alone only reaches MEDIUM, so the score
  // is what raised it.
  assert.equal(holdReason('HIGH', 2_000_000n, review, high), 'MODEL');
  // $50 held at HIGH: her ceiling reaches HIGH by itself. The hold stands
  // whatever the model said, including if it said nothing.
  assert.equal(holdReason('HIGH', 50_000_000n, review, high), 'AMOUNT');
  // $2 held at MEDIUM: her review ceiling did that.
  assert.equal(holdReason('MEDIUM', 2_000_000n, review, high), 'AMOUNT');
  // 50c held at MEDIUM: only a score could have raised it.
  assert.equal(holdReason('MEDIUM', 500_000n, review, high), 'MODEL');
  assert.equal(holdReason('LOW', 500_000n, review, high), 'NONE');
});

// ---- deny list ----

test('a soft ban lets the ceiling amount itself through', () => {
  const ceiling = 50_000_000n; // $50
  assert.equal(banBlocksAmount(ceiling, 49_000_000n), false);
  assert.equal(banBlocksAmount(ceiling, 50_000_000n), false); // strictly greater than
  assert.equal(banBlocksAmount(ceiling, 50_000_001n), true);
  // 0 = block everything, per the BanEntry comment.
  assert.equal(banBlocksAmount(0n, 1n), true);
  assert.equal(banBlocksAmount(0n, 0n), false);
});

// ---- ordering ----

const request = (over: Partial<TransferRequestView>): TransferRequestView => ({
  requestId: '0x1',
  policyId: '0xp',
  recipient: '0xr',
  amount: '1000000',
  claimedTier: null,
  truthScore: null,
  requestedAtMs: 1000,
  requestedBy: '0xo',
  status: 'PENDING',
  approvals: [],
  tier: 'LOW',
  unlockAtMs: 0,
  ...over,
});

test('whatever is waiting on him sorts first, newest within a band', () => {
  const rows = sortRequests([
    request({ requestId: 'a', status: 'EXECUTED' }),
    request({ requestId: 'b', status: 'PENDING' }),
    request({ requestId: 'c', status: 'NEEDS_APPROVAL', requestedAtMs: 100 }),
    request({ requestId: 'd', status: 'AUTO_UNLOCK_SCHEDULED' }),
    request({ requestId: 'e', status: 'NEEDS_APPROVAL', requestedAtMs: 900 }),
  ]);
  assert.deepEqual(rows.map((r) => r.requestId), ['e', 'c', 'd', 'b', 'a']);
});

test('a stopped transfer and a sent one never share a label', () => {
  // They share a band, and "Finished" over both is the single worst word
  // that could appear on this screen: one is money that reached a
  // stranger, the other is money that came back.
  assert.equal(stateLabel('BLOCKED'), 'Stopped — refunded');
  assert.equal(stateLabel('EXECUTED'), 'Sent');
  assert.notEqual(stateLabel('BLOCKED'), stateLabel('EXECUTED'));
  assert.equal(stateLabel('NEEDS_APPROVAL'), 'Waiting for you');
  assert.equal(stateLabel('AUTO_UNLOCK_SCHEDULED'), 'On hold');
  assert.equal(stateLabel('PENDING'), 'Cleared');
});

test('the consequence line counts approvals against the policy threshold', () => {
  const text = consequence(
    request({ status: 'NEEDS_APPROVAL', approvals: ['0xg'] }),
    2,
  );
  assert.match(text, /1 of 2 approvals/);
  assert.match(text, /1 more will release it/);
  // It must never imply that ignoring it sends the money.
  assert.match(text, /not sent, not lost/);
});

// ---- setup form ----

const form = (over: Partial<Parameters<typeof validatePolicyForm>[0]> = {}) => ({
  guardians: ['0x' + 'a'.repeat(64)],
  threshold: '1',
  reviewCeiling: '100',
  highRiskCeiling: '500',
  cooldownMinutes: '120',
  denyListId: '0x' + 'd'.repeat(64),
  coinType: USDC,
  ...over,
});

test('a valid form produces exactly the arguments create_policy takes', () => {
  const { errors, call } = validatePolicyForm(form());
  assert.deepEqual(errors, {});
  assert.deepEqual(call, {
    approvers: ['0x' + 'a'.repeat(64)],
    threshold: 1,
    cooldownMs: 7_200_000,
    denyListId: '0x' + 'd'.repeat(64),
    reviewCeiling: '100000000', // $100 at 6 decimals
    highRiskCeiling: '500000000',
  });
});

test('the same form in SUI converts at 9 decimals, not 6', () => {
  const { call } = validatePolicyForm(form({ coinType: SUI }));
  assert.equal(call?.reviewCeiling, '100000000000');
  assert.equal(call?.highRiskCeiling, '500000000000');
});

test('every abort in new_policy is caught before anyone pays gas', () => {
  // ETooFewApprovers
  assert.ok(validatePolicyForm(form({ guardians: [] })).errors.guardians);
  // EThresholdTooLow
  assert.ok(validatePolicyForm(form({ threshold: '0' })).errors.threshold);
  // EThresholdTooHigh — and the message says what it costs her.
  const tooHigh = validatePolicyForm(form({ threshold: '3' })).errors.threshold;
  assert.match(tooHigh!, /can never be reached/);
  // ECeilingsInverted
  assert.ok(
    validatePolicyForm(form({ reviewCeiling: '500', highRiskCeiling: '100' })).errors
      .highRiskCeiling,
  );
  // Equal ceilings are legal on-chain (review_ceiling <= high_risk_ceiling).
  assert.deepEqual(
    validatePolicyForm(form({ reviewCeiling: '500', highRiskCeiling: '500' })).errors,
    {},
  );
});

test('a duplicate guardian is refused — two entries are not two people', () => {
  const dupe = '0x' + 'a'.repeat(64);
  const { errors } = validatePolicyForm(form({ guardians: [dupe, dupe], threshold: '2' }));
  assert.match(errors.guardians!, /listed twice/);
});

test('a short guardian address is accepted and normalised', () => {
  const { errors, call } = validatePolicyForm(form({ guardians: ['0x2'] }));
  assert.deepEqual(errors, {});
  assert.deepEqual(call?.approvers, ['0x' + '0'.repeat(63) + '2']);
});

test('bad addresses and impossible waits are refused', () => {
  assert.ok(validatePolicyForm(form({ guardians: ['not-an-address'] })).errors.guardians);
  assert.ok(validatePolicyForm(form({ denyListId: 'nope' })).errors.denyListId);
  assert.ok(validatePolicyForm(form({ cooldownMinutes: '0' })).errors.cooldownMinutes);
  assert.ok(validatePolicyForm(form({ cooldownMinutes: '999999' })).errors.cooldownMinutes);
});

test('the summary is in her words, with the right currency and no jargon', () => {
  const { call } = validatePolicyForm(form());
  const lines = describePolicy(call!, USDC).join('\n');
  assert.match(lines, /100\.00 USDC/);
  assert.match(lines, /500\.00 USDC/);
  assert.match(lines, /waits 2 hours/);
  assert.match(lines, /1 of her 1 guardian say/);
  // The guarantee that makes the arrangement safe to accept.
  assert.match(lines, /no way for a guardian to send it anywhere else/);
  assert.doesNotMatch(lines, /tier|ceiling|threshold|LOW|MEDIUM|HIGH/);
});

test('durations read as a person would say them', () => {
  assert.equal(describeDuration(1), '1 minute');
  assert.equal(describeDuration(2), '2 minutes');
  assert.equal(describeDuration(120), '2 hours');
  assert.equal(describeDuration(90), '1.5 hours');
  assert.equal(describeDuration(1440), '1 day');
  assert.equal(describeDuration(4320), '3 days');
});
