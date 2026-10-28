import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import type { EnduranceBlock, NumericTarget } from "../../../shared/prescription.ts";
import { prescriptionTotals, prescriptionWorkout } from "./prescription.ts";
import { parseIntervalsSteps } from "./workout_exchange.ts";
import {
  durationToken,
  normZone,
  renderIntervalsWorkout,
  renderStrengthSession,
} from "./intervals_workout.ts";
import type { Workout } from "./types.ts";

Deno.test("normZone accepts the messy forms LLMs emit", () => {
  assertEquals(normZone("Z4"), "Z4");
  assertEquals(normZone("Zone 4"), "Z4");
  assertEquals(normZone("4"), "Z4");
  assertEquals(normZone("z2 - easy"), "Z2");
  assertEquals(normZone(""), null);
  assertEquals(normZone(null), null);
});

Deno.test("durationToken parses time and distance variants", () => {
  assertEquals(durationToken("10 min"), "10m");
  assertEquals(durationToken("30s"), "30s");
  assertEquals(durationToken("1h"), "1h");
  assertEquals(durationToken("1km"), "1km");
  assertEquals(durationToken("800m"), "0.8km");   // bare metres ≥100
  assertEquals(durationToken("5m"), "5m");        // bare m <100 ⇒ minutes
  assertEquals(durationToken("5:00"), "300s");    // clock
  assertEquals(durationToken("12"), "12m");       // bare number ⇒ minutes
  assertEquals(durationToken("8-10"), null);      // strength rep range: no duration
});

Deno.test("run renders Intervals step syntax with repeats and recoveries", () => {
  const w: Workout = {
    type: "run", title: "VO2", duration_minutes: 45, tss_estimate: 70, rpe_target: 8,
    coach_note: "Hit the reps.",
    sections: [
      {
        name: "Warmup", duration_minutes: 10,
        exercises: [{ name: "Jog", sets: 1, reps: "10 min", weight_kg: null, pace_zone: null, hr_zone: "Z1", rest_seconds: null, notes: "" }],
      },
      {
        name: "Main Set", duration_minutes: 24,
        exercises: [{ name: "Reps", sets: 4, reps: "3 min", weight_kg: null, pace_zone: "Z5", hr_zone: null, rest_seconds: 180, notes: "" }],
      },
    ],
  };
  const text = renderIntervalsWorkout(w);
  assert(text.includes("Warmup\n- 10m Z1 HR"));
  assert(text.includes("4x\n- 3m Z5 Pace\n- 3m Z1 Pace"));
  assert(text.endsWith("Hit the reps."));
});

Deno.test("strength renders readable list with load/rest/RIR", () => {
  const w: Workout = {
    type: "strength", title: "Lower", duration_minutes: 60, tss_estimate: 50, rpe_target: 8,
    coach_note: "",
    sections: [{
      name: "Main", duration_minutes: 40,
      exercises: [{ name: "Back Squat", sets: 4, reps: "5", weight_kg: 100, pace_zone: null, hr_zone: null, rest_seconds: 180, notes: "2 RIR" }],
    }],
  };
  const text = renderIntervalsWorkout(w);
  assert(text.includes("- Back Squat: 4×5 @ 100kg rest 3m 2 RIR"));
});

Deno.test("renderStrengthSession collapses identical sets", () => {
  const text = renderStrengthSession("Push Day", [
    { name: "Bench", sets: [{ reps: 5, weight_kg: 80 }, { reps: 5, weight_kg: 80 }, { reps: 5, weight_kg: 80 }] },
    { name: "OHP", sets: [{ reps: 8, weight_kg: 40 }, { reps: 6, weight_kg: 42.5 }] },
  ]);
  assert(text.includes("- Bench: 3×(5@80kg)"));
  assert(text.includes("- OHP: 8@40kg, 6@42.5kg"));
});

function prescribedWorkout(sport: "run" | "swim" | "ride", main: Partial<EnduranceBlock>): Workout {
  const block: EnduranceBlock = {
    kind: "endurance", role: "main", label: "Main", repetitions: 1,
    work_seconds: 300, recovery_seconds: 0, recovery_mode: "easy",
    recovery_after_last: false, transition_seconds: 0,
    target: { kind: "rpe", min: 3, max: 4 }, intensity_zone: "Z2",
    ...(sport === "swim" ? { stroke: "freestyle" } : {}),
  };
  const blocks: EnduranceBlock[] = [
    { ...block, role: "warmup", label: "Warmup" },
    { ...block, ...main },
    { ...block, role: "cooldown", label: "Cooldown" },
  ];
  const totals = prescriptionTotals(blocks);
  return prescriptionWorkout({
    version: 1, presentation_version: 4, policy_version: "test", template_id: "test",
    sport, objective: "easy", venue: sport === "swim" ? "pool" : "road",
    duration_seconds: totals.seconds, duration_basis: "timed", distance: totals.distance,
    blocks, reasons: [], rejected: [],
  });
}

Deno.test("absolute running and swimming pace ranges use one trailing unit and whole seconds", () => {
  for (const [sport, kind, min, max, expected] of [
    ["run", "pace_seconds_per_km", 300, 330, "5:00-5:30/km Pace"],
    ["run", "pace_seconds_per_km", 299.6, 330.4, "5:00-5:30/km Pace"],
    ["swim", "pace_seconds_per_100m", 90, 105, "1:30-1:45/100m Pace"],
  ] as const) {
    const numeric_target: NumericTarget = {
      kind, min, max, calibration_date: "2026-10-01", calibration_value: min,
      reliability: "measured", advisory: false,
    };
    const text = renderIntervalsWorkout(prescribedWorkout(sport, { numeric_target }));
    assert(text.includes(`- 300s ${expected}`));
    const steps = parseIntervalsSteps(text);
    assertEquals(steps[1].pace_seconds, [Math.round(min), Math.round(max)]);
    assertEquals(steps[1].pace_unit, sport === "run" ? "km" : "100m");
  }
  assertThrows(() => parseIntervalsSteps("- 300s 5:00/km-5:30/km Pace"));
  assertThrows(() => parseIntervalsSteps("- 300s 4:60-5:30/km Pace"));
  assertEquals(parseIntervalsSteps("- 300s 5:00/km Pace")[0].pace_seconds, [300, 300]);
});

Deno.test("stationary prescription recoveries export as rest and preserve the complete dose", () => {
  const workout = prescribedWorkout("swim", {
    repetitions: 3, recovery_seconds: 45, recovery_mode: "stationary", recovery_after_last: false,
  });
  const text = renderIntervalsWorkout(workout);
  assertEquals(text.split("- 45s intensity=rest").length - 1, 2);
  assertEquals(parseIntervalsSteps(text).reduce((sum, step) => sum + (step.seconds ?? 0), 0),
    workout.prescription!.duration_seconds);
});

Deno.test("legacy repeat blocks are isolated and HR recovery retains exact seconds", () => {
  const exercise = {
    name: "Reps", sets: 3, reps: "3 min", weight_kg: null,
    pace_zone: null, hr_zone: "Z4", rest_seconds: 150, notes: "",
  };
  const workout: Workout = {
    type: "run", title: "Intervals", duration_minutes: 30, tss_estimate: 40,
    rpe_target: 6, coach_note: "Keep it controlled.",
    sections: [{ name: "Main", duration_minutes: 30, exercises: [
      { ...exercise, sets: 1, reps: "5 min" },
      exercise,
      { ...exercise, sets: 2, reps: "1 min" },
      { ...exercise, sets: 1, reps: "10 min" },
    ] }],
  };
  assertEquals(renderIntervalsWorkout(workout), [
    "Main", "- 5m Z4 HR", "", "3x", "- 3m Z4 HR", "- 150s Z1 HR", "",
    "2x", "- 1m Z4 HR", "- 150s Z1 HR", "", "- 10m Z4 HR", "",
    "Keep it controlled.",
  ].join("\n"));
});
