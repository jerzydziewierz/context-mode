# Bug report: two `tool_result` handlers registered in the Pi extension, error flag round-trips through `details`

Status: **suspicious, unverified**. Found by reading the uncommitted diff. Tests pass, so this may be
fine — but the mechanism is fragile enough to write down.

## Where

- `context-mode/src/adapters/pi/extension.ts:533` — new handler, returns `{ isError: true }` when
  `event.details.contextModeQuestionIsError === true`.
- `context-mode/src/adapters/pi/extension.ts:541` — the pre-existing PostToolUse capture handler.
- `context-mode/src/adapters/pi/mcp-bridge.ts:1343` — sets
  `details: { contextModeQuestionIsError: questionAnswer.originalIsError }`.

## Why it exists

In non-question mode the bridge signals failure by `throw`ing (mcp-bridge.ts:1352-1356 — throw is pi's
tool-failed contract). Question mode cannot throw, because a failed command **still needs its compact
answer delivered** to the primary agent. So the bridge returns a normal result and smuggles the real
error state through `details`, and the extension re-raises it as `isError` afterwards.

## What is questionable

1. **Handler ordering is load-order dependent.** `docs/extensions.md` ("tool_result") says handlers
   chain like middleware in extension load order, each seeing the previous handler's changes. Both
   handlers are in the *same* extension, registered 533 then 541, so ours runs first — that is the
   intent ("restore the MCP error flag before telemetry handlers inspect the result"). But this is
   implicit; nothing asserts it. A future edit that reorders these two `pi.on` calls silently changes
   behavior with no test failure.

2. **`details` is overwritten wholesale.** mcp-bridge.ts:1343 replaces `details` with a single-key
   object. The non-question path returns `details: {}`. If anything downstream ever expects other keys
   in `details` for ctx_* tools, question mode drops them.

3. **The flag leaks into the session record.** `details` is persisted on the `toolResult` message
   (`docs/session-format.md`). `contextModeQuestionIsError` is now part of the on-disk session format
   for anyone parsing it. Not harmful, but it is an accidental public surface.

4. **Untested interaction:** what happens if `isError: true` is set but the content is our compact
   answer? Does pi's TUI render the answer, or does it render it as a tool failure and hide it? Not
   verified in this session. There is no test covering "question mode + nonzero exit + Pi adapter
   present" end to end — `tests/adapters/pi-mcp-bridge.test.ts:208` covers the *nested model failure*
   fallback, not the *command failure* path through the extension handler.

## Suggested action

- Merge the two handlers into one, so ordering is structural rather than incidental; or add a test that
  asserts the error-flag handler is registered before the capture handler.
- Namespace the key (`"context-mode/questionIsError"`) to match the `_meta` key convention already used
  at server.ts:2008 (`"context-mode/question"`).
- Add the missing end-to-end test: question mode + `exit 7` + a stub Pi ctx → assert the primary agent
  sees both `Status: failed (exit 7)` **and** `isError`.
