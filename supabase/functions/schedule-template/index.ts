import { slotKey } from "../_shared/session_slots.ts";
import { compileProposal } from "../_shared/proposal_compiler.ts";
import { sessionState, withForecast } from "../_shared/session_context.ts";
import { loadReviewContext, constrainSession } from "../_shared/review_context.ts";
// Expand a saved workout template into dated sessions. Template application
// is additive and atomic: any occupied date rejects the complete request.
import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { validateWorkout } from "../_shared/prompt.ts";
import { assertPublishable, ENGINE_VERSION, isoDate, PlanError, planRevision, replacePlan, requestId, reviewGeneratedWorkout, savedRequest } from "../_shared/plan_store.ts";
import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
import type { Workout } from "../_shared/types.ts";

const DAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const addDays = (date: string, amount: number) => {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10);
};
function monday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  return addDays(date, -offset);
}

Deno.serve(async req => {
  const pre = handleOptions(req); if (pre) return pre;
  try {
    const userId = await getUserId(req); if (!userId) return json({ error: "unauthorized" }, 401);
    const body = await req.json();
    if (typeof body.template_id !== "string" || !body.template_id) return json({ error: "template_id required" }, 400);
    const start = isoDate(body.start_date ?? new Date().toISOString().slice(0, 10));
    const id = requestId(body.request_id);
    const push = body.push === true;
    const admin = adminClient();
    const { data: template, error: templateError } = await admin.from("workout_templates").select("id,name,structure")
      .eq("id", body.template_id).eq("user_id", userId).single();
    if (templateError || !template) return json({ error: "template not found" }, 404);
    const canonicalTemplate = JSON.stringify(template.structure);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalTemplate));
    const templateVersion = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    const scope = { template_id: body.template_id, template_version: templateVersion, start_date: start, push };
    const replay = await savedRequest(admin, userId, id, scope);
    if (replay) {
      const sync = await drainCalendarOutbox(admin, userId);
      return json({ ...(replay.response as Record<string, unknown>), pushed: Object.keys(sync.events).length,
        replayed: true, sync_error: sync.error });
    }
    const revision = await planRevision(admin, userId);
    const structure = template.structure as Record<string, unknown>;
    const items: { date: string; session_slot: number; workout: Workout }[] = [];
    const invalid: string[] = [];
    const weeks = structure && Array.isArray(structure.weeks) ? structure.weeks as { days?: { day?: string; session_slot?: number; workout?: unknown }[] }[] : null;
    if (weeks) {
      const base = monday(start);
      weeks.forEach((week, wi) => (week.days ?? []).forEach(day => {
        const index = DAY_INDEX[day.day ?? ""];
        if (index == null) { invalid.push(`Unknown template weekday: ${day.day ?? "(missing)"}`); return; }
        const date = addDays(base, wi * 7 + index);
        if (date < start) return;
        const parsed = validateWorkout(day.workout);
        if (parsed.ok && parsed.workout) items.push({ date, session_slot: day.session_slot ?? 0, workout: parsed.workout });
        else invalid.push(`${date}: ${parsed.error ?? "invalid workout"}`);
      }));
    } else {
      const parsed = validateWorkout(structure);
      if (parsed.ok && parsed.workout) items.push({ date: start, session_slot: 0, workout: parsed.workout });
      else invalid.push(parsed.error ?? "invalid workout");
    }
    if (invalid.length) return json({ error: "template contains invalid sessions", details: invalid }, 422);
    if (!items.length) return json({ error: "template produced no schedulable workouts" }, 422);
    if (new Set(items.map(item => slotKey(item.date, item.session_slot))).size !== items.length) return json({ error: "template has duplicate session slots" }, 422);

    const { data: athlete, error: athleteError } = await admin.from("user_profiles").select("onboarding,injury_backoff,training_paused_until,last_lat,last_lon").eq("id", userId).single();
    if (athleteError || !athlete) throw new PlanError("Cannot read athlete constraints", 422, "PROFILE_UNAVAILABLE");
    for (const item of items) {
      if (athlete.training_paused_until && item.date <= athlete.training_paused_until && item.workout.type !== "rest")
        throw new PlanError("Template conflicts with the training pause", 422, "TRAINING_PAUSED");
      const context = await loadReviewContext(admin, userId, item.date, item.workout.type, athlete);
      item.workout = compileProposal(item.workout, constrainSession(await withForecast(await sessionState(admin, userId, athlete.onboarding ?? {}, item.date, item.workout.type, undefined, item.session_slot), athlete), context));
      const reviewed = reviewGeneratedWorkout(item.workout, context);
      assertPublishable(reviewed.corrected, context);
      item.workout = reviewed.corrected;
    }
    const rows = items.map(item => ({ user_id: userId, date: item.date, session_slot: item.session_slot, type: item.workout.type,
      workout_json: item.workout, llm_provider: "template", llm_model: template.name, sync_requested: push }));
    const from = items.map(x => x.date).sort()[0], to = items.map(x => x.date).sort().at(-1)!;
    const response = { scheduled: rows.length, pushed: 0, start_date: start };
    await replacePlan(admin, userId, id, scope, revision, from, to, rows, null,
      { response, engine_version: ENGINE_VERSION, template_version: templateVersion }, false);
    const sync = await drainCalendarOutbox(admin, userId);
    return json({ ...response, pushed: Object.keys(sync.events).length, sync_error: sync.error });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const status = /occupied|protected session|plan changed|request id was already used/i.test(error) ? 409 : 422;
    return json({ error, ...(e instanceof PlanError ? { code: e.code, details: e.details } : {}) }, status);
  }
});
