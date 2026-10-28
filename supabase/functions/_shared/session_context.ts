import { startingLiftReferences } from "./strength_evidence.ts";
import { activeSafetyRules } from "./workout_review.ts";
import { EXERCISE_CATALOG } from "./exercise_catalog.ts";
import { injuriesOf } from "./profile.ts";
import { combineEffort } from "./feedback_evidence.ts";
import { readinessContext } from "./readiness_context.ts";
import { getForecastWeather, assessViability } from "./weather.ts";
import { slotMinutes, slotKey, sessionWindows } from "./session_slots.ts";
import { SESSION_POLICY } from "./session_engine.ts";
import { deriveProgramState, programGoals } from "./program_state.ts";
import { activityMatchesPlanned } from "./activity_matching.ts";
import { exerciseId, requirements } from "./exercise_requirements.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { experienceForSport, minutesForDate } from "./profile.ts";
import type { SessionState, ActualExposure, Calibration } from "./session_engine.ts";
import type { TrainingSport } from "../../../shared/prescription.ts";

export function dailyMinutes(o: Record<string, unknown>, date: string): number | null {
  const day = minutesForDate(o, date);
  for (const value of [day, o.session_duration_max, o.weekly_minutes_max]) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Availability must contain finite nonnegative minutes");
  }
  const windows = sessionWindows(o, date);
  const limits = [day, windows.length ? windows.reduce((sum, w) => sum + w.max_minutes, 0) : o.session_duration_max].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);
  const available = Array.isArray(o.days) ? o.days : [];
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${date}T12:00:00Z`).getUTCDay()];
  if (available.length && !available.includes(weekday)) return 0;
  if (Array.isArray(o.day_availability) && o.day_availability.length && day === null) return 0;
  return limits.length ? Math.min(...limits) : null;
}
export function explicitImplements(o: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(o.implements)) return o.implements.filter((v): v is string => typeof v === "string");
  if (Array.isArray(o.equipment_list) && o.equipment_list.length && !o.equipment_list.includes("Full gym")) {
    const names: Record<string, string> = { "Barbell": "barbell", "Dumbbells": "dumbbells", "Kettlebells": "kettlebell", "Squat rack": "rack", "Bench": "stable_bench", "Pull-up bar": "pullup_bar", "Resistance bands": "resistance_band", "Band anchor": "band_anchor", "Cable machine": "cable_machine", "Treadmill": "treadmill", "Indoor trainer": "indoor_trainer", "Stationary bike": "stationary_bike", "Power meter": "power_meter" };
    return o.equipment_list.flatMap(v => typeof v === "string" && names[v] ? [names[v]] : []);
  }
  return undefined; // Legacy tiers do not prove individual implement ownership.
}
export function availableImplements(o: Record<string, unknown>): string[] {
  const declared = explicitImplements(o);
  if (declared) return declared;
  // Compatibility for existing profiles. New inventory selections override
  // this declared gym bundle, including an explicitly empty inventory.
  const tier = String(o.equipment ?? "").toLowerCase();
  return tier === "full gym" ? ["barbell", "rack", "stable_bench", "dumbbells", "kettlebell", "pullup_bar", "dip_bars", "cable_machine"] :
    tier === "barbell + rack" ? ["barbell", "rack"] : tier === "dumbbells" ? ["dumbbells"] : tier === "resistance bands" ? ["resistance_band"] : [];
}
export async function sessionState(admin: SupabaseClient, owner: string, o: Record<string, unknown>, date: string, sport: TrainingSport, requestedMinutes?: number, slot = 0): Promise<SessionState> {
  const since = new Date(Date.parse(date) - 28 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await admin.from("effective_activities").select("id,date,type,duration_seconds,data_json,planned_workout_id,session_group_id").eq("user_id", owner).gte("date", since).lte("date", date);
  if (error) throw new Error(`Cannot read actual training: ${error.message}`);
  const { data: feedback, error: feedbackError } = await admin.from("workout_feedback")
    .select("id,planned_workout_id,completed,actual_rpe,difficulty,created_at,date,reason,outcome,actual_minutes,pain_area,soreness_area,enjoyment,is_retraction,planned_workouts(type)").eq("user_id", owner).gte("date", since).lte("date", date).order("created_at", { ascending: false });
  if (feedbackError) throw new Error("Cannot read athlete response history");
  const byPlan = new Map<string, { actual_rpe?: number; difficulty?: string; reason?: string; outcome?: string; actual_minutes?: number }>();
  for (const f of feedback ?? []) if (f.planned_workout_id && !byPlan.has(f.planned_workout_id)) {
    if(f.is_retraction) byPlan.set(f.planned_workout_id,{});
    else if(f.completed||f.actual_rpe!=null||f.difficulty!=null||f.actual_minutes!=null||f.reason&&f.reason!=="unknown") byPlan.set(f.planned_workout_id,f);
  }
  const observations: ActualExposure[] = (data ?? []).map(a => ({ id: a.id, planned_workout_id: a.planned_workout_id, date: a.date,
    sport: ["run", "ride", "swim", "strength"].find(s => activityMatchesPlanned(s, a.type)) ?? String(a.type).toLowerCase(),
    reported_minutes: byPlan.get(a.planned_workout_id)?.actual_minutes ?? null,
    ...combineEffort(byPlan.get(a.planned_workout_id)?.actual_rpe,a.data_json?.icu_rpe),
    minutes: typeof a.duration_seconds === "number" ? a.duration_seconds / 60 : null,
    response: byPlan.get(a.planned_workout_id)?.reason === "pain" ? "pain" : byPlan.get(a.planned_workout_id)?.difficulty === "too_hard" ? "difficult" :
      ["too_easy", "just_right"].includes(byPlan.get(a.planned_workout_id)?.difficulty ?? "") ? "comfortable" : "unknown",
    effort: combineEffort(byPlan.get(a.planned_workout_id)?.actual_rpe,a.data_json?.icu_rpe).effort }));
  for (const a of observations) if (a.effort_conflict && a.response === "comfortable") a.response = "unknown";
  // Explicit multipart groups are one exposure. Unknown duration/effort in a
  // fragment stays unknown for the group, rather than fabricating full dose.
  const grouped = new Map<string, ActualExposure[]>();
  observations.forEach((a, index) => {
    const key = data?.[index]?.session_group_id ? `group:${data[index].session_group_id}:${a.sport}` : a.id;
    grouped.set(key, [...(grouped.get(key) ?? []), a]);
  });
  const actual: ActualExposure[] = [...grouped.entries()].map(([id, parts]) => ({ ...parts[0], id,
    date: parts.map(p => p.date).sort().at(-1)!,
    minutes: parts.every(p => p.minutes !== null) ? parts.reduce((sum, p) => sum + p.minutes!, 0) : null,
    effort: parts.every(p => p.effort !== null) ? Math.max(...parts.map(p => p.effort!)) : null,
    response: parts.some(p => p.response === "pain") ? "pain" : parts.some(p => p.response === "difficult") ? "difficult" : parts.every(p => p.response === "comfortable") ? "comfortable" : "unknown",
  }));
  // A dated athlete report can supply actual dose without inventing a device
  // recording. Latest report per plan only; a later linked import replaces this
  // fallback, so one session cannot count twice.
  const seenReports=new Set<string>();
  for(const f of feedback??[]) {
    if(!f.planned_workout_id||seenReports.has(f.planned_workout_id))continue;
    if(f.is_retraction){seenReports.add(f.planned_workout_id);continue;}
    if(f.outcome==="unknown"&&f.reason==="unknown"&&f.actual_minutes==null&&f.actual_rpe==null&&f.difficulty==null)continue;
    seenReports.add(f.planned_workout_id);
    if(!f.completed||f.outcome==="skipped"||typeof f.actual_minutes!=="number"||f.actual_minutes<=0||actual.some(a=>a.planned_workout_id===f.planned_workout_id))continue;
    const linked=Array.isArray(f.planned_workouts)?f.planned_workouts[0]:f.planned_workouts;
    const sport=f.outcome==="substituted"?"other":linked?.type??"other";
    actual.push({id:`report:${f.id}`,planned_workout_id:f.planned_workout_id,date:f.date,sport,minutes:f.actual_minutes,reported_minutes:f.actual_minutes,...combineEffort(f.actual_rpe,null),
      response:f.reason==="pain"?"pain":f.reason==="fatigue"||f.difficulty==="too_hard"?"difficult":["too_easy","just_right"].includes(f.difficulty??"")?"comfortable":"unknown"});
  }
  const { data: tests, error: testError } = await admin.from("threshold_tests").select("date,kind,value").eq("user_id", owner).lte("date", date).order("date", { ascending: false });
  if (testError) throw new Error("Cannot read calibration provenance");
  const calibration: NonNullable<SessionState["calibration"]> = (tests ?? []).flatMap<Calibration>(test =>
    test.kind === "ftp" ? [{ sport: "ride" as const, kind: "power" as const, value: Number(test.value), date: test.date, reliability: "measured" as const }] :
      test.kind === "threshold_pace" ? [{ sport: "run" as const, kind: "pace" as const, value: Number(test.value), date: test.date, reliability: "measured" as const }] : []);
  if (Array.isArray(o.calibrations)) for (const c of o.calibrations as Calibration[]) {
    if (["run", "ride", "swim"].includes(c.sport) && ["power", "heart_rate", "pace", "personal_best"].includes(c.kind) && Number.isFinite(c.value) && ["measured", "estimated", "unknown"].includes(c.reliability)) calibration.push(c);
  }
  const last_loads: NonNullable<SessionState["last_loads"]> = {};
  if (sport === "strength") {
    const loadSince = new Date(Date.parse(date) - 90 * 86400000).toISOString().slice(0, 10);
    const { data: logs, error: logError } = await admin.from("strength_logs").select("exercise_name,sets,date").eq("user_id", owner).gte("date", loadSince).lte("date", date).order("date", { ascending: false });
    if (logError) throw new Error("Cannot read exercise-specific load history");
    for (const log of logs ?? []) {
      const id = exerciseId(log.exercise_name);
      if (last_loads[id]) continue;
      const weights = (Array.isArray(log.sets) ? log.sets : []).filter(set => !set.is_warmup && Number(set.reps) > 0)
        .map(set => typeof set.weight_kg === "number" || typeof set.weight_kg === "string" && set.weight_kg.trim() ? Number(set.weight_kg) : NaN)
        .filter(w => Number.isFinite(w) && w >= 0 && w <= 500);
      const entry = EXERCISE_CATALOG.find(e=>e.name===log.exercise_name);
      if (weights.length && entry && !["bodyweight","band"].includes(requirements(entry).load_mode))
        last_loads[id] = { date: log.date, weight_kg: requirements(entry).load_mode === "assistance" ? Math.max(...weights) : Math.min(...weights), reps: Number((log.sets as {reps:number}[]).filter(set=>Number(set.reps)>0)[0]?.reps) || undefined };
    }
  }
  for (const lift of startingLiftReferences(o)) {
    const id = exerciseId(lift.exercise), previous = last_loads[id];
    if (!previous || Date.parse(date) - Date.parse(previous.date) >= SESSION_POLICY.interruptionDays * 86400000)
      last_loads[id] = { date, weight_kg: lift.weight_kg, reps: lift.reps, source: "reported" };
  }
  const safetyRules = activeSafetyRules(injuriesOf(o));
  const excludedExercises = EXERCISE_CATALOG.filter(e => safetyRules.some(r => r.forbid.test(e.name))).map(e => exerciseId(e.name));
  const experience = experienceForSport(o, sport);
  const slotCap = slotMinutes(o, date, slot);
  const cap = Math.min(dailyMinutes(o, date) ?? 1440, slotCap ?? 1440, typeof o.session_duration_max === "number" ? o.session_duration_max : 1440);
  const minutes = typeof requestedMinutes === "number" ? requestedMinutes : minutesForDate(o, date) ?? (typeof o.session_duration === "number" ? o.session_duration : 30);
  // Profile JSON uses null for an unanswered optional timing field. The
  // engine uses absence to mean unknown; never manufacture a measured pace.
  // A swim configuration must also not invalidate another sport's session.
  const rawPool = o.pool;
  const pool = sport === "swim" && rawPool && typeof rawPool === "object" && !Array.isArray(rawPool)
    ? { ...rawPool, seconds_per_length: (rawPool as Record<string, unknown>).seconds_per_length ?? undefined } as SessionState["pool"]
    : undefined;
  const venueOptions = ["unspecified", "road", "trail", "treadmill", "indoor", "gravel", "mtb", "pool", "open_water"];
  const venues = o.venues && typeof o.venues === "object" ? o.venues as Record<string, unknown> : {};
  const venue = venueOptions.includes(String(venues[sport])) ? venues[sport] as SessionState["venue"] : sport === "swim" ? "pool" : "unspecified";
  const { data: wellness, error: wellnessError } = await admin.from("wellness_checkins").select("date,energy,soreness,sleep_score,hrv_rmssd,resting_hr,zepp_sleep_minutes").eq("user_id", owner).gte("date",since).lte("date",date).order("date",{ascending:false});
  if (wellnessError) throw new Error("Cannot read recovery observations");
  const checkin = wellness?.find(w=>w.date===date);
  const {data: rawHolds,error: holdError}=await admin.from("training_holds").select("id,reason,sport,start_date,until_date,active").eq("user_id",owner).eq("active",true).lte("start_date",date);
  if(holdError) throw new Error("Cannot read training holds");
  const holds=(rawHolds??[]).filter(h=>!h.until_date||h.until_date>=date);
  const chrono=[...(wellness??[])].reverse();
  const readiness=readinessContext(date,wellness??[],actual,holds.filter(h=>sport==="rest"||!h.sport||h.sport===sport),chrono.filter(w=>typeof w.hrv_rmssd==="number").map(w=>({date:w.date,value:w.hrv_rmssd})),chrono.filter(w=>typeof w.resting_hr==="number").map(w=>({date:w.date,value:w.resting_hr})));
  const fatigue: SessionState["fatigue"] = checkin && (checkin.energy != null && checkin.energy < 3 || checkin.soreness != null && checkin.soreness >= 4) ? "high" :
    checkin && checkin.energy != null && checkin.energy >= 3 && checkin.soreness != null && checkin.soreness <= 2 ? "normal" : "unknown";
  // Explicit profile confirmation is needed; an empty feed is not proof of a
  // sedentary month. This may be set by the athlete after reviewing history.
  const { data: sync, error: syncError } = await admin.from("activity_sync_state").select("source,last_attempt_at,last_success_at,last_error,coverage_from").eq("user_id", owner);
  if (syncError) throw new Error("Cannot establish training feed freshness");
  const historyIssues = (sync ?? []).filter(row => {
    const success = Date.parse(row.last_success_at ?? "");
    return !!row.last_error || !Number.isFinite(success) || Date.now() - success > SESSION_POLICY.syncMaxAgeHours * 3600000 ||
      Date.parse(row.last_attempt_at ?? "") > success || !row.coverage_from || row.coverage_from > since;
  }).map(row => `${row.source} history is stale, incomplete or unavailable; it cannot authorize progression.`);
  const historyComplete = o.training_history_confirmed === true && historyIssues.length === 0;
  const { data: events, error: eventError } = await admin.from("races").select("name,date,sport,priority").eq("user_id", owner).gte("date", date).order("date", { ascending: true });
  if (eventError) throw new Error("Cannot read dated event constraints");
  const programState = deriveProgramState(date, programGoals(o, [sport], events ?? []), actual, historyComplete, o);
  let program = programState.sports[0];
  if(holds.some(h=>!h.sport||h.sport===sport)&&sport!=="rest") { program={...program,phase:"reassess",decision:"reassess",quality_allowed:false,reason:"A reported pain/illness planning hold needs explicit review before resuming affected training."};programState.sports[0]=program; }
  return { date, sport, program, program_state: programState, max_minutes: Math.min(minutes, cap ?? minutes), weekly_remaining_minutes: minutes,
    experience: ["Beginner", "Intermediate", "Advanced"].includes(experience) ? experience as SessionState["experience"] : "Beginner",
    actual, history_complete: historyComplete, history_issues: historyIssues, excluded_exercises: excludedExercises,
    implements: availableImplements(o), venue, pool, open_water: o.open_water as SessionState["open_water"], split_style: String(o.split_style ?? ""),
    fatigue: readiness.status === "caution" || readiness.status === "pause" ? "high" : fatigue, readiness, calibration, blocked_sports: holds.filter(h=>!h.sport||h.sport===sport).length && sport !== "rest" ? [sport] : [], last_loads };
}

export async function remainingWeekMinutes(admin: SupabaseClient, owner: string, o: Record<string, unknown>, date: string, replacing: Set<string>, actual: ActualExposure[] = []): Promise<number> {
  const maximum = o.weekly_minutes_max;
  if (typeof maximum !== "number" || !Number.isFinite(maximum) || maximum < 0) return 10080;
  const start = new Date(`${date}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  const from = start.toISOString().slice(0, 10), to = new Date(start.getTime() + 6 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await admin.from("reconciled_session_plans").select("id,date,session_slot,transition_before_seconds,workout_json,skipped").eq("user_id", owner).gte("date", from).lte("date", to);
  if (error) throw new Error("Cannot read committed weekly time");
  const retained = (data ?? []).filter(r => !r.skipped && !replacing.has(slotKey(r.date, r.session_slot)) && !replacing.has(r.date));
  const used = retained.reduce((sum, r) => sum + Number(r.workout_json?.duration_minutes ?? 0) + Number(r.transition_before_seconds ?? 0) / 60, 0);
  if (!Number.isFinite(used)) throw new Error("Existing weekly dose is invalid");
  const represented = new Set(retained.map(r=>r.id).filter(Boolean));
  const completed = actual.filter(a=>a.date>=from && a.date<=to && !represented.has(a.planned_workout_id) && a.minutes !== null && Number.isFinite(a.minutes) && a.minutes>0).reduce((sum,a)=>sum+a.minutes!,0);
  return Math.max(0, maximum - used - completed);
}

/** Date-specific forecasts remain separate from measured readiness. */
export async function withForecast(state: SessionState, profile: { last_lat?: number | null; last_lon?: number | null }): Promise<SessionState> {
  if (["run", "ride"].includes(state.sport) && typeof profile.last_lat === "number" && typeof profile.last_lon === "number") {
    const forecast = await getForecastWeather(profile.last_lat, profile.last_lon, state.date);
    if (forecast) return { ...state, conditions: { date: state.date, ...assessViability(forecast, state.sport as "run" | "ride") } };
  }
  return state;
}
