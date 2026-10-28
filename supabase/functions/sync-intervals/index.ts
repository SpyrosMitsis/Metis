import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
// sync-intervals — pull + cache activities and CTL/ATL/TSB from Intervals.icu.
//
// Two modes:
//   - Client call (Authorization: user JWT)       → sync that one user.
//   - Cron call  (Authorization: service_role; body { all_users: true }) →
//     iterate every user with Intervals credentials.

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, decryptSecret, getUserId } from "../_shared/supabase.ts";
import {
  getActivities,
  getWellness,
  latestFitness,
} from "../_shared/intervals.ts";
import { autoAnalyzeRecent } from "../_shared/analyze_core.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Keep the worker alive for post-response work (auto-analysis) without
// delaying the sync response.
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;
function waitUntil(p: Promise<unknown>) {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(p);
      return;
    }
  } catch (_e) { /* fall through */ }
  p.catch(() => {});
}

interface SyncResult {
  user_id: string;
  activities_synced: number;
  ctl: number;
  atl: number;
  tsb: number;
}

async function syncUser(admin: SupabaseClient, userId: string): Promise<SyncResult> {
  await admin.from("activity_sync_state").upsert({ user_id: userId, source: "intervals", last_attempt_at: new Date().toISOString(), last_error: null }, { onConflict: "user_id,source" });
  try {
    const result = await syncUserData(admin,userId);
    await admin.from("activity_sync_state").upsert({ user_id:userId, source:"intervals", last_success_at:new Date().toISOString(),
      coverage_from:new Date(Date.now()-60*86400000).toISOString().slice(0,10),coverage_to:new Date().toISOString().slice(0,10),last_error:null },{onConflict:"user_id,source"});
    await drainCalendarOutbox(admin,userId);
    return result;
  } catch(e) {
    await admin.from("activity_sync_state").upsert({user_id:userId,source:"intervals",last_error:e instanceof Error ? e.message : String(e)},{onConflict:"user_id,source"});
    throw e;
  }
}
async function syncUserData(admin: SupabaseClient, userId: string): Promise<SyncResult> {
  const { data: profile, error } = await admin
    .from("user_profiles")
    .select("intervals_athlete_id, intervals_api_key_encrypted")
    .eq("id", userId)
    .single();
  if (error || !profile?.intervals_athlete_id || !profile?.intervals_api_key_encrypted) {
    throw new Error("user has no Intervals.icu credentials");
  }

  const apiKey = await decryptSecret(admin, profile.intervals_api_key_encrypted);
  if (!apiKey) throw new Error("failed to decrypt Intervals key");
  const athleteId = profile.intervals_athlete_id;

  const [activities, wellness] = await Promise.all([
    getActivities(athleteId, apiKey, 60),
    getWellness(athleteId, apiKey, 60),
  ]);

  const rows = activities.map((a) => ({
    user_id: userId,
    intervals_id: a.id,
    source: "intervals",
    source_id: a.id,
    start_local_date: a.start_date_local?.slice(0,10) ?? null,
    timezone_provenance: a.start_date_local ? "provider_local_date" : "unavailable",
    type: a.type ?? null,
    date: a.start_date_local?.slice(0, 10) ?? null,
    duration_seconds: a.moving_time ?? null,
    distance_m: a.distance ?? null,
    avg_hr: a.average_heartrate != null ? Math.round(a.average_heartrate) : null,
    tss: a.icu_training_load ?? null,
    measurement_provenance: { duration_seconds: a.moving_time == null ? "unavailable" : "observed", distance_m: a.distance == null ? "unavailable" : "observed", avg_hr: a.average_heartrate == null ? "unavailable" : "observed", tss: a.icu_training_load == null ? "unavailable" : "provider_reported" },
    ctl: a.icu_ctl ?? null,
    atl: a.icu_atl ?? null,
    data_json: a,
  }));

  if (rows.length) {
    const { error: upErr } = await admin
      .from("completed_activities")
      .upsert(rows, { onConflict: "user_id,intervals_id" });
    if (upErr) throw new Error(`cache upsert: ${upErr.message}`);
  }

  // Mirror Intervals' OBJECTIVE daily metrics into wellness_checkins so the
  // dashboard + recovery model read everything from one table. We only write
  // objective columns, so the user's subjective energy/soreness check-in is
  // left untouched (PostgREST upsert updates only the columns present per row).
  // Everything is sourced from objective device data — no subjective sleep
  // rating. The raw 0..100 sleep score is mirrored as-is; recovery turns it
  // into its 1..5 sleep contribution at full resolution.
  const wellnessRows = wellness
    .map((w) => {
      const row: Record<string, unknown> = { user_id: userId, date: w.id };
      let has = false;
      if (typeof w.sleepSecs === "number") { row.zepp_sleep_minutes = Math.round(w.sleepSecs / 60); has = true; }
      if (typeof w.sleepScore === "number") { row.sleep_score = Math.round(w.sleepScore); has = true; }
      if (typeof w.hrv === "number") { row.hrv_rmssd = w.hrv; has = true; }
      if (typeof w.restingHR === "number") { row.resting_hr = Math.round(w.restingHR); has = true; }
      if (typeof w.vo2max === "number") { row.vo2max = w.vo2max; has = true; }
      return has ? row : null;
    })
    .filter((r): r is Record<string, unknown> => r !== null);
  if (wellnessRows.length) {
    const opts = { onConflict: "user_id,date", ignoreDuplicates: false } as const;
    const { error: wErr } = await admin.from("wellness_checkins").upsert(wellnessRows, opts);
    if (wErr) {
      // sleep_score column may not be migrated yet (migration 28) — retry without it.
      const stripped = wellnessRows.map(({ sleep_score: _s, ...rest }) => rest);
      const { error: w2 } = await admin.from("wellness_checkins").upsert(stripped, opts);
      if (w2) throw new Error(`wellness mirror: ${w2.message}`);
    }
  }

  const fitness = latestFitness(wellness);
  return { user_id: userId, activities_synced: rows.length, ...fitness };
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const admin = adminClient();
    const body = await req.json().catch(() => ({}));

    if (body?.all_users) {
      if (req.headers.get("Authorization") !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) return json({error:"unauthorized"},401);
      // Cron path. Best-effort per user; one failure doesn't abort the batch.
      const { data: users } = await admin
        .from("user_profiles")
        .select("id")
        .not("intervals_athlete_id", "is", null);
      const results = [];
      for (const u of users ?? []) {
        try {
          results.push(await syncUser(admin, u.id));
          // Auto-analyze the freshly synced sessions (best-effort, capped).
          waitUntil(autoAnalyzeRecent(admin, u.id));
        } catch (e) {
          results.push({ user_id: u.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return json({ mode: "all_users", count: results.length, results });
    }

    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const result = await syncUser(admin, userId);
    // Analyze today's/yesterday's matched run/ride in the background so the
    // execution score + AI feedback are ready when the activity is opened.
    waitUntil(autoAnalyzeRecent(admin, userId));
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
