// analyze-strength — execution analysis + AI feedback for a logged strength
// session: planned_workouts (prescription) vs strength_logs (what was lifted)
// plus the optional watch recording.
//
// POST { date: "YYYY-MM-DD", force?: boolean, peek?: boolean }
//
// Cached in strength_analyses (user_id, date); force = true recomputes.
// peek = true returns only a cached result (never runs the LLM) so the app
// can auto-display background-computed analyses without triggering spend.

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { fetchStrengthHrSeries, runStrengthAnalysis } from "../_shared/analyze_core.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const date: string | undefined = body.date;
    const workoutId = body.workout_id;
    if (workoutId != null && (typeof workoutId !== "string" || !/^[0-9a-f-]{36}$/i.test(workoutId))) return json({ error: "Invalid strength session ID" }, 400);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ error: "date (YYYY-MM-DD) required" }, 400);
    }

    const admin = adminClient();
    if (body.force !== true) {
      const { data: cached } = await admin.from(workoutId ? "strength_session_analyses" : "strength_analyses").select("analysis_json").eq("user_id", userId).eq(workoutId ? "workout_id" : "date", workoutId ?? date).maybeSingle();
      if (cached?.analysis_json) {
        let a = cached.analysis_json as Record<string, unknown>;
        // Backfill the HR trace into analyses cached before the chart existed —
        // cheap (no LLM), so it works even on the auto-display peek path.
        if (!a.series && !workoutId) {
          const series = await fetchStrengthHrSeries(admin, userId, date);
          if (series) {
            a = { ...a, series };
            await admin.from("strength_analyses")
              .update({ analysis_json: a }).eq("user_id", userId).eq("date", date);
          }
        }
        return json(a);
      }
      if (body.peek === true) return json({ ok: false, not_analyzed: true });
    }

    const analysis = await runStrengthAnalysis(admin, userId, date, workoutId);
    return json(analysis);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
