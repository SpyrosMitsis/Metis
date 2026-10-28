import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { requestedWorkoutSport } from "./workout_intent.ts";
import { workoutChoiceRequest } from "../../../shared/workout_choices.ts";
import { PlanError } from "./plan_store.ts";

Deno.test("switching sports overrides the old workout, while notes-only edits retain its sport", () => {
  const base_workout = { type: "strength" };
  assertEquals(requestedWorkoutSport({ type: "run", adjustment: "Strides", base_workout }), "run");
  assertEquals(requestedWorkoutSport({ type: "auto", adjustment: "Lower body", base_workout }), "strength");
  assertEquals(requestedWorkoutSport({ adjustment: "Shorter", base_workout: { type: "swim" } }), "swim");
  assertEquals(requestedWorkoutSport({}), "auto");
  assertThrows(() => requestedWorkoutSport({ type: "invalid" }), PlanError);
});

Deno.test("sport and focus choices produce a complete request without requiring extra notes", () => {
  assertEquals(workoutChoiceRequest("run", "Strides"), "Make this a running workout focused on strides.");
  assertEquals(workoutChoiceRequest("strength", "Lower body", "  30 minutes  "), "Make this a strength workout focused on lower body. 30 minutes");
  assertEquals(workoutChoiceRequest("swim", ""), "Make this a swimming workout.");
  assertEquals(workoutChoiceRequest("auto", "", "Shorter"), "Shorter");
  assertEquals(workoutChoiceRequest("auto", ""), "");
});
