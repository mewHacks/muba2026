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
