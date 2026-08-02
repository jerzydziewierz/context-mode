# Bug report: `question` mode nested model call cannot reuse the primary prompt cache

Status: **FIXED (s3-cmq)** — option 1 applied at `src/adapters/pi/mcp-bridge.ts` (`cacheRetention: "none"`
+ fresh `randomUUID()`), with a comment naming pi's own convention so it does not get "re-optimized"
back. The Fireworks open question below is now answered: yes, both shortlist models honor
`cacheRetention`, and the fix is correct on both API paths.

Original status: **design defect, confirmed by reading pi source**. Not a crash. It cost money on every `question:` call.

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

## Resolved: do the Fireworks shortlist models honor `cacheRetention`? — YES, both, on both paths

Checked `pi-ai/dist/providers/data/fireworks.json`. The two shortlist models do **not** share an API path:

| shortlist model | api | relevant compat |
|---|---|---|
| `accounts/fireworks/models/kimi-k3` | `anthropic-messages` | `sendSessionAffinityHeaders: true`, `supportsCacheControlOnTools: false`, `supportsLongCacheRetention: false` |
| `accounts/fireworks/models/glm-5p2` | `openai-completions` | `supportsStore: false`, `supportsDeveloperRole: false` |

So `kimi-k3` — the **first** shortlist entry, i.e. the default question model — goes through
`anthropic-messages.js` after all, and every cache finding in this report applies to it directly.

`glm-5p2` goes through `openai-completions.js`, which honors `cacheRetention` through its own
`resolveCacheRetention()` (`:93-99`, same default-to-`"short"` shape as the Anthropic path). Two
consequences there:

- `getCompatCacheControl()` (`:690-696`) returns `undefined` unless `cacheControlFormat === "anthropic"`,
  which for Fireworks it is not (`:1157` sets it only for OpenRouter + `anthropic/` model ids). So no
  explicit `cache_control` breakpoints are emitted for `glm-5p2` — caching, if any, is the provider's
  implicit prefix caching.
- `createClient()` (`:488-499`) still forwards `sessionId` as `x-session-affinity` /
  `x-client-request-id` headers when `sendSessionAffinityHeaders` is set — routing, not cache identity.
  Same conclusion as the Anthropic path.

Either way, `cacheRetention: "none"` is the correct setting: on `kimi-k3` it avoids a write premium for
reads that cannot happen, and on `glm-5p2` it suppresses a `prompt_cache_key` that would only pin
routing for a prompt nobody will send again. Note both models price `cacheWrite: 0` — so on Fireworks
specifically the wasted-write cost is zero and the fix is about correctness and consistency with pi's
convention rather than about a billing saving on this particular shortlist.
