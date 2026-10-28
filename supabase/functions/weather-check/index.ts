// weather-check — token-free daily viability check. No LLM call anywhere in
// this function: it's a deterministic composition of assessViability() and
// pickPrimaryPlannedWorkout(), meant to be hit once a day by the Android
// client (which knows the true local date — see CLAUDE.md's "today" rule)
// to decide whether to prompt "swap today's outdoor session?".
//
// POST/GET { date: "YYYY-MM-DD", lat?: number, lon?: number } — date is
// REQUIRED, no server-side `new Date()` fallback, so this can't silently
// fall into the UTC "stuck on yesterday" bug daily-summary guards against.

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { assessViability, getWeather } from "../_shared/weather.ts";
import { pickPrimaryPlannedWorkout } from "../_shared/planned_today.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type SuppressReason =
  | "no_workout"
  | "not_outdoor_sport"
  | "already_settled"
  | "user_opted_out"
  | "no_location"
  | "ok_weather"
  | null;

interface WeatherCheckResult {
  should_prompt: boolean;
  tier: "ok" | "caution" | "blocked" | null;
  reason: string | null;
  sport: "run" | "ride" | null;
  workout_id: string | null;
  workout_title: string | null;
  swap_type: "run" | "ride" | null;
  suppressed_reason: SuppressReason;
}

function suppressed(reason: SuppressReason): WeatherCheckResult {
  return {
    should_prompt: false,
    tier: null,
    reason: null,
    sport: null,
    workout_id: null,
    workout_title: null,
    swap_type: null,
    suppressed_reason: reason,
  };
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const qDate = new URL(req.url).searchParams.get("date");
    const date = [body?.date, qDate].find((d) => typeof d === "string" && ISO_DATE.test(d));
    if (!date) return json({ error: "date (YYYY-MM-DD) is required" }, 400);

    const admin = adminClient();
    const { data: profile } = await admin.from("user_profiles")
      .select("last_lat, last_lon, weather_prompt_opt_out")
      .eq("id", userId).single();

    if (profile?.weather_prompt_opt_out === true) {
      return json(suppressed("user_opted_out"));
    }

    const lat = typeof body.lat === "number" ? body.lat : profile?.last_lat;
    const lon = typeof body.lon === "number" ? body.lon : profile?.last_lon;
    if (typeof lat !== "number" || typeof lon !== "number") {
      return json(suppressed("no_location"));
    }

    const { data: rows } = await admin.from("reconciled_session_plans")
      .select("id, type, completed, skipped, locked, created_at, workout_json")
      .eq("user_id", userId).eq("date", date as string);

    const primary = pickPrimaryPlannedWorkout(rows ?? []);
    if (!primary) return json(suppressed("no_workout"));
    if (primary.type !== "run" && primary.type !== "ride") return json(suppressed("not_outdoor_sport"));
    if (primary.completed || primary.skipped || primary.locked) return json(suppressed("already_settled"));

    const wx = await getWeather(lat, lon);
    if (!wx) return json(suppressed(null));

    const sport = primary.type as "run" | "ride";
    const verdict = assessViability(wx, sport);
    if (verdict.tier !== "blocked") {
      return json({ ...suppressed("ok_weather"), tier: verdict.tier });
    }

    const title = (primary.workout_json as { title?: string } | null)?.title ?? null;
    return json({
      should_prompt: true,
      tier: "blocked",
      reason: verdict.reasons.join("; "),
      sport,
      workout_id: primary.id,
      workout_title: title,
      swap_type: sport,
      suppressed_reason: null,
    } satisfies WeatherCheckResult);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
