import { assert, assertEquals } from "jsr:@std/assert@1";
import { deriveProgramState, programGoals, type ProgramGoal } from "./program_state.ts";
import { buildSession, type ActualExposure, type SessionState } from "./session_engine.ts";
import { overlapReason } from "./training_demands.ts";
import { strengthDoseEvidence } from "./execution_evidence.ts";

const goal: ProgramGoal = { id: "run", sport: "run", objective: "fitness", priority: "primary" };
const recorded = (patch: Partial<ActualExposure> = {}): ActualExposure[] => ["2026-10-07", "2026-10-10", "2026-10-15", "2026-10-18"].map((date, i) => ({ id: `run-${i}`, date, sport: "run", minutes: 20, effort: 3, response: "comfortable", ...patch }));
Deno.test("progression requires recent actual tolerance and changes only duration", () => {
  const p = deriveProgramState("2026-10-20", [goal], recorded(), true).sports[0];
  assertEquals(p.decision, "progress"); assertEquals(p.progression_dimension, "duration");
  assertEquals(p.session_minutes, 21); assertEquals(p.weekly_sessions, 2); assertEquals(p.weekly_minutes, 42);
  const unknown = deriveProgramState("2026-10-20", [goal], recorded({ response: "unknown" }), true).sports[0];
  assertEquals(unknown.decision, "repeat"); assertEquals(unknown.session_minutes, 20);
  const incomplete = deriveProgramState("2026-10-20", [goal], recorded(), false).sports[0];
  assertEquals(incomplete.decision, "reassess"); assertEquals(incomplete.phase, "familiarization");
});
Deno.test("difficult work reduces dose; extra cycling never authorizes running progression", () => {
  const p = deriveProgramState("2026-10-20", [goal], recorded({ response: "difficult" }), true).sports[0];
  assertEquals(p.decision, "reduce"); assertEquals(p.session_minutes, 14); assertEquals(p.quality_allowed, false);
  const ride = deriveProgramState("2026-10-20", [goal], recorded({ sport: "ride" }), true);
  assertEquals(ride.sports[0].completed_sessions, 0); assertEquals(ride.sports[0].phase, "familiarization");
  assert(ride.shared_effort_minutes! > 0);
});
Deno.test("six-week interruption/missed-week simulation never accumulates training debt", () => {
  const origin = Date.parse("2026-08-03");
  const actual: ActualExposure[] = [];
  for (let week = 0; week < 6; week++) {
    const date = new Date(origin + week * 7 * 86400000).toISOString().slice(0, 10);
    const p = deriveProgramState(date, [goal], actual, true).sports[0];
    assert(p.weekly_sessions <= 2);
    assert(p.session_minutes <= 21);
    if (week === 4) { assertEquals(p.phase, "familiarization"); assertEquals(p.decision, "reduce"); }
    if (week === 1 || week === 2 || week === 3) continue;
    for (const offset of [1, 4]) actual.push({ id: `${week}-${offset}`, date: new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10), sport: "run", minutes: 20, effort: 3, response: "comfortable" });
  }
});
Deno.test("event preparation is sport specific and explicit; competing A events stay visible", () => {
  const goals = programGoals({ sports: ["run", "ride"], event_policies: { run: { days: 10, duration_factor: 0.6, allow_quality: false } } }, ["run", "ride"], [
    { name: "Run event", date: "2026-10-25", sport: "run", priority: "A" },
    { name: "Ride event", date: "2026-10-27", sport: "ride", priority: "A" },
  ]);
  const p = deriveProgramState("2026-10-20", goals, recorded(), true);
  const run = p.sports.find(s => s.sport === "run")!;
  assertEquals(run.phase, "event_preparation"); assertEquals(run.session_minutes, 12); assertEquals(run.quality_allowed, false);
  assertEquals(goals.find(g => g.event_date === "2026-10-27")!.event_policy?.days, 7);
  assert(p.observations.some(note => note.includes("Priority events are close")));
});
Deno.test("planned heavy strength and observed hard rides influence shared scheduling", () => {
  const heavy = { type: "strength" as const, title: "Leg session", duration_minutes: 30, rpe_target: 7, sections: [], tss_estimate: 0, coach_note: "" };
  assert(overlapReason("2026-10-20", "run", true, [], [{ date: "2026-10-21", workout: heavy }]));
  assert(overlapReason("2026-10-20", "swim", true, [{ id: "ride", sport: "ride", date: "2026-10-19", minutes: 60, effort: 8 }], []));
  assertEquals(overlapReason("2026-10-20", "run", false, [], [{ date: "2026-10-21", workout: heavy }]), null);
});
Deno.test("a program dose decision reaches the generated session", () => {
  const p = deriveProgramState("2026-10-20", [goal], recorded(), true).sports[0];
  const state: SessionState = { date: "2026-10-20", sport: "run", max_minutes: 60, weekly_remaining_minutes: 60,
    experience: "Intermediate", actual: recorded(), history_complete: true, implements: [], venue: "road", fatigue: "normal", blocked_sports: [], program: p };
  const workout = buildSession(state, "easy");
  assertEquals(workout.duration_minutes, 21); assert(workout.prescription!.reasons.some(r=>r.includes("progress duration only")));
});
Deno.test("strength evidence excludes warmups and never borrows a substituted exercise's sets", () => {
  const [evidence] = strengthDoseEvidence([{ name: "Barbell Bench Press", sets: 2, reps: "8-10" }], [
    { exercise_name: "Barbell Bench Press", sets: [{ reps: 10, is_warmup: true }, { reps: 8 }, { reps: 6 }] },
    { exercise_name: "Dumbbell Bench Press", sets: [{ reps: 10 }, { reps: 10 }] },
  ]);
  assertEquals(evidence.logged_sets, 2); assertEquals(evidence.sets_in_rep_range, 1); assertEquals(evidence.status, "modified");
  const [hold] = strengthDoseEvidence([{ name: "Plank", sets: 2, reps: "30 sec" }], [{ exercise_name: "Plank", sets: [{ reps: 30 }, { reps: 30 }] }]);
  assertEquals(hold.status, "unknown_units");
});

Deno.test("tiny same-day recordings never replace a stable completed-session duration", () => {
  const actual=[{id:"a",date:"2026-10-26",minutes:43},{id:"b",date:"2026-10-26",minutes:0.5},{id:"c",date:"2026-10-19",minutes:37}].map(a=>({...a,sport:"run",effort:3,response:"unknown" as const}));
  const p=deriveProgramState("2026-10-27",[goal],actual,true).sports[0];
  assert(p.session_minutes>=30);assert(p.completed_minutes>=43.5);
});

Deno.test("saved per-sport goals reach program objectives without requiring hidden engine settings", () => {
 const goals=programGoals({goals_by_sport:{strength:["Build muscle"],swim:["Improve technique"]},distance_goal_km:{run:10}},["run","strength","swim"]);
 assertEquals(goals.find(g=>g.sport==="strength")!.objective,"hypertrophy");
 assertEquals(goals.find(g=>g.sport==="swim")!.objective,"technique");
 assertEquals(goals.find(g=>g.sport==="run")!.objective,"performance");
 const explicit=programGoals({program_objectives:{strength:"return"},goals_by_sport:{strength:["Build muscle"]}},["strength"]);
 assertEquals(explicit[0].objective,"return");
});

Deno.test("goal races automatically prepare, while overrides, opt-out and tune-ups remain distinct", () => {
 const events = [{name:"Goal",date:"2026-10-25",sport:"run",priority:"A"},{name:"Tune-up",date:"2026-10-22",sport:"run",priority:"B"}];
 const auto = programGoals({}, ["run"], events);
 assertEquals(auto.find(g=>g.event_priority==="A")!.event_policy,{days:7,duration_factor:0.7,allow_quality:false});
 assertEquals(auto.find(g=>g.event_priority==="B")!.event_policy,undefined);
 const progress=deriveProgramState("2026-10-20",auto,recorded(),true).sports[0];
 assertEquals(progress.phase,"event_preparation");assertEquals(progress.session_minutes,14);assertEquals(progress.quality_allowed,false);
 const disabled=programGoals({automatic_event_preparation:false},["run"],events);
 assertEquals(disabled.find(g=>g.event_priority==="A")!.event_policy,undefined);
 const override={days:3,duration_factor:0.9,allow_quality:true};
 assertEquals(programGoals({event_policies:{run:override}},["run"],events).find(g=>g.event_priority==="A")!.event_policy,override);
 assertEquals(programGoals({},["ride"],events).filter(g=>g.event_date).length,0);
});
