"use client";
import { AdaptationControls } from "@/components/adaptation-controls";
import { SessionFeedbackPanel } from "@/components/session-feedback-panel";

import { useMemo, useState } from "react";
import { WorkoutChoice } from "@/components/workout-choice";
import { workoutChoiceRequest, type WorkoutSportChoice } from "@shared/workout_choices";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase-browser";
import { api, localDateIso } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkoutDetail } from "@/components/workout-detail";
import { ActivityDetailCard } from "@/components/activity-detail";
import type { CompletedActivity, PlannedWorkout, Workout } from "@shared/types";
import { activityMeta, displayName } from "@/lib/activity";
import { cn } from "@/lib/utils";
import {
  CalendarRange, Check, ChevronRight, Dumbbell, Lock, LockOpen, Plus,
  RefreshCw, Sparkles, Trash2, Wand2, X,
} from "lucide-react";

const TYPE_COLOR: Record<string, string> = {
  run: "bg-primary/70",
  ride: "bg-sky-500/70",
  strength: "bg-sand/70",
  rest: "bg-muted-foreground/40",
};

function monthMatrix(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) {
    cells.push(localDateIso(new Date(year, month, d)));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** Monday (ISO) of the week containing `date`. */
function mondayOf(date: string): string {
  const d = new Date(date + "T00:00:00");
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return localDateIso(d);
}

const todayIso = () => localDateIso();

// "Primary session" ordering shared with Android Home/Calendar: still-pending
// before done/skipped, non-rest before rest, newest created_at first.
function primaryFirst(sessions: PlannedWorkout[]): PlannedWorkout[] {
  return [...sessions].sort((a, b) => {
    const as = !!a.completed || !!a.skipped, bs = !!b.completed || !!b.skipped;
    if (as !== bs) return as ? 1 : -1;
    const ar = a.type === "rest" ? 1 : 0, br = b.type === "rest" ? 1 : 0;
    if (ar !== br) return ar - br;
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  });
}

// --- interval builder (E5 parity) -------------------------------------------
interface BuilderStep { kind: string; zone: string; minutes: string; reps: string }
const ZONE_IF: Record<string, number> = { Z1: 0.55, Z2: 0.7, Z3: 0.83, Z4: 0.95, Z5: 1.1 };
const STEP_KINDS = ["Warm-up", "Work", "Recovery", "Steady", "Cool-down"];

export default function CalendarPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const supabase = createClient();
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState<string | null>(todayIso);
  const [selectedActivity, setSelectedActivity] = useState<CompletedActivity | null>(null);
  const [request, setRequest] = useState("");
  const [requestSport, setRequestSport] = useState<WorkoutSportChoice>("auto");
  const [requestFocus, setRequestFocus] = useState("");
  const [lockRequest, setLockRequest] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null); // planned id being moved
  const [moveDate, setMoveDate] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<PlannedWorkout | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const cells = useMemo(() => monthMatrix(year, month), [year, month]);
  const monthStart = localDateIso(new Date(year, month, 1));
  const monthEnd = localDateIso(new Date(year, month + 1, 0));

  const planned = useQuery({
    queryKey: ["planned", monthStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reconciled_session_plans").select("*")
        .gte("date", monthStart).lte("date", monthEnd)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as PlannedWorkout[];
    },
  });

  const activities = useQuery({
    queryKey: ["activities", monthStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("effective_activities").select("*")
        .gte("date", monthStart).lte("date", monthEnd)
        .order("date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CompletedActivity[];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["planned", monthStart] });
    qc.invalidateQueries({ queryKey: ["activities", monthStart] });
    qc.invalidateQueries({ queryKey: ["daily-summary"] });
  };
  const fail = (e: unknown) => setBanner((e as Error).message);

  const generate = useMutation({
    mutationFn: (vars: { date: string; request?: string; lock?: boolean; type?: WorkoutSportChoice }) =>
      api.generateWorkout({ date: vars.date, type: vars.type ?? "auto", request: vars.request, lock: vars.lock }),
    onSuccess: () => { setRequest(""); setBanner(null); invalidate(); },
    onError: fail,
  });

  const planWeek = useMutation({
    mutationFn: (date: string) => api.planWeek(mondayOf(date)),
    onSuccess: (r) => { setBanner(`✓ Planned ${r.planned ?? ""} sessions this week.`.trim()); invalidate(); },
    onError: fail,
  });

  const toggleLock = useMutation({
    mutationFn: async (w: PlannedWorkout) => {
      const { error } = await supabase.from("planned_workouts").update({ locked: !w.locked }).eq("id", w.id);
      if (error) throw error;
    },
    onSuccess: (_d, w) => setBannerAndReload(w.locked ? "Unlocked" : "🔒 Locked, re-planning won't touch it"),
    onError: fail,
  });

  const setBannerAndReload = (msg: string) => { setBanner(msg); invalidate(); };

  // Server-side move: the Intervals.icu/watch event follows the new date.
  const move = useMutation({
    mutationFn: (vars: { id: string; date: string }) => api.moveWorkout(vars.id, vars.date),
    onSuccess: (r, vars) => {
      setBanner(r.event_moved ? "✓ Moved, watch schedule updated." : "✓ Moved.");
      setMoveFor(null);
      setMoveDate("");
      setSelected(vars.date);
      invalidate();
    },
    onError: fail,
  });

  // Done/skip parity with Android: flips the flag + logs workout_feedback.
  const markComplete = useMutation({
    mutationFn: async (vars: { w: PlannedWorkout; completed: boolean }) => {
      await api.sessionFeedback({id:crypto.randomUUID(),planned_workout_id:vars.w.id,date:vars.w.date,completed:vars.completed,outcome:vars.completed?"as_planned":"skipped"});
    },
    onSuccess: (_d, vars) => setBannerAndReload(vars.completed ? "✓ Marked done" : "Marked skipped"),
    onError: fail,
  });

  const markUndone = useMutation({
    mutationFn: async (w: PlannedWorkout) => {
      const {error}=await supabase.rpc("undo_session_feedback",{p_plan:w.id});if(error)throw error;
    },
    onSuccess: () => setBannerAndReload("Marked as not done"),
    onError: fail,
  });

  const deletePlanned = useMutation({
    mutationFn: (w: PlannedWorkout) => api.deletePlannedWorkout(w.id),
    onSuccess: () => { setConfirmDelete(null); setBannerAndReload("Workout deleted"); },
    onError: fail,
  });

  const logActivity = useMutation({
    mutationFn: async (vars: { date: string; type: string; durationMin: number; distanceKm: number | null; rpe: number | null }) => {
      const tss = (vars.durationMin * (vars.rpe ?? 5)) / 6.0;
      const { error } = await supabase.from("completed_activities").insert({
        intervals_id: `manual:${crypto.randomUUID()}`,
        source: "manual", source_id: crypto.randomUUID(), timezone_provenance: "user_local_date",
        measurement_provenance: { duration_seconds: "user_reported", distance_m: "user_reported", tss: "estimated" },
        type: vars.type, date: vars.date,
        duration_seconds: vars.durationMin * 60,
        distance_m: vars.distanceKm != null ? vars.distanceKm * 1000 : null,
        tss,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => { setShowLog(false); setBannerAndReload(`✓ Logged ${vars.type} session`); },
    onError: fail,
  });

  const saveBuilt = useMutation({
    mutationFn: async (vars: { date: string; workout: Workout; push: boolean }) => {
      const id = crypto.randomUUID();
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from("planned_workouts").insert({
        id, user_id: user?.id, date: vars.date, type: vars.workout.type, workout_json: vars.workout,
      });
      if (error) throw error;
      if (vars.push) await api.pushWorkout(id).catch(() => null);
      return vars;
    },
    onSuccess: (vars) => {
      setShowBuilder(false);
      setBannerAndReload(`✓ Added “${vars.workout.title}” to ${vars.date}` + (vars.push ? " · pushed to watch" : ""));
    },
    onError: fail,
  });

  const sync = useMutation({
    mutationFn: () => api.syncIntervals(),
    onSuccess: (r) => { setBanner(`✓ Synced, ${r.activities_synced} activities up to date.`); invalidate(); },
    onError: fail,
  });

  // Adaptive re-plan: sync fresh actuals, reconcile this week's plan against
  // what was actually done, then re-plan from today around it.

  // Open a planned strength session in the Strength logger, pre-filled and
  // linked so finishing it marks this plan complete (web handoff = sessionStorage).
  const logPlannedStrength = (w: PlannedWorkout) => {
    sessionStorage.setItem("strength-handoff", JSON.stringify({
      workout: w.workout_json, plannedId: w.id, date: w.date,
    }));
    router.push("/strength");
  };

  const byDate = new Map<string, PlannedWorkout[]>();
  for (const w of planned.data ?? []) {
    const arr = byDate.get(w.date) ?? [];
    arr.push(w);
    byDate.set(w.date, arr);
  }
  const activitiesByDate = new Map<string, CompletedActivity[]>();
  for (const a of activities.data ?? []) {
    if (!a.date) continue;
    const arr = activitiesByDate.get(a.date) ?? [];
    arr.push(a);
    activitiesByDate.set(a.date, arr);
  }
  const activityDates = new Set(activitiesByDate.keys());
  const daySessions = selected ? primaryFirst(byDate.get(selected) ?? []) : [];
  const selectedActs = selected ? activitiesByDate.get(selected) ?? [] : [];

  // Divergence: any past planned session this real week left unlogged.
  const divergence = useMemo(() => {
    const ws = mondayOf(todayIso());
    const td = todayIso();
    return (planned.data ?? []).some(
      (w) => w.date >= ws && w.date < td && !w.completed && !w.locked && w.type !== "rest",
    );
  }, [planned.data]);

  const planning = planWeek.isPending;
  const busy = planning || sync.isPending;

  return (
    <div className="space-y-4 pb-4">
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Calendar</h1>
          <p className="text-sm text-muted-foreground">{planned.data?.length ?? 0} planned this month</p>
        </div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => sync.mutate()} title="Sync from Intervals.icu">
          <RefreshCw className={cn("h-4 w-4", sync.isPending && "animate-spin")} />
          Sync
        </Button>
      </header>

      {banner && <p className="text-sm text-primary">{banner}</p>}

      <AdaptationControls onChange={invalidate} />

      {/* AI planning actions */}
      <Button className="w-full" variant="outline" disabled={busy} onClick={() => planWeek.mutate(selected ?? monthStart)}>
        <Sparkles className="h-4 w-4" />
        {planWeek.isPending ? "Planning…" : "Plan my week"}
      </Button>

      {/* Month nav */}
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={() => setCursor(new Date(year, month - 1, 1))}>‹</Button>
        <span className="text-sm font-semibold">{cursor.toLocaleString("en", { month: "long", year: "numeric" })}</span>
        <Button size="sm" variant="ghost" onClick={() => setCursor(new Date(year, month + 1, 1))}>›</Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((date, i) => {
          if (!date) return <div key={i} />;
          const ws = primaryFirst(byDate.get(date) ?? []);
          const hasActivity = activityDates.has(date);
          const day = Number(date.slice(8));
          const isToday = date === todayIso();
          return (
            <button
              key={date}
              onClick={() => { setSelected(date); setSelectedActivity(null); }}
              className={cn(
                "relative flex aspect-square flex-col items-center justify-start rounded-md border border-border/60 p-1 text-xs hover:border-primary",
                selected === date && "ring-1 ring-primary",
                isToday && "border-primary/60",
              )}
            >
              <span className={cn("self-end text-[10px]", isToday ? "font-bold text-primary" : "text-muted-foreground")}>{day}</span>
              {ws.some((w) => w.locked) && <Lock className="absolute left-1 top-1 h-2.5 w-2.5 text-primary" />}
              <span className="mt-auto flex items-center gap-0.5">
                {ws.slice(0, 3).map((w) => (
                  <span key={w.id} className={cn("h-1.5 w-1.5 rounded-full", TYPE_COLOR[w.type] ?? "bg-secondary", w.completed && "opacity-40")} />
                ))}
                {hasActivity && <span className="h-1.5 w-1.5 rounded-full border border-primary" />}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        selectedActivity ? (
          <ActivityDetailCard
            activity={selectedActivity}
            planned={(planned.data ?? []).find(w => w.id === selectedActivity.planned_workout_id) ?? null}
            plans={(planned.data ?? []).filter(w => w.date === selectedActivity.date)}
            activities={selectedActs}
            onCorrect={invalidate}
            onBack={() => setSelectedActivity(null)}
          />
        ) : (
          <div className="space-y-3">
            <h2 className="text-base font-semibold">
              {new Date(selected + "T00:00:00").toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" })}
            </h2>

            {/* Completed activities on this day */}
            {selectedActs.map((act) => (
              <button
                key={act.id}
                onClick={() => setSelectedActivity(act)}
                className="w-full rounded-xl border border-border/60 p-3 text-left transition-colors hover:border-primary"
              >
                <div className="flex items-center justify-between">
                  <span className="label-caps" style={{ color: "hsl(var(--primary))" }}>Done · {act.type ?? "activity"}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="mt-1 font-medium">{displayName(act)}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {activityMeta(act).map((m) => <span key={m} className="meta-chip">{m}</span>)}
                </div>
              </button>
            ))}

            {daySessions.length === 0 && selectedActs.length === 0 && (
              <Card>
                <CardContent className="space-y-2 p-4">
                  <p className="text-sm text-muted-foreground">Nothing planned for this day.</p>
                  <Button size="sm" disabled={generate.isPending} onClick={() => generate.mutate({ date: selected })}>
                    {generate.isPending && !request ? "Generating…" : "Auto-generate"}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Every planned session on this day, primary first */}
            {daySessions.map((w) => (
              <Card key={w.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-1">
                    <p className="label-caps flex-1" style={{ color: w.type === "strength" ? "hsl(var(--sand))" : undefined }}>
                      {w.type}{w.locked ? " · locked" : ""}{w.skipped && !w.completed ? " · skipped" : ""}
                    </p>
                    <button
                      onClick={() => toggleLock.mutate(w)}
                      className={cn("p-1.5", w.locked ? "text-primary" : "text-muted-foreground hover:text-foreground")}
                      title={w.locked ? "Unlock" : "Lock so re-planning won't change it"}
                    >
                      {w.locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
                    </button>
                    <button
                      onClick={() => { setMoveFor(moveFor === w.id ? null : w.id); setMoveDate(""); }}
                      className="p-1.5 text-muted-foreground hover:text-foreground"
                      title="Move to another day"
                    >
                      <CalendarRange className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(w)}
                      className="p-1.5 text-muted-foreground hover:text-red-400"
                      title="Delete workout"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <h3 className="text-lg font-semibold">{w.workout_json.title}</h3>
                  <SessionFeedbackPanel date={w.date} planId={w.id} onChange={invalidate} />
                  <p className="text-xs text-muted-foreground">Session {(w.session_slot ?? 0) + 1}{w.start_minute != null ? ` · ${String(Math.floor(w.start_minute / 60)).padStart(2, "0")}:${String(w.start_minute % 60).padStart(2, "0")}` : ""}{w.combined_group ? " · combined multisport session" : ""}</p>
                  <WorkoutDetail workout={w.workout_json} />

                  {moveFor === w.id && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Move to</span>
                      <input
                        type="date"
                        value={moveDate}
                        onChange={(e) => setMoveDate(e.target.value)}
                        className="rounded-md border border-input bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      <Button
                        variant="outline" size="sm"
                        disabled={!moveDate || moveDate === selected || move.isPending}
                        onClick={() => move.mutate({ id: w.id, date: moveDate })}
                      >
                        {move.isPending ? "Moving…" : "Move"}
                      </Button>
                    </div>
                  )}

                  {w.type !== "rest" && (
                    w.completed ? (
                      <div className="flex items-center justify-between">
                        <p className="flex items-center gap-1.5 text-sm text-primary"><Check className="h-4 w-4" /> Completed</p>
                        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => markUndone.mutate(w)}>
                          Mark as not done
                        </button>
                      </div>
                    ) : w.skipped ? (
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-muted-foreground">Skipped. Preview an adjustment when you want one.</p>
                        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => markUndone.mutate(w)}>
                          Undo skip
                        </button>
                      </div>
                    ) : (
                      <>
                        {w.type === "strength" && (
                          <Button variant="outline" className="w-full" onClick={() => logPlannedStrength(w)}>
                            <Dumbbell className="h-4 w-4" /> Log this session
                          </Button>
                        )}
                        <div className="flex gap-2">
                          <Button
                            variant="outline" size="sm" className="flex-1"
                            disabled={markComplete.isPending}
                            onClick={() => markComplete.mutate({ w, completed: true })}
                          >
                            <Check className="h-4 w-4" /> Done
                          </Button>
                          <Button
                            variant="ghost" size="sm"
                            disabled={markComplete.isPending}
                            onClick={() => markComplete.mutate({ w, completed: false })}
                          >
                            Skip
                          </Button>
                        </div>
                      </>
                    )
                  )}
                </CardContent>
              </Card>
            ))}

            {/* Ask AI for a specific fixed session (locked by default). */}
            <div className="space-y-2 rounded-xl bg-background/60 p-3">
              <p className="label-caps">Ask AI for a session</p>
              <WorkoutChoice sport={requestSport} focus={requestFocus} onSport={setRequestSport} onFocus={setRequestFocus} disabled={generate.isPending} />
              <textarea
                className="min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="e.g. Friday social 10k run with friends, easy pace"
                value={request}
                onChange={(e) => setRequest(e.target.value)}
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={lockRequest} onChange={(e) => setLockRequest(e.target.checked)} className="accent-primary" />
                Lock it, re-planning won&apos;t change this session
              </label>
              <Button
                size="sm"
                disabled={(!request.trim() && requestSport === "auto") || generate.isPending}
                onClick={() => generate.mutate({ date: selected, type: requestSport, request: workoutChoiceRequest(requestSport, requestFocus, request), lock: lockRequest })}
              >
                <Wand2 className="h-4 w-4" />
                {generate.isPending && request ? "Creating…" : "Create session"}
              </Button>
            </div>

            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowLog(true)}>＋ Log past</Button>
              <Button variant="ghost" size="sm" onClick={() => setShowBuilder(true)}>＋ Build intervals</Button>
            </div>
          </div>
        )
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)} title="Delete workout?">
          <p className="text-sm text-muted-foreground">
            This permanently removes “{confirmDelete.workout_json.title}” from {confirmDelete.date}.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="outline" size="sm" disabled={deletePlanned.isPending} onClick={() => deletePlanned.mutate(confirmDelete)}>
              {deletePlanned.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </Modal>
      )}

      {showLog && selected && (
        <LogActivityModal
          date={selected}
          busy={logActivity.isPending}
          onClose={() => setShowLog(false)}
          onConfirm={(type, durationMin, distanceKm, rpe) =>
            logActivity.mutate({ date: selected, type, durationMin, distanceKm, rpe })}
        />
      )}

      {showBuilder && selected && (
        <IntervalBuilderModal
          date={selected}
          busy={saveBuilt.isPending}
          onClose={() => setShowBuilder(false)}
          onSave={(workout, push) => saveBuilt.mutate({ date: selected, workout, push })}
        />
      )}
    </div>
  );
}

// --- modals -------------------------------------------------------------------

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-3">{children}</div>
      </div>
    </div>
  );
}

function LogActivityModal({
  date, busy, onClose, onConfirm,
}: {
  date: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (type: string, durationMin: number, distanceKm: number | null, rpe: number | null) => void;
}) {
  const [type, setType] = useState("Run");
  const [duration, setDuration] = useState("45");
  const [distance, setDistance] = useState("");
  const [rpe, setRpe] = useState("");
  return (
    <Modal title={`Log a session · ${date}`} onClose={onClose}>
      <div className="flex gap-1.5">
        {["Run", "WeightTraining", "Other"].map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              type === t ? "border-transparent bg-accent/60 font-medium text-primary" : "border-border text-muted-foreground",
            )}
          >
            {t === "WeightTraining" ? "Strength" : t}
          </button>
        ))}
      </div>
      <Input type="number" placeholder="Duration (min)" value={duration} onChange={(e) => setDuration(e.target.value)} />
      <Input type="number" placeholder="Distance km (optional)" value={distance} onChange={(e) => setDistance(e.target.value)} />
      <Input type="number" placeholder="RPE 1-10 (optional)" value={rpe} onChange={(e) => setRpe(e.target.value)} />
      <Button
        className="w-full"
        disabled={busy || !(+duration > 0)}
        onClick={() => onConfirm(type, +duration, distance ? +distance : null, rpe ? +rpe : null)}
      >
        {busy ? "Logging…" : "Log"}
      </Button>
    </Modal>
  );
}

// E5 — structured interval builder. Each step has a zone, minutes and a repeat
// count; the list compiles into a Workout (one "Main" section) with a duration
// and a TSS estimate from per-zone intensity factors.
function IntervalBuilderModal({
  date, busy, onClose, onSave,
}: {
  date: string;
  busy: boolean;
  onClose: () => void;
  onSave: (workout: Workout, push: boolean) => void;
}) {
  const [title, setTitle] = useState("Interval session");
  const [type, setType] = useState<"run" | "ride">("run");
  const [push, setPush] = useState(true);
  const [steps, setSteps] = useState<BuilderStep[]>([
    { kind: "Warm-up", zone: "Z1", minutes: "10", reps: "1" },
    { kind: "Work", zone: "Z4", minutes: "3", reps: "5" },
    { kind: "Recovery", zone: "Z1", minutes: "2", reps: "5" },
    { kind: "Cool-down", zone: "Z1", minutes: "10", reps: "1" },
  ]);

  const stepMinutes = (s: BuilderStep) => (parseFloat(s.minutes) || 0) * (parseInt(s.reps) || 1);
  const totalMin = steps.reduce((t, s) => t + stepMinutes(s), 0);
  const tss = steps.reduce((t, s) => {
    const mins = stepMinutes(s);
    const iff = ZONE_IF[s.zone] ?? 0.7;
    return t + (mins / 60) * iff * iff * 100;
  }, 0);

  const patch = (i: number, p: Partial<BuilderStep>) =>
    setSteps((arr) => arr.map((s, j) => (j === i ? { ...s, ...p } : s)));

  const save = () => {
    const exercises = steps.map((s) => {
      const r = parseInt(s.reps) || 1;
      return {
        name: (r > 1 ? `${r}× ` : "") + s.kind,
        sets: 0, reps: `${s.minutes} min`, hr_zone: s.zone,
      };
    });
    onSave(
      {
        type, title: title.trim() || "Interval session",
        duration_minutes: totalMin, tss_estimate: tss, rpe_target: 7,
        sections: [{ name: "Main", duration_minutes: totalMin, exercises }],
        coach_note: "Built manually.",
      } as Workout,
      push,
    );
  };

  return (
    <Modal title={`Build session · ${date}`} onClose={onClose}>
      <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="flex gap-1.5">
        {(["run", "ride"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm capitalize",
              type === t ? "border-transparent bg-accent/60 font-medium text-primary" : "border-border text-muted-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <p className="text-sm font-medium text-primary">{Math.round(totalMin)} min · ~{Math.round(tss)} TSS</p>

      {steps.map((s, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-border/60 p-3">
          <div className="flex items-center gap-2">
            <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              value={s.kind}
              onChange={(e) => patch(i, { kind: e.target.value })}
            >
              {STEP_KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
            <button onClick={() => setSteps((arr) => arr.filter((_, j) => j !== i))} className="ml-auto p-1 text-muted-foreground hover:text-red-400">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              value={s.zone}
              onChange={(e) => patch(i, { zone: e.target.value })}
            >
              {Object.keys(ZONE_IF).map((z) => <option key={z}>{z}</option>)}
            </select>
            <Input type="number" className="w-20" placeholder="min" value={s.minutes} onChange={(e) => patch(i, { minutes: e.target.value })} />
            <span className="text-xs text-muted-foreground">min ×</span>
            <Input type="number" className="w-16" placeholder="reps" value={s.reps} onChange={(e) => patch(i, { reps: e.target.value })} />
          </div>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => setSteps((arr) => [...arr, { kind: "Work", zone: "Z4", minutes: "3", reps: "1" }])}>
        <Plus className="h-3.5 w-3.5" /> Add step
      </Button>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} className="accent-primary" />
        Push to Intervals.icu watch calendar
      </label>
      <Button className="w-full" disabled={busy || totalMin <= 0} onClick={save}>
        {busy ? "Saving…" : "Save"}
      </Button>
    </Modal>
  );
}
