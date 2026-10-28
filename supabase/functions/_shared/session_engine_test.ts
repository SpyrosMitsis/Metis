import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { buildSession, SESSION_TEMPLATES, usableCalibration, type SessionState } from "./session_engine.ts";
import { assertPrescriptionProjection, blockSeconds, prescriptionTotals, prescriptionWorkout, PrescriptionSchema } from "./prescription.ts";
import { deriveProgramState, crossTrainingBenefit } from "./program_state.ts";
import { EXERCISE_CATALOG } from "./exercise_catalog.ts";
import { eligibleExercises, exerciseAlternatives, requirements } from "./exercise_requirements.ts";
import { dailyMinutes } from "./session_context.ts";
import { validateWorkout, validateWeekPlan } from "./workout_schema.ts";

const state = (patch: Partial<SessionState> = {}): SessionState => ({
  date: "2026-10-22", sport: "run", max_minutes: 40, weekly_remaining_minutes: 90,
  experience: "Intermediate", actual: [], history_complete: false, implements: [],
  venue: "unspecified", fatigue: "unknown", blocked_sports: [], ...patch,
});
Deno.test("identical state yields identical familiarization; planned volume cannot drive increases", () => {
  const a = buildSession(state(), "intervals"), b = buildSession(state(), "intervals");
  assertEquals(a, b); assertEquals(a.prescription!.objective, "easy"); assertEquals(a.duration_minutes, 20);
  assert(a.prescription!.rejected.some(r => r.template_id === "run.intervals.v1"));
});
Deno.test("all eligible templates produce valid exact totals within both time budgets", () => {
  for (const t of SESSION_TEMPLATES) {
    const actual = Array.from({ length: 8 }, (_, i) => ({ id: String(i), date: `2026-10-${10 + i}`, sport: t.sport, minutes: 60, effort: 3 }));
    const s = state({ sport: t.sport, actual, history_complete: true, fatigue: "normal", venue: t.sport === "swim" ? "pool" : "road",
      pool: { length: 25, unit: "m", strokes: ["freestyle"], seconds_per_length: 30 }, implements: ["dumbbells", "stable_bench", "resistance_band", "band_anchor"], weekly_remaining_minutes: 35 });
    const w = buildSession(s, t.objective);
    assert(PrescriptionSchema.safeParse(w.prescription).success, t.id);
    assert(w.duration_minutes <= 35, t.id);
    assert(Math.abs(w.duration_minutes * 60 - prescriptionTotals(w.prescription!.blocks).seconds) < 1e-6);
    assertPrescriptionProjection(w);
  }
});
Deno.test("moving recovery means complete distance is unknown", () => {
  const w = buildSession(state(), "run_walk");
  const b = w.prescription!.blocks.find(b => b.kind === "endurance")!;
  if (b.kind !== "endurance") throw new Error("missing endurance");
  b.repetitions = 3; b.work_seconds = 60; b.distance = { value: 200, unit: "m" }; b.recovery_seconds = 30;
  b.recovery_after_last = false;
  assertEquals(blockSeconds(b), 240);
  assertEquals(prescriptionTotals([b]).distance, null);
  b.recovery_mode = "stationary";
  assertEquals(prescriptionTotals([b]).distance, { value: 600, unit: "m" });
});
Deno.test("pool length and yard units survive schema serialization", () => {
  const w = buildSession(state({ sport: "swim", venue: "pool", pool: { length: 25, unit: "yd", strokes: ["backstroke"], seconds_per_length: 30 } }), "easy");
  const parsed = validateWorkout(JSON.parse(JSON.stringify(w)));
  assert(parsed.ok); assertEquals(parsed.workout!.prescription, w.prescription); assertPrescriptionProjection(parsed.workout!);
  for (const b of w.prescription!.blocks) {
    assert(b.kind === "endurance"); assertEquals(b.distance!.value % 25, 0); assertEquals(b.stroke, "backstroke");
  }
  assertEquals(w.prescription!.distance!.unit, "yd");
});
Deno.test("open water, missing pool data, restricted sports and impossible budgets fail explicitly", () => {
  assertThrows(() => buildSession(state({ sport: "swim", venue: "open_water" }), "easy"));
  assertThrows(() => buildSession(state({ sport: "swim" }), "easy"));
  assertThrows(() => buildSession(state({ blocked_sports: ["run"] }), "easy"));
  assertThrows(() => buildSession(state({ max_minutes: NaN }), "easy"));
  assertThrows(() => buildSession(state({ weekly_remaining_minutes: 0 }), "easy"));
  assertThrows(() => buildSession(state({ date: "2026-02-30" }), "easy"));
});
Deno.test("schema rejects dose tampering and independent display changes", () => {
  const w = buildSession(state(), "easy");
  w.duration_minutes += 1; assertThrows(() => assertPrescriptionProjection(w));
  w.prescription!.duration_seconds += 1;
  assert(!validateWorkout(w).ok);
});
Deno.test("rest does not claim load; mobility is explicit and not rehabilitation", () => {
  const rest = buildSession(state({ sport: "rest" }), "rest");
  assertEquals(rest.duration_minutes, 0); assertEquals(rest.tss_estimate, 0);
  const mobility = buildSession(state({ sport: "rest" }), "mobility");
  assertEquals(mobility.prescription!.objective, "mobility");
  assert(mobility.sections[0].exercises[0].notes.includes("not injury rehabilitation"));
});
Deno.test("implement requirements do not treat bodyweight as equipment free", () => {
  assert(!eligibleExercises([]).some(e => e.name === "Pull-Up"));
  assert(!eligibleExercises(["dumbbells"]).some(e => e.name === "Dumbbell Bench Press"));
  assert(eligibleExercises(["dumbbells"]).some(e => e.name === "Dumbbell Floor Press"));
  assert(exerciseAlternatives("Barbell Bench Press", ["dumbbells"]).some(e => e.name === "Dumbbell Floor Press"));
  assert(!exerciseAlternatives("Barbell Bench Press", []).some(e => e.muscle === "Biceps"));
});
Deno.test("catalog IDs are unique and Android names/category/muscle/compound match", () => {
  const ids = EXERCISE_CATALOG.map(e => requirements(e).id);
  assertEquals(new Set(ids).size, ids.length);
  const kotlin = Deno.readTextFileSync(new URL("../../../android/app/src/main/java/com/workoutmaker/app/strength/ExerciseCatalog.kt", import.meta.url));
  const entries = [...kotlin.matchAll(/Exercise\("([^"]+)", "([^"]+)", "([^"]+)"([^\n]*)/g)]
    .map(m => ({ name: m[1], muscle: m[2], category: m[3], compound: m[4].includes("compound = true") }));
  assertEquals(entries, EXERCISE_CATALOG);
});
Deno.test("calibration is sport specific, dated and equipment aware", () => {
  const c = { sport: "ride" as const, kind: "power" as const, value: 200, date: "2026-10-01", reliability: "measured" as const };
  assert(!usableCalibration(c, state()));
  assert(!usableCalibration(c, state({ sport: "ride" })));
  assert(usableCalibration(c, state({ sport: "ride", implements: ["power_meter"] })));
  assert(!usableCalibration({ ...c, date: "2025-01-01" }, state({ sport: "ride", implements: ["power_meter"] })));
});
Deno.test("program state counts extra training once and never invents running exposure", () => {
  const actual = { id: "ride", date: "2026-10-21", sport: "ride", minutes: 60, effort: 8 };
  const p = deriveProgramState("2026-10-22", [{ id: "run", sport: "run", objective: "fitness", priority: "primary" }], [actual, actual], true);
  assertEquals(p.sports[0].completed_minutes, 0); assertEquals(p.sports[0].decision, "reduce");
  assertEquals(p.shared_effort_minutes, 480);
  assert(crossTrainingBenefit("run", "ride").includes("does not establish run-specific"));
  const candidate = buildSession(state({ actual: [actual] }), "intervals");
  assertEquals(candidate.prescription!.objective, "easy");
});
Deno.test("availability has explicit zero and refuses unavailable weekdays", () => {
  assertEquals(dailyMinutes({ days: ["Mon"] }, "2026-10-22"), 0);
  assertEquals(dailyMinutes({ day_availability: [{ day: "Mon", max_minutes: 60 }] }, "2026-10-22"), 0);
  assertEquals(dailyMinutes({ day_availability: [{ day: "Thu", max_minutes: 60 }], session_duration_max: 30 }, "2026-10-22"), 30);
});
Deno.test("duplicate or impossible week dates reject without creating a recovery day", () => {
  const session = prescriptionWorkout(buildSession(state(), "easy").prescription!);
  assert(!validateWeekPlan({ days: [{ date: "2026-02-30", session }] }).ok);
  assert(!validateWeekPlan({ days: [{ date: "2026-10-22", session }, { date: "2026-10-22", session }] }).ok);
});

import { renderIntervalsWorkout } from "./intervals_workout.ts";
import { executionEvidence } from "./execution_evidence.ts";
Deno.test("structured export preserves work/recovery seconds and does not invent numerical targets", () => {
  const w = buildSession(state(), "run_walk");
  const text = renderIntervalsWorkout(w);
  const seconds = [...text.matchAll(/^- ([0-9.]+)s(?: Z[1-5] (?:Pace|HR))?$/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
  assertEquals(seconds, w.prescription!.duration_seconds);
  assert(text.includes("Z2 Pace")); assert(text.includes("Effort"));
  const old=prescriptionWorkout({...w.prescription!,presentation_version:3});assert(!renderIntervalsWorkout(old).includes("Z2 Pace"));
});
Deno.test("a substitution cannot earn a run completion score, easy pace has no arbitrary speed floor", () => {
  const w = buildSession(state(), "easy");
  const replacement = executionEvidence(w, { type: "Ride", duration_seconds: 1200, effort: 3 });
  assertEquals(replacement.duration_ratio, null); assertEquals(replacement.sport_compatible, false);
  const easy = executionEvidence(w, { type: "Run", duration_seconds: 1200, effort: 3 });
  assertEquals(easy.effort_compatible, true); assertEquals(easy.athlete_report, null);
  assert(easy.summary.includes("Slower pace is not a failure"));
  assertEquals(executionEvidence(w, { type: "Run", duration_seconds: null, effort: null }).duration_ratio, null);
});

Deno.test("without a swimmer's length time the engine does not invent distance", () => {
  const w = buildSession(state({ sport: "swim", venue: "pool", pool: { length: 25, unit: "m", strokes: ["freestyle"] } }), "easy");
  assertEquals(w.prescription!.distance, null);
  assert(w.prescription!.blocks.every(b => b.kind !== "endurance" || !b.distance));
  assert(w.coach_note.includes("Distance is unknown"));
});
Deno.test("catalog identity cannot be changed independently of an exercise name", () => {
  const w = buildSession(state({ sport: "strength" }), "strength");
  const block = w.prescription!.blocks.find(b => b.kind === "strength")!;
  if (block.kind !== "strength") throw new Error("missing strength");
  block.exercise_id = "another_exercise";
  assert(!PrescriptionSchema.safeParse(w.prescription).success);
});

Deno.test("blocked outdoor conditions use only confirmed equipment and never apply another day's weather", () => {
  const conditions = { date: "2026-10-22", tier: "blocked" as const, reasons: ["strong wind"] };
  assertThrows(() => buildSession(state({ sport: "ride", venue: "road", conditions }), "easy"));
  const indoor = buildSession(state({ sport: "ride", venue: "road", conditions, implements: ["indoor_trainer"] }), "easy");
  assertEquals(indoor.prescription!.venue, "indoor"); assert(indoor.coach_note.includes("indoor_trainer"));
  const future = buildSession(state({ sport: "ride", venue: "road", conditions: { ...conditions, date: "2026-10-21" } }), "easy");
  assertEquals(future.prescription!.venue, "road");
});

Deno.test("friendly presentation is versioned without invalidating older stored projections", () => {
  const w=buildSession(state(),"easy");
  assertEquals(w.title,"Easy run");
  const old={...w.prescription!};delete old.presentation_version;
  const legacy=prescriptionWorkout(old);
  assertEquals(legacy.title,"Run: easy");
  assertPrescriptionProjection(legacy);assertPrescriptionProjection(w);
});

Deno.test("many tiny recordings on one day cannot authorize a demanding session", () => {
 const actual=Array.from({length:8},(_,i)=>({id:`fragment-${i}`,date:"2026-10-21",sport:"run",minutes:0.5,effort:3,response:"comfortable" as const}));
 const w=buildSession(state({actual,history_complete:true,experience:"Advanced",fatigue:"normal"}),"intervals");
 assertEquals(w.prescription!.objective,"easy");
});

Deno.test("strength construction applies remaining muscle-set budgets before final safety review", () => {
 const w=buildSession(state({sport:"strength",implements:["dumbbells"],remaining_sets:{Quads:1,Chest:0,Back:0,Hamstrings:0,Core:0}}),"strength");
 const main=w.prescription!.blocks.filter(b=>b.kind==="strength"&&b.role==="main");
 const quad=main.filter(b=>b.kind==="strength"&&EXERCISE_CATALOG.find(e=>e.name===b.name)?.muscle==="Quads");
 assert(quad.reduce((sum,b)=>sum+(b.kind==="strength"?b.sets:0),0)<=1);
 assert(!main.some(b=>b.kind==="strength"&&EXERCISE_CATALOG.find(e=>e.name===b.name)?.muscle==="Chest"));
 assertPrescriptionProjection(w);
});

Deno.test("new bodyweight notes do not invalidate the earlier readable presentation version", () => {
 const current=buildSession(state({sport:"strength",implements:[]}),"strength");
 assert(current.sections.some(s=>s.exercises.some(e=>e.notes.includes("Use your body weight"))));
 const old=prescriptionWorkout({...current.prescription!,presentation_version:2});
 assert(old.sections.some(s=>s.exercises.some(e=>e.notes.includes("Choose a comfortable familiarization load"))));
 assertPrescriptionProjection(old);assertPrescriptionProjection(current);
});

Deno.test("experienced gym training prefers scalable lifts over catalogue-first wall push-ups", () => {
 const w=buildSession(state({sport:"strength",experience:"Intermediate",implements:["barbell","rack","stable_bench","dumbbells"],fatigue:"unknown"}),"strength");
 const names=w.sections.flatMap(s=>s.exercises.map(e=>e.name));
 assert(names.includes("Barbell Bench Press"));assert(!names.includes("Wall Push-Up"));
});

Deno.test("working weights use the saved top set without increasing a six-rep load for ten reps", () => {
 const s=state({sport:"strength",implements:["barbell","rack","stable_bench","dumbbells"],
  last_loads:{barbell_bench_press:{weight_kg:80,reps:6,date:"2026-10-22",source:"reported"}},fatigue:"unknown"});
 for(const objective of ["strength","hypertrophy"] as const){
  const w=buildSession(s,objective),bench=w.prescription!.blocks.find(b=>b.kind==="strength"&&b.name==="Barbell Bench Press"&&b.role==="main");
  assert(bench?.kind==="strength");assert(bench.weight_kg!==null&&bench.weight_kg>50&&bench.weight_kg<=80);
  if(objective==="hypertrophy"){assertEquals(bench.reps,10);assert(bench.weight_kg<80);}
 }
});

Deno.test("new running projections carry Z1 warmup, Z2 easy work and Z4 threshold through export", () => {
 const actual=Array.from({length:8},(_,i)=>({id:String(i),date:`2026-10-${10+i}`,sport:"run",minutes:35,effort:3}));
 for(const objective of ["easy","threshold"] as const){
  const w=buildSession(state({actual,history_complete:true,fatigue:"normal",venue:"road"}),objective);
  const sections=w.sections;
  assertEquals(sections[0].exercises[0].pace_zone,"Z1");
  assertEquals(sections[1].exercises[0].pace_zone,objective==="easy"?"Z2":"Z4");
  assertEquals(sections.at(-1)!.exercises[0].pace_zone,"Z1");
  assertPrescriptionProjection(w);
  const old=prescriptionWorkout({...w.prescription!,presentation_version:3});
  assertEquals(old.sections[1].exercises[0].pace_zone,null);assertPrescriptionProjection(old);
 }
});

import { inferObjective } from "./proposal_compiler.ts";
import { sessionProposalLimits } from "./session_engine.ts";
Deno.test("easy endurance wording is not misclassified as an advanced long-run request", () => {
 assertEquals(inferObjective({type:"run",title:"Easy endurance run",duration_minutes:35,tss_estimate:0,rpe_target:3,sections:[],coach_note:""}),"easy");
 const limits=sessionProposalLimits(state({experience:"Beginner"}));
 assert(limits.objectives.includes("easy"));assert(!limits.objectives.includes("threshold"));
});

import { compileWithRepairs } from "./proposal_compiler.ts";
Deno.test("failed model dose repairs are bounded and every candidate is validated again", async () => {
 const s=state({sport:"rest"}),good=buildSession(s,"rest"),bad={...good,type:"run" as const};
 let calls=0;
 const result=await compileWithRepairs(bad,s,async(previous,error)=>{calls++;assertEquals(previous.type,"run");assert(error.includes("sport"));return good;});
 assertEquals(result.type,"rest");assertEquals(calls,1);
 calls=0;let rejected=false;
 try{await compileWithRepairs(bad,s,async()=>{calls++;return bad;});}catch{rejected=true;}
 assert(rejected);assertEquals(calls,2);
});
