import type { SessionPrescription } from "../../../shared/prescription.ts";
// Shared types used across Edge Functions. The canonical workout schema is
// mirrored in /shared/types.ts for the web + Android clients.

export type LlmProvider =
  | "anthropic"
  | "deepseek"
  | "openai"
  | "gemini"
  | "groq"
  // OpenRouter — OpenAI-compatible aggregator (one key, hundreds of models via a
  // fixed endpoint). Behaves like a built-in provider; the user just picks a
  // model id (e.g. "anthropic/claude-3.5-sonnet"), default "openrouter/auto".
  | "openrouter"
  // User-supplied OpenAI-compatible endpoint (base URL + model + key). Its base
  // URL lives on the llm_api_keys row, not in the hardcoded provider registry.
  | "custom";

// Mirrors shared/types.ts's InjuryEntry. Legacy profiles only have the
// free-text injury_history string; injuriesOf() (profile.ts) is the single
// place that reconciles the two shapes for every server-side reader.
//
// raised_at/last_checked/status are the follow-up loop (see _shared/injury.ts).
// All three are optional: an injury captured before this existed simply has no
// dates, and injuryFollowUpDue treats it as due once, which is the right
// behavior for a fact nobody has revisited since onboarding.
export interface InjuryEntry {
  area: string;
  severity: "mild" | "moderate" | "serious" | "";
  note?: string;
  raised_at?: string; // YYYY-MM-DD, when the athlete first raised it
  last_checked?: string; // YYYY-MM-DD, when they last answered a follow-up
  status?: InjuryStatus;
}

// The answer to "is this still bothering you?". "" = never asked.
export type InjuryStatus = "" | "present" | "better" | "resolved";

// A dated, per-area instruction to back off, written by the post-workout pain
// check or by the coach. The structured counterpart of training_paused_until:
// prose in coach_knowledge cannot override a concrete prescription, this can.
// Inclusive `until`, self-expiring against the client's local date.
export interface InjuryBackoff {
  area: string;
  level: "ease" | "avoid";
  until: string; // YYYY-MM-DD, inclusive
  reason?: string;
  set_at?: string; // YYYY-MM-DD
}

export interface WorkoutExercise {
  dose?: { work_seconds?: number; distance_m?: number; stroke?: string; recovery_after_last?: boolean; transition_seconds?: number };
  name: string;
  sets: number;
  reps: string;
  weight_kg: number | null;
  pace_zone: string | null; // "Z1".."Z5"
  hr_zone: string | null; // "Z1".."Z5"
  rest_seconds: number | null;
  notes: string;
  // Catalog metadata, present only on exercises the AI introduced that aren't
  // in the bundled library (used to auto-register them as custom exercises).
  muscle?: string | null;
  category?: string | null;
  compound?: boolean | null;
}

export interface WorkoutSection {
  name: string;
  duration_minutes: number;
  exercises: WorkoutExercise[];
}

export interface Workout {
  prescription?: SessionPrescription;
  type: "run" | "ride" | "swim" | "strength" | "rest";
  title: string;
  duration_minutes: number;
  tss_estimate: number;
  rpe_target: number;
  sections: WorkoutSection[];
  coach_note: string;
}

export interface LlmResult {
  // Ready to show: llmGenerate has already enforced the no-dash house rule.
  text: string;
  // What the model actually wrote, before that scrub. Only the offline eval
  // wants this: scoring `text` would mark the dash checker green by
  // construction and hide a model that ignores the rule.
  raw?: string;
  promptTokens: number;
  completionTokens: number;
  provider: LlmProvider;
  model: string;
  // Prompt-cache accounting (_shared/llm_cache.ts). Both are a SUBSET of
  // promptTokens, not extra tokens: they say how much of the prompt was billed
  // at the write (~1.25x) and read (~0.1x) rates instead of full price. Zero
  // when the provider reported nothing, which is also what "no caching" looks
  // like, so llm:cost showing a flat zero is the signal that a cache broke.
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}
