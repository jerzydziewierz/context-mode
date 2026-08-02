# Bug report: `statusline-sqlite` test flakes on slow-fsync filesystems — fixture seeds 3050 rows without a transaction

Status: **FIXED 2026-08-02** — `tests/statusline-sqlite.test.ts` now wraps the seed inserts
(`seedSessionDb`) in `db.transaction(...)`: 3050 autocommitted rows → one transaction.
Verified: the failing test went from timing out (~69s) to passing (file suite 20s total),
and the full `npx vitest run` is green (210/210 files, 4723 passed, 28 skipped).

Original status: **confirmed, reproduced, root-caused**. Not a product bug — the statusline
itself is fine. Fix not applied (one line in a committed test file, outside the s2 plan scope — Grey's call).

## Symptom

`npm test` / `npx vitest run` fails exactly one test:

```
FAIL tests/statusline-sqlite.test.ts > statusline.mjs — SessionDB-backed reads
     > resolves per-session KPI from the stdin payload session_id (no env var)
Error: Test timed out in 30000ms.
```

Observed twice on this machine (51s and 69s against a 30s budget). The sibling test in the same
file — "renders lifetime $ from SessionDB session_events bytes" — passes, because it seeds only
1000 rows, not 3050.

## Root cause — it is the fixture, not the statusline

`tests/statusline-sqlite.test.ts:233-259` seeds 50 + 3000 = 3050 `session_events` rows through
`seedSessionDb()` (line ~131), which calls `insert.run(...)` once per row in a bare `for` loop.
better-sqlite3 autocommits each statement, so that is **3050 separate transactions = 3050 fsyncs**.

Measured on this box (ZFS-backed home, `/tmp` on the same pool):

| what | time |
|---|---|
| seeding loop as written (3050 autocommitted inserts) | **49.3 s** |
| identical loop wrapped in `db.transaction(...)` | **0.14 s** |
| the statusline subprocess itself, against the seeded fixture | **0.048 s** |

So ~100% of the 30s budget is consumed before `runStatusline()` is even called.

The statusline renders the fixture correctly and would satisfy every assertion:

```
context-mode  ●  53.1 KB this chat  ·  292 KB lifetime  ·  100% kept out
```

`53.1 KB … this chat` matches `/\d+(\.\d+)?\s*KB\s+this chat/`, does not match `/\bMB\s+this chat/`,
and contains no `NaN`. The test's magnitude-based mutation-defeat design is intact — it is only the
setup that is slow.

## Why the existing timeout comment does not cover this

The file already anticipates a slow platform (lines 51-53):

```ts
const STATUSLINE_SQLITE_TIMEOUT_MS =
  process.platform === "win32" ? 300_000 : 30_000;
```

with the rationale "Mac/Linux finish in <2s — keep the budget tight off-Windows so real regressions
still trip the test." That reasoning is sound and worth preserving — the assumption it rests on
(fast fsync) just does not hold on every Linux filesystem. Raising the non-Windows budget would
weaken a deliberately tight regression guard to paper over a fixture inefficiency.

## Suggested fix

Wrap the insert loop in `seedSessionDb()` in a transaction. ~350× faster, changes nothing
semantically (same rows, same ids, same order, same aggregate), keeps the 30s budget honest, and
speeds the whole file up on every platform including the Windows runner the 300s branch exists for:

```ts
const insertAll = db.transaction((events: typeof opts.events) => {
  for (const ev of events) {
    const sid = ev.sessionId ?? "default-session";
    insert.run(sid, ev.type ?? "tool_use", /* … */);
    seenSessions.add(sid);
  }
});
insertAll(opts.events);
```

The same pattern applies to `seedRealAdapter()` (line ~330, 200 rows × 2 adapters) in the
multi-adapter describe block — smaller, but the same shape.

## Not verified

- Whether CI runners hit this. They are likely on ext4/overlayfs where fsync is cheap, which would
  explain why this has never tripped in CI despite being in the tree.
