// ============================================================================
// Zod schema for LLM-generated workouts and week plans.
//
// LLM output is directionally right but sloppy on types, so this is a
// *coercing* schema, not a strict one: numbers get defaults and clamps,
// strings get fallbacks, and modality guardrails zero out fields that don't
// apply (a run never carries weights; strength never carries pace/HR zones).
// Hard failures are reserved for the things a prompt retry can fix: wrong
// type enum, missing title, sections not an array, empty non-rest workout.
// ============================================================================

import { PrescriptionSchema } from "./prescription.ts";
import { z } from "npm:zod@3.23.8";
import type { Workout } from "./types.ts";

const num = (d = 0) =>
  z.unknown().transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : d));
const clampNum = (lo: number, hi: number, d = 0) =>
  num(d).transform((v) => Math.max(lo, Math.min(hi, v)));
const str = (d = "") => z.unknown().transform((v) => (typeof v === "string" ? v : d));

const DEFAULT_EXERCISE = {
  name: "Exercise",
  sets: 1,
  reps: "",
  weight_kg: null as number | null,
  pace_zone: null as string | null,
  hr_zone: null as string | null,
  rest_seconds: null as number | null,
  notes: "",
  muscle: null as string | null,
  category: null as string | null,
  compound: null as boolean | null,
};

// Optional model metadata must not erase an otherwise valid exercise. Accept
// unambiguous JSON boolean encodings, but surface malformed objects for repair.
const optionalDoseNumber = (schema: z.ZodNumber) => z.preprocess(v => v === null ? undefined : v, schema.optional());
const doseBoolean = z.preprocess(v => {
  if (v === null) return undefined;
  if (v === 0 || v === "0" || v === "false") return false;
  if (v === 1 || v === "1" || v === "true") return true;
  return v;
}, z.boolean().optional());
const DoseSchema = z.object({
  work_seconds: optionalDoseNumber(z.number().finite().positive()),
  distance_m: optionalDoseNumber(z.number().finite().positive()),
  stroke: z.preprocess(v => v === null ? undefined : v, z.string().optional()),
  recovery_after_last: doseBoolean,
  transition_seconds: optionalDoseNumber(z.number().finite().min(0)),
}).nullish().transform(v => v ?? undefined);
const ExerciseObjectSchema = z.object({
  dose: DoseSchema,
  name: str("Exercise"),
  sets: num(1),
  reps: z.unknown().transform((v) => (v == null ? "" : String(v))),
  weight_kg: z.unknown().transform((v) => (typeof v === "number" ? v : null)),
  pace_zone: z.unknown().transform((v) => (typeof v === "string" ? v : null)),
  hr_zone: z.unknown().transform((v) => (typeof v === "string" ? v : null)),
  rest_seconds: z.unknown().transform((v) => (typeof v === "number" ? v : null)),
  notes: str(""),
  // Metadata the model supplies only for exercises NOT in the bundled catalog —
  // used to auto-register them as the athlete's custom exercises.
  muscle: z.unknown().transform((v) => (typeof v === "string" ? v : null)),
  category: z.unknown().transform((v) => (typeof v === "string" ? v : null)),
  compound: z.unknown().transform((v) => (typeof v === "boolean" ? v : null)),
});
const objectOr = (value: unknown, fallback: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const ExerciseSchema = z.preprocess(v => objectOr(v, DEFAULT_EXERCISE), ExerciseObjectSchema);

const SectionObjectSchema = z.object({
  name: str("Block"),
  duration_minutes: num(0),
  exercises: z.array(ExerciseSchema),
});
const SectionSchema = z.preprocess(v => objectOr(v, { name: "Block", duration_minutes: 0, exercises: [] }), SectionObjectSchema);

const WorkoutSchema = z
  .object({
    prescription: PrescriptionSchema.optional(),
    type: z.enum(["run", "ride", "swim", "strength", "rest"]),
    title: z.string(),
    duration_minutes: num(0).transform((v) => Math.max(0, v)),
    tss_estimate: clampNum(0, 400),
    rpe_target: clampNum(0, 10),
    coach_note: str(""),
    sections: z.array(SectionSchema, { invalid_type_error: "sections must be an array" }),
  })
  .superRefine((w, ctx) => {
    // A rest day needs no sections; everything else should have at least one.
    if (w.type !== "rest" && w.sections.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "workout has no sections" });
    }
  })
  .transform((w): Workout => {
    const isRun = w.type === "run" || w.type === "ride" || w.type === "swim"; // endurance modalities
    return {
      ...w,
      title: w.title.trim() || (w.type === "rest" ? "Rest day" : "Workout"),
      sections: w.sections.map((sec) => ({
        ...sec,
        exercises: sec.exercises.map((ex) => ({
          ...ex,
          weight_kg: isRun ? null : ex.weight_kg,
          pace_zone: isRun ? ex.pace_zone : null,
          hr_zone: isRun ? ex.hr_zone : null,
        })),
      })),
    };
  });

export function validateWorkout(obj: unknown): { ok: boolean; workout?: Workout; error?: string } {
  const r = WorkoutSchema.safeParse(obj);
  if (!r.success) {
    const error = r.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    return { ok: false, error };
  }
  return { ok: true, workout: r.data };
}

export interface WeekDay { date: string; weekday: string; session: Workout }
export interface WeekPlan { week_focus: string; rationale: string; days: WeekDay[] }

const WeekPlanSchema = z
  .object({
    week_focus: str("General"),
    rationale: str(""),
    days: z.array(z.object({
      date: str(""),
      weekday: str(""),
      session: z.unknown(),
    })).min(1, "missing days[]"),
  })
  .superRefine((o, ctx) => {
    const seen = new Set<string>();
    o.days.forEach((d, index) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !Number.isFinite(Date.parse(d.date)) ||
          new Date(d.date).toISOString().slice(0, 10) !== d.date || seen.has(d.date)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["days", index, "date"], message: "Invalid or duplicate date" });
      }
      seen.add(d.date);
      const v = validateWorkout(d.session);
      if (!v.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["days", index, "session"], message: v.error ?? "Invalid session" });
    });
  })
  .transform((o): WeekPlan => ({
    week_focus: o.week_focus,
    rationale: o.rationale,
    days: o.days
      .filter((d) => d.date)
      .map((d) => {
        // Refinement above rejects the entire plan before any storage change.
        const v = validateWorkout(d.session);
        return { date: d.date, weekday: d.weekday, session: v.workout! };
      }),
  }));

export function validateWeekPlan(obj: unknown): { ok: boolean; plan?: WeekPlan; error?: string } {
  const r = WeekPlanSchema.safeParse(obj);
  if (!r.success) {
    const error = r.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    return { ok: false, error };
  }
  if (r.data.days.length === 0) return { ok: false, error: "no valid days" };
  return { ok: true, plan: r.data };
}
