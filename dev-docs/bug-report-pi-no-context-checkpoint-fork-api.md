# Bug report / capability gap: pi has no in-process "checkpoint + clone current context" API

Status: **capability gap in pi core**, not a context-mode defect. Recorded here because it blocks the
feature Grey asked for, and because a future agent will otherwise re-derive this from scratch.

## What Grey wants

Take the **entire current live conversation context**, checkpoint it, clone the checkpoint, ask an
ephemeral question against the clone, discard the clone, then resume the *original* session from the
same checkpoint — and have the provider prompt cache stay warm across all of it.

## What pi actually offers (all read from installed source, not guessed)

Root: `/home/mib07150/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/`

Session-tree primitives — real, but **file/session level, not live-context level**:

- `docs/session-format.md` — `SessionManager`: `branch(entryId)`, `branchWithSummary()`,
  `createBranchedSession(leafId)`, `forkFrom()`, `inMemory()`, `newSession({parentSession})`,
  `buildContextEntries()`, `buildSessionContext()`.
- `docs/sessions.md` — `/tree` (branch in place, same file), `/fork` (new file from an earlier user
  message), `/clone` (duplicate active branch into a new file). CLI: `pi --fork <path|id>`,
  `pi --no-session`.
- `docs/session-format.md` "Context Building" — compaction entries with `retainedTail` act as
  **self-contained checkpoints**; `buildSessionContext()` can rebuild from them without walking older
  entries. This is the closest thing pi has to a named checkpoint.
- `docs/extensions.md:1111-1275` — `ctx.newSession()`, `ctx.fork(entryId)`, `ctx.navigateTree(targetId)`,
  `ctx.switchSession(path)`. **Commands only** — the docs say these "can deadlock if called from event
  handlers", so a tool handler cannot use them.

Nested-model primitives:

- `@earendil-works/pi-ai/compat` → `complete()`, `completeSimple()`, `streamSimple()`. Take a
  `Context { systemPrompt?, messages, tools? }` you construct yourself
  (`pi-ai/dist/types.d.ts:362-366`).
- `convertToLlm(messages)` is exported (`dist/index.d.ts:10`) so an extension *can* turn session
  entries into provider messages.
- `pi.getAllTools()` returns `ToolInfo[]` = `Pick<ToolDefinition, "name"|"description"|"parameters"|"promptGuidelines">`
  (`dist/core/extensions/types.d.ts:1122`).
- `ctx.getSystemPrompt()` returns the current system prompt string.

## Why this does not add up to what Grey wants

1. **No live-context fork.** Every fork/clone/branch primitive produces a *session file* or moves a
   *leaf pointer*. None hands you a detached, in-memory copy of the in-flight request that you can run
   a throwaway turn against and then drop. `ctx.fork()` / `ctx.switchSession()` mutate the user's actual
   session and are command-only.

2. **No cache-sharing nested call.** The agent's own request is built in
   `@earendil-works/pi-agent-core/dist/agent.js:275-290` (`createContextSnapshot()` +
   `createLoopConfig()`), which passes `sessionId: this.sessionId` down to the provider. But per
   `pi-ai/dist/api/anthropic-messages.js:688`, `sessionId` only becomes an `x-session-affinity` header.
   Anthropic prompt caching is **prefix-byte matching**, not session-id matching
   (`anthropic-messages.js:968-988` places the breakpoint on the last user block). So a nested call
   only gets cache reads if it reproduces the primary prefix byte-for-byte.

3. **Therefore the theoretical path exists but is manual and fragile:** an extension could rebuild
   `{ systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(sessionManager.buildSessionContext()),
   tools: pi.getAllTools() }`, append one ephemeral question message, and call `completeSimple()` with
   `cacheRetention: "short"` + the *same* `sessionId`. If the reconstruction is byte-identical to what
   the main loop would have sent, Anthropic should serve the shared prefix as a cache **read** and only
   bill the appended tail. **This is a hypothesis. It is NOT verified.** Untested risks:
   - `ToolInfo` is a `Pick<>` — it may not serialize identically to the real `ToolDefinition` the main
     loop sends, and tool JSON is part of the cached prefix (`anthropic-messages.js:1019`).
   - `before_provider_request` / `context` hooks from *other* extensions mutate the real payload after
     our reconstruction point (`docs/extensions.md` says `ctx.getSystemPrompt()` does not reflect
     `before_provider_request` rewrites).
   - OAuth-token mode injects an extra "You are Claude Code" system block
     (`anthropic-messages.js:722-735`) that a naive reconstruction would omit.
   - Anthropic allows only 4 cache breakpoints; adding our own could evict the main loop's.

4. **A "discard and resume" guarantee is free** *if* we never touch the SessionManager — the throwaway
   turn lives only in our local variable. The hard part is not discarding, it is the cache.

## Verification path for the next agent (cheapest first)

Use `pi.on("before_provider_request")` (`docs/extensions.md`) to dump the **real** payload the main loop
sends. Then dump our reconstructed payload. Diff the two JSON blobs. If they differ only in the
appended tail, hypothesis 3 holds and the feature is buildable as an extension with no pi core changes.
If the prefixes differ, measure `usage.cacheRead` on the nested call — a nonzero `cacheRead` roughly
equal to the primary prompt size is the only real proof.

`docs/extensions.md` explicitly says `before_provider_request` "is mainly useful for debugging provider
serialization and **cache behavior**" — so this is the sanctioned route.

## Bottom line for Grey

- Rewriting pi core is **probably not required**.
- But the extension-level path is unproven and depends on byte-exact payload reconstruction, which is
  brittle against pi upgrades and against other extensions' hooks.
- The safe, boring alternative is what `question` mode already does: a small standalone call with
  `cacheRetention: "none"` (see `dev-docs/bug-report-question-mode-no-prompt-cache-reuse.md`), accepting
  that it re-reads nothing and simply keeps the raw output out of the primary context.
