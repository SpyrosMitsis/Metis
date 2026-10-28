import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { buildSession, type SessionState } from "./session_engine.ts";
import { compileProposal } from "./proposal_compiler.ts";
import { currentCalibration, selectNumericTarget } from "./target_selection.ts";
import { assertDaySlots, sessionWindows } from "./session_slots.ts";
import { importPrescription, parseIntervalsSteps } from "./workout_exchange.ts";
import { renderIntervalsWorkout } from "./intervals_workout.ts";
import { strengthDoseEvidence } from "./execution_evidence.ts";
import { EXERCISE_CATALOG } from "./exercise_catalog.ts";
import { requirements, boundedLoad } from "./exercise_requirements.ts";
import { deriveProgramState } from "./program_state.ts";

const state = (patch: Partial<SessionState> = {}): SessionState => ({
  date: "2026-10-22", sport: "run", max_minutes: 40, weekly_remaining_minutes: 100,
  experience: "Intermediate", history_complete: true, implements: [], venue: "road", fatigue: "normal", blocked_sports: [],
  actual: Array.from({length: 8}, (_, i) => ({id: String(i), date: `2026-10-${13 + i}`, sport: "run", minutes: 40, effort: 3, response: "comfortable"})), ...patch,
});
const block = () => buildSession(state(), "easy").prescription!.blocks.find(b => b.kind === "endurance" && b.role === "main")! as import("../../../shared/prescription.ts").EnduranceBlock;
const calibration = {sport: "ride" as const, kind: "power" as const, value: 200, date: "2026-10-01", reliability: "measured" as const};
Deno.test("numeric targets require correct sport, fresh measurement and equipment", () => {
  const s = state({sport: "ride", implements: ["power_meter"], calibration: [calibration]});
  assert(currentCalibration(calibration, s));
  for (const c of [{...calibration, date: "2026-10-23"}, {...calibration, date: "2025-01-01"}, {...calibration, date: "invalid"}, {...calibration, reliability: "estimated" as const}, {...calibration, value: NaN}]) assert(!currentCalibration(c, s));
  assert(!currentCalibration(calibration, {...s, implements: []}));
  assert(!currentCalibration(calibration, {...s, sport: "run"}));
  assertEquals(selectNumericTarget(s, "easy", block())?.min, 112);
  assertEquals(selectNumericTarget(s, "easy", block())?.max, 150);
});
Deno.test("pace guidance abstains on trail, hills and caution conditions", () => {
  const s = state({calibration: [{sport: "run", kind: "pace", value: 300, date: "2026-10-01", reliability: "measured"}]});
  assert(selectNumericTarget(s, "easy", block()));
  assertEquals(selectNumericTarget({...s, venue: "trail"}, "easy", block()), undefined);
  assertEquals(selectNumericTarget(s, "hills", block()), undefined);
  assertEquals(selectNumericTarget({...s, conditions: {date: s.date, tier: "caution", reasons: ["heat"]}}, "easy", block()), undefined);
  assertEquals(selectNumericTarget({...s, calibration: [{...s.calibration![0], kind: "personal_best"}]}, "easy", block()), undefined);
});
Deno.test("short work does not use lagging heart rate as interval target", () => {
  const s = state({implements: ["heart_rate_monitor"], calibration: [{sport: "run", kind: "heart_rate", value: 170, date: "2026-10-01", reliability: "measured"}]});
  const b = {...block(), work_seconds: 60, target: {kind: "rpe" as const, min: 8, max: 8}};
  assertEquals(selectNumericTarget(s, "intervals", b), undefined);
  assertEquals(selectNumericTarget(s, "intervals", {...b, work_seconds: 240})?.kind, "heart_rate_bpm");
});
Deno.test("compiler prevents model dose, effort and eligibility bypasses", () => {
  const w = buildSession(state(), "easy");
  assertThrows(() => compileProposal(w, state({max_minutes: 20})));
  assertThrows(() => compileProposal(w, state({blocked_sports: ["run"]})));
  assertThrows(() => compileProposal(buildSession(state(), "intervals"), state({history_complete: false})));
  w.prescription!.blocks.forEach(b => { if (b.kind === "endurance") b.target.max = 9; });
  assertThrows(() => compileProposal(w, state()));
});
Deno.test("compiler independently rebuilds stale target provenance and display", () => {
  const w = buildSession(state({calibration: [{sport: "run", kind: "pace", value: 300, date: "2026-10-01", reliability: "measured"}]}), "easy");
  assert(w.prescription!.blocks.some(b => b.kind === "endurance" && b.numeric_target));
  const compiled = compileProposal(w, state());
  assert(!compiled.prescription!.blocks.some(b => b.kind === "endurance" && b.numeric_target));
  assert(!compiled.sections.some(s => s.exercises.some(e => e.notes.includes("test 2026"))));
});
Deno.test("compiler and template engine agree on blocked-weather indoor eligibility", () => {
  const w = buildSession(state(), "easy");
  const s = state({conditions: {date: "2026-10-22", tier: "blocked", reasons: ["storm"]}});
  assertThrows(() => compileProposal(w, s));
  assertEquals(compileProposal(w, {...s, implements: ["treadmill"]}).prescription!.venue, "treadmill");
});
Deno.test("second sessions require explicit windows, daily capacity and recovery", () => {
  const w = buildSession(state({max_minutes: 20}), "easy");
  const sessions = [{date: "2026-10-22", session_slot: 0, workout_json: w}, {date: "2026-10-22", session_slot: 1, workout_json: w}];
  assertThrows(() => assertDaySlots({}, "2026-10-22", sessions));
  const o = {session_windows: [{day: "Thu", slot: 0, start_minute: 420, max_minutes: 30}, {day: "Thu", slot: 1, start_minute: 1080, max_minutes: 30}]};
  assertDaySlots(o, "2026-10-22", sessions);
  assertThrows(() => assertDaySlots({...o, day_availability: [{day: "Thu", max_minutes: 30}]}, "2026-10-22", sessions));
  assertThrows(() => sessionWindows({session_windows: [{...o.session_windows[0], max_minutes: NaN}]}, "2026-10-22"));
});
Deno.test("combined sessions require multisport goal and exact transition accounting", () => {
  const run = buildSession(state({max_minutes: 20}), "easy");
  const ride = buildSession(state({sport: "ride", max_minutes: 20}), "easy");
  const sessions = [{date: "2026-10-22", session_slot: 0, start_minute: 420, combined_group: "brick", workout_json: run}, {date: "2026-10-22", session_slot: 1, start_minute: 445, combined_group: "brick", transition_before_seconds: 300, workout_json: ride}];
  const o = {session_windows: [{day: "Thu", slot: 0, start_minute: 420, max_minutes: 20}, {day: "Thu", slot: 1, start_minute: 445, max_minutes: 20}]};
  assertThrows(() => assertDaySlots(o, "2026-10-22", sessions));
  assertDaySlots({...o, multisport_goal: "duathlon"}, "2026-10-22", sessions);
  assertThrows(() => assertDaySlots({...o, multisport_goal: "duathlon"}, "2026-10-22", [{...sessions[0]}, {...sessions[1], transition_before_seconds: 0}]));
});
Deno.test("lossless prescription import preserves every supported objective and yards", () => {
  for (const [sport, objective] of [["run", "run_walk"], ["ride", "easy"], ["swim", "easy"], ["strength", "strength"], ["rest", "mobility"], ["rest", "optional_light"], ["rest", "active_recovery"]] as const) {
    const w = buildSession(state({sport, venue: sport === "swim" ? "pool" : "road", implements: ["dumbbells"], pool: {length: 25, unit: "yd", strokes: ["freestyle"], seconds_per_length: 30}}), objective);
    const result = importPrescription(JSON.stringify({format: "workout-maker-prescription", version: 1, prescription: w.prescription}));
    assertEquals(result, w);
  }
});
Deno.test("independent transport parser verifies power, seconds and yard conversions", () => {
  const s = state({sport: "ride", calibration: [calibration], implements: ["power_meter"]});
  const w = buildSession(s, "easy");
  const steps = parseIntervalsSteps(renderIntervalsWorkout(w));
  assertEquals(steps.reduce((sum, b) => sum + (b.seconds ?? 0), 0), w.prescription!.duration_seconds);
  assert(steps.some(b => b.power_watts?.[0] === 112));
  const swim = buildSession(state({sport: "swim", venue: "pool", pool: {length: 25, unit: "yd", strokes: ["freestyle"], seconds_per_length: 30}}), "easy");
  const metres = parseIntervalsSteps(renderIntervalsWorkout(swim)).reduce((sum, b) => sum + (b.metres ?? 0), 0);
  assert(Math.abs(metres - swim.prescription!.distance!.value * 0.9144) < 0.01);
  assertThrows(() => parseIntervalsSteps("- 10m 70%"));
});
Deno.test("logged hold and carry units verify dose without interpreting them as repetitions", () => {
  for (const [reps, unit] of [["30 sec", "seconds"], ["20 metres", "metres"]]) {
    const [result] = strengthDoseEvidence([{name: "Plank", sets: 2, reps}], [{exercise_name: "Plank", sets: [{reps: Number.parseInt(reps), quantity_unit: unit}, {reps: Number.parseInt(reps), quantity_unit: unit}]}]);
    assertEquals(result.status, "recorded_sets_match");
  }
});
Deno.test("generated metadata remains exactly aligned with bundled catalog", () => {
  const json = JSON.parse(Deno.readTextFileSync(new URL("../../../shared/exercise_metadata.json", import.meta.url)));
  assertEquals(json, EXERCISE_CATALOG.map(e => ({name: e.name, ...requirements(e)})));
});
Deno.test("reduced periods, explicit event preparation and material availability changes are operational", () => {
  const actual = state().actual;
  const goal = {id: "run", sport: "run" as const, objective: "performance" as const, priority: "primary" as const};
  const p = deriveProgramState("2026-10-22", [goal], actual, true, {periodized: true, program_started_on: "2026-10-01", weekly_minutes_max: 10});
  assertEquals(p.sports[0].phase, "reduced"); assert(!p.sports[0].quality_allowed); assert(p.observations.some(o => o.includes("timelines")));
  const event = deriveProgramState("2026-10-22", [goal, {...goal, event_date: "2026-10-25", event_priority: "A", event_policy: {days: 7, duration_factor: 0.5, allow_quality: false}}], actual, true);
  assertEquals(event.sports[0].phase, "event_preparation"); assertEquals(event.sports[0].session_minutes, 20);
});

import { getForecastWeather } from "./weather.ts";
Deno.test("forecast date and missing measurements stay explicit; repeated requests are cached", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const date = "2026-10-24";
  const daily = {time: [date], temperature_2m_max: [20], apparent_temperature_max: [20], apparent_temperature_min: [10], precipitation_sum: [0], precipitation_probability_max: [5], wind_speed_10m_max: [10]};
  try {
    globalThis.fetch = (() => { calls++; return Promise.resolve(Response.json({daily, hourly: {relative_humidity_2m: [40, 55]}})); }) as typeof fetch;
    const forecast = await getForecastWeather(10.123, 20.456, date);
    assertEquals(forecast?.localDate, date); assertEquals(forecast?.humidity, 55);
    assert(forecast?.summary.includes("not observations"));
    assertEquals(await getForecastWeather(10.123, 20.456, date), forecast); assertEquals(calls, 1);
    globalThis.fetch = (() => Promise.resolve(Response.json({daily}))) as typeof fetch;
    assertEquals(await getForecastWeather(10.124, 20.456, date), null);
    globalThis.fetch = (() => Promise.resolve(Response.json({daily: {...daily, time: ["2026-10-23"]}, hourly: {relative_humidity_2m: [50]}}))) as typeof fetch;
    assertEquals(await getForecastWeather(10.125, 20.456, date), null);
  } finally { globalThis.fetch = original; }
});

Deno.test("open-water confirmation expires by date and cannot establish swimming exposure", () => {
  const checks = {date: "2026-10-22", experienced: true, supervised_venue: true, buddy: true, venue_open: true, conditions_approved_by_venue: true, stroke: "freestyle", max_minutes: 20};
  const s = state({sport: "swim", venue: "open_water", max_minutes: 20, open_water: checks, actual: state().actual.map(a => ({...a, sport: "swim"}))});
  const w = buildSession(s, "easy"); assertEquals(w.prescription!.venue, "open_water");
  assert(w.prescription!.blocks.every(b => b.kind === "endurance" && !b.distance));
  assertThrows(() => buildSession({...s, actual: []}, "easy"));
  assertThrows(() => compileProposal(w, {...s, open_water: {...checks, date: "2026-10-21"}}));
  const pool = {length: 25, unit: "m" as const, strokes: ["freestyle"], seconds_per_length: 30};
  assertEquals(compileProposal(w, {...s, pool, open_water: {...checks, date: "2026-10-21"}}).prescription!.venue, "pool");
});

Deno.test("assistance cannot silently progress in the direction of added load", () => {
 assertEquals(boundedLoad("assistance",20,40),40);
 assertEquals(boundedLoad("assistance",50,40),50);
 assertEquals(boundedLoad("added_weight",50,40),40);
 assertEquals(boundedLoad("added_weight",20,40),20);
});
