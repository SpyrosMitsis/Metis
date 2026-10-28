export const CHANGE_REASONS = [
  "time",
  "fatigue",
  "pain",
  "illness",
  "equipment",
  "conditions",
  "preference",
  "other",
  "unknown",
] as const;
export type ChangeReason = typeof CHANGE_REASONS[number];
export const SESSION_OUTCOMES = [
  "as_planned",
  "skipped",
  "shortened",
  "easier",
  "harder",
  "substituted",
  "unknown",
] as const;
export type SessionOutcome = typeof SESSION_OUTCOMES[number];
export interface SessionFeedback {
  id: string;
  date: string;
  planned_workout_id?: string | null;
  activity_id?: string | null;
  completed: boolean;
  actual_rpe?: number | null;
  difficulty?: string | null;
  notes?: string | null;
  reason?: ChangeReason;
  outcome?: SessionOutcome;
  actual_minutes?: number | null;
  pain_area?: string | null;
  soreness_area?: string | null;
  enjoyment?: number | null;
  usefulness?: number | null;
  unwanted_change?: boolean | null;
}
export interface AdaptationChange {
  before_transition_seconds?: number;
  after_transition_seconds?: number;
  id: string;
  date: string;
  session_slot: number;
  before: unknown;
  after: unknown;
  explanation: string;
}
export interface AdaptationProposal {
  id: string;
  state: "preview" | "applied" | "undone";
  created_at?: string;
  changes: AdaptationChange[];
  explanation: string;
  next_action: string;
  uncertainties: string[];
  alternatives: { id: string; label: string }[];
  clarification: string | null;
}
