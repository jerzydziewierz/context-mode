/**
 * Frozen-context checkpoint for `question`-mode prompt-cache reuse.
 *
 * Anthropic prompt caching is prefix-BYTE matching (no session ids, no
 * handles). The only way a nested question call can reuse the primary
 * loop's cache is to re-send the exact bytes the primary loop sent, plus
 * an appended question block. Reconstruction from session entries is
 * brittle by design; capturing the real wire payload is exact by
 * construction. Proven 2026-08-02: cacheRead≈15.1k / cacheWrite=0, 5/5
 * runs through the dario/CCR proxy — see
 * dev-docs/cache-experiment/MANUAL.md and README.md in that dir.
 *
 * Capture side: the Pi extension registers `before_provider_request`
 * (extension.ts) and calls `captureFrozenContext(event.payload)` for
 * every primary request. One rotating slot — the latest payload IS the
 * "current frozen context" (a tool's question always fires mid-turn,
 * i.e. after the request that carried its tool call).
 *
 * Ask side: `askWithFrozenContext()` clones the checkpoint, drops
 * `stream`, appends one user block (instructions + output + question,
 * with its own ephemeral cache_control breakpoint), and POSTs to
 * `{model.baseUrl}/v1/messages` with the provider key. Raw fetch, not
 * `streamSimple`: the adapter would re-serialize from parts and any
 * byte drift silently voids the cache read. `usage.cacheRead > 0` on
 * the response is the proof the prefix was reused.
 *
 * This module is shared state between extension.ts (capture) and
 * mcp-bridge.ts (ask). Both run in the Pi process from the same build
 * output, so a module-level slot needs no disk and no IPC.
 */

// Anthropic allows at most 4 cache_control breakpoints per request. The
// primary payload already carries up to 3 (system / last tool / last
// user); our appended block takes the 4th. If the primary somehow holds
// 4 already, we append WITHOUT a breakpoint — the shared prefix still
// reads; only the question tail itself goes uncached (fine for one-off).
const MAX_CACHE_BREAKPOINTS = 4;

/** Wire payload shape we rely on. Everything else passes through untouched. */
interface FrozenPayload {
  model?: unknown;
  system?: unknown;
  tools?: unknown;
  messages?: unknown[];
  stream?: unknown;
  max_tokens?: unknown;
  [key: string]: unknown;
}

export interface FrozenContextCheckpoint {
  /** The exact wire payload Pi sent (NOT a clone — never mutate). */
  payload: FrozenPayload;
  /** Wire model id from the payload, for cheap mismatch guards. */
  wireModelId: string;
  /** Capture timestamp — informational (cache TTL is provider-side). */
  capturedAt: number;
}

let _checkpoint: FrozenContextCheckpoint | null = null;

/**
 * Rotating capture. Called from the extension's `before_provider_request`
 * handler for every primary request. Shape-guarded so summary/compaction
 * or malformed payloads never poison the slot. Never throws.
 */
export function captureFrozenContext(payload: unknown): void {
  try {
    if (!payload || typeof payload !== "object") return;
    const p = payload as FrozenPayload;
    if (typeof p.model !== "string" || !Array.isArray(p.messages) || p.messages.length === 0) return;
    _checkpoint = { payload: p, wireModelId: p.model, capturedAt: Date.now() };
  } catch {
    // capture is best-effort telemetry-grade; never break the request path
  }
}

export function getFrozenContextCheckpoint(): FrozenContextCheckpoint | null {
  return _checkpoint;
}

/** Session boundary hygiene — a new session must never see the old prefix. */
export function clearFrozenContextCheckpoint(): void {
  _checkpoint = null;
}

function countCacheBreakpoints(payload: FrozenPayload): number {
  let count = 0;
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
    } else if (value && typeof value === "object") {
      if ((value as Record<string, unknown>).cache_control) count++;
      for (const key of ["content", "system", "tools", "messages"]) {
        const nested = (value as Record<string, unknown>)[key];
        if (nested) scan(nested);
      }
    }
  };
  scan(payload.system);
  scan(payload.tools);
  scan(payload.messages);
  return count;
}

export interface AskWithFrozenContextOptions {
  checkpoint: FrozenContextCheckpoint;
  /** Full text of the appended user block (instructions + output + question). */
  questionBlockText: string;
  /** Provider base URL from the Pi model (e.g. http://localhost:3456). */
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AskWithFrozenContextResult {
  text: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  stopReason: string | undefined;
}

/**
 * Replay the frozen checkpoint + one appended question block against the
 * SAME endpoint/key the primary loop uses. Byte-exact prefix by
 * construction ⇒ the provider bills the shared prefix as a cache READ
 * (~0.1×) and only the question tail at full price.
 *
 * Throws on transport/HTTP errors — the caller (answerQuestionResult)
 * treats any throw as "fall back to the shortlist path".
 */
export async function askWithFrozenContext(
  options: AskWithFrozenContextOptions,
): Promise<AskWithFrozenContextResult> {
  const { checkpoint, questionBlockText, baseUrl, apiKey, headers, maxTokens, signal, fetchImpl } = options;

  // Shallow-clone the payload and copy the messages array; the captured
  // payload object belongs to Pi and MUST NOT be mutated.
  const body: FrozenPayload = { ...checkpoint.payload };
  delete body.stream;
  body.max_tokens = maxTokens ?? 1_200;
  const questionBlock: Record<string, unknown> = { type: "text", text: questionBlockText };
  if (countCacheBreakpoints(checkpoint.payload) < MAX_CACHE_BREAKPOINTS) {
    questionBlock.cache_control = { type: "ephemeral" };
  }
  body.messages = [
    ...(checkpoint.payload.messages ?? []),
    { role: "user", content: [questionBlock] },
  ];

  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(
      `Frozen-context replay failed: HTTP ${res.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const text = (json.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  const input = json.usage?.input_tokens ?? 0;
  const output = json.usage?.output_tokens ?? 0;
  const cacheRead = json.usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = json.usage?.cache_creation_input_tokens ?? 0;
  return {
    text,
    usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite },
    stopReason: json.stop_reason,
  };
}
