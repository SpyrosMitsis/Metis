// Shared by daily-summary and weather-check so Home, Calendar, and the
// weather-swap prompt never disagree about which row is "today's" workout
// when several exist for the same date.

export interface PlannedTodayRow {
  id: string;
  type: string;
  completed: boolean;
  skipped: boolean;
  locked: boolean;
  created_at: string | null;
  workout_json: unknown;
  session_slot?: number;
  start_minute?: number | null;
}

// Still-pending before done/skipped, real work before rest, newest first.
export function pickPrimaryPlannedWorkout<T extends PlannedTodayRow>(rows: T[]): T | null {
  return [...rows].sort((a, b) => {
    const aSettled = !!a.completed || !!a.skipped;
    const bSettled = !!b.completed || !!b.skipped;
    if (aSettled !== bSettled) return aSettled ? 1 : -1;
    const aRest = a.type === "rest" ? 1 : 0;
    const bRest = b.type === "rest" ? 1 : 0;
    if (aRest !== bRest) return aRest - bRest;
    if ((a.session_slot ?? 0) !== (b.session_slot ?? 0)) return (a.session_slot ?? 0) - (b.session_slot ?? 0);
    return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
  })[0] ?? null;
}
