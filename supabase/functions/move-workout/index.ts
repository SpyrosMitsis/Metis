import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
import { isoDate, planRevision, assertTimeBudgets, assertPublishable, requestId, savedRequest, PlanError } from "../_shared/plan_store.ts";
import { compileProposal } from "../_shared/proposal_compiler.ts";
import { sessionState, withForecast } from "../_shared/session_context.ts";
import { sessionWindows } from "../_shared/session_slots.ts";
import { loadReviewContext, constrainSession } from "../_shared/review_context.ts";
import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";

Deno.serve(async req => {
  const pre = handleOptions(req); if (pre) return pre;
  try {
    const userId = await getUserId(req); if (!userId) return json({ error: "unauthorized" }, 401);
    const body = await req.json();
    const date = isoDate(body.new_date), requestedSlot = body.session_slot;
    if (typeof body.workout_id !== "string" || requestedSlot != null && ![0, 1].includes(requestedSlot)) return json({ error: "workout_id and a valid session_slot are required" }, 400);
    const admin = adminClient(), id = requestId(body.request_id);
    const scope = { action: "move", workout_id: body.workout_id, date, slot: requestedSlot ?? null };
    const replay = await savedRequest(admin, userId, id, scope);
    if (replay) return json({ ok: true, replayed: true, ...replay });
    const revision = await planRevision(admin, userId);
    const { data: planned, error } = await admin.from("reconciled_session_plans").select("*").eq("id", body.workout_id).eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!planned) return json({ error: "workout not found" }, 404);
    if (planned.completed || planned.skipped || planned.combined_group) throw new PlanError("Completed, skipped or combined sessions cannot be moved individually");
    const { data: profile, error: profileError } = await admin.from("user_profiles").select("onboarding,injury_backoff,training_paused_until,last_lat,last_lon").eq("id", userId).single();
    if (profileError || !profile) throw new PlanError("Athlete constraints unavailable");
    if (profile.training_paused_until && date <= profile.training_paused_until && planned.type !== "rest") throw new PlanError("The destination is inside your training pause");
    const slot = requestedSlot ?? planned.session_slot ?? 0;
    const o = profile.onboarding ?? {};
    const state = await sessionState(admin, userId, o, date, planned.type, undefined, slot);
    const context = await loadReviewContext(admin, userId, date, planned.type, profile);
    const workout = compileProposal(planned.workout_json, constrainSession(await withForecast(state, profile), context));
    assertPublishable(workout, context);
    const row = { date, session_slot: slot, start_minute: sessionWindows(o, date).find(w => w.slot === slot)?.start_minute ?? null, type: workout.type, workout_json: workout };
    await assertTimeBudgets(admin, userId, [row], false, planned.id);
    const { data, error: moveError } = await admin.rpc("move_planned_session", { p_owner: userId, p_id: planned.id, p_revision: revision, p_date: date, p_slot: slot, p_start: row.start_minute, p_workout: workout, p_request: id, p_scope: scope });
    if (moveError) throw new PlanError(moveError.message, moveError.code === "40001" ? 409 : 422);
    const sync = await drainCalendarOutbox(admin, userId);
    return json({ ok: true, ...data, old_date: planned.date, new_date: date, event_moved: !!sync.events[planned.id], event_error: sync.error });
  } catch (e) { return json({ error: String(e) }, e instanceof PlanError ? e.status : 422); }
});
