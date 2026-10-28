"use client";
import { useState } from "react";
import type { OnboardingData } from "@shared/types";
import metadata from "@shared/exercise_metadata.json";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const sports = ["run", "ride", "swim", "strength"] as const;
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const inventory = [...new Set([...metadata.flatMap(e => e.implements), "treadmill", "indoor_trainer", "stationary_bike", "power_meter", "heart_rate_monitor"])].sort();
export function PlanningControls({ o, patch }: { o: OnboardingData; patch: (value: Partial<OnboardingData>) => void }) {
  const [search, setSearch] = useState("");
  const [cal, setCal] = useState({ sport: "run", kind: "pace", value: "", date: new Date().toLocaleDateString("sv-SE"), reliability: "measured", distance: "" });
  const windows = o.session_windows ?? [];
  const setWindow = (day: string, slot: number, change: Partial<(typeof windows)[number]>) => patch({ session_windows: windows.map(w => w.day === day && w.slot === slot ? { ...w, ...change } : w) });
  const checks = o.open_water ?? { date: "", experienced: false, supervised_venue: false, buddy: false, venue_open: false, conditions_approved_by_venue: false, stroke: "freestyle", max_minutes: 20 };
  return <div className="space-y-4">
    <details className="rounded-md border p-3"><summary>Session windows and multisport goals</summary><div className="mt-3 space-y-2">
      <label className="block text-sm">Multisport goal <select value={o.multisport_goal ?? "none"} onChange={e => patch({ multisport_goal: e.target.value as OnboardingData["multisport_goal"] })}>{["none", "triathlon", "duathlon"].map(goal => <option key={goal}>{goal}</option>)}</select></label>
      <label className="block text-sm">Recovery between independent sessions (minutes)<Input type="number" min={60} value={o.minimum_session_gap_minutes ?? 180} onChange={e => patch({ minimum_session_gap_minutes: Number(e.target.value) })} /></label>
      {(o.days?.length ? o.days : days).map(day => <div key={day} className="space-y-2 border-t pt-2">
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={windows.some(w => w.day === day && w.slot === 1)} onChange={e => {
          const length = Math.max(10, Math.floor((o.session_duration_max ?? o.session_duration ?? 60) / 2));
          patch({ session_windows: [...windows.filter(w => w.day !== day), ...(e.target.checked ? [{ day, slot: 0, start_minute: 420, max_minutes: length }, { day, slot: 1, start_minute: 1080, max_minutes: length }] : [])] });
        }} />{day}: two sessions</label>
        {windows.filter(w => w.day === day).map(w => <div key={w.slot} className="flex items-center gap-2 text-xs">
          <span>Session {w.slot + 1}</span><Input type="time" value={`${String(Math.floor(w.start_minute / 60)).padStart(2, "0")}:${String(w.start_minute % 60).padStart(2, "0")}`} onChange={e => { const [hour, minute] = e.target.value.split(":").map(Number); if (Number.isFinite(hour + minute)) setWindow(day, w.slot, { start_minute: hour * 60 + minute }); }} />
          <Input type="number" min={1} aria-label={`${day} session ${w.slot + 1} available minutes`} value={w.max_minutes} onChange={e => setWindow(day, w.slot, { max_minutes: Number(e.target.value) })} /><span>minutes</span>
        </div>)}
      </div>)}
    </div></details>
    <label className="block text-sm">Recovery day preference <select value={o.recovery_day_style ?? "rest"} onChange={e => patch({ recovery_day_style: e.target.value as OnboardingData["recovery_day_style"] })}>{["rest", "mobility", "optional_light", "active_recovery"].map(style => <option key={style}>{style}</option>)}</select></label>
    <details className="rounded-md border p-3"><summary>Program start and event preparation</summary><div className="mt-3 space-y-2">
      <label className="block text-sm">Program start<Input type="date" value={o.program_started_on ?? ""} onChange={e => patch({ program_started_on: e.target.value || undefined })} /></label>
      {sports.map(sport => { const policy = o.event_policies?.[sport]; return <div key={sport} className="space-y-2 border-t pt-2">
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!policy} onChange={e => { const policies = { ...o.event_policies }; if (e.target.checked) policies[sport] = { days: 7, duration_factor: 0.7, allow_quality: false }; else delete policies[sport]; patch({ event_policies: policies }); }} />{sport}: apply a chosen event preparation window</label>
        {policy && <><label className="block text-xs">Preparation days<Input type="number" min={1} max={28} value={policy.days} onChange={e => patch({ event_policies: { ...o.event_policies, [sport]: { ...policy, days: Number(e.target.value) } } })} /></label>
          <label className="block text-xs">Usual duration retained (%)<Input type="number" min={1} max={100} value={Math.round(policy.duration_factor * 100)} onChange={e => patch({ event_policies: { ...o.event_policies, [sport]: { ...policy, duration_factor: Number(e.target.value) / 100 } } })} /></label>
          <label className="flex gap-2 text-xs"><input type="checkbox" checked={policy.allow_quality} onChange={e => patch({ event_policies: { ...o.event_policies, [sport]: { ...policy, allow_quality: e.target.checked } } })} />Keep eligible quality work; recovery checks still apply</label></>}
      </div>; })}
    </div></details>
    <details className="rounded-md border p-3"><summary>Full equipment inventory</summary><div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">This inventory overrides broad gym categories, including individual benches, racks, anchors and machines.</p><Input placeholder="Find equipment" value={search} onChange={e => setSearch(e.target.value)} />
      {inventory.filter(item => item.replaceAll("_", " ").includes(search.toLowerCase())).map(item => <label key={item} className="flex gap-2 text-sm"><input type="checkbox" checked={o.implements?.includes(item) ?? false} onChange={e => patch({ implements: e.target.checked ? [...(o.implements ?? []), item] : o.implements?.filter(i => i !== item) ?? [] })} />{item.replaceAll("_", " ")}</label>)}
    </div></details>
    <details className="rounded-md border p-3"><summary>Dated calibration and personal bests</summary><div className="mt-3 space-y-2">
      {o.calibrations?.map((c, index) => <div key={index} className="text-xs">{c.sport}: {c.kind}, {c.value}, {c.date} ({c.reliability}) <button onClick={() => patch({ calibrations: o.calibrations!.filter((_, i) => i !== index) })}>Remove</button></div>)}
      <select value={cal.sport} onChange={e => setCal({ ...cal, sport: e.target.value })}>{["run", "ride", "swim"].map(s => <option key={s}>{s}</option>)}</select>
      <select value={cal.kind} onChange={e => setCal({ ...cal, kind: e.target.value })}>{["pace", "power", "heart_rate", "personal_best"].map(k => <option key={k}>{k}</option>)}</select>
      <p className="text-xs text-muted-foreground">Pace: seconds/km running or seconds/100m swimming. Power: watts. Heart rate: threshold bpm. Personal best: elapsed seconds, never used as a threshold.</p>
      <Input type="number" min={1} placeholder="Value" value={cal.value} onChange={e => setCal({ ...cal, value: e.target.value })} />
      {cal.kind === "personal_best" && <Input type="number" min={1} placeholder="Distance in metres" value={cal.distance} onChange={e => setCal({ ...cal, distance: e.target.value })} />}
      <Input type="date" value={cal.date} onChange={e => setCal({ ...cal, date: e.target.value })} />
      <select value={cal.reliability} onChange={e => setCal({ ...cal, reliability: e.target.value })}>{["measured", "estimated", "unknown"].map(r => <option key={r}>{r}</option>)}</select>
      <Button type="button" variant="outline" onClick={() => { if (Number(cal.value) > 0 && cal.date && (cal.kind !== "personal_best" || Number(cal.distance) > 0)) patch({ calibrations: [...(o.calibrations ?? []), { sport: cal.sport as "run" | "ride" | "swim", kind: cal.kind as "pace" | "power" | "heart_rate" | "personal_best", value: Number(cal.value), date: cal.date, reliability: cal.reliability as "measured" | "estimated" | "unknown", distance_m: cal.distance ? Number(cal.distance) : undefined }] }); }}>Add calibration</Button>
    </div></details>
    <details className="rounded-md border p-3"><summary>Open-water venue checks</summary><div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">Your confirmations record eligibility for a supervised session; they are not a safety assurance. Unconfirmed dates use a configured pool alternative.</p>
      <Input type="date" value={checks.date} onChange={e => patch({ open_water: { ...checks, date: e.target.value } })} />
      {([['experienced', 'Prior open-water experience'], ['supervised_venue', 'Supervised venue'], ['buddy', 'Buddy arranged'], ['venue_open', 'Venue open for this date'], ['conditions_approved_by_venue', 'Conditions permitted by the venue']] as const).map(([key, label]) => <label key={key} className="flex gap-2 text-sm"><input type="checkbox" checked={checks[key]} onChange={e => patch({ open_water: { ...checks, [key]: e.target.checked } })} />{label}</label>)}
      <select value={checks.stroke} onChange={e => patch({ open_water: { ...checks, stroke: e.target.value } })}>{["freestyle", "breaststroke", "backstroke"].map(s => <option key={s}>{s}</option>)}</select>
      <label className="block text-xs">Confirmed session limit (minutes)<Input type="number" min={10} max={120} value={checks.max_minutes} onChange={e => patch({ open_water: { ...checks, max_minutes: Number(e.target.value) } })} /></label>
    </div></details>
  </div>;
}
