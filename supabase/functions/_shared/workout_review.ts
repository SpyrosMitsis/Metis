import { prescriptionEffortMinutes } from "./prescription.ts";
import { EXERCISE_CATALOG as REQUIREMENT_CATALOG } from "./exercise_catalog.ts";
import { requirements } from "./exercise_requirements.ts";
// ============================================================================
// Post-generation CONTENT review — the layer that makes the engine trustworthy.
//
// Zod (workout_schema.ts) validates the *shape*. This validates the
// *prescription*: progression upper bound, load safety ceiling, weekly volume
// landmarks, 48h muscle recovery, endurance 80/20 / readiness, and an
// independent TSS recompute (the model's self-reported TSS is unreliable and
// feeds next-day ACWR, so we cross-check and replace it when it's way off).
//
// Pure + dependency-light so it's unit-testable without network or an LLM.
// `reviewWorkout` auto-CORRECTS the safe, unambiguous things (load ceilings,
// bad TSS) and FLAGS the judgement calls (volume, recovery, readiness) as
// violations the caller can feed into the self-repair retry.
// ============================================================================

import type { InjuryBackoff, InjuryEntry, Workout, WorkoutExercise } from "./types.ts";
import { allowedCategories, categoryOfExercise, enforceStrengthCatalog, EXERCISE_CATALOG } from "./exercise_catalog.ts";
import { exerciseLoadsArea, sportsForArea } from "./injury.ts";
import type { NextTarget } from "./progression.ts";

export interface MainLift {
  exercise: string;
  estimated1rm: number;
  lastWeight: number;
  lastReps?: number;
  lastSets?: number;
  // The app's double-progression target for the next session (progression.ts).
  // When set, the review snaps the prescription to it so the plan always says
  // the same thing as the logger's ↗ target.
  target?: NextTarget | null;
}

export interface ReviewContext {
  /** Required for newly generated plans; historical reviews may include custom lifts. */
  catalogOnly?: boolean;
  mainLifts: MainLift[];
  weeklySetsByMuscle: Record<string, number>;
  muscleGroupsLast48h: string[];
  tsb: number;
  daysSinceLastHard: number;
  experience: string;
  // Structured injuries (injuriesOf() in profile.ts — handles the legacy
  // free-text fallback). coach_knowledge is intentionally NOT folded in here:
  // it's unstructured prose covered by the prompt-level "avoid aggravating"
  // instruction, not by this deterministic backstop.
  injuries?: InjuryEntry[];
  // Active, unexpired per-area backoffs (activeBackoffs() in injury.ts) written
  // by the post-workout pain check. Distinct from `injuries`: an injury is a
  // standing fact, a backoff is a DATED instruction from something that hurt
  // this week, and it is enforced here rather than left to the prompt for the
  // same reason training_paused_until is a column and not a sentence.
  backoffs?: InjuryBackoff[];
  // Today's recovery/readiness score (0-100). Low readiness + a hard session →
  // the intensity ceiling caps it deterministically (not just a flag).
  readiness?: number;
  // What that score rests on (recovery.ts RecoveryBasis). "none" means nothing
  // was measured and the 50 is a placeholder, so it must not cap anything.
  readinessBasis?: "measured" | "subjective" | "none";
  // The athlete's equipment tier (onboarding.equipment) — strength lifts whose
  // catalog category isn't available get stripped.
  equipment?: string;
  implements?: string[];
  maxMinutes?: number;
}

export type ViolationCode = "CATALOG_ENTRY" | "INJURY_CONTRAINDICATION" | "AVOID_SPORT" | "AVOID_MOVEMENT" | "EASE_INTENSITY" | "EASE_MOVEMENT" | "EQUIPMENT" | "PROGRESSION_TARGET" | "LOAD_FLOOR" | "LOAD_CEILING" | "ABSOLUTE_LOAD" | "MUSCLE_RECOVERY" | "WEEKLY_VOLUME" | "QUALITY_DURATION" | "MIXED_QUALITY" | "FATIGUE" | "HARD_SPACING" | "READINESS_CAP";
export interface ReviewIssue { code: ViolationCode; message: string }

export interface ReviewResult {
  issues: ReviewIssue[];
  violations: string[];
  corrected: Workout;
  // Populated when the independent recompute overrode the model's tss_estimate.
  tssReplaced?: { from: number; to: number };
  // Hard safety blocks (contraindicated movements). These are STRIPPED from
  // `corrected`; if any remain the caller must reject + fall back, never serve.
  unsafe: string[];
}

// --- structured contraindication engine ------------------------------------
// A conservative backstop ON TOP of the free-text coach_knowledge already in the
// prompt: the engine will never SERVE a movement that loads an active injury,
// even if the model ignores the text. Each rule maps an injury pattern to the
// exercise-name patterns it forbids.
interface SafetyRule { when: RegExp; forbid: RegExp; reason: string }
const SAFETY_RULES: SafetyRule[] = [
  {
    when: /lower.?back|low.?back|lumbar|herniat|sciatic|disc|spine|spinal/i,
    forbid: /dead\s?lift|good.?morning|bent.?over\s?row|barbell\s?row|pendlay|sit.?up|jefferson|back\s?extension|hyperextension/i,
    reason: "loads the lumbar spine under flexion",
  },
  {
    when: /knee|patell|acl|mcl|meniscus/i,
    forbid: /pistol|jump\s?squat|box\s?jump|depth\s?jump|plyo|sissy\s?squat|leg\s?extension/i,
    reason: "high or explosive knee-joint stress",
  },
  {
    when: /shoulder|rotator|labrum|ac\s?joint|impinge/i,
    forbid: /behind.?the.?neck|upright\s?row|overhead\s?press|military\s?press|\bdips?\b/i,
    reason: "impingement / unstable overhead shoulder load",
  },
  {
    when: /achilles|calf\s?strain|plantar/i,
    forbid: /jump|plyo|sprint|depth\s?jump|bound/i,
    reason: "explosive ankle/Achilles load",
  },
  {
    when: /wrist|carpal/i,
    forbid: /front\s?squat|barbell\s?curl|\bclean\b|\bsnatch\b/i,
    reason: "wrist extension under load",
  },
];

// A SafetyRule paired with the severity of the injury entry that triggered
// it, so the caller can decide strip-vs-flag per match.
export interface ActiveSafetyRule extends SafetyRule { severity: InjuryEntry["severity"] }

export function activeSafetyRules(injuries: InjuryEntry[]): ActiveSafetyRule[] {
  if (!injuries?.length) return [];
  const out: ActiveSafetyRule[] = [];
  for (const rule of SAFETY_RULES) {
    const hit = injuries.find((i) => i.status !== "resolved" && (rule.when.test(i.area) || (i.note && rule.when.test(i.note))));
    if (hit) out.push({ ...rule, severity: hit.severity });
  }
  return out;
}

// --- helpers (exported for the eval harness) -------------------------------

const norm = (s: string) => s.trim().toLowerCase();

const CATALOG_MUSCLE = new Map(EXERCISE_CATALOG.map((e) => [norm(e.name), e.muscle]));

export function muscleOf(ex: WorkoutExercise): string {
  return (ex.muscle && ex.muscle.trim()) || CATALOG_MUSCLE.get(norm(ex.name)) || "Other";
}

const isWarmupSection = (name: string) => /warm|cool|mobility|activation/i.test(name);

// A working set carries real load/effort (not a warmup, not bodyweight filler).
function workingSets(ex: WorkoutExercise): number {
  return Math.max(0, Math.round(ex.sets || 0));
}

// Weekly hard-set landmark per experience tier, the top of each range in
// prompt.ts (Beginner ~8-12, Intermediate ~12-18, Advanced ~16-22+). This was a
// flat 22 for everyone, so a Beginner prescribed 20 sets broke the prompt and
// passed the checker (formerly KNOWN_CONTRADICTIONS "weekly-sets"). Advanced
// keeps 22 as a junk-volume landmark even though its tier is open-ended.
export function maxWeeklySets(experience: string): number {
  const e = (experience ?? "").toLowerCase();
  if (e.includes("beginner")) return 12;
  if (e.includes("advanced")) return 22;
  return 18;
}
// Absolute load sanity cap (kg) when we have no 1RM to anchor to — catches
// data-entry disasters (e.g. a "300 kg" curl) without guessing bodyweight.
const ABSOLUTE_LOAD_CAP_KG = 400;

// Zone → TSS-per-minute. Calibrated so ~60 min Z2 ≈ 50 TSS and an hour at
// threshold ≈ ~75-100. Used only as an independent cross-check.
//
// The derivation, so it can be argued with instead of guessed at. Standard TSS
// is `hours × IF² × 100`, i.e. TSS/min = IF²×100/60. Inverting each rate gives
// the intensity factor it assumes, and every one lands in the UPPER part of its
// own Coggan band:
//
//   zone  rate   implied IF   band (% FTP)
//   Z1    0.5    0.55         0-55     (top)
//   Z2    0.8    0.69         56-75    (upper)
//   Z3    1.2    0.85         76-90    (upper)
//   Z4    1.7    1.01         91-105   (upper)
//   Z5    2.2    1.15         106-120  (upper)
//
// Upper-band is the right bias for a PRESCRIBED session: told "a Z2 run", an
// athlete targets the top of Z2, not its floor. It is also why zoneOf() resolves
// a range to its HIGHEST zone — "Z1-Z2" is an easy run in the Z2 part of the
// band, so pricing it at Z1 (as it did) under-counted every long easy session.
// zone_calibration_test.ts pins these, so a silent edit shows up as a failure.
export const ZONE_TSS_PER_MIN: Record<string, number> = {
  Z1: 0.5,
  Z2: 0.8,
  Z3: 1.2,
  Z4: 1.7,
  Z5: 2.2,
};

/**
 * The Z1-Z5 zone an exercise names, from either channel. Exported so the plan
 * checkers read zones exactly the way the review engine does.
 *
 * A range resolves to its HIGHEST zone. Models write ranges constantly ("Z1-Z2"
 * for an easy run, "Z3-Z4" for a threshold block, "Z4-Z5" for strides) — 15% of
 * every zone string in a real eval run — and this used to take the FIRST match,
 * pricing each range at its floor:
 *
 *   Z1-Z2 → Z1   0.5/min instead of 0.8   (-37%)
 *   Z3-Z4 → Z3   1.2/min instead of 1.7   (-29%)
 *
 * That silently under-counted every long easy session, and reviewWorkout then
 * OVERWROTE the model's own (closer) tss_estimate with the under-count. It also
 * read a "Z2-Z3" tempo as easy, hiding it from hard-day spacing — the unsafe
 * direction. Taking the top matches ZONE_TSS_PER_MIN's upper-band calibration
 * and errs toward counting load and flagging hard days, which is the side to err.
 */
export function zoneOf(ex: WorkoutExercise): string | null {
  const z = ex.hr_zone || ex.pace_zone;
  if (!z) return null;
  let top = 0;
  for (const m of z.matchAll(/z\s*([1-5])/gi)) top = Math.max(top, Number(m[1]));
  return top ? `Z${top}` : null;
}

export const zoneIsHard = (z: string | null) => z === "Z3" || z === "Z4" || z === "Z5";

// Endurance sports share the zone × duration model. Swim was excluded from both
// functions below (formerly KNOWN_CONTRADICTIONS "swim"): a hard Z4 CSS swim was
// invisible to hard-day spacing and priced as strength working sets. TSS is
// sport-agnostic (hours × IF² × 100), so CSS zones price like pace/HR zones.
const isEndurance = (t: Workout["type"]) => t === "run" || t === "ride" || t === "swim";

/** Is this endurance session a hard/quality effort (Z3+ work or RPE ≥ 7)? */
export function isHardSession(w: Workout): boolean {
  if (!isEndurance(w.type)) return false;
  if (w.rpe_target >= 7) return true;
  if (w.prescription) return prescriptionEffortMinutes(w.prescription).some(b => zoneIsHard(b.zone));
  return w.sections.some((s) => s.exercises.some((ex) => zoneIsHard(zoneOf(ex))));
}

/** Independent TSS estimate so a bad model self-report can't poison ACWR. */
export function computeTss(w: Workout): number {
  if (w.type === "rest") return 0;

  if (isEndurance(w.type)) {
    if (w.prescription) return Math.round(prescriptionEffortMinutes(w.prescription).reduce((sum, b) => sum + b.mins * (ZONE_TSS_PER_MIN[b.zone] ?? 0), 0));
    let tss = 0;
    for (const sec of w.sections) {
      for (const ex of sec.exercises) {
        // Minutes for this piece: explicit section split across its exercises,
        // falling back to the section duration when exercises don't carry time.
        const mins = sec.duration_minutes && sec.exercises.length
          ? sec.duration_minutes / sec.exercises.length
          : 0;
        const z = zoneOf(ex) ?? "Z2";
        tss += mins * (ZONE_TSS_PER_MIN[z] ?? ZONE_TSS_PER_MIN.Z2);
      }
    }
    // Fall back to a duration estimate if sections carried no minutes.
    if (tss === 0 && w.duration_minutes > 0) tss = w.duration_minutes * ZONE_TSS_PER_MIN.Z2;
    return Math.round(tss);
  }

  // Strength: working sets drive load. ~3.3 TSS/working set is a defensible
  // mid-intensity heuristic (≈ 15-20 sets → 50-66 TSS for a typical session).
  let sets = 0;
  for (const sec of w.sections) {
    if (isWarmupSection(sec.name)) continue;
    for (const ex of sec.exercises) sets += workingSets(ex);
  }
  return Math.round(Math.min(120, sets * 3.3));
}

// --- main review -----------------------------------------------------------

export function reviewWorkout(w: Workout, ctx: ReviewContext): ReviewResult {
  const violations: string[] = [];
  const issues: ReviewIssue[] = [];
  const issue = (code: ViolationCode, message: string) => { issues.push({code,message}); violations.push(message); };
  const unsafe: string[] = [];
  // Deep-ish clone so corrections don't mutate the caller's object.
  const corrected: Workout = {
    ...w,
    sections: w.sections.map((s) => ({ ...s, exercises: s.exercises.map((e) => ({ ...e })) })),
  };

  if (ctx.catalogOnly) {
    for (const name of enforceStrengthCatalog(corrected)) {
      issue("CATALOG_ENTRY", `${name}: not in the bundled exercise library, removed; choose a library exercise`);
    }
  }

  // SAFETY FIRST — strip any contraindicated movement, whatever the type. The
  // engine must never serve a movement that loads an active injury. Severity
  // gates strip-vs-flag: "mild" is a caution (left in, just flagged for the
  // repair pass to see); unset/moderate/serious all hard-forbid, since the
  // engine is a conservative backstop and an unknown severity should err safe.
  const rules = activeSafetyRules(ctx.injuries ?? []);
  if (rules.length) {
    for (const sec of corrected.sections) {
      sec.exercises = sec.exercises.filter((ex) => {
        const hit = rules.find((r) => r.forbid.test(ex.name));
        if (!hit) return true;
        const msg = `${ex.name}: contraindicated, ${hit.reason} (injury on file)`;
        issue("INJURY_CONTRAINDICATION", msg);
        if (hit.severity === "mild") return true; // caution only, keep it
        unsafe.push(msg);
        return false; // remove it
      });
    }
    // Drop sections emptied by the safety strip.
    corrected.sections = corrected.sections.filter((s) => s.exercises.length > 0);
  }

  // INJURY BACKOFF — the dated instruction from a pain report, enforced HERE so
  // it cannot be argued with by a model that skimmed the prompt. Two levels,
  // and the difference between them is deliberate:
  //
  //   avoid  structural. The movements that load the area are STRIPPED, exactly
  //          like a contraindication, and an endurance session in a sport the
  //          area can't take is flagged unsafe (generate-workout substitutes the
  //          sport before generating, so reaching here means the model ignored
  //          the type it was given).
  //   ease   intensity. The area is still trained, just not hard: hard zones
  //          come down to Z2 and the effort target is capped. The lifts that
  //          load it are flagged, not removed, so the repair pass lightens the
  //          prescription instead of gutting the session.
  const backoffs = ctx.backoffs ?? [];
  if (backoffs.length) {
    const avoid = backoffs.filter((b) => b.level === "avoid");
    const ease = backoffs.filter((b) => b.level === "ease");

    for (const b of avoid) {
      if (isEndurance(corrected.type) && sportsForArea(b.area).includes(corrected.type)) {
        const msg = `${corrected.type} loads the ${b.area}, which is on an avoid backoff until ${b.until}`;
        issue("AVOID_SPORT", msg);
        unsafe.push(msg);
      }
      for (const sec of corrected.sections) {
        sec.exercises = sec.exercises.filter((ex) => {
          if (!exerciseLoadsArea(b.area, ex.name, muscleOf(ex))) return true;
          issue("AVOID_MOVEMENT", 
            `${ex.name}: loads the ${b.area}, on an avoid backoff until ${b.until}, removed`,
          );
          return false;
        });
      }
    }
    corrected.sections = corrected.sections.filter((s) => s.exercises.length > 0);

    // Easing is an intensity ceiling, applied the same way the readiness cap
    // below applies one. Capped at 6 (not the readiness cap's 4/5): the athlete
    // is training, just not driving into a sore area.
    const EASE_RPE_CAP = 6;
    for (const b of ease) {
      const sportHit = isEndurance(corrected.type) && sportsForArea(b.area).includes(corrected.type);
      if (sportHit) {
        for (const sec of corrected.sections) {
          for (const ex of sec.exercises) {
            if (!zoneIsHard(zoneOf(ex))) continue;
            if (ex.hr_zone) ex.hr_zone = "Z2";
            if (ex.pace_zone) ex.pace_zone = "Z2";
          }
        }
        if (corrected.rpe_target > EASE_RPE_CAP) corrected.rpe_target = EASE_RPE_CAP;
        issue("EASE_INTENSITY", 
          `${b.area} is on an ease backoff until ${b.until}, ${corrected.type} capped to easy aerobic (Z2, RPE <=${EASE_RPE_CAP})`,
        );
      }
      const loaded = corrected.sections
        .flatMap((s) => s.exercises)
        .filter((ex) => exerciseLoadsArea(b.area, ex.name, muscleOf(ex)))
        .filter((ex) => !corrected.prescription || corrected.prescription.blocks.some(block => block.kind === "strength" && block.name === ex.name && block.target.max > EASE_RPE_CAP))
        .map((ex) => ex.name);
      if (loaded.length) {
        issue("EASE_MOVEMENT", 
          `${b.area} is on an ease backoff until ${b.until}: keep ${loaded.join(", ")} light, ` +
            `well short of failure, and drop the load rather than the reps`,
        );
      }
    }
  }

  // EQUIPMENT — never serve a strength lift the athlete can't perform with their
  // gear. Only KNOWN catalog lifts are filtered (reworded/unknown names pass), and
  // only when the equipment tier is recognised (else fail open). Flagged too, so
  // the caller's repair pass regenerates an equipment-appropriate session.
  const allowed = allowedCategories(ctx.equipment);
  if (allowed && !ctx.implements && w.type === "strength") {
    for (const sec of corrected.sections) {
      sec.exercises = sec.exercises.filter((ex) => {
        const cat = categoryOfExercise(ex.name);
        if (cat && !allowed.has(cat)) {
          issue("EQUIPMENT", `${ex.name}: needs ${cat}, not in the athlete's equipment (${ctx.equipment}), removed`);
          return false;
        }
        return true;
      });
    }
    corrected.sections = corrected.sections.filter((s) => s.exercises.length > 0);
  }

  if (ctx.implements && w.type === "strength") {
    for (const sec of corrected.sections) sec.exercises = sec.exercises.filter(ex => {
      const entry = REQUIREMENT_CATALOG.find(e => e.name === ex.name);
      const missing = entry ? requirements(entry).implements.filter(i => !ctx.implements!.includes(i)) : [];
      if (missing.length) issue("EQUIPMENT", `${ex.name}: missing ${missing.join(", ")}`);
      return missing.length === 0;
    });
    corrected.sections = corrected.sections.filter(s => s.exercises.length);
  }

  if (w.type === "strength") {
    const liftByName = new Map(ctx.mainLifts.map((l) => [norm(l.exercise), l]));
    const prescribedSetsByMuscle: Record<string, number> = {};

    for (const sec of corrected.sections) {
      const warm = isWarmupSection(sec.name);
      for (const ex of sec.exercises) {
        const lift = liftByName.get(norm(ex.name));

        // A progression target is an upper bound, not a mandatory minimum.
        // Lighter work is valid for familiarization, recovery and reduced-load
        // weeks. Never copy a target between exercises or force reps upward.
        if (lift?.target && !warm && typeof ex.weight_kg === "number" &&
            ex.weight_kg > lift.target.weightKg) {
          issue("PROGRESSION_TARGET",
            `${ex.name}: load exceeds the exercise's progression target; capped at ${lift.target.weightKg}kg`);
          ex.weight_kg = lift.target.weightKg;
        }

        // Safety CEILING: clamp implausible loads.
        if (typeof ex.weight_kg === "number") {
          if (lift && !/assisted/i.test(ex.name) && categoryOfExercise(ex.name) !== "Band" && lift.estimated1rm > 0 && ex.weight_kg > lift.estimated1rm * 1.5) {
            const cap = Math.round(lift.estimated1rm * 1.5);
            issue("LOAD_CEILING", `${ex.name}: ${ex.weight_kg}kg exceeds 1.5× est 1RM, clamped to ${cap}kg`);
            ex.weight_kg = cap;
          } else if (ex.weight_kg > ABSOLUTE_LOAD_CAP_KG) {
            issue("ABSOLUTE_LOAD", `${ex.name}: ${ex.weight_kg}kg exceeds the ${ABSOLUTE_LOAD_CAP_KG}kg sanity cap, clamped`);
            ex.weight_kg = ABSOLUTE_LOAD_CAP_KG;
          }
        }

        // 48h recovery: flag hard loading of a recently-trained muscle.
        const muscle = muscleOf(ex);
        if (!warm && ctx.muscleGroupsLast48h.includes(muscle) && (ex.weight_kg ?? 0) > 0) {
          issue("MUSCLE_RECOVERY", `${ex.name}: loads ${muscle}, trained in the last 48h, should be recovering`);
        }

        if (!warm) prescribedSetsByMuscle[muscle] = (prescribedSetsByMuscle[muscle] ?? 0) + workingSets(ex);
      }
    }

    // Weekly volume landmark: prescribed + already-done must not blow past the
    // athlete's tier ceiling (12/18/22 for Beginner/Intermediate/Advanced).
    const setLandmark = maxWeeklySets(ctx.experience);
    for (const [muscle, prescribed] of Object.entries(prescribedSetsByMuscle)) {
      const total = (ctx.weeklySetsByMuscle[muscle] ?? 0) + prescribed;
      if (total > setLandmark) {
        issue("WEEKLY_VOLUME", `${muscle}: ${total} weekly sets exceeds the ~${setLandmark}-set landmark (junk volume)`);
      }
    }
  }

  // QUALITY OVERLOAD — one session must be one quality session. The eval's
  // judge caught what no check did: 20 min threshold + 3x4 min VO2 stacked in a
  // single run passed everything, yet each block alone is a full session by
  // prompt.ts:57-59 (tempo "20-40 min"; VO2 "3-5 min reps"). Two flags:
  //   - hard minutes beyond the 40-min tempo top end (an overstuffed session);
  //   - a full threshold block AND a full VO2 block together. Strides after a
  //     tempo stay legal: 6-10 x ~20s is ~3 min of Z5, under the 10-min bar.
  // RUN only: prompt.ts:57-59 is the running section, and rides legitimately
  // hold more sub-threshold time (2x20 sweet spot is normal cycling).
  if (corrected.type === "run") {
    let tempoMins = 0, vo2Mins = 0;
    for (const sec of corrected.sections) {
      if (isWarmupSection(sec.name)) continue;
      const per = sec.duration_minutes && sec.exercises.length
        ? sec.duration_minutes / sec.exercises.length
        : 0;
      for (const ex of sec.exercises) {
        const z = zoneOf(ex);
        if (z === "Z3" || z === "Z4") tempoMins += per;
        else if (z === "Z5") vo2Mins += per;
      }
    }
    if (corrected.prescription) {
      const pieces = prescriptionEffortMinutes(corrected.prescription);
      tempoMins = pieces.filter(p => p.zone === "Z3" || p.zone === "Z4").reduce((sum, p) => sum + p.mins, 0);
      vo2Mins = pieces.filter(p => p.zone === "Z5").reduce((sum, p) => sum + p.mins, 0);
    }
    const hardMins = tempoMins + vo2Mins;
    if (hardMins > 40) {
      issue("QUALITY_DURATION", 
        `${Math.round(hardMins)} min of Z3+ work in one session is over the 40-min quality ceiling (one quality block per day)`,
      );
    } else if (tempoMins >= 20 && vo2Mins >= 10) {
      issue("MIXED_QUALITY", 
        `a full threshold block (${Math.round(tempoMins)} min) AND a full VO2 block (${Math.round(vo2Mins)} min) in one session; pick one quality focus per day`,
      );
    }
  }

  // Endurance readiness: a hard session on a depleted athlete is a red flag.
  if (isHardSession(corrected)) {
    if (ctx.tsb < -20) {
      issue("FATIGUE", `hard session prescribed while very fatigued (TSB ${ctx.tsb.toFixed(0)}), favor easy/recovery`);
    }
    if (ctx.daysSinceLastHard <= 1) {
      issue("HARD_SPACING", `hard session ${ctx.daysSinceLastHard}d after the last hard effort, back-to-back quality`);
    }
  }

  // INTENSITY CEILING — a hard endurance session on a compromised athlete is
  // CAPPED, not just flagged: downgrade hard zones to easy and clamp effort.
  // Final deterministic safety, even if the model (and the repair pass) ignored
  // the readiness signal. Runs before the TSS cross-check below so the recompute
  // reflects the downgraded zones.
  //
  // The caps are the SAME promises recoveryBlock (context.ts) makes to the
  // model, at the same band thresholds as recovery.ts (red <34, amber <67) —
  // ctx.readiness IS recovery.score in production. Amber used to be entirely
  // unchecked (formerly KNOWN_CONTRADICTIONS "recovery-cap"): the prompt
  // promised "amber → cap RPE 6, no intervals/threshold" and no code held it.
  // Deep TSB (≤ -20) keeps its own RPE 5 cap — that is the prompt's "recovery
  // week" rule, driven by load, not by today's recovery score. Endurance only:
  // strength intensity is governed by the progression snap above, and an amber
  // cap there would fight the engine's own targets.
  //
  // An UNMEASURED readiness caps nothing. With no wellness rows and no synced
  // signal the model lands on exactly 50/amber, which is the neutral midpoint,
  // not a reading — and it was silently clamping every hard session to RPE 6
  // for anyone without a wearable. The TSB cap below still applies: form is
  // computed from training the athlete actually did.
  const measured = ctx.readinessBasis !== "none";
  const r = measured && typeof ctx.readiness === "number" ? ctx.readiness : null;
  const rpeCap = r !== null && r < 34 ? 4 : ctx.tsb < -20 ? 5 : r !== null && r < 67 ? 6 : null;
  if (rpeCap !== null && isHardSession(corrected)) {
    for (const sec of corrected.sections) {
      for (const ex of sec.exercises) {
        if (zoneIsHard(zoneOf(ex))) {
          if (ex.hr_zone) ex.hr_zone = "Z2";
          if (ex.pace_zone) ex.pace_zone = "Z2";
        }
      }
    }
    if (corrected.rpe_target > rpeCap) corrected.rpe_target = rpeCap;
    issue("READINESS_CAP", 
      rpeCap === 6
        ? `moderate recovery (${r}/100, amber), quality capped to easy aerobic (Z2, RPE ≤6)`
        : `low readiness (${r ?? "?"}/100) / TSB ${ctx.tsb.toFixed(0)}, capped to easy aerobic (Z2, RPE ≤${rpeCap})`,
    );
  }

  // TSS is ENGINE-OWNED. The prompt no longer asks for tss_estimate: the eval
  // proved models cannot count it (misreported >25% on 12/72 rows, and an A/B
  // showed a model relabelling the same week 300→440 with the work unchanged),
  // and the old "differs by >25%, replaced" violation burnt a repair call to
  // fix a number we were about to overwrite anyway. So: endurance TSS is always
  // the zone × duration computation; strength keeps a model-supplied value if
  // one arrives (older prompts / BYO clients), bounded at 150, else the
  // sets-based heuristic. tssReplaced records a meaningful disagreement with a
  // legacy self-report for observability, never as a violation.
  let tssReplaced: { from: number; to: number } | undefined;
  if (isEndurance(corrected.type)) {
    const computed = computeTss(corrected);
    const reported = corrected.tss_estimate;
    if (computed > 0) {
      if (reported > 0 && Math.abs(reported - computed) / computed > 0.25) {
        tssReplaced = { from: reported, to: computed };
      }
      corrected.tss_estimate = computed;
    }
  } else if (corrected.type === "strength") {
    if (corrected.tss_estimate > 150) {
      tssReplaced = { from: corrected.tss_estimate, to: 150 };
      corrected.tss_estimate = 150;
    } else if (corrected.tss_estimate <= 0) {
      corrected.tss_estimate = computeTss(corrected);
    }
  }

  return { violations, issues, corrected, tssReplaced, unsafe };
}
