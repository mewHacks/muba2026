import "dotenv/config";
import { assess } from "../src/committee.js";
import { EVAL_CASES } from "../src/scenarios.js";

/**
 * Run before recording the video and before demo day.
 *
 * The legitimate cases matter more than the scams. A guard that flags an RM86
 * electricity bill is a guard nobody installs, and false positives are the thing
 * a judge will try to provoke.
 */
type Row = { label: string; expected: string; got: string; score: number; ok: boolean };
const rows: Row[] = [];

for (const c of EVAL_CASES) {
  try {
    const r = await assess({ message: c.message, tx: c.tx, language: c.language });
    const ok = r.tier === c.expected;
    rows.push({ label: c.label, expected: c.expected, got: r.tier, score: r.riskScore, ok });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.label.padEnd(34)} want ${c.expected.padEnd(6)} got ${r.tier.padEnd(6)} ` +
      `score ${String(r.riskScore).padStart(3)} conf ${String(r.confidence).padStart(3)} ${r.latencyMs}ms`,
    );
    if (!ok) console.log(`      ${r.explanation}`);
  } catch (err: any) {
    rows.push({ label: c.label, expected: c.expected, got: "ERROR", score: -1, ok: false });
    console.log(`ERR   ${c.label.padEnd(34)} ${err.message}`);
  }
}

const scams = rows.filter((r) => r.expected !== "LOW");
const legit = rows.filter((r) => r.expected === "LOW");
const falsePositives = legit.filter((r) => r.got !== "LOW");
const misses = scams.filter((r) => r.got === "LOW");

console.log(`\n  overall        ${rows.filter((r) => r.ok).length}/${rows.length}`);
console.log(`  scams caught   ${scams.length - misses.length}/${scams.length}`);
console.log(`  false positives ${falsePositives.length}/${legit.length}  <- the number judges will probe`);
if (misses.length) console.log(`  MISSED: ${misses.map((m) => m.label).join(", ")}`);
if (falsePositives.length) console.log(`  FLAGGED WRONGLY: ${falsePositives.map((m) => m.label).join(", ")}`);
console.log(`\n  Tune prompts in src/committee.ts or weights in src/rules.ts - never the test.`);
