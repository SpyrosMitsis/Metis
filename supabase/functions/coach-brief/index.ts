import { sessionState } from "../_shared/session_context.ts";
import { ADAPTIVE_COACH_VOICE } from "../_shared/prompt.ts";
import { activityMatchesPlanned } from "../_shared/activity_matching.ts";
// coach-brief — the coach's proactive daily note for the dashboard. One short,
// human, coach-voice sentence-or-two that interprets today (readiness + Form +
// what's planned) so the coach speaks UNPROMPTED, not only inside chat.
//
// POST { date?: "YYYY-MM-DD" } — the client's LOCAL date (same convention as
// daily-summary). The client requests this lazily on Home open and caches the
// result per-day, so at most one generation happens per calendar day.
//
// Returns { brief, date, provider, disabled? }. Best-effort: any failure yields
// { brief: null } and Home falls back to its static readiness headline.

import { errorStatus, handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { llmAccess } from "../_shared/llm_keys.ts";
import { llmGenerateWithFallback } from "../_shared/llm.ts";
import { logLlmResult } from "../_shared/generation_log.ts";
import { computeRecovery } from "../_shared/recovery.ts";
import { BRIEF_SYSTEM, buildBriefPrompt, trainingPhase } from "../_shared/prompt.ts";
import { computeBodyTrend } from "../_shared/body_trend.ts";
import { memoryDocsBlock, memoryFromProfile } from "../_shared/agent_memory.ts";
import { goalsText, profileFactsBlock } from "../_shared/profile.ts";
import { applyFallbackFitness } from "../_shared/load.ts";
import {
  clipText,
  type DebriefEntry,
  fetchRecentDebriefs,
  goalRaceLine,
  pickGoalRace,
  upcomingGoals,
  weeksBetween,
} from "../_shared/context.ts";

const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void };
function waitUntil(p: Promise<unknown>) {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
  } catch { /* local dev runtime */ }
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const admin = adminClient();
    const body = await req.json().catch(() => ({}));
    const qDate = new URL(req.url).searchParams.get("date");
    const clientDate = [body?.date, qDate].find((d) => typeof d === "string" && ISO_DATE.test(d));
    const today = (clientDate as string | undefined) ?? new Date().toISOString().slice(0, 10);
    const yesterday = new Date(new Date(today + "T12:00:00Z").getTime() - DAY).toISOString().slice(0, 10);
    const since14 = new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10);
    const since7 = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);

    const { data: profile } = await admin
      .from("user_profiles")
      .select("display_name, onboarding, active_llm_provider, llm_fallback_chain, coach_knowledge, training_memory, coach_soul, coach_soul_updated_at, llm_custom_input_per_1m, llm_custom_output_per_1m, plan, plan_expires_at, use_hosted_ai")
      .eq("id", userId)
      .single();
    const onboarding = (profile?.onboarding ?? {}) as Record<string, unknown>;

    // Opt-out: the briefing toggle defaults ON; only `briefing === false` disables.
    if (onboarding.briefing === false) return json({ brief: null, date: today, disabled: true });

    const [{ data: wellness }, { data: activities }, { data: plannedRows }, debriefs, goalRows] = await Promise.all([
      admin.from("wellness_checkins").select("date, energy, soreness, sleep_score, hrv_rmssd, resting_hr, zepp_sleep_minutes")
        .eq("user_id", userId).gte("date", since14).order("date", { ascending: false }),
      admin.from("effective_activities").select("date, type, tss, ctl, atl, planned_workout_id, link_source")
        .eq("user_id", userId).gte("date", since14).order("date", { ascending: true }),
      admin.from("reconciled_session_plans").select("id, date, type, completed, skipped, reconciliation_status, workout_json, created_at")
        .eq("user_id", userId).gte("date", yesterday).lte("date", today),
      fetchRecentDebriefs(admin, userId, yesterday, 4),
      upcomingGoals(admin, userId, today),
    ]);
    const planned = (plannedRows ?? []).filter((p) => p.date === today);
    const plannedYesterday = (plannedRows ?? []).filter((p) => p.date === yesterday && p.type !== "rest");

    // No intervals-provided CTL in the window? Fill estimated values from
    // stored TSS so Form still reads for athletes without intervals.icu.
    const acts = await applyFallbackFitness(admin, userId, today, activities ?? []);
    const wells = wellness ?? [];
    const isNum = (v: unknown): v is number => typeof v === "number";

    // Readiness — same composite the dashboard shows, anchored on today so the
    // brief never narrates yesterday's HRV/sleep as if it were today's.
    const chrono = [...wells].reverse();
    const dated = (key: "hrv_rmssd" | "resting_hr") =>
      chrono.filter((w) => isNum((w as Record<string, unknown>)[key]))
        .map((w) => ({ date: (w as { date?: string }).date, value: (w as Record<string, number>)[key] }));
    const planningState=await sessionState(admin,userId,onboarding,today,"rest");
    if(planningState.readiness?.status==="pause")return json({brief:planningState.readiness.next_action,date:today,provider:"deterministic"});
    const recovery = computeRecovery(wells, dated("hrv_rmssd"), dated("resting_hr"), today);

    // Form (TSB) now + direction over the last week.
    const tsbSeries = acts.filter((a) => a.ctl != null && a.atl != null)
      .map((a) => ({ date: a.date as string, tsb: (a.ctl ?? 0) - (a.atl ?? 0) }));
    const tsbNow = tsbSeries.length ? tsbSeries[tsbSeries.length - 1].tsb : 0;
    const tsbPrev = tsbSeries.find((p) => p.date >= since7)?.tsb ?? tsbSeries[0]?.tsb ?? tsbNow;
    const tsbDelta = tsbNow - tsbPrev;
    const tsbTrend = tsbDelta > 3 ? "rising" : tsbDelta < -3 ? "falling" : "flat";

    // Today's primary session (same precedence as Home/Calendar).
    const primary = [...(planned ?? [])].sort((x, y) => {
      const xs = !!x.completed || !!x.skipped, ys = !!y.completed || !!y.skipped;
      if (xs !== ys) return xs ? 1 : -1;
      const xr = x.type === "rest" ? 1 : 0, yr = y.type === "rest" ? 1 : 0;
      if (xr !== yr) return xr - yr;
      return String(y.created_at ?? "").localeCompare(String(x.created_at ?? ""));
    })[0] ?? null;
    const todayPlan = primary
      ? `${(primary.workout_json as { title?: string })?.title ?? primary.type} (${primary.type})`
      : "nothing planned yet";

    // Weekly load vs target.
    const weeklyTss = acts.filter((a) => (a.date ?? "") >= since7).reduce((s, a) => s + (a.tss ?? 0), 0);
    const targetTss = (onboarding as { weekly_tss_target?: number }).weekly_tss_target ?? 350;
    const weeklyLoadPct = targetTss > 0 ? Math.round((weeklyTss / targetTss) * 100) : null;

    // goal_date is a pointer into `races`: resolve it to the row, so a stale
    // anchor cannot drive the phase and the countdown counts from a goal that
    // actually exists.
    const goalRace = pickGoalRace(goalRows, today, onboarding.goal_date as string | undefined);
    const weeksToGoal = goalRace?.date ? weeksBetween(today, goalRace.date) : null;

    // NOTHING MEASURED, NOTHING SAID. No check-in and no synced watch data means
    // the brief would be a paragraph of coach voice built on the placeholder
    // readiness, and it costs a real LLM call to write. Return empty and spend
    // nothing: Home shows "Readiness not measured" with the check-in card right
    // below it, and the moment either arrives (the athlete checks in, or the
    // watch syncs) the next Home open generates the day's brief for real.
    //
    // Deliberately NOT cached client-side: a null brief is never written to the
    // Room cache, so the retry after a check-in costs one cheap DB read here,
    // not a wasted generation.
    if (recovery.basis === "none") {
      return json({ brief: null, date: today, skipped: "no_readiness_data" });
    }

    // Did any objective recovery signal sync for today? If not, the brief should
    // go off subjective feel rather than stating recovery as fact.
    const objectiveData = recovery.hrv?.latest != null ||
      recovery.rhr?.latest != null || recovery.sleep?.hours != null;

    // Measured execution: how yesterday's (or today's) session actually went.
    // Coach-facing, so the label + the analyst's words only, never scores.
    const debriefStr = (e: DebriefEntry | undefined): string | null => {
      if (!e) return null;
      const note = e.feedback ? `"${clipText(e.feedback, 200)}"` : null;
      return e.label && note ? `${e.label}: ${note}` : e.label ?? note;
    };
    const yesterdayDebrief = debriefStr(debriefs.find((e) => e.date === yesterday));
    const todayDebrief = debriefStr(debriefs.find((e) => e.date === today));
    const looksLike = activityMatchesPlanned;
    const actsYesterday = acts.filter((a) => a.date === yesterday);
    const yesterdayExplicitlySkipped = !yesterdayDebrief && plannedYesterday.some((p) => p.skipped);

    // Body-composition trend: only worth a line in a 2-sentence note when the
    // athlete has a body goal AND there is a real slope. Best-effort, so a
    // pre-migration DB just skips it.
    let bodyTrendLine: string | null = null;
    try {
      const since90 = new Date(new Date(today + "T12:00:00Z").getTime() - 90 * DAY)
        .toISOString().slice(0, 10);
      const { data: bodyRows, error: bodyErr } = await admin.from("wellness_checkins")
        .select("date, weight_kg, body_fat_pct, lean_mass_kg")
        .eq("user_id", userId).gte("date", since90).lte("date", today).order("date", { ascending: true });
      if (!bodyErr && bodyRows) {
        const goals = ((onboarding.goals_by_sport as Record<string, string[]> | undefined)?.strength) ?? [];
        const bt = computeBodyTrend(bodyRows, goals, today);
        if (bt && bt.focus !== "general" && bt.onTrack !== null) bodyTrendLine = bt.summary;
      }
    } catch { /* columns not migrated yet */ }

    const userPrompt = buildBriefPrompt({
      name: (profile?.display_name as string) ?? "athlete",
      readiness: recovery.score,
      band: recovery.band,
      tsb: tsbNow,
      tsbTrend,
      todayPlan,
      todayDone: !!primary?.completed && !primary?.skipped || ["completed_as_planned", "modified", "substituted"].includes(primary?.reconciliation_status),
      phase: trainingPhase(weeksToGoal),
      // The training goal and the dated goal are two facts, from two places.
      goal: goalsText(onboarding),
      goalRace: goalRaceLine(goalRace, today),
      weeklyLoadPct,
      objectiveData,
      readinessBasis: recovery.basis,
      yesterdayDebrief,
      todayDebrief,
      yesterdayMissed: yesterdayExplicitlySkipped,
      bodyTrend: bodyTrendLine,
    });
    // Lead with the coach's soul/voice + durable knowledge so the note sounds
    // like a continuation of this relationship, not a generic tip.
    const systemPrompt = BRIEF_SYSTEM + "\n" + ADAPTIVE_COACH_VOICE + "\nCurrent planning context: " + JSON.stringify(planningState.readiness) +
      profileFactsBlock(onboarding, profile?.display_name as string | undefined) +
      memoryDocsBlock(memoryFromProfile(profile));

    const { chain, resolveKey, resolveModel, resolveBaseUrl, hosted } = await llmAccess(admin, userId, profile);
    if (chain.length === 0) return json({ brief: null, date: today });

    const outcome = await llmGenerateWithFallback(
      chain,
      { prompt: userPrompt, systemPrompt, jsonMode: false, hosted, feature: "brief" },
      resolveKey,
      resolveModel,
      resolveBaseUrl,
    );
    // Dashes are already gone: llmGenerate enforces the house rule for every
    // non-streaming feature. This function is why it moved there. Seen on
    // device, the Home readiness note read "today's full body strength session
    // — just keep the knee happy", because the scrub was hand-applied at three
    // call sites and this was not one of them.
    const brief = outcome.text.trim().replace(/^["']|["']$/g, "").slice(0, 400);

    waitUntil(logLlmResult(admin, userId, "brief", hosted, outcome, profile));

    return json({ brief, date: today, provider: outcome.provider });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, errorStatus(e));
  }
});
