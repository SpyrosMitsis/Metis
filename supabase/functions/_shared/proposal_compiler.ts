import { openWaterIssue } from "./open_water.ts";
/** Models interpret intent and propose parameters. This compiler owns units,
 * dose arithmetic, catalog identity, calibration and the final instructions. */
import type { EnduranceBlock, PrescriptionBlock, SessionObjective, SessionPrescription, StrengthBlock } from "../../../shared/prescription.ts";
import type { Workout, WorkoutExercise } from "./types.ts";
import { exerciseId, requirements, boundedLoad } from "./exercise_requirements.ts";
import { EXERCISE_CATALOG } from "./exercise_catalog.ts";
import { PrescriptionSchema, prescriptionTotals, prescriptionWorkout } from "./prescription.ts";
import { calibratedBlocks } from "./target_selection.ts";
import { resolveVenue, rejectTemplate, sessionProposalLimits, SESSION_TEMPLATES, type SessionState } from "./session_engine.ts";

export class ProposalError extends Error {}

/** A weekly repair is a separate model request, so it must carry its own
 * catalog and athlete constraints rather than relying on the week prompt. */
export function sessionRepairPrompt(previous: Workout, state: SessionState, error: string): string {
  const limits = sessionProposalLimits(state);
  return `Repair ONE session from this week, not the whole week.
Athlete constraints: ${JSON.stringify(limits)}.
Previous session: ${JSON.stringify(previous)}.
Compiler error: ${error}.
For strength, copy EVERY exercise name exactly from allowed_strength_exercises, including warm-up, activation and cool-down exercises. Replace unsupported movements with an appropriate allowed exercise or omit unsupported accessories; do not preserve an invalid movement just because it appeared in the previous session. Respect excluded_exercises and available equipment. Use explicit repetitions, hold seconds or carry metres, and include all sets, rests and transitions.
Preserve valid primary movements and appropriate loads. Trim accessories or excess preparation/rest if necessary. Aim below ${Math.floor(limits.complete_session_minutes_max * 0.85)} minutes, counting the complete session. Return corrected workout JSON only.`;
}
const effort = (value: number) => ({ kind: "rpe" as const, min: Math.max(1, Math.min(10, value)), max: Math.max(1, Math.min(10, value)) });
function role(name: string): "warmup" | "main" | "cooldown" { return /cool|warm.down/i.test(name) ? "cooldown" : /warm|activation/i.test(name) ? "warmup" : "main"; }
export function inferObjective(w: Workout): SessionObjective {
  if (w.type === "rest") return /optional|light walk/i.test(w.title) ? "optional_light" : /active recovery/i.test(w.title) ? "active_recovery" : w.sections.length ? "mobility" : "rest";
  if (w.type === "strength") return /hyper|muscle/i.test(w.title) ? "hypertrophy" : "strength";
  const text = w.title.toLowerCase();
  for (const [pattern, objective] of [[/run.?walk/, "run_walk"], [/recovery/, "recovery"], [/\blong\b/, "long"], [/hill/, "hills"], [/stride/, "strides"], [/threshold|css/, "threshold"], [/tempo/, "tempo"], [/interval|vo2/, "intervals"], [/technique|drill|cadence/, "technique"]] as const) if (pattern.test(text)) return objective;
  if (w.sections.some(s => s.exercises.some(e => /[345]/.test(e.hr_zone ?? e.pace_zone ?? "")))) return "intervals";
  return "easy";
}
function work(e: WorkoutExercise): { seconds?: number; distance?: { value: number; unit: "m" | "yd" } } {
  if (e.dose?.work_seconds != null) {
    const parsed = e.reps.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(km|m|metres?|meters?|yd|yards?)$/);
    const distance = e.dose.distance_m != null ? { value: e.dose.distance_m, unit: "m" as const } : parsed ?
      { value: Number(parsed[1]) * (parsed[2] === "km" ? 1000 : 1), unit: (/^y/.test(parsed[2]) ? "yd" : "m") as "yd" | "m" } : undefined;
    return { seconds: e.dose.work_seconds, ...(distance ? { distance } : {}) };
  }
  const s = e.reps.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+):(\d{2})$/))) return { seconds: Number(m[1]) * 60 + Number(m[2]) };
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:min|mins|minutes?|sec|secs|seconds?|s|h|hr|hours?)$/))) return { seconds: Number(m[1]) * (/min/.test(s) ? 60 : /h/.test(s) ? 3600 : 1) };
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(km|m|metres?|meters?|yd|yards?)$/))) {
    const n = Number(m[1]); const unit = /^y/.test(m[2]) ? "yd" : "m";
    if (m[2] === "m" && n < 100) throw new ProposalError("Ambiguous 'm': use explicit seconds, minutes or metres");
    return { distance: { value: n * (m[2] === "km" ? 1000 : 1), unit } };
  }
  throw new ProposalError(`Missing executable work duration/distance for ${e.name}`);
}
export function compileProposal(w: Workout, state: SessionState): Workout {
  if (w.type !== state.sport) throw new ProposalError("Proposed sport does not match the validated sport");
  const resolved = resolveVenue(state); state = resolved.state;
  const objective = w.prescription?.objective ?? inferObjective(w);
  if (state.venue === "open_water" && (openWaterIssue(state.open_water, state.date) || !["easy", "recovery"].includes(objective))) throw new ProposalError("Open-water proposals require current venue confirmations and easy effort");
  const template = SESSION_TEMPLATES.find(t => t.sport === state.sport && t.objective === objective);
  if (!template) throw new ProposalError("Unsupported sport objective");
  const ineligible = rejectTemplate(template, state);
  if (ineligible) throw new ProposalError(ineligible);
  const blocks: PrescriptionBlock[] = [];
  if (w.prescription) {
    const p = PrescriptionSchema.parse(w.prescription);
    if (p.sport !== w.type) throw new ProposalError("Prescription sport does not match the proposed session");
    // Numeric targets and prose are always rebuilt from the athlete state.
    blocks.push(...p.blocks.map(b => b.kind === "endurance" ? { ...b, numeric_target: undefined } : b));
  } else for (const section of w.sections) {
    const phase = role(section.name);
    for (const e of section.exercises) {
      if (!Number.isInteger(e.sets) || e.sets < 1 || e.sets > 100) throw new ProposalError("Repetitions/sets must be positive whole numbers");
      if (w.type === "rest") {
        const duration = work(e).seconds;
        if (!duration) throw new ProposalError("Mobility needs explicit timed movements");
        if (objective === "optional_light" || objective === "active_recovery") blocks.push({ kind: "recovery", role: phase, name: objective === "optional_light" ? "Optional comfortable walk" : "Easy recovery movement", seconds: duration * e.sets, transition_seconds: 0, optional: objective === "optional_light", target: effort(2) });
        else blocks.push({ kind: "mobility", role: phase, name: e.name, seconds: duration * e.sets, transition_seconds: e.dose?.transition_seconds ?? 15 });
      } else if (w.type === "strength") {
        const entry = EXERCISE_CATALOG.find(x => x.name === e.name);
        if (!entry) throw new ProposalError(`Exercise is not in the bundled catalog: ${e.name}`);
        const meta = requirements(entry);
        if (!meta.implements.every(i => state.implements.includes(i))) throw new ProposalError(`Unavailable implements for ${e.name}`);
        const reps = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(e.reps.replace(/(?:\/?side|each side|per side)/gi, "").trim());
        const hold = /^(\d+)\s*(?:s|sec|seconds?)$/.exec(e.reps);
        const carry = /^(\d+)\s*(?:m|metres?|meters?)$/.exec(e.reps);
        const amrap = /amrap/i.test(e.reps) && e.dose?.work_seconds;
        if (!reps && !hold && !carry && !amrap) throw new ProposalError(`Explicit repetitions, hold seconds or carry distance required for ${e.name}`);
        const last = state.last_loads?.[meta.id];
        const weight = ["band", "bodyweight"].includes(meta.load_mode) ? null : phase === "warmup" ? null :
          last ? boundedLoad(meta.load_mode, e.weight_kg, last.weight_kg) : null;
        blocks.push({ kind: "strength", role: phase, exercise_id: exerciseId(e.name), name: e.name,
          sets: e.sets, reps: reps ? Number(reps[1]) : null, reps_max: reps?.[2] ? Number(reps[2]) : undefined,
          hold_seconds: hold ? Number(hold[1]) : amrap ? Number(amrap) : null, work_mode: amrap ? "amrap" : hold ? "hold" : carry ? "carry" : "repetitions", distance_metres: carry ? Number(carry[1]) : undefined,
          seconds_per_metre: carry ? 1 : undefined, seconds_per_rep: 4, sides: meta.unilateral ? 2 : 1,
          rest_seconds: e.rest_seconds ?? (entry.compound ? 150 : 90), transition_seconds: e.dose?.transition_seconds ?? 30,
          weight_kg: weight, load_mode: meta.load_mode, target: effort(phase === "warmup" ? 3 : Math.min(w.rpe_target || 6, state.fatigue === "high" ? 5 : 8)) } as StrengthBlock);
      } else {
        const dose = work(e);
        let seconds = dose.seconds;
        if (!seconds && dose.distance) {
          const metres = dose.distance.value * (dose.distance.unit === "yd" ? 0.9144 : 1);
          if (w.type === "swim" && state.pool?.seconds_per_length) seconds = metres / (state.pool.length * (state.pool.unit === "yd" ? 0.9144 : 1)) * state.pool.seconds_per_length;
          else {
            const pace = state.calibration?.find(c => c.sport === state.sport && c.kind === "pace" && c.reliability === "measured" && Date.parse(state.date) - Date.parse(c.date) >= 0 && Date.parse(state.date) - Date.parse(c.date) <= 90 * 86400000);
            if (pace) seconds = metres / (w.type === "swim" ? 100 : 1000) * pace.value;
          }
          if (!seconds) throw new ProposalError("Distance work needs an explicit estimated duration or a current sport-specific pace");
        }
        const zone = Number((e.hr_zone ?? e.pace_zone ?? "").match(/[1-5]/)?.[0] ?? 0);
        blocks.push({ kind: "endurance", role: phase, label: phase === "main" ? objective.replaceAll("_", " ") : phase,
          repetitions: e.sets, work_seconds: seconds!, recovery_seconds: e.rest_seconds ?? 0,
          recovery_after_last: e.dose?.recovery_after_last ?? false,
          recovery_mode: w.type === "swim" ? "stationary" : objective === "run_walk" ? "walk" : "easy",
          transition_seconds: e.dose?.transition_seconds ?? 0,
          target: effort(phase !== "main" ? 2 : zone ? [0, 2, 3, 6, 7, 8][zone] : w.rpe_target || 3),
          ...(dose.distance ? { distance: dose.distance } : {}),
          ...(w.type === "swim" ? { stroke: e.dose?.stroke ?? (state.venue === "open_water" ? state.open_water?.stroke : state.pool?.strokes[0]) } : {}) } as EnduranceBlock);
      }
    }
  }
  if (["run", "ride", "swim"].includes(w.type)) {
    // Missing preparation is added by code and counted, never silently stolen
    // from work or hidden outside the athlete's available time.
    if (!blocks.some(b => b.role === "warmup")) blocks.unshift({ kind: "endurance", role: "warmup", label: "Easy preparation", repetitions: 1, work_seconds: 300, recovery_seconds: 0, recovery_mode: "easy", recovery_after_last: false, transition_seconds: 0, target: effort(2), ...(w.type === "swim" ? { stroke: state.venue === "open_water" ? state.open_water?.stroke : state.pool?.strokes[0] } : {}) });
    if (!blocks.some(b => b.role === "cooldown")) blocks.push({ kind: "endurance", role: "cooldown", label: "Easy finish", repetitions: 1, work_seconds: 180, recovery_seconds: 0, recovery_mode: "easy", recovery_after_last: false, transition_seconds: 0, target: effort(2), ...(w.type === "swim" ? { stroke: state.venue === "open_water" ? state.open_water?.stroke : state.pool?.strokes[0] } : {}) });
    if (!blocks.some(b => b.role === "main")) throw new ProposalError("Missing main work");
    if (w.type === "swim" && state.venue === "pool") for (const b of blocks) if (b.kind === "endurance" && b.distance) {
      if (!state.pool || b.distance.unit !== state.pool.unit || Math.abs(b.distance.value / state.pool.length - Math.round(b.distance.value / state.pool.length)) > 1e-6) throw new ProposalError("Swimming distance must be a whole number of lengths in the configured pool units");
    }
    const calibrated = calibratedBlocks(state, objective, blocks as EnduranceBlock[]); blocks.splice(0, blocks.length, ...calibrated);
  }
  for (const b of blocks) {
    if (b.kind !== "mobility") {
      const maxEffort = ["easy", "long", "run_walk", "technique"].includes(objective) ? 4 : ["recovery", "optional_light", "active_recovery"].includes(objective) ? 3 : 8;
      if (b.target.max > maxEffort) throw new ProposalError("Proposed effort contradicts the selected objective");
      if (b.target.max >= 7 && state.sport !== "strength") {
        const issue = rejectTemplate({ ...template, demanding: true }, state);
        if (issue) throw new ProposalError(issue);
      }
    }
    if (b.kind === "strength") {
      const entry = EXERCISE_CATALOG.find(e => exerciseId(e.name) === b.exercise_id && e.name === b.name);
      if (!entry || !requirements(entry).implements.every(i => state.implements.includes(i))) throw new ProposalError("Unavailable or unknown strength exercise");
      if (state.excluded_exercises?.includes(b.exercise_id)) throw new ProposalError("Exercise is contraindicated by an active injury");
      const meta = requirements(entry); b.load_mode = meta.load_mode; b.sides = meta.unilateral ? 2 : 1;
      const last = state.last_loads?.[b.exercise_id];
      b.weight_kg = ["band", "bodyweight"].includes(b.load_mode) || b.role === "warmup" || !last ? null : boundedLoad(b.load_mode, b.weight_kg, last.weight_kg);
    }
  }
  if (state.sport === "swim") for (const b of blocks) if (b.kind === "endurance") {
    const strokes = state.venue === "open_water" ? [state.open_water?.stroke] : state.pool?.strokes ?? [];
    if (!strokes.includes(b.stroke)) throw new ProposalError("Swimming stroke is not confirmed in the athlete profile");
  }
  const total = prescriptionTotals(blocks);
  const limit = Math.min(state.max_minutes, state.weekly_remaining_minutes, state.sport === "rest" ? 1440 : state.program?.session_minutes ?? (state.history_complete ? 1440 : ({ run: 20, ride: 30, swim: 20, strength: 30, rest: 10 })[state.sport]));
  if (total.seconds > limit * 60 + 0.001) throw new ProposalError(`Computed work, recovery and transitions total ${(total.seconds/60).toFixed(1)} minutes, exceeding the ${limit}-minute actual-based time limit`);
  const p: SessionPrescription = { version: 1, presentation_version: 4, policy_version: "compiler-2", template_id: `${w.type}.${objective}.proposal.v1`, sport: w.type, objective,
    venue: state.venue, scheduled_date: state.date, open_water_checks: state.venue === "open_water" ? state.open_water : undefined, duration_seconds: total.seconds, duration_basis: "estimated", distance: total.distance, blocks,
    reasons: [...(resolved.reason ? [resolved.reason] : []), "Built from the interpreted request; dose, equipment, units and intensity were independently constructed and checked."], rejected: [] };
  return prescriptionWorkout(p);
}

/** Bounded repair: every revision is compiled again against the original state. */
export async function compileWithRepairs(proposed: Workout, state: SessionState,
  repair: (previous: Workout, error: string) => Promise<Workout>): Promise<Workout> {
  for (let attempt=0; ; attempt++) {
    try { return compileProposal(proposed,state); }
    catch(error) {
      if(attempt>=2) throw error;
      proposed=await repair(proposed,error instanceof Error ? error.message : String(error));
    }
  }
}
