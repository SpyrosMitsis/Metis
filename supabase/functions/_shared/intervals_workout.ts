import type { NumericTarget } from "../../../shared/prescription.ts";
import { assertPrescriptionProjection } from "./prescription.ts";
// ============================================================================
// Convert our generic Workout into Intervals.icu's *workout text* syntax.
//
// Intervals.icu parses the event `description` into a STRUCTURED workout (steps
// with durations + targets + repeats) when the text follows its format, and
// then syncs those steps to the connected watch (Garmin / Amazfit via Zepp).
// Our old renderer emitted markdown ("## Section", "- name 5x3min @ pace Z4")
// which Intervals can't parse — the watch got opaque prose with no targets.
//
// Intervals.icu format we emit (endurance):
//
//   Warmup
//   - 10m Z1 HR
//
//   3x
//   - 3m Z4 Pace
//   - 90s Z1 Pace
//
//   Cooldown
//   - 10m Z1 Pace
//
// Rules that matter for the parser:
//   • A bare text line (no leading "-") is a step-group header.
//   • A line "Nx" starts a repeat block; the following "-" steps are repeated.
//   • Steps start with "-" then a duration token then a target.
//   • Duration tokens: "30s", "10m" (minutes), "1h", "1km". Distance in plain
//     metres is ambiguous with minutes, so we normalise metres → km.
//   • Targets: "Z2 Pace", "Z4 HR", or "75% Pace".
// ============================================================================

import type { Workout, WorkoutExercise, WorkoutSection } from "./types.ts";

// Normalise a zone label to Intervals' "Z<n>" form. Accepts "Z4", "Zone 4",
// "4", "z4 - threshold" → "Z4". Returns null if no zone number is present.
export function normZone(raw?: string | null): string | null {
  if (!raw) return null;
  const m = String(raw).match(/(\d)/);
  return m ? `Z${m[1]}` : null;
}

// Parse a free-form reps/duration string into an Intervals duration token.
//   "10 min" / "10m" → "10m" | "30s" / "30 sec" → "30s" | "1h" → "1h"
//   "1km" / "1k" → "1km" | "800m" (≥100, bare m) → "0.8km" | "5:00" → "300s"
// Returns null when nothing time/distance-like is present (e.g. "8-10" reps).
export function durationToken(reps?: string | null): string | null {
  if (reps == null) return null;
  const s = String(reps).trim().toLowerCase();
  if (!s) return null;
  let m: RegExpMatchArray | null;
  // mm:ss clock → seconds
  if ((m = s.match(/^(\d+):(\d{2})$/))) {
    return `${parseInt(m[1], 10) * 60 + parseInt(m[2], 10)}s`;
  }
  // hours
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/))) {
    return `${trimNum(m[1])}h`;
  }
  // kilometres
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:kilometers?|kilometres?|km|k)\b/))) {
    return `${trimNum(m[1])}km`;
  }
  // explicit minutes
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min)\b/))) {
    return `${trimNum(m[1])}m`;
  }
  // explicit seconds
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|sec|s)\b/))) {
    return `${trimNum(m[1])}s`;
  }
  // explicit metres → normalise to km to avoid the m=minutes clash
  if ((m = s.match(/^(\d+)\s*(?:meters?|metres?)\b/))) {
    return metresToken(parseInt(m[1], 10));
  }
  // bare "<n>m": ≥100 ⇒ metres (interval distance), else minutes
  if ((m = s.match(/^(\d+)\s*m\b/))) {
    const n = parseInt(m[1], 10);
    return n >= 100 ? metresToken(n) : `${n}m`;
  }
  // bare number with no unit → assume minutes (LLMs sometimes do this)
  if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) {
    return `${trimNum(m[1])}m`;
  }
  return null;
}

function metresToken(n: number): string {
  return n % 1000 === 0 ? `${n / 1000}km` : `${trimNum((n / 1000).toFixed(3))}km`;
}

function trimNum(v: string): string {
  return String(parseFloat(v));
}

// Rest seconds → a recovery duration token ("90s" under 2 min, else "Nm").
function restToken(sec: number): string {
  const seconds = Math.round(sec);
  return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

// The intensity target for an endurance step.
function paceTarget(e: WorkoutExercise): string {
  const pace = normZone(e.pace_zone);
  if (pace) return `${pace} Pace`;
  const hr = normZone(e.hr_zone);
  if (hr) return `${hr} HR`;
  return "Z2 Pace"; // safe default so the step still has a target
}

function renderEnduranceSection(s: WorkoutSection): string[] {
  const out: string[] = [];
  out.push(s.name || "Block");
  for (const e of s.exercises) {
    // Blank lines delimit repeat groups in Intervals. Without them, a later
    // exercise in the same section becomes part of the preceding repeat.
    if (out.length > 1) out.push("");
    const dur = durationToken(e.reps) ?? minutesToken(s, e);
    const target = paceTarget(e);
    const reps = e.sets && e.sets > 1 ? e.sets : 1;
    if (reps > 1) {
      // A repeat block: work step + (if there's rest) a recovery step.
      if (out[out.length - 1] !== "") out.push("");
      out.push(`${reps}x`);
      out.push(`- ${dur} ${target}`);
      if (e.rest_seconds && e.rest_seconds > 0) {
        out.push(`- ${restToken(e.rest_seconds)} Z1 ${target.endsWith(" HR") ? "HR" : "Pace"}`);
      }
    } else {
      out.push(`- ${dur} ${target}`);
    }
  }
  return out;
}

// Fall back to the section duration / a sane default when reps carry no time.
function minutesToken(s: WorkoutSection, e: WorkoutExercise): string {
  const sets = e.sets && e.sets > 1 ? e.sets : 1;
  const perRep = s.duration_minutes && sets > 0 ? s.duration_minutes / sets : s.duration_minutes;
  if (perRep && perRep > 0) return `${Math.round(perRep)}m`;
  return "5m";
}

// Strength: Intervals has no structured strength steps, but a clean, consistent
// list reads well on the watch and in the calendar — one line per exercise,
// blank line between sections.
function renderStrengthSections(w: Pick<Workout, "sections">): string {
  const parts: string[] = [];
  for (const s of w.sections) {
    const lines: string[] = [s.name || "Block"];
    for (const e of s.exercises) {
      const bits: string[] = [];
      const setReps = e.sets && e.reps ? `${e.sets}×${e.reps}` : e.reps || (e.sets ? `${e.sets} sets` : "");
      if (setReps) bits.push(setReps);
      if (e.weight_kg != null && e.weight_kg > 0) bits.push(`@ ${e.weight_kg}kg`);
      if (e.rest_seconds && e.rest_seconds > 0) bits.push(`rest ${restToken(e.rest_seconds)}`);
      const rir = e.notes?.match(/\d\s*RIR/i)?.[0];
      if (rir) bits.push(rir.toUpperCase());
      lines.push(`- ${e.name}${bits.length ? `: ${bits.join(" ")}` : ""}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function numericTransport(t?: NumericTarget): string {
  if (!t) return "";
  if (t.kind === "power_watts") return `${t.min}-${t.max}w`;
  const pace = (seconds: number) => {
    const rounded = Math.round(seconds);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
  };
  if (t.kind === "pace_seconds_per_km" || t.kind === "pace_seconds_per_100m") {
    const unit = t.kind === "pace_seconds_per_km" ? "km" : "100m";
    // The unit qualifies the complete range, not each bound.
    return `${pace(t.min)}-${pace(t.max)}/${unit} Pace`;
  }
  return ""; // Absolute bpm is retained as a cue, never mislabeled as %HRmax.
}

// Render a full Workout to Intervals.icu description text. The coach note is
// appended at the END as plain prose so it never disrupts step parsing.
export function renderIntervalsWorkout(w: Workout): string {
  if (w.prescription && ["run", "ride", "swim"].includes(w.type)) {
    assertPrescriptionProjection(w);
    const lines: string[] = [];
    for (const b of w.prescription.blocks) {
      if (b.kind !== "endurance") continue;
      lines.push(`${b.role}: ${b.label}. Effort ${b.target.min}-${b.target.max}/10${b.stroke ? `. ${b.stroke}` : ""}${b.numeric_target?.kind === "heart_rate_bpm" ? `. HR guide ${b.numeric_target.min}-${b.numeric_target.max} bpm (instruction only)` : ""}`);
      for (let i = 0; i < b.repetitions; i++) {
        // Distances use explicit metres; m alone means minutes to the provider.
        // Export declared zone goals; older effort-only prescriptions retain their original transport.
        const duration = b.distance ? `${b.distance.value * (b.distance.unit === "yd" ? 0.9144 : 1)}mtr` : `${b.work_seconds}s`;
        const zoneUnit = w.type === "ride" ? "HR" : "Pace";
        const declaredZone = w.prescription.presentation_version === 4 ? b.intensity_zone : undefined;
        const target = numericTransport(b.numeric_target) || (declaredZone ? `${declaredZone} ${zoneUnit}` : "");
        lines.push(`- ${duration}${target ? " " + target : ""}`);
        if (b.recovery_seconds && (i < b.repetitions - 1 || b.recovery_after_last)) lines.push(`- ${b.recovery_seconds}s${b.recovery_mode === "stationary" ? " intensity=rest" : declaredZone ? ` Z1 ${zoneUnit}` : ""}`);
      }
      if (b.transition_seconds) lines.push(`- ${b.transition_seconds}s`);
      lines.push("");
    }
    return [...lines, w.coach_note].join("\n").trim();
  }
  const body = w.type === "run" || w.type === "ride"
    ? w.sections.map((s) => renderEnduranceSection(s).join("\n")).join("\n\n")
    : renderStrengthSections(w);
  return (w.coach_note ? `${body}\n\n${w.coach_note}` : body).trim();
}

// A logged/routine strength session (push-strength shape) → Intervals text.
export interface PushSet { reps: number; weight_kg?: number | null; rpe?: number | null }
export interface PushExercise { name: string; muscle?: string; sets: PushSet[] }

export function renderStrengthSession(name: string, exercises: PushExercise[]): string {
  const lines: string[] = [name];
  for (const ex of exercises) {
    // Collapse identical sets ("3×5 @ 100kg"), else list them.
    const setStrs = ex.sets.map((s) => {
      const w = s.weight_kg != null && s.weight_kg > 0 ? `@${s.weight_kg}kg` : "";
      const rpe = s.rpe != null ? ` RPE${s.rpe}` : "";
      return `${s.reps}${w}${rpe}`.trim();
    });
    const allSame = setStrs.length > 1 && setStrs.every((x) => x === setStrs[0]);
    const body = allSame ? `${ex.sets.length}×(${setStrs[0]})` : setStrs.join(", ");
    lines.push(`- ${ex.name}: ${body || `${ex.sets.length} sets`}`);
  }
  return lines.join("\n");
}
