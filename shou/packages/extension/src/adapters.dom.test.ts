// Selector regression tests against a real DOM.
//
// WHY THESE EXIST. The DOM layer is the only part of this extension that
// depends on markup we do not control, and it has broken once already: in
// Sep 2026 WhatsApp Web moved to `[data-testid="msg-container"]` and both
// `.message-in` and `[data-id^="false_"]` went to zero matches, so nothing
// was scored and the only symptom was an absence of badges.
//
// The fixtures below are cut down from that live DOM. They are deliberately
// minimal — the class soup is not reproduced, because copying obfuscated
// class names would make these tests assert on noise that changes weekly.
// What they pin is the contract: which elements count as incoming, which
// are skipped, and that each message yields exactly one node.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

import { ADAPTERS, messageDirection } from './adapters.ts';

const whatsapp = ADAPTERS.find((a) => a.site === 'web.whatsapp.com')!;

/** Wraps fixture markup in the conversation panel the adapter looks for. */
function panel(inner: string): { doc: Document; root: Element } {
  const { document } = parseHTML(
    `<html><body><div id="main"><header><span title="Mak"></span></header>${inner}</div></body></html>`,
  );
  // linkedom builds a Document that is structurally compatible with the
  // lib.dom types the adapter is written against.
  const doc = document as unknown as Document;
  return { doc, root: whatsapp.root(doc)! };
}

/** Current markup: a msg-container with no delivery tick is INCOMING. */
const incomingNew = `
  <div data-testid="msg-container">
    <span class="selectable-text">Dinner is at 7pm. Do you need anything from the market?</span>
  </div>`;

/** Current markup: a msg-container with a tick is MINE, and must be skipped. */
const outgoingNew = `
  <div data-testid="msg-container">
    <span class="selectable-text">No need, I bought fish already.</span>
    <span data-icon="msg-check"></span>
  </div>`;

test('new markup: an incoming msg-container is returned', () => {
  const { root } = panel(incomingNew);
  const nodes = whatsapp.incoming(root);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.text, 'Dinner is at 7pm. Do you need anything from the market?');
});

test('new markup: an outgoing msg-container is skipped', () => {
  // Scoring her own words would let her quoting a scammer back raise her
  // own risk tier — punishing exactly the person starting to catch on.
  const { root } = panel(outgoingNew);
  assert.deepEqual(whatsapp.incoming(root), []);
});

test('new markup: every delivery-tick variant marks a message as ours', () => {
  for (const icon of ['msg-check', 'msg-dblcheck', 'msg-time']) {
    const { root } = panel(
      `<div data-testid="msg-container"><span class="selectable-text">mine</span>
       <span data-icon="${icon}"></span></div>`,
    );
    assert.deepEqual(whatsapp.incoming(root), [], `${icon} should mean outgoing`);
  }
});

test('new markup: a mixed conversation returns only the incoming half', () => {
  const { root } = panel(incomingNew + outgoingNew + incomingNew.replace('7pm', '8pm'));
  const nodes = whatsapp.incoming(root);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((n) => !n.text.includes('bought fish')));
});

test('legacy markup: .message-in still works', () => {
  const { root } = panel(
    `<div class="message-in"><span class="selectable-text">Old build, still incoming.</span></div>`,
  );
  const nodes = whatsapp.incoming(root);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.text, 'Old build, still incoming.');
});

test('legacy markup: a false_ data-id is read as incoming', () => {
  const { root } = panel(
    `<div data-id="false_60123456789@c.us_ABC"><span class="selectable-text">From her son.</span></div>`,
  );
  assert.equal(whatsapp.incoming(root).length, 1);
});

test('legacy markup: a true_ data-id is skipped even inside a msg-container', () => {
  // data-id is authoritative when present: it beats the tick heuristic, so
  // an outgoing message with no rendered tick yet is still not scored.
  const { root } = panel(
    `<div data-testid="msg-container" data-id="true_60123456789@c.us_ABC">
       <span class="selectable-text">Something I sent.</span></div>`,
  );
  assert.deepEqual(whatsapp.incoming(root), []);
});

test('a message matching several selectors is returned once', () => {
  // The selector union overlaps on purpose. Without element-identity
  // dedupe this bubble would be scored three times — three model calls and
  // three badges for one sentence.
  const { root } = panel(
    `<div class="message-in" data-testid="msg-container" data-id="false_60123@c.us_XYZ">
       <span class="selectable-text">Counted once.</span></div>`,
  );
  assert.equal(whatsapp.incoming(root).length, 1);
});

test('a container nested inside another candidate is not double-counted', () => {
  const { root } = panel(
    `<div class="message-in">
       <div data-testid="msg-container"><span class="selectable-text">Nested once.</span></div>
     </div>`,
  );
  const nodes = whatsapp.incoming(root);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.text, 'Nested once.');
});

test('only selectable-text is read, not the timestamp or sender name', () => {
  // The bubble's own textContent folds in chrome that is not the message,
  // and a quoted scam line would otherwise be re-scored on every reply.
  const { root } = panel(
    `<div data-testid="msg-container">
       <div class="quoted"><span>Ali</span></div>
       <span class="selectable-text">The actual message.</span>
       <span class="time">10:32</span>
     </div>`,
  );
  const nodes = whatsapp.incoming(root);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.text, 'The actual message.');
});

test('a container with no readable text is skipped', () => {
  // A sticker, a voice note or an image with no caption. Nothing to score,
  // so it must not produce an empty request.
  const { root } = panel(`<div data-testid="msg-container"><img src="x.jpg" /></div>`);
  assert.deepEqual(whatsapp.incoming(root), []);
});

test('root() finds the panel, and threadKey() reads the header', () => {
  const { doc, root } = panel(incomingNew);
  assert.ok(root, 'root must resolve');
  assert.equal(whatsapp.threadKey(doc), 'Mak');
});

test('threadKey() falls back to the chat jid when the header has no title', () => {
  const { document } = parseHTML(
    `<html><body><div id="main"><header></header>
       <div data-testid="msg-container" data-id="false_60123456789@c.us_ABC">
         <span class="selectable-text">hi</span></div>
     </div></body></html>`,
  );
  assert.equal(whatsapp.threadKey(document as unknown as Document), '60123456789@c.us');
});

test('messageDirection reports what the markup actually says', () => {
  const { root } = panel(incomingNew + outgoingNew);
  const all = [...root.querySelectorAll('[data-testid="msg-container"]')] as HTMLElement[];
  assert.equal(messageDirection(all[0]!), null, 'no tick, no data-id -> unknown, treated as incoming');
  assert.equal(messageDirection(all[1]!), 'out');
});

// ─── Messenger ────────────────────────────────────────────────────────
//
// These exist because the README claims the extension reads "WhatsApp Web
// and Messenger", and until now every DOM test above was a WhatsApp
// fixture — Messenger was covered only by pickAdapter() host matching in
// adapters.test.ts, which proves the adapter is SELECTED, not that it can
// read anything. An adapter that returns zero nodes on every real page
// would have passed the whole suite.
//
// The fixtures pin the two decisions the Messenger adapter actually makes:
// "You sent" marks a row as ours, and short rows (date separators, "Seen")
// are not messages.

const messenger = ADAPTERS.find((a) => a.site === 'messenger.com')!;

function mRoot(inner: string): { doc: Document; root: Element } {
  const { document } = parseHTML(
    `<html><body><div role="main"><h1>Danial</h1>${inner}</div></body></html>`,
  );
  const doc = document as unknown as Document;
  return { doc, root: messenger.root(doc)! };
}

test('messenger: an incoming row is returned', () => {
  const { root } = mRoot(
    `<div role="row">Auntie, please transfer the money before 6pm today.</div>`,
  );
  const nodes = messenger.incoming(root);
  assert.equal(nodes.length, 1);
  assert.match(nodes[0]!.text, /transfer the money/);
});

test('messenger: a row labelled "You sent" is skipped as ours', () => {
  const { root } = mRoot(
    `<div role="row" aria-label="You sent: I will check with my son first">I will check with my son first</div>`,
  );
  assert.equal(messenger.incoming(root).length, 0);
});

test('messenger: "You sent" is matched case-insensitively at the start only', () => {
  // A message that merely mentions the phrase mid-sentence is still hers to
  // be protected from, so it must NOT be skipped.
  const { root } = mRoot(
    `<div role="row">Did you see what you sent me yesterday about the fee?</div>`,
  );
  assert.equal(messenger.incoming(root).length, 1);
});

test('messenger: one- and two-word rows (date separators, receipts) are not messages', () => {
  const { root } = mRoot(`<div role="row">Today</div><div role="row">Seen</div>`);
  assert.equal(messenger.incoming(root).length, 0);
});

// KNOWN GAP, pinned rather than hidden. The filter is `< 3 words`, so a
// three-word date separator like "Wed 3 Sep" is still sent for scoring.
// It is not a safety problem — it scores LOW and the badge is meaningless
// rather than wrong — but it costs a model call per separator, and on this
// router that is seconds. Not tightened here because the obvious fix
// (require 4+ words) would drop real scam lines: "send RM5000 now" is three.
// A date-shaped test would be the right fix if Messenger becomes a demo path.
test('messenger: KNOWN GAP — a three-word date separator is still scored', () => {
  const { root } = mRoot(`<div role="row">Wed 3 Sep</div>`);
  assert.equal(
    messenger.incoming(root).length,
    1,
    'if this now returns 0, the gap was fixed — delete this test',
  );
});

test('messenger: a mixed thread returns only the incoming half', () => {
  const { root } = mRoot(
    `<div role="row">Send RM3000 for the customs clearance fee now.</div>
     <div role="row" aria-label="You sent: why do you need it">why do you need it</div>
     <div role="row">Please, do not tell your family about this.</div>`,
  );
  const nodes = messenger.incoming(root);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((n) => !/why do you need it/.test(n.text)));
});

test('messenger: threadKey reads the conversation heading', () => {
  const { doc } = mRoot(`<div role="row">hello there friend</div>`);
  assert.equal(messenger.threadKey(doc), 'Danial');
});

test('messenger: root() is null when no conversation is open', () => {
  const { document } = parseHTML(`<html><body><div id="something-else"></div></body></html>`);
  assert.equal(messenger.root(document as unknown as Document), null);
});

// ─── Telegram Web ─────────────────────────────────────────────────────
//
// Two clients at one origin with no shared markup, so each behaviour is
// pinned twice. /k/ marks its own messages with `is-out` on `.bubble`;
// /a/ marks them with `own` on `.Message`. Both are explicit, which makes
// this adapter less guessy than Messenger's accessible-label heuristic.
//
// As with Messenger, these fixtures are built from the published client
// structure, NOT captured from a live session — they prove the adapter's
// logic, not that the selectors currently match Telegram's production DOM.

const telegram = ADAPTERS.find((a) => a.site === 'web.telegram.org')!;

/** Telegram Web /k/ — the Webogram-lineage client. */
function tgK(inner: string): { doc: Document; root: Element } {
  const { document } = parseHTML(
    `<html><body><div class="chat-info"><span class="peer-title">Danial</span></div>` +
      `<div class="bubbles">${inner}</div></body></html>`,
  );
  const doc = document as unknown as Document;
  return { doc, root: telegram.root(doc)! };
}

/** Telegram Web /a/ — the newer client. */
function tgA(inner: string): { doc: Document; root: Element } {
  const { document } = parseHTML(
    `<html><body><div class="ChatInfo"><h3 class="title">Danial</h3></div>` +
      `<div class="MessageList">${inner}</div></body></html>`,
  );
  const doc = document as unknown as Document;
  return { doc, root: telegram.root(doc)! };
}

test('telegram /k/: an incoming bubble is returned', () => {
  const { root } = tgK(
    `<div class="bubble is-in"><div class="message">Auntie, transfer RM8500 before 6pm.</div></div>`,
  );
  const nodes = telegram.incoming(root);
  assert.equal(nodes.length, 1);
  assert.match(nodes[0]!.text, /RM8500/);
});

test('telegram /k/: an outgoing bubble (is-out) is skipped', () => {
  const { root } = tgK(
    `<div class="bubble is-out"><div class="message">I will ask my son first</div></div>`,
  );
  assert.equal(telegram.incoming(root).length, 0);
});

test('telegram /a/: an incoming Message is returned', () => {
  const { root } = tgA(
    `<div class="Message"><div class="text-content">Do not tell your children about this.</div></div>`,
  );
  const nodes = telegram.incoming(root);
  assert.equal(nodes.length, 1);
  assert.match(nodes[0]!.text, /tell your children/);
});

test('telegram /a/: an own Message is skipped', () => {
  const { root } = tgA(`<div class="Message own"><div class="text-content">ok</div></div>`);
  assert.equal(telegram.incoming(root).length, 0);
});

test('telegram: a mixed thread returns only the incoming half', () => {
  const { root } = tgK(
    `<div class="bubble is-in"><div class="message">Send the customs fee now.</div></div>
     <div class="bubble is-out"><div class="message">how much is it</div></div>
     <div class="bubble is-in"><div class="message">RM3000, and keep it between us.</div></div>`,
  );
  const nodes = telegram.incoming(root);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((n) => !/how much is it/.test(n.text)));
});

test('telegram: service messages and date dividers are not scored', () => {
  const { root } = tgK(
    `<div class="bubble service"><div class="message">Danial joined the group</div></div>
     <div class="bubble is-date"><div class="message">September 3</div></div>`,
  );
  assert.equal(telegram.incoming(root).length, 0);
});

test('telegram: only the message body is read, not the sender or timestamp', () => {
  const { root } = tgK(
    `<div class="bubble is-in">
       <span class="peer-title">Inspector Danial</span>
       <div class="message">Your account is under investigation.</div>
       <span class="time">18:04</span>
     </div>`,
  );
  const [node] = telegram.incoming(root);
  assert.equal(node!.text, 'Your account is under investigation.');
});

test('telegram: threadKey reads the peer title in both clients', () => {
  assert.equal(telegram.threadKey(tgK('<div class="bubble is-in"></div>').doc), 'Danial');
  assert.equal(telegram.threadKey(tgA('<div class="Message"></div>').doc), 'Danial');
});

test('telegram: root() is null when no conversation is open', () => {
  const { document } = parseHTML(`<html><body><div class="sidebar"></div></body></html>`);
  assert.equal(telegram.root(document as unknown as Document), null);
});

test('telegram: a bubble with no text is skipped (sticker, photo, voice note)', () => {
  const { root } = tgK(`<div class="bubble is-in"><div class="media-photo"></div></div>`);
  assert.equal(telegram.incoming(root).length, 0);
});
