import { PlanError } from "./plan_store.ts";

/** Adjustments keep the original sport unless the athlete explicitly switches. */
export function requestedWorkoutSport(body: { type?: unknown; adjustment?: unknown; base_workout?: { type?: unknown } }): string {
  const type = body.type ?? "auto";
  if (!["auto", "run", "ride", "swim", "strength", "rest"].includes(String(type)))
    throw new PlanError("Choose a supported workout sport", 400, "INVALID_SPORT");
  if (type !== "auto") return String(type);
  const base = body.base_workout?.type;
  return body.adjustment && ["run", "ride", "swim", "strength", "rest"].includes(String(base)) ? String(base) : "auto";
}
