import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  deepseekBodyExtras,
  extractJson,
  llmGenerateWithFallback,
  maxTokensOf,
  OUTPUT_BUDGETS,
  PROVIDERS,
} from "./llm.ts";
import type { LlmProvider } from "./types.ts";

// ---------------------------------------------------------------------------
// DeepSeek V4 thinking mode
//
// THE REGRESSION TEST. Verified against the live API on 2026-07-26: a plain
// deepseek-v4-flash call with max_tokens 20 came back content "" /
// finish_reason "length", the whole budget spent on reasoning_content. Every
// JSON-producing feature (workout, plan) would return empty or truncated JSON.
// If this assertion ever fails, that is what breaks.
// ---------------------------------------------------------------------------

Deno.test("deepseek v4 requests disable thinking", () => {
  assertEquals(deepseekBodyExtras("deepseek", "deepseek-v4-flash"), {
    thinking: { type: "disabled" },
  });
  assertEquals(deepseekBodyExtras("deepseek", "deepseek-v4-pro"), {
    thinking: { type: "disabled" },
  });
});

Deno.test("the thinking flag is deepseek-only and v4-only", () => {
  // Sending an unknown body key to another vendor's endpoint can 400.
  assertEquals(deepseekBodyExtras("openai", "gpt-5-mini"), {});
  assertEquals(deepseekBodyExtras("groq", "llama-3.3-70b-versatile"), {});
  assertEquals(deepseekBodyExtras("openrouter", "deepseek/deepseek-v4-flash"), { reasoning: { enabled: false } });
  // A user override back to a pre-V4 id must not carry the V4-only field.
  assertEquals(deepseekBodyExtras("deepseek", "deepseek-chat"), {});
});

Deno.test("the deepseek default model is a V4 id, so the flag applies to it", () => {
  const model = PROVIDERS.deepseek.model;
  assert(/^deepseek-v4/.test(model), `expected a v4 id, got ${model}`);
  assertEquals(deepseekBodyExtras("deepseek", model), { thinking: { type: "disabled" } });
});

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

Deno.test("extractJson: plain object", () => {
  assertEquals(extractJson(`{"a":1}`), { a: 1 });
});

Deno.test("extractJson: ```json fence", () => {
  assertEquals(extractJson("```json\n{\"a\":1}\n```"), { a: 1 });
});

Deno.test("extractJson: bare ``` fence", () => {
  assertEquals(extractJson("```\n{\"a\":1}\n```"), { a: 1 });
});

Deno.test("extractJson: leading/trailing prose", () => {
  assertEquals(extractJson(`Sure! Here is your workout:\n{"a":{"b":2}}\nEnjoy!`), { a: { b: 2 } });
});

Deno.test("extractJson: no JSON throws", () => {
  let threw = false;
  try { extractJson("no json here"); } catch { threw = true; }
  assert(threw);
});

// ---------------------------------------------------------------------------
// llmGenerateWithFallback — stub fetch so no network is touched.
// ---------------------------------------------------------------------------

function openAiResponse(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function withFetchStub<T>(stub: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: URL | Request | string) =>
    Promise.resolve(stub(String(input instanceof Request ? input.url : input)))) as typeof fetch;
  return fn().finally(() => { globalThis.fetch = orig; });
}

Deno.test("fallback: skips providers without keys, succeeds on the first keyed one", async () => {
  const keys: Record<string, string | null> = { groq: null, openai: "sk-test" };
  const out = await withFetchStub(
    () => openAiResponse("hello"),
    () => llmGenerateWithFallback(
      ["groq", "openai"] as LlmProvider[],
      { prompt: "hi", systemPrompt: "sys" },
      (p) => Promise.resolve(keys[p] ?? null),
    ),
  );
  assertEquals(out.provider, "openai");
  assertEquals(out.text, "hello");
  assertEquals(out.attempts, [{ provider: "groq", error: "no api key configured" }]);
});

Deno.test("fallback: walks past an HTTP failure to the next provider", async () => {
  const out = await withFetchStub(
    (url) => url.includes("api.groq.com")
      ? new Response("rate limited", { status: 429 })
      : openAiResponse("from openai"),
    () => llmGenerateWithFallback(
      ["groq", "openai"] as LlmProvider[],
      { prompt: "hi", systemPrompt: "sys" },
      () => Promise.resolve("sk-test"),
    ),
  );
  assertEquals(out.provider, "openai");
  assertEquals(out.attempts.length, 1);
  assert(out.attempts[0].error!.includes("429"));
});

Deno.test("fallback: de-duplicates repeated providers in the chain", async () => {
  let calls = 0;
  await assertRejects(() =>
    withFetchStub(
      () => { calls++; return new Response("boom", { status: 500 }); },
      () => llmGenerateWithFallback(
        ["openai", "openai", "openai"] as LlmProvider[],
        { prompt: "hi", systemPrompt: "sys" },
        () => Promise.resolve("sk-test"),
      ),
    ));
  assertEquals(calls, 1);
});

Deno.test("fallback: all fail → throws with the attempt log", async () => {
  const err = await assertRejects(() =>
    llmGenerateWithFallback(
      ["groq", "gemini"] as LlmProvider[],
      { prompt: "hi", systemPrompt: "sys" },
      () => Promise.resolve(null),
    ));
  assert(String(err).includes("no api key configured"));
});

Deno.test("anthropic: jsonSchema forces a tool call and extracts its input as JSON text", async () => {
  let seenBody: Record<string, unknown> = {};
  const out = await withFetchStub(
    () => {
      return new Response(JSON.stringify({
        content: [{ type: "tool_use", name: "emit_workout", input: { type: "run", title: "Easy 5k" } }],
        usage: { input_tokens: 20, output_tokens: 8 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    () => llmGenerateWithFallback(
      ["anthropic"] as LlmProvider[],
      {
        prompt: "hi",
        systemPrompt: "sys",
        jsonSchema: { name: "emit_workout", schema: { type: "object", properties: {} } },
      },
      () => Promise.resolve("sk-ant-test"),
    ),
  );
  assertEquals(out.provider, "anthropic");
  assertEquals(JSON.parse(out.text), { type: "run", title: "Easy 5k" });

  // Confirm the request itself carried the forced tool choice.
  const orig = globalThis.fetch;
  globalThis.fetch = ((_input: URL | Request | string, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "emit_workout", input: {} }],
      usage: {},
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;
  try {
    await llmGenerateWithFallback(
      ["anthropic"] as LlmProvider[],
      { prompt: "hi", systemPrompt: "sys", jsonSchema: { name: "emit_workout", schema: { type: "object" } } },
      () => Promise.resolve("sk-ant-test"),
    );
  } finally {
    globalThis.fetch = orig;
  }
  assertEquals(seenBody.tool_choice, { type: "tool", name: "emit_workout" });
  assertEquals((seenBody.tools as { name: string }[])[0].name, "emit_workout");
});

Deno.test("anthropic: without jsonSchema, falls back to plain text content blocks", async () => {
  const out = await withFetchStub(
    () =>
      new Response(JSON.stringify({
        content: [{ type: "text", text: "hello from claude" }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    () => llmGenerateWithFallback(
      ["anthropic"] as LlmProvider[],
      { prompt: "hi", systemPrompt: "sys" },
      () => Promise.resolve("sk-ant-test"),
    ),
  );
  assertEquals(out.text, "hello from claude");
});

Deno.test("openrouter: routes to its endpoint with attribution headers", async () => {
  let seenUrl = "";
  let seenHeaders: Headers | undefined;
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: URL | Request | string, init?: RequestInit) => {
    seenUrl = String(input instanceof Request ? input.url : input);
    seenHeaders = new Headers(init?.headers);
    return Promise.resolve(openAiResponse("hi from openrouter"));
  }) as typeof fetch;
  try {
    const out = await llmGenerateWithFallback(
      ["openrouter"] as LlmProvider[],
      { prompt: "hi", systemPrompt: "sys" },
      () => Promise.resolve("sk-or-test"),
    );
    assertEquals(out.provider, "openrouter");
    assertEquals(out.model, "openrouter/auto");
    assert(seenUrl.startsWith("https://openrouter.ai/api/v1/chat/completions"));
    assertEquals(seenHeaders?.get("X-Title"), "Workout Maker");
    assert(!!seenHeaders?.get("HTTP-Referer"));
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------------------------------------------------------------------------
// maxTokensOf — the cost-safety invariant
//
// Output tokens are the expensive half of the bill and hosted calls spend the
// OPERATOR's money, so quota.ts prices its caps against these budgets. These
// tests are what stop the table and its clamps from silently rotting.
// ---------------------------------------------------------------------------

// Both knobs are read per call, so each test owns its own env.
function withEnv(vars: Record<string, string | null>, run: () => void) {
  const prev = new Map<string, string | undefined>();
  for (const k of Object.keys(vars)) prev.set(k, Deno.env.get(k));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    run();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const noEnv = { WM_MAX_OUTPUT_TOKENS: null, WM_HOSTED_MAX_OUTPUT_TOKENS: null };

Deno.test("maxTokensOf: a call naming no feature gets the default", () => {
  withEnv(noEnv, () => {
    assertEquals(maxTokensOf({}), 2500);
    assertEquals(maxTokensOf({ hosted: true }), 2500);
    assertEquals(maxTokensOf({ feature: "not-a-feature" }), 2500);
  });
});

Deno.test("maxTokensOf: each feature gets its own budget", () => {
  withEnv(noEnv, () => {
    for (const [feature, budget] of Object.entries(OUTPUT_BUDGETS)) {
      assertEquals(maxTokensOf({ feature }), budget, `${feature} budget`);
      assertEquals(maxTokensOf({ feature, hosted: true }), budget, `${feature} hosted budget`);
    }
  });
});

Deno.test("maxTokensOf: a week plan gets room for a week plan", () => {
  // THE REGRESSION TEST. A real deepseek week plan truncated mid-JSON at 2,482
  // output tokens (measured: eval_runs/2026-07-15T15-56-58-385Z, week/peak-4wk,
  // ended inside `"notes": "Chest`). plan-week then retried into the same wall.
  // If this number ever drops back under that, week planning breaks again.
  const TRUNCATED_AT = 2482;
  withEnv(noEnv, () => {
    const budget = maxTokensOf({ feature: "plan" });
    assert(
      budget > TRUNCATED_AT * 1.5,
      `plan budget ${budget} leaves no headroom over the ${TRUNCATED_AT} that truncated`,
    );
  });
});

Deno.test("maxTokensOf: chat stays tight, because chat is the cost driver", () => {
  // A turn can make MAX_LLM_CALLS_PER_TURN (12) of these; plan makes 1-2. The
  // budgets must reflect that asymmetry or the daily cap math is wrong.
  withEnv(noEnv, () => {
    assert(maxTokensOf({ feature: "chat" }) <= 2500);
    assert(maxTokensOf({ feature: "plan" }) > maxTokensOf({ feature: "chat" }));
    assert(maxTokensOf({ feature: "brief" }) < maxTokensOf({ feature: "chat" }));
  });
});

Deno.test("maxTokensOf: an explicit maxTokens overrides the feature budget", () => {
  withEnv(noEnv, () => {
    assertEquals(maxTokensOf({ feature: "plan", maxTokens: 400 }), 400);
    assertEquals(maxTokensOf({ maxTokens: 400, hosted: true }), 400);
  });
});

Deno.test("maxTokensOf: nothing may exceed the absolute bound", () => {
  // Not a caller, not the env, not both together.
  withEnv({ WM_MAX_OUTPUT_TOKENS: "999999", WM_HOSTED_MAX_OUTPUT_TOKENS: "999999" }, () => {
    assertEquals(maxTokensOf({ maxTokens: 999_999 }), 8000);
    assertEquals(maxTokensOf({ maxTokens: 999_999, hosted: true }), 8000);
  });
});

Deno.test("maxTokensOf: WM_HOSTED_MAX_OUTPUT_TOKENS pulls hosted spend down", () => {
  // The operator's emergency brake on their OWN money: it must beat the feature
  // budget, including for the biggest feature.
  withEnv({ WM_MAX_OUTPUT_TOKENS: null, WM_HOSTED_MAX_OUTPUT_TOKENS: "1000" }, () => {
    assertEquals(maxTokensOf({ feature: "plan", hosted: true }), 1000);
    assertEquals(maxTokensOf({ feature: "chat", hosted: true }), 1000);
    // BYO is the user's own key and own bill, so the hosted brake must not touch it.
    assertEquals(maxTokensOf({ feature: "plan" }), OUTPUT_BUDGETS.plan);
  });
});

Deno.test("maxTokensOf: WM_MAX_OUTPUT_TOKENS pulls BYO down without touching hosted", () => {
  withEnv({ WM_MAX_OUTPUT_TOKENS: "800", WM_HOSTED_MAX_OUTPUT_TOKENS: null }, () => {
    assertEquals(maxTokensOf({ feature: "plan" }), 800);
    assertEquals(maxTokensOf({ feature: "plan", hosted: true }), OUTPUT_BUDGETS.plan);
  });
});

Deno.test("maxTokensOf: junk env falls back rather than zeroing the budget", () => {
  // A NaN ceiling that clamped to 0 would make every call emit nothing.
  withEnv({ WM_MAX_OUTPUT_TOKENS: "not-a-number", WM_HOSTED_MAX_OUTPUT_TOKENS: "-5" }, () => {
    assertEquals(maxTokensOf({ feature: "plan" }), OUTPUT_BUDGETS.plan);
    assertEquals(maxTokensOf({ feature: "plan", hosted: true }), OUTPUT_BUDGETS.plan);
    assert(maxTokensOf({}) > 0);
  });
});

Deno.test("maxTokensOf: every budget is sane", () => {
  for (const [feature, budget] of Object.entries(OUTPUT_BUDGETS)) {
    assert(Number.isInteger(budget) && budget > 0, `${feature} budget is not a positive integer`);
    assert(budget <= 8000, `${feature} budget exceeds the absolute bound`);
  }
});
