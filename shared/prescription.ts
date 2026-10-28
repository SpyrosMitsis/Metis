/** Versioned, executable dose. Legacy sections are a display projection only. */
export type TrainingSport = "run" | "ride" | "swim" | "strength" | "rest";
export type SessionObjective = "easy" | "recovery" | "long" | "run_walk" | "strides" | "hills" | "tempo" | "threshold" | "intervals" | "technique" | "strength" | "hypertrophy" | "mobility" | "optional_light" | "active_recovery" | "rest";
export const SPORT_OBJECTIVES: Record<TrainingSport, readonly SessionObjective[]> = {
  run: ["easy", "long", "recovery", "run_walk", "technique", "strides", "hills", "tempo", "threshold", "intervals"],
  ride: ["easy", "recovery", "long", "tempo", "threshold", "intervals", "technique"],
  swim: ["easy", "recovery", "long", "technique", "threshold", "intervals"],
  strength: ["strength", "hypertrophy"], rest: ["rest", "mobility", "optional_light", "active_recovery"],
};
export type BlockRole = "warmup" | "main" | "cooldown";
export interface EffortTarget {
  kind: "rpe";
  min: number;
  max: number;
}
export interface NumericTarget {
  kind: "power_watts" | "heart_rate_bpm" | "pace_seconds_per_km" | "pace_seconds_per_100m";
  min: number; max: number; calibration_date: string; calibration_value: number;
  reliability: "measured"; advisory: boolean;
}
export interface EnduranceBlock {
  intensity_zone?: "Z1" | "Z2" | "Z3" | "Z4" | "Z5";
  numeric_target?: NumericTarget;
  kind: "endurance";
  role: BlockRole;
  label: string;
  repetitions: number;
  work_seconds: number;
  recovery_seconds: number;
  recovery_mode: "easy" | "walk" | "stationary";
  recovery_after_last: boolean;
  transition_seconds: number;
  target: EffortTarget;
  /** Optional distance is per repetition, never the whole set. */
  distance?: { value: number; unit: "m" | "yd" };
  stroke?: string;
  drill?: string;
}
export interface StrengthBlock {
  kind: "strength";
  role: BlockRole;
  exercise_id: string;
  name: string;
  sets: number;
  reps: number | null;
  reps_max?: number;
  distance_metres?: number;
  seconds_per_metre?: number;
  load_mode?: "added_weight" | "assistance" | "band" | "bodyweight";
  work_mode?: "repetitions" | "hold" | "carry" | "amrap";
  hold_seconds: number | null;
  seconds_per_rep: number;
  sides: 1 | 2;
  rest_seconds: number;
  transition_seconds: number;
  weight_kg: number | null;
  target: EffortTarget;
}
export interface MobilityBlock {
  kind: "mobility";
  role: BlockRole;
  name: string;
  seconds: number;
  transition_seconds: number;
}
export interface RecoveryBlock { kind: "recovery"; role: BlockRole; name: string; seconds: number; transition_seconds: number; optional: boolean; target: EffortTarget }
export type PrescriptionBlock = EnduranceBlock | StrengthBlock | MobilityBlock | RecoveryBlock;
export interface SessionPrescription {
  version: 1;
  presentation_version?: 2 | 3 | 4;
  policy_version: string;
  template_id: string;
  sport: TrainingSport;
  objective: SessionObjective;
  venue: string;
  scheduled_date?: string;
  open_water_checks?: { date: string; experienced: boolean; supervised_venue: boolean; buddy: boolean; venue_open: boolean; conditions_approved_by_venue: boolean; stroke: string; max_minutes: number };
  duration_seconds: number;
  duration_basis: "estimated" | "timed";
  distance: { value: number; unit: "m" | "yd" } | null;
  blocks: PrescriptionBlock[];
  reasons: string[];
  rejected: { template_id: string; reason: string }[];
}
