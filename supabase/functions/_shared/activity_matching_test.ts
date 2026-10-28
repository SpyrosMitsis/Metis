import { assertEquals } from "jsr:@std/assert@1";
import { activityMatchesPlanned } from "./activity_matching.ts";
Deno.test("sport matching does not count walking or ambiguous workouts as prescribed training", () => {
  for (const type of ["Walk", "Workout", null, undefined]) assertEquals(activityMatchesPlanned("run", type), false);
  assertEquals(activityMatchesPlanned("strength", "Workout"), false);
  assertEquals(activityMatchesPlanned("run", "TrailRun"), true);
  assertEquals(activityMatchesPlanned("ride", "VirtualRide"), true);
  assertEquals(activityMatchesPlanned("strength", "WeightTraining"), true);
  assertEquals(activityMatchesPlanned("swim", "Open Water Swim"), true);
  assertEquals(activityMatchesPlanned("rest", "Walk"), false);
});
