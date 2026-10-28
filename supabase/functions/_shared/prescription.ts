import { SPORT_OBJECTIVES } from "../../../shared/prescription.ts";
import { EXERCISE_CATALOG } from "./exercise_catalog.ts";
import { exerciseId } from "./exercise_requirements.ts";
import { z } from "npm:zod@3.23.8";
import type { PrescriptionBlock, SessionPrescription, NumericTarget } from "../../../shared/prescription.ts";
import type { Workout, WorkoutExercise } from "./types.ts";

const seconds = z.number().finite().min(0).max(86400);
const positive = z.number().finite().positive();
const role = z.enum(["warmup", "main", "cooldown"]);
const target = z.object({ kind: z.literal("rpe"), min: z.number().min(1).max(10), max: z.number().min(1).max(10) })
  .refine(t => t.min <= t.max, "Reversed effort range");
const distance = z.object({ value: positive, unit: z.enum(["m", "yd"]) });
const endurance = z.object({
  kind: z.literal("endurance"), role, label: z.string().min(1),
  repetitions: z.number().int().min(1).max(100), work_seconds: positive.max(86400),
  recovery_seconds: seconds, recovery_mode: z.enum(["easy", "walk", "stationary"]),
  recovery_after_last: z.boolean(), transition_seconds: seconds, target,
  intensity_zone: z.enum(["Z1", "Z2", "Z3", "Z4", "Z5"]).optional(),
  numeric_target: z.object({ kind: z.enum(["power_watts", "heart_rate_bpm", "pace_seconds_per_km", "pace_seconds_per_100m"]),
    min: positive, max: positive, calibration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), calibration_value: positive,
    reliability: z.literal("measured"), advisory: z.boolean() }).refine(t => t.min <= t.max, "Reversed numerical target").optional(),
  distance: distance.optional(), stroke: z.string().optional(), drill: z.string().optional(),
});
const strength = z.object({
  kind: z.literal("strength"), role, exercise_id: z.string().min(1), name: z.string().min(1),
  sets: z.number().int().min(1).max(20), reps: z.number().int().min(1).max(100).nullable(),
  reps_max: z.number().int().positive().max(100).optional(), distance_metres: positive.max(1000).optional(), seconds_per_metre: positive.max(10).optional(),
  load_mode: z.enum(["added_weight", "assistance", "band", "bodyweight"]).optional(), work_mode: z.enum(["repetitions", "hold", "carry", "amrap"]).optional(),
  hold_seconds: positive.max(3600).nullable(), seconds_per_rep: positive.max(30),
  sides: z.union([z.literal(1), z.literal(2)]), rest_seconds: seconds, transition_seconds: seconds,
  weight_kg: z.number().finite().min(0).max(500).nullable(), target,
}).refine(b => Number(b.reps !== null) + Number(b.hold_seconds !== null) + Number(b.distance_metres !== undefined) === 1 &&
  (b.distance_metres === undefined || b.seconds_per_metre !== undefined) && (b.reps_max === undefined || b.reps !== null && b.reps_max >= b.reps), "Choose repetitions, timed work or distance with matching units");
const recovery = z.object({ kind: z.literal("recovery"), role, name: z.string().min(1), seconds: positive.max(3600), transition_seconds: seconds, optional: z.boolean(), target });
const mobility = z.object({ kind: z.literal("mobility"), role, name: z.string().min(1), seconds: positive.max(3600), transition_seconds: seconds });
export const PrescriptionSchema = z.object({
  version: z.literal(1), presentation_version: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(), policy_version: z.string().min(1), template_id: z.string().min(1),
  sport: z.enum(["run", "ride", "swim", "strength", "rest"]),
  objective: z.enum(["easy", "recovery", "long", "run_walk", "strides", "hills", "tempo", "threshold", "intervals", "technique", "strength", "hypertrophy", "mobility", "optional_light", "active_recovery", "rest"]),
  scheduled_date: z.string().optional(), open_water_checks: z.object({ date: z.string(), experienced: z.boolean(), supervised_venue: z.boolean(), buddy: z.boolean(), venue_open: z.boolean(), conditions_approved_by_venue: z.boolean(), stroke: z.string(), max_minutes: positive }).optional(),
  venue: z.string(), duration_seconds: seconds, duration_basis: z.enum(["estimated", "timed"]),
  distance: distance.nullable(), blocks: z.array(z.union([endurance, strength, mobility, recovery])).max(100),
  reasons: z.array(z.string()), rejected: z.array(z.object({ template_id: z.string(), reason: z.string() })),
}).superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (!SPORT_OBJECTIVES[p.sport].includes(p.objective)) issue("Objective is not supported for this sport");
  if (["run", "ride", "swim"].includes(p.sport) && (!p.blocks.every(b => b.kind === "endurance") || !p.blocks.some(b => b.role === "warmup") || !p.blocks.some(b => b.role === "main") || !p.blocks.some(b => b.role === "cooldown"))) issue("Endurance sessions require warm-up, main work and cool-down");
  if (p.sport === "strength" && !p.blocks.every(b => b.kind === "strength")) issue("Strength sessions require strength dose blocks");
  if (["optional_light", "active_recovery"].includes(p.objective) && !p.blocks.every(b => b.kind === "recovery")) issue("Recovery activities require recovery dose blocks");
  if (p.blocks.some(b => b.kind === "mobility" || b.kind === "recovery") && p.sport !== "rest") issue("Recovery dose requires recovery sport");
  if (p.objective === "mobility" && !p.blocks.every(b => b.kind === "mobility")) issue("Mobility requires mobility dose blocks");
  if (p.objective === "rest") {
    if (p.sport !== "rest" || p.blocks.length) issue("Complete rest cannot contain training blocks");
  } else if (!p.blocks.length) issue("Missing executable blocks");
  for (const b of p.blocks) {
    if (b.kind === "strength" && (!EXERCISE_CATALOG.some(e => e.name === b.name) || b.exercise_id !== exerciseId(b.name))) issue("Strength block must reference its exact bundled catalog ID and name");
    if (b.kind === "strength" && p.sport !== "strength") issue("Strength dose requires strength sport");
    if (b.kind === "endurance" && !["run", "ride", "swim"].includes(p.sport)) issue("Endurance dose requires endurance sport");
    if (p.sport === "swim" && b.kind === "endurance" && !b.stroke) issue("Swimming requires an explicit stroke");
  }
  const totals = prescriptionTotals(p.blocks as PrescriptionBlock[]);
  if (Math.abs(totals.seconds - p.duration_seconds) > 0.001) issue("Duration does not equal work, recovery and transitions");
  if (JSON.stringify(totals.distance) !== JSON.stringify(p.distance)) issue("Distance does not equal the complete session dose");
});

export function blockSeconds(b: PrescriptionBlock): number {
  if (b.kind === "mobility" || b.kind === "recovery") return b.seconds + b.transition_seconds;
  if (b.kind === "endurance") return b.repetitions * b.work_seconds +
    (b.repetitions - (b.recovery_after_last ? 0 : 1)) * b.recovery_seconds + b.transition_seconds;
  return b.sets * b.sides * (b.hold_seconds ?? (b.distance_metres != null ? b.distance_metres * b.seconds_per_metre! : (b.reps_max ?? b.reps!) * b.seconds_per_rep)) +
    (b.sets - 1) * b.rest_seconds + b.transition_seconds;
}
/** A distance is only asserted when every movement has a known distance.
 * Timed recoveries make complete distance unknown; don't sum work alone. */
export function prescriptionTotals(blocks: PrescriptionBlock[]) {
  const seconds = blocks.reduce((sum, b) => sum + blockSeconds(b), 0);
  const moving = blocks.filter(b => b.kind === "endurance");
  const completeDistance = blocks.length > 0 && moving.length === blocks.length && moving.every(b =>
    b.distance && (b.recovery_mode === "stationary" || b.recovery_seconds === 0 || (b.repetitions === 1 && !b.recovery_after_last)));
  const unit = moving[0]?.distance?.unit;
  const distance = completeDistance && moving.every(b => b.distance?.unit === unit)
    ? { value: moving.reduce((sum, b) => sum + b.repetitions * b.distance!.value, 0), unit: unit! } : null;
  return { seconds, distance };
}

function numericLabel(t: NumericTarget): string {
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2,"0")}`;
  return t.kind === "power_watts" ? `Power ${t.min}–${t.max} W` : t.kind === "heart_rate_bpm" ? `Heart rate ${t.min}–${t.max} bpm` :
    `Pace ${clock(t.min)}–${clock(t.max)} ${t.kind === "pace_seconds_per_km" ? "/km" : "/100m"}`;
}
const effort = (b: { target: { min: number; max: number } }) => `RPE ${b.target.min}–${b.target.max}/10`;
export function prescriptionTitle(p: SessionPrescription): string {
  const names: Record<string,string> = { easy:"Easy",recovery:"Recovery",long:"Long",run_walk:"Run and walk",strides:"Easy run with strides",hills:"Hill repetitions",tempo:"Tempo",threshold:"Threshold",intervals:"Intervals",technique:"Technique",strength:"Strength training",hypertrophy:"Muscle-building strength",mobility:"Mobility and recovery",optional_light:"Optional easy movement",active_recovery:"Active recovery",rest:"Rest day" };
  if(p.sport === "rest" || p.sport === "strength" || p.objective === "run_walk" || p.objective === "strides") return names[p.objective];
  const sport={run:"run",ride:"ride",swim:"swim"}[p.sport];
  return `${names[p.objective]} ${sport}`;
}
function coachSummary(p: SessionPrescription): string {
  if(p.sport === "rest") return p.reasons.find(r=>r.startsWith("Rest day:")) ?? (p.objective === "rest" ? "Take a rest day. No workout needs to be made up." : "Keep this recovery session comfortable and optional if you feel worse.");
  const intro = p.sport === "strength" ? "Warm-up sets prepare each movement; the working sets are your main training. Keep the listed rests between sets."
    : ["tempo","threshold","intervals","hills"].includes(p.objective) ? "Keep each effort controlled and take the full recovery between repetitions." : "Keep a comfortable effort throughout and finish feeling in control.";
  const short = p.presentation_version !== 4 && p.reasons.some(r=>r.startsWith("Building toward")) ? " Sessions are shorter while you build consistency across your selected days."
    : p.reasons.some(r=>r.startsWith("Familiarization")) ? " Start with this shorter session while recent training is uncertain." : "";
  const pool = p.sport === "swim" ? " Follow the listed stroke and pool units; the duration includes rests." : "";
  const constraints=p.reasons.filter(r=>/Distance is unknown|pool alternative|Use the available|Terrain, stops|Stored calibration/.test(r));
  const injury=p.sport === "strength" && p.reasons.some(r=>r.includes("injury settings")) ? " Exercise choices follow your recorded restrictions." : "";
  return intro+short+pool+injury+(constraints.length ? " "+constraints.join(" ") : "");
}
export function prescriptionWorkout(p: SessionPrescription): Workout {
  p = JSON.parse(JSON.stringify(PrescriptionSchema.parse(p))) as SessionPrescription;
  const exercise = (b: PrescriptionBlock): WorkoutExercise => {
    const base = { weight_kg: null, pace_zone: null, hr_zone: null, rest_seconds: null };
    if (b.kind === "recovery") return { ...base, name: b.name, sets: 1, reps: `${b.seconds} sec`, notes: `${b.optional ? "Optional: skip if it does not help recovery. " : ""}${effort(b)}. This recommendation does not count as completed activity until it is recorded.` };
    if (b.kind === "mobility") return { ...base, name: b.name, sets: 1, reps: `${b.seconds} sec`, notes: `Move comfortably. Transition: ${b.transition_seconds} sec. This is general mobility, not injury rehabilitation.` };
    if (b.kind === "strength") return { ...base,
      muscle: EXERCISE_CATALOG.find(e=>e.name===b.name)!.muscle,
      category: EXERCISE_CATALOG.find(e=>e.name===b.name)!.category,
      compound: EXERCISE_CATALOG.find(e=>e.name===b.name)!.compound,
      name: b.name, sets: b.sets,
      reps: b.distance_metres != null ? `${b.distance_metres} metres` : b.reps === null ? `${b.hold_seconds} sec` : b.reps_max ? `${b.reps}-${b.reps_max}` : String(b.reps), weight_kg: b.weight_kg, rest_seconds: b.rest_seconds,
      notes: `${effort(b)}. ${b.load_mode === "assistance" ? "Kilograms mean assistance; more assistance makes the movement easier. " : b.load_mode === "band" ? "Record the band/setup rather than inventing kilogram resistance. " : ""}${b.work_mode === "amrap" ? "Repeat controlled repetitions within the stated time, stopping with good technique. " : ""}${b.sides === 2 ? "Each side. " : ""}${b.weight_kg === null ? (p.presentation_version ?? 0) >= 3 && b.load_mode === "bodyweight" ? "Use your body weight and keep the movement controlled. " : p.presentation_version === 4 ? "Use a working weight that matches the listed RPE; keep 2–3 repetitions in reserve. " : "Choose a comfortable familiarization load; no load inferred from a different exercise. " : ""}Allow ${b.transition_seconds} sec to set up.` };
    return { ...base,
      ...(p.presentation_version === 4 && b.intensity_zone ? { pace_zone: p.sport === "run" || p.sport === "swim" ? b.intensity_zone : null, hr_zone: b.intensity_zone } : {}),
      name: b.label, sets: b.repetitions,
      reps: b.distance ? `${b.distance.value} ${b.distance.unit === "m" ? "metres" : "yards"}` : `${b.work_seconds} sec`,
      rest_seconds: b.recovery_seconds,
      notes: `${effort(b)}. ${b.numeric_target ? `${numericLabel(b.numeric_target)} (test ${b.numeric_target.calibration_date}${b.numeric_target.advisory ? ", guide only; terrain/stops can change the reading" : ""}). ` : ""}${b.stroke ? `${b.stroke}. ` : ""}${b.drill ? `${b.drill}. ` : ""}` +
        `${b.recovery_seconds} sec ${b.recovery_mode} recovery ${b.recovery_after_last ? "after every repetition" : "between repetitions only"}. Transition: ${b.transition_seconds} sec.` };
  };
  const efforts = p.blocks.flatMap(b => b.kind === "mobility" ? [] : [b.target.max]);
  return { type: p.sport, title: (p.presentation_version ?? 0) >= 2 ? prescriptionTitle(p) : `${p.sport === "rest" ? "Recovery" : p.sport[0].toUpperCase() + p.sport.slice(1)}: ${p.objective.replaceAll("_", " ")}`,
    duration_minutes: p.duration_seconds / 60, tss_estimate: 0, rpe_target: Math.max(0, ...efforts),
    sections: p.blocks.map(b => ({ name: `${b.role}: ${b.kind === "endurance" ? b.label : b.name}`, duration_minutes: blockSeconds(b) / 60, exercises: [exercise(b)] })),
    coach_note: (p.presentation_version ?? 0) >= 2 ? coachSummary(p) : p.reasons.join(" "), prescription: p };
}

/** Reject contradictory projections, including edits that changed only prose. */
export function assertPrescriptionProjection(w: Workout): void {
  if (!w.prescription) return;
  const expected = prescriptionWorkout(w.prescription);
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([k, v]) => v !== undefined && !(["muscle", "category", "compound"].includes(k) && v === null)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  for (const key of ["type", "title", "duration_minutes", "rpe_target", "sections", "coach_note"] as const) {
    if (canonical(expected[key]) !== canonical(w[key])) throw new Error(`Prescription/display mismatch: ${key}`);
  }
}

/** Effort-to-zone mapping is a load-estimation heuristic only. It never
 * creates a measured pace, heart-rate or power target for the athlete. */
export function prescriptionEffortMinutes(p: SessionPrescription): { zone: string; mins: number }[] {
  return p.blocks.flatMap(b => {
    if (b.kind !== "endurance") return [];
    const zone = b.target.max >= 8 ? "Z5" : b.target.max >= 7 ? "Z4" : b.target.max >= 5 ? "Z3" : b.target.max > 2 ? "Z2" : "Z1";
    const recoveries = b.repetitions - (b.recovery_after_last ? 0 : 1);
    return [{ zone, mins: b.repetitions * b.work_seconds / 60 },
      ...(b.recovery_mode !== "stationary" && b.recovery_seconds > 0 ? [{ zone: "Z1", mins: recoveries * b.recovery_seconds / 60 }] : [])];
  });
}
