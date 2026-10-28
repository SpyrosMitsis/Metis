import type { EnduranceBlock, NumericTarget, SessionObjective } from "../../../shared/prescription.ts";
import type { Calibration, SessionState } from "./session_engine.ts";

export const TARGET_POLICY = { version: "targets-1", maxAgeDays: 90 };
export function currentCalibration(c: Calibration, state: SessionState): boolean {
  const age = (Date.parse(state.date) - Date.parse(c.date)) / 86400000;
  return c.kind !== "personal_best" && c.sport === state.sport && c.reliability === "measured" && c.value > 0 && Number.isFinite(c.value) &&
    age >= 0 && age <= TARGET_POLICY.maxAgeDays && new Date(c.date).toISOString().slice(0,10) === c.date &&
    (c.kind !== "heart_rate" || c.value >= 60 && c.value <= 240) && (c.kind !== "power" || c.value >= 20 && c.value <= 2000) &&
    (c.kind !== "power" || state.implements.includes("power_meter")) &&
    (c.kind !== "heart_rate" || state.implements.includes("heart_rate_monitor"));
}
/** Power bands follow Coggan's published training levels. Pace/HR bands are
 * explicit versioned prescription ranges, never transferred between sports.
 * Terrain and heat disable numerical pace guidance; RPE always remains valid. */
export function selectNumericTarget(state: SessionState, objective: SessionObjective, b: EnduranceBlock): NumericTarget | undefined {
  const calibrations = (state.calibration ?? []).filter(c => currentCalibration(c, state)).sort((a, z) => z.date.localeCompare(a.date));
  const zone = intendedZone(b, objective);
  const easy = zone === "Z1" || zone === "Z2";
  const c = state.sport === "ride" ? calibrations.find(c => c.kind === "power") ?? calibrations.find(c => c.kind === "heart_rate") :
    calibrations.find(c => c.kind === "pace") ?? calibrations.find(c => c.kind === "heart_rate");
  if (!c) return;
  let range: number[], kind: NumericTarget["kind"];
  if (c.kind === "power") {
    range = {Z1:[0.4,0.55],Z2:[0.56,0.75],Z3:[0.76,0.9],Z4:[0.91,1.05],Z5:[1.06,1.2]}[zone];
    kind = "power_watts";
  } else if (c.kind === "heart_rate") {
    // Short intervals cannot be paced by lagging HR. Use effort instead.
    if (!easy && b.work_seconds < 180) return;
    range = {Z1:[0.65,0.84],Z2:[0.85,0.89],Z3:[0.90,0.94],Z4:[0.95,0.99],Z5:[1.0,1.08]}[zone];
    kind = "heart_rate_bpm";
  } else {
    if (state.sport === "run" && (!(["road", "treadmill"].includes(state.venue)) || state.conditions?.tier === "caution" || ["hills", "strides", "technique"].includes(objective))) return;
    if (state.sport === "swim" && state.venue !== "pool") return;
    range = {Z1:[1.15,1.30],Z2:[1.06,1.15],Z3:[1.01,1.06],Z4:[0.97,1.01],Z5:[0.88,0.97]}[zone];
    kind = state.sport === "swim" ? "pace_seconds_per_100m" : "pace_seconds_per_km";
  }
  return { kind, min: Math.round(c.value * range[0]), max: Math.round(c.value * range[1]), calibration_date: c.date,
    calibration_value: c.value, reliability: "measured", advisory: state.venue !== "indoor" && state.venue !== "treadmill" };
}
/** Intended training zone, not a claim that measured HR equals an RPE. */
export function intendedZone(b: EnduranceBlock, objective: SessionObjective): NonNullable<EnduranceBlock["intensity_zone"]> {
  if (b.role !== "main" || b.target.max <= 2) return "Z1";
  if (b.target.max <= 4) return "Z2";
  return b.target.max >= 8 ? "Z5" : b.target.max >= 7 ? "Z4" : "Z3";
}
export function calibratedBlocks(state: SessionState, objective: SessionObjective, blocks: EnduranceBlock[]): EnduranceBlock[] {
  return blocks.map(b => { const target = selectNumericTarget(state, objective, b); return { ...b, intensity_zone: intendedZone(b, objective), ...(target ? { numeric_target: target } : {}) }; });
}
