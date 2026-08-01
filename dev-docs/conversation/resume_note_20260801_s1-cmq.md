> **To resume:** `/skill:pickup cmq` (pi, has pickup skill) — or, any agent:
> read this note top-to-bottom, then AGENTS.md + the docs it links, then
> `git log`/`git status` for drift since 20260801, re-run the checks named
> below, and continue. Code is truth; this note is a stale map.

# Context-mode question-answer tool result — resume

## State

User wants Context Mode changed for Pi. Add optional `question` parameter to execution tool calls. When given, tool must run command, keep full raw result outside main agent context, then produce a compact answer for that question. Answer must show command status, important result, small evidence snippet, and how to retrieve full result. User cares very much about provider prompt/KV-cache reuse. No source code changed yet. Source clone is `context-mode/`, commit was clean before this note.

We search not what masters of old have found; we search for what they searched for.

## Requirements from user

1. Add `question` parameter. Good call shape:

   ```ts
   ctx_execute({
     language: "shell",
     code: "npm test",
     question: "Did tests pass? If not, name failing tests and likely cause."
   })
   ```

2. Expected compact result:

   ```md
   Status: failed (exit 1)
   Answer: Two validation tests failed because apiKey is missing.
   Evidence: ValidationError: missing apiKey
   Full output: <stable retrievable result reference>
   ```

3. Full raw output must persist and be searchable/retrievable. Summary must cite small real evidence. Exit code/timeout remain authoritative. Do not claim success without them.
4. Avoid broad raw tool output in main conversation.
5. User proposed an extra model/subagent call supplied with recent context/question and raw tool result. It should answer salient task result, not make a generic summary.
6. Add docs and future-agent guidance. Use compact ASD-STE100 style: short direct sentences; one instruction per sentence; active voice; same word same meaning; no vague words/slang. Do **not** add caveman wording to shipped docs/config.
7. First find Pi-supported nested-model-call method that preserves/reuses provider KV cache. This is critical. Do not implement a costly separate subagent until cache behavior is known.

## Important source map

- `src/server.ts`
  - MCP `ctx_execute`: about lines 1647–1949.
  - MCP `ctx_execute_file`: about lines 2042–2227.
  - Existing optional `intent` is an FTS retrieval query. For output >5 KB it indexes output then returns BM25-selected previews. It does **not** ask an LLM or answer the intent.
  - Helpers: `intentSearch()` near lines 1983–2035; `indexStdout()` near 1952; thresholds: `INTENT_SEARCH_THRESHOLD = 5000`, `LARGE_OUTPUT_THRESHOLD = 102400`.
  - Existing `ContentStore` holds persistent full output in SQLite FTS5. It uses Porter + trigram, RRF, fuzzy correction, and proximity reranking. See `src/store.ts` and `src/search/unified.ts`.
- `src/adapters/pi/extension.ts`
  - Pi extension starts bridge and injects routing anchor.
  - Current Pi routing captures session events and blocks unsafe raw HTTP Bash output. It does not rewrite normal tool output.
- `src/adapters/pi/mcp-bridge.ts`
  - Bridges every MCP tool from `server.bundle.mjs` into Pi via `pi.registerTool()`.
  - The bridge forwards params unchanged and only gets final MCP result. It does not have raw command output hidden from the MCP server.
- `package.json`
  - Pi extension entry: `build/adapters/pi/extension.js`.
  - Build: `npm run build`; bundle includes `server.bundle.mjs`.
- `configs/pi/AGENTS.md`
  - Only short Pi config guidance today.
- `README.md`
  - Pi install section begins near line 1000.
- `CONTRIBUTING.md` lines ~344–364
  - Mandatory policy: Context Mode must not dictate prose style. Do not add “terse/caveman/only fluff die” or output-format style controls to shipped adapters, README, or server tool descriptions. Tests enforce this.
- `tests/core/server.test.ts` around 4858
  - Regression tests for that policy.

## Pi documentation research

Read Pi docs from:
`/home/mib07150/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/`

Relevant files read:

- `docs/extensions.md`
  - Extension custom tools can make nested LLM calls. Return combined nested `Usage` from tool result in `usage`; Pi records it in session/footer/RPC totals.
  - Tool handler gets `ctx.model`, `ctx.modelRegistry`, `ctx.signal`, `ctx.getSystemPrompt()`, `ctx.sessionManager`, and current context usage.
  - `ctx.modelRegistry.getApiKeyAndHeaders(model)` returns auth/header/env needed for direct request.
  - Docs say `tool_result` can modify a tool result, and nested async work should use `ctx.signal`.
  - `pi.sendMessage()`/`sendUserMessage()` inject messages into main agent. They are not isolated subagent calls; they trigger or steer main loop. Do not use this for result summarization.
  - Example index lists `examples/extensions/subagent/`: it spawns a separate `pi --mode json -p --no-session` process. This is isolated but likely loses provider prompt-cache prefix and risks recursive Context Mode bridge loading.
  - Direct nested LLM calls are documented through `@earendil-works/pi-ai/compat` `complete()`.
- `examples/extensions/summarize.ts`
  - Concrete direct call pattern:
    ```ts
    import { uuidv7 } from "@earendil-works/pi-ai";
    import { complete } from "@earendil-works/pi-ai/compat";
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    const response = await complete(model, { messages }, {
      apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
      reasoningEffort: "high", cacheRetention: "none", sessionId: uuidv7(),
    });
    ```
  - This example uses a separate one-off prompt and deliberately sets `cacheRetention: "none"` with a fresh UUID. It is evidence for nested calls, not cache reuse.
- `examples/extensions/custom-compaction.ts`
  - Same direct `complete()` pattern; `cacheRetention: "none"`; fresh `uuidv7()`.
- `docs/compaction.md`
  - Pi says one-off compaction/branch-summary requests use fresh routing session IDs and, where provider supports it, disable prompt-cache writes because they are unlikely to be reused.
  - Strong signal: standard standalone summary call is intentionally **not** cache-preserving.
- `examples/extensions/subagent/index.ts`
  - Isolated subagent uses a new `pi` process in JSON/print/no-session mode. It is not a cache-sharing API.

## Cache finding so far

Pi supports extra model calls. It does **not** document a plugin API that forks the current in-flight provider request or reuses its live KV cache. Prompt caching is provider-side and typically needs byte-identical cached prefix, same model/provider, and correct cache-control/session behavior. A separate `complete()` call with a small summarizer prompt will not reuse the main conversation prefix. A subprocess subagent will also not reuse it.

Next agent must inspect installed `@earendil-works/pi-ai` type/source files for exact `complete()` options and cache semantics. Earlier search used a wrong top-level path; actual package is nested here:

`/home/mib07150/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/`

Look for `cacheRetention`, `sessionId`, `complete`, Anthropic cache-control behavior, and main agent request construction. Determine whether reusing current `PI_SESSION_ID` / provider session ID aids routing only or truly reuses KV. Do not assume it does.

Likely conclusion: no true reuse for independent call. If so, design should avoid a second call by returning a compact retrieval envelope to the existing main agent, or accept an explicitly opt-in, separate cheap nested call. User must decide after evidence.

## Design options to present after cache research

### A. No extra call, cross-platform

Add `question` as a clearer answer-oriented alias/successor to `intent`.

- Run tool in current MCP server.
- Index full output.
- Return: authoritative status + BM25-selected snippets matching question + stable source/retrieval query.
- Main agent answers semantic question in its next turn.
- Cheap; cross-platform; no additional cache loss.
- Does not itself generate semantic answer.

### B. Pi-only nested direct model call

- MCP server must return raw/stored result to Pi adapter without placing it in main conversation. Existing bridge/API may need a new private result/details channel.
- Pi extension calls `complete()` with active `ctx.model`, proper auth, signal, usage accounting.
- Give nested model strict task/question + status + selected/raw result; return structured answer.
- Need output size/chunk/retrieval policy, timeout/cancel, recursion protection, PII/security policy, and fallback when model/auth unavailable.
- Separate request likely does not reuse main prompt cache. Confirm first.

### C. Separate Pi subprocess subagent

- Existing Pi example supports it.
- Highest isolation, but startup/cost/latency and cache loss. Context Mode recursion risk. Reject unless user specifically wants isolation.

### D. New Pi core feature

- Only way to plausibly preserve true in-flight cache: Pi core/provider would need a first-class nested/branch call sharing the exact serialized prefix/cache point. This is not an extension API found so far.

## Feature contract if implementation proceeds

Use `question`, not `summarize`. “Question” tells tool what output must answer. `summarize: true` is too vague.

Suggested schema:

```ts
question?: string
// Optional future: interpretation: "auto" | "always" | "never"
```

Semantics:

- Empty/omitted: current behavior exactly.
- Non-empty: full output is indexed under unique source label, even when small enough that current tool would otherwise return raw output.
- Return has explicit `Status`, `Answer` (only if semantic model enabled), `Evidence`, `Full output`, `Retrieve`.
- If semantic model unavailable/fails: return `Status`, evidence selected by FTS, full-output source, and clear statement that no semantic answer was generated. Do not pretend success.
- Preserve error result semantics. Nonzero process exit should remain tool error only according to existing `classifyNonZeroExit()` policy; do not hide it.
- Avoid source-label collisions: current `execute:${language}` and `file:${path}` labels overwrite on re-index. Question-mode full outputs need call/session-unique labels or documented latest-result semantics.
- Do not echo full executed source/output if question mode goal is keeping tool result compact. Audit/provenance requirements in `buildExecuteEcho()` must be reconciled, not silently removed.
- Tests must cover success, nonzero exit, timeout, no output, large output, question plus `intent`, indexing/retrieval source, fallback/no nested model, and unchanged old behavior.

## Open questions for Grey

- **Q-s1-1:** Must `question` produce a real nested-model answer now, even if it cannot share KV cache, or should v1 return an indexed evidence envelope and let main agent answer?
- **Q-s1-2:** Is Pi-only behavior acceptable, or must `question` work across every Context Mode MCP host?
- **Q-s1-3:** If nested model call is accepted, should it use current model or a configurable cheap model? Current model makes semantics match but may cost more.

## Next concrete steps

1. Inspect nested `pi-ai` source/type files. Establish exact cache/session semantics for `complete()` and main agent calls.
2. Report cache finding to Grey before implementation. Cache requirement decides architecture.
3. If no shareable cache exists, get decision on options A/B/D above.
4. Map tests around `ctx_execute`, `ctx_execute_file`, intent indexing, and Pi adapter bridge.
5. Implement narrow chosen path. Keep old behavior unchanged when `question` omitted.
6. Add tests, build, typecheck, relevant Vitest tests.
7. Update README + Pi config/tool guidance in ASD-STE100 style. Keep prose-style policy intact.

## Pre-amnesia workspace state

- `context-mode` was cloned this session; it is a separate clean Git repository.
- No product files changed.
- Added only this resume note and its `dev-docs/conversation/` directory.
- No scratch files found. No existing conversation/memory notes found. No stale TODO/FIXME added.
- No bug report written: no confirmed code defect yet; architecture/caching question is open design work, captured here.
