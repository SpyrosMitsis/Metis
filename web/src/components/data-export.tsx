"use client";

// Export your data: strength sessions as CSV (Strong/Hevy-style columns),
// activities as CSV, and the full training plan as JSON. Everything is
// fetched RLS-scoped client-side and downloaded as a file — no lock-in.

import { useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
}

const stamp = () => new Date().toISOString().slice(0, 10);

export function DataExport() {
  const supabase = createClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exportStrength = () =>
    run("strength", async () => {
      const { data: workouts, error: e1 } = await supabase
        .from("strength_workouts").select("*").order("started_at", { ascending: true });
      if (e1) throw e1;
      const ids = (workouts ?? []).map((w) => w.id);
      const sets = ids.length
        ? (await supabase.from("strength_workout_sets").select("*").in("workout_id", ids)).data ?? []
        : [];
      const byWorkout = new Map<string, typeof sets>();
      for (const s of sets) {
        const arr = byWorkout.get(s.workout_id) ?? [];
        arr.push(s);
        byWorkout.set(s.workout_id, arr);
      }
      const rows: unknown[][] = [];
      for (const w of workouts ?? []) {
        const date = new Date(w.started_at).toISOString().replace("T", " ").slice(0, 16);
        for (const s of (byWorkout.get(w.id) ?? []).sort((a, b) => a.idx - b.idx)) {
          rows.push([date, w.name, s.exercise_name, s.muscle, s.idx + 1, s.weight_kg, s.reps, s.rpe ?? "", s.is_warmup ? 1 : 0]);
        }
      }
      download(`strength-${stamp()}.csv`,
        toCsv(["Date", "Workout Name", "Exercise Name", "Muscle", "Set Order", "Weight (kg)", "Reps", "RPE", "Warmup"], rows),
        "text/csv");
    });

  const exportActivities = () =>
    run("activities", async () => {
      const { data, error: e } = await supabase
        .from("effective_activities").select("*").order("date", { ascending: true });
      if (e) throw e;
      const rows = (data ?? []).map((a) => [
        a.date, a.type, a.name ?? "", a.distance_m ?? "", a.duration_seconds ?? "", a.avg_hr ?? "", a.tss ?? "", a.ctl ?? "", a.atl ?? "",
      ]);
      download(`activities-${stamp()}.csv`,
        toCsv(["Date", "Type", "Name", "Distance (m)", "Duration (s)", "Avg HR", "TSS", "CTL", "ATL"], rows),
        "text/csv");
    });

  const exportPlan = () =>
    run("plan", async () => {
      const [{ data: planned }, { data: weeks }, { data: races }] = await Promise.all([
        supabase.from("planned_workouts").select("*").order("date", { ascending: true }),
        supabase.from("week_plans").select("*").order("start_date", { ascending: true }),
        supabase.from("races").select("*").order("date", { ascending: true }),
      ]);
      download(`training-plan-${stamp()}.json`,
        JSON.stringify({ exported_at: new Date().toISOString(), planned_workouts: planned ?? [], week_plans: weeks ?? [], races: races ?? [] }, null, 2),
        "application/json");
    });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Export your data</CardTitle>
        <CardDescription>Your data is yours, download it anytime.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button variant="outline" className="w-full justify-start" disabled={busy !== null} onClick={exportStrength}>
          <Download className="h-4 w-4" /> {busy === "strength" ? "Exporting…" : "Strength sessions (CSV)"}
        </Button>
        <Button variant="outline" className="w-full justify-start" disabled={busy !== null} onClick={exportActivities}>
          <Download className="h-4 w-4" /> {busy === "activities" ? "Exporting…" : "Activities (CSV)"}
        </Button>
        <Button variant="outline" className="w-full justify-start" disabled={busy !== null} onClick={exportPlan}>
          <Download className="h-4 w-4" /> {busy === "plan" ? "Exporting…" : "Training plan + races (JSON)"}
        </Button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}
