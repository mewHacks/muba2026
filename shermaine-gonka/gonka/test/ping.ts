import "dotenv/config";
import { MODELS, callGonka, receiptUrlFor } from "../src/gonka.js";

/** Run this first. The models page and the docs spell ids differently; only one answers. */
const CANDIDATES = [
  ...Object.values(MODELS),
  "moonshotai/Kimi-K2.6",
  "DeepSeek-V4-Flash", "Kimi-K2.6", "MiniMax-M2.7",
];

for (const model of [...new Set(CANDIDATES)]) {
  try {
    const r = await callGonka(model, "Reply with exactly: pong", "ping", { maxTokens: 16, retries: 0 });
    const flag = r.substituted ? `  <-- SERVED ${r.servedModel} INSTEAD` : "";
    console.log(`OK    ${model.padEnd(30)} ${String(r.latencyMs).padStart(5)}ms${flag}`);
    console.log(`      ${receiptUrlFor(r.requestId)}`);
  } catch (err: any) {
    console.log(`FAIL  ${model.padEnd(30)} ${String(err.message).slice(0, 80)}`);
  }
}
