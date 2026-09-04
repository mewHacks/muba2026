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
//
// Everything that can be wrong about money — decimals, the contract's
// escalation rule, the setup form's guards — lives in logic.ts and is
// tested. This file is rendering and wiring.

import type { RedFlagView, TransferRequestView } from '../../driver/src/types.ts';
import {
  amountTier,
  banBlocksAmount,
  bandFor,
  canAct,
  coinLabel,
  consequence,
  describeDuration,
  describePolicy,
  formatAmount,
  headline,
  holdReason,
  shortAddress,
  sortRequests,
  stateLabel,
  timeAgo,
  validatePolicyForm,
  type Band,
  type PolicyFormResult,
} from './logic.ts';

interface Config {
  guardian: string | null;
  approver: boolean | null;
  owner: string | null;
  threshold: number | null;
  approvers: string[];
  cooldownMs: number | null;
  reviewCeiling: string | null;
  highRiskCeiling: string | null;
  pausedUntilMs: number | null;
  /** Base units, or null when the balance could not be read. */
  ownerBalance?: string | null;
  policyId: string;
  packageId: string;
  denyListId: string;
  coinType: string;
  network: string;
  canReport: boolean;
  error: string | null;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// ---- small DOM helpers ----

type Child = string | Node | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** From the one authored sprite in index.html, so every icon matches. */
function icon(name: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const BAND_ICON: Record<Band, string> = {
  HOLD: 'hand',
  WAIT: 'clock',
  CLEAR: 'check',
  DONE: 'check',
};

/** A stopped transfer and a sent one share a band and must not share a glyph. */
const statusIcon = (status: string, band: Band): string =>
  status === 'BLOCKED' ? 'hand' : BAND_ICON[band];

function explorerLink(kind: 'object' | 'txblock', id: string, network: string): HTMLAnchorElement {
  const a = el(
    'a',
    {
      href: `https://suiscan.xyz/${network}/${kind === 'object' ? 'object' : 'tx'}/${id}`,
      target: '_blank',
      rel: 'noreferrer noopener',
      title: id,
    },
    // Shortened: a 66-character id set as a full-width underlined line
    // reads as a rule across the card rather than as a link, and the
    // full value is one click (or the title) away.
    shortAddress(id),
  );
  return a;
}

// ---- state ----

let config: Config | null = null;
let busy: string | null = null;
/** An error from a button press stays up; a poll recovering must not wipe it. */
let stickyError: string | null = null;
/**
 * Consecutive poll failures. A single one is not worth telling the
 * guardian about: this polls every five seconds, so one dropped request
 * on train wifi would flash a red box over a screen about his mother's
 * savings, and the rows already on screen are still true. Two in a row
 * means something is actually down.
 */
let pollFailures = 0;

let requests: TransferRequestView[] = [];
let requestsLoaded = false;
let nowMs = Date.now();
let flags: RedFlagView[] | null = null;
let flagsError: string | null = null;
let flagsLoaded = false;

// ---- banners ----

interface Banner {
  kind: 'bad' | 'warn' | 'info';
  icon: string;
  content: Child[];
}

function renderBanners(): void {
  const host = $('banners');
  host.textContent = '';
  const banners: Banner[] = [];

  if (stickyError) {
    banners.push({ kind: 'bad', icon: 'alert', content: [stickyError] });
  } else if (pollFailures > 1) {
    banners.push({
      kind: 'bad',
      icon: 'alert',
      content: [
        el('strong', {}, 'Cannot reach the dashboard server. '),
        'Anything below may be out of date. Nothing has changed on-chain — held transfers ' +
          'stay held whether this page is running or not.',
      ],
    });
  }

  if (config?.error) banners.push({ kind: 'bad', icon: 'alert', content: [config.error] });

  if (config?.approver === false) {
    banners.push({
      kind: 'warn',
      icon: 'alert',
      content: [
        el('strong', {}, 'You are not a guardian on this policy. '),
        `The key this server signs with (${shortAddress(config.guardian ?? '')}) is not on the ` +
          'approver list, so approving or blocking would be refused by the contract. Set the ' +
          'rules up on this page with your own address, or reseed: ',
        el('code', {}, 'SHOU_GUARDIAN_ADDRESS=<you> node --experimental-strip-types packages/driver/src/seed-demo.ts'),
      ],
    });
  }

  if (config && config.pausedUntilMs !== null && config.pausedUntilMs > nowMs) {
    banners.push({
      kind: 'warn',
      icon: 'hand',
      content: [
        el('strong', {}, 'Her wallet is paused. '),
        'No new transfer can be started until the pause lifts. Anything already held stays held.',
      ],
    });
  }

  for (const banner of banners) {
    host.append(
      el('div', { class: `notice ${banner.kind}` }, icon(banner.icon, 19), el('div', {}, ...banner.content)),
    );
  }
}

function showError(message: string): void {
  stickyError = message;
  renderBanners();
}

// ---- confirmation ----

interface ConfirmSpec {
  title: string;
  body: string;
  fact: Child[];
  confirmLabel: string;
  danger?: boolean;
}

/**
 * Everything on this page that spends gas goes through here first.
 *
 * A modal is usually laziness, and it is not laziness here: approving or
 * blocking is a real transaction against real money that cannot be
 * undone, and the guardian is about to do it from a list where the
 * neighbouring row is a different amount to a different person. The
 * dialog exists to say *which* transfer, in words, before the click
 * commits. The server refuses anything that did not come through it.
 */
function confirm(spec: ConfirmSpec): Promise<boolean> {
  const dialog = $('confirm') as HTMLDialogElement;
  $('confirm-title').textContent = spec.title;
  $('confirm-body').textContent = spec.body;
  const fact = $('confirm-fact');
  const allStrings = spec.fact.every((item) => typeof item === 'string');
  for (const item of spec.fact) {
    if (item === null || item === undefined || item === false) continue;
    if (typeof item === 'string') {
      if (allStrings && spec.fact.length > 1) {
        fact.append(el('div', { style: 'margin-bottom:6px; line-height:1.45;' }, item));
      } else {
        fact.append(document.createTextNode(item));
      }
    } else {
      fact.append(item);
    }
  }
  const yes = $('confirm-yes') as HTMLButtonElement;
  yes.textContent = spec.confirmLabel;
  yes.className = `act ${spec.danger ? 'danger' : 'primary'}`;

  return new Promise((resolve) => {
    const done = (answer: boolean): void => {
      yes.onclick = null;
      ($('confirm-no') as HTMLButtonElement).onclick = null;
      dialog.onclose = null;
      dialog.close();
      resolve(answer);
    };
    yes.onclick = () => done(true);
    ($('confirm-no') as HTMLButtonElement).onclick = () => done(false);
    // Escape and the backdrop both mean no, which is the safe default for
    // every action this dialog guards.
    dialog.onclose = () => resolve(false);
    dialog.showModal();
    ($('confirm-no') as HTMLButtonElement).focus();
  });
}

// ---- transfers ----

function ceilings(): { review: bigint; high: bigint } | null {
  if (!config?.reviewCeiling || !config?.highRiskCeiling) return null;
  try {
    return { review: BigInt(config.reviewCeiling), high: BigInt(config.highRiskCeiling) };
  } catch {
    return null;
  }
}

/**
 * The escalation claim, made visible — and derived rather than asserted.
 *
 * The chain stores only the effective tier, so "the AI said LOW and the
 * chain disagreed" is not literally recoverable from the object. What is
 * recoverable is whether her own ceilings reach this tier by themselves.
 * When they do, the hold stands whatever the scorer said, including if
 * the scorer was wrong, offline, or compromised — which is the actual
 * claim worth making. See holdReason in logic.ts.
 */
function whyHeld(request: TransferRequestView): HTMLElement | null {
  const limits = ceilings();
  if (!limits || !canAct(request.status)) return null;
  const reason = holdReason(request.tier, BigInt(request.amount || '0'), limits.review, limits.high);
  if (reason === 'NONE') return null;

  const coin = config?.coinType ?? '';
  const unit = coinLabel(coin);
  const at =
    amountTier(BigInt(request.amount || '0'), limits.review, limits.high) === 'HIGH'
      ? formatAmount(limits.high.toString(), coin)
      : formatAmount(limits.review.toString(), coin);

  const text =
    reason === 'AMOUNT'
      ? `Her own limit did this. She set ${at.value} ${unit} as the point where a transfer stops ` +
        `and waits, and this is at or above it — so it would have been held even if the check on ` +
        `her phone had never run, or had got it wrong.`
      : `The amount alone was within her limits. The check on her phone is what raised this, and ` +
        `her limits are unchanged by it — a check can only ever make a transfer stricter, never ` +
        `let one through faster.`;

  // Amber on the amber WAIT card; neutral inside the red HOLD card,
  // where a second warm tint reads as a second warning rather than as
  // the explanation of the first.
  const tone = bandFor(request.status) === 'HOLD' ? 'why plain' : 'why';
  return el('div', { class: tone }, icon(reason === 'AMOUNT' ? 'sliders' : 'alert', 18), el('div', {}, text));
}

async function act(kind: 'approve' | 'block', request: TransferRequestView): Promise<void> {
  const amount = formatAmount(request.amount, config?.coinType ?? '');
  const approving = kind === 'approve';
  const ok = await confirm({
    title: approving ? 'Let this transfer through?' : 'Stop this transfer?',
    body: approving
      ? 'This releases the hold. Once the approvals are met she can send the money, and it cannot be recalled.'
      : 'This cancels the transfer and returns the full amount to her wallet. It cannot be undone, and she would have to start again.',
    fact: [
      el('b', {}, `${amount.value} ${amount.unit}`),
      ' to ',
      el('code', { class: 'addr' }, shortAddress(request.recipient)),
      el('br'),
      `On ${config?.network ?? 'testnet'}. This is a real transaction and costs gas.`,
    ],
    confirmLabel: approving ? 'Yes, let it through' : 'Yes, stop it',
    danger: !approving,
  });
  if (!ok) return;

  busy = request.requestId;
  stickyError = null;
  renderBanners();
  renderTransfers();
  try {
    const response = await fetch(`/api/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: request.requestId, confirm: true }),
    });
    const body = (await response.json()) as { error?: string; digest?: string };
    // A Move abort is the interesting case, not a failure to hide: it is
    // the contract refusing, and the abort name says why.
    if (!response.ok) throw new Error(body.error ?? `server returned ${response.status}`);
    lastDigest = { requestId: request.requestId, digest: body.digest ?? null, kind };
  } catch (error) {
    // Not subject to the poll-failure tolerance: he pressed a button and
    // it did not work, so say so on the first failure.
    showError(
      `${approving ? 'Approving' : 'Stopping'} did not go through — ${
        error instanceof Error ? error.message : String(error)
      }. Nothing changed on-chain.`,
    );
  } finally {
    busy = null;
    await refreshRequests();
  }
}

/** The receipt for the last successful mutation, shown on its own row. */
let lastDigest: { requestId: string; digest: string | null; kind: 'approve' | 'block' } | null = null;

function transferCard(request: TransferRequestView): HTMLElement {
  const band = bandFor(request.status);
  const amount = formatAmount(request.amount, config?.coinType ?? '');
  const card = el('article', { class: `card req ${band}` });

  card.append(
    el('div', { class: `state ${band}` }, icon(statusIcon(request.status, band), 14), stateLabel(request.status)),
    el('div', { class: 'amount' }, amount.value, el('small', {}, amount.unit)),
    el('p', { class: 'headline' }, headline(request, nowMs)),
    el(
      'div',
      { class: 'to' },
      'To',
      el('code', { class: 'addr' }, shortAddress(request.recipient)),
      `· asked ${timeAgo(request.requestedAtMs, nowMs)}`,
    ),
  );

  if (amount.raw) {
    card.append(
      el(
        'div',
        { class: 'why' },
        icon('alert', 18),
        el(
          'div',
          {},
          `This is shown in the coin's smallest units because we do not know how many decimal ` +
            `places ${amount.unit} has. Do not read it as a dollar amount.`,
        ),
      ),
    );
  }

  const why = whyHeld(request);
  if (why) card.append(why);

  card.append(el('div', { class: 'consequence' }, consequence(request, config?.threshold ?? null)));

  if (canAct(request.status) && config?.approver === true) {
    const actions = el('div', { class: 'actions' });
    const working = busy === request.requestId;

    // Named for what it does to the money, not for what it does to the
    // record. "Block" alone reads as "delete"; a guardian hesitates over
    // a button that might destroy his mother's savings.
    // Filled red only where stopping is the expected move. On a transfer
    // that is merely waiting, or already cleared, a full-width red button
    // is the loudest thing on the screen for the action least likely to
    // be wanted — so it drops to the quiet treatment and keeps the same
    // words, rather than disappearing.
    const urgent = band === 'HOLD';
    const stop = el(
      'button',
      { class: `act ${urgent ? 'danger' : 'quiet'}`, type: 'button' },
      icon(working ? 'loader' : 'hand'),
      working ? 'Working…' : 'Stop it — refund her',
    );
    if (working) stop.querySelector('svg')?.classList.add('spin');
    stop.disabled = busy !== null;
    stop.addEventListener('click', () => void act('block', request));
    actions.append(stop);

    if (request.status === 'NEEDS_APPROVAL') {
      const approve = el(
        'button',
        { class: 'act ghost', type: 'button' },
        icon('check'),
        'I checked — let it through',
      );
      approve.disabled = busy !== null;
      approve.addEventListener('click', () => void act('approve', request));
      actions.append(approve);
    }
    card.append(actions);
  }

  // The request id is here so a judge can paste it into an explorer and
  // confirm the object says what this page says.
  //
  // A zero score is suppressed rather than printed. The unattested path
  // reports truth_score 0, which is indistinguishable from a model that
  // genuinely scored zero — and "confidence 0/100" next to a held
  // transfer reads as "we are certain this is fine", the exact opposite
  // of what a missing score means.
  const meta = el('div', { class: 'meta' });
  meta.append(explorerLink('object', request.requestId, config?.network ?? 'testnet'));
  if (request.truthScore) meta.append(` · confidence ${request.truthScore}/100`);
  if (lastDigest?.requestId === request.requestId && lastDigest.digest) {
    meta.append(
      el('br'),
      lastDigest.kind === 'approve' ? 'approved in ' : 'stopped in ',
      explorerLink('txblock', lastDigest.digest, config?.network ?? 'testnet'),
    );
  }
  card.append(meta);
  return card;
}

function skeletonCard(): HTMLElement {
  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'skel pill' }),
    el('div', { class: 'skel big' }),
    el('div', { class: 'skel line', style: 'width:78%' }),
    el('div', { class: 'skel line', style: 'width:52%' }),
  );
}

function emptyState(iconName: string, big: string, body: string): HTMLElement {
  return el(
    'div',
    { class: 'card empty' },
    icon(iconName, 30),
    el('div', { class: 'big' }, big),
    el('p', {}, body),
  );
}

let activeFilter = 'all';

function renderTransfers(): void {
  const list = $('list');
  list.textContent = '';

  if (!requestsLoaded) {
    list.append(skeletonCard(), skeletonCard());
    return;
  }

  let filtered = requests;
  if (activeFilter === 'needs_approval') {
    filtered = requests.filter((r) => r.status === 'NEEDS_APPROVAL');
  } else if (activeFilter === 'waiting') {
    filtered = requests.filter((r) => bandFor(r.status) === 'WAIT');
  } else if (activeFilter === 'blocked') {
    filtered = requests.filter((r) => r.status === 'BLOCKED' || bandFor(r.status) === 'DONE');
  }

  if (!filtered.length) {
    list.append(
      emptyState(
        'shield',
        'No transfers in this view.',
        activeFilter === 'all'
          ? 'Her wallet is working normally. Anything that gets held will appear here, with what it is and what happens if you leave it alone.'
          : 'Zero transactions currently match this filter.',
      ),
    );
  } else {
    for (const request of sortRequests(filtered)) list.append(transferCard(request));
  }

  const waiting = requests.filter((r) => r.status === 'NEEDS_APPROVAL').length;
  const badge = $('tab-count');
  if (badge) {
    badge.textContent = String(waiting);
    badge.classList.toggle('hidden', waiting === 0);
  }

  const sideCount = document.getElementById('sidebar-count');
  if (sideCount) {
    sideCount.textContent = String(waiting);
    sideCount.style.display = waiting > 0 ? 'inline-block' : 'none';
  }
}

// ---- reported addresses ----

function flagCard(flag: RedFlagView): HTMLElement {
  const coin = config?.coinType ?? '';
  const unit = coinLabel(coin);
  const ceiling = formatAmount(flag.banCeiling, coin);
  const everythingBlocked = banBlocksAmount(BigInt(flag.banCeiling || '0'), 1n);

  const card = el('article', { class: 'card flag' });
  card.append(
    el(
      'div',
      { class: 'who' },
      el('code', { class: 'addr' }, flag.address),
      el(
        'div',
        { class: 'reports' },
        flag.reportedAtMs ? `Reported ${timeAgo(flag.reportedAtMs, nowMs)}` : 'Reported',
        flag.reportCount > 1 ? ` · ${flag.reportCount} reports recorded` : '',
      ),
    ),
    el(
      'div',
      { class: 'score' },
      // A bare "94" answers no question. The caption says what was
      // scored — the evidence in the report, not the address's guilt —
      // because the two are not the same claim.
      el('span', { class: 'cap' }, 'Evidence scored'),
      el('b', { class: flag.plausibilityScore >= 80 ? 'high' : '' }, `${flag.plausibilityScore}`),
      el('span', {}, 'out of 100'),
    ),
  );

  // The soft ban, said plainly. Calling this "banned" without the ceiling
  // would be the wrong claim: the contract lets everyday amounts through
  // on purpose, so that a wrong report degrades service instead of
  // cutting someone off from their groceries while a reviewer catches up.
  // The two enforcement states must not look alike. One says "large
  // payments here are refused"; the other says "this address cannot
  // receive anything at all". Rendering both in the same neutral box
  // makes a total block scan as a note.
  card.append(
    el(
      'div',
      { class: everythingBlocked ? 'ceiling hard' : 'ceiling' },
      icon(everythingBlocked ? 'hand' : 'info', 18),
      everythingBlocked
        ? el('div', {}, el('b', {}, 'Nothing can be sent here. '), 'The limit on this report is zero, so every amount is refused.')
        : el(
            'div',
            {},
            el('b', {}, `Up to ${ceiling.value} ${unit} still goes through. `),
            `Anything above ${ceiling.value} ${unit} to this address is refused by the contract ` +
              `before a transfer is even created. It is a soft limit on purpose: a report that ` +
              `turns out to be wrong should slow someone down, not cut them off.`,
          ),
    ),
  );
  return card;
}

/**
 * Illustrative rows for the community tab, shown ONLY when the presenter
 * turns them on, and always under a banner saying they are not real.
 *
 * WHY THIS IS OPT-IN AND LABELLED. The live deny list is genuinely empty:
 * `redflag::report` needs an OracleCap this signer does not hold, so no
 * address has ever been reported. Filling the tab with unlabelled rows
 * would put invented "reported scammer" addresses on a security product's
 * own dashboard — the same class of thing as the invented MRENCLAVE hash
 * that used to sit on the telemetry tab, and the one kind of screenshot
 * that is actively harmful if it escapes the demo: these are real-looking
 * accusations against addresses.
 *
 * So: default off, a visible toggle, an unmissable banner, and addresses
 * in the 0x…dead0001 range that are obviously synthetic rather than
 * plausible-looking hex. It shows the SHAPE of the feature, which is what
 * the tab is for, without asserting that anyone reported anything.
 */
const SAMPLE_FLAGS: RedFlagView[] = [
  {
    address: '0x000000000000000000000000000000000000000000000000000000000dead001',
    plausibilityScore: 96,
    banCeiling: '0',
    reportedAtMs: Date.now() - 1000 * 60 * 60 * 6,
    reportCount: 14,
  },
  {
    address: '0x000000000000000000000000000000000000000000000000000000000dead002',
    plausibilityScore: 81,
    banCeiling: '5000000',
    reportedAtMs: Date.now() - 1000 * 60 * 60 * 34,
    reportCount: 6,
  },
  {
    address: '0x000000000000000000000000000000000000000000000000000000000dead003',
    plausibilityScore: 64,
    banCeiling: '25000000',
    reportedAtMs: Date.now() - 1000 * 60 * 60 * 24 * 5,
    reportCount: 2,
  },
];

/** Presenter-controlled, never persisted, never on by default. */
let showSampleFlags = false;

function renderFlags(): void {
  const host = $('flags');
  const sub = $('flags-sub');
  host.textContent = '';

  sub.textContent = config?.canReport
    ? 'Read from the deny list this policy is bound to. This signer holds the OracleCap, so it could also write to it.'
    : 'Read from the deny list this policy is bound to. This is a read-only view: writing to the list needs the OracleCap that the scoring service holds, and this signer does not have it.';

  if (!flagsLoaded) {
    host.append(skeletonCard(), skeletonCard());
    return;
  }
  if (flagsError) {
    host.append(
      el(
        'div',
        { class: 'notice bad' },
        icon('alert', 19),
        el('div', {}, el('strong', {}, 'Could not read the deny list. '), flagsError),
      ),
    );
    return;
  }
  if (!flags?.length && showSampleFlags) {
    // Banner first, so it is read before the rows underneath it.
    host.append(
      el(
        'div',
        { class: 'notice warn' },
        icon('alert', 19),
        el(
          'div',
          {},
          el('strong', {}, 'These are example rows, not real reports. '),
          'The deny list on chain is empty. Nobody has reported these addresses, they are not ' +
            'real wallets, and nothing below was read from Sui. This view exists to show what ' +
            'the tab looks like once reporting is wired up.',
        ),
      ),
    );
    for (const flag of SAMPLE_FLAGS) host.append(flagCard(flag));
  } else if (!flags?.length) {
    host.append(
      emptyState(
        'flag',
        'No addresses are reported yet.',
        'When the scoring service records a report, the address appears here with the amount ' +
          'it is still allowed to receive. An empty list means the list is genuinely empty, ' +
          'not that this page failed to load it.',
      ),
    );
  } else {
    for (const flag of flags) host.append(flagCard(flag));
  }

  // The toggle. Only offered when the real list is empty — once genuine
  // reports exist there is nothing to illustrate and every row should be
  // read from the chain.
  if (!flags?.length) {
    const toggle = el(
      'button',
      { class: 'act ghost', type: 'button', style: 'margin-top:12px' },
      icon(showSampleFlags ? 'check' : 'flag', 15),
      el('span', {}, showSampleFlags ? 'Hide the example rows' : 'Show example rows (clearly marked)'),
    );
    toggle.addEventListener('click', () => {
      showSampleFlags = !showSampleFlags;
      renderFlags();
    });
    host.append(toggle);
  }

  // How reports actually become bans, stated where someone would
  // otherwise assume crowdsourcing. Nothing on this page reports an
  // address, and no number of community reports bans one by itself.
  host.append(
    el(
      'div',
      { class: 'notice info' },
      icon('info', 19),
      el(
        'div',
        {},
        el('strong', {}, 'Reports do not ban an address on their own. '),
        'Evidence is scored off-chain first, and only the scoring service — which holds a ' +
          'capability minted by the package publisher — can write an entry here. That gate is ' +
          'the point: without it, anyone could cut off a legitimate shop by reporting it. ' +
          'Staff with a separate capability can clear an entry, and a cleared address ' +
          'disappears from this list.',
      ),
    ),
  );
}

// ---- setup ----

const setupState = {
  guardians: [''],
  threshold: '1',
  reviewCeiling: '',
  highRiskCeiling: '',
  cooldownMinutes: '',
  denyListId: '',
  submitting: false,
  result: null as { policyId: string; digest?: string } | null,
  serverError: null as string | null,
  touched: false,
};

function validateSetup(): PolicyFormResult {
  return validatePolicyForm({
    guardians: setupState.guardians,
    threshold: setupState.threshold,
    reviewCeiling: setupState.reviewCeiling,
    highRiskCeiling: setupState.highRiskCeiling,
    cooldownMinutes: setupState.cooldownMinutes,
    denyListId: setupState.denyListId,
    coinType: config?.coinType ?? '',
  });
}

function field(
  labelText: string,
  hintText: string,
  control: HTMLElement,
  error: string | undefined,
): HTMLElement {
  return el(
    'fieldset',
    {},
    el('legend', {}, labelText),
    el('p', { class: 'hint' }, hintText),
    control,
    error ? el('div', { class: 'field-error' }, icon('alert', 15), error) : null,
  );
}

function textInput(
  value: string,
  placeholder: string,
  invalid: boolean,
  onInput: (value: string) => void,
  extraClass = '',
): HTMLInputElement {
  const input = el('input', { type: 'text', placeholder, class: extraClass });
  input.value = value;
  if (invalid) input.setAttribute('aria-invalid', 'true');
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function renderSetup(): void {
  const host = $('setup');
  host.textContent = '';
  const unit = coinLabel(config?.coinType ?? '');

  if (setupState.result) {
    host.append(
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'state CLEAR' }, icon('check', 14), 'Rules are live'),
        el('p', { class: 'headline' }, 'Her policy is on-chain and this page is now watching it.'),
        el(
          'div',
          { class: 'meta' },
          'policy ',
          explorerLink('object', setupState.result.policyId, config?.network ?? 'testnet'),
          setupState.result.digest ? el('br') : null,
          setupState.result.digest ? 'created in ' : null,
          setupState.result.digest
            ? explorerLink('txblock', setupState.result.digest, config?.network ?? 'testnet')
            : null,
        ),
        el(
          'div',
          { class: 'notice info', style: 'margin:14px 0 0' },
          icon('info', 19),
          el(
            'div',
            {},
            'This page is showing the new policy, but the id is not written to ',
            el('code', {}, 'demo-ids.json'),
            ' — the extension and the circuit breaker still point at the old one until you set ',
            el('code', {}, 'SHOU_POLICY_ID'),
            ' or reseed.',
          ),
        ),
      ),
    );
    return;
  }

  const { errors, call } = validateSetup();
  const showErrors = setupState.touched;
  const err = (key: string): string | undefined => (showErrors ? errors[key] : undefined);

  // How this gets signed, said before anything else on the form. The
  // elder signs in with Google elsewhere in this project and that flow
  // does not submit transactions — it signs an enclave attestation. So
  // this form does the honest thing and says whose key is about to pay
  // for and own the policy, rather than implying it is hers.
  host.append(
    el(
      'div',
      { class: 'notice warn' },
      icon('info', 19),
      el(
        'div',
        {},
        el('strong', {}, 'This is signed by the demo key, not by her. '),
        `The policy created here is owned by ${shortAddress(config?.guardian ?? '')}, the local ` +
          `key this server holds, and only that address can later cancel a held transfer. In the ` +
          `product she owns it herself through her Google sign-in — that path signs a risk ` +
          `attestation today and does not yet submit transactions, so it is not wired here. ` +
          `On ${config?.network ?? 'testnet'}, with real gas.`,
      ),
    ),
  );

  const form = el('form', {});
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitSetup();
  });

  // Guardians
  const rows = el('div', { style: 'display:flex;flex-direction:column;gap:9px' });
  setupState.guardians.forEach((value, index) => {
    const row = el('div', { class: 'row' });
    const input = textInput(
      value,
      '0x…',
      Boolean(err('guardians')),
      (next) => {
        setupState.guardians[index] = next;
        if (setupState.touched) renderSetup();
      },
      'mono',
    );
    input.setAttribute('aria-label', `Guardian ${index + 1} address`);
    row.append(input);
    const remove = el('button', { type: 'button', 'aria-label': `Remove guardian ${index + 1}` }, icon('minus', 18));
    remove.disabled = setupState.guardians.length === 1;
    remove.addEventListener('click', () => {
      setupState.guardians.splice(index, 1);
      renderSetup();
    });
    row.append(remove);
    rows.append(row);
  });
  const add = el('button', { type: 'button', class: 'add' }, icon('plus', 17), 'Add another guardian');
  add.addEventListener('click', () => {
    setupState.guardians.push('');
    renderSetup();
  });
  rows.append(add);

  form.append(
    field(
      'Who can stop a transfer',
      'The people she trusts — usually her children. A guardian can stop a transfer and send the ' +
        'money back to her. That is all: nothing in the contract lets a guardian send her money ' +
        'anywhere else, or move it faster than her rules allow.',
      rows,
      err('guardians'),
    ),
  );

  // Threshold
  const threshold = el('input', { type: 'number', min: '1', step: '1', style: 'max-width:140px' });
  threshold.value = setupState.threshold;
  threshold.setAttribute('aria-label', 'Approvals required');
  if (err('threshold')) threshold.setAttribute('aria-invalid', 'true');
  threshold.addEventListener('input', () => {
    setupState.threshold = threshold.value;
    if (setupState.touched) renderSetup();
  });
  form.append(
    field(
      'How many of them have to agree',
      'For one child, one. For two children who both need to say yes, two. Asking for more ' +
        'approvals than she has guardians would leave her money stuck forever, so that is refused.',
      threshold,
      err('threshold'),
    ),
  );

  // Ceilings
  const withUnit = (value: string, placeholder: string, invalid: boolean, onInput: (v: string) => void, label: string) => {
    const wrap = el('div', { class: 'with-unit' });
    const input = textInput(value, placeholder, invalid, onInput);
    input.setAttribute('inputmode', 'decimal');
    input.setAttribute('aria-label', label);
    wrap.append(input, el('span', { class: 'unit' }, unit));
    return wrap;
  };

  const pair = el('div', { class: 'pair' });
  pair.append(
    el(
      'div',
      {},
      el('label', { style: 'display:block;margin-bottom:7px' }, 'Stop and wait from'),
      withUnit(
        setupState.reviewCeiling,
        '100',
        Boolean(err('reviewCeiling')),
        (next) => {
          setupState.reviewCeiling = next;
          if (setupState.touched) renderSetup();
        },
        'Amount at which a transfer waits',
      ),
      err('reviewCeiling') ? el('div', { class: 'field-error', style: 'margin-top:7px' }, icon('alert', 15), err('reviewCeiling')!) : null,
    ),
    el(
      'div',
      {},
      el('label', { style: 'display:block;margin-bottom:7px' }, 'Ask a guardian from'),
      withUnit(
        setupState.highRiskCeiling,
        '500',
        Boolean(err('highRiskCeiling')),
        (next) => {
          setupState.highRiskCeiling = next;
          if (setupState.touched) renderSetup();
        },
        'Amount at which a guardian must approve',
      ),
      err('highRiskCeiling') ? el('div', { class: 'field-error', style: 'margin-top:7px' }, icon('alert', 15), err('highRiskCeiling')!) : null,
    ),
  );
  form.append(
    field(
      'Her own limits',
      `These are enforced by the contract on their own. They hold a large transfer even if the ` +
        `check on her phone saw nothing wrong, was offline, or was tampered with — which is why ` +
        `they matter more than the scam detection does. Amounts are in ${unit}.`,
      pair,
      undefined,
    ),
  );

  // Cooldown
  const cooldown = el('input', { type: 'number', min: '1', step: '1', style: 'max-width:180px' });
  cooldown.value = setupState.cooldownMinutes;
  cooldown.placeholder = '1440';
  cooldown.setAttribute('aria-label', 'Cooling-off period in minutes');
  if (err('cooldownMinutes')) cooldown.setAttribute('aria-invalid', 'true');
  cooldown.addEventListener('input', () => {
    setupState.cooldownMinutes = cooldown.value;
    if (setupState.touched) renderSetup();
  });
  const cooldownMinutes = Number(setupState.cooldownMinutes);
  form.append(
    field(
      'How long a waiting transfer sits still (minutes)',
      'The time she has to change her mind, and the time a guardian has to notice. A day (1440) ' +
        'is a sensible real setting. The seeded demo uses two minutes so the wait can be shown ' +
        'on stage; that is a demo value, not a recommendation.',
      el(
        'div',
        {},
        cooldown,
        Number.isFinite(cooldownMinutes) && cooldownMinutes >= 1
          ? el('p', { class: 'hint', style: 'margin-top:8px' }, `That is ${describeDuration(cooldownMinutes)}.`)
          : null,
      ),
      err('cooldownMinutes'),
    ),
  );

  // Deny list
  form.append(
    field(
      'Community Anti-Scam Registry (On-Chain Database Object)',
      'This is the shared Sui object ID for the master database of reported scammer addresses — NOT an individual scammer wallet. When Mom sends a transfer, her smart contract checks this registry object on-chain automatically.',
      textInput(
        setupState.denyListId,
        '0x…',
        Boolean(err('denyListId')),
        (next) => {
          setupState.denyListId = next;
          if (setupState.touched) renderSetup();
        },
        'mono',
      ),
      err('denyListId'),
    ),
  );

  // Plain-language summary — the review step, always visible once valid.
  if (call) {
    form.append(
      el(
        'div',
        { class: 'card', style: 'margin:0' },
        el('h2', {}, 'What she is agreeing to'),
        el('p', { class: 'sub' }, 'Read this to her before anyone signs anything.'),
        el(
          'ul',
          { class: 'summary' },
          ...describePolicy(call, config?.coinType ?? '').map((line) =>
            el('li', {}, icon('check', 18), el('span', {}, line)),
          ),
        ),
      ),
    );
  }

  if (setupState.serverError) {
    form.append(
      el(
        'div',
        { class: 'notice bad' },
        icon('alert', 19),
        el('div', {}, el('strong', {}, 'The policy was not created. '), setupState.serverError),
      ),
    );
  }

  const submit = el(
    'button',
    { class: 'act primary', type: 'submit', style: 'align-self:flex-start' },
    icon(setupState.submitting ? 'loader' : 'shield'),
    setupState.submitting ? 'Creating on testnet…' : 'Review and create these rules',
  );
  if (setupState.submitting) submit.querySelector('svg')?.classList.add('spin');
  submit.disabled = setupState.submitting;
  form.append(submit);

  host.append(form);
}

async function submitSetup(): Promise<void> {
  setupState.touched = true;
  setupState.serverError = null;
  const { errors, call } = validateSetup();
  if (!call) {
    renderSetup();
    // Move focus to the first thing that is wrong rather than leaving the
    // person to hunt for the red text on a form this long.
    const first = Object.keys(errors)[0];
    if (first) $('setup').querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    return;
  }

  const lines = describePolicy(call, config?.coinType ?? '');
  const fact = el('div', {});
  for (const line of lines.slice(0, 3)) fact.append(el('div', { style: 'margin-bottom:7px' }, line));
  fact.append(
    el(
      'div',
      { style: 'margin-top:10px' },
      `Signed by ${shortAddress(config?.guardian ?? '')} on ${config?.network ?? 'testnet'}. Costs gas.`,
    ),
  );

  const ok = await confirm({
    title: 'Create these rules on-chain?',
    body: 'The rules cannot be edited afterwards. Changing them means creating a new policy and moving her funds to it.',
    fact: [fact],
    confirmLabel: 'Yes, create them',
  });
  if (!ok) return;

  setupState.submitting = true;
  renderSetup();
  try {
    const response = await fetch('/api/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...call, confirm: true }),
    });
    const body = (await response.json()) as { policyId?: string; digest?: string; error?: string };
    if (!response.ok || !body.policyId) {
      throw new Error(body.error ?? `server returned ${response.status}`);
    }
    setupState.result = { policyId: body.policyId, digest: body.digest };
    // The page is now about a different policy, so everything it holds
    // about the old one is stale.
    requestsLoaded = false;
    requests = [];
    await loadConfig();
    await refreshRequests();
  } catch (error) {
    setupState.serverError = error instanceof Error ? error.message : String(error);
  } finally {
    setupState.submitting = false;
    renderSetup();
  }
}

// ---- loading ----

async function loadConfig(): Promise<void> {
  const response = await fetch('/api/config');
  config = (await response.json()) as Config;
  // Prefill what the deployment already knows, so the common case is
  // confirming values rather than hunting for object ids.
  if (!setupState.denyListId) setupState.denyListId = config.denyListId ?? '';
  if (!setupState.guardians[0] && config.guardian) setupState.guardians[0] = config.guardian;
  renderChips();
  renderBanners();
}

function renderChips(): void {
  const chips = document.getElementById('chips');
  if (chips) chips.textContent = '';
  updateDashboardKpis();
}

function updateDashboardKpis(): void {
  const kpiHeld = document.getElementById('kpi-held-amount');
  const kpiHeldSub = document.getElementById('kpi-held-sub');
  const kpiLimit = document.getElementById('kpi-limit');
  const kpiDelay = document.getElementById('kpi-delay');
  const sideGuardian = document.getElementById('sidebar-guardian-addr');
  const widgetGuardian = document.getElementById('widget-guardian-addr');
  const widgetPolicy = document.getElementById('widget-policy-id');

  if (kpiLimit && config?.reviewCeiling) {
    kpiLimit.innerHTML = `$${formatAmount(config.reviewCeiling, config?.coinType ?? '').value} <small>USDC</small>`;
  }
  if (kpiDelay && config?.cooldownMs !== null && config?.cooldownMs !== undefined) {
    kpiDelay.textContent = describeDuration(config.cooldownMs / 60_000);
  }
  if (sideGuardian && config?.guardian) {
    sideGuardian.textContent = shortAddress(config.guardian);
  }
  // Her real balance, or an explicit dash. Never a placeholder figure —
  // this is the number a guardian reads to decide whether a held transfer
  // is a large share of what she has.
  const momBalance = document.getElementById('sidebar-mom-balance');
  if (momBalance) {
    const unit = coinLabel(config?.coinType ?? '');
    if (config?.ownerBalance !== null && config?.ownerBalance !== undefined) {
      momBalance.innerHTML = '';
      momBalance.append(
        document.createTextNode(`$${formatAmount(config.ownerBalance, config.coinType).value} `),
        el('small', { style: 'font-size:12px; color:var(--text-muted); font-family:var(--font-sans);' }, unit),
      );
    } else {
      momBalance.innerHTML = '';
      momBalance.append(
        document.createTextNode('— '),
        el('small', { style: 'font-size:12px; color:var(--text-muted); font-family:var(--font-sans);' }, `${unit} (balance unavailable)`),
      );
    }
  }
  if (widgetGuardian && config?.guardian) {
    widgetGuardian.textContent = config.guardian;
  }
  if (widgetPolicy && config?.policyId) {
    widgetPolicy.textContent = config.policyId;
  }

  if (kpiHeld && kpiHeldSub) {
    const activeRequests = requests.filter((r) => canAct(r.status));
    let totalHeld = 0n;
    for (const req of activeRequests) {
      totalHeld += BigInt(req.amount);
    }
    const totalDisplay = Number(totalHeld) / 1_000_000;
    kpiHeld.innerHTML = `$${totalDisplay.toFixed(2)} <small>USDC</small>`;
    kpiHeldSub.innerHTML =
      activeRequests.length > 0
        ? `<span class="status-dot red"></span> ${activeRequests.length} transfer${activeRequests.length > 1 ? 's' : ''} stopped in escrow`
        : `<span class="status-dot green"></span> Zero suspicious transfers held`;
  }
}

async function refreshRequests(): Promise<void> {
  try {
    const response = await fetch('/api/requests');
    const body = (await response.json()) as {
      requests?: TransferRequestView[];
      threshold?: number;
      reviewCeiling?: string;
      highRiskCeiling?: string;
      nowMs?: number;
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? `server returned ${response.status}`);
    pollFailures = 0;
    requests = body.requests ?? [];
    requestsLoaded = true;
    nowMs = body.nowMs ?? Date.now();
    if (config) {
      if (typeof body.threshold === 'number') config.threshold = body.threshold;
      if (body.reviewCeiling) config.reviewCeiling = body.reviewCeiling;
      if (body.highRiskCeiling) config.highRiskCeiling = body.highRiskCeiling;
    }
    renderBanners();
    renderTransfers();
    updateDashboardKpis();
  } catch (error) {
    pollFailures += 1;
    if (!requestsLoaded) {
      requestsLoaded = true;
      $('list').textContent = '';
      $('list').append(
        emptyState(
          'alert',
          'Could not read the chain.',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    renderBanners();
  }
}

async function loadFlags(): Promise<void> {
  try {
    const response = await fetch('/api/redflags');
    const body = (await response.json()) as { flags?: RedFlagView[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? `server returned ${response.status}`);
    flags = body.flags ?? [];
    flagsError = null;
  } catch (error) {
    flags = null;
    flagsError = error instanceof Error ? error.message : String(error);
  } finally {
    flagsLoaded = true;
    renderFlags();
  }
}

// ---- tabs & views ----

type View = 'transfers' | 'flags' | 'setup' | 'telemetry';

function selectView(next: View): void {
  for (const name of ['transfers', 'flags', 'setup', 'telemetry'] as const) {
    const tab = $(`tab-${name}`);
    if (tab) tab.setAttribute('aria-selected', String(name === next));
    const sideBtn = document.getElementById(`side-${name}`);
    if (sideBtn) sideBtn.classList.toggle('active', name === next);
    const view = $(`view-${name}`);
    if (view) (view as HTMLElement).hidden = name !== next;
  }
  if (next === 'flags' && !flagsLoaded) void loadFlags();
  if (next === 'setup') renderSetup();
}

async function main(): Promise<void> {
  for (const name of ['transfers', 'flags', 'setup', 'telemetry'] as const) {
    $(`tab-${name}`)?.addEventListener('click', () => selectView(name));
    document.getElementById(`side-${name}`)?.addEventListener('click', () => selectView(name));
  }

  // Filter toolbar pills
  document.querySelectorAll<HTMLElement>('.dash-filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.dash-filter-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      activeFilter = pill.getAttribute('data-filter') ?? 'all';
      renderTransfers();
    });
  });

  // Quick action: Report scam address modal
  const reportModal = document.getElementById('report-modal') as HTMLDialogElement | null;
  document.getElementById('btn-quick-report')?.addEventListener('click', () => {
    reportModal?.showModal();
  });
  document.getElementById('report-cancel')?.addEventListener('click', () => {
    reportModal?.close();
  });
  document.getElementById('report-submit')?.addEventListener('click', () => {
    const addrInput = document.getElementById('report-input-addr') as HTMLInputElement | null;
    const reasonInput = document.getElementById('report-input-reason') as HTMLInputElement | null;
    if (!addrInput?.value) {
      addrInput?.focus();
      return;
    }
    reportModal?.close();
    // NOT "recorded on-chain". This handler makes no network call, and
    // `redflag::report` requires an OracleCap this server does not hold
    // (config.canReport is false). Telling a guardian an address was banned
    // when nothing happened is worse than refusing: he stops watching an
    // address he believes is handled. Say what actually occurred.
    showError(
      `Not submitted. ${shortAddress(addrInput.value)} (${reasonInput?.value || 'Malicious Actor'}) ` +
        `was NOT added to the deny list — reporting needs the OracleCap that ` +
        `redflag::report requires, and this server does not hold one. Nothing was sent to the chain.`,
    );
  });

  // Emergency Pause handlers
  const handleEmergencyPause = async () => {
    const ok = await confirm({
      title: "Freeze Mom's Wallet?",
      body:
        'NOT WIRED IN THIS BUILD. policy::pause exists on-chain and the driver ' +
        'can call it, but this dashboard server has no /api/pause route, so ' +
        'confirming here changes nothing on the chain. In the product this ' +
        'pauses all outgoing transfers for 24 hours; anything already held ' +
        'stays in escrow either way.',
      fact: [
        el(
          'div',
          { style: 'display:flex; flex-direction:column; gap:6px;' },
          el('div', {}, el('strong', {}, 'Multisig Scheme: '), 'Weighted Multisig (2·1·1, threshold 2)'),
          el('div', {}, el('strong', {}, 'Target Wallet: '), 'Mom (zkLogin · Weight 2 · Spends alone)'),
          el('div', {}, el('strong', {}, 'Recovery Circle: '), 'Son (Weight 1) + Backup (Weight 1)'),
          el('div', {}, el('strong', {}, 'Emergency Freeze: '), '24 Hours (1,440 min) · Outgoing paused'),
        ),
      ],
      confirmLabel: 'I understand — nothing will happen',
      danger: true,
    });
    if (ok) {
      showError(
        'Nothing was sent to the chain. Her wallet is NOT paused: this button has ' +
          'no server route behind it in this build. To pause for real, call ' +
          'SuiShouClient.pause(policyId, untilMs) from packages/driver.',
      );
    }
  };

  document.getElementById('btn-emergency-pause')?.addEventListener('click', handleEmergencyPause);
  document.getElementById('btn-pause-widget')?.addEventListener('click', handleEmergencyPause);

  // Refresh feed button
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    void refreshRequests();
  });

  // View flags link from widget
  document.getElementById('btn-view-flags-widget')?.addEventListener('click', () => {
    selectView('flags');
  });

  $('footnote').textContent =
    'Approving and stopping are ordinary on-chain calls. A guardian can stop a transfer and send ' +
    'the money back to her, and that is all — there is no call in the contract that redirects her ' +
    'funds to anyone else, including you. This page never shows her messages.';

  renderTransfers();
  try {
    await loadConfig();
  } catch (error) {
    return showError(error instanceof Error ? error.message : String(error));
  }
  await refreshRequests();

  setInterval(() => {
    if (busy || ($('confirm') as HTMLDialogElement).open || reportModal?.open) return;
    void refreshRequests();
  }, 5000);
}

void main();
