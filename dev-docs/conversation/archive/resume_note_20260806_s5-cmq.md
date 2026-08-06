> **To resume:** `/skill:pickup cmq` (pi, has the pickup skill) — or, any agent:
> read this note top-to-bottom, then CLAUDE.md + the docs it links, then
> `git log`/`git status` for drift since 20260806, re-run the checks named
> below, and continue. Code is truth; this note is a stale map.

# CMQ live smoke exposed no checkpoint; diagnose capture/provider mismatch (s5-cmq)

## State

CMQ remains open. The frozen-context implementation and mocks are green, and
this session added opt-in `debug:true` diagnostics so live question calls expose
the answer path and prompt-cache usage. After Grey restarted Pi, the first real
smoke test did **not** use frozen context: it reported
`path=standalone; frozenContext=no-checkpoint`. The standalone fallback then
failed because the configured Fireworks account is suspended. Next session's
single task: determine why `before_provider_request` did not leave an accepted
checkpoint, then make the live call report `path=frozen-context` and
`cacheRead > 0` (or establish/document an intentional provider limitation).

## What shipped this session

*Added + committed*
- `debug?: boolean` (default false) on `ctx_execute` and `ctx_execute_file`.
- Pi question results now show, only when requested: answer path, model,
  frozen-context fallback reason, and `input/output/cacheRead/cacheWrite/total`.
- Diagnostics cover frozen replay, standalone fallback, model mismatch,
  transport failure, and missing Pi adapter.
- README docs + schema/wiring/regression coverage; bundles rebuilt.
- Commit: `bdbef58` (`feat(pi): add question-mode cache diagnostics`).

*Verified*
- Full build green: `tsc`, all six bundles, `assert-bundle`,
  `assert-asymmetric-drift`.
- Full suite: **210/210 files; 4,729 passed, 28 skipped, 0 failed**.
- No scratch/untracked debris after tests; recurring `f0.tmp/f1.tmp/f2.tmp`
  test debris was removed.

*Live smoke — failed the cache criterion*
- Command: `nvidia-smi`, with a focused `question` and `debug:true`.
- Command exit: 0; raw output indexed under
  `execute:shell:question:msg2jicm-f4122ce4`.
- Debug: `path=standalone; frozenContext=no-checkpoint`.
- Fallback error: Fireworks HTTP 412, account `dziewierzjerzy-5e7dcd`
  suspended. This is separate from the missing checkpoint.

## What I need to remember

**Do not confuse proof layers.** The byte-replay mechanism itself was proven
through dario/CCR (cacheRead≈15.1k, cacheWrite=0, 5/5). Unit tests prove the
Anthropic-shaped implementation. The shipped integration has now been live
called, but capture failed before replay. CMQ is therefore not operationally
ready.

**Strongest hypothesis: provider shape mismatch, not hook failure.** Pickup
observed `PI_MODEL=gpt-5.6-sol`; this likely uses OpenAI Responses, whose wire
payload has `input`, not Anthropic `messages`. Current capture in
`src/adapters/pi/frozen-context.ts` rejects any payload without a non-empty
`messages` array. Replay also hardcodes Anthropic `/v1/messages`, headers, and
response shape. If confirmed, `no-checkpoint` is expected on this provider and
the real design question is Anthropic-only diagnostics vs provider-generic
capture/replay.

**Do not jump to that conclusion without runtime evidence.** Other live
possibilities: hook did not fire; event no longer uses `event.payload`;
`session_start` cleared after capture; duplicate module instances. Instrument
safe state first: attempt/accept counters, rejection reason, top-level key
names, timestamps/model only. Never log payload values, messages, auth, or
headers.

**Source map.**
- `src/adapters/pi/extension.ts:466-496`: session clear + hook registration.
- `src/adapters/pi/frozen-context.ts:66-83`: strict capture guard + slot.
- `src/adapters/pi/mcp-bridge.ts:402+`: reads slot and chooses replay/fallback.
- `src/adapters/pi/frozen-context.ts:140+`: Anthropic-only raw replay.
- `dev-docs/bug-report-pi-frozen-context-no-checkpoint.md`: full repro,
  hypotheses, diagnostic plan.
- `dev-docs/cache-experiment/MANUAL.md`: exact-prefix replay spec.

**Sibling piask strand.** Upstream issue is #7500, currently auto-closed with no
maintainer `lgtm`; no Pi core PR may open. Its branch remains separate. Do not
mix piask work into this diagnostic.

**Context-mode shell instrumentation footgun.** `ctx_batch_execute` shell jobs
that begin with `if`/`for` were broken by the injected `NODE_OPTIONS=...`
prefix (`NODE_OPTIONS=... if ...` syntax error). Use JS or avoid a compound
command as the first shell token. This is unrelated to CMQ.

## Next concrete steps

1. Pickup `cmq`; verify clean tree and rerun the targeted Pi tests (full suite
   was green at freeze).
2. Add safe capture diagnostics in `frozen-context.ts` and surface them through
   existing `debug:true`; tests must prove no payload content/secrets leak.
3. Live-run one minimal `ctx_execute(... question, debug:true)` and record:
   hook attempt count, rejection reason, top-level payload keys, active model,
   and lifecycle ordering.
4. Inspect current Pi provider/event types only after the live fact narrows the
   path. Confirm whether `gpt-5.6-sol` uses OpenAI Responses `input`.
5. If Anthropic support is intended, switch the live session to
   `dario/claude-*` and prove `path=frozen-context`, `cacheRead > 0`, ideally
   `cacheWrite=0` while warm.
6. If provider-generic behavior is intended, design separate exact-wire replay
   strategies (Anthropic Messages / OpenAI Responses / OpenAI Completions)
   rather than weakening the guard and then POSTing the wrong API shape.
7. Fix/replace the suspended Fireworks shortlist entry so standalone fallback
   can answer during diagnostics; do not mistake fallback success for cache
   success.
8. Run targeted tests, then full `npm test`; rebuild bundles only through the
   normal build. Commit and live-smoke again.

## Open Q for Grey

- **Q-s5-cmq-1:** After runtime diagnosis confirms the payload shape, should
  CMQ guarantee frozen-context replay across all Pi providers, or explicitly
  support only Anthropic Messages initially? Do not decide before step 3.
- **Q-s5-cmq-2:** Fireworks fallback account is suspended. Restore billing or
  choose a currently available shortlist model before testing fallback?

## Pre-amnesia workspace state

- Debug feature committed as `bdbef58`.
- This note, the new bug report, and archival move of s4-cmq are committed in
  the handover memo commit; tree clean.
- No scratch files, stale TODOs, or untracked debris.
- No memories directory; nothing to prune.
- `main` tracks read-only `origin/main`; writable remote is `fork`; handover
  commits pushed to `fork/main`.

*we search not what masters of old have found; we search for what they searched for*
