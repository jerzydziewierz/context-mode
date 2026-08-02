/**
 * cmq-exp-extension.ts — DETERMINISTIC, hook-driven probe for the
 * context-mode checkpoint/question prompt-cache experiment (Exp B/C).
 *
 * Load with:  pi -e ./cmq-exp-extension.ts -p "Reply READY" --mode json --no-session
 *
 * Pipeline (no model involvement once the primary request has fired):
 *  - before_provider_request → dump every PRIMARY wire payload to
 *    ~/.pi/cmq-exp/payloads/<seq>.json + reflect latest into last-primary.json
 *    (these are the exact bytes pi sent — what got cached).
 *  - turn_end (once) → two nested question calls against the primary prefix:
 *
 *    C1 go-through-pi (THE production-realistic test):
 *      reconstruct the current context via getSystemPrompt() +
 *      convertToLlm(buildSessionContext(entries, leafId)) + getAllTools(),
 *      append the question, run provider.streamSimple(..., cacheRetention:
 *      "short", sessionId) — same provider/auth/upstream as the primary, so
 *      cache identity is shared. Capture the nested wire via its own onPayload
 *      and diff it against the freshest primary dump.
 *
 *    C2 raw replay (diagnostic bonus): clone the exact primary wire payload,
 *      drop stream, append the question block, POST back to the provider's
 *      baseUrl with the provider's apiKey. Tests whether raw byte replay
 *      reads cache through the proxy (likely fails on account binding —
 *      that failure, if present, IS the finding: the feature must go through
 *      pi's provider path).
 *
 * Results (usage.cacheRead for each + C1's prefix diff) are written to
 * ~/.pi/cmq-exp/RESULTS.json and mirrored to stderr.
 */

import { convertToLlm, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = join(homedir(), ".pi", "cmq-exp");
const PAYLOADS = join(OUT, "payloads");
const CHECKPOINTS = join(OUT, "checkpoints");

mkdirSync(PAYLOADS, { recursive: true });
mkdirSync(CHECKPOINTS, { recursive: true });

let dumpSeq = 0;
let lastPrimaryPath = join(PAYLOADS, "last-primary.json");
let ran = false;

function stripCacheControl(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCacheControl);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      if (k === "cache_control") continue;
      out[k] = stripCacheControl(val);
    }
    return out;
  }
  return v;
}

function prefixDiff(a: any[] | undefined, b: any[] | undefined) {
  const aa = (a ?? []).map((m) => stripCacheControl(m));
  const bb = (b ?? []).map((m) => stripCacheControl(m));
  let n = 0;
  const min = Math.min(aa.length, bb.length);
  while (n < min && JSON.stringify(aa[n]) === JSON.stringify(bb[n])) n++;
  if (n >= min) return { prefixMessages: n, complete: aa.length === bb.length, firstDiff: null };
  const firstDiff = {
    index: n,
    aRole: aa[n]?.role,
    bRole: bb[n]?.role,
    aType: Array.isArray(aa[n]?.content)
      ? (aa[n].content[0]?.type ?? aa[n].content[0]?.name)
      : typeof aa[n]?.content,
    bType: Array.isArray(bb[n]?.content)
      ? (bb[n].content[0]?.type ?? bb[n].content[0]?.name)
      : typeof bb[n]?.content,
  };
  return { prefixMessages: n, complete: false, firstDiff };
}

function note(...msg: unknown[]) {
  process.stderr.write("[cmq-exp] " + msg.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ") + "\n");
}

export default function cmqExpExtension(pi: any): void {
  // ── 1. Primary payload capture ─────────────────────────────────────────
  pi.on("before_provider_request", (event: any) => {
    try {
      const p = event?.payload;
      if (!p) return;
      // Skip our own nested calls if they ever pass through here
      // (they won't — nested calls attach their own onPayload).
      dumpSeq++;
      const file = join(PAYLOADS, `${String(dumpSeq).padStart(3, "0")}.json`);
      const rec = {
        _meta: { seq: dumpSeq, ts: new Date().toISOString(), hook: "before_provider_request" },
        summary: {
          model: p?.model,
          tools: Array.isArray(p?.tools) ? p.tools.length : 0,
          messages: Array.isArray(p?.messages) ? p.messages.length : 0,
          systemBytes: p?.system ? JSON.stringify(p.system).length : 0,
        },
        params: p,
      };
      writeFileSync(file, JSON.stringify(rec, null, 1));
      writeFileSync(lastPrimaryPath, JSON.stringify(rec, null, 1));
    } catch (e) {
      note("dump failed:", e);
    }
  });

  // ── 2. turn_end → run the experiment once ──────────────────────────────
  pi.on("turn_end", async (_event: any, ctx: any) => {
    if (ran) return;
    ran = true;
    const results: Record<string, unknown> = { ts: new Date().toISOString() };
    try {
      const sm = ctx.sessionManager;
      const model = ctx.model;
      results.model = model ? `${model.provider}/${model.id}` : null;
      if (!model) {
        results.fatal = "no current model";
        writeFileSync(join(OUT, "RESULTS.json"), JSON.stringify(results, null, 1));
        return;
      }
      const provider = ctx.modelRegistry?.getProvider?.(model.provider);
      if (!provider) {
        results.fatal = `no provider for ${model.provider}`;
        writeFileSync(join(OUT, "RESULTS.json"), JSON.stringify(results, null, 1));
        return;
      }

      // Freshest primary dump for comparison
      let primary: any = null;
      const dumps = readdirSync(PAYLOADS).filter((f) => f.endsWith(".json") && f !== "last-primary.json").sort();
      if (dumps.length > 0) {
        primary = JSON.parse(readFileSync(join(PAYLOADS, dumps[dumps.length - 1]), "utf8"))?.params ?? null;
      }
      results.primaryDump = dumps.length > 0 ? dumps[dumps.length - 1] : null;
      results.primary = primary
        ? {
            model: primary.model,
            messages: primary.messages?.length,
            tools: primary.tools?.length,
            systemBytes: primary.system ? JSON.stringify(primary.system).length : 0,
          }
        : null;

      // ── C1: go-through-pi nested call ────────────────────────────────
      const question = "What is 2+2? Answer in one word.";
      const entries = sm?.getEntries?.() ?? [];
      const leafId = sm?.getLeafId?.() ?? null;
      const sc = buildSessionContext(entries, leafId);
      const messages = convertToLlm(sc.messages);
      const systemPrompt = ctx.getSystemPrompt?.() ?? "";
      const tools = (ctx.getAllTools?.() ?? []) as unknown as any[];
      const questionMsg = {
        role: "user" as const,
        content: [{ type: "text" as const, text: question }],
      };
      const context = {
        systemPrompt,
        messages: [...messages, questionMsg],
        tools,
      };

      let c1Wire: any = null;
      let c1Answer = "";
      let c1Usage: any = null;
      let c1Error: string | null = null;
      const c1Events: string[] = [];
      const t0 = Date.now();
      const timer = setTimeout(() => {
        try {
          streamCancel?.abort();
        } catch {}
      }, 40000);
      let streamCancel: AbortController | undefined;
      try {
        note("C1: streamSimple available?", typeof provider.streamSimple, "provider ids:", ctx.modelRegistry?.getRegisteredProviderIds?.() ?? "n/a");
        streamCancel = new AbortController();
        // Resolve the api key the same way C2 does: the registry's auth layer
        // (the models.json override apiKey:"dario" is not otherwise wired into
        // direct provider.streamSimple calls — it fails with
        // "No API key for provider: dario"). Pass it explicitly via StreamOptions.apiKey.
        let explicitKey: string | undefined;
        try {
          const auth = await ctx.modelRegistry?.getProviderAuth?.(model.provider);
          if (auth?.type === "apiKey" && auth.apiKey) explicitKey = auth.apiKey;
        } catch {}
        note("C1 explicitKey resolved:", explicitKey ? "<set>" : "<none>");
        const stream = provider.streamSimple(model, context, {
          cacheRetention: "short",
          sessionId: sm?.getSessionId?.() ?? undefined,
          apiKey: explicitKey,
          maxTokens: 32,
          signal: streamCancel.signal,
          onPayload: (payload: unknown) => {
            c1Wire = payload;
            c1Events.push("onPayload");
          },
        });
        note("C1: stream typeof:", typeof stream, "isAsyncIterable:", stream && typeof stream[Symbol.asyncIterator] === "function");
        for await (const ev of stream) {
          c1Events.push(ev?.type ?? "?");
          if (ev?.type === "text_delta" && ev.delta) c1Answer += ev.delta;
          if (ev?.type === "done") c1Usage = ev?.partial?.usage ?? c1Usage;
          if (ev?.type === "error") {
            c1Error = JSON.stringify(ev).slice(0, 800);
            note("C1 error event:", JSON.stringify(ev).slice(0, 800));
          }
          if (ev?.type === "done" && ev?.partial?.stopReason === "error") {
            c1Error = JSON.stringify(ev.partial).slice(0, 800);
          }
        }
      } catch (e) {
        c1Error = e instanceof Error ? e.message : String(e);
        note("C1 threw:", c1Error);
      } finally {
        clearTimeout(timer);
      }
      const c1Ms = Date.now() - t0;
      note("C1 events:", c1Events.join(",") || "<none>", "ms:", c1Ms);

      // C1 diff: nested wire vs primary wire
      let c1Diff: unknown = null;
      if (primary && c1Wire) {
        const sysEq = JSON.stringify(stripCacheControl(primary.system)) ===
          JSON.stringify(stripCacheControl(c1Wire.system));
        const toolsEq = JSON.stringify(stripCacheControl(primary.tools)) ===
          JSON.stringify(stripCacheControl(c1Wire.tools));
        const nestedMsgs = Array.isArray(c1Wire.messages) ? c1Wire.messages.slice(0, -1) : [];
        const pd = prefixDiff(primary.messages, nestedMsgs);
        c1Diff = {
          systemMatch: sysEq,
          toolsMatch: toolsEq,
          messagePrefix: `${pd.prefixMessages}/${primary.messages?.length ?? 0}${pd.complete ? " complete" : ""}`,
          firstDiff: pd.firstDiff,
        };
      }
      results.c1 = {
        ms: c1Ms,
        answer: c1Answer.slice(0, 80),
        error: c1Error,
        usage: c1Usage
          ? {
              input: c1Usage.input,
              output: c1Usage.output,
              cacheRead: c1Usage.cacheRead,
              cacheWrite: c1Usage.cacheWrite,
            }
          : null,
        wire: c1Wire ? { model: c1Wire.model, messages: c1Wire.messages?.length, tools: c1Wire.tools?.length } : null,
        diff: c1Diff,
      };

      // ── C2: raw replay of the exact primary wire payload ─────────────
      if (primary) {
        const replica = JSON.parse(JSON.stringify(primary));
        delete replica.stream;
        replica.messages = [...(replica.messages ?? [])];
        replica.messages.push({
          role: "user",
          content: [{ type: "text", text: question, cache_control: { type: "ephemeral" } }],
        });
        let c2: unknown = null;
        try {
          const baseUrl = provider?.baseUrl ?? "http://localhost:3456";
          const apiBase = baseUrl.replace(/\/+$/, "");
          const url = `${apiBase}/v1/messages`;
          const apiKey = await (async () => {
            try {
              const auth = await ctx.modelRegistry?.getProviderAuth?.(model.provider);
              if (auth?.type === "apiKey" && auth.apiKey) return auth.apiKey;
            } catch {}
            // fall back to provider.baseUrl-derived guess
            return "dario";
          })();
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(replica),
          });
          const json = await res.json();
          const u = json?.usage;
          c2 = {
            httpStatus: res.status,
            modelReturned: json?.model,
            input: u?.input_tokens,
            output: u?.output_tokens,
            cacheRead: u?.cache_read_input_tokens,
            cacheWrite: u?.cache_creation_input_tokens,
            error: res.ok ? undefined : (json?.error?.message ?? JSON.stringify(json).slice(0, 200)),
          };
        } catch (e) {
          c2 = { error: e instanceof Error ? e.message : String(e) };
        }
        results.c2 = c2;
      }

      writeFileSync(join(OUT, "RESULTS.json"), JSON.stringify(results, null, 1));
      note("RESULTS:", JSON.stringify(results));
    } catch (e) {
      results.fatal = e instanceof Error ? e.message : String(e);
      writeFileSync(join(OUT, "RESULTS.json"), JSON.stringify(results, null, 1));
      note("exp failed:", e);
    }
  });
}
