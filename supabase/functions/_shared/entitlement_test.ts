import { assertEquals } from "jsr:@std/assert@1";
import { PROFILE_COLUMNS_GENERATION } from "./supabase.ts";
import { hostedLlm, isPro, wantsHostedAi } from "./entitlement.ts";

const HOSTED_VARS = ["HOSTED_LLM_PROVIDER", "HOSTED_LLM_KEY", "HOSTED_LLM_MODEL", "HOSTED_AI_DISABLED"];

function withEnv(vars: Record<string, string>, fn: () => void) {
  const prev = new Map(HOSTED_VARS.map((k) => [k, Deno.env.get(k)]));
  try {
    for (const k of HOSTED_VARS) Deno.env.delete(k);
    for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
    fn();
  } finally {
    for (const [k, v] of prev) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

Deno.test("hostedLlm: unset env → null (self-hosted default)", () => {
  withEnv({}, () => assertEquals(hostedLlm(), null));
});

Deno.test("hostedLlm: provider+key configured → hosted config", () => {
  withEnv({ HOSTED_LLM_PROVIDER: "anthropic", HOSTED_LLM_KEY: "sk-x", HOSTED_LLM_MODEL: "claude-opus-4-8" }, () => {
    assertEquals(hostedLlm(), { provider: "anthropic", key: "sk-x", model: "claude-opus-4-8" });
  });
});

Deno.test("hostedLlm: blank model → undefined (provider default)", () => {
  withEnv({ HOSTED_LLM_PROVIDER: "groq", HOSTED_LLM_KEY: "k", HOSTED_LLM_MODEL: "  " }, () => {
    assertEquals(hostedLlm()?.model, undefined);
  });
});

Deno.test("hostedLlm: kill switch wins", () => {
  withEnv({ HOSTED_LLM_PROVIDER: "anthropic", HOSTED_LLM_KEY: "k", HOSTED_AI_DISABLED: "1" }, () => {
    assertEquals(hostedLlm(), null);
  });
});

Deno.test("hostedLlm: unknown or custom provider → null", () => {
  withEnv({ HOSTED_LLM_PROVIDER: "definitely-not-real", HOSTED_LLM_KEY: "k" }, () => {
    assertEquals(hostedLlm(), null);
  });
  withEnv({ HOSTED_LLM_PROVIDER: "custom", HOSTED_LLM_KEY: "k" }, () => {
    assertEquals(hostedLlm(), null);
  });
});

Deno.test("isPro: plan gate + expiry belt-and-braces", () => {
  assertEquals(isPro(null), false);
  assertEquals(isPro({ plan: "free" }), false);
  assertEquals(isPro({ plan: "pro" }), true); // no expiry recorded → trust the column
  assertEquals(isPro({ plan: "pro", plan_expires_at: new Date(Date.now() + 60_000).toISOString() }), true);
  assertEquals(isPro({ plan: "pro", plan_expires_at: new Date(Date.now() - 60_000).toISOString() }), false);
});

Deno.test("wantsHostedAi: needs pro + toggle (default on) + deployment config", () => {
  const pro = { plan: "pro" };
  withEnv({}, () => assertEquals(wantsHostedAi(pro), false)); // unconfigured stack
  withEnv({ HOSTED_LLM_PROVIDER: "groq", HOSTED_LLM_KEY: "k" }, () => {
    assertEquals(wantsHostedAi(pro), true);
    assertEquals(wantsHostedAi({ ...pro, use_hosted_ai: false }), false); // BYO opt-out
    assertEquals(wantsHostedAi({ plan: "free" }), false);
  });
});

Deno.test("generation profile projection preserves hosted access, opt-out and expiry", () => {
  withEnv({ HOSTED_LLM_PROVIDER: "groq", HOSTED_LLM_KEY: "fixture" }, () => {
    const project = (row: Record<string, unknown>) => Object.fromEntries(PROFILE_COLUMNS_GENERATION.split(",").map(k => k.trim()).map(k => [k,row[k]]));
    assertEquals(wantsHostedAi(project({plan:"pro",use_hosted_ai:true})), true);
    assertEquals(wantsHostedAi(project({plan:"pro",use_hosted_ai:false})), false);
    assertEquals(wantsHostedAi(project({plan:"pro",use_hosted_ai:true,plan_expires_at:"2000-01-01T00:00:00Z"})), false);
  });
});
