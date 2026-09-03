// Tests for the parts of the DOM layer that are not the DOM.
//
// The selectors themselves cannot be unit-tested without shipping a
// snapshot of WhatsApp's obfuscated markup, which would be stale within
// the week and would test the snapshot rather than the code. What IS
// worth testing is the logic layered on top: host matching, message
// identity, and text normalisation — because a bug in any of those
// silently drops messages or re-scores them, and neither failure is
// visible on screen.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { messageKey, normaliseText, parseWhatsAppDataId, pickAdapter } from './adapters.ts';

test('pickAdapter matches the hosts the manifest injects into', () => {
  assert.equal(pickAdapter('web.whatsapp.com')?.site, 'web.whatsapp.com');
  assert.equal(pickAdapter('www.messenger.com')?.site, 'messenger.com');
  assert.equal(pickAdapter('messenger.com')?.site, 'messenger.com');
});

test('pickAdapter does not match a lookalike host', () => {
  // The manifest is the real gate, but a suffix match written as
  // `includes` would happily accept these — and an adapter that runs on
  // an attacker's domain is one that reads a page we have no business
  // reading.
  assert.equal(pickAdapter('web.whatsapp.com.evil.test'), null);
  assert.equal(pickAdapter('notmessenger.com.attacker.test'), null);
  assert.equal(pickAdapter('example.com'), null);
  // The one a plain endsWith() lets through: a different registrable
  // domain that happens to end in our host's name.
  assert.equal(pickAdapter('notmessenger.com'), null);
  assert.equal(pickAdapter('fakeweb.whatsapp.com.co'), null);
});

test('normaliseText collapses the whitespace a re-render introduces', () => {
  // Both sites re-flow bubbles constantly. Without this, the same line
  // re-wrapped is a different dedupe key and gets scored again — a model
  // call per re-render.
  assert.equal(normaliseText('  Send   RM5000\n  now  '), 'Send RM5000 now');
  assert.equal(normaliseText('\t\n '), '');
});

/** Enough of an Element for messageKey; the real one is not available in node. */
function stubElement(own: string | null, ancestor: string | null): HTMLElement {
  return {
    getAttribute: () => own,
    closest: () => (ancestor === null ? null : { getAttribute: () => ancestor }),
  } as unknown as HTMLElement;
}

test('messageKey prefers the site own message id', () => {
  assert.equal(messageKey(stubElement('false_123@c.us_ABC', null), 'hello'), 'id:false_123@c.us_ABC');
});

test('messageKey climbs to an ancestor id when the bubble has none', () => {
  assert.equal(messageKey(stubElement(null, 'true_60123_XYZ'), 'hello'), 'id:true_60123_XYZ');
});

test('messageKey falls back to the text when there is no id at all', () => {
  // Messenger has no stable message id, so this is its normal path, not
  // an edge case — two identical lines are deliberately one key.
  const key = messageKey(stubElement(null, null), 'urgent, transfer now');
  assert.equal(key, 'text:urgent, transfer now');
  assert.equal(key, messageKey(stubElement(null, null), 'urgent, transfer now'));
});

test('parseWhatsAppDataId reads sender and chat out of a real data-id', () => {
  // The durable signal. `false_` means incoming, and the middle segment is
  // the conversation — both readable without any CSS class surviving.
  const incoming = parseWhatsAppDataId('false_60123456789@c.us_3EB0C767D82B1B2A6F1A');
  assert.deepEqual(incoming, { fromMe: false, chatJid: '60123456789@c.us' });

  const outgoing = parseWhatsAppDataId('true_60123456789@c.us_3EB0C767D82B1B2A6F1A');
  assert.equal(outgoing?.fromMe, true);

  // Group chats use a @g.us jid and carry a participant suffix.
  const group = parseWhatsAppDataId('false_60123456789-1234567890@g.us_ABC_60198765432@c.us');
  assert.deepEqual(group, { fromMe: false, chatJid: '60123456789-1234567890@g.us' });
});

test('parseWhatsAppDataId rejects anything that is not one', () => {
  // It must fail closed: a bad parse that returned fromMe:false would make
  // an outgoing message look incoming and score her own words.
  assert.equal(parseWhatsAppDataId(null), null);
  assert.equal(parseWhatsAppDataId(''), null);
  assert.equal(parseWhatsAppDataId('nope'), null);
  assert.equal(parseWhatsAppDataId('false_onlytwo'), null);
  assert.equal(parseWhatsAppDataId('maybe_60123@c.us_ABC'), null);
});
