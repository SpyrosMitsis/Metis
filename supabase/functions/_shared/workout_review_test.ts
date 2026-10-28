// Eval harness for the content-review layer — turns "is the engine good?" from a
// vibe into invariants. Run: `deno test supabase/functions/_shared/workout_review_test.ts`
import { assert, assertEquals } from "jsr:@std/assert@1";
import { validateWorkout } from "./workout_schema.ts";
import { activeSafetyRules, computeTss, isHardSession, type ReviewContext, reviewWorkout } from "./workout_review.ts";
import type { InjuryEntry } from "./types.ts";

const EMPTY_CTX: ReviewContext = {
  mainLifts: [],
  weeklySetsByMuscle: {},
  muscleGroupsLast48h: [],
  tsb: 0,
  daysSinceLastHard: 99,
  experience: "Intermediate",
};

// Build a validated Workout from a partial spec (mirrors the real pipeline:
// zod-coerce first, then review).
function mk(over: Record<string, unknown>) {
  const v = validateWorkout({
    type: "strength",
    title: "Session",
    duration_minutes: 60,
    tss_estimate: 55,
    rpe_target: 7,
    coach_note: "",
    sections: [],
    ...over,
  });
  assert(v.ok, `fixture failed to validate: ${v.error}`);
  return v.workout!;
}

const strengthSection = (exercises: Record<string, unknown>[]) => ({
  name: "Main Set",
  duration_minutes: 45,
  exercises,
});

// --- progressive-overload floor --------------------------------------------
Deno.test("strength recovery load below last top set stays reduced", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 80, muscle: "Quads", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, {
    ...EMPTY_CTX,
    mainLifts: [{ exercise: "Back Squat", estimated1rm: 130, lastWeight: 100, lastReps: 5, lastSets: 4 }],
  });
  assertEquals(r.corrected.sections[0].exercises[0].weight_kg, 80);
  assert(!r.violations.some((v) => v.includes("below last top set")));
});

// --- safety ceiling (vs 1RM) -----------------------------------------------
Deno.test("strength load above 1.5x est 1RM is clamped", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Bench Press", sets: 3, reps: "5", weight_kg: 300, muscle: "Chest", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, {
    ...EMPTY_CTX,
    mainLifts: [{ exercise: "Bench Press", estimated1rm: 100, lastWeight: 90 }],
  });
  assertEquals(r.corrected.sections[0].exercises[0].weight_kg, 150); // 1.5 * 100
  assert(r.violations.some((v) => v.includes("exceeds 1.5")));
});

// --- absolute sanity cap (no 1RM available) --------------------------------
Deno.test("absurd load with no 1RM is capped at the absolute limit", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Dumbbell Curl", sets: 3, reps: "10", weight_kg: 999, muscle: "Biceps", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, EMPTY_CTX);
  assertEquals(r.corrected.sections[0].exercises[0].weight_kg, 400);
  assert(r.violations.some((v) => v.includes("sanity cap")));
});

// --- weekly volume landmark ------------------------------------------------
Deno.test("blowing past the weekly volume landmark is flagged", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 8, reps: "8", weight_kg: 100, muscle: "Quads", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, { ...EMPTY_CTX, weeklySetsByMuscle: { Quads: 18 } }); // 18 + 8 = 26
  assert(r.violations.some((v) => v.includes("Quads") && v.includes("landmark")));
});

// --- 48h muscle recovery ---------------------------------------------------
Deno.test("hard-loading a muscle trained in the last 48h is flagged", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 100, muscle: "Quads", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, { ...EMPTY_CTX, muscleGroupsLast48h: ["Quads"] });
  assert(r.violations.some((v) => v.includes("last 48h")));
});

// --- endurance readiness ---------------------------------------------------
Deno.test("hard run while very fatigued (TSB < -20) is flagged", () => {
  const w = mk({
    type: "run",
    rpe_target: 9,
    sections: [{
      name: "Main Set",
      duration_minutes: 40,
      exercises: [{ name: "VO2 intervals", sets: 5, reps: "3 min", hr_zone: "Z5", notes: "" }],
    }],
  });
  assert(isHardSession(w));
  const r = reviewWorkout(w, { ...EMPTY_CTX, tsb: -25 });
  assert(r.violations.some((v) => v.includes("very fatigued")));
});

Deno.test("back-to-back hard days are flagged", () => {
  const w = mk({
    type: "run",
    rpe_target: 8,
    sections: [{
      name: "Main Set",
      duration_minutes: 30,
      exercises: [{ name: "Threshold", sets: 1, reps: "20 min", hr_zone: "Z4", notes: "" }],
    }],
  });
  const r = reviewWorkout(w, { ...EMPTY_CTX, daysSinceLastHard: 1 });
  assert(r.violations.some((v) => v.includes("back-to-back")));
});

// --- TSS is engine-owned -----------------------------------------------------
Deno.test("endurance TSS is always the computed value, silently", () => {
  // The prompt no longer asks for tss_estimate (models can't count it); the
  // engine fills it. A wildly wrong legacy self-report is still recorded in
  // tssReplaced for observability, but it is NOT a violation — the old flag
  // burnt a repair call to fix a number we were about to overwrite anyway.
  const w = mk({
    type: "run",
    tss_estimate: 300, // absurd for 30 min easy
    rpe_target: 3,
    sections: [{
      name: "Main Set",
      duration_minutes: 30,
      exercises: [{ name: "Easy jog", sets: 1, reps: "30 min", hr_zone: "Z2", notes: "" }],
    }],
  });
  const r = reviewWorkout(w, EMPTY_CTX);
  assert(r.tssReplaced, "expected the disagreement to be recorded");
  assertEquals(r.corrected.tss_estimate, computeTss(w));
  assert(r.corrected.tss_estimate < 60);
  assert(!r.violations.some((v) => /tss_estimate/.test(v)), "must not trigger a repair pass");
});

Deno.test("a missing tss_estimate is filled from the computation", () => {
  // What every generation looks like now: the field arrives absent (schema
  // defaults it to 0) and the engine owns the number end to end.
  const w = mk({
    type: "run",
    tss_estimate: 0,
    rpe_target: 3,
    sections: [{
      name: "Main Set",
      duration_minutes: 40,
      exercises: [{ name: "Easy jog", sets: 1, reps: "40 min", hr_zone: "Z2", notes: "" }],
    }],
  });
  const r = reviewWorkout(w, EMPTY_CTX);
  assertEquals(r.corrected.tss_estimate, 32); // 40 min x Z2 0.8
  assertEquals(r.tssReplaced, undefined, "filling an empty field is not a disagreement");
  assertEquals(r.violations, []);
});

Deno.test("a strength session with no estimate gets the sets heuristic", () => {
  const w = mk({
    tss_estimate: 0,
    rpe_target: 7,
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 100, muscle: "Quads", notes: "" },
      { name: "Romanian Deadlift", sets: 3, reps: "8", weight_kg: 80, muscle: "Hamstrings", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, EMPTY_CTX);
  assertEquals(r.corrected.tss_estimate, Math.round(7 * 3.3)); // 7 working sets
});

Deno.test("computeTss: ~60 min Z2 lands in a sane endurance range", () => {
  const w = mk({
    type: "run",
    sections: [{
      name: "Main Set",
      duration_minutes: 60,
      exercises: [{ name: "Z2", sets: 1, reps: "60 min", hr_zone: "Z2", notes: "" }],
    }],
  });
  const tss = computeTss(w);
  assert(tss >= 40 && tss <= 60, `Z2 hour TSS out of range: ${tss}`);
});

// --- clean workout: no false positives -------------------------------------
Deno.test("a sound progressive-overload session produces no violations", () => {
  const w = mk({
    tss_estimate: 50,
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 102.5, muscle: "Quads", notes: "RIR 2" },
    ])],
  });
  const r = reviewWorkout(w, {
    ...EMPTY_CTX,
    mainLifts: [{ exercise: "Back Squat", estimated1rm: 130, lastWeight: 100 }],
    weeklySetsByMuscle: { Quads: 8 },
  });
  assertEquals(r.violations, []);
});

Deno.test("rest day reviews clean with zero TSS", () => {
  const w = mk({ type: "rest", sections: [], tss_estimate: 0, rpe_target: 0 });
  const r = reviewWorkout(w, EMPTY_CTX);
  assertEquals(r.violations, []);
  assertEquals(computeTss(w), 0);
});

// --- contraindication safety engine ----------------------------------------
Deno.test("a contraindicated movement is stripped + marked unsafe", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Deadlift", sets: 3, reps: "5", weight_kg: 140, muscle: "Back", notes: "" },
      { name: "Leg Press", sets: 3, reps: "10", weight_kg: 200, muscle: "Quads", notes: "" },
    ])],
  });
  const injuries: InjuryEntry[] = [{ area: "Lower back", severity: "serious", note: "disc herniation" }];
  const r = reviewWorkout(w, { ...EMPTY_CTX, injuries });
  assert(r.unsafe.some((v) => v.includes("Deadlift")));
  const names = r.corrected.sections.flatMap((s) => s.exercises.map((e) => e.name));
  assert(!names.includes("Deadlift"), "deadlift should be removed");
  assert(names.includes("Leg Press"), "leg press should remain");
});

Deno.test("no injury on file leaves the movement in place", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Deadlift", sets: 3, reps: "5", weight_kg: 140, muscle: "Back", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, EMPTY_CTX);
  assertEquals(r.unsafe, []);
  assertEquals(r.corrected.sections[0].exercises[0].name, "Deadlift");
});

Deno.test("a mild injury flags the movement but does not strip it", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Deadlift", sets: 3, reps: "5", weight_kg: 140, muscle: "Back", notes: "" },
    ])],
  });
  const injuries: InjuryEntry[] = [{ area: "Lower back", severity: "mild" }];
  const r = reviewWorkout(w, { ...EMPTY_CTX, injuries });
  assertEquals(r.unsafe, []);
  assert(r.violations.some((v) => v.includes("Deadlift") && v.includes("contraindicated")));
  const names = r.corrected.sections.flatMap((s) => s.exercises.map((e) => e.name));
  assert(names.includes("Deadlift"), "mild severity should keep the movement, just flagged");
});

Deno.test("an unqualified (unset) severity errs safe and strips like serious", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Deadlift", sets: 3, reps: "5", weight_kg: 140, muscle: "Back", notes: "" },
    ])],
  });
  const injuries: InjuryEntry[] = [{ area: "Lower back", severity: "" }];
  const r = reviewWorkout(w, { ...EMPTY_CTX, injuries });
  assert(r.unsafe.some((v) => v.includes("Deadlift")));
});

Deno.test("moderate severity strips like serious", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Deadlift", sets: 3, reps: "5", weight_kg: 140, muscle: "Back", notes: "" },
    ])],
  });
  const injuries: InjuryEntry[] = [{ area: "Lower back", severity: "moderate" }];
  const r = reviewWorkout(w, { ...EMPTY_CTX, injuries });
  assert(r.unsafe.some((v) => v.includes("Deadlift")));
});

Deno.test("activeSafetyRules matches on the structured area field", () => {
  const rules = activeSafetyRules([{ area: "Knee", severity: "serious" }]);
  assert(rules.length > 0);
  assert(rules.every((r) => r.forbid.test("Pistol Squat")));
});

Deno.test("activeSafetyRules also matches a rule pattern in the free-text note", () => {
  // Freeform notes (Android's NOTE_AREA-style entries) still reach the engine
  // even when `area` itself doesn't name a body part.
  const rules = activeSafetyRules([{ area: "", severity: "moderate", note: "old knee injury from skiing" }]);
  assert(rules.length > 0);
});

Deno.test("activeSafetyRules ignores an empty injuries list", () => {
  assertEquals(activeSafetyRules([]), []);
});

// --- determinism / idempotency ---------------------------------------------
Deno.test("review is deterministic and idempotent (re-review is a no-op)", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 80, muscle: "Quads", notes: "" },
    ])],
  });
  const ctx = {
    ...EMPTY_CTX,
    mainLifts: [{ exercise: "Back Squat", estimated1rm: 130, lastWeight: 100 }],
  };
  const first = reviewWorkout(w, ctx);
  const second = reviewWorkout(first.corrected, ctx); // re-reviewing the fixed output
  assertEquals(second.violations, []); // nothing left to fix
  assertEquals(first.corrected.sections[0].exercises[0].weight_kg, 80);
  assertEquals(second.corrected.sections[0].exercises[0].weight_kg, 80);
});

// --- equipment hard-filter -------------------------------------------------
Deno.test("strength lift needing unavailable equipment is stripped + flagged", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Barbell Bench Press", sets: 4, reps: "5", weight_kg: 60, muscle: "Chest", notes: "" },
      { name: "Push-Up", sets: 3, reps: "12", muscle: "Chest", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, { ...EMPTY_CTX, equipment: "Bodyweight" });
  const names = r.corrected.sections.flatMap((s) => s.exercises.map((e) => e.name));
  assert(!names.includes("Barbell Bench Press"), "barbell lift should be removed");
  assert(names.includes("Push-Up"), "bodyweight lift should remain");
  assert(r.violations.some((v) => /Barbell Bench Press/.test(v)));
});

// --- intensity ceiling on low readiness ------------------------------------
Deno.test("hard endurance session on a wrecked athlete is capped to easy", () => {
  const w = validateWorkout({
    type: "run", title: "Intervals", duration_minutes: 50, tss_estimate: 90, rpe_target: 9,
    coach_note: "", sections: [
      { name: "Main Set", duration_minutes: 30, exercises: [{ name: "VO2 reps", sets: 5, reps: "3min", pace_zone: "Z5" }] },
    ],
  }).workout!;
  assert(isHardSession(w));
  const r = reviewWorkout(w, { ...EMPTY_CTX, tsb: -25, readiness: 20 });
  assert(r.corrected.rpe_target <= 5, "rpe should be capped");
  const zones = r.corrected.sections.flatMap((s) => s.exercises.map((e) => e.pace_zone));
  assert(zones.every((z) => z !== "Z5" && z !== "Z4"), "hard zones should be downgraded");
  assert(r.violations.some((v) => /readiness|TSB/i.test(v)));
});

// --- recovery bands: the promises recoveryBlock makes, enforced --------------
// context.ts recoveryBlock tells the model "red → cap RPE 4" and "amber → cap
// RPE 6, no intervals/threshold". These used to be prompt-only (formerly
// KNOWN_CONTRADICTIONS "recovery-cap"); the caps below hold them at the same
// band thresholds recovery.ts computes (red <34, amber <67).

const hardRun = () =>
  validateWorkout({
    // tss_estimate 51 = the zone-priced value (30 min Z4), so the unrelated
    // TSS cross-check stays quiet and these tests isolate the recovery caps.
    type: "run", title: "Tempo", duration_minutes: 45, tss_estimate: 51, rpe_target: 8,
    coach_note: "", sections: [
      { name: "Main Set", duration_minutes: 30, exercises: [{ name: "Tempo", sets: 1, reps: "30min", pace_zone: "Z4" }] },
    ],
  }).workout!;

Deno.test("red recovery (<34) caps a hard session at RPE 4", () => {
  const r = reviewWorkout(hardRun(), { ...EMPTY_CTX, tsb: 0, readiness: 30 });
  assert(r.corrected.rpe_target <= 4, `rpe ${r.corrected.rpe_target} should be ≤4 on red`);
  assert(r.violations.some((v) => /capped to easy aerobic/.test(v)));
});

Deno.test("amber recovery (34-66) caps a hard session at RPE 6 and kills the intervals", () => {
  // THE REGRESSION: amber used to pass entirely — the prompt promised a cap no
  // code enforced, and run/int/fatigued-amber existed to measure the gap.
  const r = reviewWorkout(hardRun(), { ...EMPTY_CTX, tsb: -10, readiness: 50 });
  assert(r.corrected.rpe_target <= 6, `rpe ${r.corrected.rpe_target} should be ≤6 on amber`);
  const zones = r.corrected.sections.flatMap((s) => s.exercises.map((e) => e.pace_zone));
  assert(zones.every((z) => z !== "Z4" && z !== "Z5"), "threshold work must be downgraded on amber");
  assert(r.violations.some((v) => /amber/.test(v)));
});

Deno.test("green recovery leaves a hard session alone", () => {
  const r = reviewWorkout(hardRun(), { ...EMPTY_CTX, tsb: 0, readiness: 80 });
  assertEquals(r.corrected.rpe_target, 8);
  assert(r.violations.length === 0, `unexpected: ${r.violations.join("; ")}`);
});

Deno.test("an UNMEASURED readiness caps nothing", () => {
  // With no check-in and no synced watch data, recovery.ts still returns 50 (the
  // neutral midpoint of its own defaults) and bands it amber. Reported from the
  // app: "why does it have a readiness score of 50 when it doesn't have any
  // data". Acting on it meant an athlete without a wearable was permanently
  // held to RPE 6, on the strength of a number nobody measured.
  const r = reviewWorkout(hardRun(), { ...EMPTY_CTX, tsb: 0, readiness: 50, readinessBasis: "none" });
  assertEquals(r.corrected.rpe_target, 8);
  const zones = r.corrected.sections.flatMap((s) => s.exercises.map((e) => e.pace_zone));
  assert(zones.includes("Z4"), "an unmeasured readiness must not downgrade the zones");
  assert(r.violations.length === 0, `unexpected: ${r.violations.join("; ")}`);
});

Deno.test("a SUBJECTIVE readiness still caps: they told us how they feel", () => {
  const r = reviewWorkout(hardRun(), { ...EMPTY_CTX, tsb: 0, readiness: 50, readinessBasis: "subjective" });
  assert(r.corrected.rpe_target <= 6, `rpe ${r.corrected.rpe_target} should be ≤6`);
});

Deno.test("deep TSB caps even when readiness is unmeasured: form is real training", () => {
  // The load-driven rule survives the change above, because TSB comes from
  // sessions the athlete actually did, not from a placeholder.
  const r = reviewWorkout(hardRun(), { ...EMPTY_CTX, tsb: -25, readiness: 50, readinessBasis: "none" });
  assert(r.corrected.rpe_target <= 5, `rpe ${r.corrected.rpe_target} should be ≤5 on deep TSB`);
});

Deno.test("deep TSB keeps its own RPE 5 cap independent of the recovery band", () => {
  // prompt.ts's "TSB ≤ -20 → recovery week" rule is load-driven, not
  // recovery-score-driven, so it fires even when today's readiness reads fine.
  const r = reviewWorkout(hardRun(), { ...EMPTY_CTX, tsb: -25, readiness: 80 });
  assert(r.corrected.rpe_target <= 5, `rpe ${r.corrected.rpe_target} should be ≤5 on deep TSB`);
});

// --- weekly set landmark is experience-tiered --------------------------------
Deno.test("the weekly set landmark follows the athlete's tier (12/18/22)", () => {
  // THE REGRESSION (formerly KNOWN_CONTRADICTIONS "weekly-sets"): a flat 22
  // meant a Beginner prescribed 20 sets broke prompt.ts's ~8-12 tier and passed.
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 14, reps: "8", weight_kg: 60, muscle: "Quads", notes: "" },
    ])],
  });
  const beginner = reviewWorkout(w, { ...EMPTY_CTX, experience: "Beginner" });
  assert(beginner.violations.some((v) => /~12-set landmark/.test(v)), "14 sets breaks the Beginner tier");
  const intermediate = reviewWorkout(w, { ...EMPTY_CTX, experience: "Intermediate" });
  assert(intermediate.violations.length === 0, "14 sets is inside the Intermediate tier");
  const advanced = reviewWorkout(w, { ...EMPTY_CTX, experience: "Advanced" });
  assert(advanced.violations.length === 0, "14 sets is inside the Advanced tier");
});

// --- swim is endurance -------------------------------------------------------
Deno.test("a hard CSS swim is a hard session and is priced by its zones", () => {
  // THE REGRESSION (formerly KNOWN_CONTRADICTIONS "swim"): a Z4 swim was
  // invisible to hard-day spacing and priced as strength working sets.
  const w = validateWorkout({
    type: "swim", title: "CSS Intervals", duration_minutes: 45, tss_estimate: 60, rpe_target: 6,
    coach_note: "", sections: [
      { name: "Main Set", duration_minutes: 40, exercises: [{ name: "10x100m CSS", sets: 10, reps: "100m", pace_zone: "Z4" }] },
    ],
  }).workout!;
  assert(isHardSession(w), "a Z4 swim must register as hard");
  assertEquals(computeTss(w), Math.round(40 * 1.7), "priced as 40 min of Z4, not as working sets");
});

// --- quality overload: one session, one quality focus -------------------------
Deno.test("stacking a full threshold block and a full VO2 block flags", () => {
  // The judge's blind-spot find: 20 min tempo + 3x4 min VO2 passed every check,
  // yet each block alone is a full quality session (prompt.ts:57-59).
  const w = validateWorkout({
    type: "run", title: "Combo", duration_minutes: 60, tss_estimate: 60, rpe_target: 8,
    coach_note: "", sections: [
      { name: "Tempo", duration_minutes: 20, exercises: [{ name: "Tempo", sets: 1, reps: "20min", pace_zone: "Z4" }] },
      { name: "VO2", duration_minutes: 12, exercises: [{ name: "4min reps", sets: 3, reps: "4min", pace_zone: "Z5" }] },
    ],
  }).workout!;
  const r = reviewWorkout(w, EMPTY_CTX);
  assert(r.violations.some((v) => /one quality focus per day/.test(v)), r.violations.join("; "));
});

Deno.test("a tempo with strides stays legal", () => {
  // 6-10 x ~20s of strides is ~3 min of Z5: appending them must not read as a
  // second quality block, or every classic tempo+strides day would flag.
  const w = validateWorkout({
    type: "run", title: "Tempo + strides", duration_minutes: 50, tss_estimate: 55, rpe_target: 7,
    coach_note: "", sections: [
      { name: "Tempo", duration_minutes: 25, exercises: [{ name: "Tempo", sets: 1, reps: "25min", pace_zone: "Z4" }] },
      { name: "Strides", duration_minutes: 3, exercises: [{ name: "8x20s", sets: 8, reps: "20s", pace_zone: "Z5" }] },
    ],
  }).workout!;
  const r = reviewWorkout(w, EMPTY_CTX);
  assert(!r.violations.some((v) => /quality/.test(v)), r.violations.join("; "));
});

Deno.test("a run past the 40-min quality ceiling flags; a ride does not", () => {
  const session = (type: string) =>
    validateWorkout({
      type, title: "Big quality", duration_minutes: 75, tss_estimate: 78, rpe_target: 8,
      coach_note: "", sections: [
        { name: "Main Set", duration_minutes: 46, exercises: [{ name: "2x23min", sets: 2, reps: "23min", pace_zone: "Z3" }] },
      ],
    }).workout!;
  const run = reviewWorkout(session("run"), EMPTY_CTX);
  assert(run.violations.some((v) => /40-min quality ceiling/.test(v)), run.violations.join("; "));
  // 2x20+ sweet spot is normal cycling; the ceiling is a RUNNING rule.
  const ride = reviewWorkout(session("ride"), EMPTY_CTX);
  assert(!ride.violations.some((v) => /quality ceiling/.test(v)), ride.violations.join("; "));
});

// --- injury backoff (structural, dated) --------------------------------------
// The distinction these pin: `injuries` is a standing fact, a backoff is a
// DATED instruction from a session that hurt. Both are enforced here rather
// than left to the prompt, for the reason training_paused_until is a column.

const backoff = (area: string, level: "ease" | "avoid", until = "2099-01-01") =>
  ({ area, level, until });

Deno.test("avoid backoff strips the lifts that load the area", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 100, muscle: "Quads", notes: "" },
      { name: "Bench Press", sets: 3, reps: "8", weight_kg: 70, muscle: "Chest", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, { ...EMPTY_CTX, backoffs: [backoff("Knee", "avoid")] });
  assertEquals(r.corrected.sections[0].exercises.map((e) => e.name), ["Bench Press"]);
  assert(r.violations.some((v) => v.includes("Back Squat") && v.includes("avoid backoff")));
});

Deno.test("avoid backoff strips a lift the SAFETY rules would have allowed", () => {
  // A back squat is not contraindicated for a knee (the safety engine forbids
  // pistols and depth jumps, not squats), so this is the case the backoff layer
  // exists for: the athlete's knee hurt on Tuesday, so today's squat comes out.
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 100, muscle: "Quads", notes: "" },
    ])],
  });
  const injuries: InjuryEntry[] = [{ area: "Knee", severity: "moderate" }];
  const withoutBackoff = reviewWorkout(w, { ...EMPTY_CTX, injuries });
  assertEquals(withoutBackoff.corrected.sections[0].exercises.length, 1);

  const withBackoff = reviewWorkout(w, { ...EMPTY_CTX, injuries, backoffs: [backoff("Knee", "avoid")] });
  assertEquals(withBackoff.corrected.sections.length, 0);
});

Deno.test("avoid backoff marks an endurance session in the affected sport unsafe", () => {
  const w = validateWorkout({
    type: "run", title: "Easy run", duration_minutes: 40, tss_estimate: 35, rpe_target: 4,
    coach_note: "", sections: [
      { name: "Main", duration_minutes: 40, exercises: [{ name: "Steady", sets: 1, reps: "40min", pace_zone: "Z2" }] },
    ],
  }).workout!;
  const r = reviewWorkout(w, { ...EMPTY_CTX, backoffs: [backoff("Achilles", "avoid")] });
  assert(r.unsafe.some((v) => v.includes("Achilles")), r.unsafe.join("; "));
});

Deno.test("avoid backoff on an unrelated area leaves the session alone", () => {
  const w = validateWorkout({
    type: "run", title: "Easy run", duration_minutes: 40, tss_estimate: 35, rpe_target: 4,
    coach_note: "", sections: [
      { name: "Main", duration_minutes: 40, exercises: [{ name: "Steady", sets: 1, reps: "40min", pace_zone: "Z2" }] },
    ],
  }).workout!;
  const r = reviewWorkout(w, { ...EMPTY_CTX, backoffs: [backoff("Shoulder", "avoid")] });
  assertEquals(r.unsafe.length, 0);
  assertEquals(r.corrected.sections[0].exercises.length, 1);
});

Deno.test("ease backoff caps intensity instead of removing the session", () => {
  const w = validateWorkout({
    type: "run", title: "Threshold", duration_minutes: 50, tss_estimate: 70, rpe_target: 8,
    coach_note: "", sections: [
      { name: "Main", duration_minutes: 30, exercises: [{ name: "3x10min", sets: 3, reps: "10min", pace_zone: "Z4" }] },
    ],
  }).workout!;
  const r = reviewWorkout(w, { ...EMPTY_CTX, backoffs: [backoff("Knee", "ease")] });
  assertEquals(r.corrected.sections[0].exercises[0].pace_zone, "Z2");
  assert(r.corrected.rpe_target <= 6);
  assertEquals(r.unsafe.length, 0, "easing is not a safety block, the athlete still trains");
});

Deno.test("ease backoff keeps the loading lifts but flags them for the repair pass", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 100, muscle: "Quads", notes: "" },
    ])],
  });
  const r = reviewWorkout(w, { ...EMPTY_CTX, backoffs: [backoff("Knee", "ease")] });
  assertEquals(r.corrected.sections[0].exercises.length, 1, "ease means lighter, not gone");
  assert(r.violations.some((v) => v.includes("Back Squat") && v.includes("ease backoff")));
});

Deno.test("no backoffs means byte-identical behavior to before", () => {
  const w = mk({
    sections: [strengthSection([
      { name: "Back Squat", sets: 4, reps: "5", weight_kg: 100, muscle: "Quads", notes: "" },
    ])],
  });
  const without = reviewWorkout(w, EMPTY_CTX);
  const empty = reviewWorkout(w, { ...EMPTY_CTX, backoffs: [] });
  assertEquals(empty.violations, without.violations);
  assertEquals(empty.corrected, without.corrected);
});
