import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { reviewWorkout, type ReviewContext } from "./workout_review.ts";
import { validateWorkout } from "./workout_schema.ts";
import type { Workout } from "./types.ts";

export const ENGINE_VERSION = "engine-2026-10-22.1";
export class PlanError extends Error {
  constructor(message: string, public status = 422, public code = "INVALID_PLAN") { super(message); }
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
  const parsed = validateWorkout(w);
  if (!parsed.ok) throw new PlanError(parsed.error ?? "Invalid workout shape");
  if (w.type !== "rest" && (!w.sections.some(s => s.exercises.length) || w.duration_minutes <= 0))
    throw new PlanError("No compatible session could be generated. Your existing plan was kept.",422,"EMPTY_SESSION");
  const review = reviewGeneratedWorkout(w, context);
  if (review.unsafe.length || JSON.stringify(review.corrected.sections) !== JSON.stringify(w.sections))
    throw new PlanError("The session still violates content constraints. Your existing plan was kept.",422,"CONTENT_CONSTRAINT");
}
export async function planRevision(admin: SupabaseClient, owner: string): Promise<number> {
  const { data, error } = await admin.rpc("plan_revision", { p_owner: owner });
  if (error) throw new Error(error.message);
  return Number(data);
}
export interface PlanRow { date: string; type: string; workout_json: Workout; llm_provider?: string; llm_model?: string; locked?: boolean; sync_requested?: boolean }
export async function replacePlan(admin: SupabaseClient, owner: string, id: string, scope: unknown,
  revision: number, from: string, to: string, rows: PlanRow[], week: unknown = null): Promise<Array<PlanRow & { id: string }>> {
  const { data, error } = await admin.rpc("replace_generated_plan", { p_owner: owner, p_request: id,
    p_scope: scope, p_revision: revision, p_from: from, p_to: to, p_rows: rows, p_week: week });
  if (error) throw new PlanError(error.message, error.code === "40001" ? 409 : 422,
    error.code === "40001" ? "PLAN_CONFLICT" : "SAVE_REJECTED");
  return data.rows;
}
