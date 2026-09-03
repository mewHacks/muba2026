import { callGonka, MODELS, parseLenientJson, clampScore, type GonkaCall } from "./gonka.js";
import { redact } from "./redact.js";
import { indicators, transactionAnomaly, fuse, tierFor, contractAction } from "./rules.js";
import { buildAttestation, messageCommitment } from "./attestation.js";
import type { RiskAssessment, TraceStep, TxContext, Language, Reason } from "./types.js";

/**
 * SHOU scoring pipeline.
 *
 *   1. Redact locally.
 *   2. Deterministic transaction anomaly + keyword indicators (no model, no latency).
 *   3. TWO models cross-verify the SAME redacted message, independently and in parallel:
 *        - classifier (DeepSeek): what kind of scam is this, if any?
 *        - verifier   (Kimi):     adversarial second opinion - is there an innocent reading?
 *      Because they see identical evidence, a gap between them is genuine disagreement.
 *      This is what Gonka's brief means by multi-model cross-verification.
 *   4. Deterministic fusion. CODE computes the final score, with floors models can't lower.
 *   5. Explainer (MiniMax): plain-language sentence + the user's language. It never
 *      sets the score. When the two verifiers conflict, it also adjudicates - and even
 *      then it may only nudge within a bounded band.
 *
 * An earlier version had one model score the message and another score the transaction,
 * then called their gap "agreement". That was wrong: they were measuring different
 * things, so a high message score and a low transaction score was never disagreement.
 */

const LANG_NAME: Record<Language, string> = {
  en: "English", ms: "Bahasa Malaysia", zh: "Simplified Chinese", ta: "Tamil",
};

const CONFLICT_THRESHOLD = 30;
const ADJUDICATION_BAND = 15; // most the explainer may move the fused score

const CLASSIFIER_SYSTEM = `You identify scams aimed at elderly people in Malaysia.

Patterns to know: Macau scam (caller impersonates PDRM, LHDN, Bank Negara, customs or the
courts), parcel/customs fee scam, love scam, fake investment with guaranteed returns,
fake loan approval with an upfront fee, impersonated family ("hi mum, new number"),
and any request for an OTP, TAC, password, seed phrase or private key.

You see only a message. Personal details were already replaced with tokens like [PHONE]
or [ACCOUNT]; those are our redactions, not evidence of anything.

Reply with JSON only:
{"score":0-100,"category":"snake_case_or_none","indicators":["short factual observation"],"abstain":false}
Set abstain to true only if the text is empty or unintelligible.`;

const VERIFIER_SYSTEM = `You are a skeptical second reviewer checking a possible scam report.

Another analyst has already looked at this message; you cannot see their answer. Your job
is to reach your own conclusion, and specifically to look for the INNOCENT explanation.
Ordinary life contains urgent messages, bills, and requests for money from real family.
Flagging a real utility bill or a genuine relative is a costly mistake.

Only give a high score if the message would still look like a scam to a careful person.

Reply with JSON only:
{"score":0-100,"innocentExplanation":"the most plausible harmless reading, or none","concerns":["short observation"],"abstain":false}`;

const explainerSystem = (lang: Language, adjudicating: boolean) => `You write the message an
elderly person will actually read, and you never invent numbers.

${adjudicating
  ? `The two reviewers disagreed. Say which reading you find more credible and why, in one clause.`
  : `The reviewers broadly agreed.`}

Write for a 70-year-old. One sentence. No jargon, no percentages, no talk of models,
scores or AI. Say plainly what looks wrong and what happens to the money next.

Reply with JSON only:
{${adjudicating ? `"adjustedScore":0-100,` : ""}"explanation":"one plain sentence in English","explanationLocalised":"the same sentence in ${LANG_NAME[lang]}"}`;

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

  // 3. two models, same evidence, in parallel
  const settle = async (model: string, system: string) => {
    try {
      return { ok: true as const, call: await callGonka(model, system, `Message:\n"""${message}"""`) };
    } catch (err) {
      return { ok: false as const, err };
    }
  };

  const [clsRes, verRes] = hasMessage
    ? await Promise.all([
        settle(MODELS.classifier, CLASSIFIER_SYSTEM),
        settle(MODELS.verifier, VERIFIER_SYSTEM),
      ])
    : [null, null];

  const traces: TraceStep[] = [];
  const modelReasons: Reason[] = [];

  let classifierScore: number | null = null;
  let category = "none";
  if (clsRes) {
    if (clsRes.ok) {
      const v = parseLenientJson<any>(clsRes.call.text);
      if (!v.abstain) {
        classifierScore = clampScore(v.score);
        category = v.category ?? "none";
        (v.indicators ?? []).slice(0, 3).forEach((t: string, i: number) =>
          modelReasons.push({ code: `CLASSIFIER_${i}`, severity: 0, safeText: String(t), source: "message_model" }));
      }
      traces.push(traceOf("classifier", "Classifier - what kind of scam is this?", clsRes.call,
        (v.indicators ?? []).join(" · "), classifierScore ?? undefined));
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
        v.innocentExplanation ? `Innocent reading: ${v.innocentExplanation}` : (v.concerns ?? []).join(" · "),
        verifierScore ?? undefined));
    } else {
      traces.push(failedTrace("verifier", "Verifier", MODELS.verifier, verRes.err));
    }
  }

  // 4. code owns the number
  const fused = fuse({ classifierScore, verifierScore, transactionScore: txAnomaly.score, indicators: ind });

  const delta = classifierScore !== null && verifierScore !== null
    ? Math.abs(classifierScore - verifierScore) : null;
  const conflicted = delta !== null && delta > CONFLICT_THRESHOLD;

  // 5. explain (and adjudicate only when they genuinely conflicted)
  let riskScore = fused.riskScore;
  let explanation = "";
  let explanationLocalised = "";
  let adjudicated = false;

  try {
    const expCall = await callGonka(
      MODELS.explainer,
      explainerSystem(language, conflicted),
      JSON.stringify({
        classifier: { score: classifierScore, category },
        verifier: { score: verifierScore },
        deterministic: {
          transactionScore: txAnomaly.score,
          indicatorScore: ind.score,
          hardFloor: ind.hardFloor,
          reasons: [...ind.reasons, ...txAnomaly.reasons].map((r) => r.safeText),
        },
        fusedScore: fused.riskScore,
        outcome: contractAction(tierFor(fused.riskScore), input.cooldownHours ?? 12).ruleFired,
      }, null, 2),
    );
    const v = parseLenientJson<any>(expCall.text);
    explanation = v.explanation ?? "";
    explanationLocalised = v.explanationLocalised ?? explanation;

    if (conflicted && typeof v.adjustedScore !== "undefined") {
      const proposed = clampScore(v.adjustedScore);
      // Bounded: the explainer may nudge, never overrule. Floors still win.
      const bounded = Math.max(fused.riskScore - ADJUDICATION_BAND, Math.min(fused.riskScore + ADJUDICATION_BAND, proposed));
      riskScore = Math.max(bounded, ind.floor);
      adjudicated = true;
    }
    traces.push(traceOf("explainer", conflicted ? "Adjudicator - reviewers disagreed" : "Explainer - plain language",
      expCall, explanation, adjudicated ? riskScore : undefined));
  } catch (err) {
    traces.push(failedTrace("explainer", "Explainer", MODELS.explainer, err));
  }

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

    crossVerification: { classifierScore, verifierScore, delta, conflicted, adjudicated },
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
