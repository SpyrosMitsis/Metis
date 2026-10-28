import { openWaterIssue } from "./open_water.ts";
import { assertDaySlots, slotKey, sessionWindows } from "./session_slots.ts";
import { dailyMinutes } from "./session_context.ts";
import { assertPrescriptionProjection } from "./prescription.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { reviewWorkout, type ReviewContext } from "./workout_review.ts";
import { validateWorkout } from "./workout_schema.ts";
import type { Workout } from "./types.ts";

export const ENGINE_VERSION = "engine-2026-10-27.2";
export class PlanError extends Error {
  constructor(message: string, public status = 422, public code = "INVALID_PLAN", public details?: unknown) { super(message); }
}
export function requestId(value: unknown): string {
  if (value == null) return crypto.randomUUID();
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new PlanError("Invalid request_id", 400, "INVALID_REQUEST_ID");
  return value;
}
export function isoDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value)
    throw new PlanError("A valid local date is required",400,"INVALID_DATE");
  return value;
}
/** Generation always enforces the catalog; no caller flag can disable it. */
export function reviewGeneratedWorkout(w: Workout, context: ReviewContext) {
  return reviewWorkout(w, { ...context, catalogOnly: true });
}
/** Final gate, shared by daily, weekly and chat-adjusted generation. Failures
 * retain the old plan. No invented recovery day masks a provider failure. */
export function assertPublishable(w: Workout, context: ReviewContext): void {
  if (!w.prescription) throw new PlanError("New prescriptions require a compiled executable dose", 422, "DOSE_REQUIRED");
  try { assertPrescriptionProjection(w); } catch (error) { throw new PlanError(String(error), 422, "PRESCRIPTION_MISMATCH"); }
  if (context.maxMinutes != null && w.duration_minutes > context.maxMinutes) throw new PlanError("Session exceeds available time", 422, "TIME_BUDGET");
  const p = w.prescription;
  if (p?.sport === "swim" && p.venue === "open_water" && (openWaterIssue(p.open_water_checks, p.scheduled_date ?? "") || p.duration_seconds > (p.open_water_checks?.max_minutes ?? 0) * 60)) throw new PlanError("Open-water venue checks are missing or dose exceeds the confirmed limit", 422, "VENUE_UNSUPPORTED");
  if (p?.sport === "run" && p.venue === "treadmill" && !context.implements?.includes("treadmill")) throw new PlanError("Treadmill availability is unconfirmed", 422, "VENUE_EQUIPMENT");
  if (p?.sport === "ride" && p.venue === "indoor" && !context.implements?.some(i => i === "indoor_trainer" || i === "stationary_bike")) throw new PlanError("Indoor cycling equipment is unconfirmed", 422, "VENUE_EQUIPMENT");
  const parsed = validateWorkout(w);
  if (!parsed.ok) throw new PlanError(parsed.error ?? "Invalid workout shape", 422, "INVALID_WORKOUT", { schema_error: parsed.error });
  if (w.type !== "rest" && (!w.sections.some(s => s.exercises.length) || w.duration_minutes <= 0))
    throw new PlanError("No compatible session could be generated. Your existing plan was kept.",422,"EMPTY_SESSION");
  const review = reviewGeneratedWorkout(w, context);
  if (review.unsafe.length || review.issues.length || JSON.stringify(review.corrected) !== JSON.stringify(w))
    throw new PlanError("The session still violates content constraints. Your existing plan was kept.",422,"CONTENT_CONSTRAINT",
      { issues: review.issues, unsafe: review.unsafe, corrections_required: JSON.stringify(review.corrected) !== JSON.stringify(w) });
}
export async function planRevision(admin: SupabaseClient, owner: string): Promise<number> {
  const { data, error } = await admin.rpc("plan_revision", { p_owner: owner });
  if (error) throw new Error(error.message);
  return Number(data);
}
export interface PlanRow { transition_before_seconds?: number; skipped?: boolean; session_slot?: number; start_minute?: number | null; combined_group?: string | null; date: string; type: string; workout_json: Workout; llm_provider?: string; llm_model?: string; locked?: boolean; sync_requested?: boolean }
export async function replacePlan(admin: SupabaseClient, owner: string, id: string, scope: unknown,
  revision: number, from: string, to: string, rows: PlanRow[], week: unknown = null, metadata: Record<string,unknown> = {}, replace = true): Promise<Record<string,unknown>> {
  await assertTimeBudgets(admin, owner, rows, replace);
  const { data, error } = await admin.rpc("replace_generated_plan", { p_owner: owner, p_request: id,
    p_scope: scope, p_revision: revision, p_from: from, p_to: to, p_rows: rows, p_week: week, p_metadata: { ...metadata, engine_version: ENGINE_VERSION }, p_replace: replace });
  if (error) throw new PlanError(error.message, error.code === "40001" ? 409 : 422,
    error.code === "40001" ? "PLAN_CONFLICT" : "SAVE_REJECTED");
  return data as Record<string,unknown>;
}

export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableValue(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Avoid paying for generation again when an HTTP retry repeats a request. */
export async function savedRequest(admin: SupabaseClient, owner: string, id: string, scope: unknown) {
  const { data, error } = await admin.from("plan_requests").select("request_scope,result")
    .eq("user_id",owner).eq("request_id",id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  if (stableValue(data.request_scope) !== stableValue(scope)) throw new PlanError("Request id was already used for different input; start a new request.",409,"IDEMPOTENCY_CONFLICT");
  return data.result as Record<string,unknown>;
}

/** Read under the caller's plan revision; the atomic replacement rejects any
 * intervening plan change, including changes elsewhere in this week. */
export async function assertTimeBudgets(admin: SupabaseClient, owner: string, rows: PlanRow[], replace: boolean, excludedId?: string) {
  const { data: profile, error } = await admin.from("user_profiles").select("onboarding").eq("id", owner).single();
  if (error || !profile) throw new PlanError("Cannot validate availability", 422, "AVAILABILITY_UNAVAILABLE");
  const o = profile.onboarding ?? {};
  const {data: holds,error: holdError}=await admin.from("training_holds").select("sport,start_date,until_date").eq("user_id",owner).eq("active",true);
  if(holdError) throw new PlanError("Cannot validate active training holds");
  if(rows.some(r=>r.type!=="rest"&&(holds??[]).some(h=>h.start_date<=r.date&&(!h.until_date||h.until_date>=r.date)&&(!h.sport||h.sport===r.type)))) throw new PlanError("Affected training is on hold. Review and clear the hold before resuming.",422,"TRAINING_HOLD");
  for (const row of rows) {
    const start = sessionWindows(o, row.date).find(w => w.slot === (row.session_slot ?? 0))?.start_minute;
    if (row.start_minute == null && start != null) row.start_minute = start;
    if (row.workout_json.prescription?.scheduled_date !== row.date) throw new PlanError("Prescription date does not match its calendar slot", 422, "DATE_MISMATCH");
  }
  const weekStart = (date: string) => {
    const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10);
  };
  const replacing = new Set(rows.map(r => slotKey(r.date, r.session_slot)));
  const weeks = [...new Set(rows.map(r => weekStart(r.date)))];
  for (const start of weeks) {
    const end = new Date(Date.parse(start) + 6 * 86400000).toISOString().slice(0, 10);
    const { data: existing, error: readError } = await admin.from("reconciled_session_plans").select("id,date,session_slot,start_minute,combined_group,transition_before_seconds,workout_json,skipped")
      .eq("user_id", owner).gte("date", start).lte("date", end);
    if (readError) throw new PlanError("Cannot validate availability", 422, "AVAILABILITY_UNAVAILABLE");
    const kept = (existing ?? []).filter(r => r.id !== excludedId && (!replace || !replacing.has(slotKey(r.date, r.session_slot))));
    const combined = [...kept, ...rows.filter(r => weekStart(r.date) === start)];
    for (const date of new Set(rows.filter(r => weekStart(r.date) === start).map(r => r.date))) {
      try { assertDaySlots(o, date, combined); } catch (error) { throw new PlanError(String(error), 422, "SESSION_AVAILABILITY"); }
      const cap = dailyMinutes(o, date);
      const total = combined.filter(r => r.date === date && !r.skipped).reduce((sum, r) => sum + Number(r.workout_json?.duration_minutes ?? 0) + Number(r.transition_before_seconds ?? 0) / 60, 0);
      if (!Number.isFinite(total) || cap !== null && total > cap + 1e-6) throw new PlanError(`${date}: combined dose exceeds daily availability`, 422, "TIME_BUDGET");
    }
    const weekly = o.weekly_minutes_max;
    const total = combined.filter(r => !r.skipped).reduce((sum, r) => sum + Number(r.workout_json?.duration_minutes ?? 0) + Number(r.transition_before_seconds ?? 0) / 60, 0);
    if (!Number.isFinite(total) || typeof weekly === "number" && total > weekly + 1e-6) throw new PlanError(`Week ${start} exceeds its time budget`, 422, "WEEKLY_TIME_BUDGET");
  }
}
