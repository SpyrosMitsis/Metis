"use client";
import { WORKOUT_SPORTS, WORKOUT_FOCUSES, type WorkoutSportChoice } from "@shared/workout_choices";

export function WorkoutChoice({ sport, focus, onSport, onFocus, disabled = false }: {
  sport: WorkoutSportChoice; focus: string; onSport: (sport: WorkoutSportChoice) => void;
  onFocus: (focus: string) => void; disabled?: boolean;
}) {
  const style = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return <div className="grid gap-3 sm:grid-cols-2">
    <label className="text-sm">Sport
      <select className={style} value={sport} disabled={disabled} onChange={e => {
        onSport(e.target.value as WorkoutSportChoice); onFocus("");
      }}>{WORKOUT_SPORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    </label>
    {sport !== "auto" && <label className="text-sm">Session focus
      <select className={style} value={focus} disabled={disabled} onChange={e => onFocus(e.target.value)}>
        <option value="">Coach&apos;s choice</option>
        {WORKOUT_FOCUSES[sport].map(label => <option key={label} value={label}>{label}</option>)}
      </select>
    </label>}
  </div>;
}
