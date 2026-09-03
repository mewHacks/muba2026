// Reading the conversation off the page.
//
// THIS IS THE DEMO PATH, AND IT IS NOT ToS-COMPLIANT. Automated access
// to the WhatsApp consumer client is prohibited by its Terms of Service.
// That is fine for a self-hosted demo on our own accounts and is not a
// viable production integration; the compliant source is the WhatsApp
// Business API, with this same detection logic behind it. Said plainly
// here as well as in the README so nobody reads this file and assumes
// otherwise.
//
// WHY AN ADAPTER LAYER AT ALL. Both these sites ship obfuscated,
// frequently-changing class names, so selectors rot — usually the week
// of a demo. Isolating them in one table means a break is a five-line
// fix in a known place rather than an archaeology session, and
// `describeFailure` below exists so the console tells you which half
// broke: no conversation found, or a conversation with no readable
// messages.

export interface MessageNode {
  element: HTMLElement;
  text: string;
  /** Stable per bubble, so a re-render does not re-score the same line. */
  key: string;
}

export interface SiteAdapter {
  site: string;
  /** The subtree worth observing — narrower than document, for cost. */
  root(doc: Document): Element | null;
  /**
   * Identifies the open conversation. Hashed before it is ever sent, so
   * the backend correlates messages without learning who she talks to.
   */
  threadKey(doc: Document): string | null;
  incoming(root: Element): MessageNode[];
}

/** Collapse whitespace so a re-flowed bubble is not a "new" message. */
export function normaliseText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Prefer the site's own message id; fall back to the text itself.
 *
 * The fallback deliberately keys on content, which means a scammer who
 * sends the identical line twice is scored once. That is the right trade:
 * the verdict is already at its worst tier and the enclave keeps the
 * worst verdict in the window anyway, so re-scoring buys nothing and
 * costs a model call per duplicate.
 */
export function messageKey(element: HTMLElement, text: string): string {
  const own =
    element.getAttribute('data-id') ??
    element.closest('[data-id]')?.getAttribute('data-id') ??
    null;
  return own ? `id:${own}` : `text:${text}`;
}

const SCORED_ATTR = 'data-shou-scored';

export const isScored = (element: HTMLElement): boolean => element.hasAttribute(SCORED_ATTR);
export const markScored = (element: HTMLElement): void =>
  element.setAttribute(SCORED_ATTR, '1');

/**
 * WhatsApp's own message id, which is far more durable than any CSS class.
 *
 * Format: `<fromMe>_<chatJid>_<messageId>` — e.g.
 * `false_60123456789@c.us_3EB0C767D82B1B2A6F1A`. Two things fall out of it
 * that the obfuscated markup cannot give us:
 *
 *   - `fromMe` is literally the string `true`/`false`, so incoming vs
 *     outgoing is readable without depending on `.message-in` existing.
 *   - `chatJid` identifies the conversation, so it works as a thread key
 *     even when the header has not rendered. It is hashed before it ever
 *     leaves the device, so the backend still never learns the number.
 */
export function parseWhatsAppDataId(
  dataId: string | null | undefined,
): { fromMe: boolean; chatJid: string } | null {
  if (!dataId) return null;
  const parts = dataId.split('_');
  if (parts.length < 3) return null;
  const [fromMe, chatJid] = parts;
  if (fromMe !== 'true' && fromMe !== 'false') return null;
  if (!chatJid) return null;
  return { fromMe: fromMe === 'true', chatJid };
}

/** First element matching any selector in the list, in priority order. */
function firstMatch(doc: Document | Element, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const found = doc.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/**
 * Delivery-status ticks. WhatsApp renders these on YOUR OWN messages only —
 * a sent/delivered/read tick or the pending clock — so their presence is a
 * reliable "this is outgoing" signal in markup that otherwise carries no
 * direction at all.
 *
 * Confirmed against the live DOM (Sep 2026): an outgoing bubble contains
 * exactly one of these, an incoming bubble contains none.
 */
const OUTGOING_ICONS = '[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-time"]';

/**
 * Which way a message went, or `null` when the markup will not say.
 *
 * Order matters. `data-id` is authoritative when present — it is WhatsApp's
 * own record of the message and states the direction outright — and the tick
 * icons are the fallback for the current markup, which has no `data-id` on
 * the container at all.
 */
export function messageDirection(element: HTMLElement): 'in' | 'out' | null {
  const parsed = parseWhatsAppDataId(
    element.getAttribute('data-id') ?? element.closest('[data-id]')?.getAttribute('data-id'),
  );
  if (parsed) return parsed.fromMe ? 'out' : 'in';
  return element.querySelector(OUTGOING_ICONS) ? 'out' : null;
}

/**
 * WhatsApp Web.
 *
 * Every lookup is a fallback CHAIN, newest-confirmed first, because this
 * markup is obfuscated and rebuilt often. As of Sep 2026 the live DOM has
 * moved on from the older selectors entirely:
 *
 *   #main [data-testid="msg-container"]   35 matches — the current shape
 *   div.message-in                         0 matches — gone
 *   [data-id^="false_"]                    0 matches — gone from containers
 *
 * The old two are kept anyway. They cost one querySelectorAll each, they
 * are what a slightly older WhatsApp build still serves, and the direction
 * they encode is *better* than the tick heuristic when it is there.
 *
 * Only incoming messages are scored. Scoring her own words would let her
 * quoting a scammer back — "they want RM5000 by 6pm?" — raise her own risk
 * tier, which punishes exactly the person starting to catch on.
 */
const whatsapp: SiteAdapter = {
  site: 'web.whatsapp.com',
  root: (doc) => {
    const panel = firstMatch(doc, [
      '#main',
      '[data-testid="conversation-panel-messages"]',
      'div[role="application"]',
    ]);
    if (panel) return panel;
    // Last resort: if message containers exist anywhere, work from the body
    // rather than refusing to read a page that plainly has messages on it.
    return doc.querySelector('[data-testid="msg-container"], [data-id]') ? doc.body : null;
  },
  threadKey: (doc) => {
    const header = firstMatch(doc, ['#main header', '[data-testid="conversation-info-header"]']);
    const titled = header?.querySelector('[title]')?.getAttribute('title')?.trim();
    if (titled) return titled;

    // The chat jid from any bubble that still carries one. More stable than
    // the header, and it changes when she switches chats, which is the only
    // property a thread key actually needs.
    const root = doc.querySelector('#main') ?? doc;
    for (const el of root.querySelectorAll('[data-id]')) {
      const parsed = parseWhatsAppDataId(el.getAttribute('data-id'));
      if (parsed) return parsed.chatJid;
    }

    const headerText = normaliseText(header?.textContent ?? '');
    return headerText || null;
  },
  incoming: (root) => {
    // Union of the current selector and the two legacy ones. A Set keys on
    // element identity, so a bubble matching several is one candidate.
    const candidates = new Set<HTMLElement>([
      ...root.querySelectorAll<HTMLElement>('[data-testid="msg-container"]'),
      ...root.querySelectorAll<HTMLElement>('div.message-in'),
      ...root.querySelectorAll<HTMLElement>('[data-id^="false_"]'),
    ]);

    // Drop any candidate nested inside another. The selectors overlap by
    // design, so a row and the container inside it can both match — and
    // scoring both would send the same sentence to the model twice.
    const outermost = [...candidates].filter(
      (el) => ![...candidates].some((other) => other !== el && other.contains(el)),
    );

    const nodes: MessageNode[] = [];
    const seenKeys = new Set<string>();

    for (const bubble of outermost) {
      if (isScored(bubble)) continue;
      // `null` means the markup would not say, which for a msg-container
      // without ticks is exactly the incoming case.
      if (messageDirection(bubble) === 'out') continue;

      // Only `.selectable-text`. Falling back to the bubble's own text would
      // fold in the timestamp, the sender name and any quoted message above
      // it — and a quoted scam line would then be scored again every time it
      // is replied to.
      const spans = bubble.querySelectorAll<HTMLElement>('span.selectable-text');
      if (!spans.length) continue;
      const text = normaliseText(
        Array.from(spans, (s) => s.innerText ?? s.textContent ?? '').join(' '),
      );
      if (!text) continue;

      const key = messageKey(bubble, text);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      nodes.push({ element: bubble, text, key });
    }
    return nodes;
  },
};

/**
 * Messenger.
 *
 * Best-effort, and the more fragile of the two: Messenger's markup is
 * fully obfuscated, with no stable equivalent of `message-in`. Incoming
 * is inferred from the row's accessible label, since Messenger labels
 * her own messages "You sent". When that label is absent we score the
 * row anyway — a missed incoming message is a protection gap, while a
 * wrongly-scored outgoing one can only ever hold money still.
 */
const messenger: SiteAdapter = {
  site: 'messenger.com',
  root: (doc) => doc.querySelector('[role="main"]'),
  threadKey: (doc) => {
    const heading = doc.querySelector('[role="main"] h1, [role="main"] [role="heading"]');
    return normaliseText(heading?.textContent ?? '') || null;
  },
  incoming: (root) => {
    const nodes: MessageNode[] = [];
    for (const row of root.querySelectorAll<HTMLElement>('[role="row"]')) {
      if (isScored(row)) continue;
      const label = row.getAttribute('aria-label') ?? row.textContent ?? '';
      if (/^\s*you sent\b/i.test(label)) continue;
      const text = normaliseText(row.innerText ?? row.textContent ?? '');
      // Rows also carry date separators and "seen by" notices. A single
      // word is never a scam script, and skipping it saves a model call.
      if (!text || text.split(' ').length < 3) continue;
      nodes.push({ element: row, text, key: messageKey(row, text) });
    }
    return nodes;
  },
};

export const ADAPTERS: SiteAdapter[] = [whatsapp, messenger];

/**
 * Exact host, or a subdomain of it — `www.messenger.com` matches
 * `messenger.com`, and `web.whatsapp.com` matches itself.
 *
 * The leading dot is load-bearing. A bare `host.endsWith(site)` also
 * accepts `notmessenger.com`, which is somebody else's domain entirely.
 * The manifest's match patterns are the real gate, but an adapter that
 * will read any page whose name merely ends the right way is the wrong
 * thing to have behind that gate.
 */
export function pickAdapter(host: string): SiteAdapter | null {
  return (
    ADAPTERS.find((adapter) => host === adapter.site || host.endsWith(`.${adapter.site}`)) ?? null
  );
}

/**
 * A demo failing silently is worse than one failing loudly, so name which
 * half of the read broke rather than showing a green badge on an
 * unreadable page.
 */
export function describeFailure(adapter: SiteAdapter, doc: Document): string | null {
  const root = adapter.root(doc);
  if (!root) return `SHOU: no open conversation found on ${adapter.site} — selectors may have changed (see src/adapters.ts)`;
  if (!adapter.threadKey(doc)) return `SHOU: found the conversation panel but not its title on ${adapter.site} — see src/adapters.ts`;
  return null;
}
