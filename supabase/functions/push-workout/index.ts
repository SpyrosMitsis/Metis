// Queue a retryable calendar upsert for an already planned session.
import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";

Deno.serve(async req => {
  const pre = handleOptions(req); if (pre) return pre;
  try {
    const owner = await getUserId(req); if (!owner) return json({ error: "unauthorized" }, 401);
    const { workout_id } = await req.json();
    if (typeof workout_id !== "string" || !workout_id) return json({ error: "workout_id required" }, 400);
    const admin = adminClient();
    const { error } = await admin.rpc("request_calendar_sync", { p_owner: owner, p_planned: workout_id });
    if (error) return json({ error: error.message }, error.code === "P0002" ? 404 : 500);
    const sync = await drainCalendarOutbox(admin, owner);
    return json({ ok: !sync.error, intervals_event_id: sync.events[workout_id] ?? null,
      sync_pending: !!sync.error, error: sync.error });
  } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
});
