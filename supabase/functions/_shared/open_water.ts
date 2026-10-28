export interface OpenWaterChecks {
  date: string;
  experienced: boolean;
  supervised_venue: boolean;
  buddy: boolean;
  venue_open: boolean;
  conditions_approved_by_venue: boolean;
  stroke: string;
  max_minutes: number;
}
/** Eligibility records confirmations, never an assurance of water safety.
 * No universal temperature/current limits are inferred by a language model. */
export function openWaterIssue(checks: OpenWaterChecks | undefined, date: string): string | null {
  if (!checks || checks.date !== date) return "Open-water venue and conditions need confirmation for the actual session date";
  if (![checks.experienced, checks.supervised_venue, checks.buddy, checks.venue_open, checks.conditions_approved_by_venue].every(v => v === true)) return "Open water requires prior experience, a supervised open venue, a buddy and venue-approved conditions";
  if (!Number.isFinite(checks.max_minutes) || checks.max_minutes < 10 || checks.max_minutes > 120 || !["freestyle", "breaststroke", "backstroke"].includes(checks.stroke)) return "Confirm a comfortable stroke and an explicit session limit";
  return null;
}
