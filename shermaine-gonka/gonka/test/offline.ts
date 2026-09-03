import "dotenv/config";
process.env.GONKA_API_KEY = "sk-invalid-force-offline";
const { assess } = await import("../src/committee.js");
const { EVAL_CASES: SCENARIOS } = await import("../src/scenarios.js");

let wrong = 0, fp = 0;
for (const s of SCENARIOS) {
  const r = await assess({ message: s.message, tx: s.tx, language: s.language });
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  const under = rank[r.tier] < rank[s.expected as keyof typeof rank];
  const over = rank[r.tier] > rank[s.expected as keyof typeof rank];
  if (s.expected === "LOW" && r.tier !== "LOW") fp++;
  if (under || over) wrong++;
  const mark = under ? "UNDER" : over ? "OVER " : "  ok ";
  console.log(`${mark} ${s.id.padEnd(12)} exp=${String(s.expected).padEnd(6)} got=${r.tier.padEnd(6)} score=${String(r.riskScore).padStart(3)} floor=${r.deterministic.hardFloorFired ?? "-"}`);
}
console.log(`\nOFFLINE: ${SCENARIOS.length - wrong}/${SCENARIOS.length} tiers correct, ${fp} false positives on legitimate transfers`);
