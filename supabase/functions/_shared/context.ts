import { activityMatchesPlanned } from "./activity_matching.ts";
// Shared athlete-context builders. Both the single-day generator and the weekly
// planner use these so they reason from the same signals (consistency = a more
// mature planner). Each helper is best-effort and returns "" / nulls on failure.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decryptSecret } from "./supabase.ts";
import {
  athleteDemographics,
  type Demographics,
  getAthleteFull,
  getWellness,
  latestWellnessSubjective,
  type ManualDemographics,
  mergeDemographics,
  runHrZones,
  runPaceZones,
} from "./intervals.ts";
import { assessViability, getWeather } from "./weather.ts";
import { paceToSec, paceZonesFromThreshold } from "./zones.ts";

export type HrZone = { zone: string; min: number; max: number };

export interface ActivityRow {
  type?: string | null;
  planned_workout_id?: string | null;
  link_source?: string | null;
  date?: string | null;
  distance_m?: number | null;
  tss?: number | null;
  ctl?: number | null;
  atl?: number | null;
}

// Live Intervals.icu physiology: demographics, threshold pace, zones, VO2max,
// subjective flags. `manual` carries the app's Settings → About you overrides
// (stored in onboarding) — set values beat Intervals, and the demographics line
// still renders when Intervals is disconnected or down.
/**
 * How old a hand-measured number is, in the words a coach would use.
 *
 * A threshold is a perishable fact: the app has always recorded the date a test
 * was logged and shown it in Settings, while the prompt got the bare number, so
 * a two-year-old FTP arrived looking exactly as trustworthy as one from
 * Tuesday. "" when there is no test row, because most numbers are typed in
 * rather than tested and a missing date is not a stale one.
 */
export function testAgeNote(testDate: string | undefined, today: string): string {
  if (!testDate) return "";
  const days = Math.floor(
    (new Date(today + "T12:00:00Z").getTime() - new Date(testDate + "T12:00:00Z").getTime()) / 86_400_000,
  );
  if (days < 0) return "";
  if (days <= 45) return ", tested recently";
  const months = Math.round(days / 30.4);
  if (months < 12) return `, tested ${months} months ago`;
  return `, tested over a year ago, treat it as approximate and worth retesting`;
}

/** Newest test date per kind (lthr / ftp / threshold_pace). Best-effort. */
export async function latestTestDates(
  admin: SupabaseClient,
  userId: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const { data } = await admin
      .from("threshold_tests")
      .select("kind, date")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(30);
    for (const r of data ?? []) {
      const kind = String((r as { kind?: unknown }).kind ?? "");
      const date = String((r as { date?: unknown }).date ?? "");
      if (kind && date && !out[kind]) out[kind] = date;
    }
  } catch (_e) { /* best-effort */ }
  return out;
}

export async function intervalsPhysiology(
  admin: SupabaseClient,
  profile: { intervals_athlete_id?: string | null; intervals_api_key_encrypted?: string | null },
  manual?: ManualDemographics | null,
  self?: { userId: string; today: string } | null,
): Promise<{ apiKey: string | null; hrZones: HrZone[] | null; block: string }> {
  let apiKey: string | null = null;
  let hrZones: HrZone[] | null = null;
  let demo: Demographics = {};
  const lines: string[] = [];
  if (profile.intervals_athlete_id && profile.intervals_api_key_encrypted) {
    try {
      apiKey = await decryptSecret(admin, profile.intervals_api_key_encrypted);
      if (apiKey) {
        const [athlete, ivWellness] = await Promise.all([
          getAthleteFull(profile.intervals_athlete_id, apiKey),
          getWellness(profile.intervals_athlete_id, apiKey, 14),
        ]);
        const hz = runHrZones(athlete);
        if (hz.length) hrZones = hz.map((z) => ({ zone: z.name, min: z.min, max: z.max }));
        const { thresholdPace, zones: paceZones } = runPaceZones(athlete);
        const subj = latestWellnessSubjective(ivWellness);
        demo = athleteDemographics(athlete, subj.weight);
        if (thresholdPace !== "-") lines.push(`- Threshold pace: ${thresholdPace}`);
        if (paceZones.length) lines.push(`- Pace zones: ${paceZones.map((z) => `${z.name} ${z.pace}`).join(", ")} (prescribe exact paces, not just zone labels)`);
        if (subj.vo2max) lines.push(`- VO2max: ${subj.vo2max.toFixed(1)}`);
        if (subj.restingHR) lines.push(`- Resting HR: ${subj.restingHR}`);
        if (subj.hrv) lines.push(`- HRV: ${subj.hrv.toFixed(0)}`);
        const flags: string[] = [];
        if ((subj.fatigue ?? 1) >= 3) flags.push("high fatigue");
        if ((subj.soreness ?? 1) >= 3) flags.push("high soreness");
        if ((subj.stress ?? 1) >= 3) flags.push("high stress");
        if ((subj.motivation ?? 1) >= 3) flags.push("low motivation");
        if ((subj.injury ?? 1) >= 2) flags.push("INJURY flagged, avoid aggravating load");
        if (flags.length) lines.push(`- Subjective flags: ${flags.join(", ")} → reduce intensity/volume accordingly`);
      }
    } catch (_e) {
      // best-effort — manual demographics below still apply
    }
  }
  // The athlete's own numbers, when Intervals did not supply the same thing.
  // Someone who logged a threshold test in the app has a real anchor sitting in
  // the profile; without this it never left the phone, and the prompt asked for
  // "Z2" with no pace to put on it.
  const tested = self ? await latestTestDates(admin, self.userId) : {};
  const age = (kind: string) => (self ? testAgeNote(tested[kind], self.today) : "");
  const typedPace = paceZonesFromThreshold(paceToSec(manual?.threshold_pace_per_km));
  if (typedPace.length && !lines.some((l) => l.startsWith("- Pace zones:"))) {
    lines.push(`- Threshold pace: ${manual?.threshold_pace_per_km} /km (athlete's own${age("threshold_pace")})`);
    lines.push(
      `- Pace zones: ${typedPace.map((z) => `${z.zone} ${z.range}`).join(", ")} ` +
        `(prescribe exact paces, not just zone labels)`,
    );
  }
  if (typeof manual?.ftp === "number" && manual.ftp > 0) {
    lines.push(`- FTP: ${manual.ftp} W (athlete's own${age("ftp")})`);
  }
  // Demographics first: age/sex temper recovery expectations, weight grounds
  // relative-strength and load context. Manual settings win per-field.
  demo = mergeDemographics(demo, manual);
  const demoBits = [
    demo.age != null ? `${demo.age}y` : null,
    demo.sex ?? null,
    demo.weightKg != null ? `${demo.weightKg}kg` : null,
    demo.heightCm != null ? `${demo.heightCm}cm` : null,
  ].filter(Boolean);
  if (demoBits.length) lines.unshift(`- Athlete: ${demoBits.join(", ")}`);
  const block = lines.length
    ? `\n\nMEASURED PHYSIOLOGY (use these exact numbers):\n${lines.join("\n")}`
    : "";
  return { apiKey, hrZones, block };
}



// One analyzed session (from analyze-activity / analyze-strength), stripped to
// the fields the different consumers care about. `components` is only used by
// the generator's verbose block; coach-facing surfaces stick to label+feedback.
export interface DebriefEntry {
  date: string;
  kind: string;
  score: number | null;
  label: string | null;
  feedback: string | null;
  components: { name: string; score: number; detail: string }[];
}

export function clipText(s: string, n = 320): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// Fetch recent execution analyses (endurance + strength), newest first.
// Best-effort: query failures yield fewer entries, never a throw.
export async function fetchRecentDebriefs(
  admin: SupabaseClient,
  userId: string,
  sinceDate: string,
  limit = 6,
): Promise<DebriefEntry[]> {
  interface Comp { name: string; score: number; detail: string }
  interface Analysis { score?: number; label?: string; components?: Comp[]; feedback?: string }
  const toEntry = (date: string, kind: string, a: Analysis): DebriefEntry | null => {
    if (typeof a?.score !== "number" && !a?.feedback) return null;
    return {
      date,
      kind,
      score: typeof a.score === "number" ? a.score : null,
      label: a.label ?? null,
      feedback: a.feedback ?? null,
      components: a.components ?? [],
    };
  };

  const entries: DebriefEntry[] = [];
  try {
    const { data } = await admin
      .from("effective_activities")
      .select("date, type, analysis_json")
      .eq("user_id", userId)
      .not("analysis_json", "is", null)
      .gte("date", sinceDate)
      .order("date", { ascending: false })
      .limit(5);
    for (const r of data ?? []) {
      const e = toEntry(r.date, r.type ?? "session", r.analysis_json as Analysis);
      if (e) entries.push(e);
    }
  } catch (_e) { /* best-effort */ }

  // Strength sessions are analyzed into their own table — fold them in too so
  // EVERY activity type's analysis feeds the next prescriptions.
  try {
    const { data } = await admin
      .from("strength_analyses")
      .select("date, analysis_json")
      .eq("user_id", userId)
      .gte("date", sinceDate)
      .order("date", { ascending: false })
      .limit(3);
    for (const r of data ?? []) {
      const e = toEntry(r.date, "strength", r.analysis_json as Analysis);
      if (e) entries.push(e);
    }
  } catch (_e) { /* table may not exist yet */ }

  return entries.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

// Renders one DebriefEntry as the generator's verbose execution line
// (numbers included — this text feeds the workout generator, not the coach).
export function executionLine(e: DebriefEntry): string {
  const comps = e.components
    .map((c) => `${c.name} ${c.score}/100 (${c.detail})`)
    .join("; ");
  const notes = e.feedback ? ` Analyst notes: "${clipText(e.feedback)}"` : "";
  const score = e.score != null ? `execution ${e.score}/100 "${e.label ?? ""}"` : `"${e.label ?? "analyzed"}"`;
  return `- ${e.date} ${e.kind}: ${score}${comps ? `, ${comps}` : ""}.${notes}`;
}

// Measured execution of recent sessions (from analyze-activity and
// analyze-strength): how well the athlete actually hit planned
// duration/load/intensity, plus the analyzer's written coach notes. Closes the
// autoregulation loop with objective data, not just subjective ratings.
export async function executionBlock(
  admin: SupabaseClient,
  userId: string,
  sinceDate: string,
): Promise<string> {
  const entries = await fetchRecentDebriefs(admin, userId, sinceDate);
  if (!entries.length) return "";
  const lines = entries.map(executionLine).join("\n");
  return `\n\nMEASURED EXECUTION OF RECENT SESSIONS (objective plan-vs-actual analysis with the reviewing coach's notes, autoregulate from this: honor the analyst's cues, repeated intensity overshoot means prescribe easier targets and stress discipline in coach_note; chronic under-duration means shorter or simpler sessions; consistently high scores mean progress as planned):\n${lines}`;
}

export function memoryBlock(profile: { training_memory?: string | null }): string {
  return profile.training_memory
    ? `\n\nATHLETE MEMORY (long-term notes from past sessions, honor these):\n${profile.training_memory}`
    : "";
}

// Recovery signal (HRV/RHR/sleep trends → 0-100) so generation actually
// down-regulates intensity after a poor night, not just on subjective wellness.
export function recoveryBlock(
  recovery: { score: number; band: string; summary: string; basis?: string } | null,
): string {
  if (!recovery) return "";
  // Nothing measured: say that, and give no number. Quoting "50/100 (amber)"
  // told the model to cap at RPE 6 on the strength of a placeholder.
  if (recovery.basis === "none") {
    return "\n\nRECOVERY TODAY: not measured (no check-in, no synced watch data). " +
      "Plan from the training plan and recent load alone. Do not claim to know how " +
      "recovered the athlete is, and do not hold intensity back on that basis.";
  }
  const guide = recovery.band === "red"
    ? `RED (${recovery.score}/100): the athlete is under-recovered, cap at RPE 4, easy aerobic/technique or active-recovery only, and trim volume.`
    : recovery.band === "amber"
    ? `AMBER (${recovery.score}/100): recovery is only moderate, cap today at RPE 6, keep it aerobic/technique (NO intervals, threshold or PR attempts), don't stack a second hard day, and trim a quality session's planned TSS by ~20-30%.`
    : `GREEN (${recovery.score}/100): well recovered, a quality/intensity session is appropriate if the plan calls for it.`;
  return `\n\nRECOVERY TODAY: ${recovery.score}/100 (${recovery.band}). ${recovery.summary}\n${guide}`;
}

// Hard constraints captured from the coach conversation (injuries, equipment the
// athlete has/lacks, scheduling, dislikes). These are RULES, not suggestions.
export function knowledgeBlock(profile: { coach_knowledge?: string | null }): string {
  return profile.coach_knowledge && profile.coach_knowledge.trim()
    ? `\n\nATHLETE CONSTRAINTS & PREFERENCES (HARD RULES from the coaching chat, never violate these):\n${profile.coach_knowledge.trim()}\n` +
      `- If an injury is noted, avoid loading/aggravating it and prefer safe alternatives.\n` +
      `- Only prescribe exercises the athlete's available equipment supports.`
    : "";
}

// Planned vs actually-completed over the last 14 days.
export async function adherenceBlock(
  admin: SupabaseClient,
  userId: string,
  since14: string,
  beforeDate: string,
  acts28: ActivityRow[],
): Promise<string> {
  const { data: plannedRecent } = await admin
    .from("reconciled_plans")
    .select("id, date, type, workout_json, completed, skipped, reconciliation_status")
    .eq("user_id", userId)
    .gte("date", since14)
    .lt("date", beforeDate)
    .neq("type", "rest");
  if (!plannedRecent?.length) return "";

  // One recording can support at most one planned session. Explicit feedback
  // takes precedence; consume its recording too so a second plan cannot reuse it.
  const actual = acts28.filter((a) => (a.date ?? "") >= since14 && (a.date ?? "") < beforeDate);
  const consumed = new Set<number>();
  const completedTss = actual.reduce((sum, a) => sum + (a.tss ?? 0), 0);
  let plannedTss = 0;
  let done = 0;
  let matched = 0;
  const skipped: string[] = [];
  const unmatched: string[] = [];
  const plans = [...plannedRecent].sort((a, b) => Number(!!b.completed) - Number(!!a.completed));
  for (const p of plans) {
    plannedTss += Number((p.workout_json as { tss_estimate?: number })?.tss_estimate ?? 0);
    if (p.skipped) {
      skipped.push(`${p.date} ${p.type}`);
      continue;
    }
    const index = actual.findIndex((a, i) => !consumed.has(i) && a.planned_workout_id === p.id && p.id != null);
    if (index >= 0) consumed.add(index);
    if (p.completed || p.reconciliation_status === "completed_as_planned") done++;
    else if (index >= 0) matched++;
    else unmatched.push(`${p.date} ${p.type}`);
  }
  const volPct = plannedTss > 0 ? Math.round((completedTss / plannedTss) * 100) : null;
  return `\n\nADHERENCE (last 14 days, adapt to reality):\n` +
    `- ${done}/${plans.length} explicitly completed; ${matched} additional same-sport activity matches (dose not verified).\n` +
    `- ${actual.length - consumed.size} other recorded activities; include their load even when they did not replace a planned session.\n` +
    (skipped.length ? `- Explicitly skipped: ${skipped.slice(0, 5).join("; ")}.\n` : "") +
    (unmatched.length ? `- No matching recording: ${unmatched.slice(0, 5).join("; ")}. Missing sync or unlogged training is possible; ask before assuming these were missed.\n` : "") +
    (volPct != null ? `- Recorded activity load is ~${volPct}% of planned load; this is not a diagnosis of undertraining or overtraining.\n` : "") +
    `- If sessions were missed, do not cram them into the remaining days. Use actual training, recovery and the reason for the change when adjusting.\n`;

}

// --- The athlete's dated goals -------------------------------------------
//
// `races` used to be invisible to both generators: the app collected the sport,
// the distance, the target and the A/B/C priority, and the only thing that ever
// reached a prompt was the anchor's DATE (via onboarding.goal_date). So a
// strength athlete could enter "Powerlifting meet, total 400 kg" and be planned
// for as if the date were empty, and every B/C tune-up was planned over as if
// it did not exist.
//
// Best-effort like every other block: a failed read costs a line, not a plan.

export interface RaceRow {
  name?: string | null;
  date?: string | null;
  priority?: string | null;
  sport?: string | null;
  distance?: string | null;
  target?: string | null;
  notes?: string | null;
}

const SPORT_WORD: Record<string, string> = {
  run: "run",
  ride: "ride",
  swim: "swim",
  strength: "gym",
};

/** Whole weeks from [today] to [date], negative once it is past. */
export function weeksBetween(today: string, date: string): number {
  const ms = new Date(date + "T12:00:00Z").getTime() - new Date(today + "T12:00:00Z").getTime();
  return Math.round(ms / (7 * 86_400_000));
}

/**
 * One race as the coach needs to read it: what it is, when, and what the plan
 * owes it. The A goal earns a taper; a B/C is trained through, which is a
 * different instruction, so it is spelled out rather than implied by a letter.
 */
export function raceLine(r: RaceRow, today: string): string | null {
  if (!r?.date || !r?.name) return null;
  const w = weeksBetween(today, r.date);
  if (w < 0) return null;
  const priority = (r.priority ?? "A").toUpperCase();
  const what = [
    SPORT_WORD[String(r.sport ?? "")] ?? null,
    r.distance?.trim() || null,
  ].filter(Boolean).join(" ");
  const when = w === 0 ? "this week" : w === 1 ? "in 1 week" : `in ${w} weeks`;
  const bits = [
    `- ${r.name.trim()} (${r.date}), ${when}`,
    what ? `, ${what}` : "",
    r.target?.trim() ? `, target ${r.target.trim()}` : "",
    r.notes?.trim() ? `. Note: ${r.notes.trim().slice(0, 160)}` : "",
  ].join("");
  const rule = priority === "A"
    ? " [MAIN GOAL: the plan's phases and taper are built around this date]"
    : priority === "B"
    ? " [TUNE-UP: train through it, two easy days before, no taper and no phase change]"
    : " [FOR FUN: a hard session with a number on it, do not reshape the week for it]";
  return bits + rule;
}

/**
 * Which goal the countdown counts down to.
 *
 * THE BUG THIS FIXES: Home's Goal card was built from onboarding.goal, which is
 * ALSO where deriveLegacyFields writes the athlete's combined training goals
 * ("Ride 40 km + Run 42.2 km + Swim 1.9 km"). One field, two meanings: Home
 * showed a goal per sport while Goals and races showed one race, and neither
 * could be edited into agreeing with the other. So the `races` rows decide, and
 * onboarding.goal_date only picks between them.
 *
 * Preference order: the row the anchor date points at, then the soonest A goal,
 * then the soonest goal of any priority. Past dates never win: a countdown to
 * last month is not a goal. Returns null when the athlete has no upcoming race,
 * which is the honest answer, and the same one Goals and races gives.
 */
export function pickGoalRace<T extends RaceRow>(
  races: readonly T[],
  today: string,
  anchorDate?: string | null,
): T | null {
  const upcoming = races
    .filter((r) => !!r?.name && !!r?.date && String(r.date) >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!upcoming.length) return null;
  return upcoming.find((r) => !!anchorDate && r.date === anchorDate) ??
    upcoming.find((r) => (r.priority ?? "A").toUpperCase() === "A") ??
    upcoming[0];
}

/**
 * The athlete's dated goals, soonest first. The single read behind racesBlock,
 * the goal anchor and goalRaceLine, so five callers do not each write it.
 *
 * Best-effort like every other block here: a failed read costs a line, not a
 * plan.
 */
export async function upcomingGoals(
  admin: SupabaseClient,
  userId: string,
  today: string,
): Promise<RaceRow[]> {
  try {
    const { data } = await admin
      .from("races")
      .select("name, date, priority, sport, distance, target, notes")
      .eq("user_id", userId)
      .gte("date", today)
      .order("date", { ascending: true })
      .limit(8);
    return (data ?? []) as RaceRow[];
  } catch (_e) {
    return [];
  }
}

/**
 * The goal event as one clause of prose: "Athens Marathon on 2027-11-14, in 15
 * weeks".
 *
 * racesBlock is the planner's version, every goal carrying the rule the week
 * owes it. A chat turn, a morning brief or a week recap needs the opposite: one
 * thing the coach can mention in passing, because the voice rule is that it
 * interprets rather than reads a calendar back. "" when there is no upcoming
 * goal, so a caller can append it blind.
 */
export function goalRaceLine(r: RaceRow | null | undefined, today: string): string {
  if (!r?.name?.trim() || !r?.date) return "";
  const w = weeksBetween(today, r.date);
  if (w < 0) return "";
  const when = w === 0 ? "this week" : w === 1 ? "in 1 week" : `in ${w} weeks`;
  return `${r.name.trim()} on ${r.date}, ${when}`;
}

/**
 * Every upcoming goal, with what each one is owed. Renders "" when the athlete
 * has none, so the prompt never carries an empty heading.
 */
export async function racesBlock(
  admin: SupabaseClient,
  userId: string,
  today: string,
): Promise<string> {
  const data = await upcomingGoals(admin, userId, today);
  const lines = data.map((r) => raceLine(r, today)).filter((l): l is string => !!l);
  if (!lines.length) return "";
  return `\n\nGOALS ON THE CALENDAR:\n${lines.join("\n")}\n` +
    `Prescribe for the nearest goal the session can serve. A target above is the athlete's own ` +
    `words for what a good day looks like: use it to pick the work, and never contradict it.`;
}

/**
 * Weeks to the goal, the phase that implies, and which way fitness is moving.
 *
 * Takes the RESOLVED goal date (pickGoalRace's row), not onboarding.goal_date:
 * an anchor left pointing at a race that was deleted used to keep driving phase
 * and taper from a date with nothing behind it.
 */
export function goalBlock(
  goalDate: string | null,
  weeksToGoal: number | null,
  phase: string,
  acts28: ActivityRow[],
): string {
  if (weeksToGoal == null && !goalDate) return "";
  const ctlVals = acts28.filter((a) => a.ctl != null).map((a) => Number(a.ctl));
  const ctlTrend = ctlVals.length >= 2 ? ctlVals[0] - ctlVals[ctlVals.length - 1] : 0;
  const trendWord = ctlTrend > 1 ? "building" : ctlTrend < -1 ? "declining" : "flat";
  return `\n\nGOAL TRACKING:\n` +
    (weeksToGoal != null ? `- ${weeksToGoal} weeks to goal (${goalDate}); phase: ${phase}.\n` : "") +
    `- Fitness (CTL) is ${trendWord} (${ctlTrend >= 0 ? "+" : ""}${ctlTrend.toFixed(1)} over 28d).\n` +
    `- Prioritise the work that moves the goal; ${weeksToGoal != null && weeksToGoal <= 2 ? "this is taper, sharpen, don't build." : "progress the limiter without spiking load."}`;
}

// Client-supplied life schedule: per-day busy windows derived ON-DEVICE from
// the athlete's calendar (titles never leave the phone). Untrusted input —
// sanitize hard: ISO dates, HH:MM-HH:MM windows, capped counts. Returns "" when
// nothing valid, so absent/garbage input costs nothing.
const BUSY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BUSY_WINDOW = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function calendarBlock(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  const days: string[] = [];
  for (const d of raw.slice(0, 21)) {
    const date = (d as { date?: unknown })?.date;
    if (typeof date !== "string" || !BUSY_DATE.test(date)) continue;
    const allDay = (d as { all_day?: unknown }).all_day === true;
    const windows = Array.isArray((d as { windows?: unknown }).windows)
      ? ((d as { windows: unknown[] }).windows)
        .filter((w): w is string => typeof w === "string" && BUSY_WINDOW.test(w))
        .slice(0, 8)
      : [];
    if (!allDay && windows.length === 0) continue;
    const wd = WEEKDAYS[new Date(date + "T12:00:00Z").getUTCDay()];
    const what = allDay
      ? `busy all day${windows.length ? `, plus ${windows.join(", ")}` : ""}`
      : `busy ${windows.join(", ")}`;
    days.push(`- ${date} (${wd}): ${what}`);
  }
  if (!days.length) return "";
  return `\n\nLIFE SCHEDULE (from the athlete's calendar; these times are UNAVAILABLE for training):\n` +
    days.join("\n") +
    `\nPut the long/hard sessions on days with the most free time; on tight days keep the session short, and treat an all-day commitment as little-to-no training time (rest or a very short easy session). Never prescribe a specific clock time.`;
}

export async function weatherBlock(lat: number, lon: number, sport: "run" | "ride"): Promise<string> {
  const wx = await getWeather(lat, lon);
  if (!wx) return "";
  const verdict = assessViability(wx, sport);
  const sportWord = sport === "ride" ? "cycling" : "running";
  const guidance = verdict.tier === "blocked"
    ? `HARD CONSTRAINT: outdoor ${sportWord} is NOT safe/viable today (${verdict.reasons.join("; ")}). ` +
      `Generate this as an INDOOR session (treadmill for a run, indoor trainer for a ride) instead of ` +
      `an outdoor route, and say so plainly in coach_note.`
    : verdict.tier === "caution"
    ? `Caution: ${verdict.reasons.join("; ")}. Adjust pace/route accordingly but outdoor is still fine.`
    : wx.summary;
  return `\n\nWEATHER (today, at the athlete's location):\n` +
    `- ${wx.tempC.toFixed(0)}°C (feels ${wx.apparentC.toFixed(0)}°C), ${wx.humidity}% RH, wind ${wx.windKmh.toFixed(0)} km/h, rain prob ${wx.precipProbMax}%.\n` +
    `- Guidance: ${guidance}.`;
}
