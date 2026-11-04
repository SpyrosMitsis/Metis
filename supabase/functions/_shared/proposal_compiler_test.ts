import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { compileWithRepairs, ProposalError, sessionRepairPrompt } from "./proposal_compiler.ts";
import { sessionProposalLimits, type SessionState } from "./session_engine.ts";
import { assertPrescriptionProjection } from "./prescription.ts";
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

Deno.test("an unavailable hip-abduction accessory cannot discard the remaining complete strength session",async()=>{
  const base=structuredClone(proposed.sections[1].exercises[0]);
  const candidate:Workout={...proposed,sections:[{name:"Main",duration_minutes:15,exercises:[
    base,{...base,name:"Glute Bridge (Bodyweight)"},{...base,name:"Hip Abduction",weight_kg:40},
  ]}]};
  let repairs=0;
  const result=await compileWithRepairs(candidate,state,async()=>{repairs++;return candidate;});
  assertEquals(repairs,0);
  assert(!result.sections.some(s=>s.exercises.some(e=>e.name==="Hip Abduction")));
  assert(result.sections.some(s=>s.exercises.some(e=>e.name==="Bodyweight Squat")));
  assertStringIncludes(result.coach_note,"Hip Abduction was left out");
  assertPrescriptionProjection(result);
  const equipped=await compileWithRepairs(candidate,{...state,implements:["hip_abduction_machine"]},async()=>candidate);
  assert(equipped.sections.some(s=>s.exercises.some(e=>e.name==="Hip Abduction")));
});

Deno.test("equipment repair must not drop a primary lift or publish only one remaining working exercise",async()=>{
  const base=structuredClone(proposed.sections[1].exercises[0]);
  for(const name of ["Hip Abduction","Leg Press"]) {
    const candidate:Workout={...proposed,sections:[{name:"Main",duration_minutes:15,exercises:[base,{...base,name}]}]};
    await assertRejects(()=>compileWithRepairs(candidate,state,async()=>candidate),ProposalError,"Unavailable implements");
  }
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

Deno.test("final validation failures participate in bounded proposal repair", async () => {
  const valid = structuredClone(proposed);
  valid.sections = [valid.sections[1]];
  let repairs = 0;
  let gates = 0;
  const result = await compileWithRepairs(valid, state, async (_previous, error) => {
    assertStringIncludes(error, "content constraint");
    repairs++;
    return valid;
  }, compiled => {
    if (++gates === 1) throw new ProposalError("content constraint");
    return compiled;
  });
  assertEquals(repairs, 1);
  assertPrescriptionProjection(result);
  repairs = 0;
  await assertRejects(() => compileWithRepairs(valid, state, async () => {
    repairs++;
    return valid;
  }, () => { throw new ProposalError("persistent content constraint"); }), ProposalError);
  assertEquals(repairs, 2);
});

Deno.test("timed unilateral doses accept explicit per-side units without model repair", async () => {
  const valid = structuredClone(proposed);
  valid.sections = [{ ...valid.sections[1], exercises: [{ ...valid.sections[1].exercises[0], name: "Side Plank", reps: "20-30 sec hold per side", sets: 1 }] }];
  const result = await compileWithRepairs(valid, state, async (_previous, error) => { throw new Error(error); });
  assertPrescriptionProjection(result);
  const block = result.prescription!.blocks[0];
  assert(block.kind === "strength");
  assertEquals(block.hold_seconds, 20);
});

Deno.test("explicit run-walk work and recovery compile without losing walking time", async () => {
  const w: Workout = { ...proposed, type: "run", title: "Easy Run-Walk", sections: [{ name: "Main", duration_minutes: 18,
    exercises: [{ ...proposed.sections[1].exercises[0], name: "Run-walk intervals", sets: 3, reps: "90s run / 90s walk", rest_seconds: 90, pace_zone: "Z2" }] }] };
  const result = await compileWithRepairs(w, { ...state, sport: "run", weekly_remaining_minutes: 30 }, async (_previous, error) => { throw new Error(error); });
  const block = result.prescription!.blocks.find(b => b.kind === "endurance" && b.repetitions === 3);
  assert(block?.kind === "endurance");
  assertEquals(block.work_seconds, 90);
  assertEquals(block.recovery_seconds, 90);
  assertEquals(block.recovery_after_last, true);
  assertPrescriptionProjection(result);
});

Deno.test("malformed repair consumes one attempt and can recover on the remaining attempt", async () => {
  let calls = 0;
  const valid = structuredClone(proposed);
  valid.sections = [valid.sections[1]];
  const result = await compileWithRepairs(proposed, state, async (_previous, error) => {
    calls++;
    if (calls === 1) throw new SyntaxError("Truncated repair JSON");
    assertStringIncludes(error, "Truncated repair JSON");
    return valid;
  });
  assertEquals(calls, 2);
  assertPrescriptionProjection(result);
});

Deno.test("invalid repairs remain bounded and infrastructure failures are not retried", async () => {
  let calls = 0;
  await assertRejects(() => compileWithRepairs(proposed, state, async () => {
    calls++;
    throw new SyntaxError("invalid JSON");
  }), SyntaxError);
  assertEquals(calls, 2);
  calls = 0;
  await assertRejects(() => compileWithRepairs(proposed, state, async () => {
    calls++;
    throw new Error("provider unavailable");
  }), Error, "provider unavailable");
  assertEquals(calls, 1);
});
