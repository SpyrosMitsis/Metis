import { EXERCISE_CATALOG, type CatalogExercise } from "./exercise_catalog.ts";

export type Movement = "squat" | "hinge" | "lunge" | "horizontal_push" | "vertical_push" | "horizontal_pull" | "vertical_pull" | "core" | "carry" | "accessory";
export interface ExerciseRequirements {
  id: string;
  movement: Movement;
  implements: string[];
  difficulty: "Beginner" | "Intermediate" | "Advanced";
  load_mode: "added_weight" | "assistance" | "band" | "bodyweight";
  logging: "reps" | "seconds" | "distance";
  unilateral: boolean;
}
/** IDs are persisted; renames must retain the original ID via an explicit alias. */
export function exerciseId(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); }
const specific: Record<string, string[]> = {
  "Incline Push-Up": ["stable_bench"], "Dips (Chest)": ["dip_bars"], "Dips (Triceps)": ["dip_bars"], "Bench Dip": ["stable_bench"], "Decline Sit-Up": ["decline_bench"], "EZ-Bar Curl": ["ez_bar"], "Skullcrusher": ["ez_bar", "stable_bench"], "Step-Up": ["dumbbells", "stable_step"],
  "Pull-Up": ["pullup_bar"], "Chin-Up": ["pullup_bar"], "Inverted Row": ["rack", "barbell"],
  "Assisted Pull-Up": ["assisted_pullup_machine"], "Hanging Leg Raise": ["pullup_bar"],
  "Ab Wheel Rollout": ["ab_wheel"], "Box Jump": ["plyo_box"], "Nordic Curl": ["nordic_anchor"],
  "Resistance Band Row": ["resistance_band", "band_anchor"],
  "Resistance Band Chest Press": ["resistance_band", "band_anchor"],
};
export function requirements(e: CatalogExercise): ExerciseRequirements {
  const n = e.name.toLowerCase();
  let movement: Movement = "accessory";
  if (/lunge|split squat|step.up/.test(n)) movement = "lunge";
  else if (/squat/.test(n)) movement = "squat";
  else if (/deadlift|good morning|hip thrust|glute bridge|swing/.test(n)) movement = "hinge";
  else if (/bench press|floor press|chest press|push.up|crossover/.test(n)) movement = "horizontal_push";
  else if (/overhead press|shoulder press|dumbbell press|arnold press|pike/.test(n)) movement = "vertical_push";
  else if (/row/.test(n) && e.category !== "Cardio") movement = "horizontal_pull";
  else if (/pull.up|chin.up|pulldown/.test(n)) movement = "vertical_pull";
  else if (e.muscle === "Core") movement = "core";
  else if (/carry|farmer/.test(n)) movement = "carry";
  const needed = specific[e.name] ? [...specific[e.name]] : e.category === "Bodyweight" ? [] :
    [({ Barbell: "barbell", Dumbbell: "dumbbells", Kettlebell: "kettlebell", Cable: "cable_machine", Band: "resistance_band" } as Record<string, string>)[e.category] ?? exerciseId(e.name) + "_machine"];
  if (/bench press|dumbbell fly|chest.supported|seated dumbbell|bulgarian|hip thrust|incline.*curl/i.test(n)) needed.push("stable_bench");
  if (e.category === "Barbell" && /bench press|squat|rack pull/.test(n)) needed.push("rack");
  if (e.category === "Band" && /press|row|pull/.test(n) && !/pull.apart/.test(n)) needed.push("band_anchor");
  return { id: exerciseId(e.name), movement, implements: [...new Set(needed)],
    difficulty: /snatch|clean|nordic|pistol/.test(n) ? "Advanced" :
      /wall push.up|bodyweight squat|glute bridge|dead bug|bird dog|resistance band/.test(n) ? "Beginner" : "Intermediate",
    load_mode: /assisted/.test(n) ? "assistance" : e.category === "Band" ? "band" : e.category === "Bodyweight" ? "bodyweight" : "added_weight",
    logging: /plank|hang|hold/.test(n) ? "seconds" : movement === "carry" ? "distance" : "reps",
    unilateral: /single.leg|single.arm|one.arm|lunge|split squat|side plank/.test(n) };
}
export function eligibleExercises(ownedImplements: string[]): CatalogExercise[] {
  const owned = new Set(ownedImplements);
  return EXERCISE_CATALOG.filter(e => e.category !== "Cardio" && requirements(e).implements.every(i => owned.has(i)));
}
/** Deliberately curated equivalents. Muscle overlap alone is insufficient. */
const substitutions = [
  ["Barbell Bench Press", "Dumbbell Bench Press", "Dumbbell Floor Press", "Push-Up", "Wall Push-Up", "Resistance Band Chest Press"],
  ["Barbell Row", "Dumbbell Row", "Chest-Supported Dumbbell Row", "Resistance Band Row"],
  ["Bodyweight Squat", "Kettlebell Goblet Squat", "Goblet Squat"],
  ["Romanian Deadlift", "Romanian Deadlift (Dumbbell)"],
  ["Reverse Lunge (Bodyweight)", "Reverse Lunge (Dumbbell)"],
];
export function exerciseAlternatives(name: string, ownedImplements: string[]): CatalogExercise[] {
  const group = substitutions.find(g => g.includes(name)) ?? [];
  return eligibleExercises(ownedImplements).filter(e => e.name !== name && group.includes(e.name));
}

export function movementEquivalent(first: string, second: string): boolean {
  return first === second || substitutions.some(group => group.includes(first) && group.includes(second));
}

/** More assistance is easier; added kilograms have the opposite direction. */
export function boundedLoad(mode: ExerciseRequirements["load_mode"], proposed: number | null | undefined, previous: number): number {
  return mode === "assistance" ? Math.max(proposed ?? previous, previous) : Math.min(proposed ?? previous, previous);
}
