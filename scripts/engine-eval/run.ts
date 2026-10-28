/** Offline release evidence. Contains no keys and calls no provider. */
import {
  buildSession,
  SESSION_TEMPLATES,
  type SessionState,
  SessionUnavailable,
} from "../../supabase/functions/_shared/session_engine.ts";
import { compileProposal } from "../../supabase/functions/_shared/proposal_compiler.ts";
import {
  assertPublishable,
  reviewGeneratedWorkout,
} from "../../supabase/functions/_shared/plan_store.ts";
import { prescriptionTotals } from "../../supabase/functions/_shared/prescription.ts";
import { requirements } from "../../supabase/functions/_shared/exercise_requirements.ts";
import { EXERCISE_CATALOG } from "../../supabase/functions/_shared/exercise_catalog.ts";
import {
  matchingMetrics,
  type MatchLabel,
  type PrescriptionLabel,
  prescriptionMetrics,
  releaseGate,
} from "../../supabase/functions/_shared/evaluation_metrics.ts";
import { decideAdaptation } from "../../supabase/functions/_shared/adaptation_policy.ts";
import { deriveProgramState } from "../../supabase/functions/_shared/program_state.ts";
import { activityMatchesPlanned } from "../../supabase/functions/_shared/activity_matching.ts";
const output = Deno.args[0] ?? "/tmp/workout-maker-p2-evaluation";
await Deno.mkdir(output, { recursive: true });
const rows: Record<string, unknown>[] = [], labels: PrescriptionLabel[] = [];
let unexpectedFailures = 0;
const context = {
  mainLifts: [],
  weeklySetsByMuscle: {},
  muscleGroupsLast48h: [],
  tsb: 0,
  daysSinceLastHard: 99,
  experience: "Intermediate",
  readinessBasis: "none" as const,
  catalogOnly: true,
};
for (const template of SESSION_TEMPLATES) {
  for (
    const variant of [
      "established",
      "novice",
      "sparse",
      "limited_equipment",
      "restricted_time",
      "stale_threshold",
      "fatigue",
      "blocked_weather",
    ]
  ) {
    const state: SessionState = {
      date: "2026-10-22",
      sport: template.sport,
      max_minutes: variant === "restricted_time" ? 15 : 40,
      weekly_remaining_minutes: 100,
      experience: variant === "novice" ? "Beginner" : "Intermediate",
      history_complete: variant !== "sparse",
      implements: variant === "limited_equipment" ? [] : [
        "dumbbells",
        "stable_bench",
        "resistance_band",
        "band_anchor",
        "power_meter",
      ],
      venue: template.sport === "swim" ? "pool" : "road",
      pool: {
        length: 25,
        unit: "yd",
        strokes: ["freestyle"],
        seconds_per_length: 30,
      },
      fatigue: variant === "fatigue" ? "high" : "normal",
      blocked_sports: [],
      actual: variant === "sparse" ? [] : Array.from(
        { length: 8 },
        (_, i) => ({
          id: String(i),
          date: `2026-10-${12 + i}`,
          sport: template.sport,
          minutes: 40,
          effort: 3,
        }),
      ),
      calibration: [{
        sport: template.sport,
        kind: template.sport === "ride" ? "power" : "pace",
        value: template.sport === "ride" ? 200 : 300,
        date: variant === "stale_threshold" ? "2025-01-01" : "2026-10-01",
        reliability: "measured",
      }],
    };
    if (
      variant === "blocked_weather" &&
      (template.sport === "run" || template.sport === "ride")
    ) {
      state.conditions = {
        date: state.date,
        tier: "blocked",
        reasons: ["scenario storm"],
      };
    }
    const id = `${template.id}:${variant}`;
    try {
      const workout = buildSession(state, template.objective),
        raw = compileProposal(workout, state);
      const review = {
        ...context,
        experience: state.experience,
        implements: state.implements,
        maxMinutes: state.max_minutes,
      };
      const compiled = reviewGeneratedWorkout(raw, review).corrected;
      assertPublishable(compiled, review);
      const blocks = compiled.prescription!.blocks;
      const label = {
        sport: state.sport,
        catalog_ok: blocks.every((b) =>
          b.kind !== "strength" ||
          EXERCISE_CATALOG.some((e) => e.name === b.name)
        ),
        equipment_ok: blocks.every((b) =>
          b.kind !== "strength" ||
          requirements(EXERCISE_CATALOG.find((e) => e.name === b.name)!)
            .implements.every((i) => state.implements.includes(i))
        ),
        dose_ok: Math.abs(
          prescriptionTotals(blocks).seconds - compiled.duration_minutes * 60,
        ) < 0.001,
        availability_ok: compiled.duration_minutes <= state.max_minutes,
        replacement_failed: null,
      };
      labels.push(label);
      rows.push({
        id,
        state,
        workout: compiled,
        checks: label,
        expert_review: null,
      });
    } catch (error) {
      if (!(error instanceof SessionUnavailable)) unexpectedFailures++;
      rows.push({
        id,
        state,
        abstained: true,
        reason: String(error),
        expert_review: null,
      });
    }
  }
}
// Hand-labeled sport compatibility, deliberately separate from prescriptions.
const truth: [string, string, boolean][] = [
  ["run", "Walk", false],
  ["run", "TrailRun", true],
  ["ride", "VirtualRide", true],
  ["swim", "Open Water Swim", true],
  ["strength", "Workout", false],
  ["strength", "WeightTraining", true],
  ["swim", "Run", false],
];
const matches: MatchLabel[] = truth.map(([sport, actual, same], i) => ({
  sport,
  expected: same ? String(i) : null,
  predicted: activityMatchesPlanned(sport, actual) ? String(i) : null,
  athlete_confirmed: false,
}));
const cases = JSON.parse(
  await Deno.readTextFile(new URL("./review_cases.json", import.meta.url)),
);
const decisions = cases.map((c: Record<string, string>) => ({
  id: c.id,
  decision: decideAdaptation(c as never, {
    history_complete: c.id !== "late-sync",
    fatigue: "normal",
  }),
  independent_review: null,
}));
// Multiweek replay uses explicitly provided actual histories, never assumes that
// the generated plan happened. Missed weeks and cross-training remain distinct.
const multiweek = [];
for (let week = 0; week < 8; week++) {
  const date = new Date(Date.parse("2026-09-01") + week * 7 * 86400000)
    .toISOString().slice(0, 10);
  const actual = week === 3 ? [] : Array.from({ length: 6 }, (_, i) => ({
    id: `${week}-${i}`,
    date: new Date(Date.parse(date) - (i + 1) * 2 * 86400000).toISOString()
      .slice(0, 10),
    sport: week === 4 ? "ride" : "run",
    minutes: 20,
    effort: week === 5 ? 8 : 3,
    response: week === 5 ? "difficult" as const : "comfortable" as const,
  }));
  multiweek.push(
    deriveProgramState(
      date,
      [{ id: "run", sport: "run", objective: "fitness", priority: "primary" }],
      actual,
      true,
    ),
  );
}
const metrics = prescriptionMetrics(labels),
  matching = matchingMetrics(matches);
const reviewIndex = Deno.args.indexOf("--reviews"),
  deviceIndex = Deno.args.indexOf("--device-evidence");
const reviews = reviewIndex >= 0
  ? JSON.parse(await Deno.readTextFile(Deno.args[reviewIndex + 1]))
  : [];
const transactionIndex = Deno.args.indexOf("--transaction-evidence");
const transactionEvidence = transactionIndex >= 0
  ? await Deno.readTextFile(Deno.args[transactionIndex + 1])
  : "";
const gate = releaseGate(
  metrics,
  matching,
  reviews,
  [...cases.map((c: { id: string }) => c.id), ...rows.map((r) => String(r.id))],
  deviceIndex >= 0 ? Deno.args[deviceIndex + 1] : undefined,
  transactionEvidence.includes("Database engine scenarios passed.")
    ? "passed"
    : undefined,
);
if (unexpectedFailures) {
  gate.failures.push("Unexpected production pipeline failures");
}
if (unexpectedFailures) gate.allowed = false;
await Deno.writeTextFile(
  `${output}/prescriptions.jsonl`,
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
await Deno.writeTextFile(
  `${output}/review-packet.json`,
  JSON.stringify({ cases, decisions, multiweek }, null, 2),
);
const summary = {
  unexpected_failures: unexpectedFailures,
  policy: "adaptation-1",
  prescriptions: metrics,
  matching,
  abstentions: rows.filter((r) => r.abstained).length,
  case_count: rows.length,
  gate,
  limitations: [
    "Scenario labels are engineering expectations pending independent coach review.",
    "No real provider/device validation or independent human scores are fabricated.",
  ],
};
await Deno.writeTextFile(
  `${output}/summary.json`,
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (Deno.args.includes("--require-release") && !gate.allowed) Deno.exit(1);
if (
  unexpectedFailures || metrics.catalog_violations ||
  metrics.equipment_violations || metrics.dose_inconsistencies ||
  metrics.availability_violations ||
  Object.values(matching).some((m) => m.wrong_links || m.false_completion)
) Deno.exit(1);
