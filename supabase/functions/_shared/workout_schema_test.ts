import { assert, assertEquals } from "jsr:@std/assert@1";
import { validateWeekPlan, validateWorkout } from "./workout_schema.ts";

const runWorkout = (over: Record<string, unknown> = {}) => ({
  type: "run",
  title: "Tempo Tuesday",
  duration_minutes: 45,
  tss_estimate: 60,
  rpe_target: 7,
  coach_note: "Comfortably hard.",
  sections: [{
    name: "Main Set",
    duration_minutes: 30,
    exercises: [{
      name: "Tempo", sets: 3, reps: "8 min", weight_kg: 60,
      pace_zone: "Z4", hr_zone: "Z3", rest_seconds: 90, notes: "",
    }],
  }],
  ...over,
});

Deno.test("valid run passes and strips weight (modality guardrail)", () => {
  const v = validateWorkout(runWorkout());
  assert(v.ok);
  const ex = v.workout!.sections[0].exercises[0];
  assertEquals(ex.weight_kg, null); // runs never carry weights
  assertEquals(ex.pace_zone, "Z4");
});

Deno.test("strength strips pace/HR zones", () => {
  const v = validateWorkout(runWorkout({ type: "strength" }));
  assert(v.ok);
  const ex = v.workout!.sections[0].exercises[0];
  assertEquals(ex.weight_kg, 60);
  assertEquals(ex.pace_zone, null);
  assertEquals(ex.hr_zone, null);
});

Deno.test("invalid type fails", () => {
  const v = validateWorkout(runWorkout({ type: "yoga" }));
  assert(!v.ok);
  assert(v.error!.includes("type"));
});

Deno.test("swim is a valid endurance type", () => {
  const v = validateWorkout(runWorkout({ type: "swim" }));
  assert(v.ok);
  // Endurance modality → pace/HR zones kept, weight stripped.
  assertEquals(v.workout!.type, "swim");
});

Deno.test("missing title fails", () => {
  const v = validateWorkout(runWorkout({ title: undefined }));
  assert(!v.ok);
});

Deno.test("blank title gets a fallback", () => {
  const v = validateWorkout(runWorkout({ title: "  " }));
  assert(v.ok);
  assertEquals(v.workout!.title, "Workout");
});

Deno.test("non-array sections fails", () => {
  const v = validateWorkout(runWorkout({ sections: "none" }));
  assert(!v.ok);
});

Deno.test("non-rest workout with no sections fails", () => {
  const v = validateWorkout(runWorkout({ sections: [] }));
  assert(!v.ok);
  assert(v.error!.includes("no sections"));
});

Deno.test("rest day with no sections passes", () => {
  const v = validateWorkout({ type: "rest", title: "", sections: [] });
  assert(v.ok);
  assertEquals(v.workout!.title, "Rest day");
});

Deno.test("numbers are clamped and defaulted", () => {
  const v = validateWorkout(runWorkout({ tss_estimate: 9999, rpe_target: -3, duration_minutes: "an hour" }));
  assert(v.ok);
  assertEquals(v.workout!.tss_estimate, 400);
  assertEquals(v.workout!.rpe_target, 0);
  assertEquals(v.workout!.duration_minutes, 0);
});

Deno.test("garbage exercise entries degrade to defaults instead of failing", () => {
  const v = validateWorkout(runWorkout({
    sections: [{ name: "Main", duration_minutes: 20, exercises: ["??", { name: "Easy", reps: 10 }] }],
  }));
  assert(v.ok);
  const exs = v.workout!.sections[0].exercises;
  assertEquals(exs[0].name, "Exercise");
  assertEquals(exs[1].reps, "10"); // numeric reps coerced to string
});

Deno.test("week plan: invalid day rejects the complete plan", () => {
  const v = validateWeekPlan({
    week_focus: "Build",
    rationale: "because",
    days: [
      { date: "2026-06-15", weekday: "Mon", session: runWorkout() },
      { date: "2026-06-16", weekday: "Tue", session: { type: "swim" } },
    ],
  });
  assert(!v.ok);
  assert(v.error!.includes("days.1.session"));
});

Deno.test("week plan: missing days fails", () => {
  assert(!validateWeekPlan({ week_focus: "x", days: [] }).ok);
  assert(!validateWeekPlan("nope").ok);
});

Deno.test("optional boolean encodings never replace a named timed exercise with a placeholder", () => {
 for (const [value, expected] of [[0,false],[1,true],["false",false],["true",true],[null,undefined],[undefined,undefined]] as const) {
  const v=validateWorkout(runWorkout({sections:[{name:"Warmup",duration_minutes:5,exercises:[{
   name:"Easy warm-up",sets:1,reps:"5 min",pace_zone:"Z1",dose:{work_seconds:300,recovery_after_last:value,transition_seconds:null},
  }]}]}));
  assert(v.ok,JSON.stringify(v));
  const e=v.workout!.sections[0].exercises[0];
  assertEquals(e.name,"Easy warm-up");assertEquals(e.reps,"5 min");assertEquals(e.dose?.work_seconds,300);
  assertEquals(e.dose?.recovery_after_last,expected);
 }
});

Deno.test("malformed dose objects fail with their field path instead of erasing an entire exercise or section", () => {
 for(const dose of [{recovery_after_last:"sometimes"},{work_seconds:-10},{transition_seconds:-1}]) {
  const v=validateWorkout(runWorkout({sections:[{name:"Main Set",duration_minutes:20,exercises:[{name:"Steady running",sets:1,reps:"20 min",dose}]}]}));
  assert(!v.ok);assert(v.error?.includes("dose"),v.error);
 }
});
