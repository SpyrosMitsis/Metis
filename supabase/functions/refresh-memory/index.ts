// refresh-memory — maintain a short, rolling "athlete memory" the coach carries
// into every generation. Called fire-and-forget by the app after a workout is
// generated or feedback is submitted, so it never blocks the user.
//
// Reads the old memory + recent feedback + recent sessions, asks a cheap LLM to
// fold them into <=120 words of durable notes, and saves it on the profile.

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { llmAccess } from "../_shared/llm_keys.ts";
import { memoryFromProfile, updateMemoryDoc, updateSoulDoc } from "../_shared/agent_memory.ts";
import { goalsText } from "../_shared/profile.ts";
import { goalRaceLine, pickGoalRace, upcomingGoals } from "../_shared/context.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const admin = adminClient();

    const today = new Date().toISOString().slice(0, 10);
    const [{ data: profile }, { data: feedback }, { data: planned }, { data: strength }, goalRows] = await Promise.all([
      admin.from("user_profiles").select("training_memory, coach_soul, coach_soul_updated_at, active_llm_provider, llm_fallback_chain, onboarding, plan, plan_expires_at, use_hosted_ai, llm_custom_input_per_1m, llm_custom_output_per_1m").eq("id", userId).single(),
      admin.from("workout_feedback").select("date, difficulty, actual_rpe, completed, notes").eq("user_id", userId).order("date", { ascending: false }).limit(8),
      admin.from("reconciled_session_plans").select("date, type, workout_json").eq("user_id", userId).order("date", { ascending: false }).limit(6),
      admin.from("strength_logs").select("date, exercise_name, estimated_1rm, sets").eq("user_id", userId).order("date", { ascending: false }).limit(12),
      upcomingGoals(admin, userId, today),
    ]);
    if (!profile) return json({ error: "no profile" }, 404);

    const fbLines = (feedback ?? []).map((f) =>
      `- ${f.date}: ${f.completed === false ? "skipped; " : ""}${f.difficulty ?? "?"}${f.actual_rpe ? `, RPE ${f.actual_rpe}` : ""}${f.notes ? ` ("${f.notes}")` : ""}`
    ).join("\n") || "(none)";
    const wkLines = (planned ?? []).map((p) =>
      `- ${p.date} ${p.type}: ${(p.workout_json as { title?: string })?.title ?? ""}`
    ).join("\n") || "(none)";
    const stLines = (strength ?? []).map((s) => {
      const sets = (s.sets ?? []) as Array<{ weight_kg?: number; reps?: number }>;
      const top = sets.reduce((b, x) => ((x.weight_kg ?? 0) > (b?.weight_kg ?? 0) ? x : b), sets[0]);
      const topStr = top ? ` top ${top.weight_kg ?? 0}kg×${top.reps ?? 0}` : "";
      const e1rm = s.estimated_1rm ? `, e1RM ${Math.round(s.estimated_1rm)}kg` : "";
      return `- ${s.date} ${s.exercise_name}:${topStr}${e1rm}`;
    }).join("\n") || "(none)";

    // Shared evidence block — feeds both the rolling memory and (rarely) the soul.
    //
    // These docs are DURABLE prose. A race name written into the goal line
    // survived long after the race did ("their goal is the Athens Marathon",
    // still on file the following spring), because onboarding.goal used to hold
    // whichever of the two goals was written last. The training goal is the
    // durable half; the event goes in with its date, so a later pass can see it
    // has passed.
    const onboarding = (profile.onboarding ?? {}) as Record<string, unknown>;
    const goalRace = goalRaceLine(pickGoalRace(goalRows, today, onboarding.goal_date as string | undefined), today);
    const evidence = `TRAINING GOAL: ${goalsText(onboarding)}\n` +
      (goalRace ? `NEXT GOAL EVENT: ${goalRace}\n` : "") + `\n` +
      `RECENT FEEDBACK:\n${fbLines}\n\nRECENT SESSIONS:\n${wkLines}\n\n` +
      `RECENT STRENGTH:\n${stLines}`;

    // llmAccess already carries `hosted`; pricing lets a BYO call log a real cost.
    const bundle = { ...await llmAccess(admin, userId, profile), pricing: profile };
    const mem = memoryFromProfile(profile);

    // memory.md every call; soul.md only when due (time-gated) or still unseeded.
    const memory = await updateMemoryDoc(admin, userId, mem.memory, evidence, bundle);
    await updateSoulDoc(admin, userId, mem, evidence, bundle);

    return json({ ok: true, memory });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 200);
  }
});
