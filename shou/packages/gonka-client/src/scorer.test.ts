// Tests for the scoring arithmetic and the escalate-only gate.
//
// These are the parts that decide whether money moves, and they are pure —
// no network, no router, no key. The model CALLS cannot be unit-tested
// without mocking Gonka into something that no longer resembles it; what is
// testable, and what actually breaks in review, is the fusion: a model that
// times out must not score as zero, a hard floor must not be talkable down,
// and an inference outage must hold a suspicious transfer rather than clear
// it while still leaving ordinary traffic alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fuseScores, indicators } from './scorer.ts';

const base = { classifierScore: null, verifierScore: null, indicatorScore: 0, floor: 0 };

test('a model that failed drops out instead of scoring zero', () => {
  // The original scaffold's bug: a timeout counted as 0 and dragged a real
  // scam under the MEDIUM line. Classifier 90 with the verifier absent must
  // stay HIGH, not be averaged against an imaginary zero.
  const withVerifierAbsent = fuseScores({ ...base, classifierScore: 90, indicatorScore: 45 });
  assert.equal(withVerifierAbsent.tier, 'HIGH');

  // Same two present values, but a third "model" contributing 0 — this is
  // what dragging toward zero looks like, and it must NOT be what happens.
  const withPhantomZero = fuseScores({ ...base, classifierScore: 90, verifierScore: 0, indicatorScore: 45 });
  assert.ok(
    withVerifierAbsent.truthScore > withPhantomZero.truthScore,
    'an absent model must score higher than one that answered zero',
  );
});

test('a hard floor cannot be talked down by a low model score', () => {
  // A credential request floors at 85. A model insisting it is harmless
  // must not be able to clear it — this is the "verdict is a floor" claim
  // at the arithmetic level.
  const result = fuseScores({
    ...base,
    classifierScore: 0,
    verifierScore: 0,
    indicatorScore: 40,
    floor: 85,
  });
  assert.equal(result.truthScore, 85);
  assert.equal(result.tier, 'HIGH');
});

test('with no model available, a suspicious message is held rather than cleared', () => {
  // Indicators alone land above the degraded threshold of 15, so the score
  // is raised to exactly the MEDIUM line. An inference outage must not
  // silently wave a transfer through.
  const result = fuseScores({ ...base, indicatorScore: 20 });
  assert.equal(result.anyModelScored, false);
  assert.equal(result.heldForReview, true);
  assert.equal(result.truthScore, 40);
  assert.equal(result.tier, 'MEDIUM');
});

test('with no model available, clean traffic still scores LOW', () => {
  // The other half of the same rule: the degraded floor must not turn every
  // message into a review during an outage, or the wallet is unusable.
  const result = fuseScores({ ...base, indicatorScore: 8 });
  assert.equal(result.heldForReview, false);
  assert.equal(result.tier, 'LOW');
});

// ── the deterministic lexicons ──────────────────────────────────────
// These carry the whole verdict whenever the router is slow or down, which
// on this router is often. A gap here is invisible until it matters, so the
// scripts that actually circulate get pinned as tests.

test('a Bukit Aman Macau scam reaches HIGH on rules alone', () => {
  // The exact shape shou/verify.sh caught scoring MEDIUM: authority was not
  // recognised, so the authority+urgency floor never fired.
  const r = indicators(
    'madam wong, this is inspector danial from bukit aman. your account [ACCOUNT] is ' +
      'linked to money laundering. transfer rm8500 within the hour to avoid arrest. ' +
      'do not tell your children. call [PHONE].',
  );
  assert.ok(r.patterns.includes('authority-impersonation'), 'authority must fire');
  assert.ok(r.patterns.includes('urgency'), 'urgency must fire');
  assert.ok(r.patterns.includes('secrecy'), 'secrecy must fire');
  // authority + urgency + secrecy is the classic signature, floored at 80.
  assert.equal(r.hardFloor, 'authority+urgency+secrecy');
  assert.equal(r.floor, 80);
});

test('the authority lexicon knows the agencies these scripts actually use', () => {
  for (const line of [
    'call from bukit aman regarding your case',
    'this is the ccid commercial crime division',
    'inspector rahman speaking',
    'your account is involved in money laundering',
    'sprm investigation officer here',
    'notice from lhdn',
  ]) {
    assert.ok(
      indicators(line).patterns.includes('authority-impersonation'),
      `authority should fire on: ${line}`,
    );
  }
});

test('ordinary messages do not trip the authority rule', () => {
  // The other half: a lexicon wide enough to catch every scam and nothing
  // else is the only useful one. These must stay clean.
  for (const line of [
    'dinner is at 7pm, do you need anything from the market?',
    'the courier says the parcel arrives tomorrow morning',
    'i paid the electricity bill already, rm120',
    'can you send me the photos from the wedding',
  ]) {
    const r = indicators(line);
    assert.ok(!r.patterns.includes('authority-impersonation'), `should be clean: ${line}`);
    assert.equal(r.hardFloor, null, `no hard floor for: ${line}`);
  }
});

test('silence from the keyword layer does not dilute a real model verdict', () => {
  // The Mathias case, measured live: both models called it an advance-fee
  // scam (80 and 70) but the keyword layer matched nothing, and counting
  // that 0 as a vote pulled the result to 56 — MEDIUM. Absence of keywords
  // is absence of evidence, so it must drop out rather than vote "safe".
  const r = fuseScores({
    classifierScore: 80,
    verifierScore: 70,
    indicatorScore: 0,
    floor: 0,
  });
  assert.equal(r.tier, 'HIGH');
  assert.ok(r.truthScore >= 70, `expected >=70, got ${r.truthScore}`);
});

test('the keyword layer still counts when it actually fires', () => {
  // The other direction: a firing indicator score is real evidence and must
  // keep its weight, or the deterministic layer stops mattering at all.
  const quiet = fuseScores({ classifierScore: 80, verifierScore: 70, indicatorScore: 0, floor: 0 });
  const loud = fuseScores({ classifierScore: 80, verifierScore: 70, indicatorScore: 100, floor: 0 });
  assert.ok(loud.truthScore > quiet.truthScore, 'a firing indicator must raise the score');
});

test('with nothing at all, the score is zero rather than a division by zero', () => {
  const r = fuseScores({ classifierScore: null, verifierScore: null, indicatorScore: 0, floor: 0 });
  assert.equal(r.truthScore, 0);
  assert.equal(r.tier, 'LOW');
  assert.equal(r.anyModelScored, false);
});

test('a stranger who introduces himself then asks for money reaches HIGH on rules alone', () => {
  // The advance-fee / romance-scam opening. It carries none of the classic
  // pressure markers — no urgency, no authority, no secrecy — which is why
  // it defeated every other lexicon and needed its own rule.
  const r = indicators(
    'hello madam, my name is mathias, a young cameroonian entrepreneur in the field of new ' +
      'technologies, and i am writing to you because i am launching a mobile app called ' +
      'easybuss, and i need $8000 to get started. i would appreciate your help with this, please.',
  );
  assert.ok(r.patterns.includes('stranger-introduction'), 'stranger introduction must fire');
  assert.ok(r.patterns.includes('money-request'), 'money request must fire');
  assert.equal(r.hardFloor, 'stranger+money-request');
  assert.equal(r.floor, 70);
});

test('family asking for money is not a stranger solicitation', () => {
  // The false positive that would make the wallet unusable. SHOU is a
  // guardrail, not a cage: her son asking for textbook money must pass.
  for (const line of [
    'ma, can you bank in rm200 for my textbooks? i will pay you back next month',
    'mummy i need to pay the deposit today, can help or not',
    'can you send me the photos from the wedding',
    'dinner is at 7pm. do you need anything from the market?',
  ]) {
    const r = indicators(line);
    assert.notEqual(r.hardFloor, 'stranger+money-request', `should not fire on: ${line}`);
  }
});

