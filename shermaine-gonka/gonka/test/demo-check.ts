import "dotenv/config";
import { assess } from "../src/committee.js";
import { EVAL_CASES } from "../src/scenarios.js";

/**
 * The eight cases that actually decide the demo, run live against Gonka.
 * Acceptance criteria are asserted, not eyeballed.
 */
const IDS = ["macau", "otp", "invest", "loan", "newnumber", "hospital", "urgentreal", "bill"];
const LIMIT_MS = 15000;
const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

let overBudget = 0, falsePos = 0, wrongTier = 0, noReceipt = 0;
const lat: number[] = [];

for (const id of IDS) {
  const c = EVAL_CASES.find((x) => x.id === id)!;
  const r = await assess({ message: c.message, tx: c.tx, language: c.language });
  lat.push(r.latencyMs);

  const slow = r.latencyMs > LIMIT_MS;
  const fp = c.expected === "LOW" && r.tier !== "LOW";
  const under = rank[r.tier] < rank[c.expected as keyof typeof rank];
  const ok = r.traces.filter((t) => !t.error);
  const missingReceipt = ok.filter((t) => !t.receiptUrl).length;

  if (slow) overBudget++;
  if (fp) falsePos++;
  if (under) wrongTier++;
  if (missingReceipt) noReceipt++;

  const flags = [slow && "SLOW", fp && "FALSE-POSITIVE", under && "UNDER"].filter(Boolean).join(" ");
  console.log(`${(flags || "ok").padEnd(16)} ${id.padEnd(11)} exp=${String(c.expected).padEnd(6)} got=${r.tier.padEnd(6)} score=${String(r.riskScore).padStart(3)} ${String(r.latencyMs).padStart(6)}ms  models=${ok.length}/${r.traces.length} receipts=${ok.length - missingReceipt}/${ok.length}`);
  if (r.degraded) console.log(`                 degraded: ${r.degraded}`);
}

const s = [...lat].sort((a, b) => a - b);
console.log(`\nlatency  median=${s[Math.floor(s.length / 2)]}ms  max=${s[s.length - 1]}ms  budget=${LIMIT_MS}ms`);
console.log(`over budget:      ${overBudget}/${IDS.length}`);
console.log(`false positives:  ${falsePos}`);
console.log(`under-tiered:     ${wrongTier}`);
console.log(`missing receipts: ${noReceipt}`);
console.log(overBudget || falsePos || noReceipt ? "\nFAIL" : "\nPASS");
