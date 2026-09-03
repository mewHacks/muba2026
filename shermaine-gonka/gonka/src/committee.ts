import { callGonka, MODELS, parseLenientJson, clampScore, type GonkaCall } from "./gonka.js";
import { redact } from "./redact.js";
import { indicators, transactionAnomaly, fuse, tierFor, contractAction, applyDegradedFloor } from "./rules.js";
import { buildAttestation, messageCommitment } from "./attestation.js";
import type { RiskAssessment, TraceStep, TxContext, Language, Reason } from "./types.js";

/**
 * SHOU scoring pipeline.
 *
 *   1. Redact locally.
 *   2. Deterministic transaction anomaly + keyword indicators (no model, no latency).
 *   3. TWO models cross-verify the SAME redacted message, SEQUENTIALLY, under a shared
 *      deadline:
 *        - classifier (DeepSeek): what kind of scam is this, and the warning to show?
 *        - verifier   (MiniMax):  adversarial second opinion - is there an innocent reading?
 *      Because they see identical evidence, a gap between them is genuine disagreement.
 *   4. Deterministic fusion. CODE computes the final score, with floors no model can lower.
 *
 * Sequential, not parallel, and this is not a style choice. Firing both at once returns
 * HTTP 429 "too many concurrent requests for this account", and when it does not 429 the
 * router throttles instead: the same DeepSeek call that takes 2.5s alone took 17.5s when
 * issued alongside one other request. Parallelism on this account buys nothing and costs
 * roughly 7x. So the calls are serialised and share a wall-clock budget.
 *
 * There is no third call. The classifier writes the plain-language explanation and its
 * translation in the same response that carries its score, which costs nothing measurable
 * (median 6.8s combined vs 6.2s for scoring alone) and removes a serial leg that was
 * costing ~20s on its own.
 *
 * Why the explanation rides on the FAST model: when the slower verifier times out we
 * still have a score, a category AND something to show the user. If the explanation
 * lived on the slow model, losing it would leave the screen blank at the worst moment.
 *
 * Two earlier designs, both wrong, kept for the record:
 *   - One model scored the message and another scored the transaction, and their gap was
 *     called "agreement". They measured different things, so it never meant anything.
 *   - A third model adjudicated conflicts within a bounded band. That made "code owns the
 *     number" almost-but-not-quite true. Code owns it outright now; a conflict lowers
 *     confidence and is reported, but never moves the score.
 */

const LANG_NAME: Record<Language, string> = {
  en: "English", ms: "Bahasa Malaysia", zh: "Simplified Chinese", ta: "Tamil",
};

const CONFLICT_THRESHOLD = 30;

// Measured budgets. The classifier writes more tokens so it gets more room; the
// verifier is deliberately terse because a long MiniMax reply is a slow MiniMax reply
// (median 19.6s verbose vs 8.6s terse). 250 tokens is the floor that still yields
// parseable JSON - at 150 it truncates mid-object.
const CLASSIFIER_BUDGET = { maxTokens: 700, retries: 0 };
// 1200, not 250. MiniMax is a reasoning model and emits a <think> block whatever the
// prompt says; starved of tokens it never reaches the JSON at all. Measured with room to
// finish it is accurate (otp 100, macau 95, bill 15, son 10 - all correct). Starved it
// returned nothing, which used to be read as a score of 0. Better to spend the tokens and
// let the deadline drop the call than to accept a confident wrong answer.
const VERIFIER_BUDGET = { maxTokens: 1200, retries: 0 };

// Total wall-clock the models may consume. The whole assessment must land inside the
// demo budget, so this is a deadline, not a per-call timeout.
const MODEL_DEADLINE_MS = 14000;
// Below this much remaining, the second opinion cannot realistically land, so we skip it
// and say so rather than burn the budget and return nothing.
const MIN_VERIFIER_MS = 4000;

const classifierSystem = (lang: Language) => `You identify scams aimed at elderly people in
Malaysia, and you write the warning the person will actually read.

Patterns to know: Macau scam (caller impersonates PDRM, LHDN, Bank Negara, customs or the
courts), parcel/customs fee scam, love scam, fake investment with guaranteed returns,
fake loan approval with an upfront fee, impersonated family ("hi mum, new number"),
and any request for an OTP, TAC, password, seed phrase or private key.

You see only a message. Personal details were already replaced with tokens like [PHONE]
or [ACCOUNT]; those are our redactions, not evidence of anything.

The explanation is for a 70-year-old. ONE short sentence. No jargon, no percentages, no
talk of models, scores or AI. Say plainly what looks wrong and what happens to the money.

Reply with JSON only, no reasoning:
{"score":0-100,"category":"snake_case_or_none","indicators":["short factual observation"],
"explanation":"one plain sentence in English",
"explanationLocalised":"the same sentence in ${LANG_NAME[lang]}","abstain":false}
Set abstain to true only if the text is empty or unintelligible.`;

// Terse on purpose: see VERIFIER_BUDGET.
const VERIFIER_SYSTEM = `You are a skeptical second reviewer checking a possible scam report.

Another analyst has already looked at this message; you cannot see their answer. Reach your
own conclusion, and specifically look for the INNOCENT explanation. Ordinary life contains
urgent messages, bills, and real family asking for money. Flagging a real utility bill or a
genuine relative is a costly mistake. Only score high if it would still look like a scam to
a careful person.

score means HOW LIKELY THIS IS A SCAM: 0 is certainly harmless, 100 is certainly a scam.
Do not invert it. A real utility bill scores near 0; an OTP request scores near 100.

Reply with JSON and nothing else. Do not think step by step. Do not emit <think> tags.
{"score":0-100,"innocentExplanation":"<=12 words, or none","abstain":false}`;

function traceOf(
  role: TraceStep["role"],
  roleLabel: string,
  call: GonkaCall,
  finding: string,
  score?: number,
): TraceStep {
  return {
    role, roleLabel,
    requestedModel: call.requestedModel,
    servedModel: call.servedModel,
    substituted: call.substituted,
    score, finding: finding || "(no finding returned)",
    gonkaRequestId: call.requestId,
    receiptUrl: call.receiptUrl,
    latencyMs: call.latencyMs,
  };
}

function failedTrace(role: TraceStep["role"], roleLabel: string, model: string, err: unknown): TraceStep {
  return {
    role, roleLabel, requestedModel: model, servedModel: "none", substituted: false,
    finding: "Model unavailable - this signal was dropped and confidence lowered.",
    gonkaRequestId: "unavailable", receiptUrl: "", latencyMs: 0,
    error: err instanceof Error ? err.message : String(err),
  };
}

export interface AssessInput {
  message: string;
  tx: TxContext;
  language?: Language;
  policyId?: string;
  sender?: string;
  recipient?: string;
  cooldownHours?: number;
}

export async function assess(input: AssessInput): Promise<RiskAssessment> {
  const startedAt = Date.now();
  const language = input.language ?? "en";

  // 1. redact locally
  const redaction = redact(input.message ?? "");
  const message = redaction.text;
  const hasMessage = message.trim().length > 0;

  // 2. deterministic
  const ind = indicators(message);
  const txAnomaly = transactionAnomaly(input.tx);

  // 3. two models, same evidence, one after the other, sharing a deadline.
  const settle = async (model: string, system: string, budget: { maxTokens: number; retries: number }, timeoutMs: number) => {
    try {
      return { ok: true as const, call: await callGonka(model, system, `Message:\n"""${message}"""`, { ...budget, timeoutMs }) };
    } catch (err) {
      return { ok: false as const, err };
    }
  };

  const deadline = startedAt + MODEL_DEADLINE_MS;
  const remaining = () => deadline - Date.now();

  const clsRes = hasMessage
    ? await settle(MODELS.classifier, classifierSystem(language), CLASSIFIER_BUDGET, Math.max(1000, remaining()))
    : null;

  // The second opinion is best-effort. It runs only if enough of the budget survives the
  // classifier, because a cross-verification that arrives after the deadline is worth
  // less than a verdict that arrives on time.
  const verifierBudgetMs = remaining();
  const verifierSkipped = hasMessage && verifierBudgetMs < MIN_VERIFIER_MS;
  const verRes = hasMessage && !verifierSkipped
    ? await settle(MODELS.verifier, VERIFIER_SYSTEM, VERIFIER_BUDGET, verifierBudgetMs)
    : null;

  const traces: TraceStep[] = [];
  const modelReasons: Reason[] = [];

  let classifierScore: number | null = null;
  let category = "none";
  let explanation = "";
  let explanationLocalised = "";

  if (clsRes) {
    if (clsRes.ok) {
      const v = parseLenientJson<any>(clsRes.call.text);
      if (!v.abstain) {
        classifierScore = clampScore(v.score);
        category = v.category ?? "none";
        explanation = v.explanation ?? "";
        explanationLocalised = v.explanationLocalised || explanation;
        (v.indicators ?? []).slice(0, 3).forEach((t: string, i: number) =>
          modelReasons.push({ code: `CLASSIFIER_${i}`, severity: 0, safeText: String(t), source: "message_model" }));
      }
      traces.push(traceOf("classifier", "Classifier - what kind of scam is this?", clsRes.call,
        (v.indicators ?? []).join(" \u00b7 "), classifierScore ?? undefined));
    } else {
      traces.push(failedTrace("classifier", "Classifier", MODELS.classifier, clsRes.err));
    }
  }

  let verifierScore: number | null = null;
  if (verRes) {
    if (verRes.ok) {
      const v = parseLenientJson<any>(verRes.call.text);
      if (!v.abstain) {
        verifierScore = clampScore(v.score);
        if (v.innocentExplanation && String(v.innocentExplanation).toLowerCase() !== "none") {
          modelReasons.push({
            code: "INNOCENT_READING", severity: 0,
            safeText: `Possible harmless explanation: ${v.innocentExplanation}`,
            source: "verifier_model",
          });
        }
      }
      traces.push(traceOf("verifier", "Verifier - is there an innocent explanation?", verRes.call,
        v.innocentExplanation ? `Innocent reading: ${v.innocentExplanation}` : "(no innocent reading offered)",
        verifierScore ?? undefined));
    } else {
      traces.push(failedTrace("verifier", "Verifier", MODELS.verifier, verRes.err));
    }
  }

  // 4. code owns the number, outright. A conflict is reported and lowers confidence;
  //    it never moves the score.
  const fused = fuse({ classifierScore, verifierScore, transactionScore: txAnomaly.score, indicators: ind });

  const delta = classifierScore !== null && verifierScore !== null
    ? Math.abs(classifierScore - verifierScore) : null;
  const conflicted = delta !== null && delta > CONFLICT_THRESHOLD;

  const anyModelScored = classifierScore !== null || verifierScore !== null;
  const riskScore = applyDegradedFloor(fused.riskScore, anyModelScored);
  const heldForReview = riskScore !== fused.riskScore;

  const tier = tierFor(riskScore);

  if (!explanation) {
    explanation = tier === "HIGH"
      ? "This transfer looks like a scam, so the money is being held until a guardian checks it."
      : tier === "MEDIUM"
        ? "Something about this transfer is unusual, so it is being held for a short while."
        : "Nothing unusual about this transfer.";
    explanationLocalised = explanation;
  }

  const reasons = [...ind.reasons, ...txAnomaly.reasons, ...modelReasons]
    .sort((a, b) => b.severity - a.severity);

  const attestation = buildAttestation({
    policyId: input.policyId ?? "0xPOLICY_NOT_SET",
    sender: input.sender ?? "0xSENDER_NOT_SET",
    recipient: input.recipient ?? input.tx.recipientLabel,
    amountMYR: input.tx.amountMYR,
    tier,
    message,
  });

  const anyModelRan = traces.some((t) => !t.error);
  const substituted = traces.filter((t) => t.substituted).map((t) => t.requestedModel);

  const degradedParts: string[] = [];
  if (!hasMessage) degradedParts.push("No message supplied - scored on transaction signals alone.");
  if (!anyModelRan) degradedParts.push("Gonka was unreachable - deterministic rules only.");
  else if (!anyModelScored) degradedParts.push("No model returned a usable verdict - deterministic rules only.");
  else if (classifierScore === null) degradedParts.push("The classifier did not answer in time; scored without it.");
  else if (verifierSkipped) degradedParts.push("No budget left for a second opinion, so this was not cross-verified.");
  else if (verifierScore === null) degradedParts.push("The second model did not answer in time, so this was not cross-verified.");
  if (heldForReview) degradedParts.push("Held for review rather than released, because no model was available to clear it.");
  if (conflicted) degradedParts.push(`The two models disagreed by ${delta} points; confidence lowered.`);
  if (substituted.length) degradedParts.push(`Router served a different model than requested for: ${substituted.join(", ")}.`);

  return {
    // fields Dev A's driver already expects
    tier,
    truthScore: riskScore,
    requestId: traces.find((t) => t.gonkaRequestId !== "unavailable")?.gonkaRequestId ?? "unavailable",
    category,
    messageHash: messageCommitment(message),

    riskScore,
    confidence: fused.confidence,
    reasons,
    explanation,
    explanationLocalised,
    language,

    crossVerification: { classifierScore, verifierScore, delta, conflicted, adjudicated: false },
    deterministic: {
      transactionScore: txAnomaly.score,
      indicatorFloor: ind.floor,
      hardFloorFired: ind.hardFloor,
    },

    traces,
    attestation,
    contractAction: contractAction(tier, input.cooldownHours ?? 12),
    redactedInput: message,
    redactedCount: redaction.count,
    latencyMs: Date.now() - startedAt,
    degraded: degradedParts.length ? degradedParts.join(" ") : undefined,
  };
}
