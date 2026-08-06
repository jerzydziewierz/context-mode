> **To resume:** `/skill:pickup cmq` (pi, has the pickup skill) — or, any agent:
> read this note top-to-bottom, then CLAUDE.md + the docs it links, then
> `git log`/`git status` for drift since 20260806, re-run the checks named
> below, and continue. Code is truth; this note is a stale map.

# Anthropic cache PROVEN on shipped code; one hook-fed live call left (s6-cmq)

## State

**RESTART FIRST.** Grey switched the session to Anthropic (`dario/claude-opus-5`)
mid-session. The `ctx_*` MCP tools then stopped resolving for me, so the final
in-pi `ctx_execute(..., question, debug:true)` probe never ran. Suspicion: the
extension needs a full pi restart to reload the rebuilt bundle. **Step 1 next
session: restart pi, then fire that one probe.** Everything else is done.

The big news: **CMQ works on Anthropic, live, on the code we ship.** Two new
experiments (D, E) drive the real `build/` modules against the real dario proxy
and both PASS with large cache reads. s5's `no-checkpoint` mystery is fully
diagnosed — it was never a hook failure, it was OpenAI Responses payload shape.
What remains is Grey's scope call (Q-s5-cmq-1) plus one confirmatory live call.

## What shipped this session

*Diagnosed*
- `captureAttempts=17; captureAccepted=0; captureOutcome=no-messages;
  payloadKeys=include,input,instructions,...` under `openai-codex/gpt-5.6-sol`.
  The nonzero attempt count **proves the hook fires** — s5 hypotheses 1-4
  (hook silent, event shape, session_start clearing, dup module instances) all
  dead. Cause: Responses `input` vs Anthropic `messages`.

*Proven live on `dario/claude-opus-5`*
- Exp D (`askWithFrozenContext`): cold `cacheWrite=14699` → warm
  `cacheRead=14675`. Re-run inside TTL: both calls `cacheRead≈14.7k, write=0`.
- Exp E (`answerQuestionResult` end to end): `path=frozen-context;
  frozenContext=replayed`, cold `cacheWrite=15041` → warm `cacheRead=14649`.
  Shortlist fallback's `streamSimple` wired to **throw** ⇒ proof it never ran.
  Answers were correct and context-aware both calls.

*Added*
- `dev-docs/cache-experiment/exp-d-shipped-replay.mjs`
- `dev-docs/cache-experiment/exp-e-bridge-endtoend.mjs`
  (promoted from `/tmp` scratch — they're real proofs; both honour `CMQ_MODEL`,
  both need `npm run build` first.)

*Updated*
- `dev-docs/cache-experiment/README.md` — Exp D/E sections + artifacts + the
  explicit scope limit on what D/E do not prove.
- `dev-docs/bug-report-pi-frozen-context-no-checkpoint.md` — status flipped to
  DIAGNOSED, diagnosis section prepended, original report kept below the fold.

*Verified*
- Targeted: `pi-mcp-bridge.test.ts` + `pi-extension.test.ts` → 111 passed.
- Full `npm test` (build + 6 bundles + assert-bundle + assert-asymmetric-drift):
  **210 files; 4,729 passed, 28 skipped, 0 failed.**
- Removed recurring `f0.tmp/f1.tmp/f2.tmp` test debris (it regenerates — see
  footguns).

## What I need to remember

**The one remaining gap, stated precisely.** D/E capture *synthetically* then
replay. So replay is live-proven end to end; **capture-fed-by-the-real-hook on
Anthropic is not.** The negative evidence (17 attempts on Responses) shows the
hook reaches capture, and the mocks prove the Anthropic guard accepts a correct
payload — so this is very likely fine. But "very likely" is exactly the trap s5
fell into. Fire the real probe.

**Restart hypothesis is untested.** `ctx_*` tools worked early in s6 and stopped
later. I never confirmed whether it was the model switch, the rebuild, or
something else. If they're still dead after a restart, that's a new bug worth
its own report — don't just work around it by driving `build/` directly (that's
what I had to do, and it's why the gap above exists).

**Follow-on defect, cheap.** On non-Anthropic providers the debug line reports
`frozenContext=no-checkpoint`, which reads like a capture bug when it's actually
"unsupported provider shape". Should name the shape. One-liner once Q-s5-cmq-1
is decided — don't do it before, the wording depends on the scope answer.

**Provider generalisation, if Grey says yes.** Weakening the capture guard alone
is *wrong and worse than nothing*: replay hardcodes `/v1/messages`,
`x-api-key`, `anthropic-version`, and the Anthropic response shape
(`frozen-context.ts:140+`). Accepting a Responses payload and POSTing it to
`/v1/messages` would fail loudly at best. Generalising means: capture provider
API kind alongside the payload, then separate replay strategies per wire API
(Anthropic Messages / OpenAI Responses / OpenAI Completions). Note the observed
Responses payload carries `prompt_cache_key` — OpenAI's caching is *not*
prefix-byte-identical semantics, so the whole "byte-exact prefix" theory needs
re-derivation for that provider, not just porting. Don't assume it transfers.

**Fireworks fallback still dead** — account `dziewierzjerzy-5e7dcd` suspended
(HTTP 412). All three shortlist entries in `~/.pi/model-shortlist.env` are
Fireworks, so the *standalone* path cannot answer at all right now. This did not
block D/E (they never touch it) but it means any test of the fallback branch is
currently untestable live. Q-s5-cmq-2.

**Secrets leak, mine, needs Grey action.** I ran an `env | grep` with a
`sed` redaction that silently didn't match, printing `ANTHROPIC_API_KEY`,
`ANTHROPIC_API_KEY2`, and `ANTHROPIC_STL_ADMIN_KEY` in full into the transcript
and therefore into `PI_SESSION_FILE`
(`~/.pi/agent/sessions/--home-mib07150-git-zfs-git-private-pi-plugins--/2026-08-06T17-50-24-412Z_*.jsonl`).
**Rotate those keys.** Lesson for future-me: never `env | grep` secrets and
trust an inline redaction — print key *names* only (`env | grep -c`, or
`| cut -d= -f1`).

**dario proxy config** (`~/.pi/agent/models.json`): `baseUrl
http://localhost:3456`, `api: anthropic-messages`, `apiKey` is the literal
5-char string `dario`, models `claude-opus-5|fable-5|sonnet-5`. D/E read this
file directly rather than hardcoding.

**Test debris footgun.** `f0.tmp/f1.tmp/f2.tmp` reappear in the repo root after
every full `npm test`. Some test writes them relative to cwd and doesn't clean
up. Not tracked down; worth a small fix so handovers stop having to sweep.

**Context-mode shell instrumentation footgun (still live, unrelated).**
`ctx_batch_execute` shell jobs starting with `if`/`for` break on the injected
`NODE_OPTIONS=...` prefix. Use JS or don't lead with a compound command.

**Sibling piask strand.** Upstream issue #7500, auto-closed, no maintainer
`lgtm`; branch separate. Untouched this session. Don't mix.

## Next concrete steps

1. **Restart pi fully** (new process, Anthropic model `dario/claude-*`).
2. Run one `ctx_execute(language:"shell", code:"echo cmq-probe", question:"...",
   debug:true)`. Read the `Debug:` line. Want: `captureOutcome=accepted`,
   `path=frozen-context`, `cacheRead > 0`.
   - If `ctx_*` still won't resolve → new bug report, that's the blocker.
   - If it reports `no-checkpoint` on Anthropic → capture really is broken in
     the live hook path; diagnose with the same `captureAttempts` counters.
3. Once green: mark the bug report RESOLVED, note the live numbers in the
   cache-experiment README.
4. Commit the s5 diagnostics + s6 experiments (see workspace state below).
5. Then, and only then, take Grey's answer to Q-s5-cmq-1 and either (a) improve
   the unsupported-provider debug wording, or (b) design per-API replay
   strategies. Re-derive OpenAI cache semantics from docs before coding (b).

## Open Q for Grey

- **Q-s5-cmq-1 (carried, now decidable):** Anthropic works. Should CMQ stay
  Anthropic-only for now — with a clear "unsupported provider" message
  elsewhere — or do we invest in per-wire-API capture/replay so OpenAI
  Responses and Completions also get frozen-context questions? Grey said
  "if it works, good, and then we will see if we can figure out other
  providers" — reading that as: ship Anthropic, treat providers as the next
  strand, but confirm.
- **Q-s5-cmq-2 (carried):** Fireworks account suspended ⇒ the whole standalone
  shortlist path is dead. Restore billing, or repoint
  `~/.pi/model-shortlist.env` at a live provider?
- **Q-s6-cmq-3:** Rotate the three `ANTHROPIC_*` keys I leaked into the session
  log (see above). Want me to do anything about the jsonl itself?

## Pre-amnesia workspace state

- **Uncommitted, all intentional, all green:**
  - `src/adapters/pi/frozen-context.ts`, `src/adapters/pi/mcp-bridge.ts`,
    `tests/adapters/pi-mcp-bridge.test.ts` — the s5 capture-diagnostics work.
  - `dev-docs/cache-experiment/exp-d-shipped-replay.mjs`,
    `exp-e-bridge-endtoend.mjs` — new (untracked until the memo commit).
  - `dev-docs/cache-experiment/README.md`,
    `dev-docs/bug-report-pi-frozen-context-no-checkpoint.md` — updated.
- s5 note archived to `dev-docs/conversation/archive/`.
- `f0.tmp/f1.tmp/f2.tmp` swept; they return after any full `npm test`.
- No memories dir in this repo; nothing to prune.
- `main` is 15 ahead of read-only `origin/main`; writable remote is `fork`.
- `/tmp/claude/cmq-*.mjs` scratch originals superseded by the promoted D/E
  scripts — ignore them, they're outside the repo.

*we search not what masters of old have found; we search for what they searched for*
