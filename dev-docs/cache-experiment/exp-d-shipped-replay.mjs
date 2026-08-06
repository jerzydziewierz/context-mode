#!/usr/bin/env node
/**
 * EXPERIMENT D — the SHIPPED askWithFrozenContext() reads cache, live.
 *
 * Exp A/C2 proved the mechanism with bespoke scripts. D proves the code we
 * actually ship: import build/adapters/pi/frozen-context.js, capture a
 * realistic Anthropic wire payload, replay it twice with different question
 * tails against the real dario proxy.
 *
 *   call 1 → cache_creation > 0 (write)
 *   call 2 → cache_read > 0     (READ — the claim under test)
 *
 * Run:  npm run build && node dev-docs/cache-experiment/exp-d-shipped-replay.mjs
 * Env:  CMQ_MODEL (default claude-opus-5) — must be a dario model id.
 *
 * Result 2026-08-06 (claude-opus-5): write=14699 → read=14675, write=22. PASS.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  askWithFrozenContext,
  captureFrozenContext,
  getFrozenContextCaptureDiagnostics,
  getFrozenContextCheckpoint,
} from "../../build/adapters/pi/frozen-context.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const models = JSON.parse(readFileSync(join(process.env.HOME, ".pi/agent/models.json"), "utf-8"));
const provider = (models.providers ?? models).dario;
const MODEL = process.env.CMQ_MODEL ?? "claude-opus-5";

// Filler sized well past Anthropic's 1024-token minimum cacheable prefix.
const filler = Array.from({ length: 320 }, (_, i) =>
  `Line ${i}: the context-mode extension records tool output and indexes it into FTS5 for later retrieval.`,
).join("\n");

// The shape pi's anthropic-messages adapter emits at before_provider_request:
// cache_control already placed on system / last tool / last user (3 of 4).
const payload = {
  model: MODEL,
  stream: true,
  max_tokens: 4096,
  system: [{ type: "text", text: "You are Pi, a coding agent.\n" + filler, cache_control: { type: "ephemeral" } }],
  tools: [{
    name: "ctx_execute",
    description: "Run code in a sandbox.",
    input_schema: { type: "object", properties: {} },
    cache_control: { type: "ephemeral" },
  }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Run nvidia-smi and tell me the GPU state.", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "text", text: "Running it now." }] },
  ],
};

captureFrozenContext(payload);
console.log("capture diagnostics:", JSON.stringify(getFrozenContextCaptureDiagnostics()));
const checkpoint = getFrozenContextCheckpoint();
if (!checkpoint) {
  console.error("FAIL: no checkpoint captured — the shape guard rejected an Anthropic payload");
  process.exit(1);
}

const ask = (questionBlockText) => askWithFrozenContext({
  checkpoint,
  questionBlockText,
  baseUrl: provider.baseUrl,
  apiKey: provider.apiKey,
  maxTokens: 128,
});

const first = await ask("Reply with exactly the word: ALPHA");
console.log("call 1:", JSON.stringify(first.usage), "text=", JSON.stringify(first.text.slice(0, 60)));
const second = await ask("Reply with exactly the word: BETA");
console.log("call 2:", JSON.stringify(second.usage), "text=", JSON.stringify(second.text.slice(0, 60)));

const passed = second.usage.cacheRead > 0;
console.log(passed
  ? `PASS: warm replay read ${second.usage.cacheRead} cached tokens (write=${second.usage.cacheWrite})`
  : `FAIL: warm replay read 0 cached tokens (write=${second.usage.cacheWrite}) — prefix bytes differ`);
process.exit(passed ? 0 : 1);
