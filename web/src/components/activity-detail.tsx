"use client";

import { Card, CardContent } from "@/components/ui/card";
import type { CompletedActivity, PlannedWorkout } from "@shared/types";
import {
  avgCadence, avgPower, calories, displayName, distanceKm, durationMin,
  elevationGain, fmtPaceSec, isManual, looksLike, maxHr, paceSecPerKm,
} from "@/lib/activity";
import { ArrowLeft } from "lucide-react";
import { ActivityAnalysisSection } from "@/components/analysis-section";

/** Full detail panel for a past workout/run/ride — rich Intervals.icu data. */
export function ActivityDetailCard({
  activity, planned, onBack,
}: {
  activity: CompletedActivity;
  planned: PlannedWorkout | null;
  onBack: () => void;
}) {
  const km = distanceKm(activity);
  const min = durationMin(activity);
  const pace = paceSecPerKm(activity);

  const stats: [string, string][] = [];
  if (km && km > 0) stats.push(["Distance", `${km.toFixed(2)} km`]);
  if (min && min > 0) stats.push(["Duration", `${min} min`]);
  if (pace) stats.push(["Avg pace", `${fmtPaceSec(pace)} /km`]);
  if (activity.avg_hr) stats.push(["Avg HR", `${activity.avg_hr} bpm`]);
  const mhr = maxHr(activity); if (mhr) stats.push(["Max HR", `${mhr} bpm`]);
  const pw = avgPower(activity); if (pw) stats.push(["Avg power", `${pw} W`]);
  const cad = avgCadence(activity); if (cad) stats.push(["Avg cadence", `${cad}`]);
  const elev = elevationGain(activity); if (elev) stats.push(["Elevation", `${elev} m`]);
  const cal = calories(activity); if (cal) stats.push(["Calories", `${cal} kcal`]);
  if (activity.tss && activity.tss > 0) stats.push(["Training load (TSS)", `${Math.round(activity.tss)}`]);

  const matched = planned ? activity.planned_workout_id === planned.id : false;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-lg font-bold leading-tight">{displayName(activity)}</h2>
            <p className="text-xs text-muted-foreground">
              {activity.type ?? "Activity"} · {activity.date}{isManual(activity) ? " · logged manually" : ""}
            </p>
          </div>
        </div>

        <Section title="Summary">
          {stats.map(([label, value]) => <StatRow key={label} label={label} value={value} />)}
        </Section>

        {(activity.ctl != null || activity.atl != null) && (
          <Section title="Fitness after this" tint="sand">
            {activity.ctl != null && <StatRow label="Fitness (CTL)" value={activity.ctl.toFixed(0)} />}
            {activity.atl != null && <StatRow label="Fatigue (ATL)" value={activity.atl.toFixed(0)} />}
            {activity.ctl != null && activity.atl != null && (
              <StatRow label="Form (TSB)" value={(activity.ctl - activity.atl).toFixed(0)} />
            )}
          </Section>
        )}

        {planned && (
          <Section title="On the plan that day" tint="moss">
            <p className="text-sm font-medium">{planned.workout_json.title}</p>
            <p className="text-sm" style={{ color: matched ? "hsl(var(--primary))" : "hsl(var(--sand))" }}>
              {matched ? `✓ Possible match to your planned ${planned.type}.` : `You had a ${planned.type} planned but did this instead.`}
            </p>
          </Section>
        )}

        {!isManual(activity) && <ActivityAnalysisSection activityId={activity.id} />}
      </CardContent>
    </Card>
  );
}

function Section({ title, tint, children }: { title: string; tint?: "sand" | "moss"; children: React.ReactNode }) {
  const color = tint === "sand" ? "hsl(var(--sand))" : tint === "moss" ? "hsl(var(--accent))" : "hsl(var(--primary))";
  return (
    <div className="space-y-1.5">
      <p className="label-caps" style={{ color }}>{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-background/60 px-3 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
