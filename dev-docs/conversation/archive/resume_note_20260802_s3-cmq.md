> **To resume:** `/skill:pickup cmq` (pi, has the pickup skill) — or, any agent:
> read this note top-to-bottom, then AGENTS.md + the docs it links, then
> `git log`/`git status` for drift since 20260802, re-run the checks named
> below, and continue. Code is truth; this note is a stale map.

# Checkpoint/fork-questions cache-reuse — RESOLVED; next: fix `question` param (s3-cmq)

## State

Strand B is **proven and closed**. The experiment (commit `19e51d0`) showed
decisively: **a `before_provider_request` wire-payload snapshot IS a working
checkpoint — replaying those exact bytes + an appended question block reads the
primary loop's prompt cache** (cacheRead≈15.1k / cacheWrite=0, 5/5 clean runs
through pi's dario/CCR proxy). No pi core changes needed; the checkpoint/clone
feature is a pure extension.

**Grey's next instruction (this session's forward task):** use the new method to
fix the `context-mode` plugin so the `question` parameter goes out with a **full
context** rather than a separate question — i.e., the question call should carry
the frozen full context + the question, and `cacheRetention: "short"` so it
reuses the primary cache. The manual (`dev-docs/cache-experiment/MANUAL.md`) is
written and ready as the implementation spec.

## What shipped this session

*Proven (commit `19e51d0`, added forked-from-research)*
- Exp A (raw api.anthropic.com): identical prefix + appended question =
  full cache read; `max_tokens` variance does not escape the prefix key.
- Exp B: `before_provider_request` dumps the exact real pi wire payload
  (system+tools+messages, `cache_control:ephemeral` on last block). The dario
  (CCR at `:3456`) proxy forwards cache_control+usage transparently; cache
  persists across processes (fresh `--no-session` run read its own prefix).
- Exp C2: raw replay of captured payload + question → **5/5 cacheRead≈15.1k,
  cacheWrite=0**. The whole ~15.2k-token prefix (system 17.5KB + 21 tools + 2
  user msgs) read; only the ~2-token question billed. Proxy accepts literal
  `dario` key → same upstream pool → no account-binding blocker.
- Exp C1 (pi-ai `provider.streamSimple` nested): fails on **auth only**
  (`"No API key for provider: dario"` — models.json `apiKey:"dario"` override
  not wired into direct provider calls; `getProviderAuth("dario")` returns
  nothing). Fix = pass `apiKey` in `StreamOptions` or read provider config.
  NOT a cache failure.

*Added*
- `dev-docs/cache-experiment/README.md` — full findings + re-run steps.
- `dev-docs/cache-experiment/MANUAL.md` — **the deliverable**: succinct
  user/programmer manual for fork-questions with cache reuse, with rules,
  economics, footguns, and the reference implementation pointer.
- `dev-docs/cache-experiment/exp-a-raw.mjs` — raw mechanism test.
- `dev-docs/cache-experiment/cmq-exp-extension.ts` — deterministic hook-driven
  `pi -e` probe (before_provider_request dump + turn_end C1/C2), no model
  cooperation needed.

*Archived*
- `resume_note_20260802_s2-cmq.md` → `dev-docs/conversation/archive/`.

*Committed:* `19e51d0` (experiment artifacts + both docs). Notes archived via
`git mv` (unstaged, committing with this note).

## What I need to remember

**The decisive fact (still the load-bearing one).** Anthropic prompt caching is
**prefix-byte matching** — no session id, no handles. `sessionId` only maps to
`x-session-affinity` header; `cacheRetention:"none"` just drops that header.
The pip cache key = system+tools+messages bytes up to the last `cache_control`
breakpoint. Breakpoints at: system, last tool, last block of last user message
(`anthropic-messages.js` 729/736/746 + 969-1019).

**The checkpoint trick in one line.** Capture the EXACT wire payload at
`before_provider_request`; ask = clone it, drop `stream`, append
`{role:user, content:[{type:text, text:q, cache_control:{type:ephemeral}}]}`,
POST to `{baseUrl}/v1/messages` with the provider key → full cache read.
Byte-exact by construction → immune to adapter/hook/orchestration drift.

**Q-s2-1 RESOLVED.** Warm cache wins decisively for multi-question checkpoints:
N questions ≈ 1 write (or 0) + N reads (0.1× prefix + 1× tail). Small-prompt
alternative loses on both price and fidelity for N≥2. Report this resolved
tension to Grey if it comes up again.

**Q-s2-2 (brittleness) RESOLVED too.** Worry was byte-exact *reconstruction*
from pi-ai internals. Snapshotting the actual wire bytes sidesteps it entirely
— the captured payload IS reality. The only remaining brittleness: pi adapter
serialization changes between capture and replay → re-capture per session and
assert cacheRead before trusting.

**The 4-breakpoint budget.** system(1) + last tool(1) + last user block(1) +
appended question block(1) = 4. Exactly at the Anthropic cap. Dialogue
follow-ups (q2 after q1·a1) still work — the frozen prefix stays the anchor;
reads keep hitting (empirically verified pattern via Exp A).

**TTL mechanics.** "short" = 5-min TTL, refreshed on reads. First ask after idle
expiry pays one write; subsequent reads. In-session rapid-fire questions are
all reads.

**C1 auth footgun (real, will bite the fix).** Direct `provider.streamSimple`
from an extension hook can't resolve models.json `apiKey` overrides — fails
"No API key for provider: dario". The MAIN loop uses a different auth path.
For the `question`-param fix, either pass `apiKey` explicitly (StreamOptions
has it) and/or use the C2 raw-fetch pattern which sidesteps pi auth entirely
(just read the key from models.json provider config).

**Fireworks/Nebius path unverified.** Shortlist models (`model-shortlist.env`:
nebius/moonshotai/Kimi-K3, nebius/zai-org/GLM-5.2 — NOTE: actually Nebius, not
Fireworks as s2 guessed) route through `openai-completions.js`. Whether
`cache_control` is honored there is unknown — one grep settles it. The dario
path (api `anthropic-messages`) is the one proven.

**Environment map (was a rabbit hole).** pi talks to `dario` provider =
`pi dario proxy` (CCR-style, v5.2.21, node pid, `localhost:3456`), which
forwards to upstream. `models.json` `providers.dario` = baseUrl
`http://localhost:3456`, apiKey `"dario"` (literal pool key). `settings.json
defaultModel` is a Fireworks model but sessions run `--model
dario/claude-sonnet-5` fine. Real `ANTHROPIC_API_KEY` also in env → raw tests
against api.anthropic.com possible directly.

**Repo footgun (re-learned).** `/home/mib07150/git/zfs/git/private/pi-plugins`
is NOT a git repo; only `context-mode/` (and `pi-fable-tools/`) are. Run git
from inside `context-mode/`.

**Inherited s1 work (NOT MINE).** Uncommitted: README.md, cli.bundle.mjs,
server.bundle.mjs, configs/pi/AGENTS.md, skills/context-mode/SKILL.md,
src/adapters/pi/{extension.ts,mcp-bridge.ts}, src/server.ts,
tests/{adapters/pi-mcp-bridge.test.ts, core/server.test.ts, pi-extension.test.ts}.
Green but never committed (s1 note said run full `npm test` first). Leave alone.
`dev-docs/bug-report-statusline-sqlite-fixture-unbatched-inserts.md` is also
untracked (someone's).

## Next concrete steps (the fix — Grey's ask)

1. **Read `MANUAL.md`** (`dev-docs/cache-experiment/MANUAL.md`) top-to-bottom —
   it IS the spec. Then `README.md` for the evidence.
2. **Locate the `question` param path:** `src/adapters/pi/mcp-bridge.ts` — the
   nested call currently `cacheRetention:"none"` (~:359-381) + how server.ts
   (question mode) returns the compact envelope. Find where the nested
   question context is built (currently separate/partial).
3. **Implement the fix:** when `question` mode is active, capture the primary
   wire payload (before_provider_request hook already exists in extension.ts —
   extend it or reuse) and send **full frozen context + question** via the C2
   raw-replay pattern — OR C1 pi-ai path with `apiKey` explicitly passed.
   Switch `cacheRetention` to `"short"`.
4. **Check the diff contract:** nested call's `usage.cacheRead > 0` proves the
   full context went out *and* hit the cache. Add a unit test asserting the
   wire payload contains the full context (not a stripped question-only).
5. **Verify with a live `pi -e` run** using the probe or a question-mode
   invocation; assert cacheRead≈prefix.
6. **Bundles:** rebuild `cli.bundle.mjs`/`server.bundle.mjs` only if
   `scripts/assert-bundle.mjs` complains — don't churn minified diffs
   blindly (s1-verified green).
7. Full `npm test` before committing (covers s1 work too, step 7 of s2 note).

## Open Q for Grey

- **Q-s3-1:** The `question`-param fix — prefer the C2 raw-fetch replay path
  (proven, sidesteps pi auth but hand-rolls HTTP/SSE) or C1 pi-ai
  `provider.streamSimple` with explicit apiKey (cleaner, needs the auth fix)?
  Reading between the lines of your instruction, raw-replay seems acceptable;
  but confirm before I pick.
- **Q-s3-2:** Checkpoint lifecycle for the fix: keep ONE rotating checkpoint
  (last primary payload, auto-replaced each turn) or per-question explicit
  snapshots? One-rotating is far simpler and matches "current context".
- **Q-s3-3:** (stale from s2) the double-`tool_result`-handler + missing
  "question + nonzero exit + Pi adapter" e2e test (bug report
  question-mode-double-tool-result-handler.md) — fix together with this work?

## Pre-amnesia workspace state

- **Committed:** `19e51d0` (cache experiment + README + MANUAL). Archival git
  mv of s2 note is STAGED but NOT yet committed — this note + that mv commit
  together as "resume note + memos for cmq".
- **Untracked:** `dev-docs/bug-report-statusline-sqlite-fixture-unbatched-inserts.md`
  (not mine; sibling strand's).
- **Inherited uncommitted s1 work:** as listed above — NOT mine to commit.
- **No scratch files.** `~/.pi/cmq-exp/` holds experiment dumps/RESULTS.json
  (gitignored-ish, outside repo — safe to keep for re-runs).
- **No memories dir** — nothing to prune.

## Key files

- `dev-docs/cache-experiment/MANUAL.md` — the spec (deliverable).
- `dev-docs/cache-experiment/README.md` — evidence + re-run steps.
- `dev-docs/cache-experiment/cmq-exp-extension.ts` — the probe (reference impl).
- `dev-docs/cache-experiment/exp-a-raw.mjs` — raw mechanism test.
- `dev-docs/bug-report-pi-no-context-checkpoint-fork-api.md` — now superseded by
  the proven experiment (fork-API gap is moot; snapshot wins). Could archive.
