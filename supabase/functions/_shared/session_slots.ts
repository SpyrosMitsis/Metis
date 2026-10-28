import { minutesForDate } from "./profile.ts";
import type { Workout } from "./types.ts";

export interface SessionWindow { day: string; slot: number; start_minute: number; max_minutes: number }
export const slotKey = (date: string, slot = 0) => `${date}#${slot}`;
export const weekday = (date: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${date}T12:00:00Z`).getUTCDay()];
export function sessionWindows(o: Record<string, unknown>, date: string): SessionWindow[] {
  const values = Array.isArray(o.session_windows) ? o.session_windows as SessionWindow[] : [];
  const day = weekday(date);
  const windows = values.filter(w => w.day === day);
  if (windows.some(w => !Number.isInteger(w.slot) || w.slot < 0 || w.slot > 1 || !Number.isInteger(w.start_minute) || w.start_minute < 0 || w.start_minute >= 1440 || !Number.isFinite(w.max_minutes) || w.max_minutes <= 0 || w.start_minute + w.max_minutes > 1440) || new Set(windows.map(w => w.slot)).size !== windows.length)
    throw new Error("Session windows must have unique slots, valid local start times and positive durations");
  return windows.sort((a, b) => a.slot - b.slot);
}
export function slotMinutes(o: Record<string, unknown>, date: string, slot: number): number | null {
  const windows = sessionWindows(o, date);
  if (slot !== 0 && slot !== 1) throw new Error("Invalid session slot");
  if (slot === 1 && !windows.some(w => w.slot === 1)) throw new Error("A second session needs an explicit availability window");
  return windows.length ? windows.find(w => w.slot === slot)?.max_minutes ?? 0 : minutesForDate(o, date);
}
export interface SlottedSession { transition_before_seconds?: number; date: string; session_slot?: number; start_minute?: number | null; combined_group?: string | null; workout_json: Workout; skipped?: boolean }
export function assertDaySlots(o: Record<string, unknown>, date: string, sessions: SlottedSession[]): void {
  const active = sessions.filter(s => s.date === date && !s.skipped && s.workout_json.duration_minutes > 0);
  if (active.length > 2 || new Set(active.map(s => s.session_slot ?? 0)).size !== active.length) throw new Error("Ambiguous or excessive sessions in a day");
  const windows = sessionWindows(o, date);
  for (const s of active) {
    const limit = slotMinutes(o, date, s.session_slot ?? 0);
    if (limit !== null && s.workout_json.duration_minutes > limit + 1e-6) throw new Error("Session exceeds its availability window");
    const window = windows.find(w => w.slot === (s.session_slot ?? 0));
    if (window && s.start_minute != null && s.start_minute !== window.start_minute) throw new Error("Session start must match the confirmed window");
  }
  const total = active.reduce((sum, s) => sum + s.workout_json.duration_minutes + (s.transition_before_seconds ?? 0) / 60, 0);
  const dayCap = minutesForDate(o, date);
  if (dayCap !== null && total > dayCap + 1e-6) throw new Error("Combined sessions exceed daily availability");
  if (active.length < 2) return;
  const ordered = active.map(s => ({ ...s, start: s.start_minute ?? windows.find(w => w.slot === (s.session_slot ?? 0))?.start_minute })).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  if (ordered.some(s => s.start == null)) throw new Error("Double sessions need confirmed start times");
  const gap = ordered[1].start! - ordered[0].start! - ordered[0].workout_json.duration_minutes;
  const combined = ordered[0].combined_group && ordered[0].combined_group === ordered[1].combined_group;
  if (combined) {
    if (!["triathlon", "duathlon"].includes(String(o.multisport_goal)) || ordered.some(s => !["run", "ride", "swim"].includes(s.workout_json.type)) || ordered[0].workout_json.type === ordered[1].workout_json.type)
      throw new Error("Combined sessions require an explicit multisport goal and different endurance sports");
    if (Math.abs((ordered[1].transition_before_seconds ?? 0) - gap * 60) > 0.01 || gap < 0 || gap > 30) throw new Error("Combined-session transition must fit between zero and thirty minutes");
  } else {
    const minimum = typeof o.minimum_session_gap_minutes === "number" ? o.minimum_session_gap_minutes : 180;
    if (!Number.isFinite(minimum) || minimum < 60 || gap < minimum) throw new Error("Insufficient recovery between independent sessions");
    if (ordered.every(s => s.workout_json.rpe_target >= 7 || s.workout_json.type === "strength")) throw new Error("Two demanding independent sessions are not scheduled on the same day");
  }
}
