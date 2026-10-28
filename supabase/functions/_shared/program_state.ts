import type { SessionObjective, TrainingSport } from "../../../shared/prescription.ts";
import type { ActualExposure } from "./session_engine.ts";

/** Product policy defaults, versioned separately from physiological evidence.
 * Progression is conservative and requires recorded tolerance, never a plan. */
export const PROGRAM_POLICY = {
  version: "program-3", historyDays: 28, interruptionDays: 14,
  durationIncrease: 0.05, reducedDose: 0.7, comfortableResponses: 2,
  familiarizationMinutes: { run: 20, ride: 30, swim: 20, strength: 30, rest: 0 },
} as const;
export interface ProgramGoal {
  id: string;
  sport: TrainingSport;
  objective: "fitness" | "performance" | "technique" | "strength" | "hypertrophy" | "return";
  priority: "primary" | "secondary";
  event_date?: string;
  event_priority?: "A" | "B" | "C";
  /** Product preparation policy; explicit overrides take precedence over the automatic goal-race default. */
  event_policy?: { days: number; duration_factor: number; allow_quality: boolean };
  distance_km?: number;
}
export interface SportProgress {
  sport: TrainingSport;
  phase: "familiarization" | "consistent" | "build" | "reduced" | "event_preparation" | "reassess";
  decision: "progress" | "repeat" | "reduce" | "substitute" | "reassess";
  progression_dimension: "duration" | "none";
  completed_minutes: number;
  completed_sessions: number;
  last_actual_date: string | null;
  session_minutes: number;
  weekly_minutes: number;
  weekly_sessions: number;
  preferred_objective: SessionObjective;
  quality_allowed: boolean;
  reason: string;
}
export interface ProgramState {
  version: 1;
  policy_version: string;
  as_of: string;
  goals: ProgramGoal[];
  sports: SportProgress[];
  shared_effort_minutes: number | null;
  unknown_effort_sessions: number;
  observations: string[];
}
const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86400000;
const dated = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
export function programGoals(o: Record<string, unknown>, sports: TrainingSport[], events: { name?: string | null; date?: string | null; sport?: string | null; priority?: string | null; distance?: string | null }[] = []): ProgramGoal[] {
  const primary = sports.includes(o.primary_sport as TrainingSport) ? o.primary_sport : sports[0];
  const bySport = o.program_objectives && typeof o.program_objectives === "object" ? o.program_objectives as Record<string, unknown> : {};
  const distances = o.distance_goal_km as Record<string, number> | undefined;
  const picks = o.goals_by_sport && typeof o.goals_by_sport === "object" ? o.goals_by_sport as Record<string, unknown> : {};
  const savedObjective = (sport: TrainingSport): ProgramGoal["objective"] => {
    const values = Array.isArray(picks[sport]) ? picks[sport] : Array.isArray(o.goals) ? o.goals : [o.goal ?? ""];
    const text = values.filter((v: unknown)=>typeof v === "string").join(" ");
    if(sport === "strength") return /build muscle|hypertrophy|body recomposition/i.test(text) ? "hypertrophy" : "strength";
    if(/technique|learn to swim|swim skills/i.test(text)) return "technique";
    if(typeof distances?.[sport] === "number" && distances[sport] > 0 || /faster|performance|race|improve.*pace/i.test(text)) return "performance";
    return "fitness";
  };
  const objectiveValues = ["fitness", "performance", "technique", "strength", "hypertrophy", "return"];
  const goals: ProgramGoal[] = sports.map(sport => ({ id: `goal-${sport}`, sport,
    objective: objectiveValues.includes(String(bySport[sport])) ? bySport[sport] as ProgramGoal["objective"] : savedObjective(sport),
    distance_km: typeof distances?.[sport] === "number" ? distances[sport] : undefined,
    priority: sport === primary ? "primary" : "secondary" }));
  const policies = o.event_policies && typeof o.event_policies === "object" ? o.event_policies as Record<string, ProgramGoal["event_policy"]> : {};
  for (const event of events) {
    if (!sports.includes(event.sport as TrainingSport) || !event.date || !dated(event.date) || !["A", "B", "C"].includes(event.priority ?? "")) continue;
    goals.push({ id: `event-${event.sport}-${event.date}-${event.name}`, sport: event.sport as TrainingSport,
      objective: "performance", priority: event.priority === "A" ? "primary" : "secondary",
      event_date: event.date, event_priority: event.priority as "A" | "B" | "C",
      // Reuse the existing preparation preset for goal races. B/C tune-ups do
      // not silently take priority or receive a full goal-race reduction.
      event_policy: policies[event.sport!] ?? (event.priority === "A" && o.automatic_event_preparation !== false
        ? { days: 7, duration_factor: 0.7, allow_quality: false } : undefined) });
  }
  return goals;
}
/** Rebuildable multiweek state. Unknown responses cannot authorize progression.
 * Actual durations and effort remain independent; estimated TSS is not exposure. */
export function deriveProgramState(date: string, goals: ProgramGoal[], actual: ActualExposure[], historyComplete: boolean, profile: Record<string, unknown> = {}): ProgramState {
  if (!dated(date)) throw new Error("Invalid program date");
  const unique = [...new Map(actual.filter(a => a.id && dated(a.date) && days(date, a.date) >= 0 && days(date, a.date) < PROGRAM_POLICY.historyDays).map(a => [a.id, a])).values()];
  const recent = unique.filter(a => days(date, a.date) < 7);
  const sports: SportProgress[] = [...new Set(goals.map(g => g.sport))].map(sport => {
    const all = unique.filter(a => a.sport === sport && a.minutes !== null && Number.isFinite(a.minutes) && a.minutes > 0).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const week = all.filter(a => days(date, a.date) < 7);
    const previous = all.filter(a => days(date, a.date) >= 7 && days(date, a.date) < 14);
    const meaningful = all.filter(a => a.minutes! >= 10);
    const last = meaningful[0]?.date ?? null;
    const pain = week.some(a => a.response === "pain");
    const difficult = week.some(a => a.response === "difficult");
    const gap = !last || days(date, last) >= PROGRAM_POLICY.interruptionDays;
    const goal = goals.find(g => g.sport === sport && !g.event_date) ?? goals.find(g => g.sport === sport)!;
    const events = goals.filter(g => g.sport === sport && g.event_date && days(g.event_date, date) >= 0)
      .sort((a, b) => (a.event_priority ?? "C").localeCompare(b.event_priority ?? "C") || a.event_date!.localeCompare(b.event_date!));
    const event = events.find(g => g.event_policy && days(g.event_date!, date) < g.event_policy.days);
    if (event?.event_policy && (!Number.isFinite(event.event_policy.days) || event.event_policy.days < 1 || event.event_policy.days > 28 ||
        !Number.isFinite(event.event_policy.duration_factor) || event.event_policy.duration_factor <= 0 || event.event_policy.duration_factor > 1)) throw new Error("Invalid event preparation policy");
    const comfortable = meaningful.slice(0, PROGRAM_POLICY.comfortableResponses).length === PROGRAM_POLICY.comfortableResponses &&
      meaningful.slice(0, PROGRAM_POLICY.comfortableResponses).every(a => days(date, a.date) < 14 && a.response === "comfortable" && a.effort !== null && a.effort <= 6);
    const canProgress = historyComplete && !gap && !pain && !difficult && comfortable && week.length > 0 && previous.length > 0 && !event && goal.objective !== "return" && sport !== "strength";
    const completed = week.reduce((sum, a) => sum + a.minutes!, 0);
    // Tiny recordings (strides, transitions, partial imports) still count in
    // workload, but must not randomly become the duration of the next workout.
    const typical = all.filter(a => a.minutes! >= 10).slice(0, 6).map(a => a.minutes!).sort((a,b) => a-b);
    const baseline = typical.length ? typical[Math.floor((typical.length - 1) / 2)] : PROGRAM_POLICY.familiarizationMinutes[sport];
    const start = typeof profile.program_started_on === "string" && dated(profile.program_started_on) ? profile.program_started_on : null;
    const reducedWeek = profile.periodized === true && start && Math.floor(days(date, start) / 7) >= 0 && Math.floor(days(date, start) / 7) % 4 === 3 && previous.length > 0;
    const factor = event?.event_policy?.duration_factor ?? (reducedWeek ? PROGRAM_POLICY.reducedDose : difficult ? PROGRAM_POLICY.reducedDose : canProgress ? 1 + PROGRAM_POLICY.durationIncrease : 1);
    const minutes = gap || !historyComplete ? Math.min(baseline, PROGRAM_POLICY.familiarizationMinutes[sport]) : baseline * factor;
    const phase: SportProgress["phase"] = pain ? "reassess" : gap || !historyComplete ? "familiarization" : event ? "event_preparation" : difficult || reducedWeek ? "reduced" : canProgress ? "build" : "consistent";
    const decision: SportProgress["decision"] = pain ? "reassess" : gap || difficult || event || reducedWeek ? "reduce" : !historyComplete ? "reassess" : canProgress ? "progress" : "repeat";
    const qualityAllowed = historyComplete && !gap && !pain && !difficult && !reducedWeek && new Set(meaningful.map(a=>a.date)).size >= 6 && (event?.event_policy?.allow_quality ?? true);
    return { sport, phase, decision, progression_dimension: canProgress && !reducedWeek ? "duration" : "none",
      completed_minutes: completed, completed_sessions: week.length, last_actual_date: last,
      session_minutes: Math.round(minutes * 60) / 60,
      weekly_minutes: Math.round((completed > 0 ? completed * factor : minutes * 2) * 60) / 60,
      weekly_sessions: gap || !historyComplete ? 2 : Math.max(1, week.length),
      preferred_objective: sport === "strength" ? goal.objective === "hypertrophy" ? "hypertrophy" : "strength" :
        goal.objective === "technique" ? "technique" : goal.objective === "return" && sport === "run" ? "run_walk" : "easy",
      quality_allowed: qualityAllowed,
      reason: pain ? "Pain feedback requires reassessment before progression." : gap ? "Restart with familiarization after the interruption; missed work is not added back." :
        !historyComplete ? "Observation coverage is incomplete; use familiarization rather than increasing training." : event ? `Apply the ${sport} event preparation policy for ${event.event_date}.` :
        reducedWeek ? "The explicit four-week program is in a reduced-load week; keep familiar work and reduce duration." :
        difficult ? "Recent work was reported difficult; reduce duration and keep intensity steady." : canProgress ? "Recent completed sessions were reported comfortable; progress duration only, keeping frequency and intensity steady." :
        "Repeat actual training. Missing response evidence does not authorize an increase." };
  });
  const known = recent.filter(a => a.minutes !== null && Number.isFinite(a.minutes) && a.minutes >= 0 && a.effort !== null && Number.isFinite(a.effort) && a.effort >= 1 && a.effort <= 10);
  const observations = goals.filter(g => g.event_date && days(g.event_date, date) >= 0 && days(g.event_date, date) < 14 && !g.event_policy)
    .map(g => `Upcoming ${g.sport} event ${g.event_date}: no event preparation policy is configured; reassess the goal rather than infer a universal taper.`);
  const availability = typeof profile.weekly_minutes_max === "number" ? profile.weekly_minutes_max : null;
  const completedMinutes = sports.reduce((sum, p) => sum + p.completed_minutes, 0);
  if (availability !== null && completedMinutes > 0 && availability < completedMinutes * 0.75) observations.push("Availability is materially below recent completed training. Reduce the dose and reassess goal timelines rather than promise the previous rate of progress.");
  for (const goal of goals) {
    const exposure = sports.find(p => p.sport === goal.sport);
    if (goal.event_date && days(goal.event_date, date) < 28 && (!historyComplete || !exposure || exposure.completed_sessions < 2)) observations.push(`${goal.sport} event preparation is unverified with current exposure; reassess the event goal or timeline.`);
  }
  const aEvents = goals.filter(g => g.event_date && g.event_priority === "A");
  if (aEvents.some((g, i) => aEvents.slice(i + 1).some(other => Math.abs(days(g.event_date!, other.event_date!)) < 14))) observations.push("Priority events are close together; choose which event receives preparation priority.");
  return { version: 1, policy_version: PROGRAM_POLICY.version, as_of: date, goals, sports,
    shared_effort_minutes: known.length ? known.reduce((sum, a) => sum + a.minutes! * a.effort!, 0) : null,
    unknown_effort_sessions: recent.length - known.length, observations };
}
export function crossTrainingBenefit(planned: string, actual: string): string {
  if (planned === actual) return "Same sport; dose and stimulus still require assessment.";
  if (["run", "ride", "swim"].includes(planned) && ["run", "ride", "swim", "walk", "hike", "rowing"].includes(actual))
    return `Some aerobic work is preserved; ${actual} does not establish ${planned}-specific exposure, technique or mechanical tolerance.`;
  return "Count the actual effort in shared fatigue; sport-specific training benefit is uncertain.";
}
