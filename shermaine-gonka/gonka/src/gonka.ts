/**
 * GonkaRouter client.
 *
 * Two things this file exists to get right:
 *
 * 1. Capture `x-request-id`. It resolves to a PUBLIC, UNAUTHENTICATED receipt at
 *    GET https://api.gonkarouter.io/v1/receipts/<id>, which anyone can open to confirm
 *    the call ran on the Gonka network. Be precise about what that proves: it proves
 *    PROVENANCE (this inference happened, on this model, at this time). It does not
 *    prove the model's conclusion was correct.
 *
 * 2. Record which model was actually SERVED. A router under load may answer with a
 *    fallback model. If we asked for Kimi and got something else, our "two independent
 *    models cross-verified this" claim is no longer true, so the UI has to say so.
 */

const BASE_URL = "https://api.gonkarouter.io/v1";

export const MODELS = {
  classifier: process.env.GONKA_MODEL_CLASSIFIER ?? "deepseek-ai/DeepSeek-V4-Flash-0731",
  // MiniMax, not Kimi. Measured over 5 novel prompts each: DeepSeek median 2.6s,
  // MiniMax 8.6s on the terse verifier prompt, Kimi 26.5s and never once under 23s.
  // Kimi is a fine model that this router serves too slowly for a live path.
  verifier: process.env.GONKA_MODEL_VERIFIER ?? "MiniMaxAI/MiniMax-M2.7",
};

export const PROMPT_VERSION = "shou-prompts-v2";

export interface GonkaCall {
  text: string;
  requestId: string;
  receiptUrl: string;
  requestedModel: string;
  servedModel: string;
  substituted: boolean;
  latencyMs: number;
}

export const receiptUrlFor = (id: string) => `${BASE_URL}/receipts/${id}`;

export class GonkaError extends Error {
  constructor(public model: string, public status: number, body: string) {
    super(`Gonka ${model} returned ${status}: ${body.slice(0, 240)}`);
  }
}

/** Loose match: "kimi-k2-6" vs "moonshotai/Kimi-K2.6" is the same family, not a substitution. */
function sameFamily(requested: string, served: string): boolean {
  if (!served) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(requested.split("/").pop() ?? requested);
  const b = norm(served.split("/").pop() ?? served);
  return a.startsWith(b.slice(0, 8)) || b.startsWith(a.slice(0, 8));
}

export async function callGonka(
  requestedModel: string,
  system: string,
  user: string,
  opts: { maxTokens?: number; retries?: number; timeoutMs?: number } = {},
): Promise<GonkaCall> {
  // retries default to 0 and the timeout is tight ON PURPOSE. Measured cold latency
  // on this router is ~7s for DeepSeek and ~9s for MiniMax on a terse prompt, but
  // Kimi never came in under 23s. A retry costs the full timeout again, which is how
  // one request reached 83 seconds. On a live demo it is better to lose a signal and
  // say so than to make the room wait.
  const { maxTokens = 600, retries = 0, timeoutMs = 15000 } = opts;
  const apiKey = process.env.GONKA_API_KEY;
  if (!apiKey) throw new Error("GONKA_API_KEY is not set. Copy .env.example to .env.");

  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: requestedModel,
          max_tokens: maxTokens,
          // Lowers variance. Does NOT guarantee identical output run to run —
          // batching and non-associative float reduction still move things.
          temperature: 0,
          top_p: 1,
          seed: 7,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      const requestId = res.headers.get("x-request-id") ?? "unavailable";
      if (!res.ok) throw new GonkaError(requestedModel, res.status, await res.text());

      const json: any = await res.json();
      const servedModel = json?.model ?? requestedModel;

      return {
        text: json?.choices?.[0]?.message?.content ?? "",
        requestId,
        receiptUrl: receiptUrlFor(requestId),
        requestedModel,
        servedModel,
        substituted: !sameFamily(requestedModel, servedModel),
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Models wrap JSON in prose or fences more often than anyone admits. */
export function parseLenientJson<T = any>(text: string): Partial<T> {
  if (!text) return {};
  const cleaned = text
    // Reasoning models (MiniMax especially) emit a <think> block first. Left in place
    // it swallows the token budget and the JSON never arrives; the brace-scan below
    // would then happily parse a fragment of the reasoning instead of the answer.
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s !== -1 && e > s) {
      try {
        return JSON.parse(cleaned.slice(s, e + 1));
      } catch { /* give up */ }
    }
    return {};
  }
}

/**
 * Returns null - never 0 - when the model did not give us a usable number.
 *
 * This used to return 0, which meant a truncated or unparseable reply was scored as
 * "definitely not a scam" and pulled the fused score DOWN. A model that failed to
 * answer must be absent from the fusion, not counted as a vote for safety.
 */
export const clampScore = (n: unknown): number | null => {
  if (n === null || n === undefined || n === "") return null;
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
};
