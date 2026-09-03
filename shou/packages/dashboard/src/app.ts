// The guardian's screen.
//
// Two rules shape everything below.
//
// 1. PLAIN ENGLISH, NEVER A TIER NUMBER. The person reading this is an
//    adult child at work, not an operator. He needs to know what the
//    money is doing, what happens if he ignores this, and which button
//    is safe. "risk_tier: 2" tells him none of that.
//
// 2. NO CONVERSATION, EVER. This page shows an amount, a recipient and a
//    state. It does not show what his mother was told, because a product
//    that protects her by handing her family a transcript of her private
//    messages has traded one harm for another — and family members are
//    themselves a leading vector for elder financial abuse. The server
//    does not serve message content, so there is nothing here to leak.
//
// It codes against packages/driver/src/types.ts and its own server's
// JSON. It never imports @mysten/sui and never signs anything: the
// buttons POST to this app's server, which makes the on-chain call.

import type { RiskTier, TransferRequestView, TransferStatus } from '../../driver/src/types.ts';

interface Config {
  guardian: string | null;
  approver: boolean | null;
  threshold: number | null;
  owner: string | null;
  policyId: string;
  packageId: string;
  coinType: string;
  network: string;
  error: string | null;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** Colour band. Deliberately four words, not three tiers — a resolved request is neither. */
type Band = 'HOLD' | 'WAIT' | 'CLEAR' | 'DONE';

function bandFor(request: TransferRequestView): Band {
  switch (request.status) {
    case 'NEEDS_APPROVAL':
      return 'HOLD';
    case 'AUTO_UNLOCK_SCHEDULED':
      return 'WAIT';
    case 'APPROVED':
    case 'PENDING':
      return 'CLEAR';
    default:
      return 'DONE';
  }
}

const BAND_LABEL: Record<Band, string> = {
  HOLD: 'Waiting for you',
  WAIT: 'On hold',
  CLEAR: 'Cleared',
  DONE: 'Finished',
};

/**
 * USDC has 6 decimals, so the on-chain number is a millionth of a
 * dollar. Formatting this wrong by three places is the difference
 * between approving $5 and approving $5,000, which is the single number
 * this whole screen exists to put in front of someone.
 */
function formatAmount(base: string, coinType: string): { value: string; unit: string } {
  const isUsdc = /::usdc::USDC$/i.test(coinType);
  const decimals = isUsdc ? 6 : 9;
  const unit = isUsdc ? 'USDC' : 'SUI';
  const n = BigInt(base || '0');
  const scale = 10n ** BigInt(decimals);
  const whole = n / scale;
  const frac = n % scale;
  const cents = (frac * 100n) / scale;
  return {
    value: `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`,
    unit,
  };
}

const shortAddress = (address: string): string =>
  address && address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address || '—';

function timeAgo(ms: number | null, nowMs: number): string {
  if (!ms) return 'just now';
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function countdown(unlockAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((unlockAtMs - nowMs) / 1000));
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/** The one-line answer to "what am I looking at". */
function headline(request: TransferRequestView, nowMs: number): string {
  switch (request.status) {
    case 'NEEDS_APPROVAL':
      return 'This one looked like a scam, so the money has stopped and is waiting for you.';
    case 'APPROVED':
      return 'You approved this. The money is released and can now be sent.';
    case 'AUTO_UNLOCK_SCHEDULED':
      return `A large amount, so it is sitting still for ${countdown(request.unlockAtMs, nowMs)} before it can go.`;
    case 'PENDING':
      return 'Nothing looked wrong with this one. It is clear to send.';
    case 'BLOCKED':
      return 'This was stopped, and the money went back to her.';
    case 'EXECUTED':
      return 'This one went through.';
    default:
      return '';
  }
}

/**
 * The line that actually decides behaviour: what happens if he closes
 * the tab. A guardian who thinks inaction means "approved" will do
 * nothing on purpose; a guardian who knows it means "she stays stuck"
 * will answer. Both readings are wrong unless we say which it is.
 */
function consequence(request: TransferRequestView, threshold: number | null): string {
  switch (request.status) {
    case 'NEEDS_APPROVAL': {
      const have = request.approvals.length;
      const need = threshold ?? 1;
      const remaining = Math.max(0, need - have);
      return (
        `If you do nothing, the money stays where it is — not sent, not lost. ` +
        `She can cancel it herself at any time and have it refunded. ` +
        `${have} of ${need} approvals so far; ${remaining} more will release it.`
      );
    }
    case 'APPROVED':
      return 'Nothing more is needed from you. She can complete the transfer when she wants to.';
    case 'AUTO_UNLOCK_SCHEDULED':
      return 'This releases by itself when the wait is over. You can still stop it before then.';
    case 'PENDING':
      return 'No action needed. You are seeing it only so nothing happens behind your back.';
    case 'BLOCKED':
      return 'The full amount is back in her wallet. It was never sent to the recipient.';
    case 'EXECUTED':
      return 'The recipient has the money. This one is closed.';
    default:
      return '';
  }
}

/** Blocking is available right up until the funds actually leave. */
const canAct = (status: TransferStatus): boolean =>
  status !== 'EXECUTED' && status !== 'BLOCKED';

const PLAIN_TIER: Record<RiskTier, string> = {
  LOW: 'nothing unusual',
  MEDIUM: 'something a bit off',
  HIGH: 'likely a scam',
};

let config: Config | null = null;
let busy: string | null = null;
let shownActionError = false;

async function act(kind: 'approve' | 'block', requestId: string): Promise<void> {
  busy = requestId;
  shownActionError = false;
  $('error').classList.add('hidden');
  render(lastRequests, lastNow);
  try {
    const response = await fetch(`/api/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
    const body = (await response.json()) as { error?: string };
    // A Move abort is the interesting case, not a failure to hide: it is
    // the contract refusing, and the abort name says why.
    if (!response.ok) throw new Error(body.error ?? `server returned ${response.status}`);
  } catch (error) {
    // Not subject to the poll-failure tolerance above: he pressed a
    // button and it did not work, so say so on the first failure.
    showError(error instanceof Error ? error.message : String(error));
    shownActionError = true;
  } finally {
    busy = null;
    await refresh();
  }
}

function showError(message: string): void {
  const box = $('error');
  box.classList.remove('hidden');
  box.textContent = message;
}

function clearError(): void {
  pollFailures = 0;
  // A Move abort from a button he just pressed stays on screen. The
  // five-second poll succeeds a moment later and would otherwise wipe
  // the one message explaining why his approval was refused, leaving him
  // to conclude the button simply does nothing.
  if (shownActionError) return;
  $('error').classList.add('hidden');
}

/**
 * Consecutive poll failures. A single one is not worth telling the
 * guardian about: this polls every five seconds, so one dropped request
 * on a train wifi connection would flash a red box over a screen about
 * his mother's savings, and the rows already on screen are still true.
 * Two in a row means something is actually down.
 */
let pollFailures = 0;

function card(request: TransferRequestView, nowMs: number): HTMLElement {
  const band = bandFor(request);
  const { value, unit } = formatAmount(request.amount, config?.coinType ?? '');
  const element = document.createElement('div');
  element.className = `card req ${band}`;

  const state = document.createElement('div');
  state.className = `state ${band}`;
  state.textContent = BAND_LABEL[band];
  element.append(state);

  const amount = document.createElement('div');
  amount.className = 'amount';
  amount.textContent = value;
  const small = document.createElement('small');
  small.textContent = unit;
  amount.append(small);
  element.append(amount);

  const line = document.createElement('p');
  line.className = 'headline';
  line.textContent = headline(request, nowMs);
  element.append(line);

  const to = document.createElement('div');
  to.className = 'to';
  to.append(document.createTextNode('To '));
  const code = document.createElement('code');
  code.textContent = shortAddress(request.recipient);
  to.append(code, document.createTextNode(` · asked ${timeAgo(request.requestedAtMs, nowMs)}`));
  element.append(to);

  // The escalation claim, made visible. If the chain assigned a stricter
  // tier than was submitted, this transfer is being held by her own
  // rules rather than by the model — which is the whole reason a wrong
  // or compromised scorer is not a catastrophe.
  if (request.claimedTier && request.claimedTier !== request.tier) {
    const escalated = document.createElement('div');
    escalated.className = 'escalated';
    escalated.textContent =
      `The check on her phone said ${PLAIN_TIER[request.claimedTier]}. ` +
      `Her own limits disagreed and held it anyway — nothing she set can be overridden by the check.`;
    element.append(escalated);
  }

  const why = document.createElement('div');
  why.className = 'consequence';
  why.textContent = consequence(request, config?.threshold ?? null);
  element.append(why);

  if (canAct(request.status) && config?.approver !== false) {
    const actions = document.createElement('div');
    actions.className = 'actions';

    const block = document.createElement('button');
    block.className = 'block';
    // Named for what it does to the money, not for what it does to the
    // record. "Block" alone reads as "delete"; a guardian hesitates over
    // a button that might destroy his mother's savings.
    block.textContent = 'Stop it — refund her';
    block.disabled = busy !== null;
    block.addEventListener('click', () => void act('block', request.requestId));
    actions.append(block);

    if (request.status === 'NEEDS_APPROVAL') {
      const approve = document.createElement('button');
      approve.className = 'approve';
      approve.textContent = 'I checked — let it through';
      approve.disabled = busy !== null;
      approve.addEventListener('click', () => void act('approve', request.requestId));
      actions.append(approve);
    }
    element.append(actions);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  // The request id is here so a judge can paste it into a Sui explorer
  // and confirm the object says what this page says.
  //
  // A zero score is suppressed rather than printed. The unattested path
  // emits truth_score: 0, which is indistinguishable from a model that
  // genuinely scored zero — and "confidence 0/100" next to a held
  // transfer reads as "we are certain this is fine", the exact opposite
  // of what a missing score means.
  meta.textContent =
    `${request.requestId}` +
    (request.truthScore ? ` · confidence ${request.truthScore}/100` : '');
  element.append(meta);

  return element;
}

let lastRequests: TransferRequestView[] = [];
let lastNow = Date.now();

function render(requests: TransferRequestView[], nowMs: number): void {
  const list = $('list');
  list.textContent = '';
  if (!requests.length) {
    const empty = document.createElement('div');
    empty.className = 'card empty';
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = 'Nothing needs you right now.';
    empty.append(big, document.createTextNode('Her wallet is working normally. You will see anything held here.'));
    list.append(empty);
    return;
  }
  // Whatever is waiting on him first; resolved history underneath.
  const order: Band[] = ['HOLD', 'WAIT', 'CLEAR', 'DONE'];
  const sorted = [...requests].sort(
    (a, b) =>
      order.indexOf(bandFor(a)) - order.indexOf(bandFor(b)) ||
      (b.requestedAtMs ?? 0) - (a.requestedAtMs ?? 0),
  );
  for (const request of sorted) list.append(card(request, nowMs));
}

function renderChips(): void {
  const chips = $('chips');
  chips.textContent = '';
  const add = (text: string): void => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    chips.append(chip);
  };
  if (!config) return;
  add(config.network);
  if (config.guardian) add(`you: ${shortAddress(config.guardian)}`);
  if (config.threshold !== null) add(`threshold ${config.threshold}`);
  if (config.policyId) add(`policy ${shortAddress(config.policyId)}`);
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch('/api/requests');
    const body = (await response.json()) as {
      requests?: TransferRequestView[];
      threshold?: number;
      nowMs?: number;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? `server returned ${response.status}`);
    clearError();
    lastRequests = body.requests ?? [];
    lastNow = body.nowMs ?? Date.now();
    if (config && typeof body.threshold === 'number') config.threshold = body.threshold;
    render(lastRequests, lastNow);
  } catch (error) {
    pollFailures += 1;
    if (pollFailures > 1) {
      showError(
        `Cannot reach the dashboard server (${error instanceof Error ? error.message : String(error)}). ` +
          `Anything shown below may be out of date. Nothing has changed on-chain — ` +
          `held transfers stay held whether this page is running or not.`,
      );
    }
  }
}

async function main(): Promise<void> {
  try {
    config = (await (await fetch('/api/config')).json()) as Config;
  } catch (error) {
    return showError(error instanceof Error ? error.message : String(error));
  }
  renderChips();

  if (config.error) showError(config.error);

  if (config.approver === false) {
    const box = $('notApprover');
    box.classList.remove('hidden');
    // Fails loudly rather than showing buttons that will abort on-chain.
    box.textContent =
      `The key this server signs with (${shortAddress(config.guardian ?? '')}) is not an approver on ` +
      `this policy, so approving or blocking would be refused by the contract. ` +
      `Reseed with your own address as the guardian: ` +
      `SHOU_GUARDIAN_ADDRESS=<you> node --experimental-strip-types packages/driver/src/seed-demo.ts`;
  }

  $('footnote').textContent =
    'Approving and blocking are ordinary on-chain calls. A guardian can stop a transfer and send ' +
    'the money back to her, and that is all — there is no call in the contract that redirects her ' +
    'funds to anyone else, including you. This page never shows her messages.';

  await refresh();
  // Cheap poll. The alternative is a websocket for a screen that is
  // usually empty and always has a human waiting on it.
  setInterval(() => void refresh(), 5000);
}

void main();
