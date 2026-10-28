"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient, currentUserId } from "@/lib/supabase-browser";
import { api, localDateIso } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { WorkoutDetail } from "@/components/workout-detail";
import { StrengthAnalysisSection } from "@/components/analysis-section";
import { epley1rm, type PlannedWorkout, type Workout } from "@shared/types";
import metadata from "@shared/exercise_metadata.json";
import { ChevronRight, Dumbbell, Play, Plus, Sparkles, X } from "lucide-react";

interface SetInput { quantity_unit?: string; reps: number; weight_kg: number; rpe?: number | null; is_warmup?: boolean }
interface SessionExercise { name: string; muscle: string; sets: SetInput[] }

// Full workout model — mirrors the Android cloud tables so sessions sync both ways.
interface CloudWorkout {
  id: string; name: string; started_at: number; ended_at: number;
  duration_sec: number; total_volume_kg: number; note: string; planned_workout_id?: string | null;
}
interface CloudSet {
  id: string; workout_id: string; exercise_name: string; muscle: string;
  quantity_unit?: string;
  idx: number; weight_kg: number; reps: number; rpe: number | null; is_warmup: boolean;
}
interface CloudRoutine { id: string; name: string; created_at: number }
interface CloudRoutineItem {
  id: string; routine_id: string; exercise_name: string; position: number;
  target_sets: number; target_reps: string; rest_sec: number;
}

const dayOf = (millis: number) => localDateIso(new Date(millis));
const todayIso = () => localDateIso();

// Cardio entries are logged in minutes (the set's `reps` carries the minutes,
// weight is 0) — matches the Android logger and the AI's catalog rules.
const CARDIO_NAMES = new Set(["treadmill run", "rowing machine", "assault bike", "stair climber", "elliptical"]);
const isCardioExercise = (name: string, muscle?: string | null) =>
  (muscle ?? "").toLowerCase() === "cardio" || CARDIO_NAMES.has(name.trim().toLowerCase());

export default function StrengthPage() {
  const qc = useQueryClient();
  const supabase = createClient();

  const exercises = useQuery({
    queryKey: ["exercise-library"],
    queryFn: async () => {
      const { data } = await supabase.from("exercise_library").select("name, muscle_groups, equipment, is_compound").order("name");
      return (data ?? []) as { name: string; muscle_groups: string[]; equipment: string; is_compound: boolean }[];
    },
  });

  // Rich history straight from the shared workout model (last 60 days).
  const workouts = useQuery({
    queryKey: ["strength-workouts"],
    queryFn: async () => {
      const cutoff = Date.now() - 60 * 86400000;
      const { data: ws } = await supabase
        .from("strength_workouts").select("*")
        .gte("started_at", cutoff).order("started_at", { ascending: false });
      const workouts = (ws ?? []) as CloudWorkout[];
      if (workouts.length === 0) return { workouts, sets: [] as CloudSet[] };
      const { data: ss } = await supabase
        .from("strength_workout_sets").select("*")
        .in("workout_id", workouts.map((w) => w.id));
      return { workouts, sets: (ss ?? []) as CloudSet[] };
    },
  });

  // Reusable routines — synced with the phone (strength_routines tables).
  const routines = useQuery({
    queryKey: ["strength-routines"],
    queryFn: async () => {
      const { data: rs } = await supabase.from("strength_routines").select("*").order("created_at", { ascending: false });
      const list = (rs ?? []) as CloudRoutine[];
      if (!list.length) return { routines: list, items: [] as CloudRoutineItem[] };
      const { data: items } = await supabase
        .from("strength_routine_items").select("*")
        .in("routine_id", list.map((r) => r.id))
        .order("position");
      return { routines: list, items: (items ?? []) as CloudRoutineItem[] };
    },
  });

  // Today's planned strength session(s) from the calendar.
  const todayPlanned = useQuery({
    queryKey: ["today-planned-strength"],
    queryFn: async () => {
      const { data } = await supabase
        .from("reconciled_session_plans").select("*")
        .eq("date", todayIso()).eq("type", "strength")
        .order("created_at", { ascending: false });
      return (data ?? []) as PlannedWorkout[];
    },
  });

  const lib = exercises.data ?? [];
  const [session, setSession] = useState<SessionExercise[]>([]);
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [picker, setPicker] = useState("");
  const [linkedPlannedId, setLinkedPlannedId] = useState<string | null>(null);
  // Editing mode: a past workout loaded into the builder; saving replaces it
  // in place (same id, original start/end times) instead of logging a new one.
  const [editing, setEditing] = useState<CloudWorkout | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null); // history detail
  const [banner, setBanner] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // Last logged working sets per exercise — used to pre-fill new sets (the web
  // version of Android's progression/repeat-last suggestions).
  const lastSetsByExercise = useMemo(() => {
    const ws = workouts.data?.workouts ?? [];
    const sets = workouts.data?.sets ?? [];
    const byWorkout = new Map<string, CloudSet[]>();
    for (const s of sets) {
      const arr = byWorkout.get(s.workout_id) ?? [];
      arr.push(s);
      byWorkout.set(s.workout_id, arr);
    }
    const out = new Map<string, CloudSet[]>();
    for (const w of ws) { // newest first — first hit wins
      const grouped = new Map<string, CloudSet[]>();
      for (const s of byWorkout.get(w.id) ?? []) {
        if (s.is_warmup) continue;
        const arr = grouped.get(s.exercise_name) ?? [];
        arr.push(s);
        grouped.set(s.exercise_name, arr);
      }
      for (const [ex, list] of grouped) {
        if (!out.has(ex)) out.set(ex, list.sort((a, b) => a.idx - b.idx));
      }
    }
    return out;
  }, [workouts.data]);

  const muscleOf = (exName: string) =>
    (lib.find((e) => e.name === exName)?.muscle_groups?.[0] ?? "other").toLowerCase();

  const addExercise = (exName: string, targetSets = 1) => {
    if (!exName) return;
    const last = lastSetsByExercise.get(exName);
    const sets: SetInput[] = last?.length
      ? last.slice(0, Math.max(targetSets, last.length)).map((s) => ({ reps: s.reps, weight_kg: s.weight_kg, quantity_unit: s.quantity_unit ?? "reps" }))
      : Array.from({ length: Math.max(1, targetSets) }, () => ({ reps: 8, weight_kg: 0, quantity_unit: isCardioExercise(exName) ? "minutes" : metadata.find(m => m.name === exName)?.logging ?? "reps" }));
    setSession((s) => [...s, { name: exName, muscle: muscleOf(exName), sets }]);
    if (sessionStart === null) setSessionStart(Date.now());
    setPicker("");
  };

  // Pre-fill the session from a structured Workout (planned session / AI lift).
  const seedFromWorkout = (w: Workout, plannedId: string | null) => {
    const next: SessionExercise[] = [];
    for (const sec of w.sections) {
      for (const ex of sec.exercises) {
        const reps = parseInt((ex.reps.match(/\d+/) ?? ["8"])[0]);
        const n = Math.max(1, ex.sets || 1);
        const cardio = isCardioExercise(ex.name, ex.muscle);
        next.push({
          name: ex.name,
          muscle: cardio ? "cardio" : (ex.muscle?.toLowerCase() ?? muscleOf(ex.name)),
          sets: Array.from({ length: n }, () => cardio
            ? { reps, weight_kg: 0, quantity_unit: "minutes" } // reps = minutes for cardio
            : { reps, quantity_unit: /metres|meters/.test(ex.reps) ? "metres" : /sec/.test(ex.reps) ? "seconds" : "reps", weight_kg: ex.weight_kg ?? lastSetsByExercise.get(ex.name)?.[0]?.weight_kg ?? 0 }),
        });
      }
    }
    setSession(next);
    setName(w.title || "Planned Strength");
    setSessionStart(Date.now());
    setLinkedPlannedId(plannedId);
    setEditing(null);
    setBanner(plannedId ? "Logging your planned session, finishing marks it done on the calendar." : null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Edit mode: load a logged session into the builder; "Save changes" replaces
  // it in place.
  const startEditing = (w: CloudWorkout, sets: CloudSet[]) => {
    const grouped = new Map<string, CloudSet[]>();
    for (const s of [...sets].sort((a, b) => a.idx - b.idx)) {
      const arr = grouped.get(s.exercise_name) ?? [];
      arr.push(s);
      grouped.set(s.exercise_name, arr);
    }
    setSession([...grouped.entries()].map(([exName, list]) => ({
      name: exName,
      muscle: list[0]?.muscle ?? muscleOf(exName),
      sets: list.map((s) => ({ reps: s.reps, quantity_unit: s.quantity_unit ?? "reps", weight_kg: s.weight_kg, rpe: s.rpe, is_warmup: s.is_warmup })),
    })));
    setName(w.name);
    setNote(w.note);
    setSessionStart(w.started_at);
    setLinkedPlannedId(w.planned_workout_id ?? null);
    setEditing(w);
    setOpenSession(null);
    setBanner(`Editing “${w.name}”, adjust sets/reps and Save changes.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Calendar → Strength handoff (sessionStorage, set by the calendar page).
  useEffect(() => {
    const raw = sessionStorage.getItem("strength-handoff");
    if (!raw) return;
    sessionStorage.removeItem("strength-handoff");
    try {
      const h = JSON.parse(raw) as { workout: Workout; plannedId: string; date: string };
      seedFromWorkout(h.workout, h.plannedId);
    } catch { /* malformed handoff */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startFromRoutine = (r: CloudRoutine) => {
    const items = (routines.data?.items ?? []).filter((i) => i.routine_id === r.id).sort((a, b) => a.position - b.position);
    setSession([]);
    setName(r.name);
    setSessionStart(Date.now());
    setLinkedPlannedId(null);
    setEditing(null);
    for (const it of items) addExercise(it.exercise_name, it.target_sets || 1);
  };

  const startFromLast = () => {
    const last = workouts.data?.workouts?.[0];
    if (!last) { setBanner("No previous workout to repeat."); return; }
    const sets = (workouts.data?.sets ?? []).filter((s) => s.workout_id === last.id).sort((a, b) => a.idx - b.idx);
    const grouped = new Map<string, CloudSet[]>();
    for (const s of sets) { const arr = grouped.get(s.exercise_name) ?? []; arr.push(s); grouped.set(s.exercise_name, arr); }
    setSession([...grouped.entries()].map(([exName, list]) => ({
      name: exName, muscle: muscleOf(exName),
      sets: list.map((s) => ({ reps: s.reps, quantity_unit: s.quantity_unit ?? "reps", weight_kg: s.weight_kg, is_warmup: s.is_warmup })),
    })));
    setName(last.name);
    setSessionStart(Date.now());
    setLinkedPlannedId(null);
    setEditing(null);
  };

  // AI-generated lift for today: same engine as the phone (generate-workout
  // type=strength), opened pre-filled and linked so finishing marks it done.
  const generateAiLift = async () => {
    setGenerating(true);
    setBanner("Generating today's lift with AI…");
    try {
      const r = await api.generateWorkout({ type: "strength", push: false });
      if (r.workout?.sections?.length) {
        seedFromWorkout(r.workout, r.workout_id ?? null);
        setBanner("✓ AI session ready, adjust and log");
        qc.invalidateQueries({ queryKey: ["today-planned-strength"] });
      } else {
        setBanner("AI couldn't build a strength session, check your provider key & profile.");
      }
    } catch (e) {
      setBanner((e as Error).message);
    }
    setGenerating(false);
  };

  const patchSet = (ei: number, si: number, p: Partial<SetInput>) =>
    setSession((s) => s.map((ex, i) => i !== ei ? ex : { ...ex, sets: ex.sets.map((st, j) => j === si ? { ...st, ...p } : st) }));
  const addSet = (ei: number) =>
    setSession((s) => s.map((ex, i) => i !== ei ? ex : { ...ex, sets: [...ex.sets, { ...ex.sets[ex.sets.length - 1] ?? { reps: 8, weight_kg: 20 } }] }));
  const removeSet = (ei: number, si: number) =>
    setSession((s) => s.map((ex, i) => i !== ei ? ex : { ...ex, sets: ex.sets.filter((_, j) => j !== si) }));
  const removeExercise = (ei: number) => setSession((s) => s.filter((_, i) => i !== ei));
  const discard = () => { setSession([]); setSessionStart(null); setName(""); setNote(""); setLinkedPlannedId(null); setEditing(null); };

  const sessionVolume = useMemo(
    () => session.reduce((t, ex) => t + ex.sets.filter((s) => !s.is_warmup && (s.quantity_unit ?? "reps") === "reps" && !["band", "assistance"].includes(metadata.find(m => m.name === ex.name)?.load_mode ?? "")).reduce((a, s) => a + s.weight_kg * s.reps, 0), 0),
    [session],
  );

  const save = useMutation({
    mutationFn: async () => {
      const id = editing?.id ?? crypto.randomUUID();
      // Editing keeps the original times; a new log stamps now.
      const start = editing?.started_at ?? sessionStart ?? Date.now();
      const end = editing?.ended_at ?? Date.now();
      const setRows: CloudSet[] = [];
      for (const ex of session) {
        ex.sets.forEach((s, i) => {
          setRows.push({
            id: crypto.randomUUID(), workout_id: id, exercise_name: ex.name, muscle: ex.muscle,
            idx: i + 1, quantity_unit: s.quantity_unit ?? "reps", weight_kg: s.weight_kg, reps: s.reps, rpe: s.rpe ?? null, is_warmup: s.is_warmup ?? false,
          });
        });
      }
      const date = dayOf(start);
      const owner = await currentUserId(supabase);
      const { error: saveError } = await supabase.rpc("sync_strength", { p_owner: owner,
        p_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, p_workouts: [{ id, name: name.trim() || "Workout",
          started_at: start, ended_at: end, duration_sec: Math.round((end - start) / 1000), total_volume_kg: sessionVolume,
          note, planned_workout_id: linkedPlannedId || null, sets: setRows }], p_routines: [], p_custom: [], p_deletes: [] });
      if (saveError) throw saveError;
      // 3. Auto-complete the linked plan so the calendar reflects it.
      if (linkedPlannedId) {
        await supabase.from("planned_workouts").update({ completed: true }).eq("id", linkedPlannedId);
      }
      // 4. Kick off the execution analysis in the background (same as the phone).
      api.analyzeStrength(date, { force: true, workout_id: id }).catch(() => null);
      return { linked: !!linkedPlannedId, edited: !!editing };
    },
    onSuccess: ({ linked, edited }) => {
      discard();
      setBanner(edited ? "✓ Session updated" : linked ? "✓ Logged, planned session marked done" : "✓ Workout saved");
      qc.invalidateQueries({ queryKey: ["strength-workouts"] });
      qc.invalidateQueries({ queryKey: ["today-planned-strength"] });
    },
    onError: (e) => setBanner((e as Error).message),
  });

  const saveAsRoutine = useMutation({
    mutationFn: async () => {
      if (!session.length) return;
      const rid = crypto.randomUUID();
      const { error } = await supabase.from("strength_routines").insert({
        id: rid, name: name.trim() || "Routine", created_at: Date.now(),
      });
      if (error) throw error;
      const items = session.map((ex, i) => ({
        id: crypto.randomUUID(), routine_id: rid, exercise_name: ex.name,
        position: i, target_sets: ex.sets.length, target_reps: "", rest_sec: 120,
      }));
      const { error: ie } = await supabase.from("strength_routine_items").insert(items);
      if (ie) throw ie;
    },
    onSuccess: () => {
      setBanner(`✓ Saved routine “${name.trim() || "Routine"}”`);
      qc.invalidateQueries({ queryKey: ["strength-routines"] });
    },
    onError: (e) => setBanner((e as Error).message),
  });

  const deleteRoutine = useMutation({
    mutationFn: async (id: string) => {
      await supabase.from("strength_routine_items").delete().eq("routine_id", id);
      await supabase.from("strength_routines").delete().eq("id", id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["strength-routines"] }),
  });

  // Weekly volume per muscle (working-set count) from the rich model.
  const { volume, maxVol, overload, history } = useMemo(() => {
    const ws = workouts.data?.workouts ?? [];
    const sets = workouts.data?.sets ?? [];
    const dateOfWorkout = new Map(ws.map((w) => [w.id, dayOf(w.started_at)]));
    const setsByWorkout = new Map<string, CloudSet[]>();
    for (const s of sets) {
      const arr = setsByWorkout.get(s.workout_id) ?? [];
      arr.push(s);
      setsByWorkout.set(s.workout_id, arr);
    }
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const volMap = new Map<string, number>();
    for (const s of sets) {
      if (s.is_warmup) continue;
      const d = dateOfWorkout.get(s.workout_id) ?? "";
      if (d < since7) continue;
      volMap.set(s.muscle, (volMap.get(s.muscle) ?? 0) + 1);
    }
    const volume = [...volMap.entries()].sort((a, b) => b[1] - a[1]);
    const maxVol = Math.max(1, ...volume.map(([, v]) => v));

    // e1RM trend per exercise across the last two sessions that hit it.
    const byExercise = new Map<string, { date: string; best: number }[]>();
    for (const w of ws) {
      const exMap = new Map<string, number>();
      for (const s of setsByWorkout.get(w.id) ?? []) {
        if (s.is_warmup || s.reps <= 0 || (s.quantity_unit ?? "reps") !== "reps" || /band|assisted/i.test(s.exercise_name)) continue;
        exMap.set(s.exercise_name, Math.max(exMap.get(s.exercise_name) ?? 0, epley1rm(s.weight_kg, s.reps)));
      }
      for (const [exName, best] of exMap) {
        const arr = byExercise.get(exName) ?? [];
        arr.push({ date: dayOf(w.started_at), best });
        byExercise.set(exName, arr);
      }
    }
    const overload: { name: string; up: boolean }[] = [];
    for (const [exName, list] of byExercise) {
      if (list.length < 2) continue;
      overload.push({ name: exName, up: list[0].best > list[1].best });
    }

    const history = ws.map((w) => ({ w, sets: setsByWorkout.get(w.id) ?? [] }));
    return { volume, maxVol, overload, history };
  }, [workouts.data]);

  const openDetail = openSession ? history.find((h) => h.w.id === openSession) : null;

  // --- session detail (history) ---------------------------------------------
  if (openDetail) {
    const byEx = new Map<string, CloudSet[]>();
    for (const s of openDetail.sets) { const a = byEx.get(s.exercise_name) ?? []; a.push(s); byEx.set(s.exercise_name, a); }
    return (
      <div className="space-y-4 pb-4">
        <button onClick={() => setOpenSession(null)} className="text-sm text-muted-foreground hover:text-foreground">
          ‹ Back to Strength
        </button>
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold">{openDetail.w.name}</h1>
            <p className="text-sm text-muted-foreground">
              {dayOf(openDetail.w.started_at)} · {Math.round(openDetail.w.total_volume_kg)} kg
              {openDetail.w.duration_sec > 0 && ` · ${Math.round(openDetail.w.duration_sec / 60)} min`}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => startEditing(openDetail.w, openDetail.sets)}>
            Edit session
          </Button>
        </header>

        <Card>
          <CardContent className="p-4">
            <StrengthAnalysisSection date={dayOf(openDetail.w.started_at)} workoutId={openDetail.w.id} />
          </CardContent>
        </Card>

        {[...byEx.entries()].map(([exName, exSets]) => (
          <Card key={exName}>
            <CardHeader className="pb-1"><CardTitle className="text-base">{exName}</CardTitle></CardHeader>
            <CardContent className="space-y-1">
              {exSets.sort((a, b) => a.idx - b.idx).map((s) => (
                <div key={s.id} className="flex items-center gap-3 text-sm">
                  <span className="w-8 text-xs text-muted-foreground">#{s.idx}</span>
                  <span className="font-medium tabular-nums">
                    {isCardioExercise(s.exercise_name, s.muscle) ? `${s.reps} min` : `${s.weight_kg} kg × ${s.reps}`}
                  </span>
                  {s.rpe != null && <span className="text-xs text-muted-foreground">RPE {s.rpe}</span>}
                  {s.is_warmup && <Badge variant="outline">warmup</Badge>}
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-4">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Strength</h1>
        <p className="text-sm text-muted-foreground">{history.length} workouts logged · synced with your phone</p>
      </header>

      {banner && <p className="text-sm text-primary">{banner}</p>}

      {/* Today's planned strength session(s) from the calendar */}
      {(todayPlanned.data ?? []).map((pw) => (
        <Card key={pw.id} className="border-sand/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base" style={{ color: "hsl(var(--sand))" }}>Today&apos;s plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <h3 className="text-lg font-semibold">{pw.workout_json.title}</h3>
            <WorkoutDetail workout={pw.workout_json} />
            {pw.completed ? (
              <p className="text-sm text-primary">✓ Completed</p>
            ) : (
              <Button className="w-full" onClick={() => seedFromWorkout(pw.workout_json, pw.id)}>
                <Play className="h-4 w-4" /> Start this session
              </Button>
            )}
          </CardContent>
        </Card>
      ))}

      {/* Start actions */}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={startFromLast}>
          <Dumbbell className="h-4 w-4" /> Repeat last
        </Button>
        <Button variant="outline" disabled={generating} onClick={generateAiLift}>
          <Sparkles className="h-4 w-4" /> {generating ? "Generating…" : "AI lift"}
        </Button>
      </div>

      {/* Session builder */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              {editing ? `Editing · ${dayOf(editing.started_at)}` : "Log a session"}
            </CardTitle>
            {session.length > 0 && (
              <button onClick={discard} className="text-xs text-muted-foreground hover:text-red-400">
                {editing ? "Cancel edit" : "Discard"}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="Session name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Session notes, including band and anchor setup" value={note} onChange={e => setNote(e.target.value)} />

          {session.map((ex, ei) => (
            <div key={ei} className="space-y-2 rounded-xl border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{ex.name}</span>
                <button onClick={() => removeExercise(ei)} className="text-muted-foreground hover:text-red-400"><X className="h-4 w-4" /></button>
              </div>
              {lastSetsByExercise.get(ex.name) && (
                <p className="text-[11px] text-muted-foreground">
                  Last time: {lastSetsByExercise.get(ex.name)!.map((s) => `${s.weight_kg}×${s.reps} ${s.quantity_unit ?? "reps"}`).join(", ")}
                </p>
              )}
              {ex.sets.map((s, si) => {
                const cardio = isCardioExercise(ex.name, ex.muscle);
                return (
                <div key={si} className="flex items-center gap-2">
                  {cardio ? (
                    <>
                      <Input type="number" value={s.reps} className="w-20"
                        onChange={(e) => patchSet(ei, si, { reps: +e.target.value })} />
                      <span className="text-xs text-muted-foreground">min</span>
                    </>
                  ) : (
                    <>
                      <Input type="number" value={s.weight_kg} className="w-20"
                        onChange={(e) => patchSet(ei, si, { weight_kg: +e.target.value })} />
                      <span className="text-xs text-muted-foreground">{metadata.find(m => m.name === ex.name)?.load_mode === "assistance" ? "assist kg ×" : "kg ×"}</span>
                      <Input type="number" value={s.reps} className="w-16"
                        onChange={(e) => patchSet(ei, si, { reps: +e.target.value })} />
                    </>
                  )}
                  <select aria-label="Logging unit" value={s.quantity_unit ?? (cardio ? "minutes" : "reps")} onChange={e => patchSet(ei, si, { quantity_unit: e.target.value })} className="bg-background text-xs">
                    {["reps", "seconds", "metres", "minutes"].map(unit => <option key={unit}>{unit}</option>)}
                  </select>
                  <Input
                    type="number" placeholder="RPE" value={s.rpe ?? ""} className="w-16"
                    onChange={(e) => patchSet(ei, si, { rpe: e.target.value ? +e.target.value : null })}
                  />
                  {!cardio && (
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input type="checkbox" checked={!!s.is_warmup} onChange={(e) => patchSet(ei, si, { is_warmup: e.target.checked })} className="accent-primary" />
                      warmup
                    </label>
                  )}
                  {ex.sets.length > 1 && (
                    <button onClick={() => removeSet(ei, si)} className="ml-auto text-muted-foreground hover:text-red-400"><X className="h-3.5 w-3.5" /></button>
                  )}
                </div>
                );
              })}
              <Button size="sm" variant="ghost" onClick={() => addSet(ei)}><Plus className="h-3.5 w-3.5" /> Set</Button>
            </div>
          ))}

          <div className="flex gap-2">
            <select
              className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm"
              value={picker}
              onChange={(e) => addExercise(e.target.value)}
            >
              <option value="">+ Add exercise…</option>
              {lib.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
            </select>
          </div>

          {session.length > 0 && (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{session.length} exercise(s)</span>
                <span>Volume: <b>{Math.round(sessionVolume)} kg</b></span>
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? "Saving…" : editing ? "Save changes" : linkedPlannedId ? "Finish, marks plan done" : "Finish workout"}
                </Button>
                <Button variant="ghost" disabled={saveAsRoutine.isPending} onClick={() => saveAsRoutine.mutate()}>
                  Save as routine
                </Button>
              </div>
              {save.isError && <p className="text-sm text-red-400">{(save.error as Error).message}</p>}
            </>
          )}
        </CardContent>
      </Card>

      {/* Routines */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Routines</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            A reusable template for a single session, your exercises pre-loaded so you can start a workout in one tap.
          </p>
          {(routines.data?.routines ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No routines yet. Build a session above and “Save as routine”.</p>
          )}
          {(routines.data?.routines ?? []).map((r) => {
            const items = (routines.data?.items ?? []).filter((i) => i.routine_id === r.id).sort((a, b) => a.position - b.position);
            return (
              <div key={r.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{r.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{items.map((i) => i.exercise_name).join(", ") || "empty"}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => startFromRoutine(r)}>Start</Button>
                <button onClick={() => deleteRoutine.mutate(r.id)} className="p-1.5 text-muted-foreground hover:text-red-400">
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Weekly volume */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Weekly volume by muscle group</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {volume.length === 0 && <p className="text-sm text-muted-foreground">No working sets logged this week.</p>}
          {volume.map(([mg, v]) => (
            <div key={mg} className="space-y-1">
              <div className="flex justify-between text-xs"><span className="capitalize">{mg}</span><span className="text-muted-foreground">{v} sets</span></div>
              <div className="h-2 rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary" style={{ width: `${(v / maxVol) * 100}%` }} />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Rich history, click a session for full detail + analysis */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Recent sessions</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {history.length === 0 && <p className="text-sm text-muted-foreground">No sessions yet.</p>}
          {history.slice(0, 12).map(({ w, sets }) => {
            const byEx = new Map<string, CloudSet[]>();
            for (const s of sets) { const a = byEx.get(s.exercise_name) ?? []; a.push(s); byEx.set(s.exercise_name, a); }
            return (
              <button
                key={w.id}
                onClick={() => setOpenSession(w.id)}
                className="w-full rounded-xl border border-border/60 p-3 text-left transition-colors hover:border-primary"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{w.name}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {dayOf(w.started_at)} <ChevronRight className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <span className="meta-chip">{Math.round(w.total_volume_kg)} kg</span>
                  {w.duration_sec > 0 && <span className="meta-chip">{Math.round(w.duration_sec / 60)} min</span>}
                </div>
                <div className="mt-2 space-y-0.5 text-sm">
                  {[...byEx.entries()].map(([exName, exSets]) => {
                    const work = exSets.filter((s) => !s.is_warmup);
                    const ov = overload.find((o) => o.name === exName);
                    return (
                      <div key={exName} className="flex items-center justify-between">
                        <span>{exName} <span className="text-muted-foreground">· {work.length}×</span></span>
                        {ov?.up && <Badge variant="success">↑ overload</Badge>}
                      </div>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
