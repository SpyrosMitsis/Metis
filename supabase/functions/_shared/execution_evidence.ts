import { crossTrainingBenefit } from "./program_state.ts";
import type { Workout } from "./types.ts";
import { activityMatchesPlanned } from "./activity_matching.ts";

export interface ExecutionObservation {
  type: string;
  duration_seconds: number | null;
  effort: number | null;
  athlete_state?: string;
}
/** Evidence about execution, never an inferred completion state or a verdict
 * on training quality. Totals alone cannot establish interval/set execution. */
export function executionEvidence(planned: Workout, actual: ExecutionObservation) {
  const sameSport = activityMatchesPlanned(planned.type, actual.type);
  const seconds = actual.duration_seconds;
  const durationRatio = sameSport && seconds !== null && Number.isFinite(seconds) && seconds >= 0 && planned.duration_minutes > 0
    ? seconds / (planned.duration_minutes * 60) : null;
  const effort = actual.effort !== null && Number.isFinite(actual.effort) && actual.effort >= 1 && actual.effort <= 10 ? actual.effort : null;
  const p = planned.prescription;
  const target = p?.blocks.flatMap(b => b.kind === "endurance" && b.role === "main" ? [b.target] : []);
  const easy = p && ["easy", "recovery", "long", "run_walk"].includes(p.objective);
  const effortCompatible = sameSport && effort !== null && target?.length && easy ? effort <= Math.max(...target.map(t => t.max)) : null;
  const confirmed = ["completed_as_planned", "modified", "substituted"].includes(actual.athlete_state ?? "") ? actual.athlete_state : null;
  const modifications: string[] = [];
  if (!sameSport) modifications.push("different_sport");
  if (durationRatio !== null && durationRatio < 0.9) modifications.push("shortened");
  if (durationRatio !== null && durationRatio > 1.1) modifications.push("longer");
  if (sameSport && effort !== null && target?.length) {
    if (effort < Math.min(...target.map(t => t.min))) modifications.push("easier_reported_effort");
    if (effort > Math.max(...target.map(t => t.max))) modifications.push("harder_reported_effort");
  }
  return { planned_objective: p?.objective ?? null, observed_modifications: modifications, sport_compatible: sameSport, athlete_report: confirmed, duration_ratio: durationRatio,
    effort_compatible: effortCompatible, interval_execution: "unknown" as const,
    summary: !sameSport ? `Different activity: ${crossTrainingBenefit(planned.type, ["run", "ride", "swim", "strength"].find(s => activityMatchesPlanned(s, actual.type)) ?? actual.type.toLowerCase())}` :
      durationRatio !== null && durationRatio < 0.9 ? "Shorter than the proposed session. Assess the reason and completed stimulus; do not add the missing work as debt." :
      p && !easy ? "Total duration alone cannot verify the work intervals, recoveries, strokes or sets." :
      effortCompatible === true ? "Reported effort supports the easy-session objective. Slower pace is not a failure." :
      "Dose or effort evidence is incomplete. Completion and training quality remain separate questions." };
}

export function strengthDoseEvidence(planned: { name: string; sets: number; reps: string }[],
  logged: { exercise_name: string; sets: { reps?: number; quantity_unit?: string; is_warmup?: boolean }[] }[]) {
  const normalize = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return planned.map(exercise => {
    const exact = logged.filter(l => normalize(l.exercise_name) === normalize(exercise.name));
    const sets = exact.flatMap(l => l.sets).filter(s => !s.is_warmup);
    const reps = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(exercise.reps.trim());
    const timed = /^(\d+)\s*(s|sec|seconds?|m|metres?|meters?|min|minutes?)$/.exec(exercise.reps.trim());
    const unit = !timed ? "reps" : /^(min|minutes?)$/.test(timed[2]) ? "minutes" : /^(m|metres?|meters?)$/.test(timed[2]) ? "metres" : "seconds";
    const min = reps ? Number(reps[1]) : timed ? Number(timed[1]) : null;
    const max = reps ? Number(reps[2] ?? reps[1]) : min;
    const matchedSets = min !== null ? sets.filter(s => typeof s.reps === "number" && (s.quantity_unit ?? "reps") === unit && s.reps >= min && s.reps <= max!).length : null;
    return { exercise: exercise.name, planned_sets: exercise.sets, logged_sets: sets.length,
      sets_in_rep_range: matchedSets, status: !exact.length ? "not_recorded" : min === null || sets.some(s => (s.quantity_unit ?? "reps") !== unit) ? "unknown_units" :
        sets.length !== exercise.sets || matchedSets !== exercise.sets ? "modified" : "recorded_sets_match",
      quantity_unit: unit, note: min === null ? "Timed, distance and assisted work need matching logging units; repetitions cannot verify them." :
        "Exact exercise and repetition evidence only; load, technique, effort and recovery are separate." };
  });
}
