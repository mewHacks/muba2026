import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assess } from "./committee.js";
import { SCENARIOS } from "./scenarios.js";
import { MODELS } from "./gonka.js";
import { TIER_CODE } from "./rules.js";
import type { TxContext, Language } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/scenarios", (_req, res) => res.json({ scenarios: SCENARIOS, models: MODELS }));

app.post("/api/assess", async (req, res) => {
  try {
    const { message = "", tx, language = "en", policyId, sender, recipient } = req.body ?? {};
    if (!tx || typeof tx.amountMYR !== "number") {
      return res.status(400).json({ error: "tx.amountMYR is required" });
    }
    const result = await assess({
      message: String(message),
      tx: tx as TxContext,
      language: language as Language,
      policyId, sender, recipient,
    });
    // tierCode is what shou::policy::request_transfer takes as risk_tier: u8
    res.json({ ...result, tierCode: TIER_CODE[result.tier] });
  } catch (err: any) {
    console.error(err);
    res.status(502).json({ error: err?.message ?? "Assessment failed" });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`\n  SHOU risk service on http://localhost:${port}`);
  console.log(`  models: ${Object.values(MODELS).join(", ")}\n`);
});
