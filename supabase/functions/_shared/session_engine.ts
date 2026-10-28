import { openWaterIssue, type OpenWaterChecks } from "./open_water.ts";
import { calibratedBlocks } from "./target_selection.ts";
import { SPORT_OBJECTIVES } from "../../../shared/prescription.ts";
import type { SportProgress, ProgramState } from "./program_state.ts";
import { z } from "npm:zod@3.23.8";
/** Pure candidate construction. Numerical defaults are versioned product
 * policies, NOT independently coach-validated population recommendations. */
import type { EnduranceBlock, PrescriptionBlock, SessionObjective, SessionPrescription, TrainingSport } from "../../../shared/prescription.ts";
import { eligibleExercises, requirements } from "./exercise_requirements.ts";
import { prescriptionTotals, prescriptionWorkout } from "./prescription.ts";
import type { Workout } from "./types.ts";

export class SessionUnavailable extends Error {}

export const SESSION_POLICY = {
  version: "session-3", calibrationMaxAgeDays: 90, interruptionDays: 14,
  familiarizationMinutes: { run: 20, ride: 30, swim: 20, strength: 30, rest: 10 },
  minimumExposuresForQuality: 6, minimumQualityMinutes: 25, syncMaxAgeHours: 48,
} as const;
export interface ActualExposure {
  reported_minutes?: number | null;
  reported_effort?: number | null;
  provider_effort?: number | null;
  effort_conflict?: boolean;
  planned_workout_id?: string | null;
  id: string;
  date: string;
  sport: string;
  minutes: number | null;
  effort: number | null;
  response?: "comfortable" | "difficult" | "pain" | "unknown";
}
export interface Calibration {
  sport: TrainingSport;
  kind: "power" | "heart_rate" | "pace" | "personal_best";
  value: number;
  date: string;
  reliability: "measured" | "estimated" | "unknown";
}
export interface SessionState {
  date: string;
  sport: TrainingSport;
  max_minutes: number;
  weekly_remaining_minutes: number;
  experience: "Beginner" | "Intermediate" | "Advanced";
  actual: ActualExposure[];
  history_complete: boolean;
  history_issues?: string[];
  implements: string[];
  venue: "unspecified" | "road" | "trail" | "treadmill" | "indoor" | "gravel" | "mtb" | "pool" | "open_water";
  open_water?: OpenWaterChecks;
  split_style?: string;
  session_number?: number;
  pool?: { length: number; unit: "m" | "yd"; strokes: string[]; seconds_per_length?: number };
  calibration?: Calibration[];
  readiness?: ReturnType<typeof import("./readiness_context.ts").readinessContext>;
  fatigue: "normal" | "high" | "unknown";
  blocked_sports: TrainingSport[];
  excluded_exercises?: string[];
  remaining_sets?: Record<string, number>;
  conditions?: { date: string; tier: "ok" | "caution" | "blocked"; reasons: string[] };
  program_state?: ProgramState;
  program?: SportProgress;
  last_loads?: Record<string, { weight_kg: number; date: string; reps?: number; source?: "reported" }>;
}
export interface TemplateDefinition { id: string; sport: TrainingSport; objective: SessionObjective; demanding: boolean }
export const SESSION_TEMPLATES: TemplateDefinition[] = Object.entries(SPORT_OBJECTIVES).flatMap(([sport, values]) =>
  values.map(objective => ({ id: `${sport}.${objective}.v1`, sport: sport as TrainingSport, objective,
    demanding: ["long", "strides", "hills", "tempo", "threshold", "intervals", "hypertrophy"].includes(objective) })));
const age = (now: string, then: string) => (Date.parse(now) - Date.parse(then)) / 86400000;
export function usableCalibration(c: Calibration, state: SessionState): boolean {
  const days = age(state.date, c.date);
  return c.kind !== "personal_best" && c.sport === state.sport && c.reliability === "measured" && Number.isFinite(c.value) && c.value > 0 &&
    days >= 0 && days <= SESSION_POLICY.calibrationMaxAgeDays &&
    (c.kind !== "power" || state.implements.includes("power_meter"));
}
function exposures(state: SessionState): ActualExposure[] {
  const seen = new Set<string>();
  return state.actual.filter(a => {
    if (seen.has(a.id) || !a.id) return false;
    seen.add(a.id);
    return a.sport === state.sport && age(state.date, a.date) >= 0 && age(state.date, a.date) < 28 &&
      a.minutes !== null && Number.isFinite(a.minutes) && a.minutes > 0;
  }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
const qualityDays = (s: SessionState) => new Set(exposures(s).filter(a=>a.minutes!>=10).map(a=>a.date)).size;
export function rejectTemplate(t: TemplateDefinition, s: SessionState): string | null {
  if (s.blocked_sports.includes(t.sport) && t.objective !== "rest") return "Sport is currently restricted";
  if (t.sport === "swim" && s.venue === "open_water") {
    const issue = openWaterIssue(s.open_water, s.date);
    if (issue) return issue;
    if (!s.history_complete || qualityDays(s) < SESSION_POLICY.minimumExposuresForQuality || s.experience === "Beginner" || !["easy", "recovery"].includes(t.objective)) return "Open-water templates require established swimming exposure and use easy effort only";
  }
  if (t.sport === "swim" && s.venue !== "open_water" && (!s.pool || !(s.pool.length > 0) || !s.pool.strokes.length)) return "Pool length, units and a supported stroke are required";
  if (t.sport === "swim" && ["threshold", "intervals", "long"].includes(t.objective) && !s.pool?.seconds_per_length) return "A comfortable pool-length time is needed to estimate distance-based work";
  if (t.objective === "hills" && !["trail", "road", "treadmill"].includes(s.venue)) return "Hill venue is not confirmed";
  if (t.demanding && t.sport !== "strength" && (!s.history_complete || qualityDays(s) < SESSION_POLICY.minimumExposuresForQuality || s.experience === "Beginner")) return "Insufficient recent sport-specific exposure for this template";
  if (t.demanding && s.conditions?.date === s.date && s.conditions.tier === "caution" && !["indoor", "treadmill", "pool"].includes(s.venue)) return "Outdoor conditions favor easy effort rather than quality work";
  if (t.demanding && t.sport !== "strength" && s.program && !s.program.quality_allowed) return "Program state does not support quality work";
  if (s.program?.phase === "reassess" && s.actual.some(a => a.response === "pain" && age(s.date, a.date) < 7)) return "Pain feedback requires reassessment before a training session";
  if (t.demanding && t.sport !== "strength" && (s.fatigue === "high" || s.fatigue === "unknown" && (!s.program?.quality_allowed || !(exposures(s).length >= 2 && exposures(s).slice(0, 2).every(a => a.response === "comfortable"))))) return "Recovery does not support a demanding session";
  if (t.demanding && Math.min(s.max_minutes, s.weekly_remaining_minutes) < SESSION_POLICY.minimumQualityMinutes) return "Insufficient time for preparation, work and recovery";
  const recentHard = s.actual.some(a => age(s.date, a.date) >= 0 && age(s.date, a.date) < 2 &&
    (a.effort !== null && a.effort >= 7 || a.response === "pain"));
  if (t.demanding && recentHard) return "Recent actual demanding work takes priority across sports";
  return null;
}
const rpe = (min: number, max = min) => ({ kind: "rpe" as const, min, max });
function timed(role: EnduranceBlock["role"], label: string, seconds: number, effort: number): EnduranceBlock {
  return { kind: "endurance", role, label, repetitions: 1, work_seconds: seconds, recovery_seconds: 0,
    recovery_mode: "easy", recovery_after_last: false, transition_seconds: 0, target: rpe(effort) };
}
/** Explicit sport recipes. Numbers are conservative versioned template
 * defaults, bounded by actual exposure and independently checked dose totals. */
function enduranceBlocks(t: TemplateDefinition, s: SessionState, budget: number): PrescriptionBlock[] {
  if (s.sport === "swim") return poolBlocks(t, s, budget);
  const warm = Math.min(s.sport === "ride" ? 600 : 480, Math.floor(budget * 0.2));
  const cool = Math.min(300, Math.floor(budget * 0.15));
  const main = budget - warm - cool;
  const blocks: EnduranceBlock[] = [timed("warmup", "Easy warm-up", warm, 2)];
  const running: Partial<Record<SessionObjective, { work: number; rest: number; count: number; effort: number; label: string }>> = {
    threshold: { work: 300, rest: 90, count: 3, effort: 7, label: "Controlled threshold repetitions" },
    tempo: { work: 600, rest: 120, count: 2, effort: 6, label: "Comfortably hard tempo" },
    intervals: { work: 120, rest: 120, count: 5, effort: 8, label: "Controlled fast repetitions, no sprinting" },
    hills: { work: 30, rest: 90, count: 6, effort: 7, label: "Uphill effort; recover easily before repeating" },
    strides: { work: 15, rest: 75, count: 6, effort: 6, label: "Relaxed acceleration, maintain control" },
    run_walk: { work: 60, rest: 60, count: 100, effort: 3, label: "Comfortable run followed by walking" },
    technique: { work: 20, rest: 80, count: 4, effort: 3, label: "Relaxed posture and quiet, comfortable steps" },
  };
  const cycling: Partial<Record<SessionObjective, { work: number; rest: number; count: number; effort: number; label: string }>> = {
    tempo: { work: 480, rest: 180, count: 2, effort: 6, label: "Steady purposeful tempo" },
    threshold: { work: 300, rest: 180, count: 3, effort: 7, label: "Controlled threshold efforts" },
    intervals: { work: 120, rest: 180, count: 4, effort: 8, label: "Hard, controlled efforts with easy pedalling recovery" },
    technique: { work: 60, rest: 60, count: 6, effort: 3, label: "Smooth relaxed cadence, remain stable in the saddle" },
  };
  const recipe = (s.sport === "ride" ? cycling : running)[t.objective];
  if (recipe) {
    const repetitions = Math.min(recipe.count, Math.floor(main / (recipe.work + recipe.rest)));
    if (repetitions < 1) throw new SessionUnavailable("Not enough time for a complete work/recovery pair");
    blocks.push({ ...timed("main", recipe.label, recipe.work, recipe.effort), repetitions,
      recovery_seconds: recipe.rest, recovery_after_last: true, recovery_mode: t.objective === "run_walk" ? "walk" : "easy" });
    const spare = main - repetitions * (recipe.work + recipe.rest);
    if (spare > 0) blocks.push(timed("main", "Easy continuation", spare, 3));
  } else blocks.push(timed("main", t.objective === "long" ? `Steady endurance ${s.sport === "run" ? "run" : "ride"}` : `Steady easy ${s.sport === "run" ? "run" : "ride"}`, main, t.objective === "recovery" ? 2 : 3));
  blocks.push(timed("cooldown", "Easy cool-down", cool, 2));
  return blocks;
}
function poolBlocks(t: TemplateDefinition, s: SessionState, budget: number): EnduranceBlock[] {
  if (s.venue === "open_water") {
    const warm = Math.floor(budget * 0.2), cool = Math.floor(budget * 0.15);
    return [timed("warmup", "Easy start at the confirmed supervised venue", warm, 2), timed("main", "Comfortable swimming within the venue-approved area; stop if conditions change", budget - warm - cool, 3), timed("cooldown", "Easy cool-down", cool, 2)]
      .map(b => ({ ...b, stroke: s.open_water!.stroke, recovery_mode: "stationary" as const }));
  }
  const pool = s.pool!;
  // Without an observed/self-reported length time, prescribe timed swimming
  // with unknown distance. A guessed pace must not manufacture a pool total.
  if (!pool.seconds_per_length) {
    if (["threshold", "intervals", "long"].includes(t.objective)) throw new SessionUnavailable("A comfortable pool-length time is needed to estimate this distance-based session");
    const warm = Math.floor(budget * 0.2), cool = Math.floor(budget * 0.15);
    return [timed("warmup", "Easy swimming; finish at a wall", warm, 2),
      { ...timed("main", "Comfortable swimming; pause at a wall when needed", Math.floor((budget - warm - cool) / 4) - 20, 3), repetitions: 4,
        recovery_seconds: 20, recovery_after_last: true, recovery_mode: "stationary" as const },
      timed("cooldown", "Easy swimming; finish at a wall", cool, 2)].map(b => ({ ...b, stroke: pool.strokes[0], recovery_mode: "stationary" as const }));
  }
  const perLength = pool.seconds_per_length;
  const make = (role: EnduranceBlock["role"], label: string, lengths: number, repetitions: number, rest: number, effort: number): EnduranceBlock => ({
    ...timed(role, label, lengths * perLength, effort), repetitions, recovery_seconds: rest, recovery_mode: "stationary", recovery_after_last: false,
    distance: { value: lengths * pool.length, unit: pool.unit }, stroke: pool.strokes[0], transition_seconds: 20,
  });
  const warm = make("warmup", "Easy lengths", 1, 2, 20, 2);
  const cool = make("cooldown", "Relaxed finish", 1, 2, 20, 2);
  const remaining = budget - prescriptionTotals([warm, cool]).seconds;
  const lengths = t.objective === "technique" ? 1 : t.objective === "threshold" || t.objective === "long" ? 4 : 2;
  const rest = t.objective === "technique" || t.objective === "intervals" ? 30 : 20;
  const repetitions = Math.min(16, Math.floor((remaining - 20 + rest) / (lengths * perLength + rest)));
  if (repetitions < 1) throw new SessionUnavailable("Time budget is too short for warm-up, complete pool lengths and cool-down");
  const main = make("main", t.objective === "technique" ? "Familiar stroke with relaxed breathing" : "Repeat complete pool lengths", lengths, repetitions, rest,
    t.objective === "threshold" ? 7 : t.objective === "intervals" ? 8 : t.objective === "recovery" ? 2 : 3);
  if (t.objective === "technique") main.drill = "Use only a stroke and breathing pattern you already know; no breath-holding drills";
  return [warm, main, cool];
}

/** Shared by construction and the model's allowed-choice prompt. */
export function eligibleSessionExercises(s: Pick<SessionState, "implements" | "excluded_exercises" | "experience">) {
  const levels = ["Beginner", "Intermediate", "Advanced"];
  return eligibleExercises(s.implements).filter(e => !s.excluded_exercises?.includes(requirements(e).id) && levels.indexOf(requirements(e).difficulty) <= levels.indexOf(s.experience));
}

function strengthBlocks(t: TemplateDefinition, s: SessionState, budget: number): PrescriptionBlock[] {
  const available = eligibleSessionExercises(s);
  const blocks: PrescriptionBlock[] = [];
  const split = String(s.split_style ?? "").toLowerCase();
  const index = s.session_number ?? s.actual.filter(a => a.sport === "strength").length;
  const patterns = /upper.*lower/.test(split) ? index % 2 === 0 ? ["horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "accessory"] : ["squat", "hinge", "lunge", "core"] :
    /push.*pull.*leg/.test(split) ? [["horizontal_push", "vertical_push", "accessory"], ["horizontal_pull", "vertical_pull", "core"], ["squat", "hinge", "lunge", "core"]][index % 3] :
      ["squat", "horizontal_push", "horizontal_pull", "hinge", "core", ...(t.objective === "hypertrophy" ? ["accessory"] : [])];
  for (const pattern of patterns) {
    const matching = available.filter(e => requirements(e).movement === pattern && requirements(e).logging !== "distance");
    const budgeted = matching.filter(e => s.remaining_sets?.[e.muscle] !== 0);
    // Catalogue order is not a difficulty prescription. Prefer familiar lifts,
    // then scalable gym movements for an experienced athlete.
    const preferred: Record<string, string[]> = {
      squat: ["Back Squat", "Goblet Squat", "Kettlebell Goblet Squat"],
      horizontal_push: ["Barbell Bench Press", "Dumbbell Bench Press", "Dumbbell Floor Press", "Push-Up"],
      horizontal_pull: ["Chest-Supported Dumbbell Row", "Dumbbell Row", "Resistance Band Row"],
      hinge: ["Romanian Deadlift", "Romanian Deadlift (Dumbbell)", "Hip Thrust (Dumbbell)", "Glute Bridge (Bodyweight)"],
      core: ["Side Plank", "Dead Bug"],
    };
    const familiar = budgeted.filter(e => s.last_loads?.[requirements(e).id])
      .sort((a,b) => s.last_loads![requirements(b).id].date.localeCompare(s.last_loads![requirements(a).id].date));
    const e = familiar[0] ?? (s.experience !== "Beginner" ? preferred[pattern]?.map(name=>budgeted.find(e=>e.name===name)).find(Boolean) : undefined) ?? budgeted[0];
    if (!e) continue;
    const meta = requirements(e);
    const last = s.last_loads?.[meta.id];
    const reps = meta.logging === "seconds" ? null : t.objective === "hypertrophy" ? 10 : 6;
    // A recorded 6-rep load is not automatically a 10-rep load. No automatic
    // increase; missing wellness data does not erase known lifting ability.
    const repFactor = last?.reps && reps ? Math.min(1, (1 + last.reps / 30) / (1 + reps / 30)) : 1;
    const factor = repFactor * (s.fatigue === "high" ? 0.8 : 1);
    const load = !["bodyweight", "band"].includes(meta.load_mode) && last && age(s.date, last.date) >= 0 &&
      (last.source === "reported" || age(s.date, last.date) <= SESSION_POLICY.interruptionDays)
      ? meta.load_mode === "assistance" ? last.weight_kg : Math.floor(last.weight_kg * factor / 2.5) * 2.5 : null;
    const base = { kind: "strength" as const, exercise_id: meta.id, name: e.name, load_mode: meta.load_mode,
      reps,
      hold_seconds: meta.logging === "seconds" ? 20 : null, seconds_per_rep: 4,
      sides: (meta.unilateral ? 2 : 1) as 1 | 2, rest_seconds: 90, transition_seconds: 30 };
    const used = blocks.filter((b): b is import("../../../shared/prescription.ts").StrengthBlock => b.kind === "strength" && b.role === "main" && available.find(entry=>entry.name===b.name)?.muscle === e.muscle).reduce((sum,b)=>sum+b.sets,0);
    const remaining = Math.max(0, (s.remaining_sets?.[e.muscle] ?? 22) - used);
    if(remaining < 1) continue;
    const pair: PrescriptionBlock[] = [
      { ...base, role: "warmup", sets: 1, weight_kg: null, target: rpe(2, 3) },
      { ...base, role: "main", sets: Math.min(s.experience === "Beginner" || s.fatigue === "high" ? 2 : 3, remaining), weight_kg: load, target: s.experience === "Beginner" || s.fatigue === "high" ? rpe(5, 6) : rpe(7, 8) },
    ];
    if (prescriptionTotals([...blocks, ...pair]).seconds <= budget) blocks.push(...pair);
  }
  if (!blocks.length) throw new SessionUnavailable("No complete strength session fits the available implements and time");
  return blocks;
}
const StateSchema = z.object({
  date: z.string(), sport: z.enum(["run", "ride", "swim", "strength", "rest"]),
  max_minutes: z.number().finite().min(0).max(1440), weekly_remaining_minutes: z.number().finite().min(0).max(10080),
  experience: z.enum(["Beginner", "Intermediate", "Advanced"]), history_complete: z.boolean(),
  implements: z.array(z.string()), venue: z.enum(["unspecified", "road", "trail", "treadmill", "indoor", "gravel", "mtb", "pool", "open_water"]),
  pool: z.object({ length: z.number().finite().positive().max(100), unit: z.enum(["m", "yd"]),
    strokes: z.array(z.enum(["freestyle", "backstroke", "breaststroke", "butterfly"])).min(1), seconds_per_length: z.number().finite().positive().max(600).optional() }).optional(),
  fatigue: z.enum(["normal", "high", "unknown"]), blocked_sports: z.array(z.enum(["run", "ride", "swim", "strength", "rest"])),
  actual: z.array(z.object({ id: z.string(), date: z.string(), sport: z.string(), minutes: z.number().finite().min(0).nullable(),
    effort: z.number().finite().min(1).max(10).nullable(), response: z.enum(["comfortable", "difficult", "pain", "unknown"]).optional() })),
  last_loads: z.record(z.object({ weight_kg: z.number().finite().min(0).max(500), date: z.string() })).optional(),
}).passthrough();
export function resolveVenue(s: SessionState): { state: SessionState; reason: string | null } {
  let venueReason: string | null = null;
  if (s.sport === "swim" && s.venue === "open_water" && openWaterIssue(s.open_water, s.date) && s.pool) {
    s = { ...s, venue: "pool" };
    venueReason = "Open-water conditions are unconfirmed; use the configured pool alternative.";
  }
  if (s.conditions?.date === s.date && s.conditions.tier === "blocked" && ["run", "ride"].includes(s.sport) && !["indoor", "treadmill"].includes(s.venue)) {
    const implement = s.sport === "run" ? "treadmill" : "indoor_trainer";
    if (!s.implements.includes(implement) && !(s.sport === "ride" && s.implements.includes("stationary_bike"))) throw new SessionUnavailable(`Outdoor conditions block ${s.sport}; a confirmed ${implement} is needed for the indoor alternative`);
    s = { ...s, venue: s.sport === "run" ? "treadmill" : "indoor" };
    venueReason = `Use the available ${implement}: ${s.conditions!.reasons.join("; ")}.`;
  }
  if (s.sport === "run" && s.venue === "treadmill" && !s.implements.includes("treadmill")) throw new SessionUnavailable("Treadmill availability must be confirmed");
  if (s.sport === "ride" && s.venue === "indoor" && !s.implements.some(i => i === "indoor_trainer" || i === "stationary_bike")) throw new SessionUnavailable("Indoor cycling equipment must be confirmed");
  return { state: s, reason: venueReason };
}
export function buildSession(s: SessionState, requested: SessionObjective): Workout {
  StateSchema.parse(s);
  const resolved = resolveVenue(s); s = resolved.state;
  const venueReason = resolved.reason;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !Number.isFinite(Date.parse(s.date)) || new Date(s.date).toISOString().slice(0, 10) !== s.date) throw new Error("Invalid local date");
  if (![s.max_minutes, s.weekly_remaining_minutes].every(n => Number.isFinite(n) && n >= 0)) throw new Error("Invalid availability");
  const candidates = SESSION_TEMPLATES.filter(t => t.sport === s.sport);
  const preferred = candidates.find(t => t.objective === requested);
  if (!preferred) throw new Error(`Unsupported objective ${requested} for ${s.sport}`);
  const rejected = candidates.flatMap(t => { const reason = rejectTemplate(t, s); return reason ? [{ template_id: t.id, reason }] : []; });
  const allowed = candidates.filter(t => !rejected.some(r => r.template_id === t.id));
  const selected = allowed.find(t => t.id === preferred.id) ?? allowed.find(t => t.objective === (s.sport === "strength" ? "strength" : "easy"));
  if (!selected) throw new SessionUnavailable(rejected.find(r => r.template_id === preferred.id)?.reason ?? "No eligible template");
  let minutes = Math.min(s.max_minutes, s.weekly_remaining_minutes, s.venue === "open_water" ? s.open_water!.max_minutes : 1440);
  const observed = exposures(s);
  const meaningful = observed.filter(a=>a.minutes!>=10);
  const latest = meaningful.map(a => a.date).sort().at(-1);
  const familiarization = !s.history_complete || !latest || age(s.date, latest) >= SESSION_POLICY.interruptionDays;
  if (familiarization) minutes = Math.min(minutes, SESSION_POLICY.familiarizationMinutes[s.sport]);
  else if (s.sport !== "rest") minutes = Math.min(minutes, s.program?.session_minutes ?? meaningful.map(a=>a.minutes!).sort((a,b)=>a-b)[Math.floor((meaningful.length-1)/2)]);
  if (s.program && s.sport !== "rest") minutes = Math.min(minutes, s.program.session_minutes);
  const reasons = [selected.id === preferred.id ? `Selected ${selected.objective} for ${s.sport}.` : `Selected ${selected.objective}: ${rejected.find(r => r.template_id === preferred.id)?.reason}.`,
    familiarization ? "Familiarization dose: recent sport-specific history is missing or interrupted." : "Dose repeats observed sport-specific duration; unperformed plans create no training debt.",
    ...(s.program ? [s.program.reason] : []),
    ...(s.sport === "strength" && s.excluded_exercises?.length ? ["Exercise choices respect the restrictions recorded in your injury settings."] : []),
    ...(s.history_issues ?? []),
    ...(venueReason ? [venueReason] : []),
    "Effort targets are used; pace and power are not inferred from another sport."];
  if (s.calibration?.length) reasons.push(s.calibration.some(c => usableCalibration(c, s))
    ? "A recent sport-specific calibration is available; effort remains the prescribed target for this template."
    : "Stored calibration is stale, uncertain, for another sport or requires unavailable equipment; use effort targets.");
  if (s.sport === "swim" && s.venue === "pool") reasons.push(s.pool?.seconds_per_length ? `Pool duration is estimated using your ${s.pool.seconds_per_length} seconds per length; the estimated total includes rest and transitions.` : "Distance is unknown without a comfortable length time. Swim by effort and finish each repetition at a wall; duration is an estimate.");
  if (s.venue === "trail" || s.venue === "gravel" || s.venue === "mtb") reasons.push("Terrain, stops and coasting can change speed; follow effort rather than a fixed speed target.");
  let blocks: PrescriptionBlock[];
  if (selected.objective === "rest") blocks = [];
  else if (selected.objective === "optional_light" || selected.objective === "active_recovery") {
    if (minutes < 3) throw new SessionUnavailable("Recovery activity needs at least three available minutes");
    blocks = [{ kind: "recovery", role: "main", name: selected.objective === "optional_light" ? "Optional comfortable walk" : "Deliberately easy recovery movement", seconds: Math.min(minutes, 15) * 60, transition_seconds: 0, optional: selected.objective === "optional_light", target: rpe(1, 2) }];
  }
  else if (selected.objective === "mobility") {
    if (minutes < 3) throw new SessionUnavailable("Mobility requires at least three available minutes");
    blocks = ["Gentle shoulder circles", "Comfortable ankle circles", "Gentle standing trunk rotation"].map(name => ({ kind: "mobility", role: "main", name, seconds: 50, transition_seconds: 10 }));
  } else {
    if (minutes < 10) throw new SessionUnavailable("Available time is insufficient for this template");
    blocks = s.sport === "strength" ? strengthBlocks(selected, s, minutes * 60) : enduranceBlocks(selected, s, minutes * 60);
  }
  if (["run", "ride", "swim"].includes(s.sport)) blocks = calibratedBlocks(s, selected.objective, blocks as EnduranceBlock[]);
  const total = prescriptionTotals(blocks);
  const p: SessionPrescription = { version: 1, presentation_version: 4, policy_version: SESSION_POLICY.version, template_id: selected.id,
    sport: s.sport, objective: selected.objective, venue: s.venue, scheduled_date: s.date, open_water_checks: s.venue === "open_water" ? s.open_water : undefined, duration_seconds: total.seconds,
    duration_basis: s.sport === "strength" || s.sport === "swim" ? "estimated" : "timed", distance: total.distance, blocks, reasons, rejected };
  return prescriptionWorkout(p);
}

/** Give the interpreter the same limits the compiler will enforce, before it spends a generation. */
export function sessionProposalLimits(s: SessionState) {
  return {
    date: s.date, sport: s.sport,
    objectives: SESSION_TEMPLATES.filter(t=>t.sport===s.sport&&!rejectTemplate(t,s)).map(t=>t.objective),
    complete_session_minutes_max: Math.min(s.max_minutes,s.weekly_remaining_minutes,s.program?.session_minutes ?? s.max_minutes),
    progression_reason: s.program?.reason ?? null,
    recent_training: s.actual.filter(a=>a.sport===s.sport&&a.minutes!==null&&a.minutes>=10)
      .sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6)
      .map(a=>({date:a.date,minutes:a.minutes,effort:a.effort,response:a.response??"unknown"})),
    known_lifts: s.sport==="strength" ? s.last_loads : undefined,
    excluded_exercises: s.sport==="strength" ? s.excluded_exercises : undefined,
    allowed_strength_exercises: s.sport === "strength" ? eligibleExercises(s.implements)
      .filter(e => !s.excluded_exercises?.includes(requirements(e).id)).map(e => e.name) : undefined,
  };
}
