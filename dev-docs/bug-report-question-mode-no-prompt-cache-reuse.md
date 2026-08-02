# Bug report: `question` mode nested model call cannot reuse the primary prompt cache

Status: **FIXED (s5-cmq) — cache reuse now implemented.** The frozen-context replay path
(`src/adapters/pi/frozen-context.ts` + the `before_provider_request` capture in `extension.ts`)
sends the FULL captured primary wire payload + one appended question block to the primary
model's own endpoint, so the whole prefix bills as a cache READ (mechanism proven 2026-08-02,
cacheRead≈15.1k / cacheWrite=0, 5/5 — see `dev-docs/cache-experiment/MANUAL.md`). The
question also now *sees the full session context* (Grey's original ask). The s3 fix below
(`cacheRetention: "none"` + fresh uuid on the standalone shortlist call) remains correct **as
the fallback path** — it runs when no checkpoint exists (fresh session, non-capturing host,
model switch) or when the replay transport fails.

Prior status: **FIXED (s3-cmq)** — option 1 applied at `src/adapters/pi/mcp-bridge.ts` (`cacheRetention: "none"`
+ fresh `randomUUID()`), with a comment naming pi's own convention so it does not get "re-optimized"
back.

> ⚠️ **UNVERIFIED — DISCUSSED WITH GREY 2026-08-02.** The "Resolved" section below claims the
> shortlist models honor `cacheRetention`. **That claim has NO evidence trail in this repo — it is
> inherited working-tree prose written as settled fact, with no reproducible check (no grep, no
> experiment, no date, no pi version, no author recorded). Treat it as UNCONFIRMED until re-verified
> against the installed pi version.** The `cacheRetention: "none"` fix itself is correct regardless
> (a question-mode prompt shares zero prefix with anything, so there is never a read to pay a write
> premium for) — it is only the secondary "both shortlist models honor cacheRetention" sub-claim that
> lacks evidence. See the "Resolved" section below: every assertion there needs re-confirmation.

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

## UNCONFIRMED: do the shortlist models honor `cacheRetention`? — NO EVIDENCE, NEEDS RE-VERIFICATION

> **This section is an unverified analysis, NOT a confirmed fact.** It was inherited as working-tree
> prose (status already "FIXED" when found) with no reproducible check: no command output, no commit,
> no date/pi-version, no author. The claims below are **plausible from config** but **not demonstrated**:
>
> - What is verifiable: `~/.pi/model-shortlist.env` really lists `accounts/fireworks/models/kimi-k3`,
>   `accounts/fireworks/models/glm-5p2`, `accounts/fireworks/models/deepseek-v4-flash-0731`; and
>   `~/.pi/agent/models.json` has BOTH a `fireworks` PROVIDER entry AND a `nebius` entry
>   (`api":"openai-completions"`, `baseUrl":"https://api.tokenfactory.nebius.com/v1"`) whose models are
>   `moonshotai/Kimi-K3` and `zai-org/GLM-5.2`. So BOTH provider paths exist in the live config — but
>   the shortlist-file IDs are the fireworks ones.
> - What is NOT demonstrated: that `pi-ai/dist/providers/data/fireworks.json` was actually read and
>   contains the compat fields cited below; that `kimi-k3` actually resolves to api
>   `anthropic-messages` at question-run time (model resolution order matters); that
>   `openai-completions.js` actually suppresses cache_control as described; or that both models price
>   `cacheWrite: 0` on the live account. There is no `nebius.json` in `pi-ai/dist/providers/data/`
>   (only `fireworks.json`) — the nebius provider lives entirely in user `models.json`, and nothing in
>   this repo verifies cacheRetention behavior for it.
>
> **To confirm (one focused pass, ~20 min):** (1) resolve the actual model-id → provider → api mapping
> at question-run time (`ctx.modelRegistry`/models.json precedence); (2) grep the installed
> `openai-completions.js` for `resolveCacheRetention`/`getCompatCacheControl`/`cacheControlFormat` on
> the CURRENT pi version; (3) note which shortlist entry is the default question model; (4) ideally one
> live `question:` call per model checking `usage.cacheWrite`/`cacheRead`. Update this section with the
> evidence, pi version, and date when done.

Plausible-from-config analysis (original wording preserved, treated as unverified):

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
