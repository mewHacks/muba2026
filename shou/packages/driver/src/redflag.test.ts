// node --experimental-strip-types src/redflag.test.ts
//
// The deny list decoding, tested away from the chain.
//
// This exists because the live testnet deny list is legitimately empty
// most of the time — nobody has held the OracleCap long enough to report
// anything — so the code that turns a table entry into a row would
// otherwise be exercised for the first time in front of an audience.
// The fixtures below are the shapes `sui::table` actually decodes to,
// both the gRPC snake_case form and the camelCase one other transports
// have returned.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redFlagFromField, tableInfo } from './client.ts';

test('a Table decodes to an id and a size on either transport shape', () => {
  // What testnet gRPC returned for the seeded DenyList, verified live.
  assert.deepEqual(tableInfo({ id: '0xabc', size: '0' }), { id: '0xabc', size: 0 });
  // The nested form other transports use.
  assert.deepEqual(tableInfo({ id: { id: '0xabc' }, size: '3' }), { id: '0xabc', size: 3 });
  assert.deepEqual(tableInfo('0xabc'), { id: '0xabc', size: -1 });
});

test('a missing size is -1, never 0 — "did not say" is not "empty"', () => {
  // Reading it as 0 would turn a node that omitted the field into a
  // confident "no addresses are reported".
  assert.equal(tableInfo({ id: '0xabc' })?.size, -1);
});

test('an unreadable table is null rather than a guess', () => {
  assert.equal(tableInfo(null), null);
  assert.equal(tableInfo(undefined), null);
  assert.equal(tableInfo({}), null);
  assert.equal(tableInfo({ id: 42 }), null);
  assert.equal(tableInfo({ id: { nope: '0xabc' } }), null);
});

const counts = new Map([['0x' + 'c1'.repeat(32), 3]]);

test('a snake_case BanEntry decodes to a row', () => {
  const address = '0x' + 'c1'.repeat(32);
  const row = redFlagFromField(
    {
      name: address,
      value: { plausibility_score: 92, reported_at_ms: '1788400000000', ban_ceiling: '50000000' },
    },
    counts,
  );
  assert.deepEqual(row, {
    address,
    plausibilityScore: 92,
    banCeiling: '50000000',
    reportedAtMs: 1788400000000,
    reportCount: 3,
  });
});

test('camelCase decodes identically', () => {
  const address = '0x' + 'a2'.repeat(32);
  const row = redFlagFromField(
    {
      name: address,
      value: { plausibilityScore: 71, reportedAtMs: 1788400000000, banCeiling: '0' },
    },
    counts,
  );
  assert.equal(row?.plausibilityScore, 71);
  assert.equal(row?.banCeiling, '0');
  assert.equal(row?.reportedAtMs, 1788400000000);
});

test('the ban ceiling stays a string', () => {
  // u64::MAX does not survive a JS number, and 0 is meaningful (block
  // everything) — so it is never coerced.
  const row = redFlagFromField(
    { name: '0x1', value: { ban_ceiling: '18446744073709551615' } },
    new Map(),
  );
  assert.equal(row?.banCeiling, '18446744073709551615');
  assert.equal(typeof row?.banCeiling, 'string');
});

test('an entry with no corroborating events still counts as one report', () => {
  // The entry exists in the table, so it was reported. A zero here would
  // read as "reported by nobody", which is not a state that can occur.
  const row = redFlagFromField({ name: '0x9', value: {} }, new Map());
  assert.equal(row?.reportCount, 1);
  assert.equal(row?.plausibilityScore, 0);
  assert.equal(row?.banCeiling, '0');
});

test('a field with no address is skipped rather than rendered blank', () => {
  assert.equal(redFlagFromField(undefined, new Map()), null);
  assert.equal(redFlagFromField({ value: { ban_ceiling: '1' } }, new Map()), null);
  assert.equal(redFlagFromField({ name: 42 as unknown as string }, new Map()), null);
});

test('report counts are matched case-insensitively', () => {
  const row = redFlagFromField(
    { name: '0x' + 'C1'.repeat(32), value: {} },
    new Map([['0x' + 'c1'.repeat(32), 5]]),
  );
  assert.equal(row?.reportCount, 5);
});
