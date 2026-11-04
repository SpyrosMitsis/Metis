// ============================================================================
// Multi-LLM provider abstraction layer.
//
// One entry point — `llmGenerate` — normalizes request + response across all
// five providers and returns a uniform `LlmResult`. `llmGenerateWithFallback`
// walks the user's configured fallback chain on failure.
//
// Every provider receives the SAME system + user prompt. Provider-specific
// quirks (JSON mode, message shape, header names) are isolated to the adapter
// functions below.
// ============================================================================

import type { LlmProvider, LlmResult } from "./types.ts";
import { stripDashes } from "./dashes.ts";
import { logger } from "./log.ts";
import {
  anthropicCacheUsage,
  anthropicSystemField,
  estimateTokens,
  openAiCacheUsage,
  shouldCachePrefix,
} from "./llm_cache.ts";

const log = logger("llm");

export interface ProviderSpec {
  label: string;
  model: string;
  // USD per 1M tokens.
  inputPer1M: number;
  outputPer1M: number;
  getFreeKeyUrl: string;
}

// Per-request deadline for a (non-streaming) provider call. Without it a hung
// provider runs to the platform wall-clock, and the agentic coach loop compounds
// that across up to ~12 sequential calls. AbortSignal.timeout auto-cleans.
// Env-overridable because the offline eval legitimately waits on slow reasoning
// models (mimo-v2.5-pro needs >60s for a week plan); production leaves it alone.
const LLM_TIMEOUT_MS = envInt("WM_LLM_TIMEOUT_MS", 60_000);

// COST-SAFETY INVARIANT. Output tokens are the expensive half of every bill, so
// nothing here may write max_tokens directly: every adapter (and
// llm_native_tools.ts) resolves it through maxTokensOf() below.
//
// Every FEATURE gets a budget sized to its job. One flat number used to serve
// them all, and it could not: a coach brief is two sentences, a week plan is
// seven complete workout objects. At a flat 2,500 the brief wasted nothing and
// the week plan was guillotined mid-JSON. Measured on three consecutive real
// runs: 2144 / 2216 / 2500 output tokens, i.e. 86% / 89% / 100% of the cap, and
// the third truncated inside a string with all 7 days still open.
//
// The cap was also costing what it meant to save: plan-week retries a failed
// parse (plan-week/index.ts) with the same ceiling, so a truncation burnt 2,500
// + 2,500 on a doomed retry for zero output.
//
// max_tokens is a CEILING, not a target, so a bigger budget costs nothing on the
// calls that don't need it. What a budget bounds is the WORST case, which is why
// chat stays tight (up to MAX_LLM_CALLS_PER_TURN of them per turn) while plan,
// which runs once or twice, can afford room.
//
// Operators can pull any of this down with WM_MAX_OUTPUT_TOKENS (BYO, the user's
// money) or WM_HOSTED_MAX_OUTPUT_TOKENS (hosted, YOURS). Nothing may ever exceed
// ABSOLUTE_MAX_OUTPUT_TOKENS. _shared/quota.ts prices its caps against this
// table: change a budget and re-run the per-call estimates in docs/LLM_COSTS.md.
export const OUTPUT_BUDGETS: Record<string, number> = {
  brief: 500, // 1-2 sentences (prompt.ts BRIEF_SYSTEM)
  week_review: 700, // a short recap
  memory: 900, // agent_memory docs are capped at ~200 words anyway
  analyze: 1500, // 3-5 sentences of feedback
  chat: 2500, // the cost driver: up to 12 of these per turn
  workout: 2500, // one workout object
  finalize: 3000, // a workout or plan template
  plan: 6000, // 7 x full workout JSON; measured need ~2.5k, so 2x headroom
};

/** Budget for a call that names no feature. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2500;

/** Hard bound. No feature, env override or caller may exceed this. */
const ABSOLUTE_MAX_OUTPUT_TOKENS = 8000;

function envInt(name: string, fallback: number): number {
  // Test-safe: _shared tests run without --allow-env.
  const raw = (() => {
    try {
      return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } })
        .Deno?.env.get(name);
    } catch {
      return undefined;
    }
  })();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The output-token budget for one call.
 *
 * Precedence: an explicit `maxTokens` → the feature's budget → the default. The
 * result is then clamped by the operator's env override (hosted vs BYO) and by
 * the absolute bound, so a caller can never talk its way past either.
 */
export function maxTokensOf(
  args: { feature?: string; maxTokens?: number; hosted?: boolean },
): number {
  const budget = args.maxTokens ??
    (args.feature ? OUTPUT_BUDGETS[args.feature] : undefined) ??
    DEFAULT_MAX_OUTPUT_TOKENS;
  // The env vars are an emergency brake, not the normal path: unset means the
  // table governs. Hosted spends the operator's money, so it has its own.
  const ceiling = args.hosted
    ? envInt("WM_HOSTED_MAX_OUTPUT_TOKENS", ABSOLUTE_MAX_OUTPUT_TOKENS)
    : envInt("WM_MAX_OUTPUT_TOKENS", ABSOLUTE_MAX_OUTPUT_TOKENS);
  return Math.max(1, Math.min(budget, ceiling, ABSOLUTE_MAX_OUTPUT_TOKENS));
}

export const PROVIDERS: Record<LlmProvider, ProviderSpec> = {
  anthropic: {
    label: "Anthropic",
    model: "claude-opus-4-8",
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    getFreeKeyUrl: "https://console.anthropic.com/settings/keys",
  },
  deepseek: {
    label: "DeepSeek",
    // V4 Flash. DeepSeek's docs say the old deepseek-chat/deepseek-reasoner
    // aliases became "inaccessible after 2026-07-24 15:59 UTC". Measured
    // 2026-07-26: deepseek-chat still answers 200 and routes here, so it is
    // living on borrowed time rather than already dead. Pin the real id.
    // Thinking mode is OPT-IN on V4 (a `thinking: {type:"enabled"}` body
    // field). We never send it: reasoning tokens bill as output and would eat
    // the hosted spend cap for a chat turn that doesn't need them. Keep it off.
    model: "deepseek-v4-flash",
    inputPer1M: 0.09,
    outputPer1M: 0.18,
    getFreeKeyUrl: "https://platform.deepseek.com/api_keys",
  },
  openai: {
    label: "OpenAI",
    model: "gpt-5-mini",
    inputPer1M: 0.25,
    outputPer1M: 2.0,
    getFreeKeyUrl: "https://platform.openai.com/api-keys",
  },
  gemini: {
    label: "Google Gemini",
    model: "gemini-2.5-flash",
    inputPer1M: 0.3,
    outputPer1M: 2.5,
    getFreeKeyUrl: "https://aistudio.google.com/app/apikey",
  },
  groq: {
    label: "Groq",
    model: "llama-3.3-70b-versatile",
    inputPer1M: 0.59,
    outputPer1M: 0.79,
    getFreeKeyUrl: "https://console.groq.com/keys",
  },
  openrouter: {
    // OpenAI-compatible aggregator at a fixed endpoint. Default model is the
    // auto-router; the user can override with any OpenRouter model id. Pricing
    // varies per underlying model, so cost shows ~$0 unless a price override is
    // set (customPriceFromProfile also covers openrouter).
    label: "OpenRouter",
    model: "openrouter/auto",
    inputPer1M: 0,
    outputPer1M: 0,
    getFreeKeyUrl: "https://openrouter.ai/keys",
  },
  custom: {
    // User-supplied OpenAI-compatible endpoint. No fixed model (the user types
    // it) and no pricing (self-hosted/unknown → cost shows ~$0).
    label: "Custom (OpenAI-compatible)",
    model: "",
    inputPer1M: 0,
    outputPer1M: 0,
    getFreeKeyUrl: "",
  },
};

// Per-1M-token prices to use instead of the provider's defaults — set for the
// custom (BYO) provider, which has no fixed pricing.
export interface PriceOverride {
  inputPer1M: number;
  outputPer1M: number;
}

// Per-model prices for models that differ from their provider's default. Only
// covers the Anthropic family — the documented "strong model opt-in" — so a user
// who selects, say, Haiku or Sonnet instead of the default Opus isn't billed at
// Opus rates. Other providers fall back to the provider default. Source:
// Anthropic pricing, USD per 1M tokens.
const MODEL_PRICES: { test: RegExp; inputPer1M: number; outputPer1M: number }[] = [
  { test: /opus-4/i, inputPer1M: 5.0, outputPer1M: 25.0 },
  { test: /sonnet-4/i, inputPer1M: 3.0, outputPer1M: 15.0 },
  { test: /haiku-4/i, inputPer1M: 1.0, outputPer1M: 5.0 },
  { test: /fable-5|mythos-5/i, inputPer1M: 10.0, outputPer1M: 50.0 },
];
function priceForModel(model: string | undefined): PriceOverride | undefined {
  if (!model) return undefined;
  const hit = MODEL_PRICES.find((m) => m.test.test(model));
  return hit ? { inputPer1M: hit.inputPer1M, outputPer1M: hit.outputPer1M } : undefined;
}

// Cache multipliers on the INPUT rate. A cached prefix is billed once at a
// premium to write it, then at a large discount every time it is read.
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export function estimateCostUsd(
  provider: LlmProvider,
  promptTokens: number,
  completionTokens: number,
  override?: PriceOverride,
  model?: string,
  // Cache-billed tokens, ADDITIONAL to promptTokens rather than part of it.
  // This is the trap: Anthropic's `input_tokens` reports only the UNCACHED
  // remainder of the prompt, so once caching is on, pricing promptTokens alone
  // silently under-reports every cached call and the cost table would show a
  // saving far larger than the real one.
  cache?: { writeTokens?: number; readTokens?: number },
): number {
  const p = PROVIDERS[provider];
  // Precedence: explicit user override (custom/openrouter BYO pricing) →
  // model-specific price (non-default model on a built-in provider) → provider
  // default. Without the middle tier a non-default model logged the wrong price.
  const priced = override ?? priceForModel(model);
  const inputPer1M = priced?.inputPer1M ?? p.inputPer1M;
  const outputPer1M = priced?.outputPer1M ?? p.outputPer1M;
  const write = cache?.writeTokens ?? 0;
  const read = cache?.readTokens ?? 0;
  return (
    (promptTokens / 1_000_000) * inputPer1M +
    (write / 1_000_000) * inputPer1M * CACHE_WRITE_MULTIPLIER +
    (read / 1_000_000) * inputPer1M * CACHE_READ_MULTIPLIER +
    (completionTokens / 1_000_000) * outputPer1M
  );
}

// Build a price override from the user's profile for the providers with no
// fixed pricing (custom BYO endpoint + OpenRouter, whose cost depends on the
// chosen model), so their cost isn't hardcoded $0. Returns undefined for the
// built-in providers (known pricing) or when the user hasn't entered prices.
export function customPriceFromProfile(
  provider: LlmProvider | string,
  profile:
    | { llm_custom_input_per_1m?: number | null; llm_custom_output_per_1m?: number | null }
    | null
    | undefined,
): PriceOverride | undefined {
  if ((provider !== "custom" && provider !== "openrouter") || !profile) return undefined;
  const inp = profile.llm_custom_input_per_1m;
  const out = profile.llm_custom_output_per_1m;
  if (typeof inp !== "number" && typeof out !== "number") return undefined;
  return { inputPer1M: inp ?? 0, outputPer1M: out ?? 0 };
}

// Rough token estimate when a provider doesn't return usage (~4 chars/token).
function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface GenArgs {
  // Either a single prompt OR a multi-turn message history.
  prompt?: string;
  messages?: ChatMessage[];
  systemPrompt: string;
  apiKey: string;
  model?: string;
  // JSON-object response mode. Defaults to true (workout generation); pass
  // false for free-form coach chat.
  jsonMode?: boolean;
  // OpenAI-compatible base URL for the "custom" provider (e.g.
  // http://host:11434/v1). Ignored by the built-in providers.
  baseUrl?: string;
  // Sampling temperature. Defaults to 0.6 (conversational). Structured workout
  // generation passes a lower value for less variance in the numbers (TSS/load).
  // Ignored by models that reject the parameter (Opus 4.7+, gpt-5/o-series).
  temperature?: number;
  // Reproducible mode for regression/eval runs: forces temperature 0 and passes
  // a fixed `seed` where the provider supports it (OpenAI-compatible).
  deterministic?: boolean;
  seed?: number;
  // Which feature this call serves, e.g. "plan" / "chat". Selects the output
  // budget in OUTPUT_BUDGETS and should match the `feature` the same call site
  // passes to logGeneration, so cost rows and budgets agree.
  feature?: string;
  // Explicit output ceiling, overriding the feature budget. Still clamped by the
  // env override and ABSOLUTE_MAX. Use it when a caller needs a short answer.
  maxTokens?: number;
  // True when this runs on the operator's hosted key. Must be passed through
  // from the llmAccess() bundle: it selects the hosted (spend-bounded) ceiling
  // and is what quota.ts's cost model assumes.
  hosted?: boolean;
  // Forces schema-shaped output via native tool-calling, currently honored only
  // by the anthropic() adapter (which has no json_object-style mode otherwise).
  // OpenAI-compatible/Gemini already enforce JSON via `jsonMode` and ignore this.
  jsonSchema?: { name: string; description?: string; schema: Record<string, unknown> };
}

// Resolve the effective temperature for a call (deterministic → 0, else 0.6).
function tempOf(args: GenArgs): number {
  if (args.deterministic) return 0;
  return typeof args.temperature === "number" ? args.temperature : 0.6;
}

function turns(args: GenArgs): ChatMessage[] {
  return args.messages ?? [{ role: "user", content: args.prompt ?? "" }];
}
function promptText(args: GenArgs): string {
  return args.systemPrompt + turns(args).map((m) => m.content).join("\n");
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter — covers OpenAI, DeepSeek, and Groq, which all
// speak the /chat/completions schema. Only base URL + JSON-mode flag differ.
// ---------------------------------------------------------------------------
// Newer OpenAI models (gpt-5 family, o-series) require `max_completion_tokens`
// instead of `max_tokens` and reject custom temperature values.
export function openAiModernParams(provider: LlmProvider, model: string): boolean {
  return provider === "openai" && /^(gpt-5|o\d|chatgpt)/i.test(model);
}

// DeepSeek V4 defaults to THINKING mode, and its reasoning tokens are billed as
// output AND counted against max_tokens. Measured against the live API: a plain
// `deepseek-v4-flash` call with max_tokens 20 returned content "" with
// finish_reason "length", having spent the entire budget on reasoning_content.
// At OUTPUT_BUDGETS.workout/plan that means truncated-or-empty JSON, the exact
// failure documented for the MiMo reasoning models in scripts/eval/models.ts.
//
// `{"type":"disabled"}` is the only thing that works: `reasoning_effort:"none"`
// is rejected (400, expects high/low/medium/max/xhigh) and
// `{"type":"enabled","enabled":false}` still thinks. Applies to every DeepSeek
// request body, so it lives here rather than at each call site.
export function deepseekBodyExtras(
  provider: LlmProvider,
  model: string,
): Record<string, unknown> {
  if (provider === "openrouter" && /^deepseek\/deepseek-v4/.test(model)) return { reasoning: { enabled: false } };
  return provider === "deepseek" && /^deepseek-v4/.test(model)
    ? { thinking: { type: "disabled" } }
    : {};
}

// Optional ranking/attribution headers OpenRouter uses for its app leaderboard.
// Purely informational — calls work without them; ignored by every other base.
function openRouterHeaders(provider: LlmProvider): Record<string, string> {
  return provider === "openrouter"
    ? { "HTTP-Referer": "https://github.com/workout-maker", "X-Title": "Workout Maker" }
    : {};
}

async function openAiCompatible(
  provider: LlmProvider,
  baseUrl: string,
  args: GenArgs,
): Promise<LlmResult> {
  const model = args.model ?? PROVIDERS[provider].model;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: args.systemPrompt },
      ...turns(args),
    ],
    ...deepseekBodyExtras(provider, model),
  };
  if (openAiModernParams(provider, model)) {
    body.max_completion_tokens = maxTokensOf(args);
  } else {
    body.temperature = tempOf(args);
    body.max_tokens = maxTokensOf(args);
  }
  // Reproducible sampling where supported (OpenAI/DeepSeek/Groq honor `seed`).
  if (args.deterministic && typeof args.seed === "number") body.seed = args.seed;
  if (args.jsonMode !== false) body.response_format = { type: "json_object" };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
      ...openRouterHeaders(provider),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`${provider} HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error(`${provider} returned empty content (finish_reason=${data.choices?.[0]?.finish_reason ?? "unknown"})`);
  return {
    text,
    promptTokens: data.usage?.prompt_tokens ?? estTokens(promptText(args)),
    completionTokens: data.usage?.completion_tokens ?? estTokens(text),
    provider,
    model,
    // These providers cache long prefixes on their own; nothing was sent to
    // ask for it, this just reads back what they already did.
    ...openAiCacheUsage(data.usage),
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

// Opus 4.7+ and Fable removed sampling parameters — sending `temperature`
// returns a 400 on those models, so only include it where still accepted.
export function anthropicAcceptsTemperature(model: string): boolean {
  return !/opus-4-[78]|fable/i.test(model);
}

async function anthropic(args: GenArgs): Promise<LlmResult> {
  const model = args.model ?? PROVIDERS.anthropic.model;
  // Tools render BEFORE system, so the breakpoint on the system block covers
  // both and the prefix size has to count both (llm_cache.ts).
  const schemaTool = args.jsonSchema
    ? [{
      name: args.jsonSchema.name,
      description: args.jsonSchema.description ?? "Emit the result.",
      input_schema: args.jsonSchema.schema,
    }]
    : null;
  const prefixTokens = estimateTokens(args.systemPrompt) +
    (schemaTool ? estimateTokens(JSON.stringify(schemaTool)) : 0);
  const { cache } = shouldCachePrefix("anthropic", model, args.feature, prefixTokens);

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokensOf(args),
    system: anthropicSystemField(args.systemPrompt, cache),
    messages: turns(args),
  };
  if (anthropicAcceptsTemperature(model)) body.temperature = tempOf(args);
  // No json_object-style mode exists on this API, so schema-shaped output is
  // forced via a single tool the model must call (same mechanism
  // llm_native_tools.ts uses for agentic tool calls).
  if (schemaTool) {
    body.tools = schemaTool;
    body.tool_choice = { type: "tool", name: args.jsonSchema!.name };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`anthropic HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const content = (data.content ?? []) as { type: string; text?: string; input?: unknown }[];
  const toolUse = args.jsonSchema && content.find((b) => b.type === "tool_use");
  const text: string = toolUse
    ? JSON.stringify(toolUse.input)
    : content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return {
    text,
    promptTokens: data.usage?.input_tokens ?? estTokens(promptText(args)),
    completionTokens: data.usage?.output_tokens ?? estTokens(text),
    provider: "anthropic",
    model,
    ...anthropicCacheUsage(data.usage),
  };
}

// ---------------------------------------------------------------------------
// Google Gemini generateContent API
// ---------------------------------------------------------------------------
async function gemini(args: GenArgs): Promise<LlmResult> {
  const model = args.model ?? PROVIDERS.gemini.model;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${args.apiKey}`;
  const generationConfig: Record<string, unknown> = {
    temperature: tempOf(args),
    maxOutputTokens: maxTokensOf(args),
  };
  if (args.jsonMode !== false) generationConfig.responseMimeType = "application/json";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: args.systemPrompt }] },
      contents: turns(args).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gemini HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text: string =
    data.candidates?.[0]?.content?.parts?.map((p: { text: string }) => p.text).join("") ?? "";
  return {
    text,
    promptTokens: data.usageMetadata?.promptTokenCount ?? estTokens(promptText(args)),
    completionTokens: data.usageMetadata?.candidatesTokenCount ?? estTokens(text),
    provider: "gemini",
    model,
  };
}

// ---------------------------------------------------------------------------
// Streaming. Each provider family is parsed from its SSE format; onToken fires
// per text delta. Used by the coach chat.
//
// COST IS THE HARD PART, not the parsing. Every LLM call has to land a
// generation_logs row (see generation_log.ts), hosted_spend() SUMs those rows,
// and quota.ts fails CLOSED on them. A streamed turn that reports zero tokens
// is a turn the spend cap cannot see, so llmStream returns a full LlmResult
// with real usage, and flags `usageEstimated` when a provider gave us nothing
// and we had to fall back to the ~4-chars/token estimate.
// ---------------------------------------------------------------------------

/** Wall-clock ceiling for a whole stream, and the no-data-received watchdog. */
const STREAM_IDLE_MS = envInt("WM_LLM_STREAM_IDLE_MS", 30_000);
const STREAM_TOTAL_MS = envInt("WM_LLM_STREAM_TOTAL_MS", 300_000);

export interface StreamResult extends LlmResult {
  /** True when usage came from estTokens rather than the provider. */
  usageEstimated: boolean;
}

interface Usage {
  prompt?: number;
  completion?: number;
}

export async function* sseLines(res: Response, onIdleReset: () => void): AsyncGenerator<string> {
  if (!res.body) throw new Error("stream response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    onIdleReset();
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      const t = line.trim();
      if (t.startsWith("data:")) yield t.slice(5).trim();
    }
  }
}

/**
 * A stream must not inherit the flat request timeout: a long, healthy reply
 * would be killed mid-sentence. Abort on SILENCE instead (no chunk for
 * STREAM_IDLE_MS), with a hard total ceiling as a backstop.
 */
export function streamAbort(): { signal: AbortSignal; reset: () => void; done: () => void } {
  const ctl = new AbortController();
  let idle = setTimeout(() => ctl.abort(), STREAM_IDLE_MS);
  const total = setTimeout(() => ctl.abort(), STREAM_TOTAL_MS);
  return {
    signal: ctl.signal,
    reset: () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctl.abort(), STREAM_IDLE_MS);
    },
    done: () => {
      clearTimeout(idle);
      clearTimeout(total);
    },
  };
}

/** Settle provider usage against the estimate, and say which one we used. */
function settleUsage(
  usage: Usage,
  provider: LlmProvider,
  model: string,
  args: GenArgs,
  text: string,
): StreamResult {
  const estimated = usage.prompt == null || usage.completion == null;
  if (estimated) {
    // Loud on purpose: silent zero-token rows are how streamed spend goes dark.
    log.warn("stream usage missing, estimating", { provider, model });
  }
  return {
    text,
    promptTokens: usage.prompt ?? estTokens(promptText(args)),
    completionTokens: usage.completion ?? estTokens(text),
    provider,
    model,
    usageEstimated: estimated,
  };
}

/**
 * Providers whose /chat/completions accepts `stream_options.include_usage`.
 * Deliberately excludes `custom`: an unknown body key can 400 a strict
 * self-hosted endpoint, so those fall back to the token estimate instead.
 */
function acceptsStreamUsage(provider: LlmProvider): boolean {
  return provider === "openai" || provider === "deepseek" ||
    provider === "groq" || provider === "openrouter";
}

export async function llmStream(
  provider: LlmProvider,
  args: GenArgs,
  onToken: (t: string) => void,
): Promise<StreamResult> {
  const model = args.model ?? PROVIDERS[provider].model;
  const started = Date.now();
  const usage: Usage = {};
  let full = "";
  const abort = streamAbort();

  const finish = (r: StreamResult): StreamResult => {
    abort.done();
    log.info("stream", {
      provider,
      model,
      ms: Date.now() - started,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      estimated: r.usageEstimated,
    });
    return r;
  };

  try {
    if (
      provider === "openai" || provider === "deepseek" || provider === "groq" ||
      provider === "openrouter" || provider === "custom"
    ) {
      if (provider === "custom" && !args.baseUrl) {
        throw new Error("custom provider: base URL not configured");
      }
      const base = provider === "openai"
        ? "https://api.openai.com/v1"
        : provider === "deepseek"
        ? "https://api.deepseek.com/v1"
        : provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : provider === "custom"
        ? args.baseUrl!
        : "https://api.groq.com/openai/v1";
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "system", content: args.systemPrompt }, ...turns(args)],
        stream: true,
        ...(acceptsStreamUsage(provider) ? { stream_options: { include_usage: true } } : {}),
        ...deepseekBodyExtras(provider, model),
      };
      if (openAiModernParams(provider, model)) {
        body.max_completion_tokens = maxTokensOf(args);
      } else {
        // Was hardcoded 0.6, which silently ignored deterministic/eval runs.
        body.temperature = tempOf(args);
        body.max_tokens = maxTokensOf(args);
      }
      if (args.deterministic && typeof args.seed === "number") body.seed = args.seed;

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
          ...openRouterHeaders(provider),
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${await res.text()}`);
      for await (const data of sseLines(res, abort.reset)) {
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data);
          // Read usage off EVERY chunk. Measured against the live DeepSeek API:
          // usage rides the LAST content chunk, which still has choices, not a
          // separate empty-choices chunk as the OpenAI docs imply. Groq puts it
          // under x_groq. Gating this on "choices is empty" loses it entirely.
          const u = chunk.usage ?? chunk.x_groq?.usage;
          if (u) {
            usage.prompt = u.prompt_tokens ?? usage.prompt;
            usage.completion = u.completion_tokens ?? usage.completion;
          }
          const tok = chunk.choices?.[0]?.delta?.content ?? "";
          if (tok) {
            full += tok;
            onToken(tok);
          }
        } catch { /* ignore keep-alives */ }
      }
      return finish(settleUsage(usage, provider, model, args, full));
    }

    if (provider === "anthropic") {
      const streamBody: Record<string, unknown> = {
        model,
        max_tokens: maxTokensOf(args),
        stream: true,
        system: args.systemPrompt,
        messages: turns(args),
      };
      if (anthropicAcceptsTemperature(model)) streamBody.temperature = tempOf(args);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": args.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(streamBody),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${await res.text()}`);
      for await (const data of sseLines(res, abort.reset)) {
        try {
          const ev = JSON.parse(data);
          // Input tokens land once up front; output_tokens is CUMULATIVE on
          // each message_delta, so last write wins rather than summing.
          if (ev.type === "message_start") {
            usage.prompt = ev.message?.usage?.input_tokens ?? usage.prompt;
            usage.completion = ev.message?.usage?.output_tokens ?? usage.completion;
          }
          if (ev.type === "message_delta" && ev.usage?.output_tokens != null) {
            usage.completion = ev.usage.output_tokens;
          }
          if (ev.type === "content_block_delta") {
            const tok = ev.delta?.text ?? "";
            if (tok) {
              full += tok;
              onToken(tok);
            }
          }
        } catch { /* ignore */ }
      }
      return finish(settleUsage(usage, provider, model, args, full));
    }

    // gemini
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${args.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.systemPrompt }] },
        contents: turns(args).map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature: tempOf(args), maxOutputTokens: maxTokensOf(args) },
      }),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${await res.text()}`);
    for await (const data of sseLines(res, abort.reset)) {
      try {
        const chunk = JSON.parse(data);
        // usageMetadata repeats and grows; the last one seen is the total.
        if (chunk.usageMetadata) {
          usage.prompt = chunk.usageMetadata.promptTokenCount ?? usage.prompt;
          usage.completion = chunk.usageMetadata.candidatesTokenCount ?? usage.completion;
        }
        const tok = chunk.candidates?.[0]?.content?.parts
          ?.map((p: { text: string }) => p.text).join("") ?? "";
        if (tok) {
          full += tok;
          onToken(tok);
        }
      } catch { /* ignore */ }
    }
    return finish(settleUsage(usage, provider, model, args, full));
  } catch (e) {
    abort.done();
    throw e;
  }
}

export async function llmGenerate(
  provider: LlmProvider,
  args: GenArgs,
): Promise<LlmResult> {
  const dispatch = (): Promise<LlmResult> => {
    switch (provider) {
      case "openai":
        return openAiCompatible("openai", "https://api.openai.com/v1", args);
      case "deepseek":
        return openAiCompatible("deepseek", "https://api.deepseek.com/v1", args);
      case "groq":
        return openAiCompatible("groq", "https://api.groq.com/openai/v1", args);
      case "openrouter":
        return openAiCompatible("openrouter", "https://openrouter.ai/api/v1", args);
      case "anthropic":
        return anthropic(args);
      case "gemini":
        return gemini(args);
      case "custom":
        if (!args.baseUrl) throw new Error("custom provider: base URL not configured");
        if (!args.model) throw new Error("custom provider: model id not configured");
        return openAiCompatible("custom", args.baseUrl, args);
      default:
        throw new Error(`unknown provider: ${provider}`);
    }
  };
  // One structured line per call: provider, model, latency, token usage (or the
  // error body on failure) — this is the LLM path's only observability surface.
  const out = await log.time("generate", dispatch(), (r) => ({
    provider,
    model: r.model || args.model,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
  }));
  // THE enforcement point for the no-dash rule, for every non-streaming
  // feature: brief, week review, debrief, strength insight, workout, plan.
  // It used to be three hand-applied call sites, which is exactly why an em
  // dash sat on the Home screen's readiness note for weeks — coach-brief was
  // simply not one of the three. Streaming has its own scrubber
  // (dashScrubber in coach_stream.ts), since it must scrub mid-token.
  // Safe on the JSON-producing features: the substitutions only ever emit
  // hyphens and commas, never a quote or a brace.
  return { ...out, text: stripDashes(out.text), raw: out.text };
}

export interface FallbackKeyResolver {
  (provider: LlmProvider): Promise<string | null>;
}

export interface FallbackOutcome extends LlmResult {
  attempts: { provider: LlmProvider; error?: string }[];
}

// Per-provider model override (the user's choice from the dynamic model
// selector); undefined → the provider's default model.
export interface ModelResolver {
  (provider: LlmProvider): string | undefined;
}

// Per-provider base URL — only meaningful for the "custom" provider, which has
// no fixed endpoint. undefined → not configured.
export interface BaseUrlResolver {
  (provider: LlmProvider): Promise<string | null>;
}

// Walk [active, ...fallback] in order, skipping providers with no key, until
// one succeeds. Throws with the full attempt log if all fail.
export async function llmGenerateWithFallback(
  chain: LlmProvider[],
  args: Omit<GenArgs, "apiKey">,
  resolveKey: FallbackKeyResolver,
  resolveModel?: ModelResolver,
  resolveBaseUrl?: BaseUrlResolver,
): Promise<FallbackOutcome> {
  const attempts: { provider: LlmProvider; error?: string }[] = [];
  const seen = new Set<LlmProvider>();

  for (const provider of chain) {
    if (seen.has(provider)) continue;
    seen.add(provider);

    const apiKey = await resolveKey(provider);
    if (!apiKey) {
      attempts.push({ provider, error: "no api key configured" });
      continue;
    }
    try {
      const model = args.model ?? resolveModel?.(provider);
      const baseUrl = args.baseUrl ??
        (provider === "custom" ? (await resolveBaseUrl?.(provider)) ?? undefined : undefined);
      const result = await llmGenerate(provider, { ...args, apiKey, model, baseUrl });
      return { ...result, attempts };
    } catch (e) {
      attempts.push({ provider, error: String(e instanceof Error ? e.message : e) });
    }
  }
  throw new Error(
    `all providers in fallback chain failed: ${JSON.stringify(attempts)}`,
  );
}

// Tolerant extraction of the JSON object from a model reply (handles ```json
// fences and leading/trailing prose that some providers emit).
export function extractJson<T = unknown>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model output");
  }
  return JSON.parse(t.slice(start, end + 1)) as T;
}
