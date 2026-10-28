import type { TrainingSport } from "../../../shared/prescription.ts";
import type { ActualExposure } from "./session_engine.ts";

export function calendarWeek(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
/** Availability is a requested schedule; exposure controls dose, not whether
 * a person is allowed to use their selected training days at all. */
export function sportQuotas(sports: TrainingSport[], primary: TrainingSport, slots: number): Map<TrainingSport, number> {
  const result = new Map(sports.map(s => [s, 0]));
  const order = [primary, ...sports.filter(s => s !== primary)];
  for (const sport of order) if (slots > 0) { result.set(sport, 1); slots--; }
  if (slots > 0 && sports.includes("strength")) { result.set("strength", result.get("strength")! + 1); slots--; }
  while (slots-- > 0) {
    const sport = [...order].sort((a,b) => (result.get(a)! / (a === primary ? 2 : 1)) - (result.get(b)! / (b === primary ? 2 : 1)))[0];
    result.set(sport, result.get(sport)! + 1);
  }
  return result;
}
/** Several recordings on one day still occupy one ordinary training day.
 * Their minutes/effort remain separate in workload calculations. */
export function completedSlots(actual: ActualExposure[], sport: TrainingSport, week: string, capacity: (date: string) => number, excluded: Set<string>): number {
  const byDay = new Map<string, ActualExposure[]>();
  for (const a of actual) if (calendarWeek(a.date) === week && (a.minutes === null || a.minutes > 0) && !excluded.has(a.planned_workout_id ?? ""))
    byDay.set(a.date,[...(byDay.get(a.date) ?? []),a]);
  let count=0;
  for(const [date, entries] of byDay) {
    if(capacity(date) === 1) {
      const volume=new Map<string,number>();
      for(const a of entries) volume.set(a.sport,(volume.get(a.sport) ?? 0)+(a.minutes ?? 0));
      const leading=[...volume].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      if(leading === sport) count++;
    } else count+=entries.sort((a,b)=>(b.minutes ?? 0)-(a.minutes ?? 0)).slice(0,capacity(date)).filter(a=>a.sport===sport).length;
  }
  return count;
}
