// analyze-activity — Garmin-style post-workout execution analysis + AI feedback.
//
// POST { activity_id: "<completed_activities.id>", force?: boolean }
//
// Thin wrapper around _shared/analyze_core.ts (also used by sync-intervals for
// automatic post-sync analysis). Cached in completed_activities.analysis_json;
// force = true recomputes.

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId, PROFILE_COLUMNS_ANALYSIS, type ProfileRow } from "../_shared/supabase.ts";
import { runActivityAnalysis } from "../_shared/analyze_core.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const activityId: string | undefined = body.activity_id;
    if (!activityId) return json({ error: "activity_id required" }, 400);

    const admin = adminClient();
    const { data: act } = await admin
      .from("effective_activities")
      .select("*")
      .eq("id", activityId)
      .eq("user_id", userId)
      .single();
    if (!act) return json({ error: "activity not found" }, 404);

    if (act.analysis_json && body.force !== true) {
      return json(act.analysis_json);
    }
    // peek: only return cached results — never trigger a fresh (LLM) analysis.
    if (body.peek === true) return json({ ok: false, not_analyzed: true });

    const { data: profileRow } = await admin
      .from("user_profiles")
      .select(PROFILE_COLUMNS_ANALYSIS)
      .eq("id", userId)
      .single();
    const profile = profileRow as ProfileRow | null;

    const analysis = await runActivityAnalysis(admin, userId, act, profile);
    return json(analysis);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
