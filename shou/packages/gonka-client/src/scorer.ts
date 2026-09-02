// ─────────────────────────────────────────────────────────────────────
//  DEV B (Shermaine) OWNS THIS FILE.
//
//  Dev A wrote the scaffold below only so the enclave and the on-chain
//  path were runnable end-to-end before this existed. Replace the body
//  of `gonkaScorer` with the real Gonka Router integration — prompts,
//  model choice, consensus rule and Truth Score are yours to decide.
//
//  Keep the `Scorer` signature stable: shou/enclave imports it, and
//  changing the shape breaks Dev A's half the same way editing
//  driver/src/types.ts does.
// ─────────────────────────────────────────────────────────────────────
//
//  IMPORTANT — WHERE THIS RUNS CHANGED.
//
//  This module is imported by the enclave (shou/enclave/src/server.ts)
//  and executes INSIDE the TEE. It is not called from the extension.
//
//  Why: if the extension called Gonka Router directly, the elder's
//  message would leave her device without ever passing through an
//  enclave, and shou-idea.md §9's privacy claim ("conversation content
//  is never visible to operators") would be a promise rather than a
//  measurable property. The extension's job is to POST the message to
//  the circuit breaker, which forwards it to the enclave, which calls
//  this. Your interface doesn't change; your deployment target does.
//
//  Consequence for you: this code runs where there is no disk and no
//  log aggregation. Do not write message text anywhere. Return a
//  verdict, nothing more.
//
//  ─── OPEN BLOCKER, found by Dev A while wiring this up ───
//  A live call to https://gonkarouter.io/api/v1/chat/completions with
//  model "kimi" returned HTTP 404. Either the base URL or the model
//  identifiers (or both) are wrong — these were Dev A's guesses, not
//  documented values. Confirm the correct endpoint and the exact model
//  IDs with Jack at the Gonka workshop before building on them. The
//  hackathon brief names MiniMax and Kimi as the two example models for
//  multi-model consensus, so those are probably right in spirit but not
//  in spelling.

export type RiskTierName = 'LOW' | 'MEDIUM' | 'HIGH';

export const RiskTierCode = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

export interface ScoreResult {
  tier: RiskTierName;
  /** 0–100. Gonka's Truth Score — must be rendered in the UI. */
  truthScore: number;
  /** Short label for the badge, e.g. "urgency + payment-request". */
  category: string;
  /** Gonka Request IDs, one per model call — must be rendered in the UI. */
  gonkaRequestIds: string[];
  /** Reasoning trace — must be rendered in the UI. */
  reasoning: string;
}

/** The seam. The enclave depends on this signature and nothing else. */
export type Scorer = (message: string) => Promise<ScoreResult>;

export interface GonkaConfig {
  url: string;
  apiKey: string;
  models: string[];
}

/**
 * Starting point, not a finished integration — Dev A's sketch of the
 * multi-model consensus shape. The consensus rule implemented here is
 * "strictest tier wins", on the reasoning that a single model missing a
 * scam must not be able to wave it through. Change it if you have a
 * better one, but keep that property.
 */
export function gonkaScorer(config: GonkaConfig): Scorer {
  const prompt = [
    'You are a scam-detection classifier for messages sent to elderly people.',
    'Be objective and name the manipulation pattern you observe.',
    'NEVER quote, paraphrase closely, or repeat any part of the message. ' +
      'Describe the pattern only (e.g. "urgency plus secrecy plus payment request"). ' +
      'Your reasoning is shown on screen and must not leak the conversation.',
    'Respond as JSON only: {"tier":"LOW|MEDIUM|HIGH","truthScore":0-100,"category":"...","reasoning":"..."}',
    'tier HIGH = active social-engineering (urgency, secrecy, authority impersonation, payment to a stranger).',
    'tier MEDIUM = suspicious but ambiguous. tier LOW = ordinary conversation.',
  ].join(' ');

  return async (message: string): Promise<ScoreResult> => {
    const results = await Promise.all(
      config.models.map(async (model) => {
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: model.trim(),
            messages: [
              { role: 'system', content: prompt },
              { role: 'user', content: message },
            ],
          }),
        });
        if (!response.ok) {
          throw new Error(`Gonka Router ${model} returned ${response.status}`);
        }
        const body = (await response.json()) as {
          id?: string;
          choices?: { message?: { content?: string } }[];
        };
        const parsed = JSON.parse(
          body.choices?.[0]?.message?.content ?? '{}',
        ) as Partial<ScoreResult>;
        return {
          tier: (parsed.tier ?? 'LOW') as RiskTierName,
          truthScore: Number(parsed.truthScore ?? 0),
          category: parsed.category ?? 'unknown',
          reasoning: parsed.reasoning ?? '',
          requestId: body.id ?? 'unknown',
        };
      }),
    );

    const strictest = results.reduce((worst, r) =>
      RiskTierCode[r.tier] > RiskTierCode[worst.tier] ? r : worst,
    );
    return {
      tier: strictest.tier,
      truthScore: Math.max(...results.map((r) => r.truthScore)),
      category: strictest.category,
      gonkaRequestIds: results.map((r) => r.requestId),
      reasoning: results.map((r) => r.reasoning).join(' | '),
    };
  };
}

/**
 * Dev-mode stand-in so Dev A's enclave, circuit breaker and on-chain
 * path stay runnable without Gonka credentials. This is NOT a scam
 * detector and must never be reachable in a demo or in production —
 * the enclave logs a warning when it falls back to this.
 */
export const devHeuristicScorer: Scorer = async (message: string) => {
  const lowered = message.toLowerCase();
  const urgency =
    /urgent|immediately|right now|don't tell|dont tell|secret|verify your account|suspended/;
  const money = /transfer|send money|payment|wire|gift card|bitcoin|crypto/;
  const hitUrgency = urgency.test(lowered);
  const hitMoney = money.test(lowered);
  const tier: RiskTierName =
    hitUrgency && hitMoney ? 'HIGH' : hitUrgency || hitMoney ? 'MEDIUM' : 'LOW';
  return {
    tier,
    truthScore: tier === 'HIGH' ? 90 : tier === 'MEDIUM' ? 55 : 10,
    category:
      [hitUrgency && 'urgency', hitMoney && 'payment-request'].filter(Boolean).join(' + ') ||
      'none',
    gonkaRequestIds: [`dev-${crypto.randomUUID()}`],
    reasoning: 'DEV MODE heuristic — not a real classifier. Provide GONKA_API_KEY.',
  };
};
