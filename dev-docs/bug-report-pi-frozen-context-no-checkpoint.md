# Bug report: Pi frozen-context question path has no checkpoint on live call

Status: **OPEN — live repro 2026-08-06; diagnosis intentionally parked for next session.**

## Symptom

After rebuilding context-mode, restarting Pi, and calling:

```text
ctx_execute({
  language: "shell",
  code: "nvidia-smi",
  question: "What GPUs are installed, and what are their current utilization, memory usage, temperature, and active processes?",
  debug: true
})
```

the command itself exited 0, but question mode reported:

```text
Debug: path=standalone; frozenContext=no-checkpoint
```

The standalone fallback then failed independently with Fireworks HTTP 412:
account `dziewierzjerzy-5e7dcd` suspended (monthly limit/payment). That billing
failure is not the checkpoint bug; it merely prevented fallback semantics.
Full-output source label from the repro:
`execute:shell:question:msg2jicm-f4122ce4`.

Expected: `path=frozen-context`, `frozenContext=replayed`, and provider usage
with `cacheRead > 0` approximately equal to the primary prompt prefix.

## Relevant source

- `src/adapters/pi/extension.ts:466-496`
  - `session_start` calls `clearFrozenContextCheckpoint()`.
  - `before_provider_request` calls
    `captureFrozenContext(event?.payload)`.
- `src/adapters/pi/frozen-context.ts:66-74`
  - capture silently rejects unless `payload.model` is a string AND
    `payload.messages` is a non-empty array.
- `src/adapters/pi/mcp-bridge.ts:402+`
  - `getFrozenContextCheckpoint()` returned null in the live call.
  - replay currently hardcodes Anthropic Messages semantics:
    `{baseUrl}/v1/messages`, `x-api-key`, Anthropic response shape.
- `src/server.ts` + `src/adapters/pi/mcp-bridge.ts`
  - commit `bdbef58` added opt-in `debug` to expose answer path and usage.

## Strongest hypothesis

The live session model is `gpt-5.6-sol` (`PI_MODEL` observed during pickup),
likely routed through OpenAI Responses. That provider payload uses an `input`
array rather than Anthropic's `messages` array. The capture shape guard is
Anthropic-specific, so it would silently reject a valid OpenAI Responses wire
payload and leave `_checkpoint === null` exactly as observed.

Even if capture accepted that payload, `askWithFrozenContext()` is currently
Anthropic-specific and cannot correctly replay an OpenAI Responses request.
This may therefore be a provider-support gap, not a failure of Pi's hook.
Confirm from the real event before changing anything.

## Other hypotheses to rule out

1. `before_provider_request` did not fire in this Pi/provider path.
2. Event shape changed (`event.payload` absent or nested elsewhere).
3. Hook fired before/after an unexpected `session_start` that cleared the slot.
4. Capture and read resolve separate module instances. This seems less likely:
   `extension.ts` and `mcp-bridge.ts` import the same
   `./frozen-context.js` in the same Pi extension build graph, but prove it at
   runtime rather than trusting the source graph.

## Diagnostic plan

1. Add safe debug state to `frozen-context.ts`: capture-attempt count,
   accepted count, last rejection reason (`not-object`, `no-model`,
   `no-messages`, etc.), payload top-level keys, captured model, timestamp.
   Never log payload values, auth headers, or conversation content.
2. Surface that state under `debug:true`; do not rely only on file logs.
3. Re-run one live call and establish whether the hook fired and the exact
   structural mismatch.
4. Inspect current Pi's `before_provider_request` event type/docs and provider
   adapter payload for the active model.
5. Decide scope explicitly:
   - Anthropic-only: report `unsupported-payload/provider` rather than vague
     `no-checkpoint`, and live-test using `dario/claude-*`.
   - Provider-generic: add captured provider/API metadata and separate replay
     adapters for Anthropic Messages, OpenAI Responses, and possibly OpenAI
     Completions. Preserve exact-prefix semantics and provider auth.
6. Once capture succeeds, assert the real result reports
   `path=frozen-context`, `cacheRead > 0`, and `cacheWrite` as expected.

## Existing verification

Before the live repro, the implementation was green in mocks:

- Full build succeeded (`tsc`, six bundles, `assert-bundle`,
  `assert-asymmetric-drift`).
- Full suite: **210 files passed; 4,729 passed, 28 skipped, 0 failed**.
- Unit tests prove Anthropic-shaped capture/replay and synthetic
  `cacheRead=15,150`; they do not prove capture of the active live provider's
  payload shape.
