import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { deterministicWeek } from "./deterministic_week.ts";
import { compileProposal } from "./proposal_compiler.ts";
import { assertPublishable, reviewGeneratedWorkout } from "./plan_store.ts";
import { loadReviewContext, constrainSession } from "./review_context.ts";
import { buildSession } from "./session_engine.ts";
import { remainingWeekMinutes, sessionState } from "./session_context.ts";

function database(tables: Record<string, unknown[]>, fail?: string, reads: Record<string, number> = {}): SupabaseClient {
  return { from: (table: string) => {
    reads[table] = (reads[table] ?? 0) + 1;
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    const query = {
      select: () => query, order: () => query,
      eq: (field: string, value: unknown) => { if (field !== "user_id") filters.push(r => r[field] === value); return query; },
      gte: (field: string, value: string) => { filters.push(r => String(r[field]) >= value); return query; },
      lte: (field: string, value: string) => { filters.push(r => String(r[field]) <= value); return query; },
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(resolve({ data: (tables[table] ?? []).filter(r => filters.every(f => f(r as Record<string, unknown>))), error: table === fail ? { message: "unavailable" } : null })),
    };
    return query;
  } } as unknown as SupabaseClient;
}
Deno.test("structured week preserves fixed sessions, prioritizes sports and fits weekly time", async () => {
  const db = database({ reconciled_session_plans: [{ date: "2026-10-19", workout_json: { duration_minutes: 20 } }] });
  const profile = { onboarding: { sports: ["run", "ride"], primary_sport: "ride", session_duration: 20, weekly_minutes_max: 80 } };
  const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"].map(date => ({ date, available: true }));
  const fixed = new Map([["2026-10-19", { type: "run", workout_json: {} }]]);
  const result = await deterministicWeek(db, "owner", profile, days, fixed);
  assertEquals(result.rows.length, 3); assert(!result.rows.some(r => r.date === "2026-10-19"));
  assertEquals(result.rows[0].type, "ride");
  assert(result.rows.reduce((sum, r) => sum + r.workout_json.duration_minutes, 20) <= 80);
  assertEquals(await deterministicWeek(db, "owner", profile, days, fixed), result);
});
Deno.test("weekly budget counts fixed/past commitments and only excludes dates being replaced", async () => {
  const db = database({ reconciled_session_plans: [
    { date: "2026-10-19", workout_json: { duration_minutes: 40 } },
    { date: "2026-10-22", workout_json: { duration_minutes: 30 } },
  ] });
  assertEquals(await remainingWeekMinutes(db, "owner", { weekly_minutes_max: 90 }, "2026-10-22", new Set(["2026-10-22"])), 50);
});
Deno.test("unavailable history fails week construction rather than inventing inactivity", async () => {
  await assertRejects(() => deterministicWeek(database({}, "effective_activities"), "owner", { onboarding: { sports: ["run"] } }, [{ date: "2026-10-22", available: true }], new Map()), Error, "Cannot read actual training");
});

Deno.test("multipart actuals are one exposure and feedback follows the explicit plan ID", async () => {
  const db = database({ effective_activities: [
    { id: "part-1", date: "2026-10-21", type: "Run", duration_seconds: 600, planned_workout_id: "plan", session_group_id: "group", data_json: {} },
    { id: "part-2", date: "2026-10-21", type: "Run", duration_seconds: 900, planned_workout_id: "plan", session_group_id: "group", data_json: {} },
    { id: "other", date: "2026-10-21", type: "Ride", duration_seconds: 1800, planned_workout_id: null, session_group_id: null, data_json: {} },
  ], workout_feedback: [{ planned_workout_id: "plan", date: "2026-10-21", completed: true, actual_rpe: 3, difficulty: "just_right" }] });
  const state = await sessionState(db, "owner", { training_history_confirmed: true }, "2026-10-22", "run");
  assertEquals(state.actual.length, 2);
  const run = state.actual.find(a => a.sport === "run")!;
  assertEquals(run.minutes, 25); assertEquals(run.response, "comfortable"); assertEquals(run.effort, 3);
  assertEquals(state.actual.find(a => a.sport === "ride")!.response, "unknown");
});
Deno.test("an exhausted weekly time budget produces explicit rest without erasing fixed training", async () => {
  const db = database({ reconciled_session_plans: [{ date: "2026-10-19", workout_json: { duration_minutes: 60 } }] });
  const result = await deterministicWeek(db, "owner", { onboarding: { sports: ["run"], weekly_minutes_max: 60 } },
    [{ date: "2026-10-20", available: true }], new Map());
  assertEquals(result.rows[0].type, "rest"); assertEquals(result.rows[0].workout_json.duration_minutes, 0);
});

Deno.test("crossing Monday does not double familiarization frequency or ignore a future fixed session", async () => {
  const fixed = new Map([["2026-10-27", { type: "run", workout_json: { type: "run", duration_minutes: 20, rpe_target: 3 } }]]);
  const result = await deterministicWeek(database({}), "owner", { onboarding: { sports: ["run"], session_duration: 20 } },
    ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"].map(date => ({ date, available: true })), fixed);
  assertEquals(result.rows.filter(r => r.type === "run").length, 3);
  assertEquals(result.rows.filter(r => r.type === "rest").length, 3);
});

Deno.test("a standing history confirmation cannot authorize progression after a feed failure", async () => {
  const db = database({ activity_sync_state: [{ source: "intervals", last_attempt_at: new Date().toISOString(), last_success_at: "2026-01-01T00:00:00Z", coverage_from: "2025-01-01", last_error: "offline" }] });
  const state = await sessionState(db, "owner", { training_history_confirmed: true }, "2026-10-22", "run");
  assertEquals(state.history_complete, false);
  assert(state.history_issues?.some(note => note.includes("cannot authorize progression")));
});

Deno.test("unplanned work already completed today consumes sport frequency", async () => {
  const db = database({effective_activities: [{id: "extra", date: "2026-10-22", type: "Run", duration_seconds: 1200, data_json: {icu_rpe: 3}}]});
  const result = await deterministicWeek(db, "owner", {onboarding: {sports: ["run"], training_history_confirmed: true, session_duration: 20}}, [{date: "2026-10-22", available: true}], new Map());
  assertEquals(result.rows[0].type, "rest");
});

Deno.test("skipped commitments preserve their slot but consume neither quota nor time", async () => {
  const missed = {id: "missed", date: "2026-10-21", skipped: true, type: "run", workout_json: {type: "run", duration_minutes: 60, rpe_target: 8}};
  const db = database({reconciled_session_plans: [missed]});
  assertEquals(await remainingWeekMinutes(db, "owner", {weekly_minutes_max: 60}, "2026-10-22", new Set()), 60);
  const result = await deterministicWeek(db, "owner", {onboarding: {sports: ["run"], session_duration: 20, weekly_minutes_max: 60}}, [{date: "2026-10-21", available: true}, {date: "2026-10-22", available: true}], new Map([["2026-10-21", missed]]));
  assertEquals(result.rows.length, 1); assertEquals(result.rows[0].type, "run");
});
Deno.test("a dated athlete dose report informs progression without a fabricated recording or duplicate late sync", async () => {
 const report={id:"feedback",planned_workout_id:"plan",date:"2026-10-21",completed:true,outcome:"shortened",reason:"time",actual_minutes:15,actual_rpe:3,difficulty:"just_right",planned_workouts:{type:"run"}};
 const local=await sessionState(database({workout_feedback:[report]}),"owner",{training_history_confirmed:true},"2026-10-22","run");
 assertEquals(local.actual.length,1);assertEquals(local.actual[0].id,"report:feedback");assertEquals(local.actual[0].sport,"run");assertEquals(local.actual[0].minutes,15);
 const synced=await sessionState(database({workout_feedback:[report],effective_activities:[{id:"watch",date:"2026-10-21",type:"Run",duration_seconds:900,planned_workout_id:"plan",data_json:{icu_rpe:3}}]}),"owner",{training_history_confirmed:true},"2026-10-22","run");
 assertEquals(synced.actual.length,1);assertEquals(synced.actual[0].id,"watch");
 const swap=await sessionState(database({workout_feedback:[{...report,outcome:"substituted"}]}),"owner",{},"2026-10-22","run");assertEquals(swap.actual[0].sport,"other");
});


Deno.test("nullable Android pool timing stays unknown and does not break any other sport", async () => {
  const pool = { length: 25, unit: "m" as const, strokes: ["freestyle"], seconds_per_length: null };
  for (const sport of ["run", "ride", "swim", "strength", "rest"] as const) {
    const state = await sessionState(database({}), "owner", { pool, session_duration: 20, implements: ["dumbbells"] }, "2026-10-27", sport);
    assertEquals(state.pool, sport === "swim" ? { ...pool, seconds_per_length: undefined } : undefined);
    const workout = buildSession(state, sport === "rest" ? "rest" : sport === "strength" ? "strength" : "easy");
    assertEquals(workout.type, sport);
    if (sport === "swim") assertEquals(workout.prescription!.distance, null);
  }
});

Deno.test("null pool profile is absent, while invalid supplied swimming times remain invalid", async () => {
  const absent = await sessionState(database({}), "owner", { pool: null, session_duration: 20 }, "2026-10-27", "run");
  assertEquals(absent.pool, undefined);
  assertEquals(buildSession(absent, "easy").type, "run");
  for (const seconds of [0, -1, "unknown"]) {
    const state = await sessionState(database({}), "owner", { pool: { length: 25, unit: "m", strokes: ["freestyle"], seconds_per_length: seconds }, session_duration: 20 }, "2026-10-27", "swim");
    let rejected = false;
    try { buildSession(state, "easy"); } catch { rejected = true; }
    assert(rejected, "invalid timing must not be silently treated as measured or unknown");
  }
});

Deno.test("a complete week builds with nullable pool timing from a real serialized profile", async () => {
  const result = await deterministicWeek(database({}), "owner", { onboarding: {
    sports: ["run", "strength", "swim"], primary_sport: "run", session_duration: 20, implements: ["dumbbells"],
    pool: { length: 25, unit: "m", strokes: ["freestyle"], seconds_per_length: null },
  } }, ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"].map(date => ({date,available:true})), new Map());
  assertEquals(result.rows.length, 6);
  assert(result.rows.some(row => row.type !== "rest"));
  for (const row of result.rows) assert(row.workout_json.prescription);
});

Deno.test("injury exclusions are applied before strength dose construction and cannot be bypassed by proposals", async () => {
  const db=database({});
  const profile={onboarding:{session_duration:60,implements:["dumbbells"],injuries:[{area:"lower back",severity:"moderate"}]}};
  const state=await sessionState(db,"owner",profile.onboarding,"2026-10-27","strength");
  const unsafe=buildSession({...state,excluded_exercises:[]},"strength");
  assert(unsafe.sections.some(s=>s.exercises.some(e=>/deadlift/i.test(e.name))));
  assertThrows(()=>compileProposal(unsafe,state),Error,"contraindicated");
  const safe=buildSession(state,"strength");
  assert(!safe.sections.some(s=>s.exercises.some(e=>/deadlift/i.test(e.name))));
  const context=await loadReviewContext(db,"owner",state.date,"strength",profile);
  assertPublishable(reviewGeneratedWorkout(safe,context).corrected,context);
});

Deno.test("whole-week injury-aware strength remains canonically publishable through final review", async () => {
  const profile={onboarding:{sports:["strength","run"],primary_sport:"strength",session_duration:45,implements:["dumbbells"],injuries:[{area:"lower back",severity:"moderate"}]}};
  const result=await deterministicWeek(database({}),"owner",profile,["2026-10-27","2026-10-28","2026-10-29","2026-10-30","2026-10-31","2026-11-01"].map(date=>({date,available:true})),new Map());
  assertEquals(result.rows.length,6);
  assert(result.rows.some(r=>r.type==="strength"));
  assert(!result.rows.flatMap(r=>r.workout_json.sections).flatMap(s=>s.exercises).some(e=>/deadlift/i.test(e.name)));
});


Deno.test("five selected training days are not erased by four recordings from Monday", async () => {
  const db=database({effective_activities:[630,2610,30,48].map((duration_seconds,i)=>({id:`fragment-${i}`,date:"2026-10-26",type:"Run",duration_seconds,data_json:{icu_rpe:3}}))});
  const o={sports:["run","strength"],primary_sport:"run",days:["Mon","Tue","Wed","Fri","Sun"],session_duration:45,implements:["dumbbells"],training_history_confirmed:true,injuries:[{area:"lower back",severity:"moderate"}]};
  const days=["2026-10-27","2026-10-28","2026-10-29","2026-10-30","2026-10-31","2026-11-01"].map(date=>({date,available:!["2026-10-29","2026-10-31"].includes(date)}));
  const r=await deterministicWeek(db,"owner",{onboarding:o},days,new Map());
  assertEquals(r.rows.filter(row=>row.type!=="rest").map(row=>row.date),["2026-10-27","2026-10-28","2026-10-30","2026-11-01"]);
  assertEquals(r.rows.filter(row=>row.type==="strength").length,2);
  assertEquals(r.rows.filter(row=>row.type==="run").length,2);
  for(const row of r.rows){assert(row.workout_json.duration_minutes<=45);assert(row.workout_json.prescription);assert(!row.workout_json.sections.some(s=>s.exercises.some(e=>/deadlift/i.test(e.name))));}
});

Deno.test("a full requested five-day week covers selected days while respecting a hard weekly cap", async () => {
  const dates=["2026-10-26","2026-10-27","2026-10-28","2026-10-29","2026-10-30","2026-10-31","2026-11-01"];
  const o={sports:["run","strength"],primary_sport:"run",days:["Mon","Tue","Wed","Fri","Sun"],session_duration:45,implements:["dumbbells"]};
  const days=dates.map(date=>({date,available:!["2026-10-29","2026-10-31"].includes(date)}));
  const full=await deterministicWeek(database({}),"owner",{onboarding:o},days,new Map());
  assertEquals(full.rows.filter(r=>r.type!=="rest").length,5);
  const capped=await deterministicWeek(database({}),"owner",{onboarding:{...o,weekly_minutes_max:45}},days,new Map());
  assert(capped.rows.reduce((sum,r)=>sum+r.workout_json.duration_minutes,0)<=45);
  assert(capped.rationale.includes("time budget"));
});

Deno.test("all sport recipes honor short per-day availability rather than filling the requested schedule unsafely", async () => {
  for(const sport of ["run","ride","swim","strength"] as const)for(const max of [5,10,15,25]){
    const o={sports:[sport],days:["Mon","Tue","Wed","Thu","Fri"],session_duration:max,session_duration_max:max,implements:["dumbbells"],pool:{length:25,unit:"m",strokes:["freestyle"],seconds_per_length:null}};
    const r=await deterministicWeek(database({}),"owner",{onboarding:o},[{date:"2026-10-26",available:true}],new Map());
    assert(r.rows[0].workout_json.duration_minutes<=max,`${sport} exceeds ${max} minutes`);
    if(max<10)assertEquals(r.rows[0].type,"rest");
  }
});

Deno.test("active all-sport holds explain why preferences cannot be scheduled", async () => {
  const db=database({training_holds:[{id:"hold",sport:null,start_date:"2026-10-01",until_date:"2026-11-01",active:true,reason:"illness"}]});
  const r=await deterministicWeek(db,"owner",{onboarding:{sports:["run","strength"],days:["Mon","Tue","Wed","Fri","Sun"],session_duration:45}},[{date:"2026-10-27",available:true}],new Map());
  assertEquals(r.rows[0].type,"rest");assert(r.rows[0].workout_json.coach_note.includes("hold"));
});

Deno.test("unplanned actual minutes consume the explicit weekly ceiling without double-counting linked fixed sessions", async () => {
 const actual=[{id:"recording",date:"2026-10-26",sport:"run",minutes:40,effort:3,planned_workout_id:null}];
 assertEquals(await remainingWeekMinutes(database({}),"owner",{weekly_minutes_max:55},"2026-10-27",new Set(),actual),15);
 const linked=[{...actual[0],planned_workout_id:"fixed"}];
 assertEquals(await remainingWeekMinutes(database({reconciled_session_plans:[{id:"fixed",date:"2026-10-26",session_slot:0,workout_json:{duration_minutes:40}}]}),"owner",{weekly_minutes_max:55},"2026-10-27",new Set(),linked),15);
});

Deno.test("dated injury backoffs expire, and a reduced event policy is not overridden by more requested days", async () => {
 const o={sports:["run"],days:["Mon","Tue","Wed","Thu","Fri"],session_duration:20,training_history_confirmed:true};
 const profile={onboarding:o,injury_backoff:[{area:"Knee",level:"avoid",until:"2026-10-27"}]};
 const blocked=constrainSession(await sessionState(database({}),"owner",o,"2026-10-27","run"),await loadReviewContext(database({}),"owner","2026-10-27","run",profile));
 assert(blocked.blocked_sports.includes("run"));
 const expired=constrainSession(await sessionState(database({}),"owner",o,"2026-10-28","run"),await loadReviewContext(database({}),"owner","2026-10-28","run",profile));
 assert(!expired.blocked_sports.includes("run"));
 const db=database({races:[{name:"Event",date:"2026-11-01",sport:"run",priority:"A"}],effective_activities:[{id:"a",date:"2026-10-20",type:"Run",duration_seconds:1200,data_json:{icu_rpe:3}},{id:"b",date:"2026-10-23",type:"Run",duration_seconds:1200,data_json:{icu_rpe:3}}]});
 const result=await deterministicWeek(db,"owner",{onboarding:{...o,event_policies:{run:{days:10,duration_factor:0.5,allow_quality:false}}}},["2026-10-26","2026-10-27","2026-10-28","2026-10-29","2026-10-30"].map(date=>({date,available:true})),new Map());
 assert(result.rows.reduce((sum,r)=>sum+r.workout_json.duration_minutes,0)<=20);
});

Deno.test("resolved injury entries do not permanently exclude movements", async () => {
 const state=await sessionState(database({}),"owner",{injuries:[{area:"lower back",severity:"moderate",status:"resolved"}]},"2026-10-27","strength");
 assertEquals(state.excluded_exercises,[]);
});

Deno.test("fixed future strength work reserves its muscle volume before new sessions are built", async () => {
 const fixed={id:"fixed",date:"2026-10-26",type:"strength",workout_json:{type:"strength",rpe_target:6,duration_minutes:30,sections:[{name:"main",duration_minutes:30,exercises:[{name:"Goblet Squat",sets:12,reps:"6",muscle:"Quads",weight_kg:null}]}]}};
 const o={sports:["strength"],days:["Mon","Wed","Fri"],session_duration:30,implements:["dumbbells"],experience:"Beginner"};
 const r=await deterministicWeek(database({}),"owner",{onboarding:o},["2026-10-26","2026-10-28","2026-10-30"].map(date=>({date,available:true})),new Map([["2026-10-26",fixed]]));
 assert(!r.rows.some(row=>row.workout_json.sections.some(sec=>sec.exercises.some(e=>e.muscle==="Quads"))));
 assertEquals(fixed.workout_json.sections[0].exercises[0].sets,12);
});

Deno.test("a primary endurance goal retains the longest selected window instead of using every run slot early", async () => {
 const o={sports:["run","strength"],primary_sport:"run",distance_goal_km:{run:10},days:["Mon","Tue","Wed","Fri","Sun"],session_duration:45,implements:["dumbbells"],day_availability:[{day:"Mon",max_minutes:45},{day:"Tue",max_minutes:45},{day:"Wed",max_minutes:45},{day:"Fri",max_minutes:45},{day:"Sun",max_minutes:90}]};
 const dates=["2026-10-26","2026-10-27","2026-10-28","2026-10-30","2026-11-01"];
 const r=await deterministicWeek(database({}),"owner",{onboarding:o},dates.map(date=>({date,available:true})),new Map());
 assertEquals(r.rows.filter(r=>r.type!=="rest").length,5);
 assertEquals(r.rows.find(r=>r.date==="2026-11-01")!.type,"run");
 assertEquals(r.rows.filter(r=>r.type==="strength").length,2);
 assert(r.rows.every(r=>r.workout_json.duration_minutes<=45));
});

Deno.test("reserving the primary sport window never displaces a protected session", async () => {
 const fixed={id:"protected",date:"2026-11-01",type:"strength",workout_json:{type:"strength",duration_minutes:20,rpe_target:5,sections:[]}};
 const before=JSON.stringify(fixed);
 const o={sports:["run","strength"],primary_sport:"run",distance_goal_km:{run:10},days:["Mon","Tue","Wed","Fri","Sun"],session_duration:30,implements:["dumbbells"]};
 const result=await deterministicWeek(database({}),"owner",{onboarding:o},["2026-10-26","2026-10-27","2026-10-28","2026-10-30","2026-11-01"].map(date=>({date,available:true})),new Map([["2026-11-01",fixed]]));
 assert(!result.rows.some(r=>r.date==="2026-11-01"));
 assertEquals(JSON.stringify(fixed),before);
 assertEquals(result.rows.filter(r=>r.type==="run").length,3);
});

Deno.test("zero-duration imports cannot consume a requested training day", async () => {
 const db=database({effective_activities:[{id:"empty-import",date:"2026-10-26",type:"Run",duration_seconds:0,data_json:{}}]});
 const r=await deterministicWeek(db,"owner",{onboarding:{sports:["run"],days:["Mon"],session_duration:20}},[{date:"2026-10-26",available:true}],new Map());
 assertEquals(r.rows[0].type,"run");
});

Deno.test("assistance history uses the easier direction while missing weights remain unknown", async () => {
 const state=await sessionState(database({strength_logs:[
  {exercise_name:"Assisted Pull-Up",date:"2026-10-26",sets:[{reps:6,weight_kg:20},{reps:6,weight_kg:40}]},
  {exercise_name:"Goblet Squat",date:"2026-10-26",sets:[{reps:6,weight_kg:null},{reps:6,weight_kg:""}]},
 ]}),"owner",{},"2026-10-27","strength");
 assertEquals(state.last_loads?.assisted_pull_up.weight_kg,40);
 assertEquals(state.last_loads?.goblet_squat,undefined);
});

Deno.test("weekly time is loaded once per calendar week without sharing it across weeks", async () => {
  for (const length of [7, 10]) {
    const reads: Record<string, number> = {};
    const days = Array.from({ length }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 19 + i)).toISOString().slice(0, 10), available: true }));
    const result = await deterministicWeek(database({}, undefined, reads), "owner", { onboarding: {
      sports: ["run", "strength"], days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      session_duration: 30, weekly_minutes_max: 120, implements: ["dumbbells"],
    } }, days, new Map());
    assertEquals(reads.reconciled_session_plans, length === 7 ? 1 : 2);
    for (const monday of ["2026-10-19", "2026-10-26"]) {
      const minutes = result.rows.filter(r => r.date >= monday && r.date < new Date(Date.parse(monday) + 7 * 86400000).toISOString().slice(0, 10))
        .reduce((sum, r) => sum + r.workout_json.duration_minutes, 0);
      assert(minutes <= 120);
    }
  }
});

Deno.test("a weekly budget read failure still fails closed after consolidation", async () => {
  await assertRejects(() => deterministicWeek(database({}, "reconciled_session_plans"), "owner",
    { onboarding: { sports: ["run"], weekly_minutes_max: 120 } },
    [{ date: "2026-10-22", available: true }], new Map()), Error, "Cannot read committed weekly time");
});

Deno.test("Your numbers seed each lift even when unrelated exercises have imported history", async () => {
 const db=database({strength_logs:[{exercise_name:"Dumbbell Row",sets:[{reps:8,weight_kg:25}],date:"2026-10-20"}]});
 const profile={starting_lifts:[{exercise:"Barbell Bench Press",weight_kg:80,reps:6}],equipment:"Full gym",experience:"Intermediate",training_history_confirmed:true};
 const s=await sessionState(db,"owner",profile,"2026-10-22","strength");
 assertEquals(s.last_loads?.barbell_bench_press?.weight_kg,80);
 assertEquals(s.last_loads?.barbell_bench_press?.source,"reported");
 assertEquals(s.actual.length,0);
 const context=await loadReviewContext(db,"owner","2026-10-22","strength",{onboarding:profile});
 assert(context.mainLifts.some(l=>l.exercise==="Barbell Bench Press"&&l.lastWeight===80));
 const w=buildSession(constrainSession(s,context),"strength");assertPublishable(reviewGeneratedWorkout(w,context).corrected,context);
});

Deno.test("increased requested frequency does not reset an established run to twenty minutes", async () => {
 const activities=["2026-10-07","2026-10-14","2026-10-19"].map((date,i)=>({id:String(i),date,type:"Run",duration_seconds:2100,data_json:{}}));
 const o={sports:["run"],primary_sport:"run",experience:"Intermediate",training_history_confirmed:true,session_duration:45,
  day_availability:[{day:"Mon",max_minutes:45},{day:"Wed",max_minutes:45},{day:"Fri",max_minutes:45}]};
 const result=await deterministicWeek(database({effective_activities:activities}),"owner",{onboarding:o},[{date:"2026-10-21",available:true},{date:"2026-10-23",available:true}],new Map());
 const runs=result.rows.filter(r=>r.type==="run");assert(runs.length>0);
 runs.forEach(r=>{assert(r.workout_json.duration_minutes>=30);assert(r.workout_json.duration_minutes<=45);});
});
