import { assertPublishable, isoDate, planRevision, replacePlan, requestId, reviewGeneratedWorkout } from "../_shared/plan_store.ts";
import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
// plan-week — the mature planner: generate a coherent, periodized 7-day
// microcycle in one shot (80/20 distribution, recovery spacing, weekly volume
// target, deload when fatigued), persist it idempotently to planned_workouts,
// store the rationale, and optionally push every session to Intervals.icu.
//
// Two modes:
//   - Client (user JWT): POST { start_date?, push? } → plan that user's week.
//   - Cron (service_role): POST { all_users: true } → plan NEXT week for every
//     user with user_profiles.auto_plan = true.

import { errorStatus, handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId, PROFILE_COLUMNS_GENERATION, type ProfileRow } from "../_shared/supabase.ts";
import { llmAccess } from "../_shared/llm_keys.ts";
import { customPriceFromProfile, estimateCostUsd, extractJson, llmGenerateWithFallback } from "../_shared/llm.ts";
import { logGeneration, logLlmResult } from "../_shared/generation_log.ts";
import { availabilityTssCeiling, DELOAD_AFTER_WEEKS, plannedWeeklyTarget } from "../_shared/plan_checks.ts";
import { defaultHrZones } from "../_shared/zones.ts";
import {
  buildWeekPrompt,
  trainingPhase,
  validateWeekPlan,
  WEEK_SYSTEM_PROMPT,
  WEEK_TOOL_SCHEMA,
} from "../_shared/prompt.ts";
import { createEvent, deleteEvent, latestFitness } from "../_shared/intervals.ts";
import { applyFallbackFitness } from "../_shared/load.ts";
import { renderIntervalsWorkout } from "../_shared/intervals_workout.ts";
import {
  adherenceBlock,
  calendarBlock,
  executionBlock,
  goalBlock,
  intervalsPhysiology,
  pickGoalRace,
  racesBlock,
  upcomingGoals,
  weeksBetween,
} from "../_shared/context.ts";
import {
  availabilityBlock,
  challengeBlock,
  experienceBlock,
  goalsText,
  injuriesOf,
  profileFactsBlock,
  splitBlock,
  sportsBlock,
  weeklyAvailableMinutes,
} from "../_shared/profile.ts";
import { memoryDocsBlock, memoryFromProfile } from "../_shared/agent_memory.ts";
import { exerciseCatalogBlock } from "../_shared/exercise_catalog.ts";
import { isHardSession, type MainLift, muscleOf, reviewWorkout } from "../_shared/workout_review.ts";
import { coerceForPause, computeDayList, computePeriodization, weekdayOf } from "../_shared/week_planning.ts";
import {
  activeBackoffs,
  backoffBlock,
  type EnduranceSport,
  sportsToAvoid,
} from "../_shared/injury.ts";
import type { LlmProvider, Workout } from "../_shared/types.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function nextMonday(): string {
  const today = new Date().toISOString().slice(0, 10);
  let d = (8 - new Date(today + "T12:00:00").getDay()) % 7;
  if (d === 0) d = 7; // always the upcoming Monday, never today
  return addDays(today, d);
}

const safeJson = (text: string): unknown => {
  try { return extractJson(text); } catch { return null; }
};

async function planForUser(admin: SupabaseClient, userId: string, start: string, shouldPush: boolean, calendarBusy: unknown = null, generationId: string = crypto.randomUUID(), localToday?: string) {
  isoDate(start);
  const revision = await planRevision(admin, userId);
  const allDates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = allDates[6];
  // Never touch days that have already happened: re-planning mid-week only
  // rebuilds today onward. The earlier days stay as the record of what was
  // planned (and the actuals feed the prompt via the adherence block).
  const today = isoDate(localToday ?? start);
  const dates = allDates.filter((d) => d >= today);
  if (dates.length === 0) throw new Error("that week is already over, nothing left to plan");
  const planFrom = dates[0];

  const { data: profileRow } = await admin.from("user_profiles").select(PROFILE_COLUMNS_GENERATION).eq("id", userId).single();
  const profile = profileRow as ProfileRow | null;
  if (!profile) throw new Error("profile not found");
  const onboarding = profile.onboarding ?? {};

  const since28 = new Date(Date.now() - 28 * DAY).toISOString().slice(0, 10);
  const since14 = new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10);
  const since7 = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
  const { data: activities } = await admin
    .from("effective_activities")
    .select("type, date, distance_m, tss, ctl, atl, planned_workout_id, link_source")
    .eq("user_id", userId).gte("date", since28).order("date", { ascending: false });
  // No intervals-provided CTL in the window? Fill estimated values from
  // stored TSS so fitness/goal context still works without intervals.icu.
  const acts28 = await applyFallbackFitness(admin, userId, today, activities ?? []);
  const acts14 = acts28.filter((a) => (a.date ?? "") >= since14);
  const runs = acts14.filter((a) => (a.type ?? "").toLowerCase().includes("run"));

  const load7 = acts28.filter((a) => (a.date ?? "") >= since7).reduce((s, a) => s + (a.tss ?? 0), 0);
  const load28 = acts28.reduce((s, a) => s + (a.tss ?? 0), 0);
  const acwr = load28 > 0 ? load7 / (load28 / 4) : null;

  const fitnessRow = acts14.find((a) => a.ctl != null) ?? { ctl: 0, atl: 0 };
  const fitness = latestFitness([{ id: start, ctl: fitnessRow.ctl ?? 0, atl: fitnessRow.atl ?? 0 }]);

  const { data: wellness } = await admin
    .from("wellness_checkins").select("date, energy, soreness, sleep_score")
    .eq("user_id", userId).gte("date", since7).order("date", { ascending: false });
  const wells = wellness ?? [];
  const isNum = (v: unknown): v is number => typeof v === "number";
  const avg = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 3;
  const wellness3d = {
    energy: avg(wells.slice(0, 3).map((w) => w.energy ?? 3)),
    soreness: avg(wells.slice(0, 3).map((w) => w.soreness ?? 3)),
    sleep: avg(wells.slice(0, 3).map((w) => isNum(w.sleep_score) ? w.sleep_score / 20 : 3)),
  };

  // The anchor is a pointer into `races`, resolved to the row so a stale date
  // cannot flatten (or taper) a week around a goal that no longer exists.
  const goalRace = pickGoalRace(await upcomingGoals(admin, userId, start), start, onboarding.goal_date as string | undefined);
  const weeksToGoal = goalRace?.date ? weeksBetween(start, goalRace.date) : null;
  const phase = trainingPhase(weeksToGoal);

  const weeklyKm = runs.filter((r) => (r.date ?? "") >= since7).reduce((s, r) => s + (r.distance_m ?? 0) / 1000, 0);
  const weeklyTssTarget = (onboarding as { weekly_tss_target?: number }).weekly_tss_target ?? 350;
  const availableDays: string[] = Array.isArray(onboarding.days) ? onboarding.days : [];

  const phys = await intervalsPhysiology(admin, profile, onboarding, { userId, today: start });
  // Measured zones win; otherwise per-athlete defaults from LTHR/age (zones.ts).
  const hrZones = phys.hrZones ?? onboarding.hr_zones ?? defaultHrZones(onboarding);

  // Athlete-locked fixed sessions in this week (social runs, gym with a friend…).
  // The planner must work around them, not over them.
  const { data: lockedRows } = await admin
    .from("planned_workouts").select("date, type, workout_json")
    .eq("user_id", userId).gte("date", planFrom).lte("date", end).or("locked.eq.true,completed.eq.true,skipped.eq.true");
  const lockedByDate = new Map((lockedRows ?? []).map((r) => [r.date as string, r]));
  const lockedBlock = lockedByDate.size === 0 ? "" :
    `\n\nFIXED SESSIONS, the athlete has LOCKED these days; DO NOT schedule anything on them. Plan the rest of the week AROUND them (respect easy/recovery before and after a hard fixed session):\n` +
    [...lockedByDate.entries()].map(([d, r]) =>
      `- ${d} (${weekdayOf(d)}): ${(r.workout_json as Workout)?.title ?? r.type} [${r.type}]`).join("\n");

  // Athlete's modalities + strength split → constrain and shape the week.
  const declaredSports: string[] = Array.isArray(onboarding.sports) ? onboarding.sports as string[] : [];
  const splitStyle = (onboarding.split_style as string | undefined) ?? "";

  // INJURY BACKOFF, given the same structural authority as the training pause
  // below. sportsBlock already tells the model "ONLY schedule these modalities",
  // and that instruction is honored — so the cheapest way to stop a week full of
  // runs on a torn Achilles is to REMOVE running from the list it is handed,
  // rather than adding a paragraph asking it not to. Same lesson as
  // training_paused_until: a fact that has to beat specific dates needs to feed
  // a structured input, not compete with one as prose (agent_memory.ts).
  //
  // Only "avoid" removes a sport ("ease" means train it lighter), and only when
  // something is left to schedule: an athlete who does nothing but run gets a
  // heavily-caveated running week rather than an empty one, which is a
  // conversation for the coach, not a silently blank calendar.
  //
  // The list is a WEEK-level input, so a sport is only removed when the backoff
  // covers the whole window (still active on `end`). A backoff that lapses on
  // Wednesday must not cost the athlete Saturday's long run: for those, the
  // block below names the exact end date, and the per-DATE review inside the
  // scheduling loop is the thing with day-level authority, exactly as
  // computeDayList is for the pause.
  const backoffs = activeBackoffs(profile.injury_backoff, start);
  const avoidedAllWeek = sportsToAvoid(activeBackoffs(profile.injury_backoff, end));
  const survivors = declaredSports.filter((s) => !avoidedAllWeek.has(s as EnduranceSport));
  const sportsList = declaredSports.length > 0 && survivors.length > 0 ? survivors : declaredSports;

  // The most load the athlete's declared day budgets can hold; clamps both the
  // weekly target below and the periodization ramp target, so no part of the
  // prompt can ask for more than the availability the same prompt hands out.
  const availCeiling = availabilityTssCeiling(weeklyAvailableMinutes(onboarding));

  // Opt-in periodization: track build weeks via week_plans.focus history and
  // schedule an automatic deload. Off → no block, exactly today's behavior.
  let periodizationBlock = "";
  let deloadDue = false;
  if (onboarding.periodized === true) {
    const { data: recentWeeks } = await admin
      .from("week_plans").select("start_date, focus")
      .eq("user_id", userId).lt("start_date", start)
      .order("start_date", { ascending: false }).limit(6);
    const lastWeekStart = addDays(start, -7);
    const lastWeekTss = Math.round(
      acts28.filter((a) => (a.date ?? "") >= lastWeekStart && (a.date ?? "") < start)
        .reduce((s, a) => s + (a.tss ?? 0), 0),
    );
    const periodization = computePeriodization(
      (recentWeeks ?? []).map((w) => (w.focus ?? "") as string),
      lastWeekTss, availCeiling, weeklyTssTarget, DELOAD_AFTER_WEEKS,
    );
    deloadDue = periodization.deloadDue;
    periodizationBlock = periodization.block;
  }

  // The athlete's weekly_tss_target is a BASE for a normal build week. Two
  // reconciliations before it becomes the number the prompt asks for, so the
  // prompt never demands two incompatible things at once:
  //  1. availability: the target can't exceed what the athlete's own day
  //     budgets can hold at a properly polarized mix (availabilityTssCeiling);
  //  2. phase: a taper/deload week is a lower target, not a broken one.
  const reachableTarget = availCeiling !== null ? Math.min(weeklyTssTarget, availCeiling) : weeklyTssTarget;
  const phaseTssTarget = plannedWeeklyTarget(reachableTarget, phase, deloadDue);

  const contextBlocks =
    profileFactsBlock(onboarding, profile.display_name as string | undefined) +
    memoryDocsBlock(memoryFromProfile(profile)) + phys.block +
    await adherenceBlock(admin, userId, since14, start, acts28) +
    await executionBlock(admin, userId, since14) +
    goalBlock(goalRace?.date ?? null, weeksToGoal, phase, acts28) +
    // The week is where a B/C tune-up actually lands, so the planner has to
    // know it exists: it gets easy days in front of it and no taper.
    await racesBlock(admin, userId, start) + lockedBlock +
    calendarBlock(calendarBusy) +
    sportsBlock(sportsList) + splitBlock(splitStyle) + periodizationBlock +
    availabilityBlock(onboarding) + experienceBlock(onboarding) + challengeBlock(onboarding) +
    backoffBlock(backoffs) +
    await exerciseCatalogBlock(admin, userId);

  // An active training pause (set via the coach-chat set_training_pause tool)
  // gets the SAME structural authority as locked days / weekday-recurring
  // availability below — it feeds the `available` flag that the prompt
  // already treats as authoritative, instead of relying on the model to
  // resolve a free-text coach_knowledge note against a concrete date list.
  const pausedUntil = (profile.training_paused_until as string | null) ?? null;
  const pauseReason = (profile.training_pause_reason as string | null) ?? null;
  const dayList = computeDayList(dates, availableDays, new Set(lockedByDate.keys()), pausedUntil);

  const userPrompt = buildWeekPrompt({
    startDate: start, dayList,
    goal: goalsText(onboarding),
    experience: onboarding.experience ?? "Intermediate",
    phase, tsb: fitness.tsb, ctl: fitness.ctl, atl: fitness.atl, acwr,
    wellness3d, weeklyKm, weeklyTssTarget: phaseTssTarget, hrZones, contextBlocks,
  });

  const { chain, resolveKey, resolveModel, resolveBaseUrl, hosted } = await llmAccess(admin, userId, profile);
  if (chain.length === 0) throw new Error("No AI provider configured");

  // Failures are logged to generation_logs (like generate-workout does) so a
  // "re-plan failed" in the app is diagnosable from the logs table.
  const logFailure = (provider: string | null, raw: string | null, error: string) =>
    logGeneration(admin, userId, {
      feature: "plan", hosted, provider, systemPrompt: WEEK_SYSTEM_PROMPT,
      userPrompt, rawResponse: raw, parsedOk: false, error,
    });

  let outcome;
  try {
    outcome = await llmGenerateWithFallback(
      chain,
      {
        prompt: userPrompt,
        systemPrompt: WEEK_SYSTEM_PROMPT,
        hosted,
        feature: "plan",
        jsonSchema: { name: "emit_week_plan", schema: WEEK_TOOL_SCHEMA },
      },
      resolveKey,
      resolveModel,
      resolveBaseUrl,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logFailure(chain[0] ?? null, null, msg);
    throw new Error(`AI generation failed: ${msg}`);
  }
  let v = validateWeekPlan(safeJson(outcome.text));
  if (!v.ok) {
    const retry = await llmGenerateWithFallback(
      chain,
      {
        prompt: `${userPrompt}\n\nYOUR PREVIOUS RESPONSE was invalid (${v.error}). Return ONLY corrected JSON.`,
        systemPrompt: WEEK_SYSTEM_PROMPT,
        hosted,
        feature: "plan",
        jsonSchema: { name: "emit_week_plan", schema: WEEK_TOOL_SCHEMA },
      },
      resolveKey,
      resolveModel,
      resolveBaseUrl,
    ).catch(() => null);
    if (retry) {
      const v2 = validateWeekPlan(safeJson(retry.text));
      if (v2.ok) { v = v2; outcome = retry; }
    }
  }
  if (!v.ok || !v.plan) {
    await logFailure(outcome.provider, outcome.text, `could not parse week plan: ${v.error}`);
    throw new Error(`could not parse week plan: ${v.error}`);
  }
  const plan = v.plan;

  // Content review per day — same engine as generate-workout: strip
  // contraindicated movements, clamp unsafe loads, recompute endurance TSS, and
  // fall back to recovery if a day is left unsafe/empty. The strength/recovery
  // context below is tracked ACROSS the planned week (it used to run on empty
  // inputs, so the progressive-overload floor, weekly-volume landmark, 48h
  // recovery and back-to-back-hard guards never fired at week scope).
  const injuries = injuriesOf(onboarding);
  const weekViolations: string[] = [];

  // --- strength/recovery seed from history (mirrors generate-workout) --------
  const daysBetweenIso = (a: string, b: string) =>
    Math.round((new Date(b + "T12:00:00").getTime() - new Date(a + "T12:00:00").getTime()) / DAY);
  const since48Plan = addDays(planFrom, -2);

  // Muscles trained in the 48h before the plan starts, dated so the first day or
  // two of the week still see them; later extended with the planned days.
  const { data: recentStrength } = await admin
    .from("strength_logs").select("muscle_groups, date")
    .eq("user_id", userId).gte("date", since48Plan).lt("date", planFrom);
  const plannedMuscles: { date: string; muscles: string[] }[] = (recentStrength ?? [])
    .map((r) => ({ date: r.date as string, muscles: (r.muscle_groups ?? []) as string[] }));

  // Hard sets per muscle over the trailing week — the running volume landmark,
  // grown as the loop schedules each strength day.
  const { data: weekStrength } = await admin
    .from("strength_logs").select("muscle_groups, sets, date")
    .eq("user_id", userId).gte("date", since7);
  const weeklySetsByMuscle: Record<string, number> = {};
  for (const r of weekStrength ?? []) {
    const n = Array.isArray(r.sets) ? r.sets.length : 0;
    for (const mg of (r.muscle_groups ?? [])) weeklySetsByMuscle[mg] = (weeklySetsByMuscle[mg] ?? 0) + n;
  }

  // Last top working set per lift → the progressive-overload floor.
  const { data: mainLiftRows } = await admin
    .from("strength_logs").select("exercise_name, estimated_1rm, sets, date")
    .eq("user_id", userId).order("date", { ascending: false }).limit(20);
  const seenLift = new Set<string>();
  const mainLifts: MainLift[] = (mainLiftRows ?? [])
    .filter((r) => { if (seenLift.has(r.exercise_name)) return false; seenLift.add(r.exercise_name); return true; })
    .slice(0, 5)
    .map((r) => {
      const sets = Array.isArray(r.sets) ? r.sets : [];
      const top = sets.reduce(
        (best: { w: number; reps: number }, s: { weight_kg?: number; reps?: number }) => {
          const w = Number(s?.weight_kg ?? 0);
          return w > best.w ? { w, reps: Number(s?.reps ?? 0) } : best;
        },
        { w: 0, reps: 0 },
      );
      return { exercise: r.exercise_name, estimated1rm: r.estimated_1rm ?? top.w, lastWeight: top.w, lastReps: top.reps, lastSets: sets.length };
    });

  // Days since the last hard effort, seeded from history then advanced as the
  // loop schedules hard days (so back-to-back quality gets caught mid-week).
  let lastHardDate: string | null = acts28.find((a) => (a.tss ?? 0) > 60)?.date ?? null;
  // Readiness proxy (0-100) from recent subjective wellness; TSB is the objective
  // half. Matches the review's "wrecked athlete" semantics.
  const readiness = Math.round(((wellness3d.energy + (6 - wellness3d.soreness) + wellness3d.sleep) / 15) * 100);
  // Same trap as recovery.ts: with no check-ins the neutral 3s produce 60,
  // which is under the amber threshold and quietly capped every planned hard
  // session at RPE 6 for an athlete who had simply never checked in.
  const readinessBasis = wells.slice(0, 3).some((w) =>
      isNum(w.energy) || isNum(w.soreness) || isNum(w.sleep_score)
    )
    ? "subjective" as const
    : "none" as const;
  const equipment = onboarding.equipment as string | undefined;
  const sessionMuscles = (w: Workout): string[] =>
    [...new Set(w.sections.flatMap((s) => s.exercises.map((e) => muscleOf(e))))];

  // Don't insert on dates that already hold a locked session.
  const rows: { user_id: string; date: string; type: string; workout_json: Workout; llm_provider: string; llm_model: string }[] = [];
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (lockedByDate.has(date)) continue;
    let session = plan.days[i]?.session ??
      { type: "rest", title: "Rest day", duration_minutes: 0, tss_estimate: 0, rpe_target: 0, sections: [], coach_note: "Recovery." } as Workout;

    // Deterministic guarantee on top of the "available" prompt signal above:
    // even if the model still returned a real session for a paused date,
    // force it to rest server-side. Closes the bug class regardless of how
    // reliably any given model follows the prompt.
    session = coerceForPause(session, date, pausedUntil, pauseReason);

    const muscleGroupsLast48h = [
      ...new Set(
        plannedMuscles
          .filter((m) => { const d = daysBetweenIso(m.date, date); return d >= 1 && d <= 2; })
          .flatMap((m) => m.muscles),
      ),
    ];
    const reviewContext = {
      catalogOnly: true,
      mainLifts, weeklySetsByMuscle, muscleGroupsLast48h,
      tsb: fitness.tsb, daysSinceLastHard: lastHardDate ? daysBetweenIso(lastHardDate, date) : 99,
      experience: onboarding.experience ?? "Intermediate", injuries, readiness, readinessBasis, equipment,
      // Re-resolved per DATE, not once for the week: a backoff that ends on
      // Wednesday must stop constraining Thursday. This is the day-level
      // authority the sports list above deliberately does not try to have.
      backoffs: activeBackoffs(profile.injury_backoff, date),
    };
    const rev = reviewGeneratedWorkout(session, reviewContext);
    session = rev.corrected;
    assertPublishable(session, reviewContext);
    if (rev.violations.length) weekViolations.push(`${date}: ${rev.violations.join("; ")}`);

    // Advance the running state with the FINAL (reviewed) session so the next
    // day's checks see it.
    if (session.type === "strength") {
      plannedMuscles.push({ date, muscles: sessionMuscles(session) });
      for (const sec of session.sections) {
        for (const ex of sec.exercises) {
          weeklySetsByMuscle[muscleOf(ex)] = (weeklySetsByMuscle[muscleOf(ex)] ?? 0) + Math.max(1, ex.sets ?? 1);
        }
      }
    }
    if (isHardSession(session)) lastHardDate = date;

    rows.push({ user_id: userId, date, type: session.type, workout_json: session, llm_provider: outcome.provider, llm_model: outcome.model });
  }
  if (!rows.length) return { start_date: start, end_date: end, scheduled: 0, pushed: 0, days: [],
    week_focus: plan.week_focus, rationale: "All requested dates are protected." };
  await replacePlan(admin, userId, generationId, { start, shouldPush, calendarBusy, today }, revision,
    planFrom, end, rows.map(row => ({ ...row, sync_requested: shouldPush })),
    { start_date: start, focus: plan.week_focus, rationale: plan.rationale });
  const sync = await drainCalendarOutbox(admin, userId);
  const pushed = Object.keys(sync.events).length;

  // Still computed locally: the response reports it back to the caller.
  const cost = estimateCostUsd(outcome.provider, outcome.promptTokens, outcome.completionTokens, customPriceFromProfile(outcome.provider, profile), outcome.model);
  await logLlmResult(admin, userId, "plan", hosted, outcome, profile, {
    systemPrompt: WEEK_SYSTEM_PROMPT,
    userPrompt,
    rawResponse: outcome.text,
    error: weekViolations.length ? JSON.stringify(weekViolations) : null,
  });

  return {
    start_date: start, end_date: end, week_focus: plan.week_focus, rationale: plan.rationale,
    provider: outcome.provider, model: outcome.model, estimated_cost_usd: cost,
    scheduled: rows.length, pushed,
    days: rows.map((row) => {
      const s = row.workout_json as Workout;
      return { date: row.date, weekday: weekdayOf(row.date), type: s.type, title: s.title, tss: Math.round(s.tss_estimate) };
    }),
  };
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const admin = adminClient();
    const body = await req.json().catch(() => ({}));

    // Cron path: plan NEXT week for every opted-in user. One failure doesn't abort.
    if (body?.all_users) {
      if (req.headers.get("Authorization") !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) return json({error:"unauthorized"},401);
      const start = nextMonday();
      const { data: users } = await admin.from("user_profiles").select("id").eq("auto_plan", true);
      const results: unknown[] = [];
      for (const u of users ?? []) {
        try {
          const r = await planForUser(admin, u.id, start, body.push ?? true);
          results.push({ user_id: u.id, scheduled: r.scheduled, pushed: r.pushed });
        } catch (e) {
          results.push({ user_id: u.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return json({ mode: "all_users", start_date: start, count: results.length, results });
    }

    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const start = isoDate(body.start_date);
    const result = await planForUser(admin, userId, start, body.push ?? true, body.calendar_busy ?? null, requestId(body.request_id), body.today ?? start);
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, errorStatus(e));
  }
});
