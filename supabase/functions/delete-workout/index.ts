import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
// delete-workout — delete a planned workout and remove its Intervals.icu
// calendar event (so it also disappears from the connected watch).
//
// POST { workout_id }

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const { workout_id } = await req.json().catch(() => ({}));
    if (!workout_id) return json({ error: "workout_id required" }, 400);

    const admin = adminClient();
    const { data: planned } = await admin
      .from("reconciled_session_plans")
      .select("id, intervals_event_id")
      .eq("id", workout_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!planned) return json({ error: "workout not found" }, 404);

    const { error } = await admin
      .from("planned_workouts")
      .delete()
      .eq("id", workout_id)
      .eq("user_id", userId);
    if (error) return json({ error: error.message }, 500);

    const sync = await drainCalendarOutbox(admin, userId);
    return json({ ok: true, sync_error: sync.error });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
