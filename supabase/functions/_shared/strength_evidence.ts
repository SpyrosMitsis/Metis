import { EXERCISE_CATALOG } from "./exercise_catalog.ts";
import { exerciseId } from "./exercise_requirements.ts";

/** Your numbers are exercise-specific top sets, not completed sessions or 1RMs. */
export function startingLiftReferences(profile: Record<string, unknown>): { exercise: string; weight_kg: number; reps: number }[] {
  if (!Array.isArray(profile.starting_lifts)) return [];
  return profile.starting_lifts.flatMap(lift => {
    const entry = EXERCISE_CATALOG.find(e => exerciseId(e.name) === exerciseId(String(lift?.exercise ?? "")));
    const weight = lift?.weight_kg, reps = lift?.reps;
    return entry && typeof weight === "number" && weight > 0 && weight <= 400 &&
      Number.isInteger(reps) && reps >= 1 && reps <= 30 ? [{ exercise: entry.name, weight_kg: weight, reps }] : [];
  });
}
