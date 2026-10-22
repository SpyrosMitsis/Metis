import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decryptSecret } from "./supabase.ts";
import { renderIntervalsWorkout } from "./intervals_workout.ts";
import type { Workout } from "./types.ts";

/** Retryable calendar delivery. Jobs commit with the plan; provider failure
 * never rolls back or destroys the athlete's saved plan. */
export async function drainCalendarOutbox(admin: SupabaseClient, owner: string) {
  const events: Record<string,string> = {};
  let error: string | null = null;
  try {
    const { data: profile } = await admin.from("user_profiles")
      .select("intervals_athlete_id, intervals_api_key_encrypted").eq("id", owner).single();
    if (!profile?.intervals_athlete_id || !profile?.intervals_api_key_encrypted) return { events, error: "Calendar sync pending: connect Intervals.icu." };
    const key = await decryptSecret(admin, profile.intervals_api_key_encrypted);
    if (!key) return { events, error: "Calendar sync pending: credentials unavailable." };
    const base = `https://intervals.icu/api/v1/athlete/${encodeURIComponent(profile.intervals_athlete_id)}/events`;
    const call = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
      const response = await fetch(base + path, { method, signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Basic ${btoa(`API_KEY:${key}`)}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (method === "DELETE" && response.status === 404) return null;
      if (!response.ok) throw new Error(`Calendar ${method} failed (${response.status})`);
      return response.status === 204 ? null : await response.json();
    };
    for (let i = 0; i < 8; i++) {
      const { data: job, error: claimError } = await admin.rpc("claim_calendar_job", { p_owner: owner });
      if (claimError) throw new Error(claimError.message);
      if (!job) break;
      let failure: string | null = null;
      try {
        const { data: current, error: readError } = await admin.from("planned_workouts").select("*")
          .eq("id", job.planned_id).eq("user_id", owner).maybeSingle();
        if (readError) throw new Error(readError.message);
        const removing = job.operation === "delete" || !current || current.skipped || current.type === "rest";
        const row = removing ? job.payload : current;
        const externalId = `workout-maker:${job.planned_id}`;
        let eventId = current?.intervals_event_id ?? job.event_id;
        if (!eventId) {
          // API-key users cannot assume OAuth-only upsert semantics. Look up
          // our stable identity before retrying an ambiguous create timeout.
          const end = new Date(row.date + "T12:00:00Z"); end.setUTCDate(end.getUTCDate()+1);
          const existing = await call(`?oldest=${row.date}&newest=${end.toISOString().slice(0,10)}`) as Array<{id: string|number;external_id?:string}>;
          eventId = existing.find(e => e.external_id === externalId)?.id;
        }
        if (removing) {
          if (eventId) await call(`/${encodeURIComponent(eventId)}`, "DELETE");
        } else {
          const workout = row.workout_json as Workout;
          const payload = { external_id: externalId, category: "WORKOUT", start_date_local: `${row.date}T00:00:00`,
            name: workout.title, description: renderIntervalsWorkout(workout),
            type: ({ run: "Run", ride: "Ride", swim: "Swim", strength: "WeightTraining" } as Record<string,string>)[workout.type] ?? "Workout" };
          if (eventId) await call(`/${encodeURIComponent(eventId)}`, "PUT", payload);
          else {
            const created = await call("", "POST", payload) as { id?: string|number };
            if (!created?.id) throw new Error("Calendar returned no event identity");
            eventId = created.id;
          }
          const { error: saveError } = await admin.from("planned_workouts")
            .update({ intervals_event_id: String(eventId), pushed_at: new Date().toISOString() })
            .eq("id", job.planned_id).eq("user_id",owner);
          if (saveError) throw new Error(saveError.message);
          events[job.planned_id] = String(eventId);
        }
      } catch (e) { failure = e instanceof Error ? e.message : String(e); }
      const { error: finishError } = await admin.rpc("finish_calendar_job", { p_owner: owner,
        p_id: job.id, p_token: job.lease_token, p_error: failure });
      if (finishError) throw new Error(finishError.message);
      if (failure) { error = failure; break; }
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  return { events, error };
}
