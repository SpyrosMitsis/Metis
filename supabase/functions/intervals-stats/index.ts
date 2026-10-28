// intervals-stats — live fitness dashboard data pulled from Intervals.icu for
// the signed-in user: the CTL/ATL/TSB fitness curve, current HR zones, and a
// list of recent activities. Runs server-side with the user's decrypted key.
//
// Returns { connected:false } when the user hasn't linked Intervals yet, so the
// app can hide the section gracefully.

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, decryptSecret, getUserId } from "../_shared/supabase.ts";
import {
  getActivities,
  getAthleteFull,
  getWellness,
  latestFitness,
  runHrZones,
} from "../_shared/intervals.ts";

const round1 = (n: number) => Math.round(n * 10) / 10;

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const admin = adminClient();
    const { data: profile } = await admin
      .from("user_profiles")
      .select("intervals_athlete_id, intervals_api_key_encrypted")
      .eq("id", userId)
      .single();

    if (!profile?.intervals_athlete_id || !profile?.intervals_api_key_encrypted) {
      return json({ connected: false });
    }

    const apiKey = await decryptSecret(admin, profile.intervals_api_key_encrypted);
    if (!apiKey) return json({ connected: false, error: "failed to decrypt key" });
    const athleteId = profile.intervals_athlete_id;

    const [wellness, activities, athlete] = await Promise.all([
      getWellness(athleteId, apiKey, 90),
      getActivities(athleteId, apiKey, 42),
      getAthleteFull(athleteId, apiKey),
    ]);

    const fitness = wellness
      .filter((w) => typeof w.ctl === "number")
      .map((w) => ({
        date: w.id,
        ctl: round1(w.ctl ?? 0),
        atl: round1(w.atl ?? 0),
        tsb: round1((w.ctl ?? 0) - (w.atl ?? 0)),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const latest = latestFitness(wellness);
    // 7-day CTL ramp (positive = building fitness).
    const last = fitness[fitness.length - 1]?.ctl ?? latest.ctl;
    const weekAgo = fitness[fitness.length - 8]?.ctl ?? last;
    const ramp = round1(last - weekAgo);

    const recent = [...activities]
      .sort((a, b) => ((a.start_date_local ?? "") < (b.start_date_local ?? "") ? 1 : -1))
      .slice(0, 15)
      .map((a) => ({
        date: a.start_date_local?.slice(0, 10) ?? "",
        name: a.name ?? a.type ?? "Activity",
        type: a.type ?? "",
        distance_km: a.distance ? round1(a.distance / 1000) : null,
        intervals_id: a.id != null ? String(a.id) : null,
        duration_min: a.moving_time ? Math.round(a.moving_time / 60) : null,
        tss: a.icu_training_load ?? null,
        avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      }));

    return json({
      connected: true,
      athlete_name: athlete.name ?? null,
      summary: {
        ctl: round1(latest.ctl),
        atl: round1(latest.atl),
        tsb: round1(latest.tsb),
        ramp,
      },
      fitness,
      hr_zones: runHrZones(athlete),
      activities: recent,
    });
  } catch (e) {
    // Surface the error but keep connected:true so the UI shows a retry hint.
    return json({ connected: true, error: e instanceof Error ? e.message : String(e) }, 200);
  }
});
