// PII redaction for messages before they are scored.
//
// THE DESIGN IDEA: placeholder-preserving redaction. A scam is detected
// from its *pattern*, not from the digits. "Send RM5000 to [ACCOUNT] and
// call [PHONE]" carries exactly the same signal as the original — an
// urgent payment request to an unknown account with a callback number —
// while the values that identify a real person are gone.
//
// So redaction here costs almost no detection accuracy, which is what
// makes it safe to apply by default rather than as an opt-in.
//
// WHERE THIS RUNS (both, deliberately — defence in depth):
//   1. In the extension, on-device, BEFORE the message ever leaves. This
//      is the strong claim: identifying values never cross the network.
//   2. Again in the enclave, before scoring. If an extension is stale,
//      bypassed, or a message arrives from anywhere else, the enclave
//      still strips it. Redaction is idempotent, so running twice is
//      harmless.
//
// WHAT IS DELIBERATELY KEPT: amounts and currency. "RM5000" is the
// single strongest scam signal in the message and identifies nobody.

export const PLACEHOLDERS = {
  otp: '[OTP]',
  nric: '[ID]',
  card: '[CARD]',
  account: '[ACCOUNT]',
  phone: '[PHONE]',
  email: '[EMAIL]',
  wallet: '[WALLET]',
  url: '[LINK]',
} as const;

export interface RedactionResult {
  /** Safe to send onward. */
  text: string;
  /** What was removed, by kind — useful signal, carries no values. */
  removed: Record<string, number>;
}

/**
 * Order matters: the most specific patterns run first, so a national ID
 * is not eaten by the generic long-digit-run rule.
 */
const RULES: { kind: keyof typeof PLACEHOLDERS; pattern: RegExp }[] = [
  // Structured identifiers first — they contain digits that the looser
  // numeric rules below would otherwise chew into.
  { kind: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  // Crypto addresses (EVM 40-hex and Sui 64-hex).
  { kind: 'wallet', pattern: /\b0x[a-fA-F0-9]{40,64}\b/g },
  // One-time codes. "your TAC is 123456", "OTP: 8842". TAC is the
  // Malaysian term and appears constantly in local scam scripts.
  {
    kind: 'otp',
    pattern: /\b(?:otp|tac|pin|passcode|verification code|code)\b[^0-9]{0,15}\d{4,8}\b/gi,
  },
  // Malaysian NRIC: YYMMDD-PB-###G, with or without separators.
  { kind: 'nric', pattern: /\b\d{6}[-\s]?\d{2}[-\s]?\d{4}\b/g },
  // International phone, matched WHOLE. Ordered before the numeric
  // rules so "+60 12-345 6789" cannot be redacted in part, which would
  // leave the country code and prefix behind — still identifying.
  { kind: 'phone', pattern: /\+\d{1,3}[\s-]?\d(?:[\s-]?\d){5,12}(?!\d)/g },
  // Payment cards: 14–19 digits. Below that is treated as an account,
  // since local bank accounts are commonly 10–13.
  { kind: 'card', pattern: /\b\d(?:[ -]?\d){13,18}(?!\d)/g },
  // Local mobile format, e.g. 012-345 6789.
  { kind: 'phone', pattern: /\b0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}(?!\d)/g },
  // Bank accounts: runs of 8–13 digits that survived the above, WITH or
  // WITHOUT separators — same shape as the card rule above.
  //
  // This used to be `\b\d{8,13}\b`, bare digits only, which left a hole
  // exactly where account numbers are usually written. `512088776655`
  // was stripped but `5140-2288-9911` — the same number, grouped the way
  // a person types one — passed through untouched and reached the model,
  // because it is too short for the 14–19 digit card rule and the account
  // rule could not see past the dashes.
  { kind: 'account', pattern: /\b\d(?:[ -]?\d){7,12}(?!\d)/g },
];

/** Keeps the domain (a lookalike domain is signal) and drops the rest. */
function redactUrls(text: string, removed: Record<string, number>): string {
  return text.replace(/\bhttps?:\/\/([^\s/]+)(\/\S*)?/gi, (_match, host: string, path?: string) => {
    if (!path || path === '/') return `${PLACEHOLDERS.url}(${host})`;
    removed.url = (removed.url ?? 0) + 1;
    return `${PLACEHOLDERS.url}(${host})`;
  });
}

/**
 * Amounts are protected from redaction because they are the strongest
 * signal in the message and identify nobody. Without this, "RM 5000"
 * risks being swallowed by a numeric rule.
 */
/**
 * Amounts are masked behind a NUL-delimited sentinel so the placeholder
 * cannot collide with anything a human would type.
 *
 * WRITE THE NUL AS `\u0000`, NEVER AS A RAW BYTE. A literal NUL in the
 * source makes every file that bundles this module test as *binary*: `file`
 * reports "data", and `grep` silently reports no matches in it rather than
 * erroring — which is a genuinely nasty way to lose an afternoon when you
 * are grepping a built extension bundle for a symbol that is plainly there.
 * The escape is byte-identical at runtime.
 */
function protectAmounts(text: string): { text: string; restore: (s: string) => string } {
  const amounts: string[] = [];
  const masked = text.replace(
    /\b(?:rm|myr|sgd|usd|s\$|\$|£|€)\s?\d[\d,]*(?:\.\d{1,2})?\b/gi,
    (match) => {
      amounts.push(match);
      return `\u0000AMT${amounts.length - 1}\u0000`;
    },
  );
  return {
    text: masked,
    restore: (s: string) => s.replace(/\u0000AMT(\d+)\u0000/g, (_m, i: string) => amounts[Number(i)]!),
  };
}

/**
 * Strips identifying values while preserving the shape of the message.
 * Idempotent: running it on already-redacted text changes nothing.
 */
export function redact(message: string): RedactionResult {
  const removed: Record<string, number> = {};
  const { text: protectedText, restore } = protectAmounts(message);

  let out = redactUrls(protectedText, removed);

  for (const { kind, pattern } of RULES) {
    out = out.replace(pattern, (match) => {
      // Don't re-redact an existing placeholder.
      if (match.includes('[')) return match;
      removed[kind] = (removed[kind] ?? 0) + 1;
      return PLACEHOLDERS[kind];
    });
  }

  return { text: restore(out), removed };
}

/**
 * Throws if `text` still looks like it contains identifying values.
 * Used as an assertion at the trust boundary rather than a filter — if
 * this ever fires, redaction has a gap and we want to fail loudly rather
 * than quietly score a message full of PII.
 */
export function assertRedacted(text: string): void {
  const { removed } = redact(text);
  const leaked = Object.entries(removed).filter(([kind]) => kind !== 'url');
  if (leaked.length > 0) {
    const kinds = leaked.map(([kind, count]) => `${kind}x${count}`).join(', ');
    throw new Error(`text still contains unredacted PII (${kinds})`);
  }
}
