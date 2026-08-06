> **To resume:** `/skill:pickup cmq` (pi, has the pickup skill) — or, any agent:
> read this note top-to-bottom, then AGENTS.md + the docs it links, then
> `git log`/`git status` for drift since 20260802, re-run the checks named
> below, and continue. Code is truth; this note is a stale map.

# Stable base reached; ONE task remains: `question`-param full-context fix (s4-cmq)

## State

**All previous strands are CLOSED. The repo is a stable base.** The cache
experiment is proven (`19e51d0`), the manual is the spec (`49e845b`), the s1
question-mode feature is committed and green (`0c1497a`), and the pre-existing
statusline-sqlite test flake is fixed (`6432318`). Full suite green. Working
tree clean. The only remaining work is Grey's requested follow-up: make the
`question` parameter send the **full frozen context + question** (cache-reusing)
instead of a separate/short question — an implementation task, fully spec'd,
no open design questions blocking it.

## What shipped this session (s4: no code, housekeeping)

*Verification (before the commits)*
- `npm run typecheck` clean; `assert-bundle` 6/6 OK; `assert-asymmetric-drift` OK.
- Full `npx vitest run`: **210/210 files, 4723 passed, 28 skipped** — after fixing
  the flake. (s1 had never had the full suite run before; the note said so.)

*Committed (GitHub log)*
- `0c1497a` — question-mode full Pi adapter support (the s1 feature + both
  question-mode bug reports marked FIXED + docs/skills + bundles + tests).
- `6432318` — statusline-sqlite fixture flake fix (3050 autocommits → one
  `db.transaction()`; failing test went ~69s-timeout → passing, file suite 20s).
  Bug report updated FIXED with before/after timing.
- `49e845b` — cache-experiment MANUAL.md (was missed from earlier handover
  commit; now in git).

*Cleaned*
- Stray `f0.tmp/f1.tmp/f2.tmp` (4-byte "data", created mid-vitest-run) removed —
  test debris, not content.

## What I need to remember

**The decisive fact.** Anthropic prompt caching is **prefix-byte matching** — no
session id, no handles. `sessionId` only maps to `x-session-affinity`.
`cacheRetention:"none"` just drops that header; it does NOT disable caching.
Cache key = system+tools+messages bytes up to the last `cache_control`
breakpoint (system / last tool / last user block; `anthropic-messages.js`
729/736/746 + 969-1019).

**The checkpoint trick (proven, THE spec).** Capture the exact wire payload at
`before_provider_request`; ask = clone it, drop `stream`, append
`{role:user, content:[{type:text, text:q, cache_control:{type:ephemeral}}]}`,
POST to `{baseUrl}/v1/messages` with the provider key → full cache read
(cacheRead≈15.1k / cacheWrite=0, 5/5 runs through dario/CCR proxy). Byte-exact
by construction → immune to adapter/hook drift. **Full detail + rules +
footguns: `dev-docs/cache-experiment/MANUAL.md`.**

**Q-s2-1/Q-s2-2 RESOLVED.** Warm-cache wins decisively for N questions against
one frozen checkpoint (1 write-or-0 + N reads @ 0.1×). Snapshotting the real
wire bytes sidesteps all reconstruction brittleness — no pi core changes.

**C1 auth footgun (will bite the fix).** Direct `provider.streamSimple` from an
extension hook fails `"No API key for provider: dario"` (models.json apiKey
override not wired into direct provider calls). Fix: pass `apiKey` in
`StreamOptions`, or use the C2 raw-fetch pattern (reads key from models.json /
`getProviderAuth`, fallback literal `"dario"`).

**Fireworks/Nebius cacheRetention — FLAG UNVERIFIED.** The committed
`bug-report-question-mode-no-prompt-cache-reuse.md` (FIXED) claims "both
shortlist models honor cacheRetention" — but no grep/experiment evidence exists
in the repo for that claim (inherited working-tree text). Shortlist models
(nebius/moonshotai/Kimi-K3, nebius/zai-org/GLM-5.2) route through
`openai-completions.js`, NOT the proven anthropic-messages path. The
`cacheRetention:"none"` fix is correct regardless (no shared prefix → never
worth a write premium); the "both honor it" claim just has no proof.

**Environment map.** pi → `dario` provider = `pi dario proxy` v5.2.21 on
`localhost:3456` (models.json: baseUrl localhost:3456, apiKey literal `"dario"`;
proxy → upstream; pool/sticky sessions). `settings.json defaultModel` is a
Fireworks model; sessions run `--model dario/claude-sonnet-5` fine. Real
`ANTHROPIC_API_KEY` in env for direct api.anthropic.com tests.

**Repo footgun.** `/home/mib07150/git/zfs/git/private/pi-plugins` is NOT a git
repo; run git from inside `context-mode/`. Branch is **7 commits ahead of
origin/main, NOT pushed**.

**Bundles in sync.** `cli.bundle.mjs`/`server.bundle.mjs` match src (s1
assert-bundle verified). Do NOT rebuild blindly — it churns minified diffs.

## Next concrete steps (THE fix — per MANUAL.md)

1. **(Optional) push:** branch is 7 ahead of origin/main — `git push` if Grey
   wants the stable base published.
2. **Locate the `question` path:** `src/adapters/pi/mcp-bridge.ts` nested call
   (currently `cacheRetention:"none"` + fresh uuid, question-only context) and
   `src/server.ts` envelope. The ask: send **full frozen context + question**
   with `cacheRetention` re-enabled at `"short"`, per the C2 raw-replay pattern
   in MANUAL.md (or C1 pi-ai with explicit apiKey — Q-s4-1 below).
3. **Capture:** the extension already has `before_provider_request` plumbing
   (extension.ts) — reuse/extend to keep a rotating checkpoint of the last
   primary wire payload (Q-s4-2).
4. **Assert:** nested call `usage.cacheRead > 0` ≈ prefix → full context went
   out AND cache hit. Add a unit test (wire payload contains full context, not
   question-only).
5. **Verify:** typecheck, `npx vitest run` (now green, fast), assert-bundle.
6. Rebuild bundles only if assert-bundle complains.

## Open Q for Grey

- **Q-s4-1** (carryover): for the fix — C2 raw-fetch replay (proven, sidesteps
  pi auth, hand-rolls HTTP) or C1 pi-ai `provider.streamSimple` + explicit
  apiKey (cleaner, needs the auth fix)? Raw-replay is the proven fallback.
- **Q-s4-2** (carryover): checkpoint lifecycle — one rotating checkpoint (last
  primary payload, auto-refreshed) vs explicit per-question snapshots? Rotating
  is far simpler and matches "current context".
- **Q-s4-3** (new): push the 7 commits to origin/main now?

## Pre-amnesia workspace state

- **Clean:** `git status` empty after the three commits (0c1497a, 6432318,
  49e845b). Nothing uncommitted, nothing untracked.
- **Ahead:** 7 commits ahead of origin/main; not pushed.
- **Experiment data:** `~/.pi/cmq-exp/` (payloads dumps + RESULTS.json) — outside
  the repo, safe to keep for re-runs; `dev-docs/cache-experiment/` committed.
- **No memories dir** — nothing to prune.
- **No stray scratch files.**

## Key files

- `dev-docs/cache-experiment/MANUAL.md` — **the spec** for the remaining fix.
- `dev-docs/cache-experiment/README.md` — evidence + re-run steps.
- `dev-docs/cache-experiment/cmq-exp-extension.ts` + `exp-a-raw.mjs` — probe +
  raw test (reference impl for the fix).
- `src/adapters/pi/mcp-bridge.ts` (~:359-381) — the nested call to change.
- `src/server.ts` — question envelope (`buildQuestionResult`).
