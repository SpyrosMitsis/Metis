import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  decideAdaptation,
  feedbackConflicts,
  FeedbackSchema,
} from "./adaptation_policy.ts";
import { readinessContext } from "./readiness_context.ts";
import {
  matchingMetrics,
  prescriptionMetrics,
  releaseGate,
} from "./evaluation_metrics.ts";
import { buildSession } from "./session_engine.ts";
import { assertPublishable, reviewGeneratedWorkout } from "./plan_store.ts";
const state = { history_complete: true, fatigue: "normal" as const };
Deno.test("the same skipped session yields different justified time, equipment and illness decisions", () => {
  assertEquals(
    decideAdaptation({ reason: "time", outcome: "skipped" }, state).action,
    "repeat",
  );
  assertEquals(
    decideAdaptation({ reason: "equipment", outcome: "skipped" }, state)
      .clarification,
    "Which implement is unavailable?",
  );
  assertEquals(
    decideAdaptation({ reason: "equipment", outcome: "skipped" }, state, {
      unavailable_implements: ["dumbbells"],
    }).action,
    "rebuild",
  );
  assertEquals(
    decideAdaptation({ reason: "illness", outcome: "skipped" }, state).action,
    "rest",
  );
});
Deno.test("unknown sync cannot become a miss; explicit fatigue may still reduce work", () => {
  assertEquals(
    decideAdaptation(null, { ...state, history_complete: false }).action,
    "keep",
  );
  assertEquals(
    decideAdaptation({ reason: "unknown", outcome: "skipped" }, {
      ...state,
      history_complete: false,
    }).action,
    "keep",
  );
  assertEquals(
    decideAdaptation({ reason: "fatigue", outcome: "shortened" }, {
      ...state,
      history_complete: false,
    }).action,
    "reduce",
  );
});
Deno.test("skipped, shortened, easier, harder and substituted work have explicit policies without debt", () => {
  for (
    const outcome of ["skipped", "shortened", "easier", "substituted"] as const
  ) {
    assertEquals(
      decideAdaptation({ reason: "unknown", outcome }, state).action,
      "repeat",
    );
  }
  assertEquals(
    decideAdaptation({ reason: "unknown", outcome: "harder" }, state).factor,
    0.7,
  );
  assert(
    decideAdaptation({ reason: "preference", outcome: "substituted" }, state)
      .explanation.includes("does not establish"),
  );
  assertEquals(
    decideAdaptation({ reason: "time", outcome: "shortened" }, state, {
      minutes: 15,
    }).action,
    "rebuild",
  );
});
Deno.test("pain and illness remain different from ordinary soreness and are not medical clearance", () => {
  assertEquals(
    decideAdaptation({ reason: "pain", outcome: "unknown" }, state).action,
    "rest",
  );
  assertEquals(
    readinessContext("2026-10-22", [{ date: "2026-10-22", soreness: 5 }], [])
      .status,
    "caution",
  );
  assertEquals(
    readinessContext("2026-10-22", [], [], [{ reason: "pain" }]).status,
    "pause",
  );
});
Deno.test("no readiness readings means unknown and no numerical decision score", () => {
  const r = readinessContext("2026-10-22", [], []);
  assertEquals(r.status, "unknown");
  assertEquals(r.score, null);
  assertEquals(
    readinessContext("2026-10-22", [{ date: "2026-10-21", energy: 1 }], [])
      .status,
    "unknown",
  );
});
Deno.test("subjective symptoms can disagree with favorable objective trends and both survive", () => {
  const r = readinessContext(
    "2026-10-22",
    [{ date: "2026-10-22", energy: 1, soreness: 5 }],
    [],
    [],
    [{ date: "2026-10-21", value: 40 }, { date: "2026-10-22", value: 60 }],
  );
  assertEquals(r.status, "caution");
  assertEquals(r.conflicts.length, 1);
  assert(r.recovery.drivers.some((d) => d.tone === "good"));
});
Deno.test("actual hard cross-training influences readiness without fabricating sport-specific exposure", () => {
  const actual = [{
    id: "ride",
    date: "2026-10-21",
    sport: "ride",
    minutes: 60,
    effort: 8,
  }];
  const r = readinessContext("2026-10-22", [], actual);
  assertEquals(r.status, "caution");
  assertEquals(actual[0].sport, "ride");
});
Deno.test("duration disagreement and athlete skip versus recording preserve both sources", () => {
  const report = { outcome: "skipped" as const, actual_minutes: 10 };
  const actual = { minutes: 60, count: 1 };
  assertEquals(feedbackConflicts(report, actual).length, 2);
  assertEquals(report.actual_minutes, 10);
  assertEquals(actual.minutes, 60);
});
Deno.test("feedback schema rejects impossible numbers and accidental diagnosis labels", () => {
  const base = {
    id: crypto.randomUUID(),
    date: "2026-10-22",
    completed: false,
  };
  assertThrows(() =>
    FeedbackSchema.parse({ ...base, actual_minutes: Infinity })
  );
  assertThrows(() => FeedbackSchema.parse({ ...base, reason: "overtraining" }));
  assertThrows(() => FeedbackSchema.parse({ ...base, enjoyment: 6 }));
  assertThrows(() => FeedbackSchema.parse({ ...base, actual_rpe: 11 }));
});
Deno.test("matching, prescription and human explanation review remain separate metrics", () => {
  const m = matchingMetrics([{
    sport: "run",
    expected: "a",
    predicted: null,
    athlete_confirmed: false,
  }, {
    sport: "run",
    expected: null,
    predicted: "b",
    athlete_confirmed: true,
    corrected: true,
  }]);
  assertEquals(m.run.false_completion, 1);
  assertEquals(m.run.missed_matches, 1);
  assertEquals(m.run.abstentions, 1);
  assertEquals(m.run.correction_rate, 0.5);
  const p = prescriptionMetrics([{
    sport: "run",
    catalog_ok: true,
    equipment_ok: true,
    dose_ok: true,
    availability_ok: true,
    replacement_failed: false,
  }]);
  assertEquals(p.catalog_violations, 0);
  assert(!releaseGate(p, m, [], ["run"]).allowed);
});
Deno.test("release gate cannot call self-evaluation independent coach or device validation", () => {
  const p = prescriptionMetrics([{
    sport: "run",
    catalog_ok: true,
    equipment_ok: true,
    dose_ok: true,
    availability_ok: true,
    replacement_failed: false,
  }]);
  const m = matchingMetrics([{
    sport: "run",
    expected: "a",
    predicted: "a",
    athlete_confirmed: false,
  }]);
  assert(!releaseGate(p, m, [], ["run"]).allowed);
  assert(
    releaseGate(
      p,
      m,
      [{
        case_id: "run",
        source: "independent_coach",
        reviewer: "External reviewer fixture",
        approved: true,
        evidence: "review fixture",
      }],
      ["run"],
      "device fixture",
      "database fixture",
    ).allowed,
  );
  assert(!releaseGate(p, m, [], []).allowed);
});
Deno.test("canonical strength metadata survives production content review without contradictory sections", () => {
  const w = buildSession({
    date: "2026-10-22",
    sport: "strength",
    max_minutes: 30,
    weekly_remaining_minutes: 60,
    experience: "Beginner",
    actual: [],
    history_complete: false,
    implements: [],
    venue: "unspecified",
    fatigue: "normal",
    blocked_sports: [],
  }, "strength");
  const ctx = {
    mainLifts: [],
    weeklySetsByMuscle: {},
    muscleGroupsLast48h: [],
    tsb: 0,
    daysSinceLastHard: 99,
    experience: "Beginner",
    readinessBasis: "none" as const,
    implements: [],
  };
  const reviewed = reviewGeneratedWorkout(w, ctx).corrected;
  assertPublishable(reviewed, ctx);
  assert(
    reviewed.sections.every((s) =>
      s.exercises.every((e) =>
        e.muscle && e.category && typeof e.compound === "boolean"
      )
    ),
  );
});

import { combineEffort } from "./feedback_evidence.ts";
Deno.test("conflicting athlete/provider effort retains both and cannot authorize progression from the lower report", () => {
  const result = combineEffort(3, 8);
  assertEquals(result, {
    reported_effort: 3,
    provider_effort: 8,
    effort: 8,
    effort_conflict: true,
  });
  assertEquals(combineEffort(null, 4).effort, 4);
  assertEquals(combineEffort(NaN, Infinity).effort, null);
  const r = readinessContext("2026-10-22", [], [{
    id: "a",
    date: "2026-10-21",
    sport: "ride",
    minutes: 60,
    ...result,
  }]);
  assert(r.conflicts.length > 0);
});
Deno.test("poor current readiness can reduce the next demanding session without inventing a missed workout", () => {
  assertEquals(
    decideAdaptation(null, { history_complete: true, fatigue: "high" }).action,
    "reduce",
  );
  assertEquals(
    decideAdaptation({ reason: "unknown", outcome: "unknown" }, {
      history_complete: true,
      fatigue: "high",
    }).action,
    "reduce",
  );
  assertEquals(
    decideAdaptation({ reason: "equipment", outcome: "skipped" }, {
      history_complete: true,
      fatigue: "high",
    }).clarification,
    "Which implement is unavailable?",
  );
});
Deno.test("an athlete completion report cannot silently erase a recorded cross-sport disagreement", () => {
  assertEquals(
    feedbackConflicts({ outcome: "as_planned" }, {
      minutes: 20,
      count: 1,
      type: "Ride",
      expected_sport: "run",
    }).length,
    1,
  );
  assertEquals(
    feedbackConflicts({ outcome: "as_planned" }, {
      minutes: 20,
      count: 1,
      type: "TrailRun",
      expected_sport: "run",
    }).length,
    0,
  );
});
