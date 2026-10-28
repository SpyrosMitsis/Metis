import { activityMatchesPlanned } from "./activity_matching.ts";
import { z } from "npm:zod@3.23.8";
import {
  CHANGE_REASONS,
  SESSION_OUTCOMES,
} from "../../../shared/adaptation.ts";
import type { SessionState } from "./session_engine.ts";
export const ADAPTATION_POLICY = "adaptation-1";
export const FeedbackSchema = z.object({
  id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  planned_workout_id: z.string().uuid().nullable().optional(),
  activity_id: z.string().uuid().nullable().optional(),
  completed: z.boolean(),
  actual_rpe: z.number().int().min(1).max(10).nullable().optional(),
  difficulty: z.enum(["too_easy", "just_right", "too_hard"]).nullable()
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
  reason: z.enum(CHANGE_REASONS).default("unknown"),
  outcome: z.enum(SESSION_OUTCOMES).optional(),
  actual_minutes: z.number().finite().min(0).max(1440).nullable().optional(),
  pain_area: z.string().max(100).nullable().optional(),
  soreness_area: z.string().max(100).nullable().optional(),
  enjoyment: z.number().int().min(1).max(5).nullable().optional(),
  usefulness: z.number().int().min(1).max(5).nullable().optional(),
  unwanted_change: z.boolean().nullable().optional(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;
export interface AdaptationDecision {
  action: "keep" | "repeat" | "reduce" | "rebuild" | "rest";
  factor: number;
  explanation: string;
  next_action: string;
  clarification: string | null;
}
export function decideAdaptation(
  report: Pick<Feedback, "reason" | "outcome"> | null,
  state: Pick<SessionState, "history_complete" | "fatigue">,
  options: {
    minutes?: number;
    unavailable_implements?: string[];
    conditions_known?: boolean;
  } = {},
): AdaptationDecision {
  const result = (
    action: AdaptationDecision["action"],
    explanation: string,
    next_action: string,
    factor = 1,
    clarification: string | null = null,
  ) => ({ action, factor, explanation, next_action, clarification });
  if (!report && state.fatigue === "high") {
    return result(
      "reduce",
      "Current symptoms or recent demanding work support a more conservative next session.",
      "Use familiar easy work and reassess your response.",
      0.7,
    );
  }
  if (!report) {
    return result(
      "keep",
      "No confirmed change requires a schedule adjustment. Missing recordings remain unknown.",
      "Follow the next suitable planned session.",
    );
  }
  if (["pain", "illness"].includes(report.reason)) {
    return result(
      "rest",
      `Reported ${report.reason} takes priority over completion or device load. Affected planning stays on hold until you clear it.`,
      "Pause affected training and review symptoms before resuming; seek appropriate clinical advice when needed.",
      0,
    );
  }
  if (report.reason === "fatigue" || report.outcome === "harder") {
    return result(
      "reduce",
      "Actual work or reported fatigue calls for less demanding next work. The missed or extra dose is not carried forward as debt.",
      "Use the easier session and reassess how you feel afterwards.",
      0.7,
    );
  }
  if (!state.history_complete && report.reason === "unknown") {
    return result(
      "keep",
      "Training history is incomplete; absence of a recording is not a confirmed miss.",
      "Sync or review the actual session before changing its interpretation.",
    );
  }
  if (report.reason === "equipment") {
    return options.unavailable_implements?.length
      ? result(
        "rebuild",
        "Rebuild only the affected session using the remaining confirmed implements.",
        "Check the revised exercise list before starting.",
      )
      : result(
        "keep",
        "Equipment changes need the unavailable implement, rather than a guessed substitution.",
        "Choose the implement that is unavailable.",
        1,
        "Which implement is unavailable?",
      );
  }
  if (report.reason === "conditions") {
    return options.conditions_known
      ? result(
        "rebuild",
        "Use date-specific conditions and confirmed indoor alternatives.",
        "Recheck conditions near departure.",
      )
      : result(
        "keep",
        "Conditions have not been established for this session.",
        "Choose a confirmed indoor venue or update conditions.",
        1,
        "Are you using an available indoor venue?",
      );
  }
  if (state.fatigue === "high") {
    return result(
      "reduce",
      "Current readiness context takes priority over an otherwise unchanged schedule.",
      "Use familiar easy work and reassess your response.",
      0.7,
    );
  }
  if (report.reason === "time" && options.minutes != null) {
    return result(
      "rebuild",
      "Fit the complete session to the available time; do not add missed work elsewhere.",
      "Use the shorter session that fits today.",
    );
  }
  if (report.outcome === "substituted") {
    return result(
      "repeat",
      "Count the activity actually performed for shared fatigue. It does not establish the original sport-specific dose.",
      "Resume familiar sport-specific work when recovered.",
    );
  }
  if (["skipped", "shortened", "easier"].includes(report.outcome ?? "")) {
    return result(
      "repeat",
      "Keep continuity with a familiar dose. A useful adjustment is not a failure, and missed work does not accumulate.",
      "Resume the next familiar session without catching up.",
    );
  }
  return result(
    "keep",
    "No constraint justifies changing the existing session. Preferences can be handled by previewing a feasible alternative.",
    "Keep this session or choose an available alternative.",
  );
}

/** Both reports survive disagreement; device observations never erase the
 * athlete's reason and athlete reports never rewrite source measurements. */
export function feedbackConflicts(
  report: Pick<Feedback, "outcome" | "actual_minutes">,
  actual: {
    minutes: number | null;
    count: number;
    type?: string | null;
    expected_sport?: string | null;
  },
) {
  const conflicts: string[] = [];
  if (actual.count && report.outcome === "skipped") {
    conflicts.push(
      "The athlete reported skipping, but an explicitly linked recording exists; both sources are retained.",
    );
  }
  if (
    report.actual_minutes != null && actual.minutes != null &&
    Math.abs(report.actual_minutes - actual.minutes) >
      Math.max(5, actual.minutes * 0.2)
  ) {
    conflicts.push(
      "Reported and recorded durations differ; neither is silently overwritten.",
    );
  }
  if (
    report.outcome === "as_planned" && actual.type && actual.expected_sport &&
    !activityMatchesPlanned(actual.expected_sport, actual.type)
  ) {
    conflicts.push(
      "The completion report and recorded sport differ; retain both before attributing sport-specific dose.",
    );
  }
  return conflicts;
}
