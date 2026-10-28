import {
  computeRecovery,
  type SeriesPoint,
  type WellnessRow,
} from "./recovery.ts";
import type { ActualExposure } from "./session_engine.ts";
export function readinessContext(
  date: string,
  wellness: WellnessRow[],
  actual: ActualExposure[],
  holds: { reason: string }[] = [],
  hrv: SeriesPoint[] = [],
  rhr: SeriesPoint[] = [],
) {
  const recovery = computeRecovery(wellness, hrv, rhr, date);
  const today = wellness.find((w) => w.date === date);
  const recentHard = actual.filter((a) => {
    const age = (Date.parse(date) - Date.parse(a.date)) / 86400000;
    return age >= 0 && age < 2 &&
      (a.effort != null && a.effort >= 7 || a.response === "difficult" ||
        a.response === "pain");
  });
  const subjectiveCaution = !!today &&
    (today.energy != null && today.energy <= 2 ||
      today.soreness != null && today.soreness >= 4);
  const measuredCaution =
    recovery.drivers.filter((d) => d.tone === "bad").length >= 2;
  const unknown = recovery.basis === "none" && !recentHard.length &&
    !holds.length;
  const status = holds.length
    ? "pause"
    : subjectiveCaution || measuredCaution || recentHard.length
    ? "caution"
    : unknown
    ? "unknown"
    : "steady";
  const conflicts =
    subjectiveCaution && recovery.drivers.some((d) => d.tone === "good")
      ? [
        "How you feel and device trends differ. Retain both; a favorable device trend does not override symptoms.",
      ]
      : [];
  if (actual.some((a) => a.effort_conflict)) {
    conflicts.push(
      "Athlete and provider effort reports disagree. Both remain visible; no progression is authorized by the lower value alone.",
    );
  }
  return {
    version: 1,
    status,
    score: recovery.basis === "none" ? null : recovery.score,
    basis: recovery.basis,
    recovery,
    conflicts,
    observations: [
      ...recovery.drivers.map((d) => `${d.label}: ${d.dir}`),
      ...(recentHard.length
        ? [
          "Recent demanding actual work affects shared recovery; it does not establish another sport's exposure.",
        ]
        : []),
      ...holds.map((h) => `Active ${h.reason} planning hold.`),
    ],
    next_action: status === "pause"
      ? "Keep affected training paused until you review and clear the hold."
      : status === "caution"
      ? "Favor familiar easy work and reassess your response."
      : status === "unknown"
      ? "Use familiar training; no readiness measurement is available."
      : "Use the planned dose and adjust to your response.",
    limits:
      "Readiness and load ratios describe observations, not diagnoses or precise injury probabilities.",
  };
}
