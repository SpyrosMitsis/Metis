"use client";
import { SessionFeedbackPanel } from "@/components/session-feedback-panel";

import { Card, CardContent } from "@/components/ui/card";
import type { CompletedActivity, PlannedWorkout } from "@shared/types";
import {
  avgCadence, avgPower, calories, displayName, distanceKm, durationMin,
  elevationGain, fmtPaceSec, isManual, looksLike, maxHr, paceSecPerKm,
} from "@/lib/activity";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase-browser";
import { Button } from "@/components/ui/button";
import { ActivityAnalysisSection } from "@/components/analysis-section";

/** Full detail panel for a past workout/run/ride — rich Intervals.icu data. */
export function ActivityDetailCard({
  activity, planned, plans = [], activities = [], onBack, onCorrect,
}: {
  activity: CompletedActivity;
  planned: PlannedWorkout | null;
  plans?: PlannedWorkout[];
  activities?: CompletedActivity[];
  onBack: () => void;
  onCorrect?: () => void;
}) {
  const supabase = createClient();
  const [planId,setPlanId] = useState(activity.planned_workout_id ?? planned?.id ?? "");
  const [state,setState] = useState(activity.session_state ?? "unknown");
  const [type,setType] = useState(activity.type ?? "");
  const [duplicate,setDuplicate] = useState("");
  const [unmerge,setUnmerge] = useState("");
  const [group,setGroup] = useState(activity.session_group_id ?? activity.id);
  const [message,setMessage] = useState("");
  const [saving,setSaving] = useState(false);
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

        <SessionFeedbackPanel key={activity.id} date={activity.date ?? new Date().toLocaleDateString("sv-SE")} planId={activity.planned_workout_id ?? undefined} activityId={activity.id} />

        <Section title="Plan matching" tint="moss">
          {planned && <p className="text-sm font-medium">{planned.workout_json.title}</p>}
          <p className="text-sm">{activity.link_source === "athlete" ? `Your assessment: ${activity.session_state?.replaceAll("_"," ")}.` : matched ? "Possible same-sport match. Completion and dose are unconfirmed." : "No confirmed plan link."}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">Linked plan
              <select className="mt-1 w-full rounded-md border bg-background p-2" value={planId} onChange={e=>setPlanId(e.target.value)}>
                <option value="">No plan</option>{plans.map(p=><option key={p.id} value={p.id}>{p.date} · {p.type} · {p.workout_json.title}</option>)}
              </select>
            </label>
            <label className="text-xs">What happened
              <select className="mt-1 w-full rounded-md border bg-background p-2" value={state} onChange={e=>{setState(e.target.value);if(e.target.value==="unplanned")setPlanId("");}}>
                <option value="unknown">Unknown / not confirmed</option><option value="completed_as_planned">Completed as planned</option>
                <option value="modified">Modified</option><option value="substituted">Substituted</option><option value="unplanned">Unplanned activity</option>
              </select>
            </label>
            <label className="text-xs">Correct activity type
              <select className="mt-1 w-full rounded-md border bg-background p-2" value={type} onChange={e=>setType(e.target.value)}>
                {["Run","Ride","Swim","Weight training","Walk","Hike","Rowing","Other"].map(x=><option key={x} value={x}>{x}</option>)}
              </select>
            </label>
            <label className="text-xs">Duplicate source record
              <select className="mt-1 w-full rounded-md border bg-background p-2" value={duplicate} onChange={e=>{setDuplicate(e.target.value);if(e.target.value){setPlanId("");setState("unknown");}}}>
                <option value="">Keep as separate session</option>{activities.filter(a=>a.id!==activity.id).map(a=><option key={a.id} value={a.id}>{a.type} · {a.date} · {a.duration_seconds ? Math.round(a.duration_seconds/60)+" min" : a.id.slice(0,8)}</option>)}
              </select>
            </label>
            {activity.duplicate_candidate_ids?.length ? <label className="text-xs">Restore a possibly hidden duplicate
              <select className="mt-1 w-full rounded-md border bg-background p-2" value={unmerge} onChange={e=>setUnmerge(e.target.value)}>
                <option value="">Keep hidden</option>{activity.duplicate_candidate_ids.map(id=><option key={id} value={id}>Restore source record {id.slice(0,8)}</option>)}
              </select>
            </label> : null}
            <label className="text-xs">Part of session
              <select className="mt-1 w-full rounded-md border bg-background p-2" value={group} onChange={e=>setGroup(e.target.value)}>
                {activities.map(a=><option key={a.id} value={a.session_group_id ?? a.id}>{a.id===activity.id?"Separate session":`${a.type} · ${a.date} · ${a.id.slice(0,8)}`}</option>)}
              </select>
            </label>
          </div>
          <Button size="sm" disabled={saving} onClick={async()=>{
            setSaving(true);setMessage("");
            const {error}=await supabase.rpc("correct_session",{p_activity:activity.id,p_plan:planId||null,p_state:state,p_type:type,p_duplicate:duplicate||null,p_group:group||null,p_revision:activity.content_revision??1,p_unmerge:unmerge||null});
            setSaving(false);
            if(error){setMessage(error.message);return;}
            setMessage("Saved. Training totals and plan matching updated.");onCorrect?.();
          }}>{saving?"Saving…":"Save correction"}</Button>
          {message&&<p className="text-xs text-muted-foreground">{message}</p>}
        </Section>

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
