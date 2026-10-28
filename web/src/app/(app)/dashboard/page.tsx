"use client";

import { useMemo, useState } from "react";
import { WorkoutChoice } from "@/components/workout-choice";
import { workoutChoiceRequest, type WorkoutSportChoice } from "@shared/workout_choices";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, localDateIso } from "@/lib/api";
import { createClient } from "@/lib/supabase-browser";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ReadinessRing } from "@/components/charts/readiness-ring";
import { FitnessChart } from "@/components/charts/fitness-chart";
import { WorkoutDetail } from "@/components/workout-detail";
import { WellnessCheckin } from "@/components/wellness-checkin";
import { ActivityDetailCard } from "@/components/activity-detail";
import { PROVIDER_LABELS, type CompletedActivity, type DailySummary } from "@shared/types";
import { activityMeta, displayName } from "@/lib/activity";
import { ChevronDown, ChevronRight, ChevronUp, RefreshCw, Sparkles } from "lucide-react";

function readinessHeadline(band: string): string {
  switch (band) {
    case "green": return "Ready to train";
    case "amber": return "Train with care";
    default: return "Prioritize recovery";
  }
}

function hoursToHm(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh}h ${String(mm).padStart(2, "0")}m`;
}

const tsbLabel = (tsb: number) =>
  tsb > 15 ? "fresh" : tsb > 5 ? "ready" : tsb < -20 ? "high fatigue" : tsb < -10 ? "building" : "neutral";

export default function DashboardPage() {
  const qc = useQueryClient();
  const supabase = createClient();
  const summary = useQuery({ queryKey: ["daily-summary"], queryFn: api.dailySummary });
  // 90-day CTL/ATL curve from Intervals.icu — the same source the Android Home
  // chart uses. Falls back to the 14d sparkline points when not connected.
  const stats = useQuery({ queryKey: ["intervals-stats"], queryFn: api.intervalsStats });
  const [showDetails, setShowDetails] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [workoutSport, setWorkoutSport] = useState<WorkoutSportChoice>("auto");
  const [workoutFocus, setWorkoutFocus] = useState("");
  const [didIt, setDidIt] = useState(false);
  const [rpe, setRpe] = useState<number | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [openActivity, setOpenActivity] = useState<CompletedActivity | null>(null);

  // Recent activities — same list the Android Home shows under the fitness card.
  const recent = useQuery({
    queryKey: ["recent-activities"],
    queryFn: async () => {
      const since = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
      const { data } = await supabase
        .from("effective_activities").select("*")
        .gte("date", since).order("date", { ascending: false }).limit(8);
      return (data ?? []) as CompletedActivity[];
    },
  });

  const reload = () => {
    qc.invalidateQueries({ queryKey: ["daily-summary"] });
    qc.invalidateQueries({ queryKey: ["recent-activities"] });
  };

  const sync = useMutation({ mutationFn: api.syncIntervals, onSuccess: reload });

  // Unified regenerate: if a workout exists and the user typed a tweak, revise
  // it with that instruction; otherwise generate a fresh one.
  const generate = useMutation({
    mutationFn: (vars: { base?: DailySummary["today_workout"]; tweak: string }) =>
      vars.base && vars.tweak.trim()
        ? api.generateWorkout({ type: workoutSport, adjustment: vars.tweak.trim(), base_workout: vars.base.workout_json, push: true })
        : api.generateWorkout({ type: workoutSport, request: vars.tweak.trim() || undefined }),
    onSuccess: () => { setInstruction(""); reload(); },
  });

  // #1 parity: done/skip + difficulty + RPE rating that adapts the next workout.
  const feedback = useMutation({
    mutationFn: async (vars: { completed: boolean; difficulty: string | null; rpe?: number | null }) => {
      const today = summary.data?.today_workout;
      const date = localDateIso();
      const row = {
        date, completed: vars.completed, difficulty: vars.difficulty, actual_rpe: vars.rpe ?? null,
      };
      if (today?.id) {
        const { error } = await supabase.from("planned_workouts")
          .update({ completed: vars.completed, skipped: !vars.completed }).eq("id", today.id);
        // Pre-migration-26 fallback: no `skipped` column yet.
        if (error) await supabase.from("planned_workouts").update({ completed: vars.completed }).eq("id", today.id);
        const { error: fbErr } = await supabase.from("workout_feedback").insert({ ...row, planned_workout_id: today.id });
        if (fbErr) throw fbErr;
      } else {
        const { error: fbErr } = await supabase.from("workout_feedback").insert(row);
        if (fbErr) throw fbErr;
      }
    },
    onSuccess: (_d, vars) => {
      setFeedbackStatus(vars.completed ? "✓ Marked done, your next workout will adapt." : null);
      setDidIt(false);
      setRpe(null);
      reload();
    },
    onError: (e) => setFeedbackStatus((e as Error).message),
  });

  // Skipped by mistake (or changed your mind): restore the card and drop the
  // skip feedback so the planner doesn't count it against you.
  const undoSkip = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("planned_workouts").update({ skipped: false }).eq("id", id);
      if (error) throw error;
      await supabase.from("workout_feedback").delete().eq("planned_workout_id", id).eq("completed", false);
    },
    onSuccess: () => { setFeedbackStatus(null); reload(); },
    onError: (e) => setFeedbackStatus((e as Error).message),
  });

  // Load guardrail (E3 parity) from the CTL/ATL sparkline.
  const loadGuard = useMemo(() => {
    const live = stats.data?.summary;
    const pts = summary.data?.tsb_sparkline ?? [];
    const last = live ?? pts[pts.length - 1];
    if (!last || last.ctl < 1) return null;
    const ratio = last.atl / last.ctl;
    const weekAgo = pts[Math.max(0, pts.length - 8)];
    const ramp = live?.ramp ?? (last.ctl - (weekAgo?.ctl ?? last.ctl));
    if (ratio >= 1.5) return { color: "hsl(var(--sand))", headline: "Recent recorded load is higher", detail: `ATL/CTL ratio ${ratio.toFixed(2)} describes modeled load, not individual injury risk. Review actual training and how you feel.` };
    if (ratio >= 1.3 || ramp >= 8) return { color: "hsl(var(--sand))", headline: "Recorded load is increasing", detail: `Ratio ${ratio.toFixed(2)}, ramp ${ramp >= 0 ? "+" : ""}${ramp.toFixed(1)}. Interpret this with actual training and your response.` };
    if (ratio < 0.8 && ramp < 0) return { color: "hsl(var(--sand))", headline: "Recent recorded load is lower", detail: `Ratio ${ratio.toFixed(2)} may reflect rest, changed plans or missing recordings. Do not add work just to raise it.` };
    return { color: "hsl(var(--primary))", headline: "Recorded load context", detail: `ATL/CTL ratio ${ratio.toFixed(2)} does not establish training quality or recovery.` };
  }, [summary.data, stats.data]);

  if (summary.isLoading) return <Skeleton />;
  if (summary.isError) {
    return <p className="text-sm text-red-400">Failed to load: {(summary.error as Error).message}</p>;
  }
  const d = summary.data!;
  const rec = d.recovery;
  const band = rec?.band ?? d.readiness.band;
  const score = rec?.score ?? d.readiness.score;
  const last = d.tsb_sparkline[d.tsb_sparkline.length - 1];
  const weekAgoPt = d.tsb_sparkline[Math.max(0, d.tsb_sparkline.length - 8)];
  const fit = stats.data?.summary ??
    (last ? { ...last, ramp: last.ctl - (weekAgoPt?.ctl ?? last.ctl) } : null);

  if (openActivity) {
    return (
      <ActivityDetailCard activity={openActivity} planned={null} onBack={() => setOpenActivity(null)} />
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Today</h1>
          <p className="text-sm text-muted-foreground">{d.date}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{PROVIDER_LABELS[d.active_llm_provider]}</Badge>
          <Button size="icon" variant="ghost" onClick={() => sync.mutate()} disabled={sync.isPending}>
            <RefreshCw className={sync.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
        </div>
      </header>

      <WellnessCheckin />

      {/* Readiness, summary by default; the signals live behind "Details". */}
      <Card>
        <CardContent className="space-y-2 pt-5">
          <div className="flex items-center gap-5">
            {rec?.basis==="none"||d.readiness_context?.status==="pause"?<div className="text-3xl text-muted-foreground" aria-label="Readiness not measured">—</div>:<ReadinessRing score={score} band={band as "green" | "amber" | "red"} />}
            <div className="space-y-1">
              <p className="font-semibold">{d.readiness_context?.status==="pause"?"Affected training on hold":d.readiness_context?.status==="caution"?"Review today’s training load":rec?.basis==="none"?"Readiness not measured":readinessHeadline(band)}</p>
              {(d.readiness_context?.next_action||rec?.summary)&&<p className="text-sm text-muted-foreground">{d.readiness_context?.next_action??rec?.summary}</p>}{d.readiness_context?.conflicts.map((s,i)=><p key={i} className="text-xs text-muted-foreground">{s}</p>)}
            </div>
          </div>
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {showDetails ? "Hide details" : "Details"}
            {showDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showDetails && (
            <div className="space-y-1.5 pt-1">
              {rec?.hrv && (
                rec.hrv.latest != null ? (
                  <MetricRow
                    label="HRV" value={`${rec.hrv.latest.toFixed(0)} ms`}
                    trendLabel={`${rec.hrv.deltaPct >= 0 ? "↑" : "↓"}${Math.abs(rec.hrv.deltaPct * 100).toFixed(0)}%`}
                    good={rec.hrv.deltaPct >= 0}
                  />
                ) : (
                  <MetricRow label="HRV" value="No reading today" />
                )
              )}
              {rec?.rhr && (
                rec.rhr.latest != null ? (
                  <MetricRow
                    label="Resting HR" value={`${rec.rhr.latest.toFixed(0)} bpm`}
                    trendLabel={`${rec.rhr.deltaPct >= 0 ? "↑" : "↓"}${Math.abs(rec.rhr.deltaPct * 100).toFixed(0)}%`}
                    good={rec.rhr.deltaPct <= 0}
                  />
                ) : (
                  <MetricRow label="Resting HR" value="No reading today" />
                )
              )}
              {rec?.sleep && (
                <MetricRow label="Sleep" value={(rec.sleep.hours != null ? hoursToHm(rec.sleep.hours) : "No data today") + (rec.sleep.avgHours ? ` · avg ${hoursToHm(rec.sleep.avgHours)}` : "")} />
              )}
              <MetricRow label="Wellness" value={`${(rec?.wellness ?? d.readiness.components.wellness).toFixed(1)} / 5`} />
              <MetricRow label="Weekly load" value={`${d.weekly_load.tss} / ${d.weekly_load.target} TSS`} />
              {d.vo2max && (
                <MetricRow
                  label="VO₂ max" value={`${d.vo2max.value.toFixed(1)} ml/kg/min`}
                  trendLabel={d.vo2max.change != null && Math.abs(d.vo2max.change) >= 0.1
                    ? `${d.vo2max.change > 0 ? "↑" : "↓"}${Math.abs(d.vo2max.change).toFixed(1)}` : undefined}
                  good={(d.vo2max.change ?? 0) >= 0}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Goal countdown */}
      {d.goal && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Goal · {d.goal.goal}</CardTitle></CardHeader>
          <CardContent className="flex items-center justify-between">
            <div>
              <p className="font-semibold">
                {(() => {
                  const days = d.goal!.goal_date
                    ? Math.round((new Date(d.goal!.goal_date + "T00:00:00").getTime() - Date.now()) / 86400000)
                    : null;
                  if (days != null && days > 0) return `${days} days to go`;
                  if (days === 0) return "Race day! 🏁";
                  if (d.goal!.weeks_to_goal != null) return `${d.goal!.weeks_to_goal} weeks to go`;
                  return "No date set";
                })()}
              </p>
              {d.goal.phase && <p className="text-sm text-muted-foreground">Phase: {d.goal.phase}</p>}
            </div>
            {d.goal.on_track && <Badge variant="outline">{d.goal.on_track}</Badge>}
          </CardContent>
        </Card>
      )}

      {/* Today's workout with tweak-regenerate + done/skip/rating */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Today&apos;s Workout</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {generate.isError && (
            <p className="text-sm text-red-400">{(generate.error as Error).message}</p>
          )}
          {d.today_workout && d.today_workout.skipped && !d.today_workout.completed ? (
            // Skipped: collapse to a single line + Undo instead of the full card.
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-muted-foreground line-through">
                {d.today_workout.workout_json.title}
              </h3>
              <p className="text-sm text-muted-foreground">
                Skipped, rest matters too. The plan will adapt and rebuild gradually.
              </p>
              <Button variant="outline" size="sm" disabled={undoSkip.isPending}
                onClick={() => undoSkip.mutate(d.today_workout!.id)}>
                {undoSkip.isPending ? "Restoring…" : "Undo skip"}
              </Button>
              {feedbackStatus && <p className="text-sm text-primary">{feedbackStatus}</p>}
            </div>
          ) : (<>
          {d.today_workout ? (
            <>
              <h3 className="text-lg font-semibold">{d.today_workout.workout_json.title}</h3>
              <WorkoutDetail workout={d.today_workout.workout_json} />
              <Input
                placeholder="Tweak the regenerate (optional), e.g. shorter, I'm sore, add hills"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No workout planned. Generate one below.</p>
          )}
          <WorkoutChoice sport={workoutSport} focus={workoutFocus} onSport={setWorkoutSport} onFocus={setWorkoutFocus} disabled={generate.isPending} />
          {!d.today_workout && <Input aria-label="Workout notes" placeholder="Workout notes (optional)" value={instruction} onChange={e => setInstruction(e.target.value)} />}
          <Button
            className="w-full"
            disabled={generate.isPending}
            onClick={() => generate.mutate({ base: d.today_workout, tweak: workoutChoiceRequest(workoutSport, workoutFocus, instruction) })}
          >
            <Sparkles className="h-4 w-4" />
            {generate.isPending ? "Generating…" : d.today_workout ? "Regenerate" : "Generate workout"}
          </Button>

          {d.today_workout && (
            d.today_workout.completed ? (
              <p className="text-sm font-medium text-primary">✓ Completed today</p>
            ) : !didIt ? (
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setDidIt(true)}>✓ I did this workout</Button>
                <Button variant="ghost" onClick={() => feedback.mutate({ completed: false, difficulty: null })}>Skip</Button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="label-caps">How hard was it? (RPE)</p>
                <RpeBars value={rpe} onSelect={setRpe} />
                <p className="text-xs text-muted-foreground">
                  {rpe ? `RPE ${rpe}, ${rpeWord(rpe)}` : "Tap a bar: 1 = very easy, 10 = max effort (optional)"}
                </p>
                <p className="label-caps">How did it go?</p>
                <div className="flex gap-2">
                  {[["too_easy", "Too easy"], ["just_right", "Just right"], ["too_hard", "Too hard"]].map(([k, label]) => (
                    <Button key={k} variant="outline" size="sm" className="flex-1" onClick={() => feedback.mutate({ completed: true, difficulty: k, rpe })}>
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            )
          )}
          {feedbackStatus && <p className="text-sm text-primary">{feedbackStatus}</p>}
          </>)}
        </CardContent>
      </Card>

      {/* Fitness · Fatigue · Form */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Fitness{stats.data?.athlete_name ? ` · ${stats.data.athlete_name}` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {fit && (
            <div className="flex justify-between text-center">
              <FitnessStat label="Fitness" value={fit.ctl.toFixed(0)} sub="CTL" color="hsl(var(--primary))" />
              <FitnessStat label="Fatigue" value={fit.atl.toFixed(0)} sub="ATL" color="hsl(var(--sand))" />
              <FitnessStat
                label="Form" value={`${fit.tsb >= 0 ? "+" : ""}${fit.tsb.toFixed(0)}`} sub={tsbLabel(fit.tsb)}
                color={fit.tsb > 5 ? "#4ade80" : fit.tsb < -20 ? "#f87171" : fit.tsb < -10 ? "#fbbf24" : "hsl(var(--primary))"}
              />
              <FitnessStat
                label="Ramp" value={`${fit.ramp >= 0 ? "+" : ""}${fit.ramp.toFixed(1)}`} sub="7d CTL"
                color="hsl(var(--muted-foreground))"
              />
            </div>
          )}
          {loadGuard && (
            <div className="flex items-start gap-2.5 rounded-xl p-3" style={{ background: "hsl(var(--muted))" }}>
              <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: loadGuard.color }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: loadGuard.color }}>{loadGuard.headline}</p>
                <p className="text-xs text-muted-foreground">{loadGuard.detail}</p>
              </div>
            </div>
          )}
          <FitnessChart points={(stats.data?.fitness?.length ?? 0) >= 2 ? stats.data!.fitness : d.tsb_sparkline} />
        </CardContent>
      </Card>

      {/* Recent activities */}
      {(recent.data ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Recent activities</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {recent.data!.map((a) => (
              <button
                key={a.id}
                onClick={() => setOpenActivity(a)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-secondary/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.date} · {displayName(a)}</p>
                  <p className="text-xs text-muted-foreground">{activityMeta(a).join(" · ")}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function rpeWord(n: number): string {
  if (n <= 2) return "very easy";
  if (n <= 4) return "easy";
  if (n <= 6) return "moderate";
  if (n <= 8) return "hard";
  return n === 9 ? "very hard" : "max effort";
}

// Increasing-bars RPE picker: bars 1-10 grow in height; tapping bar n lights
// bars 1..n (green → amber → red).
function RpeBars({ value, onSelect }: { value: number | null; onSelect: (n: number) => void }) {
  const color = (n: number) => (n <= 5 ? "#4ade80" : n <= 8 ? "#fbbf24" : "#f87171");
  return (
    <div className="flex items-end gap-1">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          aria-label={`RPE ${n}`}
          onClick={() => onSelect(n)}
          className="flex-1 rounded-sm transition-colors"
          style={{
            height: 10 + n * 3.2,
            background: value != null && n <= value ? color(n) : "hsl(var(--secondary))",
          }}
        />
      ))}
    </div>
  );
}

function MetricRow({ label, value, trendLabel, good }: { label: string; value: string; trendLabel?: string; good?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-background/60 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 font-medium tabular-nums">
        {value}
        {trendLabel && (
          <span className="text-xs" style={{ color: good ? "#4ade80" : "#f87171" }}>{trendLabel}</span>
        )}
      </span>
    </div>
  );
}

function FitnessStat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold" style={{ color }}>{value}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-32 animate-pulse rounded bg-secondary" />
      <div className="h-40 animate-pulse rounded-lg bg-secondary" />
      <div className="h-64 animate-pulse rounded-lg bg-secondary" />
    </div>
  );
}
