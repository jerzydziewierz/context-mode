> **To resume:** `/skill:pickup piask` (pi, has the pickup skill) — or, any agent:
> read this note top-to-bottom, then the docs it links, then
> `git log`/`git status` for drift since 20260802 **in BOTH repos**, re-run the
> checks named below, and continue. Code is truth; this note is a stale map.
> **Work happens in `~/git/zfs/git/from-source/pi`** (branch
> `feat/ask-with-frozen-context`); this note lives in context-mode because the
> strand was born here.

# askWithFrozenContext() PR: source recon DONE, implementation NOT started (s2-piask)

## State

Parked late-night mid-stride: the pi monorepo is cloned, forked, branch cut,
deps installed (`npm ci --ignore-scripts`, clean), **full source recon done —
no implementation code written yet**. Grey is writing the upstream issue
himself (gate requirement). Next session: write the code. Everything below is
what recon established, so do NOT re-derive it.

## Repos + branches

- **Work repo:** `~/git/zfs/git/from-source/pi` — fork clone
  (`origin` = jerzydziewierz/pi, `upstream` = earendil-works/pi), branch
  `feat/ask-with-frozen-context`, ZERO commits on it yet, tree clean, in
  sync with upstream/main at freeze.
- **context-mode:** all work committed AND pushed to `fork` remote
  (jerzydziewierz/context-mode). `origin` (mksglu) is read-only for us.
  Plugin-side frozen-context feature SHIPPED there (s5-cmq): see
  `src/adapters/pi/frozen-context.ts` — port its ideas, not its code.

## The contribution gate (hard constraints, from CONTRIBUTING.md + AGENTS.md)

- **No PR until a maintainer replies `lgtm`** on an issue. All new-contributor
  PRs auto-close (verified: their PR #7046 died exactly this way). **Grey is
  writing the issue himself, in his own voice** — LLM-written issues risk a
  permanent block. Do not draft or post it for him unless he asks for a skeleton.
- Their AGENTS.md binds us in that repo: no inline imports; no `any`; erasable
  TS only; `npm run check` after code changes (full output); `./test.sh` not
  raw vitest; specific tests via
  `node ../../node_modules/vitest/dist/cli.js --run test/x.test.ts` from the
  package root; **never commit unless Grey asks**; stage explicit paths only;
  no emojis; core philosophy "minimal core — should this be an extension?".
- Weekend issues get deprioritized; Discord is the fast lane.

## Architecture recon (the map — all verified by reading source this session)

**The payload pipeline** (why core can do what the plugin cannot):
1. `packages/agent/src/agent-loop.ts` `streamAssistantResponse()` (~:281-312)
   builds `llmContext` and calls `streamFunction(model, llmContext, {...config,
   apiKey, signal})`.
2. Each provider adapter builds wire params then calls
   `options?.onPayload?.(params, model)` — anthropic-messages.ts:550,
   openai-completions.ts:233, openai-responses.ts:140. **Return value replaces
   params** (this is where before_provider_request rides; also where a core
   snapshot hook belongs).
3. coding-agent `sdk.ts:331` wires `onPayload` → extension runner
   `emitBeforeProviderRequest` (runner.ts:1016).

**Where the API lands** (decision made during recon, defensible in PR):
- `ExtensionContext` (coding-agent `src/core/extensions/types.ts:307-347`) gets
  `askWithFrozenContext(options)`. Implementation flows like the existing
  members: `runner.createContext()` (runner.ts:673) exposes it →
  `bindCore(actions, contextActions)` (runner.ts:315) wires it →
  `_bindExtensionCore` (agent-session.ts:2331, contextActions block ~:2407-2437)
  implements it on AgentSession — alongside `compact`/`getSystemPrompt`.
  Runner field idiom: `private askFn: ... = () => {throw}` + assign in bindCore
  (mirror `compactFn` runner.ts:286/349/744).
- Snapshot capture: AgentSession already owns the `onPayload` chain
  (sdk.ts:331 for the CLI path, but note the harness builds its own Agent with
  its own onPayload — capture must live where BOTH paths pass:
  **AgentSession**, e.g. wrap agent.onPayload in `_buildRuntime` or capture in
  its own onPayload layer). Store `{payload, model}` per request; clear on
  session switch/reset.
- Replay: pi has NO "send raw payload" path — `ModelRuntime.streamSimple`
  (model-runtime.ts:508) re-serializes Context via the adapter. For core, the
  clean move is NOT raw fetch (that's the plugin hack) but an **options-level
  payload override**: the adapters already accept payload replacement via
  `onPayload` return. So: nested call = `modelRuntime.streamSimple(model,
  dummyContext, {...opts, onPayload: () => clonedSnapshotPlusQuestion})` — the
  adapter serializes dummy, onPayload swaps in the frozen bytes. Same
  provider/auth/retry stack, byte-exact wire body. **This is the elegant core
  trick recon found; validate it compiles/behaves before writing the PR.**
  Alternative if it feels too cute: add an explicit `rawPayload` option to
  SimpleStreamOptions (bigger API surface — maintainers may prefer either).

**Test harness facts:**
- `packages/coding-agent/test/suite/harness.ts` — `createHarness({tools,
  extensionFactories, ...})`, faux provider, `setResponses([...])`.
- **Faux provider models prompt-cache honestly** (providers/faux.ts
  `withUsageEstimate` ~:215-250): per-sessionId prompt cache,
  `commonPrefixLength` → usage.cacheRead/cacheWrite estimated from shared
  prefix, skipped when `cacheRetention === "none"`. So a suite test CAN assert
  cacheRead > 0 on the nested ask without real APIs — gift, use it.
- Faux serializes context via `serializeContext` (system + messages + tools
  concat) — prefix matching is at that string level.
- Regression naming: `test/suite/regressions/<issue>-<slug>.test.ts` — once
  Grey's issue has a number, name the suite test after it.
- `fauxAssistantMessage(content, {stopReason})`, `fauxToolCall(name, args)`
  helpers; extensionFactories get the real `pi` ExtensionAPI.

**Types to touch:** ExtensionContextActions (types.ts:1633) gains the ask
action; ExtensionContext (types.ts:307) gains the method;
`extensions-runner.test.ts:92` has an `extensionContextActions` fixture that
must gain the new required member (or make it optional — smaller diff,
weaker contract; pick one and defend it).

## What I need to remember

- **Prior art searched** (gh, 2026-08-02): #6654 open (promptCacheKey
  option), #7046/#6627/#6919 closed — cache-adjacent, none is our feature.
  No collision. Cite #6654 as related-not-overlapping in the PR.
- The onPayload-as-injection replay trick is UNVALIDATED — it is recon's best
  idea, not tested code. First thing next session: spike it in a suite test
  before building the API around it.
- `Agent.reset()` (agent.ts:326) and model switches invalidate the snapshot —
  clear it there; a stale-model ask must reject (mirror the plugin's
  wireModelId guard).
- maxTokens for the ask: SimpleStreamOptions.maxTokens exists (ai types.ts:118).
- The plugin implementation (context-mode frozen-context.ts) is the semantic
  reference: breakpoint budget ≤4, shape-guarded capture, never mutate the
  captured object, cache miss = cost not correctness.
- context-mode f4a7bab is committed+pushed but **never live-smoke-tested**
  (no real `question:` call asserting cacheRead>0 through the dario proxy).
  Separate loose end, cmq strand, not this one.

## Next concrete steps

1. **Spike the replay trick**: suite test — harness, two prompts, capture
   payload via an extensionFactory's before_provider_request, then
   `modelRuntime.streamSimple(model, dummyCtx, {onPayload: () => frozen})`
   against the faux provider; assert the faux saw the frozen bytes. If the
   trick fails, fall back to explicit `rawPayload` option design.
2. Implement capture + `askWithFrozenContext` per the map above (types →
   runner → agent-session → docs comment on ExtensionContext).
3. Tests: suite test asserting (a) full-context bytes went out, (b)
   cacheRead > 0 via faux usage estimator, (c) stale-model rejection,
   (d) no-snapshot rejection.
4. `npm run check` (full output) + `./test.sh`.
5. Hold the branch. **PR only after Grey's issue gets `lgtm`.** Then: PR body
   from the capability-gap bug report + MANUAL.md numbers, link Grey's issue,
   `docs(agent)`-style title per their commit format.

## Open Q for Grey

- **Q-s2-piask-1**: has the upstream issue been posted yet? Number? (Needed
  for regression-test naming and PR linkage.)
- **Q-s2-piask-2**: cmq strand — the plugin feature is shipped and pushed;
  its s4 note still sits top-level. Close/archive cmq as done, or keep it
  open pending the live smoke test (cacheRead>0 through the dario proxy)?

## Pre-amnesia workspace state

- pi clone: branch `feat/ask-with-frozen-context`, clean, no commits, deps
  installed. Nothing uncommitted anywhere.
- context-mode: clean, main == fork/main (pushed). s1-piask note archived
  this handover; s4-cmq left top-level (sibling strand, Grey decides).
- No scratch files, no stale TODOs added this session, no memories dir.
