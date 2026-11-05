import { stableValue } from "./plan_store.ts";
export class RestrictionEditError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
/** Preserve unknown fields and unrelated restrictions; reject stale client snapshots. */
export function editRestriction(entries: Record<string, unknown>[], body: Record<string, unknown>): Record<string, unknown>[] {
  const index = entries.findIndex(b => stableValue(b) === stableValue(body.expected));
  if (index < 0 || entries[index].area !== body.area) throw new RestrictionEditError("This restriction changed. Reload it before editing.", 409);
  if (!Array.isArray(body.sports) || body.sports.some(s => typeof s !== "string" || !["run", "ride", "swim"].includes(s))) throw new RestrictionEditError("Choose valid activities.", 400);
  if (!["ease", "avoid"].includes(String(body.level)) || typeof body.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.until) || !Number.isFinite(Date.parse(body.until)) || new Date(body.until).toISOString().slice(0,10) !== body.until) throw new RestrictionEditError("Choose a valid restriction and end date.", 400);
  return entries.map((b, i) => i === index ? { ...b, source: "user", level: body.level, until: body.until, sports: [...new Set(body.sports as string[])] } : b);
}
