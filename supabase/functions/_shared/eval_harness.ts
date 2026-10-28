// ============================================================================
// Offline eval harness — turn "is this LLM good enough for the workout maker?"
// into data. It scores a generated workout with the SAME deterministic tools the
// engine already trusts (schema validity, review violations, independent TSS) and
// attaches the cost estimate, so providers can be compared on quality AND price.
//
// Two layers:
//   • scoreRaw() — pure, no network: parse → validate → review → tss. Unit-tested.
//   • runLive()  — calls every provider that has a key in the environment with a
//                  fixed, deterministic prompt set and prints a comparison table.
//                  Run it directly:  deno run -A eval_harness.ts
// ============================================================================

import { extractJson, estimateCostUsd, llmGenerate, PROVIDERS } from "./llm.ts";
import { SYSTEM_PROMPT, validateWorkout, buildRunPrompt, buildStrengthPrompt } from "./prompt.ts";
import { reviewWorkout, computeTss, type ReviewContext } from "./workout_review.ts";
import type { LlmProvider } from "./types.ts";

export interface Fixture {
  name: string;
  systemPrompt: string;
  userPrompt: string;
  ctx: ReviewContext;
}

export interface EvalScore {
  fixture: string;
  valid: boolean;
  violations: number;
  unsafe: number;
  tss: number;
  parseError?: string;
  // The violation TEXT, not just the count. `violations` above stays a count so
  // existing callers/tests are untouched; the eval needs the strings to answer
  // "WHICH rule broke", which a number cannot.
  violationList?: string[];
  unsafeList?: string[];
  violationKinds?: ViolationKind[];
}

// ---------------------------------------------------------------------------
// Violation classification
//
// reviewWorkout emits human sentences with values interpolated ("Bench Press:
// 200kg exceeds 1.5x est 1RM, clamped to 175kg"), so raw strings can't be
// grouped — every one is unique. This maps each of the 13 templates onto a
// stable kind so the eval can count them by rule.
//
// Matching the rendered prose is admittedly brittle. It is contained here, and
// VIOLATION_TEMPLATES + its test pin every template: reword one in
// workout_review.ts and the test fails loudly, instead of the histogram quietly
// growing an "unknown" bar. The durable fix is for reviewWorkout to emit
// {kind, message}; that touches gated runtime deploys, so it's a follow-up.
// ---------------------------------------------------------------------------

export type ViolationKind =
  // --- session-level, from workout_review.ts -------------------------------
  | "injury_contraindicated"
  // Distinct from injury_contraindicated on purpose. That one is the standing
  // "never load this" rule; these two are the DATED backoff written by a pain
  // report (_shared/injury.ts), and they are the measurement that says whether
  // a model honors a backoff it was told about in the prompt.
  | "injury_backoff_avoid"
  | "injury_backoff_ease"
  | "equipment_not_owned"
  | "progression_target_missed"
  | "below_last_top_set"
  | "over_1rm_cap"
  | "over_absolute_cap"
  | "muscle_not_recovered"
  | "junk_volume"
  | "hard_while_fatigued"
  | "back_to_back_hard"
  | "intensity_ceiling"
  | "amber_quality_capped"
  | "quality_overload"
  | "tss_misreported"
  | "strength_tss_implausible"
  | "unsafe_fallback"
  // --- week-level, from plan_checks.ts -------------------------------------
  | "week_back_to_back_hard"
  | "week_too_many_hard"
  | "week_unpolarized"
  | "week_tss_off_target"
  | "week_ramp_too_steep"
  | "week_taper_wrong"
  | "week_over_set_landmark"
  | "week_no_deload"
  | "week_long_run_oversized"
  | "unknown";

const VIOLATION_PATTERNS: { kind: ViolationKind; test: RegExp }[] = [
  // Session-level (workout_review.ts:199-345).
  { kind: "injury_contraindicated", test: /contraindicated,.*\(injury on file\)/i },
  // Before intensity_ceiling: the ease-level sport cap ends in similar wording.
  { kind: "injury_backoff_avoid", test: /on an avoid backoff until|is on an avoid backoff/i },
  { kind: "injury_backoff_ease", test: /is on an ease backoff until/i },
  { kind: "equipment_not_owned", test: /not in the athlete's equipment/i },
  { kind: "progression_target_missed", test: /progression target .*snapped to the engine target/i },
  { kind: "below_last_top_set", test: /is below last top set/i },
  { kind: "over_1rm_cap", test: /exceeds 1\.5×? est 1RM/i },
  { kind: "over_absolute_cap", test: /exceeds the \d+kg sanity cap/i },
  { kind: "muscle_not_recovered", test: /trained in the last 48h, should be recovering/i },
  { kind: "junk_volume", test: /exceeds the ~?\d+-set landmark \(junk volume\)/i },
  { kind: "hard_while_fatigued", test: /hard session prescribed while very fatigued/i },
  { kind: "back_to_back_hard", test: /after the last hard effort, back-to-back quality/i },
  { kind: "amber_quality_capped", test: /moderate recovery .*amber.*quality capped/i },
  { kind: "quality_overload", test: /quality ceiling \(one quality block per day\)|pick one quality focus per day/i },
  { kind: "intensity_ceiling", test: /capped to easy aerobic \(Z2, RPE ≤\d\)/i },
  { kind: "tss_misreported", test: /differs from computed .* by >25%, replaced/i },
  { kind: "strength_tss_implausible", test: /strength tss_estimate .* implausibly high, clamped/i },
  { kind: "unsafe_fallback", test: /fell back to a safe recovery day/i },
  // Week-level (plan_checks.ts). Without these every periodization violation
  // lands in "unknown" — which is exactly the half of the report we care about.
  { kind: "week_back_to_back_hard", test: /hard session the day after a hard session/i },
  { kind: "week_too_many_hard", test: /hard sessions this week exceeds the/i },
  { kind: "week_unpolarized", test: /intensity distribution .* easy floor/i },
  { kind: "week_tss_off_target", test: /weekly load .* from the .* TSS target/i },
  { kind: "week_ramp_too_steep", test: /weekly volume up .* on last week/i },
  { kind: "week_taper_wrong", test: /taper week cut volume/i },
  { kind: "week_over_set_landmark", test: /weekly sets is over the ~?\d+-set .* landmark/i },
  { kind: "week_no_deload", test: /build weeks with no deload/i },
  { kind: "week_long_run_oversized", test: /over the ~?35% long-run ceiling/i },
];

/** Map one reviewWorkout violation sentence onto a stable kind. */
export function classifyViolation(s: string): ViolationKind {
  return VIOLATION_PATTERNS.find((p) => p.test.test(s))?.kind ?? "unknown";
}

/**
 * One real sample of every violation reviewWorkout can emit, copied from the
 * templates at workout_review.ts:199-345 (+ the caller-pushed one at
 * generate-workout/index.ts:602). The test asserts each classifies, so this is
 * the tripwire for a reworded template.
 */
export const VIOLATION_TEMPLATES: { kind: ViolationKind; sample: string }[] = [
  {
    kind: "injury_contraindicated",
    sample: "Barbell Deadlift: contraindicated, loads the lumbar spine under flexion (injury on file)",
  },
  {
    kind: "injury_backoff_avoid",
    sample: "Back Squat: loads the Knee, on an avoid backoff until 2026-08-08, removed",
  },
  {
    kind: "injury_backoff_ease",
    sample:
      "Knee is on an ease backoff until 2026-08-08: keep Back Squat light, well short of failure, and drop the load rather than the reps",
  },
  {
    kind: "equipment_not_owned",
    sample: "Leg Press: needs machine, not in the athlete's equipment (Home minimal), removed",
  },
  {
    kind: "progression_target_missed",
    sample: "Back Squat: prescribed 105kg×5 ≠ progression target 102.5kg×6, snapped to the engine target",
  },
  {
    kind: "below_last_top_set",
    sample: "Bench Press: prescribed 60kg is below last top set 77.5kg, raised to 77.5kg",
  },
  { kind: "over_1rm_cap", sample: "Back Squat: 200kg exceeds 1.5× est 1RM, clamped to 175kg" },
  { kind: "over_absolute_cap", sample: "Deadlift: 500kg exceeds the 400kg sanity cap, clamped" },
  {
    kind: "muscle_not_recovered",
    sample: "Back Squat: loads Quads, trained in the last 48h, should be recovering",
  },
  { kind: "junk_volume", sample: "Chest: 26 weekly sets exceeds the ~22-set landmark (junk volume)" },
  {
    kind: "hard_while_fatigued",
    sample: "hard session prescribed while very fatigued (TSB -25), favor easy/recovery",
  },
  { kind: "back_to_back_hard", sample: "hard session 1d after the last hard effort, back-to-back quality" },
  {
    kind: "intensity_ceiling",
    sample: "low readiness (20/100) / TSB -25, capped to easy aerobic (Z2, RPE ≤4)",
  },
  {
    kind: "amber_quality_capped",
    sample: "moderate recovery (50/100, amber), quality capped to easy aerobic (Z2, RPE ≤6)",
  },
  {
    // The kind has two renderings (the 40-min ceiling and the mixed-blocks
    // message); the pattern covers both, one sample per kind by convention.
    kind: "quality_overload",
    sample: "a full threshold block (20 min) AND a full VO2 block (12 min) in one session; pick one quality focus per day",
  },
  { kind: "tss_misreported", sample: "tss_estimate 40 differs from computed 95 by >25%, replaced" },
  {
    kind: "strength_tss_implausible",
    sample: "strength tss_estimate 300 implausibly high, clamped to 150",
  },
  { kind: "unsafe_fallback", sample: "fell back to a safe recovery day (unsafe/empty after review)" },
  // Week-level, from plan_checks.ts.
  {
    kind: "week_back_to_back_hard",
    sample: "2026-08-04: hard session the day after a hard session, back-to-back quality",
  },
  { kind: "week_too_many_hard", sample: "4 hard sessions this week exceeds the 3-session ceiling" },
  {
    kind: "week_unpolarized",
    sample: "intensity distribution 50% easy / 50% hard is below the 70% easy floor (target ~80/20)",
  },
  {
    kind: "week_tss_off_target",
    sample: "weekly load 412 TSS is +8% from the 380 TSS target, outside the 15% band",
  },
  {
    kind: "week_ramp_too_steep",
    sample: "weekly volume up 100% on last week (190 to 380 TSS), over the 10% rule",
  },
  {
    kind: "week_taper_wrong",
    sample: "taper week cut volume 0% (380 to 380 TSS), outside the 30%-70% taper band",
  },
  {
    kind: "week_over_set_landmark",
    sample: "Chest: 20 weekly sets is over the ~12-set Beginner landmark",
  },
  { kind: "week_no_deload", sample: "week 7: 7 build weeks with no deload, over the 6-week ceiling" },
  {
    kind: "week_long_run_oversized",
    sample: "long run is 44% of weekly running, over the ~35% long-run ceiling",
  },
];

// Pure scorer: take raw model text for a fixture and grade it with the engine's
// own deterministic guards. No network — this is what the unit tests exercise.
export function scoreRaw(raw: string, fx: Fixture): EvalScore {
  try {
    const v = validateWorkout(extractJson(raw));
    if (!v.ok || !v.workout) {
      return { fixture: fx.name, valid: false, violations: 0, unsafe: 0, tss: 0, parseError: v.error };
    }
    const review = reviewWorkout(v.workout, { ...fx.ctx, catalogOnly: true });
    return {
      fixture: fx.name,
      valid: true,
      violations: review.violations.length,
      unsafe: review.unsafe.length,
      tss: computeTss(review.corrected),
      violationList: review.violations,
      unsafeList: review.unsafe,
      violationKinds: review.violations.map(classifyViolation),
    };
  } catch (e) {
    return {
      fixture: fx.name, valid: false, violations: 0, unsafe: 0, tss: 0,
      parseError: e instanceof Error ? e.message : String(e),
    };
  }
}

// A small, representative fixture set. Deterministic so runs are comparable.
export function buildFixtures(): Fixture[] {
  const baseStrengthCtx: ReviewContext = {
    mainLifts: [
      { exercise: "Barbell Bench Press", estimated1rm: 110, lastWeight: 90, lastReps: 5, lastSets: 3 },
      { exercise: "Back Squat", estimated1rm: 150, lastWeight: 120, lastReps: 5, lastSets: 3 },
    ],
    weeklySetsByMuscle: { Chest: 6, Back: 4, Quads: 6 },
    muscleGroupsLast48h: [],
    tsb: 2,
    daysSinceLastHard: 3,
    experience: "Intermediate",
    equipment: "Full gym",
  };
  const runCtx: ReviewContext = {
    mainLifts: [], weeklySetsByMuscle: {}, muscleGroupsLast48h: [],
    tsb: 5, daysSinceLastHard: 3, experience: "Intermediate",
  };
  const hrZones = [
    { zone: "Z1", min: 95, max: 130 }, { zone: "Z2", min: 131, max: 145 },
    { zone: "Z3", min: 146, max: 160 }, { zone: "Z4", min: 161, max: 172 },
    { zone: "Z5", min: 173, max: 190 },
  ];
  return [
    {
      name: "strength/intermediate/full-gym",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildStrengthPrompt({
        muscleGroupsLast48h: [], weeklySetsByMuscle: baseStrengthCtx.weeklySetsByMuscle,
        equipment: "Full gym", experience: "Intermediate", goal: "Hybrid athlete",
        soreness: 2, phase: "Base (aerobic + general strength)", mainLifts: baseStrengthCtx.mainLifts,
        durationNote: "around 60 min", splitStyle: "Upper / lower",
      }),
      ctx: baseStrengthCtx,
    },
    {
      name: "run/tempo/fresh",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildRunPrompt({
        hrZones, tsb: 5, ctl: 55, atl: 50, acwr: 1.1, phase: "Build (threshold + VO2)",
        wellness3d: { energy: 4, soreness: 2, sleep: 4 }, weeklyKm: 40, goal: "10K pace",
        targetPace: "4:30/km", daysSinceLastRun: 1, daysSinceLastHard: 3,
        durationNote: "around 50 min", experience: "Intermediate", sport: "run",
      }),
      ctx: runCtx,
    },
  ];
}

const ENV_KEY: Partial<Record<LlmProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export interface ProviderResult {
  provider: LlmProvider;
  runs: number;
  validPct: number;
  avgViolations: number;
  anyUnsafe: number;
  avgCostUsd: number;
}

// Live run: every provider with a key in the env generates each fixture
// (deterministic), is scored, and aggregated. Network — not run by the tests.
export async function runLive(fixtures = buildFixtures()): Promise<ProviderResult[]> {
  const out: ProviderResult[] = [];
  for (const provider of Object.keys(ENV_KEY) as LlmProvider[]) {
    const apiKey = Deno.env.get(ENV_KEY[provider]!);
    if (!apiKey) continue;
    let valid = 0, violations = 0, unsafe = 0, cost = 0;
    for (const fx of fixtures) {
      try {
        const r = await llmGenerate(provider, {
          prompt: fx.userPrompt, systemPrompt: fx.systemPrompt, apiKey,
          model: PROVIDERS[provider].model, deterministic: true, seed: 7,
        });
        const score = scoreRaw(r.text, fx);
        if (score.valid) valid++;
        violations += score.violations;
        unsafe += score.unsafe;
        cost += estimateCostUsd(provider, r.promptTokens, r.completionTokens);
      } catch {
        // a failed call counts as an invalid run
      }
    }
    out.push({
      provider, runs: fixtures.length,
      validPct: Math.round((valid / fixtures.length) * 100),
      avgViolations: +(violations / fixtures.length).toFixed(2),
      anyUnsafe: unsafe,
      avgCostUsd: +(cost / fixtures.length).toFixed(5),
    });
  }
  return out;
}

if (import.meta.main) {
  const rows = await runLive();
  if (!rows.length) {
    console.log("No provider keys in env. Set e.g. GROQ_API_KEY / ANTHROPIC_API_KEY and re-run.");
  } else {
    console.table(rows);
  }
}
