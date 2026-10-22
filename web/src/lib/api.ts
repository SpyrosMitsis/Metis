"use client";

import { createClient } from "./supabase-browser";
import type {
  ActivityAnalysis,
  DailySummary,
  LlmProvider,
  StrengthAnalysis,
  Workout,
} from "@shared/types";

// Translate raw edge-function/provider errors into something a human can act
// on. Falls through to the raw message for anything unrecognized.
export function humanizeError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes("no ai provider configured") || m.includes("no llm key")) {
    return "No AI provider is set up yet. Add an API key in Settings → LLM.";
  }
  if (m.includes("all providers in fallback chain failed")) {
    return "All of your AI providers failed. Check your API keys in Settings → LLM (a key may be invalid or out of credit).";
  }
  if (m.includes("http 401") || m.includes("invalid api key") || m.includes("invalid x-api-key")) {
    return "An API key was rejected. Re-check it in Settings.";
  }
  if (m.includes("http 429") || m.includes("rate limit")) {
    return "The AI provider is rate-limiting you. Wait a minute and try again, or switch the active provider.";
  }
  if (m.includes("could not parse workout")) {
    return "The AI returned something unusable this time. Try generating again (this usually works on retry).";
  }
  if (m.includes("intervals") && (m.includes("403") || m.includes("401"))) {
    return "Intervals.icu rejected your credentials, re-connect it in Settings.";
  }
  if (m.includes("profile not found")) {
    return "Your profile isn't set up yet, finish onboarding first.";
  }
  if (m.includes("failed to fetch") || m.includes("network")) {
    return "Network problem, check your connection and try again.";
  }
  return raw;
}

// The browser's LOCAL calendar date (YYYY-MM-DD). new Date().toISOString() is
// UTC — for timezones ahead of UTC that's still *yesterday* until mid-morning,
// which made Home/strength show the wrong day's workout.
export function localDateIso(d: Date = new Date()): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

// Thin wrapper over supabase.functions.invoke that surfaces the JSON error
// bodies our Edge Functions return.
async function invoke<T>(name: string, body?: unknown): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(name, { body: body ?? {} });
  if (error) {
    // functions.invoke wraps non-2xx; try to read the JSON body for detail.
    const ctx = (error as unknown as { context?: Response }).context;
    let detail: string | null = null;
    if (ctx) {
      try {
        const parsed = await ctx.json();
        detail = String(parsed.error ?? parsed.detail ?? "") || null;
      } catch { /* non-JSON error body */ }
    }
    throw new Error(humanizeError(detail ?? error.message));
  }
  return data as T;
}

// Live Intervals.icu fitness dashboard (same source as the Android Home chart).
export interface IntervalsStats {
  connected: boolean;
  athlete_name?: string | null;
  summary?: { ctl: number; atl: number; tsb: number; ramp: number } | null;
  fitness: { date: string; ctl: number; atl: number; tsb: number }[];
  activities?: unknown[];
}

export const api = {
  // Send the browser's local date so "today's workout" matches the calendar
  // the athlete lives in, not the server's UTC clock.
  dailySummary: () => invoke<DailySummary>("daily-summary", { date: localDateIso() }),

  intervalsStats: () => invoke<IntervalsStats>("intervals-stats"),

  syncIntervals: () => invoke<{ activities_synced: number; ctl: number; atl: number; tsb: number }>("sync-intervals"),

  connectIntervals: (athleteId: string, apiKey: string) =>
    invoke<{ ok: boolean; athlete_name: string; athlete_id: string }>("connect-intervals", { athleteId, apiKey }),

  generateWorkout: (args: {
    date?: string;
    type?: "run" | "ride" | "swim" | "strength" | "auto";
    duration?: number;
    push?: boolean;
    request?: string; // free-text "Friday social 10k with friends"
    lock?: boolean; // pin it so re-planning won't touch it
    adjustment?: string; // tweak an existing workout ("shorter, I'm sore")
    base_workout?: Workout;
  }) =>
    invoke<{
      workout: Workout;
      workout_id: string;
      provider: LlmProvider;
      model: string;
      estimated_cost_usd: number;
      intervals_event_id: string | null;
      push_error: string | null;
    }>("generate-workout", { ...args, date: args.date ?? localDate(), request_id: crypto.randomUUID() }),

  planWeek: (startDate?: string) =>
    invoke<{ planned?: number; week?: unknown; error?: string }>("plan-week", { start_date: startDate ?? localDate(), today: localDate(), request_id: crypto.randomUUID() }),

  pushWorkout: (workout_id: string) =>
    invoke<{ ok: boolean; intervals_event_id: string }>("push-workout", { workout_id }),

  coachChat: (messages: { role: "user" | "assistant"; content: string }[], conversationId?: string | null) =>
    invoke<{ reply: string; conversation_id: string | null; provider: string; tools_used?: string[] }>(
      "coach-chat",
      { messages, mode: "chat", conversationId: conversationId ?? undefined, purpose: "plan" },
    ),

  moveWorkout: (workout_id: string, new_date: string) =>
    invoke<{ ok: boolean; event_moved: boolean }>("move-workout", { workout_id, new_date }),

  // Delete a planned workout (and its Intervals.icu/watch event) server-side.
  deletePlannedWorkout: (workout_id: string) =>
    invoke<{ ok: boolean }>("delete-workout", { workout_id }),

  testLlmKey: (provider: LlmProvider, apiKey: string, sampleGeneration = false) =>
    invoke<{
      provider: LlmProvider;
      model: string;
      is_valid: boolean;
      error: string | null;
      sample: string | null;
      estimated_cost_usd: number;
    }>("test-llm-key", { provider, apiKey, sampleGeneration }),

  // Live model list from the provider's API (used by the model override picker).
  listModels: (provider: LlmProvider) =>
    invoke<{ provider: string; default_model: string | null; current: string | null; models: string[]; error: string | null }>(
      "list-models",
      { provider },
    ),

  // Garmin-style execution analysis. peek=true only returns a cached result
  // (never triggers a fresh LLM run); force=true recomputes.
  analyzeActivity: (activityId: string, opts?: { force?: boolean; peek?: boolean }) =>
    invoke<ActivityAnalysis>("analyze-activity", { activity_id: activityId, ...opts }),

  analyzeStrength: (date: string, opts?: { force?: boolean; peek?: boolean }) =>
    invoke<StrengthAnalysis>("analyze-strength", { date, ...opts }),

  coachFinalize: (
    messages: { role: "user" | "assistant"; content: string }[],
    kind: "workout" | "plan",
    conversationId?: string | null,
  ) =>
    invoke<{ template: unknown; template_id: string | null }>("coach-chat", {
      messages, mode: "finalize", finalizeKind: kind,
      conversationId: conversationId ?? undefined, save: true,
    }),
};

// --- agentic coach streaming (SSE) -----------------------------------------
// Mirrors the Android client: POST with stream=true, then read `data:` lines
// carrying {tool}, {token}, {error} and a final {done, conversation_id,
// tools_used} event.
export interface CoachStreamResult {
  conversationId: string | null;
  toolsUsed: string[];
  error: string | null;
  gotReply: boolean;
}

export async function coachChatStream(
  messages: { role: "user" | "assistant"; content: string }[],
  conversationId: string | null,
  onTool: (name: string) => void,
  onToken: (text: string) => void,
): Promise<CoachStreamResult> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/coach-chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    },
    body: JSON.stringify({
      messages, mode: "chat", conversationId: conversationId ?? undefined,
      purpose: "setup", stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(humanizeError(`HTTP ${res.status}`));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const out: CoachStreamResult = { conversationId: null, toolsUsed: [], error: null, gotReply: false };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(data); } catch { continue; }
      if (typeof obj.tool === "string") onTool(obj.tool);
      if (typeof obj.token === "string") { out.gotReply = true; onToken(obj.token); }
      if (typeof obj.error === "string") out.error = humanizeError(obj.error);
      if (obj.done) {
        out.conversationId = (obj.conversation_id as string | null) ?? null;
        out.toolsUsed = Array.isArray(obj.tools_used) ? (obj.tools_used as string[]) : [];
      }
    }
  }
  return out;
}

function localDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
