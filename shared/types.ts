import type { SessionPrescription } from "./prescription";
// ============================================================================
// Shared TypeScript types — the canonical workout schema and DB row shapes,
// consumed by the web app. (Android mirrors these as Kotlin data classes.)
// Keep in sync with supabase/functions/_shared/types.ts.
// ============================================================================

// Keep in sync with supabase/functions/_shared/types.ts and the llm_api_keys
// provider CHECK. "custom" = a user-supplied OpenAI-compatible endpoint.
export type LlmProvider = "anthropic" | "deepseek" | "openai" | "gemini" | "groq" | "openrouter" | "custom";

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  gemini: "Google Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
  custom: "Custom (OpenAI-compatible)",
};

export const PROVIDER_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-opus-4-8",
  deepseek: "deepseek-v4-flash",
  openai: "gpt-5-mini",
  gemini: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
  openrouter: "openrouter/auto",
  custom: "",
};

export const PROVIDER_FREE_KEY_URL: Record<LlmProvider, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/app/apikey",
  groq: "https://console.groq.com/keys",
  openrouter: "https://openrouter.ai/keys",
  custom: "",
};

// ~USD per 1M tokens (input/output) for the per-generation cost estimate.
// OpenRouter + custom pricing depend on the chosen model/endpoint, so they show
// ~$0 here unless the user enters explicit per-1M prices.
export const PROVIDER_PRICING: Record<LlmProvider, { inputPer1M: number; outputPer1M: number }> = {
  anthropic: { inputPer1M: 5.0, outputPer1M: 25.0 },
  deepseek: { inputPer1M: 0.28, outputPer1M: 0.42 },
  openai: { inputPer1M: 0.25, outputPer1M: 2.0 },
  gemini: { inputPer1M: 0.3, outputPer1M: 2.5 },
  groq: { inputPer1M: 0.59, outputPer1M: 0.79 },
  openrouter: { inputPer1M: 0, outputPer1M: 0 },
  custom: { inputPer1M: 0, outputPer1M: 0 },
};

export interface WorkoutExercise {
  dose?: { work_seconds?: number; distance_m?: number; stroke?: string; recovery_after_last?: boolean; transition_seconds?: number };
  name: string;
  sets: number;
  reps: string;
  weight_kg: number | null;
  pace_zone: string | null;
  hr_zone: string | null;
  rest_seconds: number | null;
  notes: string;
  // Catalog metadata, present only on AI-introduced exercises that aren't in
  // the bundled library (used to auto-register them as custom exercises).
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

export interface UserProfile {
  id: string;
  display_name: string | null;
  intervals_athlete_id: string | null;
  onboarding: OnboardingData;
  onboarding_complete: boolean;
  active_llm_provider: LlmProvider;
  llm_fallback_chain: LlmProvider[];
}

// Mirrors supabase/functions/_shared/types.ts. raised_at/last_checked/status
// drive the injury follow-up loop (_shared/injury.ts); all optional, since
// profiles written before it existed carry none of them.
export interface InjuryEntry {
  area: string;
  severity: "mild" | "moderate" | "serious" | "";
  note?: string;
  raised_at?: string; // YYYY-MM-DD
  last_checked?: string; // YYYY-MM-DD
  status?: "" | "present" | "better" | "resolved";
}

// Active per-area backoff, self-expiring against the client's local date.
export interface InjuryBackoff {
  area: string;
  level: "ease" | "avoid";
  until: string; // YYYY-MM-DD, inclusive
  reason?: string;
  set_at?: string;
}

export interface OnboardingData {
  session_windows?: { day: string; slot: number; start_minute: number; max_minutes: number }[];
  minimum_session_gap_minutes?: number;
  multisport_goal?: "none" | "triathlon" | "duathlon";
  recovery_day_style?: "rest" | "mobility" | "optional_light" | "active_recovery";
  program_started_on?: string;
  periodized?: boolean;
  distance_goal_km?: Record<string, number>;
  open_water?: NonNullable<import("./prescription").SessionPrescription["open_water_checks"]>;
  calibrations?: { sport: "run" | "ride" | "swim"; kind: "power" | "heart_rate" | "pace" | "personal_best"; value: number; date: string; reliability: "measured" | "estimated" | "unknown"; distance_m?: number }[];
  prescription_engine?: "model" | "deterministic";
  primary_sport?: "run" | "ride" | "swim" | "strength";
  program_objectives?: Partial<Record<"run" | "ride" | "swim" | "strength", "fitness" | "performance" | "technique" | "strength" | "hypertrophy" | "return">>;
  venues?: Partial<Record<"run" | "ride" | "swim", "unspecified" | "road" | "trail" | "treadmill" | "indoor" | "gravel" | "mtb" | "pool" | "open_water">>;
  event_policies?: Partial<Record<"run" | "ride" | "swim" | "strength", { days: number; duration_factor: number; allow_quality: boolean }>>;
  implements?: string[];
  weekly_minutes_max?: number;
  training_history_confirmed?: boolean;
  pool?: { length: number; unit: "m" | "yd"; strokes: string[]; seconds_per_length?: number };

  goal?: string;
  experience?: "Beginner" | "Intermediate" | "Advanced";
  days?: string[];
  session_duration?: number;
  // Optional hard cap; session_duration is then a typical length and the AI
  // varies the actual duration with each session's purpose.
  session_duration_max?: number;
  equipment?: string;
  target_pace?: string;
  weekly_tss_target?: number;
  // Legacy free-text field, kept for backward compat with existing profiles.
  // New writes should use `injuries` instead; readers should go through
  // `injuriesOf()` (_shared/profile.ts) rather than reading either field
  // directly, since it falls back to parsing this string when `injuries` is unset.
  injury_history?: string;
  injuries?: InjuryEntry[];
  hr_zones?: { zone: string; min: number; max: number }[];
  // E1/E4 thresholds — feed zone derivation; shared with Android (Zones.kt).
  lthr?: number;                    // bpm
  ftp?: number;                     // watts
  threshold_pace_per_km?: string;   // "m:ss"
  // P1 periodization anchor (the A-race driving phase/taper).
  goal_date?: string;               // YYYY-MM-DD
}

export type GoalSport = "run" | "ride" | "swim" | "strength" | "other";

export interface Race {
  id: string;
  name: string;
  date: string;
  priority: "A" | "B" | "C";
  sport: GoalSport;
  distance: string | null;
  target: string | null; // free text: "4:45/km", "FTP 260W", "Squat 120kg"
  notes: string | null;
}

export interface ThresholdTest {
  id: string;
  date: string;
  kind: "lthr" | "ftp" | "threshold_pace";
  value: number;
  notes: string | null;
}

// A past activity pulled from Intervals.icu (or logged manually) into
// completed_activities. data_json holds the full Intervals object.
export interface CompletedActivity {
  planned_workout_id?: string | null;
  link_source?: string | null;
  session_state?: string;
  content_revision?: number;
  session_group_id?: string | null;
  source?: string | null;
  source_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  start_local_date?: string | null;
  end_local_date?: string | null;
  timezone_name?: string | null;
  timezone_provenance?: string;
  measurement_provenance?: Record<string,string>;
  duplicate_of?: string | null;
  duplicate_candidate_ids?: string[];
  id: string;
  intervals_id: string;
  type: string | null;
  date: string | null;
  duration_seconds: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  tss: number | null;
  ctl: number | null;
  atl: number | null;
  data_json: Record<string, unknown> | null;
}

export interface WellnessCheckin {
  id: string;
  date: string;
  energy: number;
  soreness: number;
  sleep_quality: number;
  zepp_sleep_minutes: number | null;
}

export interface PlannedWorkout {
  transition_before_seconds?: number; session_slot?: number; start_minute?: number | null; combined_group?: string | null;
  reconciliation_status?: string;
  activity_ids?: string[];
  id: string;
  date: string;
  type: "run" | "ride" | "swim" | "strength" | "rest";
  workout_json: Workout;
  llm_provider: string | null;
  llm_model: string | null;
  intervals_event_id: string | null;
  pushed_at: string | null;
  completed: boolean;
  // Added by migration 17 — a locked session is honored verbatim and excluded
  // from weekly/block re-planning. May be undefined until that migration runs.
  locked?: boolean;
  // Added by migration 26 — user pressed Skip; shown collapsed with an Undo.
  skipped?: boolean;
  created_at?: string | null;
}

export interface StrengthLog {
  id: string;
  date: string;
  exercise_name: string;
  muscle_groups: string[];
  sets: { reps: number; weight_kg: number; rpe?: number }[];
  estimated_1rm: number | null;
  notes: string | null;
}

export interface RecoveryTrend {
  // null = today's reading hasn't synced yet (shown explicitly, not back-filled).
  latest: number | null;
  baseline: number;
  deltaPct: number;
}

export interface Recovery {
  basis?: "measured" | "subjective" | "none";
  score: number;
  band: string;
  wellness: number;
  hrv?: RecoveryTrend | null;
  rhr?: RecoveryTrend | null;
  sleep?: { hours: number | null; avgHours?: number | null } | null;
  summary: string;
}

export interface GoalProgress {
  goal: string;
  goal_date?: string | null;
  weeks_to_goal?: number | null;
  phase?: string;
  ctl_trend?: number;
  on_track?: string;
}

export interface ReadinessContext { status: "unknown"|"steady"|"caution"|"pause"; score:number|null; basis:string; observations:string[]; conflicts:string[]; next_action:string; limits:string }

export interface DailySummary {
  readiness_context?: ReadinessContext;
  date: string;
  readiness: {
    decision_score?: number | null;
    score: number;
    band: "green" | "amber" | "red";
    components: { wellness: number; hrvDelta: number; rhrDelta: number };
  };
  recovery?: Recovery | null;
  vo2max?: { value: number; change?: number | null } | null;
  today_workout: PlannedWorkout | null;
  tsb_sparkline: { date: string; tsb: number; ctl: number; atl: number }[];
  weekly_load: { tss: number; target: number };
  active_llm_provider: LlmProvider;
  goal?: GoalProgress | null;
}

export interface LlmKeyStatus {
  provider: LlmProvider;
  is_valid: boolean | null;
  last_tested_at: string | null;
}

export interface GenerationLog {
  id: string;
  created_at: string;
  provider: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated_cost_usd: number | null;
  system_prompt: string;
  user_prompt: string;
  raw_response: string;
  parsed_ok: boolean;
  workout_id: string | null;
}

// Epley 1RM estimate, shared by web + Android strength trackers.
export function epley1rm(weightKg: number, reps: number): number {
  return weightKg * (1 + reps / 30);
}

// --- execution analysis (analyze-activity / analyze-strength) ---------------
// Mirrors supabase/functions/_shared/analyze_core.ts output and the Android
// models in data/Models.kt.
export interface AnalysisComponent {
  name: string;
  score: number;
  detail: string;
}

export interface AnalysisSeries {
  t: number[];
  pace: (number | null)[]; // sec/km, null while stopped
  hr: (number | null)[];
}

export interface AnalysisTarget {
  pace_lo?: number | null;
  pace_hi?: number | null;
  hr_lo?: number | null;
  hr_hi?: number | null;
}

export interface AnalysisSplit {
  km: number;
  sec: number;
  avg_hr?: number | null;
}

export interface ActivityAnalysis {
  pace_unit?: "/km" | "/100m";
  split_m?: number;
  execution_evidence?: { summary: string; sport_compatible: boolean; duration_ratio: number | null; effort_compatible: boolean | null } | null;
  ok: boolean;
  not_analyzed?: boolean; // peek miss
  score?: number | null;
  label?: string | null;
  components?: AnalysisComponent[];
  feedback?: string | null;
  feedback_provider?: string | null;
  series?: AnalysisSeries | null;
  target?: AnalysisTarget | null;
  splits?: AnalysisSplit[];
  planned_title?: string | null;
  streams_error?: string | null;
  error?: string | null;
}

export interface StrengthAnalysisExercise {
  name: string;
  actual_sets: number;
  top_weight_kg?: number | null;
  volume_kg?: number | null;
  planned?: string | null;
}

export interface StrengthAnalysisWatch {
  duration_min?: number | null;
  avg_hr?: number | null;
  tss?: number | null;
}

export interface StrengthAnalysis {
  coverage_evidence?: { exact: number; movement: number; muscle: number; total: number } | null;
  dose_evidence?: { exercise: string; planned_sets: number; logged_sets: number; sets_in_rep_range: number | null; status: string; note: string }[];
  ok: boolean;
  not_analyzed?: boolean; // peek miss
  score?: number | null;
  label?: string | null;
  components?: AnalysisComponent[];
  feedback?: string | null;
  feedback_provider?: string | null;
  exercises?: StrengthAnalysisExercise[];
  total_volume_kg?: number | null;
  total_sets?: number | null;
  watch?: StrengthAnalysisWatch | null;
  planned_title?: string | null;
  error?: string | null;
}

export interface CoachConversation {
  id: string;
  title: string | null;
  messages: { role: "user" | "assistant"; content: string }[];
  updated_at: string | null;
  pinned: boolean;
}
