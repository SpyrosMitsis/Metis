import { errorStatus, handleOptions, json } from "../_shared/cors.ts";
import { adminClient, getUserId } from "../_shared/supabase.ts";
import { isoDate, PlanError, requestId } from "../_shared/plan_store.ts";
import {
  previewAdaptation,
  recordEngineEvent,
  validateAdaptation,
} from "../_shared/adaptation_service.ts";
import { drainCalendarOutbox } from "../_shared/calendar_outbox.ts";
import type { AdaptationProposal } from "../../../shared/adaptation.ts";
Deno.serve(async (req) => {
  let owner: string | null = null;
  let action = "unknown";
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    owner = await getUserId(req);
    if (!owner) return json({ error: "unauthorized" }, 401);
    const body = await req.json(), admin = adminClient();
    action = body.action ?? "preview";
    if (action === "history") {
      const { data, error } = await admin.from("adaptation_proposals").select(
        "id,state,created_at,changes,explanation,next_action,uncertainties,alternatives,clarification,policy_version",
      ).eq("user_id", owner).order("created_at", { ascending: false }).limit(
        30,
      );
      if (error) throw new Error("Cannot read adaptation history");
      return json({ history: data });
    }
    const today = isoDate(body.today);
    if (action === "preview") {
      const proposal = await previewAdaptation(admin, owner, body);
      const { data: allowed, error } = await admin.rpc(
        "engine_release_allowed",
        { p_policy: proposal.policy_version, p_owner: owner },
      );
      if (error) throw new PlanError("Cannot establish rollout status");
      return json({ proposal, apply_allowed: allowed === true });
    }
    if (!["apply", "undo"].includes(action)) {
      throw new PlanError("Unknown adaptation action", 400);
    }
    const id = requestId(body.proposal_id);
    const { data, error } = await admin.from("adaptation_proposals").select("*")
      .eq("id", id).eq("user_id", owner).single();
    if (error || !data) throw new PlanError("Preview not found", 404);
    const replay = action === "apply" && data.state === "applied" ||
      action === "undo" && data.state === "undone";
    if (!replay) {
      await validateAdaptation(
        admin,
        owner,
        data as AdaptationProposal,
        today,
        action === "undo",
      );
    }
    const { data: proposal, error: saveError } = await admin.rpc(
      "apply_adaptation",
      { p_owner: owner, p_id: id, p_undo: action === "undo" },
    );
    if (saveError) {
      throw new PlanError(
        saveError.message,
        saveError.code === "40001" ? 409 : 422,
        saveError.code === "40001"
          ? "ADAPTATION_CONFLICT"
          : "ADAPTATION_REJECTED",
      );
    }
    if (!replay) {
      await recordEngineEvent(admin, owner, action, {
        changes: data.changes.length,
        proposal_id: id,
      });
    }
    const sync = await drainCalendarOutbox(admin, owner);
    return json({
      proposal,
      apply_allowed: action === "apply",
      sync_error: sync.error,
    });
  } catch (e) {
    if (owner) {
      await recordEngineEvent(adminClient(), owner, "rejected", {
        action,
        code: e instanceof PlanError ? e.code : "INTERNAL",
      }).catch(() => {});
    }
    return json(
      { error: e instanceof Error ? e.message : String(e) },
      errorStatus(e),
    );
  }
});
