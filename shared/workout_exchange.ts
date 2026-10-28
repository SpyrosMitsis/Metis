import type { SessionPrescription } from "./prescription";
export const EXCHANGE_FORMAT = "workout-maker-prescription";
export function exportPrescription(prescription: SessionPrescription): string {
  return JSON.stringify({ format: EXCHANGE_FORMAT, version: 1, prescription }, null, 2);
}
