import { assert, assertEquals } from "jsr:@std/assert@1";
import { EXERCISE_CATALOG, enforceStrengthCatalog } from "./exercise_catalog.ts";
import { validateWorkout } from "./workout_schema.ts";
import { reviewWorkout } from "./workout_review.ts";

function workout(names: string[]) {
  const parsed = validateWorkout({ type: "strength", title: "Test", duration_minutes: 30,
    tss_estimate: 20, rpe_target: 5, coach_note: "", sections: [{ name: "Main",
      exercises: names.map(name => ({ name, sets: 2, reps: "10", muscle: "Wrong", category: "Machine", compound: false })) }] });
  assert(parsed.ok);
  return parsed.workout!;
}

Deno.test("generation accepts bundled spelling variants, replaces metadata, rejects inventions and equipment guesses", () => {
  const w = workout(["push up", "Dumbbell Floor Press", "Machine Push-Up", "My custom curl"]);
  assertEquals(enforceStrengthCatalog(w), ["Machine Push-Up", "My custom curl"]);
  assertEquals(w.sections[0].exercises.map(e => e.name), ["Push-Up", "Dumbbell Floor Press"]);
  assertEquals(w.sections[0].exercises[0].muscle, "Chest");
  assertEquals(w.sections[0].exercises[0].category, "Bodyweight");
  assertEquals(w.sections[0].exercises[0].compound, true);
});

Deno.test("generation review enforces catalog before equipment and reports removals for repair", () => {
  const input = workout(["Invented move", "Dumbbell Floor Press", "Bodyweight Squat"]);
  const result = reviewWorkout(input, { catalogOnly: true, mainLifts: [], weeklySetsByMuscle: {},
    muscleGroupsLast48h: [], tsb: 0, daysSinceLastHard: 99, experience: "Beginner", equipment: "bodyweight" });
  assertEquals(result.corrected.sections.flatMap(s => s.exercises.map(e => e.name)), ["Bodyweight Squat"]);
  assert(result.violations.some(v => v.includes("Invented move")));
  assertEquals(input.sections[0].exercises.length, 3);
});

Deno.test("unknown-only strength workout becomes empty for the endpoint fallback", () => {
  const w = workout(["Invented move"]);
  enforceStrengthCatalog(w);
  assertEquals(w.sections, []);
});

Deno.test("bundled Android and server catalogs have exactly matching names and metadata", async () => {
  const source = await Deno.readTextFile(new URL("../../../android/app/src/main/java/com/workoutmaker/app/strength/ExerciseCatalog.kt", import.meta.url));
  const rows = [...source.matchAll(/Exercise\("([^"]+)", "([^"]+)", "([^"]+)"([^\n]*)/g)]
    .map(([, name, muscle, category, tail]) => ({ name, muscle, category, compound: tail.includes("compound = true") }));
  assertEquals(rows, EXERCISE_CATALOG);
  assertEquals(new Set(rows.map(e => e.name.toLowerCase().replace(/[^a-z0-9]/g, ""))).size, rows.length);
});
