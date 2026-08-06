#!/usr/bin/env node
/**
 * EXPERIMENT E — the SHIPPED answerQuestionResult() takes the frozen-context
 * path and reads cache, live, end to end.
 *
 * D proves the replay primitive. E proves the whole question path on top of
 * it: buildFrozenQuestionInput → replay → parseQuestionAnswer → debug line.
 * The shortlist fallback's streamSimple is wired to THROW, so a pass is proof
 * the fallback never ran.
 *
 *   call 1 → path=frozen-context, cache write
 *   call 2 → path=frozen-context, cacheRead > 0  (the claim under test)
 *
 * Run:  npm run build && node dev-docs/cache-experiment/exp-e-bridge-endtoend.mjs
 * Env:  CMQ_MODEL (default claude-opus-5) — must be a dario model id.
 *
 * Result 2026-08-06 (claude-opus-5): write=15041 → read=14649, write=387.
 * PASS, with correct context-aware answers both calls.
 *
 * NOTE: this drives the modules directly, so it proves REPLAY under a
 * synthetic capture. It does NOT prove pi's before_provider_request hook
 * feeds capture in a live session — for that, run a real
 * ctx_execute(..., question, debug:true) in pi and read the Debug line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureFrozenContext } from "../../build/adapters/pi/frozen-context.js";
import { answerQuestionResult } from "../../build/adapters/pi/mcp-bridge.js";

const models = JSON.parse(readFileSync(join(process.env.HOME, ".pi/agent/models.json"), "utf-8"));
const provider = (models.providers ?? models).dario;
const MODEL = process.env.CMQ_MODEL ?? "claude-opus-5";

const filler = Array.from({ length: 320 }, (_, i) =>
  `Line ${i}: the context-mode extension records tool output and indexes it into FTS5 for later retrieval.`,
).join("\n");

captureFrozenContext({
  model: MODEL,
  stream: true,
  max_tokens: 4096,
  system: [{ type: "text", text: "You are Pi, a coding agent.\n" + filler, cache_control: { type: "ephemeral" } }],
  tools: [{ name: "ctx_execute", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Check the GPU state.", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "text", text: "Running nvidia-smi." }] },
  ],
});

const rawOutput = [
  "GPU 0: NVIDIA RTX 6000 Ada  temp 41C  util 3%  mem 1024MiB / 49140MiB",
  "GPU 1: NVIDIA RTX 6000 Ada  temp 39C  util 0%  mem 12MiB / 49140MiB",
  "Processes: PID 4711 python train.py 980MiB",
].join("\n");

const questionResult = (question) => ({
  content: [{ type: "text", text: rawOutput }],
  isError: false,
  _meta: {
    "context-mode/question": {
      version: 1,
      question,
      answerInput: rawOutput,
      evidence: rawOutput,
      rawOutputBytes: rawOutput.length,
      outputReduced: false,
      source: "execute:shell:question:live-probe",
      status: "completed (exit 0)",
      backgrounded: false,
      isError: false,
    },
  },
});

const primary = { provider: "dario", id: MODEL, baseUrl: provider.baseUrl, contextWindow: 200_000 };
const ctx = {
  model: primary,
  modelRegistry: {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: provider.apiKey }),
    getProvider: () => ({
      streamSimple: () => { throw new Error("SHORTLIST FALLBACK RAN — the frozen path failed"); },
    }),
  },
};

const questions = [
  "How many GPUs are present and what is GPU 0 temperature?",
  "Which PID is using GPU memory, and how much?",
];

let last;
for (const [index, question] of questions.entries()) {
  last = await answerQuestionResult(questionResult(question), ctx, ["p/small"], true);
  console.log(`\n=== call ${index + 1} ===\n${last?.text}`);
}

const cacheRead = last?.usage?.cacheRead ?? 0;
const tookFrozenPath = Boolean(last?.text?.includes("path=frozen-context"));
console.log(tookFrozenPath && cacheRead > 0
  ? `\nPASS: path=frozen-context and warm cacheRead=${cacheRead}`
  : `\nFAIL: frozenPath=${tookFrozenPath} cacheRead=${cacheRead}`);
process.exit(tookFrozenPath && cacheRead > 0 ? 0 : 1);
