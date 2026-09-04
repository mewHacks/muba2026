// Runs in the page. Reads new incoming messages, redacts them HERE, and
// hands the redacted text to the service worker.
//
// THE PRIVACY CLAIM STARTS ON THIS LINE. redact() is imported from
// @shou/redact — the same module the enclave runs — and is applied
// before the text is passed to anything, including the extension's own
// service worker. Identifying values do not cross the network because
// they do not survive this file. The enclave redacts again on arrival
// (redaction is idempotent) so that a stale or bypassed copy of this
// extension cannot cause raw PII to be scored.
//
// This script talks to nothing but its own service worker. It holds no
// credentials and knows no URLs, so a compromised page cannot use it to
// reach the circuit breaker or the enclave directly.

import { redact } from '../../redact/src/redact.ts';
import { describeFailure, isScored, markScored, pickAdapter, type SiteAdapter } from './adapters.ts';
import { TIER_EMOJI, TIER_PLAIN, type ScoreRequest, type ScoreResponse } from './shared.ts';

const adapter = pickAdapter(location.host);
if (adapter) void start(adapter);

/**
 * The conversation identifier the backend sees.
 *
 * Hashed, not sent: "Mak" or a phone number is the contact's identity,
 * and the circuit breaker only needs a *stable* key to correlate
 * messages, not a meaningful one. So it gets a hash of the thread title
 * and never learns who she is talking to.
 */
async function sessionIdFor(threadKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${location.host}|${threadKey}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `shou-${hex.slice(0, 24)}`;
}

const BADGE_CLASS = 'shou-badge';

function styleOnce(): void {
  if (document.getElementById('shou-style')) return;
  const style = document.createElement('style');
  style.id = 'shou-style';
  // Scoped to our own class and kept to a handful of properties: a
  // content script that restyles the host page breaks the page it is
  // supposed to be quietly watching.
  style.textContent = `
    .${BADGE_CLASS}{display:inline-flex;align-items:center;gap:4px;margin-left:6px;padding:1px 7px;
      border-radius:999px;font:600 11px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      vertical-align:middle;white-space:nowrap;cursor:help;border:1px solid transparent}
    .${BADGE_CLASS}[data-tier="LOW"]{background:#e8f6ef;color:#0f7b4f;border-color:#c4e5d5}
    .${BADGE_CLASS}[data-tier="MEDIUM"]{background:#fdf3e0;color:#8a5800;border-color:#f0dcb4}
    .${BADGE_CLASS}[data-tier="HIGH"]{background:#fdecea;color:#b3261e;border-color:#f3c9c5}
    .${BADGE_CLASS}[data-tier="PENDING"]{background:#eef1f5;color:#5d6674;border-color:#e3e6ea}
  `;
  (document.head ?? document.documentElement).append(style);
}

function attachBadge(element: HTMLElement): HTMLElement {
  const existing = element.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
  if (existing) return existing;
  const badge = document.createElement('span');
  badge.className = BADGE_CLASS;
  badge.dataset.tier = 'PENDING';
  badge.textContent = '⋯';
  badge.title = 'SHOU is checking this message';
  element.append(badge);
  return badge;
}

/**
 * A checked message that scored clean still gets a badge. An indicator
 * that appears only on danger is indistinguishable from one that is
 * broken, and the point of a passive guard is that she can tell it is
 * watching without having to trust that it is.
 */
function settleBadge(badge: HTMLElement, response: ScoreResponse): void {
  if (!response.ok || !response.verdict) {
    badge.dataset.tier = 'PENDING';
    const isInvalidated =
      response.error?.includes('Extension context invalidated') ||
      response.error?.includes('reconnect');
    if (isInvalidated) {
      badge.textContent = '↻ refresh tab';
      badge.title = 'SHOU extension was reloaded. Click or press Cmd+R (Ctrl+R) to refresh this tab and reconnect safety checking.';
      badge.style.cursor = 'pointer';
      badge.onclick = () => location.reload();
    } else {
      badge.textContent = '⚠︎ not checked';
      badge.title = `SHOU could not check this message: ${response.error ?? 'unknown error'}`;
    }
    return;
  }
  const { tier, category, truthScore } = response.verdict;
  badge.dataset.tier = tier;
  badge.textContent = TIER_EMOJI[tier];
  badge.title =
    `${TIER_PLAIN[tier]}\n\n` +
    `Signal: ${category}` +
    (truthScore === null ? '' : `\nConfidence: ${truthScore}/100`) +
    `\n\nScored inside a secure enclave. The message itself never left this device unredacted.`;
}

const seen = new Set<string>();
/** Cap so a very long session cannot grow this set without bound. */
const MAX_SEEN = 4000;

async function scoreNode(
  sessionId: string,
  site: string,
  node: { element: HTMLElement; text: string; key: string },
): Promise<void> {
  markScored(node.element);
  if (seen.has(node.key)) return;
  if (seen.size > MAX_SEEN) seen.clear();
  seen.add(node.key);

  styleOnce();
  const badge = attachBadge(node.element);

  // Here, before anything else, and before the service worker sees it.
  const { text: redactedText, removed } = redact(node.text);
  const request: ScoreRequest = {
    type: 'shou:score',
    sessionId,
    site,
    redactedText,
    redacted: removed,
  };
  try {
    if (!chrome.runtime?.id) {
      throw new Error('Extension context invalidated. Please refresh this tab to reconnect.');
    }
    const response = (await chrome.runtime.sendMessage(request)) as ScoreResponse | undefined;
    settleBadge(badge, response ?? { ok: false, error: 'no response from SHOU' });
  } catch (error) {
    // Happens when the worker has been reloaded mid-session. Say so on
    // the badge rather than leaving a stale "checking" spinner.
    const msg = error instanceof Error ? error.message : String(error);
    settleBadge(badge, {
      ok: false,
      error: msg.includes('Extension context invalidated')
        ? 'Extension context invalidated. Please refresh this tab to reconnect.'
        : msg,
    });
  }
}

// How long to let a slow single-page app finish booting before believing
// that a missing conversation panel is a real fault.
const SETTLE_MS = 20_000;

async function start(site: SiteAdapter): Promise<void> {
  let sessionId: string | null = null;
  let lastThreadKey: string | null = null;
  // Whether we have EVER found a readable conversation. The diagnostic
  // below is gated on this rather than on the state at start-up: at
  // document_idle WhatsApp Web has not rendered a chat yet — and may not
  // even be logged in — so checking immediately reported a selector
  // failure on every single page load, which is a diagnostic that cries
  // wolf and therefore tells you nothing.
  let everFound = false;

  const sweep = async (): Promise<void> => {
    const root = site.root(document);
    if (!root) return;
    const threadKey = site.threadKey(document);
    if (!threadKey) return;
    everFound = true;
    if (threadKey !== lastThreadKey) {
      lastThreadKey = threadKey;
      sessionId = await sessionIdFor(threadKey);
      // Switching conversations must not carry the previous one's
      // dedupe keys, or the first repeat of a line in the new chat is
      // silently skipped.
      seen.clear();
    }
    for (const node of site.incoming(root)) {
      if (isScored(node.element)) continue;
      void scoreNode(sessionId!, site.site, node);
    }
  };

  await sweep();

  // Now that the page has had time to settle, a still-unreadable
  // conversation is worth reporting — and only once.
  setTimeout(() => {
    if (everFound) return;
    const failure = describeFailure(site, document);
    if (failure) console.warn(failure);
  }, SETTLE_MS);

  // Both sites re-render heavily, so the observer fires constantly.
  // Coalesce into one sweep per animation-frame-ish window: the work per
  // sweep is a querySelectorAll over one panel, and doing that hundreds
  // of times a second is what makes a content script noticeable.
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      void sweep();
    }, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Safety net. The observer catches everything in practice, but this is a
  // single-page app that renders through a virtualised list, and a missed
  // sweep means a message silently never gets scored. A querySelectorAll
  // over one panel every few seconds is cheap insurance against that.
  setInterval(() => void sweep(), 4000);
}
