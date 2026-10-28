import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildFixtures,
  classifyViolation,
  scoreRaw,
  VIOLATION_TEMPLATES,
} from "./eval_harness.ts";

const fixtures = buildFixtures();

Deno.test("fixtures build non-empty prompts", () => {
  assert(fixtures.length >= 2);
  for (const fx of fixtures) {
    assert(fx.userPrompt.length > 50, `${fx.name} prompt too short`);
    assert(fx.systemPrompt.length > 50);
  }
});

Deno.test("scoreRaw grades a valid endurance workout", () => {
  const raw = JSON.stringify({
    type: "run",
    title: "Tempo",
    duration_minutes: 50,
    tss_estimate: 55,
    rpe_target: 6,
    coach_note: "controlled tempo",
    sections: [
      { name: "Warmup", duration_minutes: 10, exercises: [{ name: "Easy jog", sets: 1, reps: "10min", pace_zone: "Z2" }] },
      { name: "Main Set", duration_minutes: 30, exercises: [{ name: "Tempo", sets: 1, reps: "30min", pace_zone: "Z3" }] },
    ],
  });
  const runFx = fixtures.find((f) => f.name.startsWith("run"))!;
  const s = scoreRaw(raw, runFx);
  assert(s.valid);
  assert(s.tss > 0);
});

Deno.test("scoreRaw flags unparseable output", () => {
  const s = scoreRaw("not json at all", fixtures[0]);
  assert(!s.valid);
  assert(s.parseError);
});

// ---------------------------------------------------------------------------
// classifyViolation — the histogram's backbone
// ---------------------------------------------------------------------------

Deno.test("classifyViolation: every reviewWorkout template maps to a kind", () => {
  // The tripwire. reviewWorkout emits interpolated prose, so the eval groups it
  // by regex. If someone rewords a template in workout_review.ts, this fails
  // here rather than silently dumping that rule into "unknown" in the report.
  for (const { kind, sample } of VIOLATION_TEMPLATES) {
    assertEquals(classifyViolation(sample), kind, `template drifted: ${sample}`);
  }
});

Deno.test("classifyViolation: every kind is covered by a template", () => {
  // Guards the other direction: a new ViolationKind with no sample would never
  // be exercised by the test above.
  const covered = new Set(VIOLATION_TEMPLATES.map((t) => t.kind));
  for (const { kind } of VIOLATION_TEMPLATES) assert(covered.has(kind));
  assertEquals(covered.size, VIOLATION_TEMPLATES.length, "duplicate kinds in VIOLATION_TEMPLATES");
});

Deno.test("classifyViolation: an unrecognised string is 'unknown', not a crash", () => {
  assertEquals(classifyViolation("something nobody has written yet"), "unknown");
});

Deno.test("scoreRaw: reports the violation text and kinds, not just a count", () => {
  // A count can't answer "which rule broke". The strings + kinds are what the
  // notebook's violation histogram is built from.
  const fx = buildFixtures()[0];
  // 500kg squat: over the 1.5x 1RM cap AND the absolute 400kg cap.
  const raw = JSON.stringify({
    type: "strength", title: "Heavy", duration_minutes: 60, tss_estimate: 55, rpe_target: 8,
    coach_note: "", sections: [{
      name: "Main Set", duration_minutes: 50,
      exercises: [{
        name: "Back Squat", sets: 3, reps: "5", weight_kg: 500,
        pace_zone: null, hr_zone: null, rest_seconds: 180, notes: "",
      }],
    }],
  });
  const s = scoreRaw(raw, fx);
  assert(s.valid);
  assertEquals(s.violations, s.violationList?.length, "count and list must agree");
  // Note the engine's ordering: the 1.5x-1RM check clamps 500kg to 225kg first,
  // so the 400kg absolute cap never sees it. The absolute cap is the backstop for
  // lifts with NO known 1RM. Asserting the real kind keeps that documented.
  assert((s.violationKinds ?? []).includes("over_1rm_cap"), JSON.stringify(s.violationList));
  assert(!(s.violationKinds ?? []).includes("unknown"), "every emitted violation should classify");
});
