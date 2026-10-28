import { startingLiftReferences } from "./strength_evidence.ts";
import { EXERCISE_CATALOG } from "./exercise_catalog.ts";
import { exerciseId } from "./exercise_requirements.ts";
import { exerciseLoadsArea, sportsForArea } from "./injury.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { maxWeeklySets } from "./workout_review.ts";
import type { ReviewContext, MainLift } from "./workout_review.ts";
import { experienceForSport, injuriesOf } from "./profile.ts";
import { activeBackoffs } from "./injury.ts";
import { dailyMinutes, explicitImplements } from "./session_context.ts";
import { nextTarget } from "./progression.ts";
import { compoundForName, categoryOfExercise } from "./exercise_catalog.ts";
import type { InjuryBackoff } from "./types.ts";

/** Template application is training prescription too, so it cannot use an
 * empty synthetic athlete. Fail closed if any required history read fails. */
export async function loadReviewContext(admin: SupabaseClient, owner: string, date: string, sport: string,
  profile: { onboarding?: Record<string, unknown>; injury_backoff?: unknown }): Promise<ReviewContext> {
  const o = profile.onboarding ?? {};
  const since = new Date(Date.parse(date) - 28 * 86400000).toISOString().slice(0, 10);
  const [{ data: logs, error }, { data: activities, error: activityError }] = await Promise.all([
    admin.from("strength_logs").select("exercise_name,estimated_1rm,sets,muscle_groups,date").eq("user_id", owner).gte("date", since).lte("date", date).order("date", { ascending: false }),
    admin.from("effective_activities").select("date,tss,data_json").eq("user_id", owner).gte("date", since).lte("date", date),
  ]);
  if (error || activityError) throw new Error("Cannot read training history for prescription review");
  const days = (d: string) => (Date.parse(date) - Date.parse(d)) / 86400000;
  const mainLifts: MainLift[] = [];
  const muscles = new Set<string>();
  const weeklySetsByMuscle: Record<string, number> = {};
  const seen = new Set<string>();
  for (const log of logs ?? []) {
    const sets = Array.isArray(log.sets) ? log.sets.filter(s => !s.is_warmup) : [];
    const top = Math.max(0, ...sets.map(s => Number(s.weight_kg ?? 0)).filter(Number.isFinite));
    if (!seen.has(log.exercise_name)) {
      seen.add(log.exercise_name);
      mainLifts.push({ exercise: log.exercise_name, estimated1rm: Number(log.estimated_1rm ?? 0), lastWeight: top,
        target: categoryOfExercise(log.exercise_name) === "Band" || /assisted/i.test(log.exercise_name) ? null : nextTarget(sets, compoundForName(log.exercise_name) ?? false) });
    }
    for (const muscle of log.muscle_groups ?? []) {
      if (days(log.date) < 2) muscles.add(muscle);
      if (days(log.date) < 7) weeklySetsByMuscle[muscle] = (weeklySetsByMuscle[muscle] ?? 0) + sets.length;
    }
  }
  for (const lift of startingLiftReferences(o)) if (!mainLifts.some(l=>l.exercise===lift.exercise)) {
    mainLifts.push({ exercise: lift.exercise, estimated1rm: lift.weight_kg * (1 + lift.reps / 30),
      lastWeight: lift.weight_kg, lastReps: lift.reps, lastSets: 1,
      target: nextTarget([{reps:lift.reps,weight_kg:lift.weight_kg}], compoundForName(lift.exercise) ?? false) });
  }
  const hard = (activities ?? []).filter(a => Number(a.data_json?.icu_rpe ?? 0) >= 7);
  return { catalogOnly: true, mainLifts, weeklySetsByMuscle, muscleGroupsLast48h: [...muscles], tsb: 0,
    daysSinceLastHard: hard.length ? Math.min(...hard.map(a => days(a.date))) : 99,
    experience: experienceForSport(o, sport), injuries: injuriesOf(o),
    backoffs: activeBackoffs(profile.injury_backoff as InjuryBackoff[] | null, date),
    readinessBasis: "none", equipment: typeof o.equipment === "string" ? o.equipment : undefined,
    implements: explicitImplements(o), maxMinutes: dailyMinutes(o, date) ?? undefined };
}

/** Apply dated review constraints before selection as well as at the final gate. */
export function constrainSession(state: import('./session_engine.ts').SessionState, context: ReviewContext): import('./session_engine.ts').SessionState {
  const avoided = (context.backoffs ?? []).filter(b => b.level === "avoid");
  const excluded = EXERCISE_CATALOG.filter(e => avoided.some(b => exerciseLoadsArea(b.area, e.name, e.muscle))).map(e => exerciseId(e.name));
  const blocked = avoided.some(b => sportsForArea(b.area).includes(state.sport as import('./injury.ts').EnduranceSport));
  const eased = (context.backoffs ?? []).some(b => b.level === "ease" && sportsForArea(b.area).includes(state.sport as import('./injury.ts').EnduranceSport));
  return { ...state, max_minutes: Math.min(state.max_minutes, context.maxMinutes ?? state.max_minutes),
    excluded_exercises: [...new Set([...(state.excluded_exercises ?? []), ...excluded])],
    remaining_sets: Object.fromEntries([...new Set(EXERCISE_CATALOG.map(e=>e.muscle))].map(m=>[m,Math.max(0,maxWeeklySets(context.experience)-(context.weeklySetsByMuscle[m] ?? 0))])),
    blocked_sports: [...new Set([...state.blocked_sports, ...(blocked ? [state.sport] : [])])],
    fatigue: eased ? "high" : state.fatigue,
    program: eased && state.program ? { ...state.program, quality_allowed: false } : state.program };
}
