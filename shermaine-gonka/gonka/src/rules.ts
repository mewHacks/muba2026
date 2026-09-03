import type { TxContext, ContractAction, RiskTier, Reason } from "./types.js";

/**
 * Deterministic layer. Owns two jobs the models should never have had:
 *
 *   1. Transaction anomaly scoring. This is arithmetic - amount against the user's
 *      normal range, recipient novelty, velocity, hour of day. Asking an LLM to do
 *      it was slower, costlier, non-deterministic and no more accurate.
 *
 *   2. Final score fusion. Code computes the number. Models supply evidence and
 *      language; they never own the verdict.
 *
 * Hard indicators impose FLOORS that no model can lower.
 */

export const POLICY_VERSION = "shou-policy-v2";

// ---------- weights ----------
// Message risk dominates because scams are social first, financial second, but a
// transaction that is anomalous on its own can still reach MEDIUM with no message.
const W = { classifier: 0.35, verifier: 0.2, transaction: 0.25, indicators: 0.2 };

// ---------- lexicons ----------
const URGENCY = [
  "immediately", "right now", "within the hour", "urgent", "last chance",
  "sekarang juga", "segera", "cepat", "dalam masa",
  "马上", "立刻", "尽快", "限时",
];
const AUTHORITY = [
  "pdrm", "police", "polis", "警察", "lhdn", "inland revenue", "bank negara", "bnm",
  "court", "mahkamah", "法院", "传票", "saman", "warrant", "waran",
  "kastam", "customs", "imigresen", "immigration", "nsrc", "sspn",
];
const SECRECY = [
  "do not tell", "don't tell", "jangan beritahu", "jangan bagitahu",
  "别告诉", "不要告诉", "keep this confidential", "rahsia", "保密", "secret investigation",
];
const CREDENTIAL = [
  "otp", "one-time password", "tac", "kod tac", "verification code", "验证码",
  "seed phrase", "recovery phrase", "private key", "password", "kata laluan", "密码", "助记词",
];
const LURE = [
  "guaranteed return", "pulangan terjamin", "保本", "保证收益", "double your money",
  "investment opportunity", "peluang pelaburan", "投资机会",
  "you have won", "anda menang", "中奖", "lucky draw", "cabutan bertuah",
  "parcel", "bungkusan", "包裹", "customs fee", "clearance fee",
];

const hits = (h: string, needles: string[]) => needles.filter((n) => h.includes(n));

export interface IndicatorResult {
  score: number;
  reasons: Reason[];
  /** Set when a floor fired that models are not permitted to argue down. */
  hardFloor: string | null;
  floor: number;
}

/**
 * Keyword indicators. Deliberately conservative: these exist so that if every model
 * has a bad moment in front of a judge, an obvious scam is still caught.
 */
export function indicators(message: string): IndicatorResult {
  const m = message.toLowerCase();
  const reasons: Reason[] = [];
  let score = 0;
  let hardFloor: string | null = null;
  let floor = 0;

  const u = hits(m, URGENCY);
  const a = hits(m, AUTHORITY);
  const s = hits(m, SECRECY);
  const c = hits(m, CREDENTIAL);
  const l = hits(m, LURE);

  const add = (code: string, severity: number, safeText: string) => {
    reasons.push({ code, severity, safeText, source: "deterministic" });
    score += severity;
  };

  if (u.length) add("URGENCY", 20, "The message pressures you to act immediately.");
  if (a.length) add("AUTHORITY_CLAIM", 25, "The sender claims to be from an authority such as the police, LHDN or a court.");
  if (s.length) add("SECRECY", 25, "You are being told to keep this from your family.");
  if (l.length) add("FINANCIAL_LURE", 20, "The message promises money, a prize or a parcel.");
  if (c.length) add("CREDENTIAL_REQUEST", 40, "Someone is asking for a code, password or recovery phrase. No real institution ever does this.");

  // Hard floors. A model cannot talk these down.
  if (c.length) {
    hardFloor = "CREDENTIAL_REQUEST";
    floor = 85;
  } else if (a.length && u.length && s.length) {
    hardFloor = "AUTHORITY_URGENCY_SECRECY";
    floor = 80; // the classic Macau-scam signature
  } else if (a.length && u.length) {
    hardFloor = "AUTHORITY_URGENCY";
    floor = 70;
  }

  return { score: Math.min(100, score), reasons, hardFloor, floor };
}

/** Pure arithmetic. No model involved, no latency, no variance. */
export function transactionAnomaly(tx: TxContext): { score: number; reasons: Reason[] } {
  const reasons: Reason[] = [];
  let score = 0;
  const add = (code: string, severity: number, safeText: string) => {
    reasons.push({ code, severity, safeText, source: "deterministic" });
    score += severity;
  };

  const ratio = tx.usualMaxMYR > 0 ? tx.amountMYR / tx.usualMaxMYR : tx.amountMYR > 0 ? 99 : 0;

  if (ratio >= 10) add("AMOUNT_EXTREME", 40, `This is about ${Math.round(ratio)} times larger than anything you normally send.`);
  else if (ratio >= 3) add("AMOUNT_HIGH", 25, `This is about ${Math.round(ratio)} times your usual maximum.`);
  else if (ratio >= 1.5) add("AMOUNT_ABOVE_NORMAL", 10, "This is above your usual spending.");

  if (tx.recipientIsNew) {
    add("NEW_RECIPIENT", tx.amountMYR > 1000 ? 30 : 15, "You have never sent money to this recipient before.");
  }
  if (tx.transfersLastHour >= 3) add("VELOCITY", 20, `${tx.transfersLastHour} transfers in the last hour.`);
  if (tx.localHour >= 23 || tx.localHour < 6) add("ODD_HOUR", 10, "This transfer is happening in the middle of the night.");

  return { score: Math.min(100, score), reasons };
}

export interface FusionInput {
  classifierScore: number | null;
  verifierScore: number | null;
  transactionScore: number;
  indicators: IndicatorResult;
}

/** Code owns the number. Models contribute evidence, never the verdict. */
export function fuse(input: FusionInput): { riskScore: number; confidence: number } {
  const { classifierScore, verifierScore, transactionScore, indicators: ind } = input;

  // Redistribute the weight of any model that failed or abstained, so an outage
  // degrades the score's confidence rather than silently dragging it toward zero.
  const parts: Array<[number, number]> = [];
  if (classifierScore !== null) parts.push([classifierScore, W.classifier]);
  if (verifierScore !== null) parts.push([verifierScore, W.verifier]);
  parts.push([transactionScore, W.transaction]);
  parts.push([ind.score, W.indicators]);

  const totalWeight = parts.reduce((acc, [, w]) => acc + w, 0);
  const weighted = parts.reduce((acc, [v, w]) => acc + v * w, 0) / totalWeight;

  const riskScore = Math.round(Math.max(weighted, ind.floor));

  // Confidence falls when models are missing or when they disagree with each other.
  let confidence = 100;
  if (classifierScore === null) confidence -= 30;
  if (verifierScore === null) confidence -= 20;
  if (classifierScore !== null && verifierScore !== null) {
    confidence -= Math.min(35, Math.abs(classifierScore - verifierScore));
  }
  // A hard floor is a rule, not a guess, so it restores confidence.
  if (ind.hardFloor) confidence = Math.max(confidence, 85);

  return { riskScore: Math.min(100, Math.max(0, riskScore)), confidence: Math.max(0, confidence) };
}

export const tierFor = (score: number): RiskTier =>
  score >= 70 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW";

export const TIER_CODE: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Mirrors shou::policy exactly as the Move module is written today:
 *  - LOW      unlock_at = now, executes immediately
 *  - MEDIUM   unlock_at = now + cooldown; any approver may block_and_refund
 *  - HIGH     released only by `threshold` approvals; time alone never releases it
 *
 * Guardians can stop a transfer and refund the owner. They cannot redirect it,
 * cannot take it, and cannot approve a MEDIUM one faster.
 */
export function contractAction(tier: RiskTier, cooldownHours = 12): ContractAction {
  if (tier === "HIGH") {
    return {
      action: "GUARDIAN_APPROVAL",
      cooldownHours: 0,
      guardianNotified: true,
      ruleFired:
        "High risk. Funds are locked and stay locked until a guardian approves. A guardian may instead cancel it, which refunds the owner. Time alone does not release it.",
    };
  }
  if (tier === "MEDIUM") {
    return {
      action: "COOLDOWN",
      cooldownHours,
      guardianNotified: true,
      ruleFired: `Elevated risk. Locked for ${cooldownHours} hours, guardians notified. If nobody cancels it, it releases automatically.`,
    };
  }
  return {
    action: "EXECUTE",
    cooldownHours: 0,
    guardianNotified: false,
    ruleFired: "Within normal spending. Executes immediately, no guardian involved.",
  };
}
