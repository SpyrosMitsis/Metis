import { z } from "npm:zod@3.23.8";
import { PrescriptionSchema, prescriptionWorkout } from "./prescription.ts";

/** Lossless interchange retains target provenance, yards, repetitions and
 * separate recovery intervals. Provider text is a narrower transport view. */
export function importPrescription(json: string) {
  const value = z.object({ format: z.literal("workout-maker-prescription"), version: z.literal(1), prescription: PrescriptionSchema }).parse(JSON.parse(json));
  return prescriptionWorkout(value.prescription);
}
export interface TransportStep { zone?: number; zone_basis?: "Pace" | "HR"; seconds?: number; metres?: number; power_watts?: [number, number]; pace_seconds?: [number, number]; pace_unit?: "km" | "100m" }
export function parseIntervalsSteps(text: string): TransportStep[] {
  const result: TransportStep[] = [];
  const clock = (minutes: string, seconds: string) => Number(minutes) * 60 + Number(seconds);
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("- ")) continue;
    const m = /^- (\d+(?:\.\d+)?)(s|mtr)(?:\s+(.*))?$/.exec(line);
    if (!m || !Number.isFinite(Number(m[1])) || Number(m[1]) <= 0) throw new Error("Unsupported or invalid provider step; use explicit seconds/metres");
    const step: TransportStep = m[2] === "s" ? { seconds: Number(m[1]) } : { metres: Number(m[1]) };
    const target = m[3] ?? "";
    const zone = /^Z([1-5]) (Pace|HR)$/.exec(target);
    const power = /^(\d+)(?:-(\d+))?w$/.exec(target);
    const pace = /^(\d+):([0-5]\d)(?:-(\d+):([0-5]\d))?\/(km|100m) Pace$/.exec(target);
    if (zone) { step.zone = Number(zone[1]); step.zone_basis = zone[2] as "Pace" | "HR"; }
    else if (power) step.power_watts = [Number(power[1]), Number(power[2] ?? power[1])];
    else if (pace) {
      step.pace_unit = pace[5] as "km" | "100m";
      step.pace_seconds = [clock(pace[1], pace[2]), pace[3] ? clock(pace[3], pace[4]) : clock(pace[1], pace[2])];
    } else if (target && target !== "freeride" && target !== "intensity=rest") throw new Error("Unsupported provider target");
    result.push(step);
  }
  return result;
}
