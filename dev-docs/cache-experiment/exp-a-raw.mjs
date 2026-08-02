#!/usr/bin/env node
/**
 * EXPERIMENT A — Raw Anthropic prompt-cache mechanism proof.
 *
 * Question: does an identical byte-prefix + appended question tail get a
 * prompt-cache READ (not a write, not a miss)?
 *
 * Method (against api.anthropic.com directly, no pi involved):
 *   call 1: system (cache_control) + big filler user message (cache_control
 *           on its last block) + max_tokens small.
 *           → expects cache_creation_input_tokens > 0 (write).
 *   call 2: IDENTICAL system + filler, PLUS an appended question user message
 *           (cache_control on the question block), DIFFERENT max_tokens.
 *           → expects cache_read_input_tokens ≈ call-1 cache_creation, and
 *             cache_creation_input_tokens == 0.
 *
 * The different max_tokens on call 2 also tests whether non-prompt request
 * fields escape the cache key (they should — prefix bytes are the key).
 *
 * Usage: node exp-a-raw.mjs [model]
 * Env:   ANTHROPIC_API_KEY required.
 */

const API = "https://api.anthropic.com/v1/messages";
const MODEL = process.argv[2] || process.env.EXP_A_MODEL || "claude-sonnet-4-6";
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// Big filler so prefix is way above Anthropic's 1024-token cacheable minimum.
const FILLER = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
  "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure.",
  "Dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident.",
  "Sunt in culpa qui officia deserunt mollit anim id est laborum sed perspiciatis unde omnis iste natus error sit voluptatem accusantium.",
  "Doloremque laudantium totam rem aperiam eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.",
  "Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit sed quia consequuntur magni dolores eos qui ratione voluptatem.",
  "Neque porro quisquam est qui dolorem ipsum quia dolor sit amet consectetur adipisci velit sed quia non numquam eius modi tempora incidunt.",
  "Ut labore et dolore magnam aliquam quaerat voluptatem ut enim ad minima veniam quis nostrum exercitationem ullam corporis suscipit laboriosam.",
].join(" ");
// ~2.2k tokens of unique filler (indexed so content is unique per block)
const fillerBody = Array.from(
  { length: 4 },
  (_, i) => `P${i}: ${FILLER} ${i}${i}${i}${i}${i}${i}${i}${i}`,
).join("\n\n");

const system = "You are a research assistant. Answer tersely.\n" + FILLER; // ~600 tokens

function breakpoint() {
  return { type: "ephemeral" };
}

function buildCall(question, maxTokens) {
  const systemBlock = { type: "text", text: system, cache_control: breakpoint() };
  const fillerBlock = {
    type: "text",
    text: fillerBody,
    // Primary loop places cache_control on the last (only) block of the last
    // user message — i.e. conversation history is cacheable.
    cache_control: breakpoint(),
  };
  const messages = [{ role: "user", content: [fillerBlock] }];
  if (question) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: question, cache_control: breakpoint() }],
    });
  }
  return { model: MODEL, max_tokens: maxTokens, system: [systemBlock], messages };
}

async function call(label, body) {
  const t0 = Date.now();
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.error(`[${label}] HTTP ${res.status}:`, JSON.stringify(json).slice(0, 500));
    process.exit(1);
  }
  const u = json.usage;
  console.log(`[${label}] ${ms}ms model=${json.model} stop=${json.stop_reason}`);
  console.log(`  input=${u.input_tokens} output=${u.output_tokens} ` +
    `cacheRead=${u.cache_read_input_tokens} cacheWrite=${u.cache_creation_input_tokens}`);
  return u;
}

// The primary loop itself would have already cached this prefix; here we
// explicitly write it with call 1.
console.log(`model: ${MODEL}`);
const u1 = await call("WRITE (filler)", buildCall(null, 16));
const u2 = await call("READ  (filler+question)", buildCall("What was the second paragraph about?", 64));

const verdict = [];
if (u1.cache_creation_input_tokens > 0) verdict.push("PASS: call-1 wrote cache");
else verdict.push("FAIL: call-1 did not write cache (prefix too small or breakpoints wrong)");
if (u2.cache_read_input_tokens > 0) verdict.push("PASS: call-2 got a cache READ");
else verdict.push("FAIL: call-2 got NO cache read");
if (u2.cache_read_input_tokens >= u1.cache_creation_input_tokens * 0.5)
  verdict.push("PASS: read ≈ write size (prefix reused)");
else
  verdict.push(`INFO: read (${u2.cache_read_input_tokens}) << write (${u1.cache_creation_input_tokens})`);
if (u2.cache_creation_input_tokens === 0) verdict.push("PASS: no new write on call-2");
else verdict.push("INFO: call-2 wrote too");

console.log("\n" + verdict.join("\n"));
