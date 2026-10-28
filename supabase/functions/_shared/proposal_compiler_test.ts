import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { compileWithRepairs, ProposalError, sessionRepairPrompt } from "./proposal_compiler.ts";
import { sessionProposalLimits, type SessionState } from "./session_engine.ts";
import type { Workout } from "./types.ts";

const state: SessionState = {
  date: "2026-10-28", sport: "strength", max_minutes: 30, weekly_remaining_minutes: 20,
  experience: "Intermediate", history_complete: false, actual: [],
  implements: [], excluded_exercises: ["push_up"], venue: "unspecified", fatigue: "unknown", blocked_sports: [],
};
const proposed: Workout = {
  type: "strength", title: "Strength", duration_minutes: 10, tss_estimate: 10,
  rpe_target: 4, coach_note: "Controlled preparation and main work.",
  sections: [
    { name: "Warmup", duration_minutes: 2, exercises: [{ name: "Arm Circles", sets: 1, reps: "10", weight_kg: null,
      rest_seconds: 0, pace_zone: null, hr_zone: null, notes: "" }] },
    { name: "Main", duration_minutes: 8, exercises: [{ name: "Bodyweight Squat", sets: 2, reps: "8", weight_kg: null,
      rest_seconds: 60, pace_zone: null, hr_zone: null, notes: "" }] },
  ],
};

Deno.test("weekly repair carries exact equipment-eligible names and exclusions in its own request", () => {
  const names = sessionProposalLimits(state).allowed_strength_exercises!;
  assert(names.includes("Bodyweight Squat"));
  assert(!names.includes("Arm Circles"));
  assert(!names.includes("Push-Up"));
  assert(!names.includes("Barbell Back Squat"));
  const prompt = sessionRepairPrompt(proposed, state, "Exercise is not in the bundled catalog: Arm Circles");
  assertStringIncludes(prompt, JSON.stringify(names));
  assertStringIncludes(prompt, "including warm-up, activation and cool-down");
  assertStringIncludes(prompt, "Replace unsupported movements");
  assertStringIncludes(prompt, "below 17 minutes");
  assertEquals(sessionProposalLimits({ ...state, sport: "run" }).allowed_strength_exercises, undefined);
});

Deno.test("Arm Circles failure can be repaired without weakening the compiler catalog gate", async () => {
  let calls = 0;
  const result = await compileWithRepairs(proposed, state, async (previous, error) => {
    calls++;
    assertStringIncludes(error, "Exercise is not in the bundled catalog: Arm Circles");
    const repaired = structuredClone(previous);
    repaired.sections[0].exercises[0].name = "Bodyweight Squat";
    return repaired;
  });
  assertEquals(calls, 1);
  assert(result.prescription);
  assert(result.prescription.blocks.every(b => b.kind === "strength" && b.name === "Bodyweight Squat"));
  await assertRejects(() => compileWithRepairs(proposed, state, async previous => previous), ProposalError,
    "Exercise is not in the bundled catalog: Arm Circles");
});
