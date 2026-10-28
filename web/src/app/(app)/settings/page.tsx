"use client";

import { PlanningControls } from "@/components/planning-controls";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient, currentUserId } from "@/lib/supabase-browser";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { OnboardingData } from "@shared/types";
import { DataExport } from "@/components/data-export";
import { ZonesRaces } from "@/components/zones-races";
import { useRouter } from "next/navigation";
import { ChevronRight, Cpu, Activity, Moon, Sun } from "lucide-react";

const GOALS = ["5K pace", "10K pace", "Half Marathon", "Marathon pace", "General fitness", "Muscle gain", "Body recomposition", "Hybrid athlete"];
const EQUIPMENT = ["Bodyweight", "Dumbbells", "Full gym", "Barbell + rack"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DURATIONS = [30, 45, 60, 90];
const LEVELS = ["Beginner", "Intermediate", "Advanced"] as const;

export default function SettingsPage() {
  const qc = useQueryClient();
  const supabase = createClient();
  const { theme, setTheme } = useTheme();

  const profile = useQuery({
    queryKey: ["profile-onboarding"],
    queryFn: async () => {
      // intervals_api_key_hint arrives with migration 27 — retry without it
      // when the column doesn't exist yet.
      let res = await supabase
        .from("user_profiles")
        .select("onboarding, intervals_athlete_id, intervals_api_key_hint, auto_plan, coach_knowledge")
        .single();
      if (res.error) {
        res = await supabase
          .from("user_profiles")
          .select("onboarding, intervals_athlete_id, auto_plan, coach_knowledge")
          .single();
      }
      if (res.error) throw res.error;
      return res.data as {
        onboarding: OnboardingData;
        intervals_athlete_id: string | null;
        intervals_api_key_hint?: string | null;
        auto_plan: boolean | null;
        coach_knowledge: string | null;
      };
    },
  });

  // Local editable copy, seeded once the profile loads.
  const [draft, setDraft] = useState<OnboardingData | null>(null);
  useEffect(() => {
    if (profile.data && draft === null) setDraft(profile.data.onboarding ?? {});
  }, [profile.data, draft]);

  const save = useMutation({
    mutationFn: async (next: OnboardingData) => {
      const { error } = await supabase
        .from("user_profiles")
        .update({ onboarding: next })
        .eq("id", await currentUserId(supabase));
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile-onboarding"] }),
  });

  const router = useRouter();
  const [knowledge, setKnowledge] = useState<string | null>(null);
  useEffect(() => {
    if (profile.data && knowledge === null) setKnowledge(profile.data.coach_knowledge ?? "");
  }, [profile.data, knowledge]);

  const saveKnowledge = useMutation({
    mutationFn: async (text: string) => {
      const { error } = await supabase.from("user_profiles").update({ coach_knowledge: text }).eq("id", await currentUserId(supabase));
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile-onboarding"] }),
  });

  const setAutoPlan = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase.from("user_profiles").update({ auto_plan: enabled }).eq("id", await currentUserId(supabase));
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile-onboarding"] }),
  });

  const signOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const o = draft;
  const patch = (p: Partial<OnboardingData>) => setDraft((d) => ({ ...(d ?? {}), ...p }));
  const toggleDay = (d: string) =>
    patch({ days: (o?.days ?? []).includes(d) ? (o!.days ?? []).filter((x) => x !== d) : [...(o?.days ?? []), d] });

  return (
    <div className="space-y-5 pb-4">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Training profile, appearance &amp; AI</p>
      </header>

      {/* Training profile -------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Training profile</CardTitle>
          <CardDescription>Tunes every AI workout to you.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!o ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <Field label="Goal">
                <select
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={o.goal ?? ""}
                  onChange={(e) => patch({ goal: e.target.value })}
                >
                  <option value="">Select…</option>
                  {GOALS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </Field>

              <Field label="Experience">
                <ChipRow>
                  {LEVELS.map((x) => (
                    <Chip key={x} active={o.experience === x} onClick={() => patch({ experience: x })}>{x}</Chip>
                  ))}
                </ChipRow>
              </Field>

              <Field label="Available days">
                <ChipRow>
                  {DAYS.map((d) => (
                    <Chip key={d} active={(o.days ?? []).includes(d)} onClick={() => toggleDay(d)}>{d}</Chip>
                  ))}
                </ChipRow>
              </Field>

              <Field label="Session length">
                <ChipRow>
                  {DURATIONS.map((d) => (
                    <Chip key={d} active={o.session_duration === d} onClick={() => patch({ session_duration: d })}>{d}m</Chip>
                  ))}
                </ChipRow>
              </Field>

              <Field label="Equipment">
                <select
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={o.equipment ?? ""}
                  onChange={(e) => patch({ equipment: e.target.value })}
                >
                  <option value="">Select…</option>
                  {EQUIPMENT.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </Field>

              <PlanningControls o={o} patch={patch} />
              <Field label="Workout construction">
                <select className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={o.prescription_engine ?? "model"} onChange={e => patch({ prescription_engine: e.target.value as "model" | "deterministic" })}>
                  <option value="model">Coach interpreted workouts</option>
                  <option value="deterministic">Structured familiarization templates</option>
                </select>
                <p className="text-xs text-muted-foreground">Templates use effort targets and recent training. Custom written requests still use the coach.</p>
              </Field>
              <Field label="Primary sport">
                <select value={o.primary_sport ?? ""} onChange={e => patch({ primary_sport: e.target.value as OnboardingData["primary_sport"] })}>
                  <option value="">Use selected sports order</option>{["run", "ride", "swim", "strength"].map(sport => <option key={sport}>{sport}</option>)}
                </select>
              </Field>
              <label className="flex gap-2 text-sm"><input type="checkbox" checked={o.training_history_confirmed ?? false} onChange={e => patch({ training_history_confirmed: e.target.checked })} />Recent recorded and manual activities represent my last four weeks of training.</label>
              <Field label="Weekly time limit (minutes)">
                <Input type="number" min={0} value={o.weekly_minutes_max ?? ""} onChange={e => patch({ weekly_minutes_max: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })} />
              </Field>
              <Field label="Available implements">
                <ChipRow>{["dumbbells", "barbell", "rack", "stable_bench", "kettlebell", "pullup_bar", "resistance_band", "band_anchor", "cable_machine", "treadmill", "indoor_trainer", "stationary_bike", "power_meter"].map(item =>
                  <Chip key={item} active={o.implements?.includes(item) ?? false} onClick={() => patch({ implements: o.implements?.includes(item) ? o.implements.filter(x => x !== item) : [...(o.implements ?? []), item] })}>{item.replaceAll("_", " ")}</Chip>
                )}</ChipRow>
                <p className="text-xs text-muted-foreground">Selecting implements makes this list authoritative. A bench, rack and band anchor are separate items.</p>
              </Field>
              {(["run", "ride", "swim", "strength"] as const).map(sport => <Field key={sport} label={`${sport} program objective`}>
                <select value={o.program_objectives?.[sport] ?? "fitness"} onChange={e => patch({ program_objectives: { ...o.program_objectives, [sport]: e.target.value } })}>
                  {(sport === "strength" ? ["fitness", "strength", "hypertrophy", "return"] : ["fitness", "performance", "technique", "return"]).map(objective => <option key={objective}>{objective}</option>)}
                </select>
              </Field>)}
              {(["run", "ride", "swim"] as const).map(sport => <Field key={sport} label={`${sport} venue`}>
                <select value={o.venues?.[sport] ?? (sport === "swim" ? "pool" : "unspecified")} onChange={e => patch({ venues: { ...o.venues, [sport]: e.target.value } })}>
                  {(sport === "run" ? ["unspecified", "road", "trail", "treadmill"] : sport === "ride" ? ["unspecified", "road", "gravel", "mtb", "indoor"] : ["pool", "open_water"]).map(venue => <option key={venue}>{venue}</option>)}
                </select>
              </Field>)}
              <Field label="Swimming pool">
                <Input type="number" min={1} placeholder="Pool length" value={o.pool?.length ?? ""} onChange={e => patch({ pool: e.target.value ? { ...o.pool, length: Number(e.target.value), unit: o.pool?.unit ?? "m", strokes: o.pool?.strokes ?? ["freestyle"] } : undefined })} />
                {o.pool && <>
                  <Input type="number" min={1} max={600} placeholder="Comfortable seconds per pool length (optional)" value={o.pool.seconds_per_length ?? ""} onChange={e => patch({ pool: { ...o.pool!, seconds_per_length: e.target.value ? Number(e.target.value) : undefined } })} />
                  <select value={o.pool.unit} onChange={e => patch({ pool: { ...o.pool!, unit: e.target.value as "m" | "yd" } })}><option value="m">Metres</option><option value="yd">Yards</option></select>
                  <select value={o.pool.strokes[0] ?? "freestyle"} onChange={e => patch({ pool: { ...o.pool!, strokes: [e.target.value] } })}>{["freestyle", "backstroke", "breaststroke"].map(stroke => <option key={stroke}>{stroke}</option>)}</select>
                </>}
              </Field>

              {/* The goal RACE is named by the starred row in Goals & races
                  below, which owns it. This line used to print onboarding.goal
                  beside the race date, which is the athlete's training goal
                  wearing a race's clothes. */}
              {(o.goal_date || o.target_pace) && (
                <p className="text-xs text-muted-foreground">
                  Goal race{o.goal_date ? `: ${o.goal_date}` : ""}
                  {o.target_pace ? ` · target ${o.target_pace}` : ""} (starred in Goals &amp; races below)
                </p>
              )}
              <Input
                placeholder="Injury history (optional)"
                value={o.injury_history ?? ""}
                onChange={(e) => patch({ injury_history: e.target.value })}
              />
              <Field label="Weekly load target">
                <Input
                  type="number"
                  placeholder="Target weekly TSS (blank = auto-estimate)"
                  value={o.weekly_tss_target ?? ""}
                  onChange={(e) => patch({ weekly_tss_target: e.target.value ? +e.target.value : undefined })}
                />
              </Field>

              <Button className="w-full" disabled={save.isPending} onClick={() => save.mutate(o)}>
                {save.isPending ? "Saving…" : "Save profile"}
              </Button>
              {save.isSuccess && <p className="text-center text-sm text-primary">✓ Saved</p>}
              {save.isError && <p className="text-center text-sm text-red-400">{(save.error as Error).message}</p>}
            </>
          )}
        </CardContent>
      </Card>

      {/* Goals & races + training zones -------------------------------------- */}
      <ZonesRaces />

      {/* Planning ------------------------------------------------------------ */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Planning</CardTitle></CardHeader>
        <CardContent>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={profile.data?.auto_plan ?? false}
              onChange={(e) => setAutoPlan.mutate(e.target.checked)}
            />
            <span>
              <span className="block font-medium">Auto-plan next week</span>
              <span className="block text-xs text-muted-foreground">
                Every Sunday the AI lays out your week and (if connected) pushes it to your watch.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      {/* Coach knowledge ----------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Coach knowledge</CardTitle>
          <CardDescription>
            Durable facts your coach must respect on every plan, injuries, equipment, scheduling.
            The coach chat updates this automatically; you can edit it here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            className="min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={"- Left knee tendinitis, avoid deep knee flexion\n- Home gym: dumbbells + bands only\n- Runs only before work (mornings)"}
            value={knowledge ?? ""}
            onChange={(e) => setKnowledge(e.target.value)}
          />
          <Button className="w-full" disabled={saveKnowledge.isPending || knowledge === null} onClick={() => saveKnowledge.mutate(knowledge ?? "")}>
            {saveKnowledge.isPending ? "Saving…" : "Save knowledge"}
          </Button>
          {saveKnowledge.isSuccess && <p className="text-center text-sm text-primary">✓ Saved</p>}
        </CardContent>
      </Card>

      {/* Appearance -------------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Appearance</CardTitle></CardHeader>
        <CardContent>
          <ChipRow>
            <Chip active={theme === "dark"} onClick={() => setTheme("dark")}>
              <Moon className="mr-1.5 inline h-3.5 w-3.5" />Dark
            </Chip>
            <Chip active={theme === "light"} onClick={() => setTheme("light")}>
              <Sun className="mr-1.5 inline h-3.5 w-3.5" />Light
            </Chip>
          </ChipRow>
        </CardContent>
      </Card>

      {/* Links ------------------------------------------------------------- */}
      <Card>
        <CardContent className="p-0">
          <LinkRow href="/settings/llm" icon={<Cpu className="h-5 w-5" />} title="AI provider" subtitle="Choose & test your LLM keys" />
          <div className="mx-4 border-t border-border/60" />
          <LinkRow
            href="/onboarding"
            icon={<Activity className="h-5 w-5" />}
            title="Intervals.icu connection"
            subtitle={profile.data?.intervals_athlete_id
              ? `Connected · athlete ${profile.data.intervals_athlete_id} · key ${profile.data.intervals_api_key_hint ?? "••••••••"}`
              : "Not connected"}
          />
        </CardContent>
      </Card>

      {/* Data export --------------------------------------------------------- */}
      <DataExport />

      {/* Account ------------------------------------------------------------- */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <p className="text-sm font-semibold">Workout Maker</p>
          <p className="text-xs text-muted-foreground">Personalised endurance + strength coaching.</p>
          <Button variant="outline" className="w-full" onClick={signOut}>Sign out</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="label-caps">{label}</p>
      {children}
    </div>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
        active
          ? "border-transparent bg-accent/60 font-medium text-primary"
          : "border-sand/50 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LinkRow({ href, icon, title, subtitle }: { href: string; icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <Link href={href} className="flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-accent/20">
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{subtitle}</span>
      </span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}
