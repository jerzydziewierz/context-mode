> **To resume:** `/skill:pickup piask` (pi, has the pickup skill) — or, any agent:
> read this note top-to-bottom, then the docs it links, then verify the claims
> against the code (both repos), and continue. Code is truth; this note is a
> stale map. **This strand works in a DIFFERENT repo** (a fresh clone of
> upstream pi) — this note lives in context-mode only because that is where
> the strand was born.

# Upstream `askWithFrozenContext()` for pi core + PR to earendil-works/pi (s1-piask)

## Goal (Grey, 2026-08-02, verbatim intent)

Get the latest pi source, implement **`askWithFrozenContext()` into pi core**,
and submit a clean PR to https://github.com/earendil-works/pi. An accepted
upstream API is personally more valuable to Grey than the plugin-side
workaround. The plugin workaround **already ships** (see below) — the PR does
not block anything; it upstreams a proven mechanism as a first-class primitive.

## What is already true (do NOT redo)

- **The mechanism is proven and shipping** in context-mode commit `f4a7bab`
  (branch main, `/home/mib07150/git/zfs/git/private/pi-plugins/context-mode`):
  - `src/adapters/pi/frozen-context.ts` — capture + raw-replay, the exact
    logic the core API should absorb. Read it first; it is the reference.
  - `src/adapters/pi/extension.ts` — `before_provider_request` → capture;
    `session_start` → clear.
  - `dev-docs/cache-experiment/MANUAL.md` — the spec: prefix-byte caching,
    the checkpoint trick, rules, footguns, economics. **This is the PR's
    design rationale in miniature.**
  - Proof numbers: cacheRead≈15.1k / cacheWrite=0, 5/5 runs through a
    CCR-style proxy (2026-08-02); full suite 210 files / 4729 passed after
    integration.
- **Why plugin-side is second-best** (= the PR motivation): every consumer
  must hand-roll (a) a `before_provider_request` capture hook, (b) a raw
  HTTP POST that bypasses pi's provider layer (auth/retry/streaming/usage
  accounting all reimplemented), because `streamSimple()` re-serializes from
  parts and cannot replay exact bytes. The capability gap is documented in
  `dev-docs/bug-report-pi-no-context-checkpoint-fork-api.md` — pi has session
  forks (file-level) but **no live-context fork**: nothing hands you the
  in-flight request to run a throwaway turn against. That bug report is
  ~90% of the PR description already written.

## Environment facts (verified 2026-08-02)

- Installed pi: **v0.83.0** at `/home/mib07150/.local/share/pi-node/
  node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent`.
  Monorepo upstream: `github.com/earendil-works/pi`, package dir
  `packages/coding-agent`. The provider layer lives in a sibling package
  (`@earendil-works/pi-ai`, likely `packages/ai`).
- **No local clone exists yet** (checked `~/git` tree). Step 1 is the clone.
- Key upstream code coordinates (from the installed dist — re-locate in src):
  - `dist/core/sdk.js:200-206` — `onPayload` → `emitBeforeProviderRequest`
    (where the exact wire payload surfaces).
  - `dist/core/extensions/runner.js:773-804` — the emitter; handlers may
    replace the payload.
  - `pi-ai` `anthropic-messages.js` — breakpoint placement (system / last
    tool / last user; ~729/736/746) and `sessionId` → `x-session-affinity`
    only (caching is prefix-byte, not session).
  - `dist/core/extensions/types.d.ts:209-249` — `ExtensionContext` (where
    the new API most naturally hangs).

## Proposed API sketch (starting point, NOT a settled design — expect the
## maintainers to have opinions; keep the PR small and negotiable)

```ts
// On ExtensionContext (or a new pi.ai namespace):
askWithFrozenContext(options: {
  question: string;              // appended as one user block
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<{ text: string; usage: Usage; stopReason: StopReason }>;
```

Semantics: pi keeps its own rotating snapshot of the last provider payload
(it already flows through `onPayload`); the call clones it, drops `stream`,
appends the question block (with `cache_control` iff < 4 breakpoints in the
snapshot), sends through the **provider layer** (pi-internal — so auth,
retries, and usage accounting come for free; this is the part a plugin
cannot do), never touches the SessionManager (the throwaway turn is
discarded by construction). Errors: reject if no snapshot yet or model
switched since capture.

## Next concrete steps

1. `git clone https://github.com/earendil-works/pi ~/git/zfs/git/from-source/pi`
   (or Grey's preferred location) and orient: find the src counterparts of the
   dist coordinates above; read CONTRIBUTING/AGENTS files; find how the repo
   runs its tests.
2. **Check upstream first**: search existing issues/PRs for prompt-cache /
   frozen-context / fork-question work. If something exists, join it instead
   of colliding. Consider opening a short issue *before* the PR to test the
   maintainers' appetite for the API shape (cheap; avoids wasted work).
3. Implement: capture in core (rotating slot next to `onPayload`), the ask
   method on `ExtensionContext` (or wherever fits the codebase's idiom —
   follow their conventions, not ours), unit tests in their style.
4. PR: title like `feat: askWithFrozenContext() — one-off question against
   the live context with prompt-cache reuse`. Body: the capability gap
   (from the bug report), the mechanism (from MANUAL.md), the proof numbers,
   and context-mode as the shipping downstream consumer that would migrate.
   Link nothing private — rewrite, don't paste, anything from this repo's
   dev-docs.
5. After the PR is up: note the URL here (or in the next resume note) so
   context-mode can later swap its raw-fetch replay for the core API behind
   the same one-function seam (`askWithFrozenContext` in
   `frozen-context.ts` was named to match on purpose).

## Traps for the next session (paid for already)

- **`streamSimple()` cannot replay exact bytes** — it re-serializes from
  parts. The core implementation must snapshot at/after serialization
  (the `onPayload` boundary), not rebuild from session entries.
- **Reconstruction (buildSessionContext/convertToLlm/getSystemPrompt) is a
  dead end** — byte-drift risk (ToolInfo Pick<>, OAuth system-block
  injection, other extensions' request rewrites). It also failed auth in
  the original experiment. Do not resurrect it in the PR.
- **≤4 cache breakpoints** (Anthropic hard limit). The snapshot usually
  holds 3; append the question's breakpoint only when budget remains.
- **Cache is per model+endpoint+account.** The ask must go out exactly as
  the primary does; in core this is free (same provider path) — say so in
  the PR, it is the core-vs-plugin argument in one line.
- **This machine's pi is a pi-node distribution** (`~/.local/share/pi-node`)
  — do not confuse the installed dist with the clone during development;
  test against the clone's own harness.

## Open Q for Grey

- **Q-s1-piask-1**: clone location — `~/git/zfs/git/from-source/pi` assumed;
  confirm or redirect.
- **Q-s1-piask-2**: issue-first or PR-first? Note recommends a short
  API-shape issue before coding the PR (maintainer appetite test). Grey may
  prefer to just ship the PR.
- **Q-s1-piask-3**: GitHub identity/fork to submit from (the machine's `gh`
  auth was not checked this session).

## Pre-amnesia workspace state (context-mode repo, for reference)

- Implementation committed: `f4a7bab` on main; branch was **10 commits ahead
  of origin/main, NOT pushed** at freeze time (Q-s4-3 push decision still
  open with Grey).
- Full suite green post-implementation: 210 files, 4729 passed, 28 skipped.
- This strand (`piask`) starts fresh — no code exists for it yet anywhere.
