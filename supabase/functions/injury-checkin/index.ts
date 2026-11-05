// injury-checkin — the write end of the injury follow-up loop.
//
// Both things the athlete can answer about an injury land here, because both
// mutate the same two places (onboarding.injuries and injury_backoff) and both
// have consequences the client must not be trusted to get right on its own: a
// "resolved" has to drop the backoff too, and a pain score has to be escalated
// by the SAME rule the tests pin (backoffFromPain), not by whatever the UI felt
// like sending. The phone posts an answer; the server decides what it means.
//
// POST { kind: "followup", area, status: "present"|"better"|"resolved", date? }
// POST { kind: "pain", area, pain: 1-5, date?, planned_workout_id?, note? }
//
// `date` is the CLIENT's local date (the "today is not UTC" rule); it anchors
// the backoff window and the follow-up clock.

import { handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { injuriesOf } from "../_shared/profile.ts";
import {
  activeBackoffs,
  backoffFromPain,
  clearBackoff,
  markInjuryChecked,
  upsertBackoff,
} from "../_shared/injury.ts";
import { editRestriction, RestrictionEditError } from "../_shared/restriction_edit.ts";
import { logger } from "../_shared/log.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const log = logger("injury-checkin");

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const area = typeof body.area === "string" ? body.area.trim() : "";
    if (!area) return json({ error: "area required" }, 400);
    const today = typeof body.date === "string" && ISO_DATE.test(body.date)
      ? body.date
      : new Date().toISOString().slice(0, 10);

    const admin = adminClient();
    const { data: profile } = await admin
      .from("user_profiles")
      .select("onboarding, injury_backoff")
      .eq("id", userId)
      .single();
    if (!profile) return json({ error: "profile not found" }, 404);

    if (body.kind === "restriction") {
      const entries = Array.isArray(profile.injury_backoff) ? profile.injury_backoff : [];
      let next;
      try { next = editRestriction(entries, body); }
      catch (e) { if (e instanceof RestrictionEditError) return json({ error: e.message }, e.status); throw e; }
      const { data, error } = await admin.from("user_profiles").update({ injury_backoff: next })
        .eq("id", userId).eq("injury_backoff", JSON.stringify(entries)).select("id");
      if (error) throw error;
      if (!data?.length) return json({ error: "Your restrictions changed while saving. Reload and try again." }, 409);
      return json({ ok: true });
    }

    const onboarding = (profile.onboarding ?? {}) as Record<string, unknown>;
    const injuries = injuriesOf(onboarding);
    if (!injuries.some((i) => i.area.trim().toLowerCase() === area.toLowerCase())) {
      return json({ error: `no injury on file for "${area}"` }, 404);
    }
    const current = activeBackoffs(profile.injury_backoff, today);

    // --- the follow-up card: "is it still bothering you?" -------------------
    if (body.kind === "followup") {
      const status = body.status;
      if (status !== "present" && status !== "better" && status !== "resolved") {
        return json({ error: "status must be present, better or resolved" }, 400);
      }
      const nextInjuries = markInjuryChecked(injuries, area, status, today);
      // Resolved drops the backoff as well: "it's fine now" must not leave a
      // dated instruction quietly reshaping sessions for another week.
      const nextBackoffs = status === "resolved" ? clearBackoff(current, area) : current;
      await admin.from("user_profiles").update({
        onboarding: { ...onboarding, injuries: nextInjuries },
        injury_backoff: nextBackoffs,
      }).eq("id", userId);
      log.info("follow-up answered", { area, status });
      return json({
        ok: true,
        area,
        status,
        removed: status === "resolved",
        backoff_cleared: current.length - nextBackoffs.length,
      });
    }

    // --- the post-workout pain check ----------------------------------------
    if (body.kind === "pain") {
      const pain = Number(body.pain);
      if (!Number.isFinite(pain) || pain < 1 || pain > 5) {
        return json({ error: "pain must be 1 to 5" }, 400);
      }
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
      const outcome = backoffFromPain(area, pain, today, note || undefined);
      const nextBackoffs = outcome.clear
        ? clearBackoff(current, area)
        : outcome.backoff
        ? upsertBackoff(current, outcome.backoff)
        : current;

      // A pain answer IS a follow-up answer: the athlete just told us how the
      // area is. Recording it stops the Home card asking the same question
      // tomorrow. It never resolves an injury on its own, though: one pain-free
      // session is not recovery, and only the athlete gets to say it is over.
      const nextInjuries = markInjuryChecked(
        injuries,
        area,
        pain <= 2 ? "better" : "present",
        today,
      );

      await admin.from("user_profiles").update({
        onboarding: { ...onboarding, injuries: nextInjuries },
        injury_backoff: nextBackoffs,
      }).eq("id", userId);

      // Scope the score to the session it was felt in. markPlannedComplete has
      // already written the feedback row by the time the athlete answers this,
      // so update in place and only insert when there is nothing to update
      // (a session logged outside the planned flow).
      const plannedId = typeof body.planned_workout_id === "string" ? body.planned_workout_id : null;
      const painCols = { pain_score: Math.round(pain), pain_area: area };
      let wrote = false;
      if (plannedId) {
        const { data } = await admin.from("workout_feedback")
          .update(painCols).eq("user_id", userId).eq("planned_workout_id", plannedId).select("id");
        wrote = (data ?? []).length > 0;
      }
      if (!wrote) {
        const { data } = await admin.from("workout_feedback")
          .update(painCols).eq("user_id", userId).eq("date", today).select("id");
        wrote = (data ?? []).length > 0;
      }
      if (!wrote) {
        await admin.from("workout_feedback").insert({
          user_id: userId, date: today, planned_workout_id: plannedId, completed: true, ...painCols,
        });
      }

      log.info("pain reported", { area, pain, level: outcome.backoff?.level ?? "none" });
      return json({
        ok: true,
        area,
        pain: Math.round(pain),
        backoff: outcome.backoff,
        cleared: outcome.clear,
        severe: outcome.severe,
      });
    }

    return json({ error: "kind must be followup or pain" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
