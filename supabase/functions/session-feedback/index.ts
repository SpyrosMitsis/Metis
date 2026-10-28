import { errorStatus, handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { FeedbackSchema } from "../_shared/adaptation_policy.ts";
import { isoDate, PlanError, requestId } from "../_shared/plan_store.ts";
Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const owner = await getUserId(req);
    if (!owner) return json({ error: "unauthorized" }, 401);
    const body = await req.json(),
      today = isoDate(body.today),
      feedback = FeedbackSchema.parse({
        ...body.feedback,
        id: requestId(body.feedback?.id),
        reason: body.feedback?.reason ?? "unknown",
        outcome: body.feedback?.outcome ?? undefined,
      });
    isoDate(feedback.date);
    if (feedback.date > today) {
      throw new PlanError(
        "Completed training cannot be reported in the future",
        400,
      );
    }
    const { error } = await adminClient().rpc("save_workout_feedback", {
      p_owner: owner,
      p_feedback: feedback,
    });
    if (error) {
      throw new PlanError(error.message, error.code === "42501" ? 403 : 422);
    }
    return json({
      ok: true,
      feedback_id: feedback.id,
      planning_hold: ["pain", "illness"].includes(feedback.reason),
      next_action: "Preview any schedule changes in Adjust my plan.",
    });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : String(e) },
      e instanceof PlanError ? errorStatus(e) : 400,
    );
  }
});
