/**
 * Personal details are stripped ON OUR SIDE before anything reaches the network.
 * The UI shows the user exactly what was sent. This is our answer to the privacy
 * question, and it is the honest replacement for the TEE we cut from the plan.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{6}-\d{2}-\d{4}\b/g, "[IC]"],                          // Malaysian NRIC
  [/\b(?:\+?60|0)1\d[-\s]?\d{3,4}[-\s]?\d{4}\b/g, "[PHONE]"],  // MY mobile
  [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, "[EMAIL]"],
  [/\b\d{10,16}\b/g, "[ACCOUNT]"],                             // bank account / card
];

export interface Redaction {
  text: string;
  count: number;
  kinds: string[];
}

export function redact(input: string): Redaction {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();

  for (const [pattern, token] of PATTERNS) {
    text = text.replace(pattern, () => {
      count++;
      kinds.add(token);
      return token;
    });
  }
  return { text, count, kinds: [...kinds] };
}
