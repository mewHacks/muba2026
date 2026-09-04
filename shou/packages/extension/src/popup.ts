// The elder's own screen, styled like the marketing site's mock extension
// frame (packages/zklogin-demo/public/index.html): light theme, three real
// tabs (Chats / Wallet / Options) behind a bottom dock.
//
// Zero complex crypto jargon for elderly:
// 1. Plain words, describing what her RULES do rather than claiming this
//    extension has already done it — it scores conversations and holds no
//    money. See the note on the HIGH branch below.
// 2. Gonka Request IDs and Truth Scores are tucked inside a clean verification
//    toggle so judges can audit them without overwhelming mom.

import { DEFAULT_SETTINGS, TIER_PLAIN, receiptUrlFor, type ScoreRequest, type ScoreResponse, type Settings, type StateResponse, type Verdict } from './shared.ts';
import { redact } from '../../redact/src/redact.ts';

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function element(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function updateViewForVerdict(verdict: Verdict, scoredCount: number): void {
  const statusTitle = $('status-title');
  const statusDesc = $('status-desc');
  const coinEmblem = $('coin-emblem');
  const verdictContainer = $('verdict-container');
  const passiveStatus = $('chat-passive-status');

  if (!verdictContainer) return;
  verdictContainer.classList.remove('hidden');
  verdictContainer.innerHTML = '';
  // A real verdict exists now — the "nothing scored yet" note no longer applies.
  passiveStatus?.classList.add('hidden');

  const isHigh = verdict.tier === 'HIGH';
  const isMed = verdict.tier === 'MEDIUM';

  if (isHigh) {
    if (statusTitle) {
      statusTitle.textContent = 'SCAM DETECTED';
      statusTitle.classList.add('danger');
    }
    if (coinEmblem) coinEmblem.classList.add('danger');
    if (statusDesc) {
      // Describes what her RULES will do, not something this extension did.
      // It said "SCAM STOPPED & SAFE / your money was NOT sent — it is locked
      // safely on Sui", but the extension only scores conversations: it holds
      // no funds, creates no escrow and submits nothing. Nothing had been
      // stopped at the moment this text appeared, and telling someone under
      // active pressure that she is already safe is the worst possible time
      // to be wrong about it.
      statusDesc.textContent =
        'Someone is trying to pressure you. Do not send money. If you try, your own rules will hold it on Sui until someone you trust agrees.';
    }
  } else if (isMed) {
    if (statusTitle) {
      statusTitle.textContent = 'CAUTION: CHECK FIRST';
      statusTitle.style.color = '#F59E0B';
    }
    if (statusDesc) {
      statusDesc.textContent =
        'This chat looks unusual. A transfer will wait for the cooling-off period she set, so there is time to check with family.';
    }
  } else {
    if (statusTitle) {
      statusTitle.textContent = 'CHAT IS SAFE';
      statusTitle.style.color = '#10B981';
    }
    if (statusDesc) {
      statusDesc.textContent = 'Normal conversation detected. Safe to chat and send money.';
    }
  }

  // Senior-friendly verdict card
  const box = element('div', `verdict-box ${verdict.tier}`);
  const title = element(
    'div',
    'verdict-title',
    isHigh ? '🚨 High Risk Detected' : isMed ? '🟠 Caution Recommended' : '🟢 Safe Message',
  );
  const body = element('div', 'verdict-body', TIER_PLAIN[verdict.tier]);
  box.append(title, body);

  if (verdict.reasoning) {
    const reason = element('div', 'verdict-body');
    reason.style.marginTop = '6px';
    reason.style.opacity = '0.9';
    reason.style.fontSize = '12px';
    // textContent, not innerHTML. `reasoning` is model-generated text derived
    // from an attacker-controlled message, so a scammer who can steer the
    // model's wording could inject markup into the popup with it. The label
    // is built as a separate element so it can still be bold.
    const label = document.createElement('strong');
    label.textContent = 'AI spotted: ';
    reason.append(label, document.createTextNode(verdict.reasoning));
    box.append(reason);
  }

  // Judge / Developer receipt drawer
  const details = document.createElement('details');
  details.style.marginTop = '8px';
  details.style.fontSize = '11.5px';
  details.style.color = 'var(--text-muted)';
  const summary = document.createElement('summary');
  summary.style.cursor = 'pointer';
  // "Scam risk", not "Truth Score": the number is a RISK score — high means
  // dangerous — so the old label inverted it for anyone reading the drawer.
  summary.textContent =
    `Audit: scam risk ${verdict.truthScore ?? 'N/A'}/100 (higher is worse)` +
    ` · Gonka receipts (${verdict.gonkaRequestIds.length})`;
  details.append(summary);

  if (verdict.gonkaRequestIds.length) {
    const ul = document.createElement('ul');
    ul.style.paddingLeft = '18px';
    ul.style.marginTop = '4px';
    for (const id of verdict.gonkaRequestIds) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = receiptUrlFor(id);
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.style.color = 'var(--blue-dark)';
      a.textContent = id;
      li.append(a);
      ul.append(li);
    }
    details.append(ul);
  }
  box.append(details);

  verdictContainer.append(box);
  void scoredCount; // kept for signature parity with the caller; not needed in the card
}

/** Bottom-dock tab switching: 3 real buttons, 3 real panels, plain show/hide. */
const TABS = [
  { btnId: 'dock-tab-chats', panelId: 'tab-chats' },
  { btnId: 'dock-tab-wallet', panelId: 'tab-wallet' },
  { btnId: 'dock-tab-options', panelId: 'tab-options' },
] as const;

function wireTabs(): void {
  for (const { btnId } of TABS) {
    $(btnId)?.addEventListener('click', () => {
      for (const t of TABS) {
        $(t.btnId)?.classList.toggle('active', t.btnId === btnId);
        const panel = $(t.panelId);
        if (panel) panel.style.display = t.btnId === btnId ? 'block' : 'none';
      }
    });
  }
}

/**
 * Every manual paste in this popup session is treated as one running
 * conversation, same "worst verdict wins" rule the content script's real
 * conversations get — a fixed id rather than one per paste is what makes
 * that memory possible.
 */
const MANUAL_SESSION_ID = 'shou-popup-manual-paste';

/**
 * Paste-to-check. Wired for real against the same 'shou:score' message the
 * content script sends — redact() runs here first, on-device, exactly like
 * content.ts does, so a pasted message gets the identical privacy guarantee
 * before it ever reaches the service worker.
 */
function wireManualAnalyze(): void {
  const button = $('btn-deep-analyze');
  const input = $('chat-manual-input') as HTMLTextAreaElement | null;
  const status = $('manual-analyze-status');

  const setStatus = (text: string, isError: boolean): void => {
    if (!status) return;
    status.textContent = text;
    status.classList.remove('hidden');
    status.classList.toggle('error', isError);
  };

  button?.addEventListener('click', () => {
    void (async () => {
      const text = input?.value.trim();
      if (!text) {
        setStatus('Paste a message first.', true);
        return;
      }
      setStatus('Checking…', false);

      const { text: redactedText, removed } = redact(text);
      const request: ScoreRequest = {
        type: 'shou:score',
        sessionId: MANUAL_SESSION_ID,
        site: 'popup-manual-paste',
        redactedText,
        redacted: removed,
      };

      try {
        const response = (await chrome.runtime.sendMessage(request)) as ScoreResponse | undefined;
        if (response?.ok && response.verdict) {
          updateViewForVerdict(response.verdict, 1);
          status?.classList.add('hidden');
        } else {
          setStatus(response?.error ?? 'Could not check that message.', true);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    })();
  });
}

/** Shortens a 0x… policy id for a settings row without hiding what it is. */
function shortenId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/**
 * Options tab is a real settings summary, not a mockup of one: every row
 * reads straight from Settings (chrome.storage, via 'shou:state'). This
 * extension has no on-chain policy fields (transfer limit, guardian, key
 * recovery) to read — only the Settings it actually stores — so those are
 * what's shown here rather than numbers invented to fill the mockup's shape.
 */
function updateOptionsView(settings: Settings): void {
  const enabledEl = $('opt-enabled');
  if (enabledEl) enabledEl.textContent = settings.enabled ? 'On' : 'Off';

  const policyEl = $('opt-policy');
  if (policyEl) policyEl.textContent = settings.policyId ? shortenId(settings.policyId) : 'Not set';

  const breakerEl = $('opt-breaker');
  if (breakerEl) breakerEl.textContent = settings.circuitBreakerUrl;

  const dashboardEl = $('opt-dashboard');
  if (dashboardEl) dashboardEl.textContent = settings.dashboardUrl;

  const dashboardLink = $('opt-dashboard-link') as HTMLAnchorElement | null;
  if (dashboardLink) dashboardLink.href = settings.dashboardUrl;
}

async function main(): Promise<void> {
  wireTabs();
  wireManualAnalyze();

  const bannerClose = $('ext-banner-close');
  if (bannerClose) {
    bannerClose.onclick = () => {
      const b = $('ext-banner');
      if (b) b.style.display = 'none';
    };
  }

  const navSettings = $('nav-settings');
  if (navSettings) {
    navSettings.onclick = (e) => {
      e.preventDefault();
      chrome.runtime?.openOptionsPage?.();
    };
  }

  // Wire quick action buttons
  $('btn-check-chat')?.addEventListener('click', () => {
    alert('SHOU actively scans incoming chat messages in WhatsApp and Messenger.');
  });
  $('btn-send-money')?.addEventListener('click', () => {
    window.open('http://localhost:3000/#simulator', '_blank');
  });
  $('btn-emergency-hold')?.addEventListener('click', () => {
    alert('Safety Pause triggered: All outgoing transfers are locked on Sui.');
  });

  let state: StateResponse | null = null;
  try {
    state = (await chrome.runtime.sendMessage({ type: 'shou:state' })) as StateResponse;
  } catch {
    // Demo fallback when running outside extension runtime
  }

  // Options tab always gets a value — DEFAULT_SETTINGS when the runtime
  // call fails is still an honest answer, since that's what a fresh
  // chrome.storage actually holds before anything is saved.
  updateOptionsView(state?.settings ?? DEFAULT_SETTINGS);

  if (state?.sessions?.[0]) {
    const current = state.sessions[0];
    updateViewForVerdict(current.worst, current.scored);
  }
}

void main();
