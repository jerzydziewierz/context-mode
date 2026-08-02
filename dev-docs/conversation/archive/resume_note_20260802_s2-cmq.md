> **To resume:** `/skill:pickup cmq` (pi, has the pickup skill) — or, any agent:
> read this note top-to-bottom, then AGENTS.md + the docs it links, then
> `git log`/`git status` for drift since 20260802, re-run the checks named
> below, and continue. Code is truth; this note is a stale map.

# Pi context checkpoint/clone + `question` mode — resume (s2-cmq)

## State

Two strands merged into one this session.

**Strand A (inherited, uncommitted):** the `question` parameter for `ctx_execute` /
`ctx_execute_file` is **implemented and green**. Server side stores full raw output and returns a
compact envelope + `_meta["context-mode/question"]`; Pi bridge picks that up, runs a nested model call,
returns `Status/Answer/Evidence/Full output/Retrieve`. `npm run typecheck` clean, 36/36 bridge tests
pass, bundle + drift asserts pass. **Nothing committed yet.**

**Strand B (this session's question from Grey):** can pi checkpoint the *live* context, clone it, ask
throwaway questions, discard, and resume from the same checkpoint — with the prompt cache staying warm?
I read pi's installed source rather than guessing. **Answer: no first-class API, but rewriting pi core
is probably not needed.** Details in `dev-docs/bug-report-pi-no-context-checkpoint-fork-api.md`.

Stalled at: the cache hypothesis is **unverified**. Next concrete thing is to dump the real provider
payload via `before_provider_request` and diff it against a reconstructed one. That single experiment
decides the whole architecture.

We search not what masters of old have found; we search for what they searched for.

## What shipped this session

*Investigated*
- pi session/fork/branch primitives, `pi-ai` cache-control internals, agent-loop request construction.
- Confirmed `sessionId` → `x-session-affinity` **header only**, not cache identity.
- Confirmed Anthropic breakpoint placement: system prompt, last tool, last block of last user message.

*Added*
- `dev-docs/bug-report-pi-no-context-checkpoint-fork-api.md` — the capability-gap analysis + the one
  experiment that settles it.
- `dev-docs/bug-report-question-mode-no-prompt-cache-reuse.md` — `cacheRetention: "short"` on the nested
  call is strictly worse than `"none"`; costs the write premium for zero reads.
- `dev-docs/bug-report-question-mode-double-tool-result-handler.md` — two `tool_result` handlers, error
  flag smuggled through `details`, ordering is incidental.

*Archived*
- `resume_note_20260801_s1-cmq.md` → `dev-docs/conversation/archive/`.

*Not changed*
- No product code touched this session. All `git status` modifications are the inherited s1 work.

## What I need to remember

**The decisive fact.** Anthropic prompt caching is **prefix-byte matching**. Not session id, not model
id, not a handle. `anthropic-messages.js:968-988`. Everything else follows from this. Any scheme that
does not reproduce the primary request's leading bytes exactly gets a full miss, full stop.

**Corollary that kills the naive design.** The whole point of `question` mode is to keep the big raw
output *out* of the primary context. But cache reuse requires *sending the primary prefix*. These pull
in opposite directions. You can have "cheap because short prompt" or "cheap because cached prefix" —
not obviously both. Grey should be told this tension explicitly; it may change what they want.

**Unverified hypothesis worth one experiment (the whole ballgame).** An extension can assemble
`{ systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(sm.buildSessionContext()), tools: pi.getAllTools() }`,
append one ephemeral question, and call `completeSimple()` with the *same* `sessionId` and
`cacheRetention: "short"`. If the reconstruction is byte-identical, the appended tail is the only new
input and the rest is a cache **read**. Then discarding is trivial (it only ever lived in a local
variable) and the primary session is untouched. Proof = nonzero `usage.cacheRead` ≈ primary prompt size.
Do not trust a payload diff alone; trust the billed `cacheRead`.

**Four known ways the reconstruction can differ** (each one = total cache miss, all listed in the bug
report): `ToolInfo` is a `Pick<>` and may not serialize like the real `ToolDefinition`; other
extensions' `context` / `before_provider_request` hooks mutate the payload *after* our snapshot point;
OAuth mode injects an extra "You are Claude Code" system block; Anthropic allows only 4 breakpoints and
ours could evict the main loop's.

**Dead ends — do not re-walk these.**
- `ctx.fork()` / `ctx.newSession()` / `ctx.switchSession()` / `ctx.navigateTree()` are **command-only**;
  docs say they deadlock from event handlers. Useless from a tool handler.
- `/clone`, `/fork`, `--fork`, `createBranchedSession()` all produce **session files**. None gives a
  detached in-memory context.
- The `examples/extensions/subagent/` pattern spawns `pi --mode json -p --no-session` as a subprocess.
  Isolated, yes; cache-sharing, no; plus recursion risk with our own bridge.
- `pi.sendMessage()` / `sendUserMessage()` steer the *main* loop. Not isolated. Wrong tool.

**Closest thing pi has to a named checkpoint.** Compaction entries with `retainedTail` are described in
`docs/session-format.md` as *self-contained checkpoints* — `buildSessionContext()` rebuilds from them
without walking older entries. If we ever want a persisted checkpoint rather than an ephemeral one,
that is the existing mechanism to lean on, not a new entry type.

**Sanctioned debugging route.** `docs/extensions.md` says `before_provider_request` "is mainly useful
for debugging provider serialization and **cache behavior**". pi's authors pointed at exactly the tool
we need. Also `dist/core/cache-stats.js` already computes per-turn cache waste (`CACHE_TTL_MS = 5min`,
`NOISE_FLOOR_TOKENS = 1024`) — free instrumentation, do not rebuild it.

**pi's own convention, which we violate.** Every one-off call in pi core sets `cacheRetention: "none"`
+ fresh `uuidv7()`: `compaction.js:444`, `examples/extensions/summarize.ts`,
`examples/extensions/custom-compaction.ts`. Our bridge sets `"short"` at mcp-bridge.ts:359. We are the
odd one out and we are paying for it.

**Noticed in passing, unchecked.** The shortlist models in `~/.pi/model-shortlist.env` are Fireworks
(`kimi-k3`, `glm-5p2`) — they route through `openai-completions.js`, **not** `anthropic-messages.js`.
All my cache findings are from the Anthropic path. Whether Fireworks honors `cacheRetention` at all is
unknown. One grep would settle it. This matters because the shortlist is what question mode actually
uses by default.

**Repo layout footgun.** `/home/mib07150/git/zfs/git/private/pi-plugins` is **not** a git repo. Only
`context-mode/` (and presumably its siblings) are. `git` commands must be run from inside
`context-mode/`. Cost me one failed command.

## Next concrete steps

1. **Run the payload experiment.** Temporary extension: `before_provider_request` dumps the real payload
   to a file; alongside it, reconstruct the payload from `getSystemPrompt()` + `convertToLlm()` +
   `getAllTools()`; diff. Then do one live nested call and read `usage.cacheRead`. This is ~an hour and
   it decides everything below.
2. **Report the result to Grey before building anything.** If `cacheRead` is real → the checkpoint/clone
   feature is an extension, no core changes. If not → tell Grey pi core would need a first-class
   "branch the in-flight request" API, and let them decide whether that is worth it.
3. **Independently of 1–2, fix mcp-bridge.ts:359** to `cacheRetention: "none"` + fresh `uuidv7()`, with a
   comment explaining why, so nobody "optimizes" it back. This is correct under *either* outcome, since
   the current nested prompt shares no prefix with anything.
4. Grep `openai-completions.js` for `cacheRetention` handling → settles the Fireworks question above.
5. Address `dev-docs/bug-report-question-mode-double-tool-result-handler.md`: merge the two handlers,
   namespace the details key, add the missing "question + nonzero exit + Pi adapter" end-to-end test.
6. Run the **full** suite (`npm test`) — this session only ran `tests/adapters/pi-mcp-bridge.test.ts`
   and typecheck. The inherited work touches `src/server.ts` and `tests/core/server.test.ts` too.
7. Then commit the s1 feature work. It is green but has never been committed.

## Open Q for Grey

- **Q-s2-1:** The cache tension is real: keeping raw output out of context and reusing the cached prefix
  pull in opposite directions. Which do you actually want optimized — small prompts, or warm cache?
- **Q-s2-2:** If the payload-reconstruction experiment succeeds, are you OK depending on byte-exact
  reconstruction of pi's internal payload? It is brittle against pi upgrades and against other
  extensions' hooks. Ship it, or ask upstream for a real API first?
- **Q-s2-3:** Inherited from s1, still unanswered: must `question` work across every MCP host, or is
  Pi-only acceptable? (Non-Pi hosts currently get evidence + retrieval reference, no semantic answer.)
- **Q-s2-4:** The s1 feature work is green but uncommitted, and I have not run the full suite. Want me
  to run `npm test` and commit it as-is next session, or hold until the cache decision lands?

## Pre-amnesia workspace state

- **Uncommitted (inherited from s1, all green, not mine):** `README.md`, `cli.bundle.mjs`,
  `configs/pi/AGENTS.md`, `server.bundle.mjs`, `skills/context-mode/SKILL.md`,
  `src/adapters/pi/extension.ts`, `src/adapters/pi/mcp-bridge.ts`, `src/server.ts`,
  `tests/adapters/pi-mcp-bridge.test.ts`, `tests/core/server.test.ts`. Bundles are in sync with source
  (`assert-bundle` passes) — do **not** rebuild blindly, it will churn the minified diffs.
- **Added by me:** three `dev-docs/bug-report-*.md` files + this note. Previous note archived.
- **Verified green this session:** `npm run typecheck`, `npx vitest run tests/adapters/pi-mcp-bridge.test.ts`
  (36/36), `scripts/assert-bundle.mjs`, `scripts/assert-asymmetric-drift.mjs`.
- **NOT run:** full `npm test`. Flagged as step 6 above.
- No scratch files. No stray TODO/FIXME added. `dev-docs/conversation/memories/` does not exist —
  nothing to prune.
