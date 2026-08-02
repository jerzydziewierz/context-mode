# Fork-questions with cache reuse — user/programmer manual

**Goal:** from a *current* context, ask one or many questions as if forked — the
questions see the full frozen context, and **every question reuses the primary
loop's prompt cache** (no re-send of the full context at full price).

**Proven by:** `README.md` in this dir (2026-08-02, cacheRead≈15.1k / cacheWrite=0,
5/5 runs, through pi's dario/CCR proxy).

---

## The one truth that makes it work

Anthropic prompt caching is **prefix-byte matching**. A request is billed as a
cache *read* for every byte shared with a previously-sent request, up to the
last matching `cache_control` breakpoint. So:

> **A checkpoint = the exact provider payload pi sent. A question call = those
> exact bytes + one appended question block.**

If the replay bytes are identical to what pi sent, the whole prefix is a read
(0.1× price). Only the question tail is new/full price. `sessionId` is
irrelevant — the cache key is the bytes, not the session.

---

## Method (3 steps)

### 1. Capture — checkpoint the current context

Hook **`before_provider_request`** and dump `event.payload` (the exact wire
payload: `{model, system, tools, messages, max_tokens, ...}`) to storage.
`pi.on("before_provider_request", (ev) => dump(ev.payload))`. The most recent
dump IS the "current context" checkpoint. Byte-exact by construction — no
reconstruction, no drift, immune to adapters/other-extensions mutating shapes.

### 2. Ask — replay checkpoint + appended question

Clone the checkpoint. Drop `stream`. Append:

```json
{ "role": "user", "content": [{ "type": "text", "text": "<question>",
  "cache_control": { "type": "ephemeral" } }] }
```

POST to `{provider.baseUrl}/v1/messages` with the provider's api key
(`x-api-key`) + `anthropic-version: 2023-06-01`. Send `stream:false` (stream
flag does not affect the cache key — proven).

### 3. Verify (assert before shipping)

`usage.cache_read_input_tokens ≈ prefix size` and
`usage.cache_creation_input_tokens ≈ 0`. If read≈0 → bytes differ (provider
serialization changed, or model/account/endpoint drifted) — the checkpoint must
be re-captured.

---

## Rules (violating any = cache miss)

1. **Same model id, same endpoint, same upstream account** as the primary loop
   (pi's provider path guarantees this; raw fetch must reuse the same
   baseUrl/key).
2. **Append only at the end.** The question block is the ONLY difference from
   the captured prefix. Never reorder/edit the captured system/tools/messages.
3. **Correct breakpoints.** pi's adapters already place `cache_control` on
   system / last tool / last user block; the question block carries its own
   `cache_control` (Anthropic limit: ≤4 breakpoints).
4. **Prefix must be ≥1024 tokens** to be cacheable (pi's real context always
   is).
5. **Be quick or re-capture:** 5-min TTL ("short"). A read refreshes the TTL;
   after idle expiry the first ask pays one write, subsequent asks read again.

---

## Economics (why warm-cache wins for N questions)

N questions against one frozen checkpoint ≈ **1 write (or 0) + N reads**.
Each read ≈ 0.1× prefix + 1× question tail. A "small prompt" alternative pays
full price N times AND loses context fidelity. For N≥2 the checkpoint method
wins on every axis → **Q-s2-1 resolved: warm cache.**

---

## Known footguns

- **Direct `provider.streamSimple()` from an extension hook fails auth**:
  `"No API key for provider: dario"` — models.json `apiKey` overrides aren't
  wired into direct provider calls. Fixes: pass `apiKey` explicitly in
  `StreamOptions`, or read it from the models.json provider config. (C1 finding,
  commit `19e51d0`.)
- **Storage:** each checkpoint ≈ full context (~0.4–1 MB per 100k tokens).
  Plan eviction (keep N most recent, or drop after use).
- **Fireworks/Nebius paths** (`openai-completions.js`) — whether they honor
  `cache_control` is **unverified** (shortlist models route there). Test before
  relying on cache for those models.
- **pi upgrades** can change adapter serialization → stale checkpoints miss.
  Re-capture per session; assert the read (step 3).

---

## Reference implementation (copy from)

`cmq-exp-extension.ts` in this dir — `before_provider_request` dump + turn_end
raw replay (C2): the exact working pattern, ~40 lines of relevant code.

## Next (per Grey): apply to context-mode `question` parameter

The `question` param (mcp-bridge.ts nested call, currently `cacheRetention:
"none"` + separate/short context at ~:359-381) should instead: capture the
primary payload at the boundary, and send **full frozen context + question** via
the C2 raw-replay pattern (or C1 pi-ai path with the auth fix), `cacheRetention:
"short"` — so the question sees the full context AND reads the primary cache.
