import { ADAPTIVE_COACH_VOICE } from "../_shared/prompt.ts";
// coach-week-review — the coach's end-of-week recap for the dashboard. A short,
// human, coach-voice paragraph that interprets how the week went (adherence, load
// trend, the standout) and nudges into next week.
//
// POST { week_start?: "YYYY-MM-DD" } — defaults to the current week's Monday. The
// client requests this lazily and caches it per week_start, so at most one
// generation happens per week. Returns { review, week_start, provider }.
// Best-effort: any failure yields { review: null } and the card shows just its
// deterministic stats.

import { errorStatus, handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { llmAccess } from "../_shared/llm_keys.ts";
import { llmGenerateWithFallback } from "../_shared/llm.ts";
import { logLlmResult } from "../_shared/generation_log.ts";
import { buildWeekReviewPrompt, trainingPhase, WEEK_REVIEW_SYSTEM } from "../_shared/prompt.ts";
import { memoryDocsBlock, memoryFromProfile } from "../_shared/agent_memory.ts";
import { goalsText } from "../_shared/profile.ts";
import { goalRaceLine, pickGoalRace, upcomingGoals, weeksBetween } from "../_shared/context.ts";

const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void };
function waitUntil(p: Promise<unknown>) {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
  } catch { /* local dev runtime */ }
}

function mondayOf(d: string): string {
  const date = new Date(d + "T12:00:00");
  const dow = (date.getDay() + 6) % 7; // Mon=0..Sun=6
  date.setDate(date.getDate() - dow);
  return date.toISOString().slice(0, 10);
}

function sportOf(type: string | null | undefined): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("run")) return "run";
  if (t.includes("ride") || t.includes("bike") || t.includes("cycl")) return "ride";
  if (t.includes("swim")) return "swim";
  if (t.includes("strength") || t.includes("weight") || t.includes("lift")) return "strength";
  return "other";
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const admin = adminClient();
    const body = await req.json().catch(() => ({}));
    const qStart = new URL(req.url).searchParams.get("week_start");
    const reqStart = [body?.week_start, qStart].find((d) => typeof d === "string" && ISO_DATE.test(d)) as string | undefined;
    const weekStart = mondayOf(reqStart ?? new Date().toISOString().slice(0, 10));
    const startMs = new Date(weekStart + "T12:00:00").getTime();
    const weekEnd = new Date(startMs + 6 * DAY).toISOString().slice(0, 10);
    const prevStart = new Date(startMs - 7 * DAY).toISOString().slice(0, 10);

    const { data: profile } = await admin
      .from("user_profiles")
      .select("display_name, onboarding, active_llm_provider, llm_fallback_chain, coach_knowledge, training_memory, coach_soul, coach_soul_updated_at, llm_custom_input_per_1m, llm_custom_output_per_1m, plan, plan_expires_at, use_hosted_ai")
      .eq("id", userId)
      .single();
    const onboarding = (profile?.onboarding ?? {}) as Record<string, unknown>;
    const {data: holds}=await admin.from("training_holds").select("reason,sport,area").eq("user_id",userId).eq("active",true);

    const [{ data: activities }, { data: planned }, goalRows] = await Promise.all([
      admin.from("effective_activities").select("date, type, tss, planned_workout_id, link_source")
        .eq("user_id", userId).gte("date", prevStart).lte("date", weekEnd).order("date", { ascending: true }),
      admin.from("reconciled_session_plans").select("date, type, completed, skipped, reconciliation_status")
        .eq("user_id", userId).gte("date", weekStart).lte("date", weekEnd).neq("type", "rest"),
      // Anchored on the week being reviewed, so a recap of a past week counts
      // from that week rather than from today.
      upcomingGoals(admin, userId, weekStart),
    ]);

    const acts = activities ?? [];
    const thisWeek = acts.filter((a) => (a.date ?? "") >= weekStart);
    const prevWeek = acts.filter((a) => (a.date ?? "") < weekStart);
    const plan = planned ?? [];

    // No activity and nothing planned → no recap worth an LLM call.
    if (thisWeek.length === 0 && plan.length === 0) {
      return json({ review: null, week_start: weekStart });
    }

    const sumTss = (rows: { tss?: number | null }[]) => Math.round(rows.reduce((s, a) => s + (a.tss ?? 0), 0));
    const tss = sumTss(thisWeek);
    const prevTss = sumTss(prevWeek);
    const loadDeltaPct = prevTss > 0 ? Math.round(((tss - prevTss) / prevTss) * 100) : null;

    const bySportMap = new Map<string, number>();
    for (const a of thisWeek) bySportMap.set(sportOf(a.type), (bySportMap.get(sportOf(a.type)) ?? 0) + (a.tss ?? 0));
    const bySport = [...bySportMap.entries()].map(([sport, t]) => ({ sport, tss: Math.round(t) })).sort((a, b) => b.tss - a.tss);

    const standoutRow = thisWeek.reduce<{ date?: string; type?: string | null; tss?: number | null } | null>(
      (best, a) => (!best || (a.tss ?? 0) > (best.tss ?? 0) ? a : best),
      null,
    );
    const standout = standoutRow && (standoutRow.tss ?? 0) > 0
      ? { sport: sportOf(standoutRow.type), date: standoutRow.date ?? weekStart, tss: Math.round(standoutRow.tss ?? 0) }
      : null;

    const targetTss = (onboarding as { weekly_tss_target?: number }).weekly_tss_target ?? 350;
    const goalRace = pickGoalRace(goalRows, weekStart, onboarding.goal_date as string | undefined);
    const weeksToGoal = goalRace?.date ? weeksBetween(weekStart, goalRace.date) : null;

    const userPrompt = buildWeekReviewPrompt({
      name: (profile?.display_name as string) ?? "athlete",
      sessions: thisWeek.length,
      adherenceDone: plan.filter((p) => !p.skipped && (p.completed || ["completed_as_planned", "modified", "substituted"].includes(p.reconciliation_status))).length,
      adherencePlanned: plan.length,
      tss,
      targetTss,
      loadDeltaPct,
      bySport,
      standout,
      phase: trainingPhase(weeksToGoal),
      // This recap had no ATHLETE PROFILE block, so onboarding.goal was the only
      // goal it ever saw: after any set_goal_race that was a race name, and the
      // athlete's actual training goals never reached it at all.
      goal: goalsText(onboarding),
      goalRace: goalRaceLine(goalRace, weekStart),
    });
    const systemPrompt = WEEK_REVIEW_SYSTEM + "\n" + ADAPTIVE_COACH_VOICE + "\nCurrent planning holds: " + JSON.stringify(holds??[]) + memoryDocsBlock(memoryFromProfile(profile));

    const { chain, resolveKey, resolveModel, resolveBaseUrl, hosted } = await llmAccess(admin, userId, profile);
    if (chain.length === 0) return json({ review: null, week_start: weekStart });

    const outcome = await llmGenerateWithFallback(
      chain,
      { prompt: userPrompt, systemPrompt, jsonMode: false, hosted, feature: "week_review" },
      resolveKey,
      resolveModel,
      resolveBaseUrl,
    );
    // Dashes are already gone: llmGenerate is the enforcement point.
    const review = outcome.text.trim().replace(/^["']|["']$/g, "").slice(0, 600);

    waitUntil(logLlmResult(admin, userId, "week_review", hosted, outcome, profile));

    return json({ review, week_start: weekStart, provider: outcome.provider });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, errorStatus(e));
  }
});
