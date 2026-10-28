import { prescriptionEffortMinutes } from "./prescription.ts";
// ============================================================================
// plan_checks — deterministic checks for the rules that were prose-only.
//
// workout_review.ts already checks a SINGLE session hard (load, safety,
// equipment, progression). Nothing checked the rules that only exist across a
// WEEK: intensity distribution, hard-day spacing, weekly load vs target, the
// 10% ramp, deload cadence, taper. Those live as prose in COACHING_PRINCIPLES
// and buildWeekPrompt's PLANNING RULES, so the model was asked to follow rules
// nothing could verify. This module makes them checkable.
//
// TWO RULES OF THIS FILE:
//
// 1. Every threshold is an exported const that cites the prompt line it mirrors.
//    Prompt/checker drift is this repo's recurring failure mode (see
//    KNOWN_CONTRADICTIONS below — three of them have already been caught and
//    fixed). If a prompt rule changes, the const and the citation must move together.
//
// 2. Never re-derive what the engine already computes. Zone attribution, TSS and
//    hard-session detection come from workout_review.ts, so a check here can
//    never disagree with what generate-workout/plan-week actually enforce.
// ============================================================================

import type { Workout, WorkoutExercise } from "./types.ts";
import type { WeekPlan } from "./workout_schema.ts";
import { computeTss, isHardSession, muscleOf, zoneIsHard, zoneOf } from "./workout_review.ts";

// ---------------------------------------------------------------------------
// Thresholds. Each cites prompt.ts, which is the rule's actual home.
// ---------------------------------------------------------------------------

/** prompt.ts:58 "no more than 2-3 hard (Z3+) sessions/week"; :476 "At most 2-3". */
export const MAX_HARD_SESSIONS_PER_WEEK = 3;

/**
 * prompt.ts:47 "keep ~80% of weekly running in Z1-Z2"; :475 "~80% easy / ~20% hard".
 * Banded at 0.70 rather than 0.80 because the rule is written with a tilde and
 * the attribution is section-level (see zonedMinutes). This catches a genuinely
 * unpolarized week (50/50) without failing an honest 75/25.
 */
export const MIN_EASY_TIME_FRACTION = 0.70;

/**
 * prompt.ts:477 "Keep weekly load near the target". The prompt gives NO number
 * for "near", so this threshold is ours, not the prompt's — the one const here
 * that cannot cite an exact rule. Reported as a distribution by the eval so the
 * choice of 0.15 doesn't quietly become the finding.
 */
export const TSS_TARGET_TOLERANCE = 0.15;

/** prompt.ts:52 "increase weekly volume by no more than ~10%"; :477 "within ~10%". */
export const MAX_WEEKLY_RAMP = 0.10;

/** prompt.ts:76 "deload (~ -40% volume)"; :477 "cut ~40% volume". Band around 40%. */
export const DELOAD_CUT = { min: 0.25, max: 0.60 } as const;

/** prompt.ts:76 "roughly every 4-6 weeks". */
export const DELOAD_EVERY_WEEKS = { min: 4, max: 6 } as const;

/** prompt.ts:50-51 "Taper (cut volume 40-60%...)". Band widened for the tilde. */
export const TAPER_CUT = { min: 0.30, max: 0.70 } as const;

/** prompt.ts:79-88, the experience-tiered weekly set landmarks. */
export const SETS_BY_EXPERIENCE: Record<string, readonly [number, number]> = {
  Beginner: [8, 12], // prompt.ts:79-80
  Intermediate: [12, 18], // prompt.ts:84
  Advanced: [16, 22], // prompt.ts:87
};

/** Build weeks before a deload comes due. Mirrors plan-week's periodization block. */
export const DELOAD_AFTER_WEEKS = 4;

/** prompt.ts:50-51 "Taper (cut volume 40-60%)" — the midpoint we aim the target at. */
export const TAPER_TARGET_CUT = 0.50;

/** prompt.ts:76 "deload (~ -40% volume)"; :477 "cut ~40% volume". */
export const DELOAD_TARGET_CUT = 0.40;

/**
 * The weekly load to actually aim at, given the phase.
 *
 * `weekly_tss_target` is a BASE for a normal build week. Handing it to a
 * tapering athlete unchanged is what made buildWeekPrompt say, in one breath,
 * "cut volume 40-60%" AND "keep weekly load near 380 TSS" — an instruction no
 * model can satisfy. A real run caught it: deepseek correctly cut to 215 TSS
 * (-43%) and our own checkTssTarget flagged the correct answer as a violation.
 * A more obedient model would not have tapered at all, which is the real harm.
 *
 * Used by BOTH plan-week (to build the prompt) and the eval (to score it), so
 * the number the athlete is asked for and the number we check against cannot
 * drift apart.
 *
 * Peak is deliberately NOT scaled: prompt.ts:257 calls it "lower volume/high
 * quality" but names no number, and inventing one here would be worse than the
 * gap it fills.
 */
export function plannedWeeklyTarget(
  baseTss: number,
  phase: string,
  deloadDue = false,
): number {
  if (baseTss <= 0) return baseTss;
  if (/taper/i.test(phase)) return Math.round(baseTss * (1 - TAPER_TARGET_CUT));
  if (deloadDue) return Math.round(baseTss * (1 - DELOAD_TARGET_CUT));
  return Math.round(baseTss);
}

/**
 * The 80/20 week priced with the engine's own zone rates: 80% of minutes at Z2
 * (0.8 TSS/min) + 20% at Z3 (1.2) = 0.88/min. Deliberately the PROPERLY
 * POLARIZED mix, not a best case: a week that beats this ceiling can only do it
 * by breaking the 80/20 rule the same prompt demands.
 */
export const MIXED_TSS_PER_MIN = 0.88;

/**
 * The most weekly load an athlete's declared availability can hold.
 *
 * `weekly_tss_target` and WEEKLY AVAILABILITY reach the prompt independently,
 * and nothing reconciled them: Sam's 405 min/week prices out at ~356 TSS, yet
 * the prompt asked for 380 AND "size each day to its budget". Two instructions
 * no model can satisfy at once — the same class of bug as the taper
 * contradiction, and every "under-target" verdict was partly measuring it.
 * plan-week clamps the asked-for target with this; the eval checks against the
 * same clamped number. 0 minutes (no day_availability set) means no ceiling.
 */
export function availabilityTssCeiling(weeklyMinutes: number): number | null {
  if (weeklyMinutes <= 0) return null;
  return Math.round(weeklyMinutes * MIXED_TSS_PER_MIN);
}

/**
 * Prompt-vs-checker contradictions we know about and have not yet resolved.
 * A scenario that trips one of these is a spec bug, not a model failure.
 * Empty right now, and the eval scenarios tagged meta.contradiction exist to
 * keep it that way — each one measures a spot where prompt and code previously
 * disagreed. Resolved so far (kept for the record, dates are commit history):
 *   - weekly-sets: checker was a flat 22; now tiered 12/18/22 per experience.
 *   - recovery-cap: amber was unchecked; now red→RPE≤4, amber→RPE≤6 enforced.
 *   - swim: was invisible to isHardSession/computeTss; now priced as endurance.
 */
export const KNOWN_CONTRADICTIONS: readonly string[] = [];

// ---------------------------------------------------------------------------
// Shared shape
// ---------------------------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  /** Same string convention as reviewWorkout.violations, so they concatenate. */
  violations: string[];
  /** Numbers the notebook plots. Present even when ok, so we get distributions. */
  detail: Record<string, number | string | null>;
}

const pass = (detail: CheckResult["detail"] = {}): CheckResult => ({ ok: true, violations: [], detail });
const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Minutes per zone for one session.
 *
 * Mirrors computeTss (workout_review.ts:152-166) exactly: a section's minutes
 * are split evenly across its exercises, because WorkoutExercise carries a zone
 * but NO duration — only WorkoutSection has duration_minutes. So a 40min section
 * holding a Z2 and a Z4 exercise genuinely does not say how the 40 split.
 *
 * This is an approximation, but it is the SAME approximation the TSS the engine
 * feeds into ACWR already rests on. Any 80/20 number here is exactly as
 * trustworthy as that TSS, no more and no less.
 */
function zonedMinutes(w: Workout): { zone: string; mins: number }[] {
  if (w.prescription) return prescriptionEffortMinutes(w.prescription);
  if (w.type !== "run" && w.type !== "ride" && w.type !== "swim") return [];
  const out: { zone: string; mins: number }[] = [];
  for (const sec of w.sections) {
    const per = sec.duration_minutes && sec.exercises.length
      ? sec.duration_minutes / sec.exercises.length
      : 0;
    if (!per) continue;
    for (const ex of sec.exercises) out.push({ zone: zoneOf(ex) ?? "Z2", mins: per });
  }
  return out;
}

/** Working sets per muscle for a strength session (warm-ups excluded upstream). */
function setsByMuscle(w: Workout, into: Record<string, number>): void {
  if (w.type !== "strength") return;
  for (const sec of w.sections) {
    if (/warm|mobil|activat/i.test(sec.name)) continue;
    for (const ex of sec.exercises) {
      const m = muscleOf(ex);
      if (!m) continue;
      into[m] = (into[m] ?? 0) + Math.max(0, ex.sets || 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface WeekMetrics {
  totalTss: number;
  sessions: number;
  restDays: number;
  hardSessions: number;
  /** Dates of the SECOND session in each back-to-back hard pair. */
  backToBackHard: string[];
  easyMinutes: number;
  hardMinutes: number;
  /** Z1-2 share of zoned endurance time; null when the week has none. */
  easyFraction: number | null;
  setsByMuscle: Record<string, number>;
  sessionsBySport: Record<string, number>;
  /** Hard swims, invisible to hardSessions. See KNOWN_CONTRADICTIONS. */
}

export function weekMetrics(plan: WeekPlan): WeekMetrics {
  let totalTss = 0, sessions = 0, restDays = 0, hardSessions = 0;
  let easyMinutes = 0, hardMinutes = 0;
  const backToBackHard: string[] = [];
  const muscles: Record<string, number> = {};
  const sports: Record<string, number> = {};
  let prevHard = false;

  for (const day of plan.days) {
    const w = day.session;
    if (w.type === "rest") {
      restDays++;
      prevHard = false; // rest breaks a hard streak
      continue;
    }
    sessions++;
    sports[w.type] = (sports[w.type] ?? 0) + 1;
    totalTss += computeTss(w);
    setsByMuscle(w, muscles);
    for (const { zone, mins } of zonedMinutes(w)) {
      if (zoneIsHard(zone)) hardMinutes += mins;
      else easyMinutes += mins;
    }

    const hard = isHardSession(w);
    if (hard) {
      hardSessions++;
      if (prevHard) backToBackHard.push(day.date);
    }
    prevHard = hard;
  }

  const zoned = easyMinutes + hardMinutes;
  return {
    totalTss,
    sessions,
    restDays,
    hardSessions,
    backToBackHard,
    easyMinutes: Math.round(easyMinutes),
    hardMinutes: Math.round(hardMinutes),
    easyFraction: zoned > 0 ? easyMinutes / zoned : null,
    setsByMuscle: muscles,
    sessionsBySport: sports,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** prompt.ts:58 + :476 — never back-to-back hard; at most 2-3 hard/week. */
export function checkHardSpacing(plan: WeekPlan): CheckResult {
  const m = weekMetrics(plan);
  const violations: string[] = [];
  for (const date of m.backToBackHard) {
    violations.push(`${date}: hard session the day after a hard session, back-to-back quality`);
  }
  if (m.hardSessions > MAX_HARD_SESSIONS_PER_WEEK) {
    violations.push(
      `${m.hardSessions} hard sessions this week exceeds the ${MAX_HARD_SESSIONS_PER_WEEK}-session ceiling`,
    );
  }
  return {
    ok: violations.length === 0,
    violations,
    detail: {
      hard_sessions: m.hardSessions,
      back_to_back: m.backToBackHard.length,
    },
  };
}

/** prompt.ts:47 + :475 — ~80% of endurance time easy (Z1-Z2). */
export function checkPolarization(plan: WeekPlan): CheckResult {
  const m = weekMetrics(plan);
  if (m.easyFraction === null) {
    // No zoned endurance time at all (e.g. a pure strength week). Not a
    // violation: the rule is about running/riding distribution.
    return pass({ easy_fraction: null, easy_minutes: 0, hard_minutes: 0 });
  }
  const ok = m.easyFraction >= MIN_EASY_TIME_FRACTION;
  return {
    ok,
    violations: ok ? [] : [
      `intensity distribution ${pct(m.easyFraction)} easy / ${pct(1 - m.easyFraction)} hard ` +
      `is below the ${pct(MIN_EASY_TIME_FRACTION)} easy floor (target ~80/20)`,
    ],
    detail: {
      easy_fraction: Number(m.easyFraction.toFixed(3)),
      easy_minutes: m.easyMinutes,
      hard_minutes: m.hardMinutes,
    },
  };
}

/** prompt.ts:477 — "Keep weekly load near the target". */
export function checkTssTarget(plan: WeekPlan, targetTss: number): CheckResult {
  const m = weekMetrics(plan);
  if (targetTss <= 0) return pass({ total_tss: m.totalTss, target_tss: null, delta_pct: null });
  const delta = (m.totalTss - targetTss) / targetTss;
  const ok = Math.abs(delta) <= TSS_TARGET_TOLERANCE;
  return {
    ok,
    violations: ok ? [] : [
      `weekly load ${m.totalTss} TSS is ${delta > 0 ? "+" : ""}${pct(delta)} from the ` +
      `${targetTss} TSS target, outside the ${pct(TSS_TARGET_TOLERANCE)} band`,
    ],
    detail: { total_tss: m.totalTss, target_tss: targetTss, delta_pct: Number(delta.toFixed(3)) },
  };
}

/** prompt.ts:52 — volume up by no more than ~10% week on week. */
export function checkRamp(plan: WeekPlan, priorWeekTss: number): CheckResult {
  const m = weekMetrics(plan);
  if (priorWeekTss <= 0) {
    // Cold start: no prior volume to ramp from. prompt.ts:90-94 is explicit that
    // absent history is not a signal, so this must not read as a violation.
    return pass({ total_tss: m.totalTss, prior_tss: null, ramp_pct: null });
  }
  const ramp = (m.totalTss - priorWeekTss) / priorWeekTss;
  const ok = ramp <= MAX_WEEKLY_RAMP;
  return {
    ok,
    violations: ok ? [] : [
      `weekly volume up ${pct(ramp)} on last week (${priorWeekTss} to ${m.totalTss} TSS), ` +
      `over the ${pct(MAX_WEEKLY_RAMP)} rule`,
    ],
    detail: { total_tss: m.totalTss, prior_tss: priorWeekTss, ramp_pct: Number(ramp.toFixed(3)) },
  };
}

/** prompt.ts:50-51 — a taper week cuts volume 40-60%. Only asserts in Taper. */
export function checkTaper(plan: WeekPlan, priorWeekTss: number, phase: string): CheckResult {
  const m = weekMetrics(plan);
  if (!/taper/i.test(phase) || priorWeekTss <= 0) {
    return pass({ total_tss: m.totalTss, cut_pct: null, asserted: 0 });
  }
  const cut = (priorWeekTss - m.totalTss) / priorWeekTss;
  const ok = cut >= TAPER_CUT.min && cut <= TAPER_CUT.max;
  return {
    ok,
    violations: ok ? [] : [
      `taper week cut volume ${pct(cut)} (${priorWeekTss} to ${m.totalTss} TSS), outside the ` +
      `${pct(TAPER_CUT.min)}-${pct(TAPER_CUT.max)} taper band`,
    ],
    detail: { total_tss: m.totalTss, prior_tss: priorWeekTss, cut_pct: Number(cut.toFixed(3)), asserted: 1 },
  };
}

/** prompt.ts:79-88 — experience-tiered weekly sets per muscle. */
export function checkSetLandmarks(plan: WeekPlan, experience: string): CheckResult {
  const band = SETS_BY_EXPERIENCE[experience];
  const m = weekMetrics(plan);
  const muscles = Object.entries(m.setsByMuscle);
  if (!band || muscles.length === 0) {
    return pass({ muscles_trained: muscles.length, over_landmark: 0, max_sets: 0 });
  }
  const violations: string[] = [];
  let over = 0;
  let max = 0;
  for (const [muscle, sets] of muscles) {
    max = Math.max(max, sets);
    // Only the ceiling is a violation: under-shooting one muscle in a single
    // week is normal rotation, not a rule break.
    if (sets > band[1]) {
      over++;
      violations.push(
        `${muscle}: ${sets} weekly sets is over the ~${band[1]}-set ${experience} landmark`,
      );
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    detail: { muscles_trained: muscles.length, over_landmark: over, max_sets: max },
  };
}

/**
 * prompt.ts:76 — a deload (~ -40%) roughly every 4-6 weeks.
 *
 * Block-level: takes the weekly TSS series in order. [buildWeeks] is how many
 * build weeks already preceded the series (plan-week counts these by regex over
 * week_plans.focus), so a series can start mid-block.
 */
export function checkDeload(weekTss: number[], buildWeeks = 0): CheckResult {
  const deloadIdx: number[] = [];
  const violations: string[] = [];
  let sinceDeload = buildWeeks;

  for (let i = 0; i < weekTss.length; i++) {
    const prior = i === 0 ? null : weekTss[i - 1];
    const cut = prior && prior > 0 ? (prior - weekTss[i]) / prior : 0;
    const isDeload = cut >= DELOAD_CUT.min;
    if (isDeload) {
      deloadIdx.push(i);
      sinceDeload = 0;
      continue;
    }
    sinceDeload++;
    if (sinceDeload > DELOAD_EVERY_WEEKS.max) {
      violations.push(
        `week ${i + 1}: ${sinceDeload} build weeks with no deload, over the ` +
        `${DELOAD_EVERY_WEEKS.max}-week ceiling`,
      );
      sinceDeload = 0; // report once per overrun, not every week after
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    detail: {
      weeks: weekTss.length,
      deloads: deloadIdx.length,
      first_deload_week: deloadIdx.length ? deloadIdx[0] + 1 : null,
      build_weeks_in: buildWeeks,
    },
  };
}

// ---------------------------------------------------------------------------
// One call for the eval
// ---------------------------------------------------------------------------

export interface WeekCheckContext {
  targetTss: number;
  priorWeekTss: number;
  phase: string;
  experience: string;
}

export interface WeekCheckResult {
  ok: boolean;
  violations: string[];
  checks: Record<string, CheckResult>;
  metrics: WeekMetrics;
}

/** Every week-level check at once. Violations concatenate in reviewWorkout's format. */
/**
 * prompt.ts:57 "Long run (Z2, ≤30-35% of weekly volume)". Flagged past 0.40 —
 * the tilde-band treatment every other threshold here gets — and only when the
 * week holds 3+ runs: with 1-2 runs each is naturally half the volume and the
 * rule (a marathon-training landmark) doesn't apply. Was prose-only; the eval's
 * judge caught a 116-TSS long run nothing verified.
 */
export const MAX_LONG_RUN_FRACTION = 0.40;

export function checkLongRun(plan: WeekPlan): CheckResult {
  const runs = plan.days.map((d) => d.session).filter((s) => s.type === "run");
  const mins = runs.map((s) => s.duration_minutes || 0).filter((m) => m > 0);
  if (mins.length < 3) return pass({ runs: mins.length, long_run_fraction: null });
  const total = mins.reduce((a, b) => a + b, 0);
  const longest = Math.max(...mins);
  const frac = longest / total;
  const detail = { runs: mins.length, long_run_fraction: +frac.toFixed(2), longest_minutes: longest };
  if (frac <= MAX_LONG_RUN_FRACTION) return pass(detail);
  return {
    ok: false,
    violations: [
      `long run is ${pct(frac)} of weekly running, over the ~35% long-run ceiling`,
    ],
    detail,
  };
}

export function checkWeek(plan: WeekPlan, ctx: WeekCheckContext): WeekCheckResult {
  const checks: Record<string, CheckResult> = {
    hard_spacing: checkHardSpacing(plan),
    polarization: checkPolarization(plan),
    tss_target: checkTssTarget(plan, ctx.targetTss),
    ramp: checkRamp(plan, ctx.priorWeekTss),
    taper: checkTaper(plan, ctx.priorWeekTss, ctx.phase),
    set_landmarks: checkSetLandmarks(plan, ctx.experience),
    long_run: checkLongRun(plan),
  };
  const violations = Object.values(checks).flatMap((c) => c.violations);
  return { ok: violations.length === 0, violations, checks, metrics: weekMetrics(plan) };
}
