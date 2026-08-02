# Bug report: `question` mode nested model call cannot reuse the primary prompt cache

Status: **design defect, confirmed by reading pi source**. Not a crash. It costs money on every `question:` call.

## Where

- `context-mode/src/adapters/pi/mcp-bridge.ts:330-365` — `answerQuestionResult()` builds the nested call.
  - line 356 `reasoning: selected.thinkingLevel ?? "low"`
  - line 357 `maxTokens: 1_200`
  - line 358 `transport: "sse"`
  - line 359 `cacheRetention: "short"`
  - line 360 `sessionId: \`${sessionId}:context-mode-question:${modelRef(selected.model)}\``

## What is wrong

The nested call sends a **fresh, self-contained prompt**: a 6-line system prompt plus one JSON user message
(`buildQuestionInput()`). It shares **zero** prefix bytes with the primary agent's request. Therefore:

- `cacheRetention: "short"` writes a cache entry that will never be read again, because the next
  `question:` call has a different `executionResult` payload and so a different prefix.
- We pay the Anthropic cache-**write** premium (~1.25x input) on every question call and get **no** read discount.
- `sessionId` is routing/affinity only — see evidence below. It does not join a KV cache.

Net effect: `cacheRetention: "short"` here is strictly worse than `"none"`. Pi's own one-off callers
(`compaction.js:444`, `examples/extensions/summarize.ts`, `examples/extensions/custom-compaction.ts`)
all deliberately set `cacheRetention: "none"` + a fresh `uuidv7()` for exactly this reason.

## Evidence from installed pi source

Root: `/home/mib07150/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/`

- `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:968-988` — cache breakpoint is placed
  on the **last block of the last user message**, plus system prompt (`:729-746`) and last tool (`:1019`).
  Anthropic caching is a strict **prefix** match, so a different message body = full miss.
- Same file `:357-358`:
  ```js
  const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
  const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
  ```
  and `:688`:
  ```js
  const sessionAffinityHeaders = sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders
    ? { "x-session-affinity": sessionId } : {};
  ```
  `sessionId` becomes an `x-session-affinity` **header** — gateway routing, not cache identity.
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts:69-73` — the doc comment for `sessionId` says
  "Providers **can** use this to enable prompt caching, request routing, or other session-aware features.
  Ignored by providers that don't support it." On the Anthropic path it is routing only (see above).

## Fix options (need Grey's call)

1. **Cheap + correct today:** set `cacheRetention: "none"` and a fresh `uuidv7()` on the nested call,
   matching pi's own one-off convention. Loses nothing (there was no reuse), saves the write premium.
2. **Actually cacheable:** make the nested prompt prefix-stable — put the constant system prompt and a
   constant instruction block *first*, and the volatile `executionResult` *last*. Only helps if the
   nested-call system prompt is large enough to be worth a breakpoint (it currently is not; ~6 lines).
3. **Real reuse** would require replaying the primary conversation prefix in the nested call, which is
   the thing we are explicitly trying to avoid (the whole point of `question` is to keep raw output and
   long context out of the primary path). See
   `dev-docs/bug-report-pi-no-context-checkpoint-fork-api.md` for why pi has no API for this.

Recommendation: option 1 now, and note option 2 in the code as a comment so a future agent does not
"re-optimize" it back to `"short"`.

## Not yet verified

- Whether the Fireworks models named in `~/.pi/model-shortlist.env`
  (`accounts/fireworks/models/kimi-k3`, `accounts/fireworks/models/glm-5p2`) honor `cacheRetention` at
  all. They go through the OpenAI-completions API path, not `anthropic-messages.js`. Worth one grep of
  `pi-ai/dist/api/openai-completions.js` before finalizing option 1's wording.
