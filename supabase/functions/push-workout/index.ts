import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
// push-workout — push an already-planned workout to the Intervals.icu calendar.
//
// POST { workout_id }

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, decryptSecret, getUserId } from "../_shared/supabase.ts";
import { createEvent } from "../_shared/intervals.ts";
import { renderIntervalsWorkout } from "../_shared/intervals_workout.ts";
import type { Workout } from "../_shared/types.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const { workout_id } = await req.json();
    if (!workout_id) return json({ error: "workout_id required" }, 400);

    const admin = adminClient();
    const { data: planned } = await admin
      .from("planned_workouts")
      .select("*")
      .eq("id", workout_id)
      .eq("user_id", userId)
      .single();
    if (!planned) return json({ error: "workout not found" }, 404);

    const { error } = await admin.from("planned_workouts").update({ sync_requested: true })
      .eq("id", workout_id).eq("user_id", userId);
    if (error) throw new Error(error.message);
    const sync = await drainCalendarOutbox(admin, userId);
    return json({ ok: !sync.error, intervals_event_id: sync.events[workout_id] ?? planned.intervals_event_id,
      sync_pending: !!sync.error, error: sync.error });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
