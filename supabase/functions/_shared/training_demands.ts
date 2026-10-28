import type { TrainingSport } from "../../../shared/prescription.ts";
import type { ActualExposure } from "./session_engine.ts";
import type { Workout } from "./types.ts";

export type TrainingDemand = "lower_body" | "upper_body" | "impact" | "systemic";
export function sportDemands(sport: string): TrainingDemand[] {
  if (sport === "run" || sport === "hike") return ["lower_body", "impact", "systemic"];
  if (sport === "ride") return ["lower_body", "systemic"];
  if (["swim", "rowing"].includes(sport)) return ["upper_body", "systemic"];
  if (sport === "strength") return ["lower_body", "upper_body", "systemic"];
  return ["systemic"]; // Unknown load remains visible; no specific mechanics inferred.
}
export function demandingWorkout(w: Workout): boolean {
  return w.type === "strength" || w.rpe_target >= 7 || !!w.prescription && ["long", "tempo", "threshold", "intervals", "hills", "strides"].includes(w.prescription.objective);
}
export function overlapReason(date: string, sport: TrainingSport, demanding: boolean,
  actual: ActualExposure[], planned: { date: string; workout: Workout }[]): string | null {
  const relevant = new Set<TrainingDemand>(sportDemands(sport).filter(d => d !== "systemic"));
  const near = (other: string) => Math.abs(Date.parse(date) - Date.parse(other)) < 2 * 86400000;
  const history = actual.filter(a => near(a.date) && (a.effort !== null && a.effort >= 7 || a.response === "difficult" || a.response === "pain"));
  if (demanding && history.length) return `Recent demanding ${history[0].sport} influences shared recovery; it does not count as ${sport}-specific work.`;
  for (const session of planned) {
    if (!near(session.date) || !demandingWorkout(session.workout)) continue;
    const overlap = sportDemands(session.workout.type).some(d => relevant.has(d));
    if (demanding && overlap) return `${sport} overlaps with demanding ${session.workout.type} on ${session.date}; preserve recovery between sessions.`;
  }
  return null;
}
