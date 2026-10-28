import { selectNumericTarget } from "./target_selection.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type {
  SessionObjective,
  TrainingSport,
} from "../../../shared/prescription.ts";
import {
  ADAPTATION_POLICY,
  decideAdaptation,
  type Feedback,
  feedbackConflicts,
} from "./adaptation_policy.ts";
import {
  assertPublishable,
  assertTimeBudgets,
  isoDate,
  PlanError,
  planRevision,
  requestId,
  reviewGeneratedWorkout,
  stableValue,
} from "./plan_store.ts";
import {
  remainingWeekMinutes,
  sessionState,
  withForecast,
} from "./session_context.ts";
import {
  buildSession,
  rejectTemplate,
  SESSION_TEMPLATES,
} from "./session_engine.ts";
import { loadReviewContext } from "./review_context.ts";
import { slotKey } from "./session_slots.ts";
import { demandingWorkout, overlapReason } from "./training_demands.ts";
import type { Workout } from "./types.ts";
import type {
  AdaptationChange,
  AdaptationProposal,
} from "../../../shared/adaptation.ts";

const plus = (date: string, n: number) =>
  new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
async function athleteRevision(admin: SupabaseClient, owner: string) {
  const { data, error } = await admin.from("athlete_versions").select(
    "revision",
  ).eq("user_id", owner).maybeSingle();
  if (error) throw new Error("Cannot read athlete revision");
  return Number(data?.revision ?? 0);
}
export async function recordEngineEvent(
  admin: SupabaseClient,
  owner: string,
  kind: string,
  properties: Record<string, unknown> = {},
  sport?: string,
) {
  const { error } = await admin.from("engine_events").insert({
    user_id: owner,
    kind,
    sport,
    policy_version: ADAPTATION_POLICY,
    properties,
  });
  if (error) console.warn("engine metric write failed", error.code); // Never include athlete payloads or auth headers.
}
export async function previewAdaptation(
  admin: SupabaseClient,
  owner: string,
  body: Record<string, unknown>,
): Promise<AdaptationProposal & { policy_version: string }> {
  const today = isoDate(body.today), id = requestId(body.request_id);
  const scope = {
    today,
    workout_id: body.workout_id ?? null,
    minutes: body.minutes ?? null,
    unavailable_implements: body.unavailable_implements ?? [],
    alternative_sport: body.alternative_sport ?? null,
  };
  const { data: existing, error: replayError } = await admin.from(
    "adaptation_proposals",
  ).select("*").eq("user_id", owner).eq("id", id).maybeSingle();
  if (replayError) throw new Error("Cannot read adaptation request");
  if (existing) {
    if (stableValue(existing.provenance.scope) !== stableValue(scope)) {
      throw new PlanError("Request ID belongs to another preview", 409);
    }
    return existing;
  }
  const revision = await planRevision(admin, owner),
    version = await athleteRevision(admin, owner);
  const [
    { data: profile, error: pe },
    { data: plans, error: we },
    { data: reports, error: fe },
    { data: holds, error: he },
  ] = await Promise.all([
    admin.from("user_profiles").select(
      "onboarding,injury_backoff,training_paused_until,last_lat,last_lon",
    ).eq("id", owner).single(),
    admin.from("reconciled_session_plans").select("*").eq("user_id", owner).gte(
      "date",
      today,
    ).lte("date", plus(today, 6)).order("date"),
    admin.from("workout_feedback").select("*,planned_workouts(type)").eq(
      "user_id",
      owner,
    ).gte("date", plus(today, -7)).lte("date", today).order("created_at", {
      ascending: false,
    }),
    admin.from("training_holds").select("*").eq("user_id", owner).eq(
      "active",
      true,
    ).lte("start_date", plus(today, 6)),
  ]);
  if (pe || we || fe || he || !profile) {
    throw new PlanError("Cannot establish current athlete constraints");
  }
  let report = (reports ?? []).find((r) =>
    !body.workout_id || r.planned_workout_id === body.workout_id
  ) as Feedback | undefined;
  const o = profile.onboarding ?? {},
    selectedSports = Array.isArray(o.sports) ? o.sports : [];
  const unavailable = Array.isArray(body.unavailable_implements)
    ? body.unavailable_implements.filter((v): v is string =>
      typeof v === "string"
    )
    : [];
  if (
    body.minutes != null &&
    (typeof body.minutes !== "number" || !Number.isFinite(body.minutes) ||
      body.minutes < 0 || body.minutes > 1440)
  ) throw new PlanError("Invalid available minutes", 400);
  if (
    body.alternative_sport && !selectedSports.includes(body.alternative_sport)
  ) throw new PlanError("Alternative sport is not in your profile", 422);
  const stateInputs: unknown[] = [];
  const changes: AdaptationChange[] = [],
    uncertainties: string[] = [],
    alternatives: { id: string; label: string }[] = [];
  let explanation =
      "The existing plan is kept. Missing recordings are not treated as missed workouts.",
    nextAction = "Continue with the next suitable planned session.",
    clarification: string | null = null;
  const protectedRows = (plans ?? []).filter((p) =>
    p.completed || p.skipped || p.locked || p.activity_ids?.length
  );
  const holdFor = (p: { date: string; type: string }) =>
    (holds ?? []).find((h) =>
      h.start_date <= p.date && (!h.until_date || h.until_date >= p.date) &&
      (!h.sport || h.sport === p.type)
    );
  const heldGroups = new Set(
    (plans ?? []).filter((p) => p.combined_group && holdFor(p)).map((p) =>
      p.combined_group
    ),
  );
  const protectedGroups = new Set(
    protectedRows.filter((p) => p.combined_group).map((p) => p.combined_group),
  );
  const mutable = (plans ?? []).filter((p) =>
    !protectedRows.includes(p) &&
    (p.type !== "rest" || p.workout_json?.duration_minutes > 0) &&
    (!p.combined_group ||
      heldGroups.has(p.combined_group) &&
        !protectedGroups.has(p.combined_group))
  );
  const targetSport = body.workout_id
    ? (plans ?? []).find((p) => p.id === body.workout_id)?.type
    : undefined;
  if (report?.activity_id) {
    const { data: actual, error } = await admin.from("effective_activities")
      .select("duration_seconds,type").eq("user_id", owner).eq(
        "id",
        report.activity_id,
      );
    if (error) throw new PlanError("Cannot read linked observation");
    const reportRow = (reports ?? []).find((r) => r.id === report!.id);
    const linked = Array.isArray(reportRow?.planned_workouts)
      ? reportRow.planned_workouts[0]
      : reportRow?.planned_workouts;
    uncertainties.push(
      ...feedbackConflicts(report, {
        count: actual?.length ?? 0,
        minutes: actual?.[0]?.duration_seconds != null
          ? actual[0].duration_seconds / 60
          : null,
        type: actual?.[0]?.type,
        expected_sport: linked?.type,
      }),
    );
  }
  for (const plan of mutable) {
    if (
      targetSport && plan.type !== targetSport &&
      !heldGroups.has(plan.combined_group)
    ) continue;
    const sport = plan.type as TrainingSport;
    const state = await withForecast(
      await sessionState(
        admin,
        owner,
        o,
        plan.date,
        sport,
        undefined,
        plan.session_slot,
      ),
      profile,
    );
    stateInputs.push({
      date: state.date,
      sport: state.sport,
      actual: state.actual,
      program: state.program,
      history_complete: state.history_complete,
      history_issues: state.history_issues,
      readiness: state.readiness,
    });
    const activeHold = holdFor(plan) ??
      (heldGroups.has(plan.combined_group)
        ? (plans ?? []).filter((p) => p.combined_group === plan.combined_group)
          .map(holdFor).find(Boolean)
        : undefined);
    if (!report) {
      if (body.minutes != null) {
        report = {
          id: "",
          date: today,
          completed: false,
          reason: "time",
          outcome: "unknown",
        };
      } else if (unavailable.length) {
        report = {
          id: "",
          date: today,
          completed: false,
          reason: "equipment",
          outcome: "unknown",
        };
      } else if (
        state.actual.some((a) =>
          a.effort != null && a.effort >= 7 && a.date <= today &&
          a.date >= plus(today, -1)
        )
      ) {
        report = {
          id: "",
          date: today,
          completed: true,
          reason: "fatigue",
          outcome: "harder",
        };
      }
    }
    const effectiveReport = activeHold
      ? {
        reason: activeHold.reason as "pain" | "illness",
        outcome: "unknown" as const,
      }
      : report ?? null;
    const decision = decideAdaptation(effectiveReport, state, {
      minutes: body.minutes as number | undefined,
      unavailable_implements: unavailable,
      conditions_known: !!state.conditions ||
        ["indoor", "treadmill", "pool"].includes(state.venue),
    });
    explanation = decision.explanation;
    nextAction = decision.next_action;
    clarification = decision.clarification;
    if (clarification) break;
    if (!state.history_complete) {
      uncertainties.push(
        ...state.history_issues ?? [],
        "Observation coverage is incomplete; no automatic progression is authorized.",
      );
    }
    if (decision.action === "keep" && !body.alternative_sport) break;
    if (decision.action === "repeat" && !body.alternative_sport) {
      // Repeating the existing familiar session is often the smallest useful
      // adaptation. Never regenerate merely to make the screen look changed.
      if (
        plan.workout_json?.duration_minutes <=
          (state.program?.session_minutes ?? state.max_minutes) &&
        !demandingWorkout(plan.workout_json)
      ) break;
    }
    let candidate: Workout;
    if (decision.action === "rest") {
      candidate = buildSession(
        await sessionState(
          admin,
          owner,
          o,
          plan.date,
          "rest",
          0,
          plan.session_slot,
        ),
        "rest",
      );
    } else {
      const next = body.alternative_sport
        ? await withForecast(
          await sessionState(
            admin,
            owner,
            o,
            plan.date,
            body.alternative_sport as TrainingSport,
            undefined,
            plan.session_slot,
          ),
          profile,
        )
        : state;
      next.implements = next.implements.filter((i) => !unavailable.includes(i));
      next.max_minutes = Math.min(
        next.max_minutes,
        typeof body.minutes === "number" ? body.minutes : 1440,
        plan.workout_json.duration_minutes * decision.factor,
      );
      next.weekly_remaining_minutes = await remainingWeekMinutes(
        admin,
        owner,
        o,
        plan.date,
        new Set([slotKey(plan.date, plan.session_slot)]),
      );
      if (next.program) {
        next.program = {
          ...next.program,
          session_minutes: Math.min(
            next.program.session_minutes,
            next.max_minutes,
          ),
          quality_allowed: decision.action === "rebuild" &&
            next.program.quality_allowed,
        };
      }
      const objective: SessionObjective = next.sport === "strength"
        ? "strength"
        : decision.action === "reduce"
        ? "recovery"
        : "easy";
      candidate = next.max_minutes < 10
        ? buildSession(
          await sessionState(
            admin,
            owner,
            o,
            plan.date,
            "rest",
            0,
            plan.session_slot,
          ),
          "rest",
        )
        : buildSession(next, objective);
      const overlap = overlapReason(
        plan.date,
        candidate.type,
        demandingWorkout(candidate),
        state.actual,
        (plans ?? []).filter((p) => p.id !== plan.id && !p.skipped).map(
          (p) => ({ date: p.date, workout: p.workout_json as Workout }),
        ),
      );
      if (overlap) {
        uncertainties.push(overlap);
        continue;
      }
    }
    const review = await loadReviewContext(
      admin,
      owner,
      plan.date,
      candidate.type,
      profile,
    );
    candidate = reviewGeneratedWorkout(candidate, review).corrected;
    assertPublishable(candidate, review);
    changes.push({
      id: plan.id,
      date: plan.date,
      session_slot: plan.session_slot ?? 0,
      before: plan.workout_json,
      after: candidate,
      before_transition_seconds: plan.transition_before_seconds ?? 0,
      after_transition_seconds: candidate.type === "rest"
        ? 0
        : plan.transition_before_seconds ?? 0,
      explanation: decision.explanation,
    });
    // A hold affects all unprotected sessions of the affected sport. Other
    // changes touch only the next suitable session, never the entire week.
    if (!activeHold) break;
  }
  if (protectedRows.length) {
    uncertainties.push(
      `${protectedRows.length} completed, recorded, skipped or locked commitments are preserved.`,
    );
  }
  if ((plans ?? []).some((p) => p.combined_group)) {
    uncertainties.push(
      "Combined sessions are preserved as a unit; affected unprotected groups move to rest together during a planning hold.",
    );
  }
  if (report?.reason === "preference") {
    const plan = mutable[0];
    if (plan) {
      for (
        const sport of selectedSports.filter((s: string) => s !== plan.type)
          .slice(0, 3)
      ) {
        try {
          const state = await withForecast(
            await sessionState(
              admin,
              owner,
              o,
              plan.date,
              sport,
              undefined,
              plan.session_slot,
            ),
            profile,
          );
          state.weekly_remaining_minutes = await remainingWeekMinutes(
            admin,
            owner,
            o,
            plan.date,
            new Set([slotKey(plan.date, plan.session_slot)]),
          );
          const w = buildSession(
            state,
            sport === "strength" ? "strength" : "easy",
          );
          assertPublishable(
            w,
            await loadReviewContext(admin, owner, plan.date, sport, profile),
          );
          await assertTimeBudgets(admin, owner, [{
            date: plan.date,
            session_slot: plan.session_slot,
            type: w.type,
            workout_json: w,
          }], true);
          if (
            !overlapReason(
              plan.date,
              sport,
              demandingWorkout(w),
              state.actual,
              (plans ?? []).filter((p) => p.id !== plan.id && !p.skipped).map(
                (p) => ({ date: p.date, workout: p.workout_json as Workout }),
              ),
            )
          ) {
            alternatives.push({
              id: sport,
              label: `Preview familiar ${sport} instead`,
            });
          }
        } catch { /* Only independently eligible alternatives are shown. */ }
      }
    }
  }
  if (changes.length) {
    await assertTimeBudgets(
      admin,
      owner,
      changes.map((c) => ({
        date: c.date,
        session_slot: c.session_slot,
        type: (c.after as Workout).type,
        workout_json: c.after as Workout,
        transition_before_seconds: c.after_transition_seconds,
      })),
      true,
    );
  }
  if (
    await planRevision(admin, owner) !== revision ||
    await athleteRevision(admin, owner) !== version
  ) throw new PlanError("Inputs changed; preview again", 409, "STALE_PREVIEW");
  const proposal = {
    id,
    user_id: owner,
    state: "preview" as const,
    plan_revision: revision,
    athlete_revision: version,
    changes,
    explanation,
    next_action: nextAction,
    uncertainties: [...new Set(uncertainties)],
    alternatives,
    clarification,
    policy_version: ADAPTATION_POLICY,
    provenance: {
      scope,
      feedback_id: report?.id ?? null,
      history_source: "effective_activities",
      athlete_states: stateInputs,
      model: "deterministic",
      protected_ids: protectedRows.map((p) => p.id),
    },
  };
  const { error } = await admin.from("adaptation_proposals").insert(proposal);
  if (error) throw new PlanError("Cannot save adaptation preview");
  await recordEngineEvent(admin, owner, "preview", {
    changes: changes.length,
    reason: report?.reason ?? "unknown",
    clarification: !!clarification,
  });
  return proposal;
}
export async function validateAdaptation(
  admin: SupabaseClient,
  owner: string,
  proposal: AdaptationProposal,
  today: string,
  undo = false,
) {
  const { data: profile, error } = await admin.from("user_profiles").select(
    "onboarding,injury_backoff,training_paused_until,last_lat,last_lon",
  ).eq("id", owner).single();
  if (error || !profile) {
    throw new PlanError("Cannot validate current constraints");
  }
  const rows = [];
  for (const c of proposal.changes) {
    if (c.date < today) {
      throw new PlanError("Past training cannot be rewritten", 409);
    }
    const w = (undo ? c.before : c.after) as Workout;
    if (!w.prescription) {
      throw new PlanError(
        "This historical session needs a new validated preview",
        422,
      );
    }
    const state = await withForecast(
      await sessionState(
        admin,
        owner,
        profile.onboarding ?? {},
        c.date,
        w.type,
        undefined,
        c.session_slot,
      ),
      profile,
    );
    if (
      w.type !== "rest" &&
      w.duration_minutes >
        Math.min(state.max_minutes, state.program?.session_minutes ?? 1440)
    ) {
      throw new PlanError(
        "Current exposure or availability no longer supports this dose",
      );
    }
    if (
      state.conditions?.tier === "blocked" &&
      !["indoor", "treadmill", "pool"].includes(w.prescription.venue)
    ) throw new PlanError("Current conditions no longer support this venue");
    const template = SESSION_TEMPLATES.find((t) =>
      t.sport === w.type && t.objective === w.prescription!.objective
    );
    const issue = template
      ? rejectTemplate(template, state)
      : "Unsupported objective";
    if (issue) throw new PlanError(issue);
    if (
      profile.training_paused_until &&
      c.date <= profile.training_paused_until && w.type !== "rest"
    ) throw new PlanError("Training is paused");
    for (const block of w.prescription.blocks) {
      if (block.kind === "endurance" && block.numeric_target) {
        const expected = selectNumericTarget(
          { ...state, venue: w.prescription.venue as typeof state.venue },
          w.prescription.objective,
          block,
        );
        if (stableValue(expected) !== stableValue(block.numeric_target)) {
          throw new PlanError(
            "Intensity calibration changed; preview a current prescription before restoring it",
          );
        }
      }
    }
    assertPublishable(
      w,
      await loadReviewContext(admin, owner, c.date, w.type, profile),
    );
    rows.push({
      date: c.date,
      session_slot: c.session_slot,
      type: w.type,
      workout_json: w,
      transition_before_seconds: undo
        ? c.before_transition_seconds
        : c.after_transition_seconds,
    });
  }
  if (rows.length) await assertTimeBudgets(admin, owner, rows, true);
}
