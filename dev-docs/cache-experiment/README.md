# Cache experiment — checkpoint + appended question → prompt-cache read (PROVEN)

**Dates:** 2026-08-02, extended 2026-08-06 · **Status:** proven, and proven again
against the *shipped* code (Exp D/E) · **Decision impact: the checkpoint/clone
question-mode feature is viable as a pure extension. No pi core changes needed.**

## Question

Can a pi extension checkpoint the *live* context, and later ask *many* questions
against that frozen checkpoint — each question reusing the primary loop's prompt
cache? (Resume-note `resume_note_20260802_s2-cmq.md` Strand B.)

## Mechanism (recap)

Anthropic prompt caching is **prefix-byte matching** — no session ids, no handles.
A request is billed as a cache read for every byte it shares with a previously
sent request *up to a `cache_control` breakpoint*. pi's adapters place breakpoints
at: system prompt, last tool, last block of the last user message
(`pi-ai/dist/api/anthropic-messages.js` lines 729/736/746 + 969-1019).
`cacheRetention: "none"` only drops the session-affinity header — the cache key
is the prefix bytes, so session id is irrelevant (confirmed in
`anthropic-messages.js:351-357`).

## Experiments & results

### Exp A — raw mechanism (api.anthropic.com, no pi) — ✅ PASS

`exp-a-raw.mjs`: call 1 = big filler (system + last-block breakpoints) wrote
`cacheWrite=1702`; call 2 = identical prefix + appended question block
(`cache_control` on the question), *different* `max_tokens`:
`cacheRead=1702`, `cacheWrite=8`.

→ Non-prompt request fields (`max_tokens`) do NOT escape/affect the cache key;
the appended-question-after-identical-prefix pattern reads the whole prior
prefix.

### Exp B — real payload capture — ✅ WORKS

`cmq-exp-extension.ts` `before_provider_request` hook dumps every primary wire
payload to `~/.pi/cmq-exp/payloads/<seq>.json`. Captured the real pi request:
`claude-sonnet-5` via `dario` (pi's CCR proxy at `localhost:3456`), system
17.5KB, **21 tools**, 2 user messages, `cache_control: ephemeral` on last block.

Notable: the dario proxy **forwards cache_control + usage transparently** and
pi's own loop **reads** its own previously-cached prefix
(`cacheRead=14863` on a fresh `--no-session` process → cache is server-side,
persists across sessions/processes; TTL refreshed by reads).

### Exp C2 — raw replay of the EXACT captured wire payload + question — ✅✅ DECISIVE

At `turn_end`, the extension cloned the freshest primary dump, dropped `stream`,
appended `{role:"user", content:[{type:"text", text:<question>, cache_control:{type:"ephemeral"}}]}`,
and POSTed it back to `{provider.baseUrl}/v1/messages` with `x-api-key: dario`.

**Result (4 consecutive runs): `cacheRead≈15100-15150`, `cacheWrite=0`.**

The entire ~15.2k-token prefix (system+tools+messages) read from cache; the
appended question was the only ~2-token new input. Zero write across the board.

→ **A frozen wire-prefix captured at the provider boundary IS a working
checkpoint.** Replaying those exact bytes + appended tail reads the cache
every time. The proxy accepts the literal `dario` key and routes to the same
upstream pool that cached the primary — no account-binding blocker.

### Exp C1 — go-through-pi nested call (pi-ai) — ⚠ FAILED (auth only, not cache)

`provider.streamSimple(model, {systemPrompt, messages, tools}, {cacheRetention:
"short", ...})` from the `turn_end` hook fails immediately with
`"No API key for provider: dario"`. The direct `provider.streamSimple` path does
not resolve the `models.json` override (`apiKey: "dario"`), and
`modelRegistry.getProviderAuth("dario")` returns no key (it surfaces
credential/OAuth auth, not literal models.json apiKey). **Not a cache failure.**

Follow-up (post-experiment): pass the key explicitly (`apiKey` is a
`StreamOptions` field — `streamSimple(model, context, {apiKey})`) resolved from
the models.json provider config; or use a custom `streamSimple` provider wrapper
that injects the key. The rebuilt Context (`getSystemPrompt()` +
`convertToLlm(buildSessionContext(entries, leafId))` + `getAllTools()`) is the
"friendlier" path to verify next; C2 proves the byte-level mechanism regardless.

### Exp D — the SHIPPED `askWithFrozenContext()` reads cache — ✅ PASS (2026-08-06)

`exp-d-shipped-replay.mjs`. A/C2 proved the mechanism with bespoke scripts; D
imports `build/adapters/pi/frozen-context.js` — the code we ship — captures a
realistic Anthropic wire payload and replays it twice against the live dario
proxy on `claude-opus-5`.

Cold: `cacheWrite=14699` → `cacheRead=14675, cacheWrite=22`. Re-run inside the
5-min TTL: `cacheRead=14699/14697, cacheWrite=0` on *both* calls.

### Exp E — the SHIPPED question path, end to end — ✅ PASS (2026-08-06)

`exp-e-bridge-endtoend.mjs`. Drives `answerQuestionResult()`, so it covers
`buildFrozenQuestionInput` → replay → `parseQuestionAnswer` → debug line. The
shortlist fallback's `streamSimple` is wired to **throw**, so a pass proves the
fallback never ran.

Both calls reported `path=frozen-context; frozenContext=replayed` with correct,
context-aware answers. Cold: `cacheWrite=15041` → `cacheRead=14649`. Warm:
`cacheRead=15036, cacheWrite=0`.

→ **The Anthropic path is operationally proven, not just mock-proven.**

**Scope limit — what D/E do NOT prove.** Both capture synthetically, so they
prove *replay*. They do not prove pi's `before_provider_request` hook feeds
capture in a live session. For that, run a real
`ctx_execute(..., question, debug:true)` inside pi on a `dario/claude-*` model
and read the `Debug:` line — expect `path=frozen-context` and `cacheRead > 0`.
The live *negative* evidence so far (`captureOutcome=no-messages` under
`openai-codex/gpt-5.6-sol`) shows the hook does fire and does reach capture;
see `dev-docs/bug-report-pi-frozen-context-no-checkpoint.md`.

## Verdict → architecture for the base function

| | |
|---|---|
| Checkpoint = | the exact wire payload captured by `before_provider_request` at the boundary. Byte-exact by construction — no reconstruction, no drift. |
| Ask = | clone checkpoint, append question block (wire shape + `cache_control`), send to `{provider.baseUrl}/v1/messages` with the provider's api key. Full cache read. |
| N questions = | each ask re-sends the same frozen prefix → all reads. TTL refreshed per read. First ask after idle (TTL expiry) may write once; subsequent all reads. |
| Cost per ask ≈ | read rate (0.1×) × prefix + full price × question tail. |

**Q-s2-1 resolved: warm cache wins decisively for the multi-question checkpoint
use case.** For a single one-shot question the small-prompt trade-off may
occasionally win, but for N≥2 against a frozen checkpoint, byte-replay reads
dominate on every axis.

**Remaining engineering (not cache):** (1) C1 auth fix if we prefer pi-ai's
Context path over raw fetch; (2) raw-fetch path must parse SSE streaming or use
`stream: false` (cache unaffected — proven); (3) checkpoint storage/eviction
size (~0.4-1MB per 100k-token context); (4) verify Fireworks/Nebius paths honor
`cache_control` (shortlist models route through `openai-completions.js`).

## Artifacts

- `exp-a-raw.mjs` — raw Anthropic mechanism test (Exp A).
- `exp-d-shipped-replay.mjs` — shipped `askWithFrozenContext()` against the live
  dario proxy (Exp D). `node dev-docs/cache-experiment/exp-d-shipped-replay.mjs`.
- `exp-e-bridge-endtoend.mjs` — shipped `answerQuestionResult()` frozen path,
  fallback wired to throw (Exp E). Same invocation. Both need `npm run build`
  first and honour `CMQ_MODEL` (default `claude-opus-5`).
- `cmq-exp-extension.ts` — the `pi -e` probe (Exp B/C): hook dump + turn_end
  snapshot/ask/diff + raw replay. Deterministic — needs no model cooperation.
- `~/.pi/cmq-exp/payloads/*.json` — captured primary wire payloads.
- `~/.pi/cmq-exp/RESULTS.json` — last run's structured results.

## Re-run

```bash
cd context-mode/dev-docs/cache-experiment
rm -rf ~/.pi/cmq-exp/payloads ~/.pi/cmq-exp/checkpoints && mkdir -p ~/.pi/cmq-exp/{payloads,checkpoints}
pi -e ./cmq-exp-extension.ts -p "Reply READY" --mode json --no-session --model dario/claude-sonnet-5 2>/tmp/cmq-exp-stderr.log
jq . ~/.pi/cmq-exp/RESULTS.json   # look at c2.cacheRead (~15k) and c2.cacheWrite (0)
```
