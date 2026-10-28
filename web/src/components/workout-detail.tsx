"use client";
import { exportPrescription } from "@shared/workout_exchange";
import { Button } from "@/components/ui/button";
import type { Workout } from "@shared/types";
import { Badge } from "@/components/ui/badge";

export function WorkoutDetail({ workout }: { workout: Workout }) {
  const strengthGroups = new Map<string, { exercise: Workout["sections"][number]["exercises"][number]; warmup: boolean }[]>();
  if (workout.type === "strength") for (const section of workout.sections) for (const exercise of section.exercises) {
    const doses = strengthGroups.get(exercise.name) ?? [];
    doses.push({ exercise, warmup: /^(warm.?up|activation)\b/i.test(section.name) });
    strengthGroups.set(exercise.name, doses);
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={workout.type === "run" ? "success" : workout.type === "strength" ? "warning" : "outline"}>
          {workout.type}
        </Badge>
        <span className="text-sm text-muted-foreground">{Math.round(workout.duration_minutes * 10) / 10} min</span>
        <span className="text-sm text-muted-foreground">RPE {workout.rpe_target}</span>
        <span className="text-sm text-muted-foreground">~{Math.round(workout.tss_estimate)} TSS</span>
      </div>

      {workout.prescription && <Button variant="outline" size="sm" onClick={() => {
        const url = URL.createObjectURL(new Blob([exportPrescription(workout.prescription!)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "workout-prescription.json"; link.click(); URL.revokeObjectURL(url);
      }}>Download workout (.json)</Button>}
      {workout.coach_note && (
        <p className="rounded-md bg-secondary/50 p-3 text-sm italic text-muted-foreground">
          “{workout.coach_note}”
        </p>
      )}

      <div className="space-y-4">
        {workout.type === "strength" ? <>
          <p className="text-sm text-muted-foreground">{strengthGroups.size} exercises</p>
          {[...strengthGroups].map(([name, doses]) => <div key={name} className="rounded-lg border p-3">
            <h4 className="font-medium">{name}</h4>
            {doses.map(({ exercise: ex, warmup }, i) => <p key={i} className="mt-1 text-sm text-muted-foreground">
              {warmup ? "Warm-up" : "Working sets"} · {ex.sets} × {ex.reps}
              {ex.weight_kg != null && ` · ${ex.weight_kg} kg`}{ex.rest_seconds != null && ` · ${ex.rest_seconds}s rest`}
            </p>)}
            <details className="mt-2 text-xs text-muted-foreground"><summary>Exercise notes</summary>
              {doses.map(({ exercise: ex }, i) => <p key={i} className="mt-1">{ex.notes}</p>)}
            </details>
          </div>)}
        </> : workout.sections.map((section, i) => (
          <div key={i}>
            <div className="mb-1.5 flex items-baseline justify-between">
              <h4 className="text-sm font-semibold">{section.name}</h4>
              <span className="text-xs text-muted-foreground">{Math.round(section.duration_minutes * 10) / 10} min</span>
            </div>
            <ul className="space-y-1.5">
              {section.exercises.map((ex, j) => (
                <li key={j} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{ex.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {ex.sets > 0 && ex.reps ? `${ex.sets} × ${ex.reps}` : ex.reps}
                      {ex.weight_kg != null && ` · ${ex.weight_kg}kg`}
                      {ex.pace_zone && ` · pace ${ex.pace_zone}`}
                      {ex.hr_zone && ` · HR ${ex.hr_zone}`}
                      {ex.rest_seconds != null && ` · ${ex.rest_seconds}s rest`}
                    </span>
                  </div>
                  {ex.notes && <p className="mt-0.5 text-xs text-muted-foreground">{ex.notes}</p>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
