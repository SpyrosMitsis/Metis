import { calendarWeek, sportQuotas, completedSlots } from "./weekly_schedule.ts";
import { dailyMinutes } from "./session_context.ts";
import { minutesForDate } from "./profile.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { SessionObjective, TrainingSport } from "../../../shared/prescription.ts";
import type { Workout } from "./types.ts";
import { buildSession, SESSION_POLICY, SessionUnavailable, type SessionState } from "./session_engine.ts";
import { sessionState, remainingWeekMinutes, withForecast } from "./session_context.ts";
import { loadReviewContext, constrainSession } from "./review_context.ts";
import { assertPublishable, reviewGeneratedWorkout, type PlanRow, PlanError } from "./plan_store.ts";
import { deriveProgramState, programGoals, type ProgramState } from "./program_state.ts";
import { muscleForName } from "./exercise_catalog.ts";
import { sessionWindows, slotKey, assertDaySlots } from "./session_slots.ts";
import { prescriptionWorkout } from "./prescription.ts";
import { overlapReason } from "./training_demands.ts";

const weekKey = calendarWeek;
export async function deterministicWeek(admin: SupabaseClient, owner: string,
  profile: { onboarding?: Record<string, unknown>; injury_backoff?: unknown; last_lat?: number | null; last_lon?: number | null },
  days: { date: string; available: boolean }[], fixed: Map<string, { skipped?: boolean; id?: string; date?: string; session_slot?: number; start_minute?: number | null; type: string; workout_json: unknown }>) {
  const o = profile.onboarding ?? {};
  const supported = new Set(["run", "ride", "swim", "strength"]);
  const sports = [...new Set((Array.isArray(o.sports) ? o.sports : []).filter((s): s is TrainingSport => typeof s === "string" && supported.has(s)))];
  if (!sports.length) throw new PlanError("Select the sports you want to train before making a structured week", 422, "SPORTS_REQUIRED");
  let primary = sports.includes(o.primary_sport as TrainingSport) ? o.primary_sport as TrainingSport : sports[0];
  const first = days[0]?.date;
  if (!first) return { rows: [], programs: [], states: [], rationale: "No mutable dates." };
  const { data: events, error: eventError } = await admin.from("races").select("name,date,sport,priority").eq("user_id", owner).gte("date", first).order("date", { ascending: true });
  if (eventError) throw new PlanError("Cannot read event priorities", 422, "GOALS_UNAVAILABLE");
  const goals = programGoals(o, sports, events ?? []);
  const priorityEvent = goals.filter(g => g.event_priority === "A" && g.event_date && g.event_policy && Date.parse(g.event_date) - Date.parse(first) <= g.event_policy.days * 86400000)
    .sort((a,b) => a.event_date!.localeCompare(b.event_date!))[0];
  if (priorityEvent) primary = priorityEvent.sport;
  const fixedRows = [...fixed].map(([key, row]) => ({ ...row, date: row.date ?? key.split("#")[0], session_slot: row.session_slot ?? Number(key.split("#")[1] ?? 0) }));
  const fixedBySlot = new Map(fixedRows.map(row => [slotKey(row.date, row.session_slot), row]));
  const windowsByDate = new Map(days.map(d => [d.date, sessionWindows(o, d.date)]));
  const mutable = new Set(days.flatMap(d => (windowsByDate.get(d.date)!.length ? windowsByDate.get(d.date)! : [{ slot: 0 }]).map(w => slotKey(d.date, w.slot))).filter(key => !fixedBySlot.has(key)));
  const primaryGoal = primary !== "strength" && goals.some(g => g.sport === primary && (g.objective === "performance" || g.distance_km));
  const primaryWindow = (date: string) => {
    const windows = windowsByDate.get(date)!;
    return Math.max(0, ...(windows.length ? windows : [{ slot: 0, max_minutes: dailyMinutes(o, date) ?? Number(o.session_duration ?? 30) }])
      .filter(w => !fixedBySlot.has(slotKey(date, w.slot))).map(w => Math.min(w.max_minutes, dailyMinutes(o, date) ?? w.max_minutes)));
  };
  const longestWindow = Math.max(0, ...days.filter(d => d.available).map(d => windowsByDate.get(d.date)!.find(w => w.slot === 0)?.max_minutes ?? (minutesForDate(o, d.date) ?? Number(o.session_duration ?? 30))));

  const counts = new Map<TrainingSport, number>(sports.map(s => [s, 0]));
  const rows: PlanRow[] = [], programs: ProgramState[] = [], states: SessionState[] = [];
  const scheduled = fixedRows.filter(r => !r.skipped).map(row => ({ date: row.date, workout: row.workout_json as Workout }));
  const decisions: string[] = [];
  const anchor = await sessionState(admin, owner, o, first, primary);
  const program = deriveProgramState(first, goals, anchor.actual, anchor.history_complete, o);
  // Completed earlier sessions in this calendar week consume frequency as well
  // as time. Actuals on double-session days remain distinct by stable ID.
  for (const actual of anchor.actual) if (actual.date < first && weekKey(actual.date) === weekKey(first) && counts.has(actual.sport as TrainingSport))
    counts.set(actual.sport as TrainingSport, counts.get(actual.sport as TrainingSport)! + 1);
  const explicitSchedule = Array.isArray(o.days) && o.days.length > 0 || Array.isArray(o.day_availability) && o.day_availability.length > 0;
  const capacity = (date: string) => Math.max(1, sessionWindows(o, date).length);
  // All of these inputs are fixed during generation. Calculate them once per
  // calendar week; only newly constructed rows consume the remaining budget.
  const weeks = new Map<string, {
    quotas: Map<TrainingSport, number>;
    fixed: typeof fixedRows;
    anchorDay?: string;
    remaining?: number;
  }>();
  const weekFor = (date: string) => {
    const key = weekKey(date);
    if (!weeks.has(key)) {
      const monday = Date.parse(`${key}T12:00:00Z`);
      const slots = Array.from({ length: 7 }, (_, i) => new Date(monday + i * 86400000).toISOString().slice(0, 10))
        .reduce((sum, d) => sum + (dailyMinutes(o, d) === 0 ? 0 : capacity(d)), 0);
      weeks.set(key, {
        quotas: explicitSchedule ? sportQuotas(sports, primary, slots) : new Map(program.sports.map(p => [p.sport, p.weekly_sessions])),
        fixed: fixedRows.filter(r => !r.skipped && weekKey(r.date) === key),
        anchorDay: primaryGoal ? days.filter(d => d.available && weekKey(d.date) === key && primaryWindow(d.date) >= 10)
          .sort((a, b) => primaryWindow(b.date) - primaryWindow(a.date) || b.date.localeCompare(a.date))[0]?.date : undefined,
      });
    }
    return weeks.get(key)!;
  };
  if (explicitSchedule) {
    const targets = weekFor(first).quotas;
    for (const p of program.sports) p.weekly_sessions = targets.get(p.sport) ?? 0;
    for (const sport of sports) counts.set(sport, completedSlots(anchor.actual.filter(a=>a.date<first),sport,weekKey(first),capacity,new Set()));
  }
  let currentWeek = weekKey(first);
  for (const day of days) {
    if (weekKey(day.date) !== currentWeek) { for (const sport of sports) counts.set(sport, 0); currentWeek = weekKey(day.date); }
    const windows = windowsByDate.get(day.date)!;
    const week = weekFor(day.date);
    for (const window of windows.length ? windows : [{ slot: 0, start_minute: undefined }]) {
    const slot = window.slot;
    const fixedDay = fixedBySlot.get(slotKey(day.date, slot));
    if (fixedDay) {
      if (!fixedDay.skipped && counts.has(fixedDay.type as TrainingSport)) counts.set(fixedDay.type as TrainingSport, counts.get(fixedDay.type as TrainingSport)! + 1);
      continue;
    }
    const planned = rows.filter(r => weekKey(r.date) === weekKey(day.date));
    const committed = planned.reduce((sum, r) => sum + r.workout_json.duration_minutes + (r.transition_before_seconds ?? 0) / 60, 0);
    week.remaining ??= await remainingWeekMinutes(admin, owner, o, day.date, mutable, anchor.actual);
    const remaining = Math.max(0, week.remaining - committed);
    const { anchorDay, quotas } = week;
    const commitments = (sport: TrainingSport) => {
      const fixed = week.fixed.filter(r => r.type === sport);
      const plannedSport = planned.filter(r => r.type === sport);
      const linked = new Set(fixed.map(r => r.id).filter((id): id is string => !!id));
      const actual = anchor.actual.filter(a => a.sport === sport && !fixed.some(r => r.id === a.planned_workout_id));
      return {
        actual,
        completed: completedSlots(anchor.actual, sport, weekKey(day.date), capacity, linked),
        sessions: fixed.length + plannedSport.length,
        minutes: plannedSport.reduce((sum, r) => sum + r.workout_json.duration_minutes, 0) +
          fixed.reduce((sum, r) => sum + Number((r.workout_json as Workout)?.duration_minutes ?? 0), 0),
      };
    };
    // Keep the final primary-sport slot for the longest eligible window.
    const primaryCommitments = commitments(primary);
    const primaryUsed = primaryCommitments.sessions + primaryCommitments.completed;
    const reservePrimary = explicitSchedule && anchorDay && anchorDay>day.date && quotas.get(primary)!-primaryUsed === 1;
    const ranked = [...sports].sort((a, b) => {
      if (explicitSchedule && anchorDay === day.date && (a === primary || b === primary)) return a === primary ? -1 : 1;
      if (reservePrimary && (a === primary || b === primary)) return a === primary ? 1 : -1;
      const score = (s: TrainingSport) => (counts.get(s) ?? 0) / (s === primary ? 2 : 1);
      return score(a) - score(b) || (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b));
    });
    let chosen: Workout | null = null;
    let chosenState: SessionState | null = null;
    const unavailable: string[] = [];
    let deliberateRecovery = !day.available || remaining < 10;
    if (!deliberateRecovery) for (const sport of ranked) {
      const progress = program.sports.find(p => p.sport === sport)!;
      if (sport === primary && reservePrimary) { deliberateRecovery=true; unavailable.push(`${sport}: the remaining primary session is reserved for ${anchorDay}.`); continue; }
      const quota = quotas.get(sport)!;
      const commitment = commitments(sport);
      const completed = explicitSchedule ? commitment.completed : commitment.actual
        .filter(a => a.date <= day.date && Date.parse(day.date) - Date.parse(a.date) < 7 * 86400000).length;
      const committedSessions = commitment.sessions;
      if (completed + committedSessions >= quota) {
        unavailable.push(`${sport}: this calendar week's ${quota} training slots are already covered.`);
        deliberateRecovery = true; continue;
      }
      let state = await withForecast(await sessionState(admin, owner, o, day.date, sport, undefined, slot), profile);
      // A requested increase in frequency introduces short easy sessions; it
      // does not authorize harder/longer sessions or invent completed exposure.
      const observedDays = new Set(anchor.actual.filter(a=>a.sport===sport && Date.parse(first)-Date.parse(a.date)<7*86400000).map(a=>a.date)).size;
      const transition = explicitSchedule && quota > Math.max(1, observedDays);
      state.program = transition ? {...progress, weekly_sessions:quota, session_minutes:progress.session_minutes, quality_allowed:false,
        reason:"Building toward your selected training days using your recent session duration; intensity progression remains separate."} : {...progress,weekly_sessions:quota};
      const sportMinutes = commitment.minutes;
      const sportBudget = explicitSchedule && !["reduced", "event_preparation", "reassess"].includes(progress.phase) ? Math.max(progress.weekly_minutes, quota * state.program.session_minutes) : progress.weekly_minutes;
      const completedDose = ["reduced", "event_preparation"].includes(progress.phase)
        ? commitment.actual.filter(a=>weekKey(a.date)===weekKey(day.date) && a.minutes!==null).reduce((sum,a)=>sum+a.minutes!,0) : 0;
      state.weekly_remaining_minutes = Math.min(remaining, Math.max(0, sportBudget - sportMinutes - completedDose));
      if (state.weekly_remaining_minutes < 10 || state.max_minutes < 10) { unavailable.push(`${sport}: less than ten minutes remain within the time budget.`); deliberateRecovery = true; continue; }
      const reason = overlapReason(day.date, sport, sport === "strength", state.actual, scheduled);
      if (reason) { unavailable.push(reason); deliberateRecovery = true; continue; }
      state.session_number = (state.actual.filter(a => a.sport === "strength").length + rows.filter(r => r.type === "strength").length);
      let objective: SessionObjective = progress.preferred_objective;
      const distanceGoal = goals.find(g => g.sport === sport && !g.event_date)?.distance_km;
      const dayLimit = windows.find(w => w.slot === slot)?.max_minutes ?? (minutesForDate(o, day.date) ?? Number(o.session_duration ?? 30));
      if (["run", "ride"].includes(sport) && distanceGoal && state.program.quality_allowed && quota >= 3 && dayLimit >= longestWindow && !rows.some(r => r.workout_json.prescription?.objective === "long")) {
        objective = "long";
        const longestActual = state.actual.filter(a => a.sport === sport && a.minutes !== null && Date.parse(first) - Date.parse(a.date) < 14 * 86400000).reduce((max, a) => Math.max(max, a.minutes!), progress.session_minutes);
        state.program = { ...progress, session_minutes: Math.min(dayLimit, longestActual) };
      }
      const performance = goals.some(g => g.sport === sport && g.objective === "performance");
      // Change either duration or stimulus, never both in the same decision.
      if (objective !== "long" && sport !== "strength" && performance && state.program.quality_allowed && progress.decision === "repeat" && state.fatigue === "normal" &&
          !rows.some(r => r.workout_json.rpe_target >= 7) && !overlapReason(day.date, sport, true, state.actual, scheduled)) objective = "tempo";
      if (objective === "tempo" && sport === "swim") objective = "threshold";
      const context = await loadReviewContext(admin, owner, day.date, sport, profile);
      // Accumulate planned strength sets so a week cannot exceed the landmark
      // through individually-valid sessions. Planned work never drives progress.
      const reservedStrength = [...planned,
        ...week.fixed.filter(r=>!anchor.actual.some(a=>r.id && a.planned_workout_id===r.id))];
      for (const row of reservedStrength) if (row.type === "strength") for (const section of (row.workout_json as Workout).sections ?? []) {
        if (/warm|cool/.test(section.name)) continue;
        for (const exercise of section.exercises) {
          const muscle = exercise.muscle ?? muscleForName(exercise.name);
          if (muscle) context.weeklySetsByMuscle[muscle] = (context.weeklySetsByMuscle[muscle] ?? 0) + exercise.sets;
        }
      }
      state = constrainSession(state, context);
      if (state.blocked_sports.includes(sport) || state.program?.phase === "reassess" && state.actual.some(a=>a.sport===sport && a.response === "pain" && Date.parse(day.date)-Date.parse(a.date)<7*86400000)) {
        deliberateRecovery = true; unavailable.push(`${sport}: an active training hold or pain report requires review.`); continue;
      }
      try { chosen = buildSession(state, objective); }
      catch (error) {
        if (!(error instanceof SessionUnavailable)) throw error;
        unavailable.push(`${sport}: ${error.message}`); continue;
      }
      const reviewed = reviewGeneratedWorkout(chosen, context);
      assertPublishable(reviewed.corrected, context);
      chosen = reviewed.corrected; chosenState = state;
      if (unavailable.length && sport !== ranked[0]) {
        chosenState.program = { ...progress, decision: "substitute", reason: `Use eligible ${sport} because ${unavailable.join("; ")}. It does not replace the original sport-specific exposure.` };
        decisions.push(`${day.date}: ${chosenState.program.reason}`);
      }
      break;
    }
    if (!chosen) {
      if (!deliberateRecovery && unavailable.length) throw new PlanError("No eligible session; existing week retained", 422, "NO_ELIGIBLE_SESSION", unavailable);
      const rest = await sessionState(admin, owner, o, day.date, "rest", o.recovery_day_style && day.available ? Math.min(10, remaining) : 0);
      chosen = buildSession(rest, ["mobility", "optional_light", "active_recovery"].includes(String(o.recovery_day_style)) && day.available ? o.recovery_day_style as SessionObjective : "rest");
      chosenState = rest;
      const reason = !day.available ? "Rest day: outside your selected training days or during a training pause."
        : remaining < 10 ? "Rest day: your weekly time budget is already used."
        : `Rest day: ${unavailable.join(" ") || "no compatible training slot remains."}`;
      chosen.prescription!.reasons = [reason]; chosen = prescriptionWorkout(chosen.prescription!);
      decisions.push(`${day.date}: ${reason}`);
    }
    const row: PlanRow = { date: day.date, session_slot: slot, start_minute: window.start_minute, type: chosen.type, workout_json: chosen, llm_model: SESSION_POLICY.version };
    const previous = rows.find(r => r.date === day.date && r.session_slot === 0);
    if (slot === 1 && previous && chosen.type !== "rest") {
      const gap = (row.start_minute ?? 0) - (previous.start_minute ?? 0) - previous.workout_json.duration_minutes;
      if (["triathlon", "duathlon"].includes(String(o.multisport_goal)) && previous.type !== chosen.type && ["run", "ride", "swim"].includes(previous.type) && chosenState?.history_complete && gap >= 0 && gap <= 30) {
        row.combined_group = previous.combined_group = `${day.date}:multisport`;
        row.transition_before_seconds = gap * 60;
      }
      try { assertDaySlots(o, day.date, [...fixedRows as PlanRow[], ...rows, row]); }
      catch (error) {
        // Availability is a hard constraint, not a reason to publish overlapping
        // sessions. Keep the primary session and make this slot explicit rest.
        const rest = await sessionState(admin, owner, o, day.date, "rest", 0, slot);
        row.workout_json = buildSession(rest, "rest"); row.type = "rest"; chosenState = rest;
        delete row.combined_group; delete row.transition_before_seconds;
        if (previous) delete previous.combined_group;
        decisions.push(`${day.date} slot ${slot + 1}: ${String(error)}`);
      }
    }
    rows.push(row);
    states.push(chosenState!);
    scheduled.push({ date: day.date, workout: row.workout_json });
    if (counts.has(row.workout_json.type)) counts.set(row.workout_json.type, counts.get(row.workout_json.type)! + 1);
    }
  }
  if (rows.length) programs.push(program);
  return { rows, programs, states, rationale: `Prioritized ${primary}; fitted secondary sports around actual exposure, time and recovery. ${program.sports.map(p => `${p.sport}: ${p.reason}`).join(" ")} ${program.observations.join(" ")} ${decisions.join(" ")}` };
}
