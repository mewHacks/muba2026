// ─────────────────────────────────────────────────────────────────────
//  DEV B (Shermaine) OWNS THIS FILE.
//
//  This is now the real Gonka Router integration. It is a message-only
//  port of the pipeline in shermaine-gonka/gonka, which is where the
//  numbers below were measured. Keep the two in step when either moves.
//
//  Why a port and not an import: this module runs under
//  `node --experimental-strip-types`, which needs `.ts` import
//  specifiers, while the standalone service is tsx/ESM with `.js`
//  specifiers. Reaching across would break at start-up, on demo day,
//  in the one process that has no console to debug it in.
//
//  Keep the `Scorer` signature stable: shou/enclave imports it, and
//  changing the shape breaks Dev A's half the same way editing
//  driver/src/types.ts does.
// ─────────────────────────────────────────────────────────────────────
//
//  WHERE THIS RUNS. Imported by shou/enclave/src/server.ts and executed
//  INSIDE the TEE. No disk, no log aggregation. The message text must
//  not be written anywhere, and `reasoning` LEAVES the enclave and is
//  rendered on screen — so it describes patterns, never content. There
//  is a guard at the bottom that enforces that rather than trusting the
//  prompt, because a model that ignores an instruction once in fifty
//  calls will do it in front of the judges.
//
//  ─── the 404 blocker is RESOLVED ───
//  Dev A's guessed URL and model ids were both wrong. Verified working:
//    https://api.gonkarouter.io/v1/chat/completions
//    deepseek-ai/DeepSeek-V4-Flash-0731
//    MiniMaxAI/MiniMax-M2.7
//  The short forms ("kimi", "minimax", "MiniMax-M2.7") return HTTP 400
//  invalid_model. Kimi answers, but see MODEL NOTES below.
//
//  ─── MODEL NOTES, measured over 5 novel prompts each ───
//    DeepSeek-V4-Flash  median  2.6s   max  4.4s   usable JSON 5/5
//    MiniMax-M2.7       median 19.6s   max 30.4s   usable JSON 4/5
//    Kimi-K2.6          median 26.5s   max 30.2s   never under 23s
//  Kimi is not in the live path: it is a good model that this router
//  serves too slowly to sit in front of a waiting user.
//
//  ─── WHY THE CALLS ARE SEQUENTIAL ───
//  Concurrent calls return HTTP 429 "too many concurrent requests for
//  this account", and when they do not 429 the router throttles: the
//  same DeepSeek call took 2,472ms alone and 17,560ms issued alongside
//  one other request. Parallelism costs ~7x here and buys nothing.
//  Dev A's scaffold used Promise.all over the models; that is exactly
//  the shape that triggers it.

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
  /** Reasoning trace — must be rendered in the UI. Patterns only, never content. */
  reasoning: string;
}

/** The seam. The enclave depends on this signature and nothing else. */
export type Scorer = (message: string) => Promise<ScoreResult>;

export interface GonkaConfig {
  url: string;
  apiKey: string;
  /** [classifier, verifier]. A single entry runs classifier-only. */
  models: string[];
}

const DEFAULT_CLASSIFIER = 'deepseek-ai/DeepSeek-V4-Flash-0731';
const DEFAULT_VERIFIER = 'MiniMaxAI/MiniMax-M2.7';

// Total wall-clock the models may consume. The UI is waiting, so this is a
// deadline shared across both calls, not a per-call timeout.
//
// 14s was below this router's own latency for a novel prompt (measured at
// 12-20s in LATENCY-FINDINGS.md), so most first-time messages lost the race:
// the caller waited the full 14s AND got no model answer AND no request id —
// the worst of both. 25s means an unseen message usually lands.
//
// It costs nothing on a repeat, because the router caches: the same prompt
// returns in ~300ms. Warm the demo message once beforehand and this deadline
// never comes near being spent.
//
// Tune without editing code: GONKA_DEADLINE_MS. Set it low (2000) when you
// want the deterministic rules alone and do not care about model output —
// that is the fast path for chain tests, where scoring is not what is under
// test.
const MODEL_DEADLINE_MS = Number(process.env.GONKA_DEADLINE_MS ?? 25_000);
// Below this much remaining, a second opinion cannot land, so we skip it and
// say so rather than spend the rest of the budget and return nothing.
const MIN_VERIFIER_MS = 4_000;

// The classifier writes more, so it gets more room. The verifier needs 1200
// because MiniMax is a reasoning model: it emits a <think> block whatever the
// prompt says, and starved of tokens it never reaches its JSON at all. With
// room to finish it is accurate (otp 100, macau 95, bill 15, son 10). Starved,
// it returned nothing — which the old scaffold would have scored as 0.
const CLASSIFIER_MAX_TOKENS = 700;
const VERIFIER_MAX_TOKENS = 1200;

const GONKA_RECEIPT_BASE = 'https://api.gonkarouter.io/v1/receipts';
export const receiptUrlFor = (id: string) => `${GONKA_RECEIPT_BASE}/${id}`;

// ─── deterministic layer ─────────────────────────────────────────────
// Exists so that if every model has a bad moment in front of a judge, an
// obvious scam is still caught. Message-only: this seam gets no transaction
// context, so amount-vs-usual arithmetic lives on the standalone side.

const URGENCY = [
  'immediately', 'right now', 'within the hour', 'urgent', 'last chance',
  'hurry', 'as soon as possible', 'act now', 'before it is too late',
  // Bare "sekarang", not just "sekarang juga": real scam texts shorten it,
  // and matching only the long form let the Macau-scam floor silently miss.
  'sekarang', 'segera', 'cepat', 'dalam masa', 'jangan tunggu',
  '马上', '立刻', '尽快', '限时', '现在', '快点',
];
const AUTHORITY = [
  'pdrm', 'police', 'polis', '警察', 'lhdn', 'inland revenue', 'bank negara', 'bnm',
  'court', 'mahkamah', '法院', '传票', 'saman', 'warrant', 'waran',
  'kastam', 'customs', 'imigresen', 'immigration', 'nsrc', 'sspn',
];
const SECRECY = [
  'do not tell', "don't tell", 'dont tell', 'jangan beritahu', 'jangan bagitahu',
  '别告诉', '不要告诉', 'keep this confidential', 'rahsia', '保密',
  'secret investigation', 'keep it secret', 'keep this secret',
];
const CREDENTIAL = [
  'otp', 'one-time password', 'tac', 'kod tac', 'verification code', '验证码',
  'seed phrase', 'recovery phrase', 'private key', 'password', 'kata laluan', '密码', '助记词',
];
const LURE = [
  'guaranteed return', 'pulangan terjamin', '保本', '保证收益', 'double your money',
  'investment opportunity', 'peluang pelaburan', '投资机会',
  'you have won', 'anda menang', '中奖', 'lucky draw', 'cabutan bertuah',
  'parcel', 'bungkusan', '包裹', 'customs fee', 'clearance fee',
  'processing fee', 'upfront fee', 'release fee', 'advance fee', 'administration fee',
  'yuran pemprosesan', 'yuran pendahuluan', '手续费', '预付费',
  'loan approved', 'loan is approved', 'pinjaman diluluskan', 'pinjaman anda diluluskan',
];

const hits = (haystack: string, needles: string[]) => needles.filter((n) => haystack.includes(n));

interface IndicatorResult {
  score: number;
  /** Pattern names only. Safe to render: these are our words, not the sender's. */
  patterns: string[];
  hardFloor: string | null;
  floor: number;
}

function indicators(message: string): IndicatorResult {
  const m = message.toLowerCase();
  const patterns: string[] = [];
  let score = 0;

  const u = hits(m, URGENCY);
  const a = hits(m, AUTHORITY);
  const s = hits(m, SECRECY);
  const c = hits(m, CREDENTIAL);
  const l = hits(m, LURE);

  if (u.length) { patterns.push('urgency'); score += 20; }
  if (a.length) { patterns.push('authority-impersonation'); score += 25; }
  if (s.length) { patterns.push('secrecy'); score += 25; }
  if (l.length) { patterns.push('financial-lure'); score += 20; }
  if (c.length) { patterns.push('credential-request'); score += 40; }

  // Hard floors. No model is permitted to talk these down.
  let hardFloor: string | null = null;
  let floor = 0;
  if (c.length) {
    hardFloor = 'credential-request';
    floor = 85;
  } else if (a.length && u.length && s.length) {
    hardFloor = 'authority+urgency+secrecy';
    floor = 80; // the classic Macau-scam signature
  } else if (a.length && u.length) {
    hardFloor = 'authority+urgency';
    floor = 70;
  }

  return { score: Math.min(100, score), patterns, hardFloor, floor };
}

/**
 * Safety net for the case where EVERY model failed.
 *
 * With no model opinion, a subtle scam scores on keywords alone and can land
 * under the MEDIUM line. Silently waving a transfer through because our own
 * inference provider was down is the one failure mode we cannot ship.
 *
 * The threshold is measured, not guessed: across the 24 standalone eval cases
 * with every model forced to fail, legitimate traffic lands 0–8 and the weakest
 * scam lands 22. 15 sits in that gap with margin on both sides.
 */
const DEGRADED_REVIEW_THRESHOLD = 15;
const DEGRADED_REVIEW_SCORE = 40; // exactly the MEDIUM line

const tierFor = (score: number): RiskTierName =>
  score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';

// ─── transport ───────────────────────────────────────────────────────

interface GonkaCall {
  text: string;
  requestId: string;
  requestedModel: string;
  servedModel: string;
  substituted: boolean;
  latencyMs: number;
}

/** "kimi-k2-6" and "moonshotai/Kimi-K2.6" are the same family, not a substitution. */
function sameFamily(requested: string, served: string): boolean {
  if (!served) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(requested.split('/').pop() ?? requested);
  const b = norm(served.split('/').pop() ?? served);
  return a.startsWith(b.slice(0, 8)) || b.startsWith(a.slice(0, 8));
}

async function callGonka(
  config: GonkaConfig,
  requestedModel: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<GonkaCall> {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: requestedModel.trim(),
        max_tokens: maxTokens,
        // Lowers variance. Does NOT make output identical run to run.
        temperature: 0,
        top_p: 1,
        seed: 7,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    // The judge-verifiable receipt id is the x-request-id HEADER. Dev A's
    // scaffold read body.id, which is a different value and does not resolve
    // at /v1/receipts/<id> — the receipts would have been dead links on stage.
    const requestId = res.headers.get('x-request-id') ?? 'unavailable';
    if (!res.ok) {
      // Deliberately does not include the body: an error path that echoes the
      // request would put message text into an exception message.
      throw new Error(`Gonka ${requestedModel} returned ${res.status}`);
    }

    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
    };
    const servedModel = body.model ?? requestedModel;

    return {
      text: body.choices?.[0]?.message?.content ?? '',
      requestId,
      requestedModel,
      servedModel,
      substituted: !sameFamily(requestedModel, servedModel),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Models wrap JSON in prose or fences more often than anyone admits. */
function parseLenientJson<T = Record<string, unknown>>(text: string): Partial<T> {
  if (!text) return {};
  const cleaned = text
    // Reasoning models emit a <think> block first. Left in place it swallows
    // the budget, and the brace-scan below would parse a fragment of the
    // reasoning instead of the answer.
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  try {
    return JSON.parse(cleaned) as Partial<T>;
  } catch {
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(cleaned.slice(s, e + 1)) as Partial<T>;
      } catch { /* give up */ }
    }
    return {};
  }
}

/**
 * Returns null — never 0 — when the model gave us no usable number.
 *
 * Dev A's scaffold used `Number(parsed.truthScore ?? 0)` and `parsed.tier ?? 'LOW'`.
 * Both mean a truncated or unparseable reply was read as "certainly not a scam",
 * so a model that FAILED voted for letting the money go. A model that did not
 * answer must be absent from the fusion, not counted.
 */
function clampScore(n: unknown): number | null {
  if (n === null || n === undefined || n === '') return null;
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

// ─── prompts ─────────────────────────────────────────────────────────
// Both models are told NEVER to quote the message. `reasoning` leaves the
// enclave and is rendered on screen, so a model that echoes the message would
// undo the privacy property this whole service exists to provide. The guard in
// stripLeakedContent() enforces it; the prompt only asks.

const CLASSIFIER_SYSTEM = `You identify scams aimed at elderly people in Malaysia.

Patterns to know: Macau scam (caller impersonates PDRM, LHDN, Bank Negara, customs or the
courts), parcel/customs fee scam, love scam, fake investment with guaranteed returns, fake
loan approval with an upfront fee, impersonated family ("hi mum, new number"), and any
request for an OTP, TAC, password, seed phrase or private key.

Personal details were already replaced with tokens like [PHONE] or [ACCOUNT]; those are our
redactions, not evidence of anything.

NEVER quote, paraphrase closely, or repeat any part of the message. Name the manipulation
pattern only, e.g. "urgency plus secrecy plus authority impersonation". Your reasoning is
shown on screen and must not leak the conversation.

Reply with JSON only, no reasoning outside the JSON:
{"score":0-100,"category":"snake_case_or_none","reasoning":"pattern names only, one short sentence","abstain":false}
score is HOW LIKELY THIS IS A SCAM: 0 certainly harmless, 100 certainly a scam.
Set abstain to true only if the text is empty or unintelligible.`;

const VERIFIER_SYSTEM = `You are a skeptical second reviewer checking a possible scam report.

Another analyst has already looked at this message; you cannot see their answer. Reach your
own conclusion, and specifically look for the INNOCENT explanation. Ordinary life contains
urgent messages, bills, and real family asking for money. Flagging a real utility bill or a
genuine relative is a costly mistake.

NEVER quote or repeat any part of the message. Describe the pattern only.

score means HOW LIKELY THIS IS A SCAM: 0 certainly harmless, 100 certainly a scam.
Do not invert it. A real utility bill scores near 0; an OTP request scores near 100.

Reply with JSON and nothing else. Do not think step by step. Do not emit <think> tags.
{"score":0-100,"innocentExplanation":"<=12 words, or none","abstain":false}`;

// ─── fusion ──────────────────────────────────────────────────────────
// Message-only. The standalone pipeline also weighs transaction anomaly, but
// this seam is handed a message and nothing else, so those weights are absent
// and the rest renormalise over whatever actually answered.
const W = { classifier: 0.35, verifier: 0.2, indicators: 0.2 };

/**
 * Removes anything the model echoed back from the message.
 *
 * The prompts forbid quoting, but a prompt is a request, not a guarantee, and
 * this string is rendered in the UI. Any run of five or more consecutive words
 * shared with the message means the model quoted it, so we drop the text
 * entirely rather than publish a partial redaction we cannot reason about.
 */
function stripLeakedContent(reasoning: string, message: string): string {
  if (!reasoning) return '';
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const msgWords = words(message);
  if (msgWords.length < 5) return reasoning;

  const shingles = new Set<string>();
  for (let i = 0; i + 5 <= msgWords.length; i++) shingles.add(msgWords.slice(i, i + 5).join(' '));

  const rWords = words(reasoning);
  for (let i = 0; i + 5 <= rWords.length; i++) {
    if (shingles.has(rWords.slice(i, i + 5).join(' '))) {
      return '[reasoning withheld: the model quoted the message, which must not leave the enclave]';
    }
  }
  return reasoning;
}

// ─── the integration ─────────────────────────────────────────────────

/**
 * Real Gonka Router integration.
 *
 * DeepSeek classifies. MiniMax cross-verifies if the deadline allows. Code owns
 * the final number: the models supply evidence, never the verdict, and the
 * deterministic floors cannot be argued down by either of them.
 *
 * The consensus property Dev A asked for is preserved and strengthened. His rule
 * was "strictest tier wins", so one model missing a scam could not wave it
 * through. Here a model that misses a scam is outvoted by weight AND cannot pull
 * the result below a hard floor — and a model that fails to answer is dropped
 * rather than counted as a vote for LOW, which was the hole in the original.
 */
export function gonkaScorer(config: GonkaConfig): Scorer {
  const classifierModel = config.models[0]?.trim() || DEFAULT_CLASSIFIER;
  const verifierModel = config.models[1]?.trim() || DEFAULT_VERIFIER;

  return async (message: string): Promise<ScoreResult> => {
    const startedAt = Date.now();
    const deadline = startedAt + MODEL_DEADLINE_MS;
    const remaining = () => deadline - Date.now();

    const ind = indicators(message);
    const hasMessage = message.trim().length > 0;

    const requestIds: string[] = [];
    const notes: string[] = [];

    let classifierScore: number | null = null;
    let category = 'none';
    let modelReasoning = '';

    if (hasMessage) {
      try {
        const call = await callGonka(
          config, classifierModel, CLASSIFIER_SYSTEM,
          `Message:\n"""${message}"""`,
          CLASSIFIER_MAX_TOKENS, Math.max(1_000, remaining()),
        );
        if (call.requestId !== 'unavailable') requestIds.push(call.requestId);
        if (call.substituted) notes.push(`router served ${call.servedModel} in place of ${classifierModel}`);
        const v = parseLenientJson<{ score: unknown; category: string; reasoning: string; abstain: boolean }>(call.text);
        if (!v.abstain) {
          classifierScore = clampScore(v.score);
          category = v.category ?? 'none';
          modelReasoning = typeof v.reasoning === 'string' ? v.reasoning : '';
        }
        if (classifierScore === null) notes.push('classifier returned no usable score');
      } catch {
        // No message text in the note — see the enclave privacy contract.
        notes.push('classifier unavailable');
      }
    }

    // Best-effort second opinion. A cross-verification that arrives after the
    // deadline is worth less than a verdict that arrives while the user waits.
    let verifierScore: number | null = null;
    const verifierBudget = remaining();
    if (hasMessage && verifierBudget < MIN_VERIFIER_MS) {
      notes.push('no budget left for a second opinion; not cross-verified');
    } else if (hasMessage) {
      try {
        const call = await callGonka(
          config, verifierModel, VERIFIER_SYSTEM,
          `Message:\n"""${message}"""`,
          VERIFIER_MAX_TOKENS, verifierBudget,
        );
        if (call.requestId !== 'unavailable') requestIds.push(call.requestId);
        if (call.substituted) notes.push(`router served ${call.servedModel} in place of ${verifierModel}`);
        const v = parseLenientJson<{ score: unknown; abstain: boolean }>(call.text);
        if (!v.abstain) verifierScore = clampScore(v.score);
        if (verifierScore === null) notes.push('verifier returned no usable score');
      } catch {
        notes.push('second model did not answer in time; not cross-verified');
      }
    }

    // Code owns the number. Any model that failed drops out of the weighting
    // rather than dragging the average toward zero.
    const parts: Array<[number, number]> = [];
    if (classifierScore !== null) parts.push([classifierScore, W.classifier]);
    if (verifierScore !== null) parts.push([verifierScore, W.verifier]);
    parts.push([ind.score, W.indicators]);
    const totalWeight = parts.reduce((acc, [, w]) => acc + w, 0);
    const weighted = parts.reduce((acc, [v, w]) => acc + v * w, 0) / totalWeight;

    let truthScore = Math.round(Math.max(weighted, ind.floor));

    const anyModelScored = classifierScore !== null || verifierScore !== null;
    if (!anyModelScored && truthScore >= DEGRADED_REVIEW_THRESHOLD) {
      truthScore = Math.max(truthScore, DEGRADED_REVIEW_SCORE);
      notes.push('held for review rather than cleared, because no model was available');
    }

    truthScore = Math.max(0, Math.min(100, truthScore));
    const tier = tierFor(truthScore);

    if (classifierScore !== null && verifierScore !== null) {
      const delta = Math.abs(classifierScore - verifierScore);
      if (delta > 30) notes.push(`the two models disagreed by ${delta} points`);
    }

    const patternText = ind.patterns.length
      ? `deterministic indicators: ${ind.patterns.join(' + ')}`
      : 'no deterministic indicators fired';
    const floorText = ind.hardFloor ? `; hard floor ${ind.hardFloor} applied` : '';
    const safeModelReasoning = stripLeakedContent(modelReasoning, message);

    const reasoning = [
      safeModelReasoning || (anyModelScored ? 'model returned no reasoning' : 'scored on deterministic rules alone'),
      `${patternText}${floorText}`,
      notes.length ? `degraded: ${notes.join('; ')}` : null,
    ].filter(Boolean).join(' | ');

    return {
      tier,
      truthScore,
      category: category !== 'none' ? category : (ind.patterns.join('+') || 'none'),
      gonkaRequestIds: requestIds,
      reasoning,
    };
  };
}

/**
 * Dev-mode stand-in so Dev A's enclave, circuit breaker and on-chain path stay
 * runnable without Gonka credentials. This is NOT a scam detector and must never
 * be reachable in a demo — the enclave logs a warning when it falls back here.
 *
 * Left exactly as Dev A wrote it, deliberately. It is his test fixture:
 * enclave/src/session-risk.test.ts pins "URGENT: wire the money now or you will
 * be arrested" to HIGH, and that message scores 20 (LOW) under the indicator
 * lexicons above, which know about Malaysian authority impersonation rather than
 * generic wire-fraud wording. Swapping this for the "better" rules would have
 * broken the session-laundering test for no gain — the real scoring improvements
 * belong in gonkaScorer, not in the stand-in.
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
