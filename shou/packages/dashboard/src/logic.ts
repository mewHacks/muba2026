// Everything the guardian dashboard decides, with no DOM in sight.
//
// It lives apart from app.ts for one reason: these are the functions that
// can be wrong about money. Reading a USDC amount with nine decimals
// shows $5 where $5,000 is meant; mirroring the contract's escalation
// rule incorrectly tells a guardian his mother's own limits held a
// transfer when in fact the model did. Both are testable, so they are
// tested — see logic.test.ts.
//
// Nothing here reaches the network. Every value it works on has already
// been read from the chain by @shou/driver.

import type { RiskTier, TransferRequestView, TransferStatus } from '../../driver/src/types.ts';

// ---- Coins and amounts ----

export interface CoinInfo {
  symbol: string;
  decimals: number;
}

/**
 * USDC has 6 decimals and SUI has 9. Getting this wrong by three places
 * is the difference between approving $5 and approving $5,000, which is
 * the single number this whole screen exists to put in front of someone.
 *
 * Unknown coin types are not guessed at. Falling back to 9 for a coin we
 * have not seen would print a plausible, wrong number — the failure mode
 * that has no symptom. The symbol degrades to the type's own module name
 * and the decimals to null, and callers show the base units instead.
 */
export function coinInfo(coinType: string): CoinInfo | null {
  if (/::usdc::USDC$/i.test(coinType)) return { symbol: 'USDC', decimals: 6 };
  if (/^(0x)?0*2::sui::SUI$/i.test(coinType)) return { symbol: 'SUI', decimals: 9 };
  return null;
}

/** The bare module name, for a coin type we have no decimals for. */
export function coinLabel(coinType: string): string {
  const known = coinInfo(coinType);
  if (known) return known.symbol;
  const parts = coinType.split('::');
  return parts[parts.length - 1] || 'units';
}

export interface FormattedAmount {
  /** Grouped and fixed to the coin's own precision, e.g. "1,250.00". */
  value: string;
  unit: string;
  /** True when the coin type is unknown, so `value` is raw base units. */
  raw: boolean;
}

export function formatAmount(base: string, coinType: string): FormattedAmount {
  const info = coinInfo(coinType);
  const n = BigInt(base || '0');
  if (!info) {
    return { value: n.toLocaleString('en-US'), unit: coinLabel(coinType), raw: true };
  }
  const scale = 10n ** BigInt(info.decimals);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / scale;
  // Two places is what a person reads an amount in. The remaining
  // precision is truncated, never rounded up: rounding 4.999 to 5.00 on a
  // screen next to a $5.00 ceiling would explain a hold that the number
  // shown does not justify.
  const cents = ((abs % scale) * 100n) / scale;
  return {
    value: `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`,
    unit: info.symbol,
    raw: false,
  };
}

/**
 * The inverse, for the setup form: a typed "12.50" into base units.
 *
 * Rejects rather than rounds. A ceiling typed with more precision than
 * the coin can hold is a typo — silently truncating "5.0000001" to
 * "5.00" would set a limit the person did not ask for, and they would
 * find out when a transfer they expected to be held went through.
 */
export function parseAmount(input: string, coinType: string): bigint | { error: string } {
  const info = coinInfo(coinType);
  if (!info) return { error: `Unknown coin type — cannot tell how many decimals ${coinType} has.` };
  const text = input.trim().replace(/,/g, '');
  if (!text) return { error: 'Enter an amount.' };
  if (!/^\d+(\.\d+)?$/.test(text)) return { error: 'Amounts are digits only, like 250 or 250.50.' };
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > info.decimals) {
    return {
      error: `${info.symbol} has ${info.decimals} decimal places; "${text}" has ${fraction.length}.`,
    };
  }
  return BigInt(whole + fraction.padEnd(info.decimals, '0'));
}

// ---- Addresses ----

/**
 * Sui accepts a short address and normalises it, so "0x2" and the padded
 * 64-character form are the same account. Normalising here means a
 * guardian pasted in short form still matches the approver list read back
 * from the chain in long form.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(text)) return null;
  return '0x' + text.slice(2).padStart(64, '0');
}

export function shortAddress(address: string): string {
  return address && address.length > 14
    ? `${address.slice(0, 8)}…${address.slice(-6)}`
    : address || '—';
}

// ---- The contract's own escalation rule, mirrored ----

const TIER_ORDER: RiskTier[] = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * `shou::policy::amount_tier`, in TypeScript. Both comparisons are `>=`,
 * matching the Move exactly: an amount equal to a ceiling is at that
 * tier, not below it.
 *
 * This is a mirror, so it can drift. It is tested against the same
 * boundary cases as tests/policy_tests.move for that reason.
 */
export function amountTier(
  amount: bigint,
  reviewCeiling: bigint,
  highRiskCeiling: bigint,
): RiskTier {
  if (amount >= highRiskCeiling) return 'HIGH';
  if (amount >= reviewCeiling) return 'MEDIUM';
  return 'LOW';
}

export type HoldReason =
  /** Her own amount limits reach this tier on their own. */
  | 'AMOUNT'
  /** The amount alone was fine; the tier came from the submitted risk score. */
  | 'MODEL'
  /** Nothing escalated it. */
  | 'NONE';

/**
 * Who actually held this transfer.
 *
 * The chain stores only the effective tier — `max(amount_tier, claimed)`
 * — so the claimed tier is not recoverable from the object, and
 * `TransferRequested` does not carry it either. What IS recoverable is
 * whether her own ceilings reach the effective tier by themselves. If
 * they do, the hold stands whatever the model said, including if the
 * model said nothing at all. If they do not, the score is the only thing
 * that raised it.
 *
 * That distinction is the entire "the AI's verdict is a floor, never a
 * ceiling" claim, and it is derived rather than asserted.
 */
export function holdReason(
  effectiveTier: RiskTier,
  amount: bigint,
  reviewCeiling: bigint,
  highRiskCeiling: bigint,
): HoldReason {
  if (effectiveTier === 'LOW') return 'NONE';
  const byAmount = amountTier(amount, reviewCeiling, highRiskCeiling);
  return TIER_ORDER.indexOf(byAmount) >= TIER_ORDER.indexOf(effectiveTier) ? 'AMOUNT' : 'MODEL';
}

// ---- Deny list ----

/**
 * `shou::redflag::blocks_amount`, mirrored. Strictly greater than: an
 * amount exactly at the ceiling still goes through, which is what makes
 * the ban soft rather than a cut-off.
 */
export const banBlocksAmount = (banCeiling: bigint, amount: bigint): boolean => amount > banCeiling;

// ---- Presentation ----

export type Band = 'HOLD' | 'WAIT' | 'CLEAR' | 'DONE';

export function bandFor(status: TransferStatus): Band {
  switch (status) {
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

export const BAND_LABEL: Record<Band, string> = {
  HOLD: 'Waiting for you',
  WAIT: 'On hold',
  CLEAR: 'Cleared',
  DONE: 'Finished',
};

/**
 * The label on the badge. Per status rather than per band, because the
 * two resolved statuses share a band and mean opposite things: one is
 * money that reached a stranger and one is money that came back. A badge
 * reading "Finished" over both is the single worst word on this screen.
 */
export function stateLabel(status: TransferStatus): string {
  switch (status) {
    case 'BLOCKED':
      return 'Stopped — refunded';
    case 'EXECUTED':
      return 'Sent';
    default:
      return BAND_LABEL[bandFor(status)];
  }
}

/** Whatever is waiting on him first; resolved history underneath. */
export function sortRequests(requests: TransferRequestView[]): TransferRequestView[] {
  const order: Band[] = ['HOLD', 'WAIT', 'CLEAR', 'DONE'];
  return [...requests].sort(
    (a, b) =>
      order.indexOf(bandFor(a.status)) - order.indexOf(bandFor(b.status)) ||
      (b.requestedAtMs ?? 0) - (a.requestedAtMs ?? 0),
  );
}

/** Blocking is available right up until the funds actually leave. */
export const canAct = (status: TransferStatus): boolean =>
  status !== 'EXECUTED' && status !== 'BLOCKED';

export function timeAgo(ms: number | null, nowMs: number): string {
  if (!ms) return 'just now';
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function countdown(unlockAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((unlockAtMs - nowMs) / 1000));
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/** Plain English for a duration typed in minutes, for the setup summary. */
export function describeDuration(minutes: number): string {
  if (minutes < 1) return 'no wait at all';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (hours < 24) {
    return Number.isInteger(hours)
      ? `${hours} hour${hours === 1 ? '' : 's'}`
      : `${hours.toFixed(1)} hours`;
  }
  const days = hours / 24;
  return Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${days.toFixed(1)} days`;
}

/** The one-line answer to "what am I looking at". */
export function headline(request: TransferRequestView, nowMs: number): string {
  switch (request.status) {
    case 'NEEDS_APPROVAL':
      return 'The money has stopped and is waiting for you.';
    case 'APPROVED':
      return 'You approved this. The money is released and can now be sent.';
    case 'AUTO_UNLOCK_SCHEDULED':
      return `Sitting still for ${countdown(request.unlockAtMs, nowMs)} before it can go.`;
    case 'PENDING':
      return 'Nothing held this one up. It is clear to send.';
    case 'BLOCKED':
      return 'This was stopped, and the money went back to her.';
    case 'EXECUTED':
      return 'This one went through.';
    default:
      return '';
  }
}

/**
 * The line that actually decides behaviour: what happens if he closes the
 * tab. A guardian who thinks inaction means "approved" will do nothing on
 * purpose; one who thinks it means "she is stuck" will answer. Both
 * readings are wrong unless the screen says which it is.
 */
export function consequence(request: TransferRequestView, threshold: number | null): string {
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

// ---- Policy setup validation ----

export interface PolicyFormInput {
  guardians: string[];
  threshold: string;
  reviewCeiling: string;
  highRiskCeiling: string;
  cooldownMinutes: string;
  denyListId: string;
  coinType: string;
}

export interface PolicyFormResult {
  /** Field name -> the problem, in the words the person needs. */
  errors: Record<string, string>;
  /** Present only when `errors` is empty: exactly what goes to the chain. */
  call?: {
    approvers: string[];
    threshold: number;
    cooldownMs: number;
    denyListId: string;
    reviewCeiling: string;
    highRiskCeiling: string;
  };
}

/**
 * Every rule the contract enforces, checked before anyone pays gas to
 * discover it. `new_policy` aborts on each of these — ETooFewApprovers,
 * EThresholdTooLow, EThresholdTooHigh, ECeilingsInverted — and a Move
 * abort reaches a browser as an opaque failure, so the form has to be the
 * thing that explains it.
 *
 * The two rules the contract does NOT enforce but a person needs are
 * checked too: a duplicate guardian would silently make a 2-of-2 policy
 * satisfiable by one person, and a zero cooldown would make the MEDIUM
 * tier release the instant it is created.
 */
export function validatePolicyForm(input: PolicyFormInput): PolicyFormResult {
  const errors: Record<string, string> = {};

  const entered = input.guardians.map((g) => g.trim()).filter(Boolean);
  const approvers: string[] = [];
  if (!entered.length) {
    errors.guardians = 'Name at least one person who can stop a transfer.';
  }
  for (const raw of entered) {
    const address = normalizeAddress(raw);
    if (!address) {
      errors.guardians = `"${raw}" is not a Sui address. They start with 0x and are hex digits.`;
      break;
    }
    if (approvers.includes(address)) {
      errors.guardians = `${shortAddress(address)} is listed twice. Two entries for one person do not make two approvals.`;
      break;
    }
    approvers.push(address);
  }

  const threshold = Number(input.threshold);
  if (!Number.isInteger(threshold) || threshold < 1) {
    errors.threshold = 'At least one person has to approve.';
  } else if (approvers.length && threshold > approvers.length) {
    errors.threshold = `You have ${approvers.length} guardian${approvers.length === 1 ? '' : 's'}, so ${threshold} approvals can never be reached — her money would be stuck.`;
  }

  const cooldownMinutes = Number(input.cooldownMinutes);
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 1) {
    errors.cooldownMinutes = 'The wait has to be at least a minute, or it is not a wait.';
  } else if (cooldownMinutes > 60 * 24 * 30) {
    errors.cooldownMinutes = 'A wait longer than 30 days locks her out of her own money.';
  }

  const review = parseAmount(input.reviewCeiling, input.coinType);
  if (typeof review !== 'bigint') errors.reviewCeiling = review.error;
  else if (review <= 0n) errors.reviewCeiling = 'Must be more than zero.';

  const high = parseAmount(input.highRiskCeiling, input.coinType);
  if (typeof high !== 'bigint') errors.highRiskCeiling = high.error;
  else if (high <= 0n) errors.highRiskCeiling = 'Must be more than zero.';

  if (typeof review === 'bigint' && typeof high === 'bigint' && review > high) {
    errors.highRiskCeiling =
      'The amount that needs approval has to be at least the amount that waits — otherwise the wait never applies.';
  }

  const denyListId = normalizeAddress(input.denyListId);
  if (!denyListId) {
    errors.denyListId = 'A deny list object id is required, and this is not one.';
  }

  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    call: {
      approvers,
      threshold,
      cooldownMs: Math.round(cooldownMinutes * 60_000),
      denyListId: denyListId!,
      reviewCeiling: (review as bigint).toString(),
      highRiskCeiling: (high as bigint).toString(),
    },
  };
}

/**
 * The plain-language summary shown before anything is signed. Written for
 * the two people in the room — the elder and the family member helping
 * her — so every line is about what happens to her money, not about
 * tiers, ceilings or thresholds.
 */
export function describePolicy(
  call: NonNullable<PolicyFormResult['call']>,
  coinType: string,
): string[] {
  const unit = coinLabel(coinType);
  const review = formatAmount(call.reviewCeiling, coinType);
  const high = formatAmount(call.highRiskCeiling, coinType);
  const wait = describeDuration(call.cooldownMs / 60_000);
  const people = call.approvers.length;
  return [
    `Anything under ${review.value} ${unit} goes straight through, with no wait and nobody asked.`,
    `From ${review.value} ${unit} up to ${high.value} ${unit}, the money waits ${wait} before it can go. She can cancel it in that time, and so can a guardian.`,
    `${high.value} ${unit} and above will not move until ${call.threshold} of her ${people} guardian${people === 1 ? '' : 's'} say yes.`,
    `A guardian can stop a transfer and send the money back to her. There is no way for a guardian to send it anywhere else, or to make a transfer happen faster than these rules allow.`,
    `She can cancel any held transfer herself at any time, without asking anyone.`,
  ];
}
