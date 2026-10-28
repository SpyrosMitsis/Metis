import { sessionState } from "../_shared/session_context.ts";
// daily-summary — compute the dashboard payload: readiness score (0-100),
// today's planned workout, TSB sparkline (14d), and weekly load vs target.
//
// Readiness = composite of HRV delta, resting-HR delta, and 3-day avg wellness.
//
// GET or POST { date?: "YYYY-MM-DD" } — the client's LOCAL date. Without it
// the server falls back to UTC, which is yesterday for tz-ahead users until
// mid-morning (the "Home stuck on yesterday's workout" bug).

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { computeRecovery } from "../_shared/recovery.ts";
import { applyFallbackFitness } from "../_shared/load.ts";
import { hostedLlm } from "../_shared/entitlement.ts";
import { pickDebrief, type SessionDebrief } from "../_shared/debrief.ts";
import { computeBodyTrend } from "../_shared/body_trend.ts";
import { pickGoalRace, type RaceRow } from "../_shared/context.ts";
import { pickPrimaryPlannedWorkout } from "../_shared/planned_today.ts";
import { injuriesOf } from "../_shared/profile.ts";
import { muscleOf } from "../_shared/workout_review.ts";
import {
  activeBackoffs,
  daysBetween,
  followUpQuestion,
  injuryFollowUpDue,
  painCheckArea,
} from "../_shared/injury.ts";
import type { Workout } from "../_shared/types.ts";

const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    // Anchor every "recent" window on the REQUESTED day, not on the wall clock, so
    // paging back to a past date shows the dashboard AS IT WAS then (readiness,
    // load, Form). Noon-UTC keeps the date arithmetic off DST/tz edges. All the
    // recent-data queries are also capped at `<= today` so a past view never pulls
    // in data from after that day.
    const anchorMs = new Date(today + "T12:00:00Z").getTime();
    const since14 = new Date(anchorMs - 14 * DAY).toISOString().slice(0, 10);
    const since7 = new Date(anchorMs - 7 * DAY).toISOString().slice(0, 10);
    const since90 = new Date(anchorMs - 90 * DAY).toISOString().slice(0, 10);

    // ONE round of parallel reads. This endpoint is the app's most-hit by a wide
    // margin (every Home open, every morning notification), and it used to fan
    // out five queries here and then run four MORE sequentially below: three
    // further reads of wellness_checkins (two over the identical window, just
    // different columns) plus a second read of user_profiles. Same rows, same
    // user, four extra round trips on the critical path.
    //
    // Now every read starts at once. The wellness data is fetched over the
    // WIDEST window any consumer needs (since90) and narrowed per consumer in
    // memory, because slicing an array costs nothing and a round trip does not.
    //
    // The split into core/extended is deliberate and is the one thing not to
    // "simplify" away: the core columns ship in the initial schema and must
    // always work, while the extended ones arrive in later migrations
    // (hrv/rhr in 8, sleep_score in 28, vo2max in 19, body metrics in 39). Only
    // the extended read is allowed to fail, so a partially-migrated database
    // loses VO2/body-trend and keeps its dashboard, exactly as before. The
    // change is that those three now degrade together rather than one by one.
    const [
      { data: profile },
      { data: wellnessCore },
      extended,
      { data: activities },
      { data: planned },
      { data: plannedWeek },
      backoffRow,
      { data: raceRows },
    ] = await Promise.all([
      admin.from("user_profiles").select("onboarding, active_llm_provider").eq("id", userId).single(),
      admin.from("wellness_checkins").select("date, energy, soreness, zepp_sleep_minutes")
        .eq("user_id", userId).gte("date", since90).lte("date", today).order("date", { ascending: false }),
      admin.from("wellness_checkins")
        .select("date, hrv_rmssd, resting_hr, sleep_score, vo2max, weight_kg, body_fat_pct, lean_mass_kg")
        .eq("user_id", userId).gte("date", since90).lte("date", today).order("date", { ascending: true })
        .then((r) => r, () => ({ data: null, error: true })),
      admin.from("effective_activities").select("date, type, distance_m, tss, ctl, atl, data_json, planned_workout_id, link_source")
        .eq("user_id", userId).gte("date", since14).lte("date", today).order("date", { ascending: true }),
      admin.from("reconciled_session_plans").select("*").eq("user_id", userId).eq("date", today),
      admin.from("reconciled_session_plans").select("date, type, workout_json, completed, skipped, reconciliation_status")
        .eq("user_id", userId).gte("date", since7).lte("date", today).neq("type", "rest"),
      admin.from("user_profiles").select("injury_backoff").eq("id", userId).single()
        .then((r) => r, () => ({ data: null })),
      // Depends only on `today`, so there is no reason for it to wait for the
      // recovery maths that used to precede it.
      admin.from("races").select("name, date, priority").eq("user_id", userId)
        .gte("date", today).order("date", { ascending: true }).limit(8),
    ]);

    // Per-consumer windows, sliced from the one fetch above. `wells` keeps its
    // old shape exactly: 14 days, newest first, which is what computeRecovery
    // and the 3-day wellness average both assume.
    const wellsAll = wellnessCore ?? [];
    const wells = wellsAll.filter((w) => (w.date ?? "") >= since14);
    // deno-lint-ignore no-explicit-any
    const wellnessExt: any[] = (extended as { data: unknown[] | null }).data ?? [];
    const extOk = wellnessExt.length > 0 || !(extended as { error?: unknown }).error;
    const ext14 = wellnessExt.filter((w) => (w.date ?? "") >= since14);

    // When today holds several sessions, pick the SAME "primary" the calendar
    // shows first (shared with weather-check so Home/Calendar/the weather
    // prompt never disagree about today's workout) — see planned_today.ts.
    const todayWorkout = pickPrimaryPlannedWorkout(planned ?? []);

    // No intervals-provided CTL in the window? Fill estimated values from
    // stored TSS so the TSB sparkline and goal trend work without intervals.icu.
    const acts = await applyFallbackFitness(admin, userId, today, activities ?? []);

    // --- recovery: HRV/RHR/sleep trends → 0-100 score (shared module) --------
    // wellness_checkins is the single source of truth: sync-intervals mirrors
    // Intervals.icu's objective series (sleep/HRV/RHR/VO2max) into it, and any
    // Health Connect snapshot can override the same columns. Fall back to the
    // raw Intervals wellness in completed_activities.data_json only if the
    // mirror hasn't run yet. Queried best-effort (works pre-migration-8).
    const isNum = (v: unknown): v is number => typeof v === "number";
    // Dated points (oldest→newest) so computeRecovery can pick TODAY's reading
    // specifically — a not-yet-synced day reads as missing, not as yesterday's.
    type DatedNum = { date?: string; value: number };
    let hcHrv: DatedNum[] = [];
    let hcRhr: DatedNum[] = [];
    if (extOk) {
      // Same 14-day slice and same ascending order the dedicated query used;
      // sleep_score is merged onto wells for full-resolution recovery.
      hcHrv = ext14.filter((w) => isNum(w.hrv_rmssd))
        .map((w) => ({ date: w.date as string | undefined, value: w.hrv_rmssd as number }));
      hcRhr = ext14.filter((w) => isNum(w.resting_hr))
        .map((w) => ({ date: w.date as string | undefined, value: w.resting_hr as number }));
      const scoreByDate = new Map<string, number>();
      for (const r of ext14) if (isNum(r.sleep_score)) scoreByDate.set(r.date as string, r.sleep_score);
      for (const w of wells) {
        const sc = w.date ? scoreByDate.get(w.date) : undefined;
        if (sc !== undefined) (w as { sleep_score?: number }).sleep_score = sc;
      }
    }
    const ivHrv: DatedNum[] = acts.filter((a) => isNum((a.data_json as { hrv?: number })?.hrv))
      .map((a) => ({ date: a.date, value: (a.data_json as { hrv: number }).hrv }));
    const ivRhr: DatedNum[] = acts.filter((a) => isNum((a.data_json as { restingHR?: number })?.restingHR))
      .map((a) => ({ date: a.date, value: (a.data_json as { restingHR: number }).restingHR }));
    const hrvSeries = hcHrv.length >= 2 ? hcHrv : ivHrv;
    const rhrSeries = hcRhr.length >= 2 ? hcRhr : ivRhr;

    // Data freshness: the most recent day (≤ requested date) with ANY objective
    // recovery signal — HRV/RHR (mirror or Intervals) or sleep (minutes/score).
    // Powers the "last synced" line so missing data reads as "stale", not absent.
    const objectiveDates: string[] = [];
    for (const p of [...hcHrv, ...hcRhr, ...ivHrv, ...ivRhr]) if (p.date) objectiveDates.push(p.date);
    for (const w of wells) {
      if (w.date && (isNum(w.zepp_sleep_minutes) || isNum((w as { sleep_score?: number }).sleep_score))) {
        objectiveDates.push(w.date);
      }
    }
    const recoverySyncedDate = objectiveDates.length
      ? objectiveDates.reduce((a, b) => (a > b ? a : b))
      : null;

    // Anchor on the requested day so a missing today reads as missing.
    const recovery = computeRecovery(wells, hrvSeries, rhrSeries, today);
    const planningState = await sessionState(admin,userId,profile?.onboarding??{},today,"rest");
    const readiness = recovery.score;
    const band = recovery.band;

    // VO2 max (from Intervals.icu mirror, or Zepp via Health Connect): current
    // value + change over ~90d.
    // Best-effort — works whether or not the vo2max column migration is applied.
    let vo2max: { value: number; change: number | null } | null = null;
    if (extOk) {
      const series = wellnessExt.map((r) => r.vo2max).filter(isNum);
      if (series.length) {
        const value = series[series.length - 1];
        const change = series.length >= 2 ? +(value - series[0]).toFixed(1) : null;
        vo2max = { value: +value.toFixed(1), change };
      }
    }

    // Body-composition trend, read through the strength goals (build muscle →
    // lean mass, lose fat → weight/fat). Best-effort: pre-migration selects
    // error out and the key is simply omitted.
    let bodyTrend: ReturnType<typeof computeBodyTrend> = null;
    if (extOk) {
      const goals = ((profile?.onboarding as { goals_by_sport?: Record<string, string[]> })
        ?.goals_by_sport?.strength) ?? [];
      bodyTrend = computeBodyTrend(wellnessExt, goals, today);
    }

    // --- session debrief (today's or yesterday's analyzed session) ----------
    // Dedicated narrow query: analysis_json also lives on the wide activities
    // rows, but only for rows we already fetch WITHOUT it (it carries series/
    // splits and would bloat every dashboard load). Best-effort, max 2+2 rows.
    let debrief: SessionDebrief | null = null;
    try {
      const sinceYesterday = new Date(anchorMs - DAY).toISOString().slice(0, 10);
      const [{ data: analyzedActs }, { data: analyzedStrength }] = await Promise.all([
        admin.from("effective_activities").select("id, date, type, analysis_json, planned_workout_id, link_source")
          .eq("user_id", userId).not("analysis_json", "is", null)
          .gte("date", sinceYesterday).lte("date", today)
          .order("date", { ascending: false }).limit(2),
        admin.from("strength_analyses").select("date, analysis_json")
          .eq("user_id", userId)
          .gte("date", sinceYesterday).lte("date", today)
          .order("date", { ascending: false }).limit(2),
      ]);
      debrief = pickDebrief(analyzedActs ?? [], analyzedStrength ?? [], today);
    } catch { /* table/column may not exist yet */ }

    // --- TSB sparkline (14d) -------------------------------------------------
    const tsbSparkline = acts
      .filter((a) => a.ctl != null && a.atl != null)
      .map((a) => ({ date: a.date, tsb: (a.ctl ?? 0) - (a.atl ?? 0), ctl: a.ctl, atl: a.atl }));

    // --- weekly load vs target ----------------------------------------------
    const weeklyTss = acts.filter((a) => a.date >= since7).reduce((s, a) => s + (a.tss ?? 0), 0);
    const targetWeeklyTss = (profile?.onboarding as { weekly_tss_target?: number })?.weekly_tss_target ?? 350;

    // --- week in review (deterministic; no LLM — the coach voice on Home comes
    // from coach-brief). Adherence, load trend vs last week, sport split, and the
    // standout session over the last 7 days. ---------------------------------
    const prevWeekStart = since14; // the 7 days before this week's window
    const sportOf = (t?: string | null): string => {
      const s = (t ?? "").toLowerCase();
      if (s.includes("run")) return "run";
      if (s.includes("ride") || s.includes("cycl") || s.includes("bike") || s.includes("velo")) return "ride";
      if (s.includes("swim")) return "swim";
      if (s.includes("weight") || s.includes("strength") || s.includes("gym")) return "strength";
      return "other";
    };
    const week7 = acts.filter((a) => a.date >= since7);
    const prevWeek = acts.filter((a) => a.date >= prevWeekStart && a.date < since7);
    const prevTss = prevWeek.reduce((s, a) => s + (a.tss ?? 0), 0);
    const bySport = new Map<string, number>();
    for (const a of week7) bySport.set(sportOf(a.type), (bySport.get(sportOf(a.type)) ?? 0) + (a.tss ?? 0));
    const plannedNonRest = (plannedWeek ?? []);
    const doneCount = plannedNonRest.filter((p) => !p.skipped && (p.completed || ["completed_as_planned", "modified", "substituted"].includes(p.reconciliation_status))).length;
    const standout = [...week7].sort((a, b) => (b.tss ?? 0) - (a.tss ?? 0))[0] ?? null;
    const weekReview = {
      adherence: {
        done: doneCount,
        planned: plannedNonRest.length,
        pct: plannedNonRest.length ? Math.round((doneCount / plannedNonRest.length) * 100) : null,
      },
      load: {
        tss: Math.round(weeklyTss),
        target: targetWeeklyTss,
        prev_tss: Math.round(prevTss),
        delta_pct: prevTss > 0 ? Math.round(((weeklyTss - prevTss) / prevTss) * 100) : null,
      },
      by_sport: [...bySport.entries()]
        .map(([sport, tss]) => ({ sport, tss: Math.round(tss) }))
        .sort((a, b) => b.tss - a.tss),
      sessions: week7.length,
      standout: standout
        ? { date: standout.date, sport: sportOf(standout.type), tss: Math.round(standout.tss ?? 0) }
        : null,
    };

    // --- injury follow-up + post-workout pain check --------------------------
    // Deliberately SERVER-side, and deliberately on this endpoint. The follow-up
    // is a "N days after the athlete raised an injury" question, and Android has
    // no scheduler shaped like that: CheckinReminder is a daily periodic worker
    // keyed off wake time, so a per-injury delayed job would have been new
    // scheduling infrastructure (and a WorkManager request whose id, cancellation
    // and re-scheduling all had to track a jsonb array inside a profile). This
    // endpoint already runs every morning, already knows the client's local date,
    // and already carries the cards Home draws. The check is three pure function
    // calls on data the request has in hand, so it costs nothing and there is no
    // second copy of "is it due?" to drift.
    //
    // Both are payload, not state: nothing is written until the athlete answers
    // (injury-checkin), so a summary fetched five times shows the same card.
    let injuryCheckin: {
      area: string; severity: string | null; note: string | null;
      raised_at: string | null; days_since: number | null; question: string;
    } | null = null;
    let painCheck: { area: string; planned_workout_id: string | null } | null = null;
    let injuryBackoff: ReturnType<typeof activeBackoffs> = [];
    try {
      const injuries = injuriesOf((profile?.onboarding ?? {}) as Record<string, unknown>);
      const due = injuryFollowUpDue(injuries, today);
      if (due) {
        injuryCheckin = {
          area: due.area,
          severity: due.severity || null,
          note: due.note ?? null,
          raised_at: due.raised_at ?? null,
          days_since: due.raised_at ? daysBetween(due.raised_at, today) : null,
          question: followUpQuestion(due, today),
        };
      }
      // Asked about TODAY's session, and only when that session could actually
      // have loaded an injured area (see painCheckArea). The client shows it
      // after the athlete marks the workout done.
      const wj = (todayWorkout?.workout_json ?? null) as Workout | null;
      const area = painCheckArea(injuries, wj, muscleOf);
      if (area) painCheck = { area, planned_workout_id: todayWorkout?.id ?? null };
      // Fetched in the parallel round above; a pre-migration DB yields null
      // there rather than costing the athlete their dashboard.
      injuryBackoff = activeBackoffs(
        (backoffRow as { data?: { injury_backoff?: unknown } }).data?.injury_backoff,
        today,
      );
    } catch { /* column not migrated yet */ }

    // --- goal tracking ------------------------------------------------------
    // Goals and races is the source of truth: the card names the athlete's own
    // race row, and shows nothing when that page is empty. See pickGoalRace.
    const onboard = (profile?.onboarding ?? {}) as { goal?: string; goal_date?: string };
    const goalRace = pickGoalRace((raceRows ?? []) as RaceRow[], today, onboard.goal_date);
    let goal = null as null | {
      goal: string; goal_date: string | null; weeks_to_goal: number | null;
      phase: string; ctl_trend: number; on_track: string;
    };
    if (goalRace) {
      const goalDate = goalRace.date as string;
      // Noon-UTC on both sides, or race day itself lands half a day in the past
      // and the countdown reads "no date" on the morning that matters most.
      const wk = (new Date(goalDate + "T12:00:00Z").getTime() - anchorMs) / (7 * 86_400_000);
      const weeksToGoal = Math.max(0, Math.round(wk));
      const phase = weeksToGoal <= 2 ? "Taper"
        : weeksToGoal <= 6 ? "Peak" : weeksToGoal <= 14 ? "Build" : "Base";
      // acts is ordered ASCENDING here (unlike goalBlock's descending input),
      // so the trend is newest minus oldest.
      const ctlVals = acts.filter((a) => a.ctl != null).map((a) => Number(a.ctl));
      const ctlTrend = ctlVals.length >= 2 ? Math.round((ctlVals[ctlVals.length - 1] - ctlVals[0]) * 10) / 10 : 0;
      const onTrack = ctlTrend > 1 ? "Fitness building, on track"
        : ctlTrend < -1 ? (phase === "Taper" ? "Tapering as planned" : "Fitness slipping, rebuild consistency")
        : "Holding steady";
      goal = {
        goal: (goalRace.name as string).trim(),
        goal_date: goalDate,
        weeks_to_goal: weeksToGoal,
        phase,
        ctl_trend: ctlTrend,
        on_track: onTrack,
      };
    }

    return json({
      date: today,
      readiness_context: planningState.readiness,
      readiness: {
        decision_score: recovery.basis === "none" ? null : readiness,
        score: readiness,
        band,
        components: {
          wellness: recovery.wellness,
          hrvDelta: recovery.hrv?.deltaPct ?? 0,
          rhrDelta: recovery.rhr?.deltaPct ?? 0,
        },
      },
      recovery,
      recovery_synced_date: recoverySyncedDate,
      vo2max,
      body_trend: bodyTrend,
      today_workout: todayWorkout,
      tsb_sparkline: tsbSparkline,
      weekly_load: { tss: Math.round(weeklyTss), target: targetWeeklyTss },
      week_review: weekReview,
      debrief,
      // The injury loop's read side: one follow-up question at most, the pain
      // question for today's session if it could have aggravated something, and
      // whatever backoff is currently reshaping the training.
      injury_checkin: injuryCheckin,
      pain_check: painCheck,
      injury_backoff: injuryBackoff,
      active_llm_provider: profile?.active_llm_provider ?? "groq",
      goal,
      // Deployment capabilities — self-hosted stacks without the hosted LLM
      // secrets advertise false and the app never shows Pro UI.
      server: { hosted_ai: hostedLlm() !== null },
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
