/**
 * MCP-stdio bridge for the Pi Coding Agent extension.
 *
 * Pi 0.73.x has no native MCP support — its README is explicit:
 *   > "No MCP. Build CLI tools with READMEs (see Skills), or build an
 *   >  extension that adds MCP support."
 *
 * Without this bridge, the routing block tells the LLM to call
 * `ctx_execute`, `ctx_search`, etc. — but those tools never enter Pi's
 * tool list, so the LLM cannot reach them. context-mode then becomes a
 * pure cost on Pi (~2.5K tokens of system-prompt overhead with 0
 * actual ctx_* calls). Reported in mksglu/context-mode#426.
 *
 * The bridge spawns `server.bundle.mjs` as a long-lived child via stdio
 * JSON-RPC, performs the MCP handshake, calls `tools/list` once, and
 * registers each returned tool through `pi.registerTool({ … })`. Each
 * tool's `execute()` forwards into the child via `tools/call` — same
 * code path Claude Code, Gemini CLI, and the other adapters use, so
 * Pi behavior matches the rest of the platform suite.
 *
 * No external dependencies — pure node:child_process + JSON line frames.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { detectRuntimes } from "../../runtime.js";
import { foreignWorkspaceEnv, foreignIdentificationEnv } from "../detect.js";
import {
  askWithFrozenContext,
  getFrozenContextCaptureDiagnostics,
  getFrozenContextCheckpoint,
} from "./frozen-context.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// ── Fork-bomb prevention (#516) ──────────────────────────────────────
//
// Original bug: `spawn(process.execPath, [serverScript])` recursively
// re-executed the Pi binary on Bun-only systems where `process.execPath`
// IS pi itself. Each spawn re-loaded context-mode → spawned again →
// took the box down.
//
// Defence in depth:
//   1. resolveJsRuntimeForBridge() refuses pi-named binaries even when
//      detectRuntimes() returns one, falling back to PATH-resolved
//      node/bun.
//   2. Spawn passes CONTEXT_MODE_BRIDGE_DEPTH=1 in child env so any
//      transitive bridge load can detect the recursion via env counter.
//   3. bootstrapMCPTools() aborts if CONTEXT_MODE_BRIDGE_DEPTH > 0 in
//      its own env — catches recursion that bypasses the binary-name
//      check (e.g. a `node` shim that re-execs Pi).

const PI_BINARY_BASENAME = /^pi(\.exe)?$/i;
const BRIDGE_DEPTH_ENV = "CONTEXT_MODE_BRIDGE_DEPTH";
const isWindows = process.platform === "win32";

function basename(p: string): string {
  const segs = p.split(/[\\/]/);
  return segs[segs.length - 1] ?? "";
}

function whichOnPath(cmd: string): string | null {
  try {
    const probe = isWindows ? `where ${cmd}` : `command -v ${cmd}`;
    const out = execSync(probe, { encoding: "utf-8", stdio: "pipe" })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface ResolveDeps {
  detect?: () => { javascript: string | null };
  which?: (cmd: string) => string | null;
  execPath?: string;
}

/**
 * Resolve a JS runtime safe to spawn the MCP server with.
 *
 * Returns `null` when no real runtime is reachable (caller must skip
 * the bridge gracefully — see bootstrapMCPTools). Pi-named binaries are
 * explicitly rejected at every step to prevent the #516 fork bomb.
 */
export function resolveJsRuntimeForBridge(deps: ResolveDeps = {}): string | null {
  const detect = deps.detect ?? (() => detectRuntimes());
  const which = deps.which ?? whichOnPath;
  const execPath = deps.execPath ?? process.execPath;

  const isPi = (p: string | null | undefined): boolean =>
    !!p && PI_BINARY_BASENAME.test(basename(p));

  // 1. Prefer detectRuntimes().javascript when it is NOT pi.
  let candidate: string | null = null;
  try {
    candidate = detect().javascript ?? null;
  } catch {
    candidate = null;
  }
  if (candidate && !isPi(candidate)) return candidate;

  // 2. Fall back to PATH-resolved node, then bun.
  for (const cmd of ["node", "bun"]) {
    const resolved = which(cmd);
    if (resolved && !isPi(resolved)) return resolved;
  }

  // 3. Last resort: process.execPath only if it is not pi.
  if (execPath && !isPi(execPath)) return execPath;

  return null;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

const QUESTION_META_KEY = "context-mode/question";
/**
 * `details` key carrying the real MCP error state of a question-mode result.
 *
 * Question mode cannot signal failure by throwing (the throw contract used by
 * the non-question path below) because a failed command STILL needs its
 * compact answer delivered to the primary agent. So the bridge returns a
 * normal result and smuggles the error state through `details`; the extension's
 * `tool_result` handler re-raises it as `isError`. Namespaced to match the
 * `_meta` convention (`QUESTION_META_KEY`) because `details` is persisted on
 * the `toolResult` message and is therefore an on-disk public surface.
 */
export const QUESTION_IS_ERROR_DETAILS_KEY = "context-mode/questionIsError";
const QUESTION_MODEL_SHORTLIST_PATH = join(homedir(), ".pi", "model-shortlist.env");

interface QuestionMeta {
  version: number;
  question: string;
  answerInput: string;
  evidence: string;
  rawOutputBytes: number;
  outputReduced: boolean;
  source: string;
  status: string;
  exitCode: number;
  timedOut: boolean;
  backgrounded: boolean;
  isError: boolean;
}

interface PiQuestionContext {
  model?: any;
  scopedModels?: ReadonlyArray<{ model: any; thinkingLevel?: string }>;
  thinkingLevel?: string;
  signal?: AbortSignal;
  sessionManager?: { getSessionId?: () => string };
  modelRegistry?: {
    getAvailable?: () => any[];
    getApiKeyAndHeaders?: (model: any) => Promise<{
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      error?: string;
    }>;
    getProvider?: (provider: string) => {
      streamSimple: (model: any, context: unknown, options?: Record<string, unknown>) => {
        result: () => Promise<any>;
      };
    } | undefined;
  };
}

function getQuestionMeta(result: MCPCallResult): QuestionMeta | null {
  const value = result._meta?.[QUESTION_META_KEY];
  if (!value || typeof value !== "object") return null;
  const meta = value as Partial<QuestionMeta>;
  if (
    meta.version !== 1
    || typeof meta.question !== "string"
    || typeof meta.answerInput !== "string"
    || typeof meta.evidence !== "string"
    || typeof meta.rawOutputBytes !== "number"
    || typeof meta.outputReduced !== "boolean"
    || typeof meta.source !== "string"
    || typeof meta.status !== "string"
  ) return null;
  return meta as QuestionMeta;
}

function modelRef(model: any): string {
  return `${String(model?.provider ?? "")}/${String(model?.id ?? "")}`;
}

function questionDebugLine(
  enabled: boolean,
  path: "frozen-context" | "standalone" | "unavailable",
  model: any,
  usage?: unknown,
  frozenContext?: string,
  primaryModel?: any,
): string[] {
  if (!enabled) return [];
  const fields = [`path=${path}`];
  const ref = modelRef(model);
  if (ref !== "/") fields.push(`model=${ref}`);
  if (frozenContext) fields.push(`frozenContext=${frozenContext}`);
  if (usage && typeof usage === "object") {
    const values = usage as Record<string, unknown>;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
      if (typeof values[key] === "number") fields.push(`${key}=${values[key]}`);
    }
  }
  const capture = getFrozenContextCaptureDiagnostics();
  const activeRef = modelRef(primaryModel);
  if (activeRef !== "/") fields.push(`activeModel=${activeRef}`);
  fields.push(
    `captureAttempts=${capture.attempts}`,
    `captureAccepted=${capture.accepted}`,
    `captureOutcome=${capture.lastOutcome}`,
  );
  if (capture.lastPayloadKeys.length > 0) fields.push(`payloadKeys=${capture.lastPayloadKeys.join(",")}`);
  if (capture.lastWireModelId) fields.push(`payloadModel=${capture.lastWireModelId}`);
  if (capture.lastAttemptAt) fields.push(`captureAttemptAt=${capture.lastAttemptAt}`);
  if (capture.lastAcceptedAt) fields.push(`captureAcceptedAt=${capture.lastAcceptedAt}`);
  if (capture.lastClearedAt) fields.push(`captureClearedAt=${capture.lastClearedAt}`);
  return [`Debug: ${fields.join("; ")}`];
}

export function readQuestionModelShortlist(
  path: string = QUESTION_MODEL_SHORTLIST_PATH,
): string[] {
  if (!existsSync(path)) return [];
  const refs: string[] = [];
  try {
    for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
      const ref = (match?.[1] ?? line).trim();
      if (ref && !refs.includes(ref)) refs.push(ref);
    }
  } catch {
    return [];
  }
  return refs;
}

function findShortlistModel(ref: string, models: any[]): any | undefined {
  const normalized = ref.trim().toLowerCase();
  const canonical = models.filter((model) => modelRef(model).toLowerCase() === normalized);
  if (canonical.length === 1) return canonical[0];
  const byId = models.filter((model) => String(model?.id ?? "").toLowerCase() === normalized);
  return byId.length === 1 ? byId[0] : undefined;
}

export function selectQuestionModel(
  ctx: PiQuestionContext,
  shortlistRefs: readonly string[] = readQuestionModelShortlist(),
): { model: any; thinkingLevel?: string } {
  const scoped = Array.isArray(ctx.scopedModels) ? [...ctx.scopedModels] : [];
  if (shortlistRefs.length > 0) {
    const available = ctx.modelRegistry?.getAvailable?.() ?? scoped.map((entry) => entry.model);
    for (const ref of shortlistRefs) {
      const model = findShortlistModel(ref, available);
      if (!model) continue;
      const scopedMatch = scoped.find((entry) => modelRef(entry.model) === modelRef(model));
      return { model, thinkingLevel: scopedMatch?.thinkingLevel };
    }
    throw new Error(`No available question model is listed in ${QUESTION_MODEL_SHORTLIST_PATH}`);
  }

  if (ctx.model) return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
  if (scoped.length > 0) return scoped[0];
  throw new Error("No Pi model is available for question answering");
}

function compactEvidence(rawOutput: string, preferred: string): string {
  const candidates = preferred
    .split(/\n{2,}|\n---\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (rawOutput.includes(candidate)) return candidate.slice(0, 800);
  }
  return rawOutput.trim().slice(0, 800) || "(no output)";
}

function buildQuestionInput(meta: QuestionMeta, model: any): string {
  const advertisedWindow = Number(model?.contextWindow);
  const contextWindow = Number.isFinite(advertisedWindow) && advertisedWindow > 0
    ? advertisedWindow
    : 32_000;
  // One UTF-16 code unit per token is a conservative fallback for source,
  // Unicode logs, and JSON. Reserve room for instructions and the answer.
  const maxChars = Math.max(1_000, Math.min(250_000, contextWindow - 4_000));
  let executionResult = meta.answerInput;
  let truncated = meta.outputReduced;
  if (executionResult.length > maxChars) {
    truncated = true;
    const head = meta.answerInput.slice(0, 1_000);
    const tail = meta.answerInput.slice(-1_500);
    const evidenceBudget = Math.max(1_000, maxChars - head.length - tail.length - 500);
    executionResult = [
      "Start of raw output:",
      head,
      "Question-matched evidence:",
      meta.evidence.slice(0, evidenceBudget),
      "End of raw output:",
      tail,
    ].join("\n\n");
  }
  return JSON.stringify({
    question: meta.question,
    authoritativeStatus: meta.status,
    outputWasReduced: truncated,
    executionResult,
  });
}

/**
 * Appended user block for the frozen-context replay path. Unlike
 * buildQuestionInput (a standalone prompt for a context-blind model),
 * this block RIDES ON the full frozen session context, so the
 * instructions scope the model to interpreting the new output only —
 * Grey's intent: the session explains WHY the command ran; the model
 * summarizes/interprets the output in that light, and only the compact
 * conclusion returns to the primary agent.
 */
function buildFrozenQuestionInput(meta: QuestionMeta, model: any): string {
  return [
    "[context-mode question side-channel — not part of the conversation]",
    "The conversation above is the live session context, frozen at the moment",
    "a tool call executed. Below is that tool call's raw result, which the",
    "primary agent has NOT seen. Using the session context to understand why",
    "the command was run, interpret and summarize ONLY this execution result.",
    "Do not continue the conversation. Do not call tools.",
    "Return a single JSON object with string fields \"answer\" and \"evidence\".",
    "Keep the answer compact. Copy a short exact evidence excerpt from the",
    "execution result. Use the authoritative status exactly as supplied.",
    "",
    buildQuestionInput(meta, model),
  ].join("\n");
}

function responseText(response: any): string {
  if (!Array.isArray(response?.content)) return "";
  return response.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

function parseQuestionAnswer(text: string, meta: QuestionMeta): { answer: string; evidence: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { answer?: unknown; evidence?: unknown };
      if (typeof parsed.answer === "string" && parsed.answer.trim()) {
        const proposed = Array.isArray(parsed.evidence)
          ? parsed.evidence.filter((v): v is string => typeof v === "string").join("\n")
          : typeof parsed.evidence === "string" ? parsed.evidence : "";
        return {
          answer: parsed.answer.trim(),
          evidence: compactEvidence(meta.answerInput, proposed || meta.evidence),
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function answerQuestionResult(
  result: MCPCallResult,
  ctx: PiQuestionContext | undefined,
  shortlistRefs?: readonly string[],
  debug = false,
): Promise<{ text: string; usage?: unknown; originalIsError: boolean } | null> {
  const meta = getQuestionMeta(result);
  if (!meta) return null;
  if (!ctx?.modelRegistry?.getApiKeyAndHeaders || !ctx.modelRegistry.getProvider) {
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    return {
      text: [
        text,
        ...questionDebugLine(debug, "unavailable", ctx?.model, undefined, "pi-adapter-unavailable", ctx?.model),
      ].filter(Boolean).join("\n"),
      originalIsError: meta.isError,
    };
  }

  // ── Frozen-context path (preferred) ────────────────────────────────
  //
  // When the extension has captured the primary loop's wire payload
  // (before_provider_request → captureFrozenContext), replay it with the
  // question appended. The question model MUST be the primary model:
  // Anthropic's prompt cache is keyed per model+endpoint+account, so only
  // the model that sent the prefix can read it (~0.1× billed as
  // cacheRead). The budget shortlist below stays as the fallback for
  // fresh sessions, non-capturing hosts, and replay failures — a cache
  // MISS on this path is a cost issue, never a correctness issue.
  const checkpoint = getFrozenContextCheckpoint();
  const primaryModel = ctx.model;
  let frozenContextDebug = !checkpoint
    ? "no-checkpoint"
    : !primaryModel
      ? "no-primary-model"
      : typeof (primaryModel as any).baseUrl !== "string"
        ? "no-base-url"
        : checkpoint.wireModelId !== String((primaryModel as any).id ?? "")
          ? "model-mismatch"
          : "eligible";
  if (
    checkpoint
    && primaryModel
    && typeof (primaryModel as any).baseUrl === "string"
    && checkpoint.wireModelId === String((primaryModel as any).id ?? "")
  ) {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(primaryModel);
      if (auth.ok && auth.apiKey) {
        const replay = await askWithFrozenContext({
          checkpoint,
          questionBlockText: buildFrozenQuestionInput(meta, primaryModel),
          baseUrl: (primaryModel as any).baseUrl,
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 1_200,
          signal: ctx.signal,
        });
        if (replay.stopReason === "error") throw new Error("Frozen-context replay returned error stop");
        const answered = parseQuestionAnswer(replay.text, meta);
        if (answered) {
          return {
            text: [
              `Status: ${meta.status}`,
              `Answer: ${answered.answer}`,
              `Evidence: ${answered.evidence}`,
              `Full output: ${meta.source}`,
              `Retrieve: ctx_search(queries: [${JSON.stringify(meta.question)}], source: ${JSON.stringify(meta.source)})`,
              ...questionDebugLine(debug, "frozen-context", primaryModel, replay.usage, "replayed", primaryModel),
            ].join("\n"),
            usage: replay.usage,
            originalIsError: meta.isError,
          };
        }
        // Parse failure with a healthy transport: don't burn a second
        // full-price shortlist call — return the evidence envelope with
        // the replay usage attached.
        return {
          text: [
            `Status: ${meta.status}`,
            "Answer: Semantic answer unavailable: the answer model returned invalid structured data.",
            `Evidence: ${compactEvidence(meta.answerInput, meta.evidence)}`,
            `Full output: ${meta.source}`,
            `Retrieve: ctx_search(queries: [${JSON.stringify(meta.question)}], source: ${JSON.stringify(meta.source)})`,
            ...questionDebugLine(debug, "frozen-context", primaryModel, replay.usage, "replayed-invalid-answer", primaryModel),
          ].join("\n"),
          usage: replay.usage,
          originalIsError: meta.isError,
        };
      }
      frozenContextDebug = "auth-unavailable";
    } catch {
      // Replay path failed (endpoint drift, auth, aborted, proxy down).
      // Fall through to the shortlist path — same behavior as before
      // this feature existed.
      frozenContextDebug = "replay-failed";
    }
  }

  try {
    const selected = selectQuestionModel(ctx, shortlistRefs ?? readQuestionModelShortlist());
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selected.model);
    if (!auth.ok) throw new Error(auth.error || "Question model authentication failed");
    const provider = ctx.modelRegistry.getProvider(String(selected.model.provider));
    if (!provider) throw new Error(`Question model provider not found: ${selected.model.provider}`);
    const stream = provider.streamSimple(
      selected.model,
      {
        systemPrompt: [
          "Answer one question about a command result.",
          "Use the authoritative status exactly as supplied.",
          "Use only the execution result as evidence.",
          "Return JSON with string fields answer and evidence.",
          "Keep the answer compact.",
          "Copy a short exact evidence excerpt from the execution result.",
        ].join("\n"),
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildQuestionInput(meta, selected.model) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: ctx.signal,
        reasoning: selected.thinkingLevel ?? "low",
        maxTokens: 1_200,
        transport: "sse",
        // Standalone request — never reuse, never write cache. The nested
        // prompt (a one-off system prompt + a single synthetic user message)
        // shares no leading bytes with the primary agent loop's prompt, and
        // Anthropic/OpenAI prompt caching is prefix-byte matching. Any
        // retention other than "none" therefore pays the cache-WRITE premium
        // for reads that can never happen. Fresh sessionId for the same
        // reason — a stable id would only pin routing affinity to a prompt
        // nobody will send again. This mirrors pi core's own convention for
        // one-off calls (compaction.js:444, examples/extensions/summarize.ts).
        // Do not "optimize" this back to "short".
        cacheRetention: "none",
        sessionId: randomUUID(),
      },
    );
    const response = await stream.result();
    if (response?.stopReason === "error" || response?.stopReason === "aborted") {
      throw new Error(response?.errorMessage || `Question model stopped: ${response?.stopReason}`);
    }
    const answered = parseQuestionAnswer(responseText(response), meta);
    if (!answered) {
      return {
        text: [
          `Status: ${meta.status}`,
          "Answer: Semantic answer unavailable: the answer model returned invalid structured data.",
          `Evidence: ${compactEvidence(meta.answerInput, meta.evidence)}`,
          `Full output: ${meta.source}`,
          `Retrieve: ctx_search(queries: [${JSON.stringify(meta.question)}], source: ${JSON.stringify(meta.source)})`,
          ...questionDebugLine(debug, "standalone", selected.model, response?.usage, frozenContextDebug, primaryModel),
        ].join("\n"),
        usage: response?.usage,
        originalIsError: meta.isError,
      };
    }
    return {
      text: [
        `Status: ${meta.status}`,
        `Answer: ${answered.answer}`,
        `Evidence: ${answered.evidence}`,
        `Full output: ${meta.source}`,
        `Retrieve: ctx_search(queries: [${JSON.stringify(meta.question)}], source: ${JSON.stringify(meta.source)})`,
        ...questionDebugLine(debug, "standalone", selected.model, response?.usage, frozenContextDebug, primaryModel),
      ].join("\n"),
      usage: response?.usage,
      originalIsError: meta.isError,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: [
        `Status: ${meta.status}`,
        `Answer: Semantic answer unavailable: ${message}`,
        `Evidence: ${compactEvidence(meta.answerInput, meta.evidence)}`,
        `Full output: ${meta.source}`,
        `Retrieve: ctx_search(queries: [${JSON.stringify(meta.question)}], source: ${JSON.stringify(meta.source)})`,
        ...questionDebugLine(debug, "standalone", undefined, undefined, frozenContextDebug, primaryModel),
      ].join("\n"),
      originalIsError: meta.isError,
    };
  }
}

// Bridge-imposed timeout for protocol-handshake methods (initialize,
// tools/list). These MUST be bounded: a server that never replies to
// initialize would otherwise block Pi's bridge bootstrap indefinitely.
// `tools/call` deliberately has NO bridge ceiling (#643) — long-running
// ctx_execute (test suites, builds, cargo test) was rejected by a 120s
// hardcoded bound even though the executor child would have finished.
// Responsibility for bounding a tool call belongs to the executor
// layer (per-tool timeout / background mode / Pi-level cancel), not
// to the transport.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// Retry budget for the bridge bootstrap `initialize` handshake (#647).
//
// On cold NFS home dirs, first JIT compile of server.bundle.mjs, or
// constrained CI runners, the first `initialize` can exceed the 60s
// ceiling above. Before this fix, bootstrapMCPTools propagated the
// rejection up to extension.ts, which logged once and continued with
// NO ctx_* tools registered — silently degrading the session for its
// entire lifetime while the routing block kept emitting ~2.5K tokens
// of dead instructions per turn.
//
// Retry pattern mirrors the existing #583 single-flight respawn shape:
// on failure, shut the prior child cleanly, sleep a short backoff so
// the OS reclaims fds, then start + initialize again. After the budget
// is exhausted we re-throw and the existing extension.ts handler runs
// the degrade-and-log path — preserving the contract for genuinely
// broken servers (binary missing, runtime crash, etc.) while
// self-healing the transient warm-up case.
const MAX_INIT_RETRIES = 2;
const INIT_RETRY_DELAY_MS = 1_000;

export class PiTextComponent {
  private text: string;

  constructor(text = "") {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {
    // Stateless renderer: no cached layout to invalidate.
  }

  render(width: number): string[] {
    if (!this.text || this.text.trim() === "") return [];
    return this.text
      .replace(/\t/g, "   ")
      .split(/\r?\n/)
      .map((line) => truncateAnsiLine(line, Math.max(1, width)));
  }
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function extractTerminalEscape(str: string, pos: number): { code: string; length: number } | null {
  if (pos >= str.length || str[pos] !== "\x1b") return null;
  const next = str[pos + 1];

  // CSI sequence: ESC [ ... final-byte. Covers SGR plus cursor/control codes.
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length) {
      const code = str.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) {
        return { code: str.slice(pos, j + 1), length: j + 1 - pos };
      }
      j++;
    }
    return null;
  }

  // OSC/APC sequence: ESC ]/_ ... BEL or ST (ESC \). Stop at the FIRST
  // terminator so OSC 8 hyperlinks don't swallow visible link text.
  if (next === "]" || next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.slice(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\") {
        return { code: str.slice(pos, j + 2), length: j + 2 - pos };
      }
      j++;
    }
    return null;
  }

  return null;
}

function couldBeEmoji(segment: string): boolean {
  const cp = segment.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1f000 && cp <= 0x1fbff) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b50 && cp <= 0x2b55) ||
    segment.includes("\uFE0F") ||
    segment.includes("\u200D")
  );
}

function isZeroWidthCodePoint(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x300 && cp <= 0x36f) ||     // Combining Diacritical Marks
    (cp >= 0x1ab0 && cp <= 0x1aff) ||   // Combining Diacritical Marks Extended
    (cp >= 0x1dc0 && cp <= 0x1dff) ||   // Combining Diacritical Marks Supplement
    (cp >= 0x20d0 && cp <= 0x20ff) ||   // Combining Diacritical Marks for Symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) ||   // Variation Selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||   // Combining Half Marks
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff
  );
}

function isZeroWidthGrapheme(segment: string): boolean {
  if (segment.length === 0) return true;
  for (const char of segment) {
    if (!isZeroWidthCodePoint(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * Returns the terminal display width of a code point.
 * CJK ideographs, Hangul, fullwidth forms, etc. → 2; everything else → 1.
 * Mirrors the Unicode east-asian-width "W"/"F" categories.
 */
function charWidth(cp: number): number {
  return cp >= 0x1100 && (
    cp <= 0x115f ||   // Hangul Jamo
    (cp >= 0xa960 && cp <= 0xa97c) ||   // Hangul Jamo Extended-A
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||  // CJK
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul syllables
    (cp >= 0xd7b0 && cp <= 0xd7fb) ||   // Hangul Jamo Extended-B
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK compat
    (cp >= 0xfe10 && cp <= 0xfe19) ||   // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK compat forms
    (cp >= 0xff01 && cp <= 0xff60) ||   // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth signs
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK extensions
    (cp >= 0x30000 && cp <= 0x3fffd)    // CJK extensions B+
  ) ? 2 : 1;
}

function graphemeWidth(segment: string): number {
  const cp = segment.codePointAt(0);
  if (cp === undefined) return 0;
  if (isZeroWidthGrapheme(segment)) return 0;
  if (couldBeEmoji(segment)) return 2;
  // Regional indicator symbols render as wide emoji flags in Pi's TUI.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;
  return charWidth(cp);
}

export function truncateAnsiLine(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let output = "";
  let visible = 0;
  let index = 0;
  while (index < line.length) {
    const escape = extractTerminalEscape(line, index);
    if (escape) {
      output += escape.code;
      index += escape.length;
      continue;
    }

    let end = index + 1;
    while (end < line.length && !extractTerminalEscape(line, end)) end++;
    const chunk = line.slice(index, end);
    for (const { segment } of GRAPHEME_SEGMENTER.segment(chunk)) {
      const w = graphemeWidth(segment);
      if (visible + w > maxWidth) return output;
      output += segment;
      visible += w;
    }
    index = end;
  }
  return output;
}

interface PiRenderTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

interface PiRenderContext {
  lastComponent?: unknown;
}

function createContextModeCallRenderer(toolName: string) {
  return (_args: unknown, theme: PiRenderTheme, context: PiRenderContext) => {
    const text =
      context.lastComponent instanceof PiTextComponent
        ? context.lastComponent
        : new PiTextComponent();
    text.setText(theme.fg("toolTitle", theme.bold(toolName)));
    return text;
  };
}

function createContextModeResultRenderer(toolName: string) {
  return (
    result: MCPCallResult,
    { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
    theme: PiRenderTheme,
    context: PiRenderContext,
  ) => {
    const text =
      context.lastComponent instanceof PiTextComponent
        ? context.lastComponent
        : new PiTextComponent();
    if (isPartial) {
      text.setText(theme.fg("warning", "indexing/searching..."));
      return text;
    }
    const output = (result.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    if (expanded) {
      text.setText(theme.fg("toolOutput", output));
      return text;
    }
    const firstLine = output
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim();
    const status =
      firstLine && firstLine.length <= 180
        ? firstLine
        : `${toolName} completed`;
    text.setText(theme.fg("toolOutput", status));
    return text;
  };
}

/**
 * Minimal stdio JSON-RPC client targeting the context-mode MCP server.
 *
 * Implementation notes:
 *   - One outstanding ID per request; results matched by `id` from the
 *     returned envelope. Notifications (no id) are sent fire-and-forget.
 *   - Buffer is split on `\n` because the MCP server writes one
 *     newline-delimited JSON message per `console.log` / `stdout.write`
 *     invocation — this is the standard MCP stdio transport framing.
 *   - On child exit / error, every in-flight request is rejected so
 *     callers do not hang forever.
 */
export class MCPStdioClient {
  private child: ChildProcess | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private initialized = false;
  private exited = false;
  /**
   * In-flight respawn promise — set while {@link respawn} runs so
   * concurrent callers awaiting `request()` after an idle exit observe
   * the SAME respawn, not N parallel ones. Without this guard, two
   * simultaneous `callTool` calls would each see `this.exited === true`,
   * each fire their own `respawn()`, and the loser leaks an orphaned
   * child process the GC cannot reach (no `.kill()` reference).
   */
  private respawnPromise: Promise<void> | null = null;
  /**
   * Live env passed to the spawned child — exposed (read-only intent)
   * so tests can pin the fork-bomb-prevention env counter (#516)
   * without needing to attach a process-tree probe.
   */
  _spawnEnv: NodeJS.ProcessEnv | null = null;

  constructor(
    private readonly serverScript: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly runtimeOverride: string | null = null,
    /**
     * TUI-safe sink for the child's forwarded stderr (#868). Defaults to a
     * no-op so direct callers (skippedBridge, tests) never leak to the
     * terminal; bootstrapMCPTools wires this to the Pi host's file logger.
     */
    private readonly diag: BridgeDiag = () => {},
  ) {}

  /** Spawn the MCP child. Idempotent. */
  start(): void {
    if (this.child) return;
    this.exited = false;
    // Pick a JS runtime that is NOT the host process (#516). When Pi
    // is the host binary, process.execPath would re-exec Pi and fork
    // bomb the box. resolveJsRuntimeForBridge prefers bun/node and
    // explicitly rejects pi-named binaries.
    const runtime =
      this.runtimeOverride ?? resolveJsRuntimeForBridge() ?? process.execPath;
    // Increment the depth counter so any transitive bridge load inside
    // the child can short-circuit before spawning yet another server.
    const depth = Number.parseInt(this.env[BRIDGE_DEPTH_ENV] ?? "0", 10);
    const childEnv: NodeJS.ProcessEnv = {
      ...this.env,
      [BRIDGE_DEPTH_ENV]: String(Number.isFinite(depth) ? depth + 1 : 1),
    };
    // Issue #545 — scrub foreign workspace env vars before spawn.
    //
    // Pi's MCP bridge inherits the host shell env (including a prior
    // `claude` invocation's CLAUDE_PROJECT_DIR). Without this scrub, the
    // spawned MCP server resolves getProjectDir() to the foreign workspace
    // and Pi's sessions write into the wrong project. The ban list is
    // derived ALGORITHMICALLY from PLATFORM_ENV_VARS (every other adapter's
    // workspace-role vars), so adding adapter #16 grows the scrub
    // automatically — no edit to this file. Pi's own workspace vars and
    // the universal escape hatch (CONTEXT_MODE_PROJECT_DIR) are NEVER
    // scrubbed.
    for (const banned of foreignWorkspaceEnv("pi")) {
      delete childEnv[banned];
    }
    // Issue #561 — scrub foreign IDENTIFICATION env vars before spawn.
    //
    // Foreign identification vars hijack detectPlatform() — must scrub
    // when spawning child under a different host (#561). When Pi runs
    // co-resident with Claude Code, the inherited shell env carries
    // CLAUDE_CODE_ENTRYPOINT and CLAUDE_PLUGIN_ROOT; the spawned MCP
    // child's detectPlatform() then walks PLATFORM_ENV_VARS in priority
    // order (claude-code first), returns claude-code, and Pi's session
    // data lands in ~/.claude/context-mode/ instead of Pi's own dir.
    // Pi's OWN identification vars (PI_CONFIG_DIR / PI_SESSION_FILE /
    // PI_COMPILED) are excluded from the ban set so the child still
    // detects pi correctly.
    for (const banned of foreignIdentificationEnv("pi")) {
      delete childEnv[banned];
    }
    // Issue #561 regression fix: Pi detection vars are empty after
    // foreign env scrubbing (CLAUDE_CODE_ENTRYPOINT / CLAUDE_PLUGIN_ROOT
    // are deleted by the ban above). Without PI_CONFIG_DIR,
    // detectPlatform() finds zero Pi identification vars and falls
    // through to Claude Code default — stats land in ~/.claude/ instead
    // of ~/.pi/. Set PI_CONFIG_DIR from the child's HOME env var so the
    // child resolves to Pi correctly. (Use childEnv.HOME, not homedir(),
    // because homedir() reads getpwent() which ignores our HOME override
    // in test environments.)
    //
    // Cross-OS PI_CONFIG_DIR rescue (PR #741 follow-up):
    //   1. If the parent already exported PI_CONFIG_DIR, trust it
    //      verbatim — Pi's launcher owns that path and may pin it to
    //      a non-default location (corporate setup, CI, etc.).
    //   2. POSIX: ~/.pi (HOME-rooted).
    //   3. Windows: probe both %USERPROFILE%\.pi (rare native install)
    //      AND %APPDATA%\.pi (XDG-on-Windows, Pi's documented Windows
    //      layout). Without the APPDATA fallback, every Pi-on-Windows
    //      install silently drops back to the Claude Code default and
    //      Pi's sessions write into the wrong directory.
    if (!childEnv.PI_CONFIG_DIR) {
      const home = childEnv.HOME ?? childEnv.USERPROFILE ?? childEnv.HOMEPATH;
      const appData = childEnv.APPDATA; // Windows-only, undefined on POSIX
      const candidates: string[] = [];
      if (home) candidates.push(join(home, ".pi"));
      if (appData) candidates.push(join(appData, ".pi"));
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          childEnv.PI_CONFIG_DIR = candidate;
          break;
        }
      }
    }
    this._spawnEnv = childEnv;
    this.child = spawn(runtime, [this.serverScript], {
      // Pipe stderr (#472 round-3): swallowing it via "ignore" hides
      // server crash diagnostics — the user only saw "ctx_* tools will
      // not be callable" with no clue WHY. We capture it so the diagnostic
      // is preserved, but route it through `diag` (Pi's file logger), NOT
      // process.stderr — Pi's raw-mode TUI owns the terminal and any console
      // write is rendered into the editor input box, blocking typing (#868).
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    this.child.stdout?.on("data", (chunk) => this.onData(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      // Forward each non-empty line, [mcp-bridge]-prefixed so it stays
      // grep-friendly in ~/.omp/logs. debug level: this is mostly routine
      // child chatter (e.g. the #854 idle-reaper notice), not an alert.
      for (const line of splitDiagLines(text)) {
        if (line !== "") this.diag(`[mcp-bridge] ${line}`, "debug");
      }
    });
    this.child.on("exit", () => this.onExit());
    this.child.on("error", () => this.onExit());
  }

  private onExit(): void {
    if (this.exited) return;
    this.exited = true;
    const err = new Error("MCP server exited");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip non-JSON noise (e.g. stray log lines)
      }
      if (typeof msg.id !== "number" || !this.pending.has(msg.id)) continue;
      const handler = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) handler.reject(msg.error);
      else handler.resolve(msg.result);
    }
  }

  async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    // Respawn-on-idle-exit (#583, #583-followup).
    //
    // Initial #583 fix patched callTool() only. The structural location is
    // here: `request()` is the single chokepoint for `initialize`,
    // `tools/list`, `tools/call`, and any future method. Patching at this
    // layer means listTools / re-initialize paths after an idle exit also
    // self-heal, not just the registered-tool happy path.
    //
    // Sequencing is critical: respawn() resets `exited`, `child`, and
    // `buffer` BEFORE start() + initialize(). The initialize() call inside
    // respawn() goes through this same request() — recursion is safe
    // because by the time we re-enter, `exited` is false again. We use a
    // single-flight `respawnPromise` so concurrent callers share the same
    // respawn (orphan-child guard, see field comment).
    if (this.exited) {
      if (!this.respawnPromise) {
        this.respawnPromise = this.respawn().finally(() => {
          this.respawnPromise = null;
        });
      }
      await this.respawnPromise;
    }
    if (!this.child) throw new Error("MCP client not started");
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("MCP request aborted"));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        this.notify("notifications/cancelled", { requestId: id, reason: "Pi tool call aborted" });
        reject(new Error("MCP request aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Gate the timer on a finite ms value so callers can pass
      // `Number.POSITIVE_INFINITY` to mean "no bridge ceiling" (#643).
      // Node coerces both `undefined` and `Infinity` to a 1ms delay
      // (TimeoutOverflowWarning), so we can't just pass them through —
      // we must skip the setTimeout entirely. tools/call uses this path
      // because long-running ctx_execute must not be bounded here.
      timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            if (!this.pending.has(id)) return;
            this.pending.delete(id);
            signal?.removeEventListener("abort", onAbort);
            reject(new Error(`MCP request timeout after ${timeoutMs}ms: ${method}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const rejectWrite = (err: Error) => {
        const handler = this.pending.get(id);
        if (handler) {
          this.pending.delete(id);
          handler.reject(err);
          return;
        }
        reject(err);
      };
      this.writeFrame(frame, rejectWrite);
    });
  }

  private writeFrame(frame: string, onError?: (err: Error) => void): boolean {
    if (!this.child || this.exited) {
      onError?.(new Error("MCP server exited"));
      return false;
    }

    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.closed) {
      this.onExit();
      onError?.(new Error("MCP server stdin unavailable"));
      return false;
    }

    try {
      stdin.write(frame + "\n", (err) => {
        if (!err) return;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
          this.onExit();
          onError?.(err);
          return;
        }
        onError?.(err);
      });
      return true;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (err instanceof Error && (code === "EPIPE" || code === "ERR_STREAM_DESTROYED")) {
        this.onExit();
        onError?.(err);
        return false;
      }
      throw err;
    }
  }

  notify(method: string, params: unknown): void {
    if (!this.child) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writeFrame(frame);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      clientInfo: {
        name: "pi-coding-agent-context-mode-bridge",
        version: "1.0",
      },
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request<{ tools?: MCPTool[] }>("tools/list", {});
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<MCPCallResult> {
    // Respawn-on-idle-exit is now handled centrally in `request()`
    // (#583 follow-up). Originally patched here in #583 — moving it up
    // one layer covers `listTools` / `initialize` paths too, with a
    // single-flight guard against orphan child processes from
    // concurrent callers.
    //
    // No bridge-imposed timeout for tools/call (#643). The previous
    // 120s ceiling rejected legitimate long-running ctx_execute calls
    // (test suites, builds, large `cargo test`) even though the
    // executor child would have finished. Bounding belongs to the
    // executor layer (per-tool timeout / background mode / Pi cancel),
    // not the transport. `Number.POSITIVE_INFINITY` instructs
    // `request()` to skip the setTimeout entirely — see the gate there.
    return this.request<MCPCallResult>(
      "tools/call",
      { name, arguments: args ?? {} },
      Number.POSITIVE_INFINITY,
      signal,
    );
  }

  /**
   * Respawn the MCP child after an exit (clean shutdown or crash).
   * Resets state so a fresh `start()` + `initialize()` cycle runs, then
   * the caller's pending request flows through the new child.
   *
   * Single-flight — concurrent callers share one in-flight respawn via
   * {@link respawnPromise}. Internal — only entered via {@link request}.
   *
   * Sequencing pinned (do not reorder without updating the regression
   * test in tests/adapters/pi-mcp-bridge.test.ts):
   *   1. `this.child = null`     — drop stale handle
   *   2. `this.buffer = ""`       — discard leftover bytes from old child
   *   3. `this.exited = false`    — must precede `start()` + `initialize()`,
   *                                 because `request("initialize", …)`
   *                                 inside `initialize()` re-checks this
   *                                 flag and would otherwise re-enter
   *                                 respawn in an infinite loop
   *   4. `this.initialized = false`
   *   5. `this.start()`
   *   6. `await this.initialize()` — flows through `request()` recursively
   */
  private async respawn(): Promise<void> {
    this.child = null;
    this.buffer = "";
    this.exited = false;
    this.initialized = false;
    this.start();
    await this.initialize();
  }

  shutdown(): void {
    if (!this.child) return;
    const child = this.child;
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
    // SIGKILL fallback (#472 round-3): a child that ignores SIGTERM
    // (e.g. installed handler that swallows the signal, or stuck in
    // an uninterruptible syscall) becomes a zombie because we null
    // the handle immediately. Schedule a hard kill bounded at 5s; the
    // .unref() prevents this timer from keeping the parent alive after
    // legitimate work is done.
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // best effort
      }
    }, 5000).unref();
    this.child = null;
    this.initialized = false;
    this.exited = true;
  }
}

/**
 * Subset of the Pi ExtensionAPI we touch. Typed structurally so we don't
 * pull `@earendil-works/pi-coding-agent` as a build dependency — keeps
 * the bundle size unchanged and matches the existing pi-extension.ts
 * style (which also types `pi` as `any`).
 */
export interface PiToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  renderCall?: (
    args: unknown,
    theme: PiRenderTheme,
    context: PiRenderContext,
  ) => unknown;
  renderResult?: (
    result: MCPCallResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: PiRenderTheme,
    context: PiRenderContext,
  ) => unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: PiQuestionContext,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    usage?: unknown;
    isError?: boolean;
  }>;
}

export interface PiLikeAPI {
  registerTool: (tool: PiToolRegistration) => void;
  /**
   * Pi's rotating file logger (`~/.omp/logs/`). Pi runs a raw-mode TUI that
   * owns the terminal, so an in-process extension MUST NOT write to
   * process.stdout/stderr — any console write is rendered straight into the
   * editor input box and blocks typing (#868, confirmed against
   * oh-my-pi tui/terminal.ts raw-mode + docs/skills/authoring-extensions.md:
   * "nothing is written to the console, which would corrupt the TUI"). All
   * bridge diagnostics route here instead. Optional: absent in tests / minimal
   * hosts, in which case diagnostics are dropped — we NEVER fall back to the
   * terminal.
   */
  logger?: {
    debug?: (message: string, context?: Record<string, unknown>) => void;
    info?: (message: string, context?: Record<string, unknown>) => void;
    warn?: (message: string, context?: Record<string, unknown>) => void;
    error?: (message: string, context?: Record<string, unknown>) => void;
  };
}

/** TUI-safe diagnostics sink: routes to Pi's file logger, never the terminal. */
export type BridgeDiag = (line: string, level?: "warn" | "debug") => void;

/**
 * Build a {@link BridgeDiag} bound to a Pi host's file logger (#868). Writing to
 * process.stderr from inside Pi's raw-mode TUI corrupts the editor, so every
 * bridge diagnostic — the forwarded MCP child stderr included — goes to
 * `pi.logger` instead. When no logger is reachable (tests, non-Pi hosts) the
 * line is dropped; we never touch the terminal as a fallback.
 */
export function makeBridgeDiag(pi: PiLikeAPI | null | undefined): BridgeDiag {
  const logger = pi?.logger;
  return (line, level = "warn") => {
    try {
      const fn = level === "debug" ? logger?.debug : logger?.warn;
      if (typeof fn === "function") fn(line);
    } catch {
      /* never throw from diagnostics — and never write to the TUI terminal */
    }
  };
}

/**
 * Split a chunk of forwarded child output into lines without a regex (the repo
 * forbids regex in source). Trailing `\r` is stripped so CRLF traces stay clean
 * in the log; the final partial line (no trailing newline) is preserved.
 */
export function splitDiagLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      let end = i;
      if (end > start && text[end - 1] === "\r") end--;
      lines.push(text.slice(start, end));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * #868: is this the FOREGROUND interactive Pi session (vs a subagent / print /
 * RPC session)? Pi passes an ExtensionContext as the 2nd arg to
 * `before_agent_start`; `ctx.hasUI === true` only for the interactive session
 * with a real UI attached (refs oh-my-pi runner.ts:330-331), while subagents
 * are provably `hasUI: false` (refs executor.ts:2052). Fail-safe: treat anything
 * that is NOT an explicit `hasUI === false` as foreground, so an
 * ambiguous/absent ctx keeps the session's bridge ALIVE rather than risking the
 * #868 idle-drop. Mis-classifying an abandoned non-interactive child as
 * foreground only costs one lingering child until parent-death/ session_shutdown
 * reaps it; the opposite error re-drops the user's tools mid-session.
 */
export function isForegroundSession(ctx: unknown): boolean {
  const hasUI = (ctx as { hasUI?: unknown } | null | undefined)?.hasUI;
  return hasUI !== false;
}

/**
 * #868: derive the bridge child's spawn env for a session kind. The FOREGROUND
 * interactive session's child must never be idle-reaped — a multi-minute human
 * pause should not drop its ctx_* tools — so we disable the #854 reaper for it
 * via `CONTEXT_MODE_BRIDGE_IDLE_MS=0` (lifecycle.ts honors 0 → reaper not armed).
 * Sub-context / non-interactive children keep the default reaper so abandoned
 * children still can't accumulate (#854). The foreground child is still reaped
 * on actual parent death by the ppid/​signal watchdog (#311/#388) — only the
 * idle-time path is disabled. Pure; does not mutate the input env.
 */
export function foregroundBridgeEnv(
  baseEnv: NodeJS.ProcessEnv,
  foreground: boolean,
): NodeJS.ProcessEnv {
  if (!foreground) return baseEnv;
  return { ...baseEnv, CONTEXT_MODE_BRIDGE_IDLE_MS: "0" };
}

/** Result of bootstrapping the bridge. */
export interface BridgeHandle {
  /** Names of tools registered with Pi (for diagnostics / tests). */
  tools: string[];
  /** Idempotent shutdown — terminates the MCP child. */
  shutdown: () => void;
  /** Underlying client, exposed for tests / advanced callers. */
  client: MCPStdioClient;
}

/**
 * Spawn the MCP server and register each of its tools with Pi via
 * `pi.registerTool()`. The same JSON Schema returned by `tools/list` is
 * passed straight through as `parameters` — TypeBox emits JSON-Schema
 * compatible objects, so any Pi runtime that validates JSON Schema
 * accepts this shape (verified against pi 0.73.x).
 *
 * Errors during MCP `tools/call` are translated to a `throw` from the
 * `execute()` callback — Pi's contract is "throw to mark the tool call
 * failed", which lets the LLM see and adapt.
 */
export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  /** DI hook for tests: override the runtime resolver entirely. */
  _resolveJsRuntime?: () => string | null;
  /**
   * #868: true for the foreground interactive Pi session → spawn the child with
   * the #854 idle reaper DISABLED so a human pause never drops its tools.
   * Defaults to false (keep the reaper) for any non-foreground / unspecified
   * caller; the pi extension resolves this from `ctx.hasUI` via
   * {@link isForegroundSession}.
   */
  foreground?: boolean;
}

/**
 * Empty-but-valid handle returned when bootstrap is skipped (#516).
 * Keeps the shutdown contract intact so callers do not need null checks.
 */
function skippedBridge(): BridgeHandle {
  return {
    tools: [],
    shutdown: () => {
      /* nothing to shut down */
    },
    client: new MCPStdioClient("/dev/null"),
  };
}

export async function bootstrapMCPTools(
  pi: PiLikeAPI,
  serverScript: string,
  options: BootstrapOptions = {},
): Promise<BridgeHandle> {
  const env = options.env ?? process.env;
  // #868: all bridge diagnostics go to Pi's file logger, never the TUI terminal.
  const diag = makeBridgeDiag(pi);

  // Recursion guard (#516): if an ancestor bridge already incremented
  // the depth counter, refuse to spawn another child — even if the
  // binary-name check would let us through. Catches `node` shims that
  // re-exec Pi and other host swaps that bypass basename detection.
  const depth = Number.parseInt(env[BRIDGE_DEPTH_ENV] ?? "0", 10);
  if (Number.isFinite(depth) && depth > 0) {
    diag(
      `[context-mode] WARNING: skipping MCP bridge — ${BRIDGE_DEPTH_ENV}=${depth} ` +
        `indicates recursion (fork-bomb guard, #516). ctx_* tools will not be callable.`,
    );
    return skippedBridge();
  }

  // Runtime guard (#516): when neither node nor bun is on PATH and the
  // host process is pi, there is no safe binary to spawn. Log once and
  // return an empty handle — the rest of the extension keeps working.
  const runtime = (options._resolveJsRuntime ?? resolveJsRuntimeForBridge)();
  if (runtime === null) {
    diag(
      `[context-mode] WARNING: no JS runtime found (need node or bun on PATH). ` +
        `Skipping MCP bridge to avoid fork bomb (#516). ctx_* tools will not be callable.`,
    );
    return skippedBridge();
  }

  // #868: the foreground interactive session's child runs with the #854 idle
  // reaper disabled (CONTEXT_MODE_BRIDGE_IDLE_MS=0) so a human pause never drops
  // its tools; sub-context / non-interactive children keep the reaper (#854).
  const spawnEnv = foregroundBridgeEnv(env, options.foreground ?? false);
  const client = new MCPStdioClient(serverScript, spawnEnv, runtime, diag);

  // Retry-on-slow-initialize (#647).
  //
  // Each attempt is independently bounded by DEFAULT_REQUEST_TIMEOUT_MS
  // (60s) inside request(). On failure we shutdown the child to release
  // its fds before respawning — this is the same sequencing the #583
  // respawn path uses, just hoisted into the bootstrap layer where the
  // failure happens before any tool was registered. Final attempt's
  // rejection is re-thrown so extension.ts's existing then/onRejected
  // handler runs the degrade-and-log path for genuinely broken servers.
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_INIT_RETRIES; attempt++) {
    try {
      client.start();
      await client.initialize();
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (attempt === MAX_INIT_RETRIES) break;
      const msg = err instanceof Error ? err.message : String(err);
      diag(
        `[context-mode] WARNING: MCP bridge initialize failed ` +
          `(attempt ${attempt + 1}/${MAX_INIT_RETRIES + 1}): ${msg}. Retrying…`,
      );
      // Reclaim the failed child's fds before respawning. shutdown() is
      // idempotent and bounded by a 5s SIGKILL fallback (#472 round-3),
      // so a child stuck in an uninterruptible syscall cannot block the
      // retry loop indefinitely.
      try {
        client.shutdown();
      } catch {
        // best effort — we are already on the failure path
      }
      await new Promise((resolve) => setTimeout(resolve, INIT_RETRY_DELAY_MS));
    }
  }
  if (lastError !== undefined) throw lastError;

  const tools = await client.listTools();
  const registered: string[] = [];

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? "",
      // MCP tools/list returns JSON Schema; Pi validates against JSON
      // Schema (TypeBox is just JSON Schema with extra Symbol metadata
      // for type inference). Empty-object fallback keeps tools that
      // declare no parameters callable.
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      renderCall: createContextModeCallRenderer(tool.name),
      renderResult: createContextModeResultRenderer(tool.name),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const result = await client.callTool(tool.name, params ?? {}, signal);
        const questionCtx = ctx ? { ...ctx, signal: signal ?? ctx.signal } : undefined;
        const rawDebug = params && typeof params === "object"
          ? (params as Record<string, unknown>).debug
          : undefined;
        const debug = rawDebug === true || (typeof rawDebug === "string" && rawDebug.toLowerCase() === "true");
        const questionAnswer = await answerQuestionResult(result, questionCtx, undefined, debug);
        if (questionAnswer) {
          return {
            content: [{ type: "text", text: questionAnswer.text }],
            details: { [QUESTION_IS_ERROR_DETAILS_KEY]: questionAnswer.originalIsError },
            usage: questionAnswer.usage,
          };
        }
        const text = (result.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n");
        if (result.isError) {
          // Throw is the Pi contract for "tool failed". The text body
          // becomes the error message visible to the LLM, so it sees
          // the same diagnostic the MCP server emitted.
          throw new Error(text || `${tool.name} returned an error`);
        }
        return {
          content: [{ type: "text", text }],
          details: {},
        };
      },
    });
    registered.push(tool.name);
  }

  return {
    tools: registered,
    shutdown: () => client.shutdown(),
    client,
  };
}
