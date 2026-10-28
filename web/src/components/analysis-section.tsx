"use client";

// Execution-analysis UI shared by activity and strength detail views — the web
// counterpart of the Android AnalysisSection / StrengthAnalysisSection.
// Peeks the cached analysis on mount (never triggers LLM spend); the explicit
// button runs a fresh analysis.

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarkdownText } from "@/components/markdown-text";
import { fmtPaceSec } from "@/lib/activity";
import type { ActivityAnalysis, AnalysisComponent, StrengthAnalysis } from "@shared/types";
import { Sparkles } from "lucide-react";
import {
  Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

function scoreColor(score: number): string {
  if (score >= 75) return "#4ade80";
  if (score >= 55) return "#fbbf24";
  return "#f87171";
}

export function ExecutionRing({ score }: { score: number }) {
  const color = scoreColor(score);
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-[72px] w-[72px] shrink-0">
      <svg viewBox="0 0 72 72" className="h-full w-full -rotate-90">
        <circle cx="36" cy="36" r={r} fill="none" stroke="#333535" strokeWidth="7" />
        <circle
          cx="36" cy="36" r={r} fill="none" stroke={color} strokeWidth="7"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xl font-semibold" style={{ color }}>
        {score}
      </span>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.max(2, Math.min(100, score))}%`, background: scoreColor(score) }}
      />
    </div>
  );
}

function Components({ components }: { components: AnalysisComponent[] }) {
  return (
    <div className="space-y-2.5">
      {components.map((c) => (
        <div key={c.name} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span>{c.name}</span>
            <span className="font-semibold" style={{ color: scoreColor(c.score) }}>{c.score}/100</span>
          </div>
          <ScoreBar score={c.score} />
          <p className="text-xs text-muted-foreground">{c.detail}</p>
        </div>
      ))}
    </div>
  );
}

function ScoreHeader({ score, label, plannedTitle }: { score?: number | null; label?: string | null; plannedTitle?: string | null }) {
  if (score == null) return <p className="text-sm">{label ?? "No plan to compare against."}</p>;
  return (
    <div className="flex items-center gap-4">
      <ExecutionRing score={score} />
      <div>
        <p className="font-semibold">{label}</p>
        {plannedTitle && <p className="text-xs text-muted-foreground">vs “{plannedTitle}”</p>}
      </div>
    </div>
  );
}

function Feedback({ feedback, provider }: { feedback?: string | null; provider?: string | null }) {
  if (!feedback?.trim()) return null;
  return (
    <div className="space-y-1.5">
      <p className="label-caps flex items-center gap-1.5" style={{ color: "hsl(var(--primary))" }}>
        <Sparkles className="h-3.5 w-3.5" /> Coach feedback{provider ? ` · ${provider}` : ""}
      </p>
      <MarkdownText text={feedback} className="space-y-0.5 text-sm" />
    </div>
  );
}

// --- endurance ---------------------------------------------------------------

export function ActivityAnalysisSection({ activityId }: { activityId: string }) {
  const [a, setA] = useState<ActivityAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Display a background-computed analysis immediately, no button press needed.
  useEffect(() => {
    let cancelled = false;
    setA(null);
    setError(null);
    api.analyzeActivity(activityId, { peek: true })
      .then((res) => { if (!cancelled && res.ok) setA(res); })
      .catch(() => { /* peek is best-effort */ });
    return () => { cancelled = true; };
  }, [activityId]);

  const analyze = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.analyzeActivity(activityId, { force });
      if (res.ok) setA(res);
      else setError(res.error ?? "Couldn't analyze this activity.");
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const chart = useMemo(() => buildChartData(a), [a]);
  const paceUnit = a?.pace_unit ?? "/km";

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="label-caps" style={{ color: "hsl(var(--primary))" }}>Workout analysis</p>
          {a && (
            <button onClick={() => analyze(true)} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground">
              {busy ? "Analyzing…" : "Re-analyze"}
            </button>
          )}
        </div>

        {!a && (
          <>
            <p className="text-sm text-muted-foreground">
              Review the recorded dose, effort evidence, splits and coach feedback. Missing measurements remain unknown.
            </p>
            <Button variant="outline" className="w-full" disabled={busy} onClick={() => analyze()}>
              <Sparkles className="h-4 w-4" />
              {busy ? "Analyzing…" : "Analyze this workout"}
            </Button>
            {error && <p className="text-sm text-red-400">{error}</p>}
          </>
        )}

        {a && (
          <>
            <ScoreHeader score={a.score} label={a.label} plannedTitle={a.planned_title} />
              {a.execution_evidence && <p className="text-sm">{a.execution_evidence.summary}</p>}
            <Components components={a.components ?? []} />
          </>
        )}
      </div>

      {chart && chart.hasPace && (
        <ChartCard
          title={
            "Pace" +
            (a?.target?.pace_lo != null && a?.target?.pace_hi != null
              ? ` · target ${fmtPaceSec(a.target.pace_lo)}-${fmtPaceSec(a.target.pace_hi)} ${paceUnit}`
              : "")
          }
        >
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={chart.data} margin={{ left: -16, right: 4 }}>
              <XAxis dataKey="min" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" unit="m" />
              <YAxis
                reversed domain={["dataMin - 15", "dataMax + 15"]}
                tickFormatter={(v: number) => fmtPaceSec(v)}
                tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={44}
              />
              <Tooltip
                formatter={(v) => [`${fmtPaceSec(Number(v))} ${paceUnit}`, "pace"]}
                labelFormatter={(l) => `${l} min`}
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
              />
              {a?.target?.pace_lo != null && a?.target?.pace_hi != null && (
                <ReferenceArea y1={a.target.pace_lo} y2={a.target.pace_hi} fill="hsl(var(--sand))" fillOpacity={0.15} />
              )}
              <Line type="monotone" dataKey="pace" stroke="hsl(var(--primary))" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {chart && chart.hasHr && (
        <ChartCard
          title={
            "Heart rate" +
            (a?.target?.hr_lo != null ? ` · target ${a.target.hr_lo}-${a.target.hr_hi} bpm` : "")
          }
        >
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={chart.data} margin={{ left: -16, right: 4 }}>
              <XAxis dataKey="min" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" unit="m" />
              <YAxis domain={["dataMin - 5", "dataMax + 5"]} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={36} />
              <Tooltip
                formatter={(v) => [`${Math.round(Number(v))} bpm`, "HR"]}
                labelFormatter={(l) => `${l} min`}
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
              />
              {a?.target?.hr_lo != null && a?.target?.hr_hi != null && (
                <ReferenceArea y1={a.target.hr_lo} y2={a.target.hr_hi} fill="hsl(var(--sand))" fillOpacity={0.15} />
              )}
              <Line type="monotone" dataKey="hr" stroke="#f87171" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {a && (a.splits?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <p className="label-caps" style={{ color: "hsl(var(--accent))" }}>Splits</p>
          {a.splits!.map((s) => (
            <div key={s.km} className="flex items-center gap-3 text-sm">
              <span className="w-14 text-xs text-muted-foreground">{a.pace_unit === "/100m" ? `${Math.round(s.km * 1000)} m` : `km ${s.km % 1 === 0 ? s.km.toFixed(0) : s.km}`}</span>
              <span className="font-medium tabular-nums">{fmtPaceSec(s.sec)} {paceUnit}</span>
              <span className="ml-auto text-xs text-muted-foreground">{s.avg_hr ? `♥ ${s.avg_hr}` : ""}</span>
            </div>
          ))}
        </div>
      )}

      {a && <Feedback feedback={a.feedback} provider={a.feedback_provider} />}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <p className="label-caps" style={{ color: "hsl(var(--primary))" }}>{title}</p>
        {children}
      </CardContent>
    </Card>
  );
}

// Downsample the per-second series for the charts (~240 points max).
function buildChartData(a: ActivityAnalysis | null) {
  const s = a?.series;
  if (!s || s.t.length === 0) return null;
  const step = Math.max(1, Math.floor(s.t.length / 240));
  const data: { min: number; pace: number | null; hr: number | null }[] = [];
  for (let i = 0; i < s.t.length; i += step) {
    data.push({
      min: +(s.t[i] / 60).toFixed(1),
      pace: s.pace[i] ?? null,
      hr: s.hr[i] ?? null,
    });
  }
  return {
    data,
    hasPace: s.pace.some((p) => p != null),
    hasHr: s.hr.some((h) => h != null),
  };
}

// --- strength ----------------------------------------------------------------

export function StrengthAnalysisSection({ date, workoutId }: { date: string; workoutId?: string }) {
  const [a, setA] = useState<StrengthAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setA(null);
    setError(null);
    api.analyzeStrength(date, { peek: true, workout_id: workoutId })
      .then((res) => { if (!cancelled && res.ok) setA(res); })
      .catch(() => { /* peek is best-effort */ });
    return () => { cancelled = true; };
  }, [date, workoutId]);

  const analyze = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.analyzeStrength(date, { force, workout_id: workoutId });
      if (res.ok) setA(res);
      else setError(res.error ?? "Couldn't analyze this session.");
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="label-caps" style={{ color: "hsl(var(--sand))" }}>Session analysis</p>
        {a && (
          <button onClick={() => analyze(true)} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground">
            {busy ? "Analyzing…" : "Re-analyze"}
          </button>
        )}
      </div>

      {!a && (
        <>
          <p className="text-sm text-muted-foreground">
            Compare what you lifted against the planned session, coverage, volume and AI coach feedback.
          </p>
          <Button variant="outline" className="w-full" disabled={busy} onClick={() => analyze()}>
            <Sparkles className="h-4 w-4" />
            {busy ? "Analyzing…" : "Analyze this session"}
          </Button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </>
      )}

      {a && (
        <>
          <ScoreHeader score={a.score} label={a.label} plannedTitle={a.planned_title} />
          {a.coverage_evidence && <p className="text-sm">Exact exercises: {a.coverage_evidence.exact}/{a.coverage_evidence.total} · Movement coverage: {a.coverage_evidence.movement}/{a.coverage_evidence.total} · Muscle overlap: {a.coverage_evidence.muscle}/{a.coverage_evidence.total}</p>}
          {a.dose_evidence?.map(dose => <p key={dose.exercise} className="text-xs text-muted-foreground">{dose.exercise}: {dose.logged_sets}/{dose.planned_sets} working sets recorded; {dose.sets_in_rep_range == null ? "units need confirmation" : `${dose.sets_in_rep_range} in the planned rep range`}</p>)}
          <Components components={a.components ?? []} />

          {(a.watch || a.total_volume_kg != null) && (
            <div className="flex flex-wrap gap-1.5">
              {a.total_volume_kg != null && <span className="meta-chip">{Math.round(a.total_volume_kg)} kg total</span>}
              {a.total_sets != null && <span className="meta-chip">{a.total_sets} sets</span>}
              {a.watch?.duration_min != null && <span className="meta-chip">{a.watch.duration_min} min on watch</span>}
              {a.watch?.avg_hr != null && <span className="meta-chip">♥ {a.watch.avg_hr}</span>}
              {a.watch?.tss != null && <span className="meta-chip">TSS {Math.round(a.watch.tss)}</span>}
            </div>
          )}

          {(a.exercises?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <p className="label-caps" style={{ color: "hsl(var(--accent))" }}>Planned vs lifted</p>
              {a.exercises!.map((ex) => (
                <div key={ex.name} className="rounded-lg bg-background/60 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{ex.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {ex.actual_sets}× sets
                      {ex.top_weight_kg != null && ` · top ${ex.top_weight_kg} kg`}
                      {ex.volume_kg != null && ` · ${Math.round(ex.volume_kg)} kg vol`}
                    </span>
                  </div>
                  {ex.planned && <p className="text-xs text-muted-foreground">planned: {ex.planned}</p>}
                </div>
              ))}
            </div>
          )}

          <Feedback feedback={a.feedback} provider={a.feedback_provider} />
        </>
      )}
    </div>
  );
}
