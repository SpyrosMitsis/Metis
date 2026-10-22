import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
// schedule-template — expand a saved workout_template into dated
// planned_workouts rows. Single-workout templates schedule one day; multi-week
// "plan" templates map week/day onto the calendar from a start date.
//
// POST { template_id, start_date?: "YYYY-MM-DD", push?: boolean }

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, decryptSecret, getUserId } from "../_shared/supabase.ts";
import { validateWorkout } from "../_shared/prompt.ts";
import { createEvent } from "../_shared/intervals.ts";
import type { Workout } from "../_shared/types.ts";

const DAY = 86_400_000;
const DAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
// Monday of the week containing `d` (Monday-first).
function mondayOf(d: Date): Date {
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const { template_id, start_date, push } = await req.json();
    if (!template_id) return json({ error: "template_id required" }, 400);

    const admin = adminClient();
    const { data: tpl } = await admin
      .from("workout_templates")
      .select("*")
      .eq("id", template_id)
      .eq("user_id", userId)
      .single();
    if (!tpl) return json({ error: "template not found" }, 404);

    const start = start_date ? new Date(start_date + "T12:00:00") : new Date();
    const startStr = iso(start);
    const structure = tpl.structure as Record<string, unknown>;

    // Collect { date, workout } pairs to insert.
    const items: { date: string; workout: Workout }[] = [];

    if (structure && Array.isArray((structure as { weeks?: unknown[] }).weeks)) {
      // Multi-week plan.
      const weeks = (structure as { weeks: { week?: number; days?: { day?: string; workout?: unknown }[] }[] }).weeks;
      const baseMonday = mondayOf(start);
      weeks.forEach((wk, wi) => {
        for (const d of wk.days ?? []) {
          const di = DAY_INDEX[d.day ?? ""] ?? null;
          if (di == null) continue;
          const date = new Date(baseMonday.getTime() + (wi * 7 + di) * DAY);
          if (iso(date) < startStr) continue; // don't schedule before start
          const v = validateWorkout(d.workout);
          if (v.ok && v.workout) items.push({ date: iso(date), workout: v.workout });
        }
      });
    } else {
      // Single workout template.
      const v = validateWorkout(structure);
      if (v.ok && v.workout) items.push({ date: startStr, workout: v.workout });
    }

    if (!items.length) return json({ error: "template produced no schedulable workouts" }, 422);

    const rows = items.map((it) => ({
      user_id: userId,
      date: it.date,
      type: it.workout.type,
      workout_json: it.workout,
      sync_requested: push === true,
      llm_provider: "template",
      llm_model: tpl.name,
    }));
    const { data: inserted, error: insErr } = await admin
      .from("planned_workouts")
      .insert(rows)
      .select("id, date, workout_json");
    if (insErr) return json({ error: `insert failed: ${insErr.message}` }, 500);

    const sync = await drainCalendarOutbox(admin,userId);
    const pushed = Object.keys(sync.events).length;

    return json({ scheduled: items.length, pushed, start_date: startStr });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
