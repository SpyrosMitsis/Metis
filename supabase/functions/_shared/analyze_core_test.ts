// Coverage matching invariants — substitution-aware planned-vs-logged scoring.
// Run: `deno test supabase/functions/_shared/analyze_core_test.ts`
import { assertEquals } from "jsr:@std/assert@1";
import { type CoverageItem, matchCoverage } from "./analyze_core.ts";

const P = (name: string, muscle: string | null): CoverageItem => ({ name, muscle });

Deno.test("exact names match without substitutions", () => {
  const planned = [P("Machine Chest Press", "Chest"), P("Triceps Pushdown", "Triceps")];
  const logged = [P("Machine Chest Press", "Chest"), P("Triceps Pushdown", "Triceps")];
  const cov = matchCoverage(planned, logged);
  assertEquals(cov.done, 2);
  assertEquals(cov.skipped, []);
  assertEquals(cov.substitutions, []);
});

Deno.test("same-muscle swap covers a slot but is explicitly identified as a substitution", () => {
  // The real case: planned Machine Bicep Curl, logged Preacher Curl (both Biceps),
  // plus a genuinely-skipped Stretching with no same-muscle lift performed.
  const planned = [P("Machine Bicep Curl", "Biceps"), P("Stretching", null)];
  const logged = [P("Preacher Curl", "Biceps")];
  const cov = matchCoverage(planned, logged);
  assertEquals(cov.done, 1);
  assertEquals(cov.skipped, ["Stretching"]);
  assertEquals(cov.substitutions, [{ logged: "Preacher Curl", planned: "Machine Bicep Curl" }]);
});

Deno.test("a single logged lift cannot cover two planned slots", () => {
  const planned = [P("Barbell Curl", "Biceps"), P("Hammer Curl", "Biceps")];
  const logged = [P("Preacher Curl", "Biceps")]; // one lift, two planned biceps
  const cov = matchCoverage(planned, logged);
  assertEquals(cov.done, 1);
  assertEquals(cov.skipped.length, 1);
  assertEquals(cov.substitutions.length, 1);
});

Deno.test("name match is preferred over substitution and consumes its lift", () => {
  const planned = [P("Hammer Curl", "Biceps"), P("Barbell Curl", "Biceps")];
  // Hammer Curl is logged exactly; the leftover Preacher Curl substitutes for Barbell Curl.
  const logged = [P("Preacher Curl", "Biceps"), P("Hammer Curl", "Biceps")];
  const cov = matchCoverage(planned, logged);
  assertEquals(cov.done, 2);
  assertEquals(cov.skipped, []);
  assertEquals(cov.substitutions, [{ logged: "Preacher Curl", planned: "Barbell Curl" }]);
});

Deno.test("Other / Cardio / unknown muscles never substitute", () => {
  const planned = [P("Stretching", "Other"), P("Some Drill", null), P("Treadmill Run", "Cardio")];
  const logged = [P("Foam Rolling", "Other"), P("Random Move", null), P("Rowing Machine", "Cardio")];
  const cov = matchCoverage(planned, logged);
  assertEquals(cov.done, 0);
  assertEquals(cov.substitutions, []);
  assertEquals(cov.skipped.length, 3);
});

Deno.test("substring exercise variants cannot inherit the original lift prescription", () => {
  const cov = matchCoverage([P("Dumbbell Row", "Back")], [P("Chest-Supported Dumbbell Row", "Back")]);
  assertEquals(cov.substitutions, [{ logged: "Chest-Supported Dumbbell Row", planned: "Dumbbell Row" }]);
  assertEquals(matchCoverage([P("", null)], [P("Anything", null)]).done, 0);
});

Deno.test("exact exercise, curated movement and primary-muscle overlap remain distinct", () => {
  const cov = matchCoverage([P("Barbell Bench Press", "Chest"), P("Cable Crossover", "Chest")], [P("Dumbbell Floor Press", "Chest"), P("Pec Deck", "Chest")]);
  assertEquals(cov.exactDone, 0);
  assertEquals(cov.movementDone, 1);
  assertEquals(cov.done, 2);
});
