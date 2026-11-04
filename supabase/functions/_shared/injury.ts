// ============================================================================
// injury — the follow-up loop and the structural pain backoff.
//
// WHY THIS FILE EXISTS. An injury used to be a fact captured once at onboarding
// and repeated into every prompt forever: "Knee (moderate)". Nothing asked
// whether it was still there, nothing recorded that a session hurt, and the
// only lever the coach had was more prose. Prose loses. The header comment on
// memoryDocsBlock (agent_memory.ts) spells out why: free text in
// coach_knowledge has NO date-level authority over a concrete prescription, and
// training_paused_until exists because a stated "I'm stopping until X" got
// scheduled over anyway. A backoff is the same class of fact, so it gets the
// same treatment: a structured, dated field that the engine enforces itself.
//
// Three pieces, all pure so they are trivially testable and shared by every
// consumer (daily-summary, generate-workout, plan-week, coach_tools, report-pain):
//
//   1. FOLLOW-UP    injuryFollowUpDue / markInjuryChecked
//                   "is this still bothering you?", a few days after it was
//                   raised, then weekly while it persists.
//   2. INVOLVEMENT  painCheckArea / exerciseLoadsArea / sportsToAvoid
//                   which injury a given session could plausibly have
//                   aggravated, so the pain question is asked about the right
//                   area and only when the session could have caused it.
//   3. BACKOFF      backoffFromPain / activeBackoffs / backoffBlock
//                   the escalation from a pain answer to a dated instruction,
//                   plus the readers the generators enforce it through.
//
// Dates are ISO YYYY-MM-DD and compared as strings, the way training_paused_until
// is. Every backoff is inclusive and SELF-EXPIRING: readers compare `until`
// against the client's local "today", so there is no cleanup job and no window
// where a stale row keeps suppressing training.
// ============================================================================

import type { InjuryBackoff, InjuryEntry, InjuryStatus, Workout, WorkoutExercise } from "./types.ts";

// ---------------------------------------------------------------------------
// Dates. Local noon on both sides, the same trick weekdayOf uses, so a DST
// boundary can never turn a 3-day gap into 2.958 days and round down.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE.test(v);
}

function noon(iso: string): number {
  return new Date(iso + "T12:00:00").getTime();
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((noon(to) - noon(from)) / DAY_MS);
}

export function addDays(iso: string, days: number): string {
  return new Date(noon(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1. The follow-up loop
// ---------------------------------------------------------------------------

// Ask a couple of days after it was raised: soon enough that the athlete still
// remembers what they did to it, late enough that the answer means something.
export const FOLLOWUP_AFTER_DAYS = 3;
// Then weekly, while it is still there. Anything tighter is nagging, and this
// is a card on Home, not a notification the athlete has to dismiss.
export const FOLLOWUP_REPEAT_DAYS = 7;

// Freeform "anything else" text is stored as an entry with a BLANK area (see
// withNote in InjuryEditor.kt). It is not a body part and there is nothing
// coherent to ask about it, so every function here skips it.
const isRealInjury = (i: InjuryEntry) => typeof i.area === "string" && i.area.trim().length > 0;

/** Injuries still being trained around: everything the athlete has not called resolved. */
export function unresolvedInjuries(injuries: InjuryEntry[]): InjuryEntry[] {
  return (injuries ?? []).filter((i) => isRealInjury(i) && i.status !== "resolved");
}

// The date a follow-up should be counted from: the last answer, else when it
// was raised, else null. Null means "captured before any of this existed, and
// nobody has ever asked" — which is exactly the case the loop was built for,
// so it sorts first and is due immediately rather than never.
function followUpAnchor(i: InjuryEntry): string | null {
  if (isIsoDate(i.last_checked)) return i.last_checked;
  if (isIsoDate(i.raised_at)) return i.raised_at;
  return null;
}

function isFollowUpDue(i: InjuryEntry, today: string): boolean {
  const anchor = followUpAnchor(i);
  if (anchor === null) return true;
  if (anchor > today) return false; // clock skew, or a date typed in the future
  const wait = isIsoDate(i.last_checked) ? FOLLOWUP_REPEAT_DAYS : FOLLOWUP_AFTER_DAYS;
  return daysBetween(anchor, today) >= wait;
}

/**
 * The ONE injury to ask about today, or null. One at a time on purpose: a card
 * that asks about three things at once gets dismissed, and the oldest unanswered
 * question is always the most valuable one.
 */
export function injuryFollowUpDue(injuries: InjuryEntry[], today: string): InjuryEntry | null {
  const due = unresolvedInjuries(injuries).filter((i) => isFollowUpDue(i, today));
  if (!due.length) return null;
  // Never-asked first, then oldest anchor.
  due.sort((a, b) => {
    const x = followUpAnchor(a);
    const y = followUpAnchor(b);
    if (x === null && y === null) return 0;
    if (x === null) return -1;
    if (y === null) return 1;
    return x.localeCompare(y);
  });
  return due[0];
}

/**
 * Record a follow-up answer.
 *
 * "resolved" REMOVES the entry rather than flagging it. Keeping a resolved
 * injury on the list would leave injuriesText telling the coach to train around
 * a healed knee and activeSafetyRules stripping deadlifts forever, which is the
 * opposite of what the athlete just said. The point of closing the loop is that
 * something actually closes.
 */
export function markInjuryChecked(
  injuries: InjuryEntry[],
  area: string,
  status: InjuryStatus,
  today: string,
): InjuryEntry[] {
  const match = (i: InjuryEntry) => i.area.trim().toLowerCase() === area.trim().toLowerCase();
  if (status === "resolved") return (injuries ?? []).filter((i) => !match(i));
  return (injuries ?? []).map((i) => (match(i) ? { ...i, status, last_checked: today } : i));
}

/** Stamp raised_at on entries that lack it. Used when the client writes a new injury. */
export function stampRaisedAt(injuries: InjuryEntry[], today: string): InjuryEntry[] {
  return (injuries ?? []).map((i) =>
    isRealInjury(i) && !isIsoDate(i.raised_at) ? { ...i, raised_at: today } : i
  );
}

// ---------------------------------------------------------------------------
// 2. Involvement: which sessions can aggravate which area
//
// Distinct from workout_review.ts's SAFETY_RULES, and deliberately so. Those
// map an injury to the handful of movements that are CONTRAINDICATED (a knee
// injury forbids depth jumps). This maps an injury to everything that LOADS the
// area at all (a knee injury is involved in every squat, lunge and run), which
// is a much wider net. Asking "did your knee hurt?" after a session that could
// not have touched it is noise, and backing off a sport the injury has nothing
// to do with is worse than noise.
//
// `sports` lists ENDURANCE modalities only. Strength is never dropped wholesale
// because it has per-exercise granularity: an avoid-level backoff strips the
// lifts that load the area and keeps the rest of the session.
// ---------------------------------------------------------------------------

export type EnduranceSport = "run" | "ride" | "swim";

interface AreaProfile {
  when: RegExp;
  muscles: string[]; // catalog muscle groups (exercise_catalog.ts)
  moves: RegExp; // exercise names that load it regardless of muscle tag
  sports: EnduranceSport[];
}

const AREA_PROFILES: AreaProfile[] = [
  {
    when: /knee|patell|\bacl\b|\bmcl\b|meniscus|\bitb\b|iliotibial/i,
    muscles: ["Quads", "Hamstrings", "Glutes"],
    moves: /squat|lunge|leg\s?press|leg\s?extension|leg\s?curl|step.?up|jump|plyo|pistol|box\s?jump/i,
    sports: ["run", "ride"],
  },
  {
    when: /lower.?back|low.?back|lumbar|herniat|sciatic|disc|spine|spinal/i,
    muscles: ["Back", "Core"],
    moves: /dead\s?lift|good.?morning|\brow\b|squat|\bclean\b|\bsnatch\b|sit.?up|back\s?extension|hyperextension|jefferson/i,
    sports: ["ride", "run"],
  },
  {
    when: /shoulder|rotator|labrum|ac\s?joint|impinge|delt/i,
    muscles: ["Shoulders", "Chest"],
    moves: /press|\bdips?\b|pull.?up|chin.?up|raise|\bfly\b|\brow\b|\bsnatch\b|\bjerk\b|shrug/i,
    sports: ["swim"],
  },
  {
    when: /achilles|calf|calves|ankle|plantar|shin|tibial/i,
    muscles: ["Calves"],
    moves: /calf|jump|plyo|sprint|bound|skip|hop/i,
    sports: ["run"],
  },
  {
    when: /hamstring|biceps\s?femoris/i,
    muscles: ["Hamstrings", "Glutes"],
    moves: /dead\s?lift|good.?morning|leg\s?curl|romanian|\brdl\b|nordic|sprint|stride/i,
    sports: ["run"],
  },
  {
    when: /\bhip\b|groin|adductor|glute|piriformis|labral|\bpsoas\b/i,
    muscles: ["Glutes", "Quads", "Hamstrings"],
    moves: /squat|lunge|hip\s?thrust|dead\s?lift|abduct|adduct|split\s?squat|bulgarian/i,
    sports: ["run", "ride"],
  },
  {
    when: /wrist|carpal|elbow|epicondyl|forearm/i,
    muscles: ["Forearms", "Biceps", "Triceps"],
    moves: /curl|press|push.?up|\bclean\b|\bsnatch\b|front\s?squat|plank|pull.?up|chin.?up|extension/i,
    sports: ["swim"],
  },
  {
    when: /neck|cervical|\btrap\b|traps/i,
    muscles: ["Shoulders"],
    moves: /shrug|overhead|press|bridge|upright\s?row/i,
    sports: ["swim"],
  },
  {
    when: /\brib\b|ribs|chest|\bpec\b|pecs|sternum|costal/i,
    muscles: ["Chest"],
    moves: /bench|\bfly\b|push.?up|\bdips?\b|pullover/i,
    sports: ["swim"],
  },
];

/**
 * The profile for an injury area, or null when it is something the map does not
 * know ("jaw", "left thumb"). Null is honest, not a failure: an unknown area
 * still reaches the model through backoffBlock, it just gets no automatic
 * strip, because guessing which lifts load an unrecognised body part would do
 * more damage than leaving it to the coach.
 */
function profileFor(area: string): AreaProfile | null {
  const a = (area ?? "").trim();
  if (!a) return null;
  return AREA_PROFILES.find((p) => p.when.test(a)) ?? null;
}

/** Does this exercise load `area`? `muscle` is the catalog group (muscleOf). */
export function exerciseLoadsArea(area: string, exerciseName: string, muscle?: string | null): boolean {
  const p = profileFor(area);
  if (!p) return false;
  if (p.moves.test(exerciseName ?? "")) return true;
  return !!muscle && p.muscles.includes(muscle);
}

/** Endurance sports an injury in `area` loads. Empty for unknown areas. */
export function sportsForArea(area: string): EnduranceSport[] {
  return profileFor(area)?.sports ?? [];
}

/**
 * Endurance sports that must not be SCHEDULED at all, given the active
 * backoffs. Only "avoid" contributes: "ease" means train it lighter, which is a
 * prompt instruction, not a structural ban. This is the plan-week analogue of
 * computeDayList's pause handling, applied to the sports list rather than the
 * day list.
 */
export function backoffSports(b: InjuryBackoff): EnduranceSport[] {
  return Array.isArray(b.sports) ? b.sports.filter(s => ["run", "ride", "swim"].includes(s)) : sportsForArea(b.area);
}

export function sportsToAvoid(backoffs: InjuryBackoff[]): Set<EnduranceSport> {
  const out = new Set<EnduranceSport>();
  for (const b of backoffs) {
    if (b.level !== "avoid") continue;
    for (const s of backoffSports(b)) out.add(s);
  }
  return out;
}

/**
 * Pick what to train when the sport the athlete was heading for is under an
 * avoid-level backoff.
 *
 * This runs BEFORE generation, which is the whole point: catching an avoided
 * run after the model has written one leaves the engine with nothing to serve
 * but a rest day, and "your Achilles hurt so here is nothing" is a worse answer
 * than "your Achilles hurt so here is a swim". `sports` is the athlete's own
 * modality list (empty means no restriction).
 */
export function substituteSport(
  requested: string,
  sports: string[],
  avoid: ReadonlySet<EnduranceSport>,
): { type: string; swappedFrom: string | null } {
  if (!avoid.has(requested as EnduranceSport)) return { type: requested, swappedFrom: null };
  const does = (s: string) => sports.length === 0 || sports.includes(s);
  const alt = (["run", "ride", "swim"] as EnduranceSport[]).find((s) => does(s) && !avoid.has(s));
  if (alt) return { type: alt, swappedFrom: requested };
  // No endurance option left. Strength still works: the review strips the lifts
  // that load the area and keeps the rest of the session.
  if (does("strength")) return { type: "strength", swappedFrom: requested };
  return { type: "rest", swappedFrom: requested };
}

/**
 * The area to ask about after `workout`, or null when the session could not
 * plausibly have touched anything on file.
 *
 * Rest days never ask. A session that involves two injured areas asks about the
 * more serious one, because one question is all a post-workout card gets.
 */
export function painCheckArea(
  injuries: InjuryEntry[],
  workout: Workout | null,
  muscleOf: (ex: WorkoutExercise) => string,
): string | null {
  if (!workout || workout.type === "rest") return null;
  const candidates = unresolvedInjuries(injuries).filter((i) => {
    if (workout.type === "strength") {
      return workout.sections.some((s) =>
        s.exercises.some((ex) => exerciseLoadsArea(i.area, ex.name, muscleOf(ex)))
      );
    }
    return sportsForArea(i.area).includes(workout.type as EnduranceSport);
  });
  if (!candidates.length) return null;
  const rank: Record<string, number> = { serious: 0, moderate: 1, mild: 2, "": 3 };
  candidates.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
  return candidates[0].area;
}

// ---------------------------------------------------------------------------
// 3. Backoff: reading, writing, escalating
// ---------------------------------------------------------------------------

const LEVELS = ["ease", "avoid"] as const;

function isBackoff(v: unknown): v is InjuryBackoff {
  if (!v || typeof v !== "object") return false;
  const b = v as InjuryBackoff;
  return typeof b.area === "string" && b.area.trim().length > 0 &&
    (LEVELS as readonly string[]).includes(b.level) && isIsoDate(b.until);
}

/** Tolerant read of the jsonb column: anything malformed is simply dropped. */
export function parseBackoffs(raw: unknown): InjuryBackoff[] {
  return Array.isArray(raw) ? raw.filter(isBackoff) : [];
}

/**
 * The backoffs in force on `today`. Inclusive end date, so a backoff set
 * "until Friday" still applies on Friday and is gone on Saturday with nothing
 * having to delete it.
 */
export function activeBackoffs(raw: unknown, today: string): InjuryBackoff[] {
  return parseBackoffs(raw).filter((b) => b.until >= today);
}

/** The strictest backoff in force for one area, or null. */
export function backoffForArea(backoffs: InjuryBackoff[], area: string): InjuryBackoff | null {
  const hits = backoffs.filter((b) => b.area.trim().toLowerCase() === area.trim().toLowerCase());
  if (!hits.length) return null;
  const avoid = hits.filter((b) => b.level === "avoid");
  const pool = avoid.length ? avoid : hits;
  return pool.reduce((a, b) => (b.until > a.until ? b : a));
}

/**
 * Write a backoff for an area, replacing whatever was there. One per area:
 * stacking two windows on the same knee just makes "which one is in force?"
 * a question every reader has to answer.
 */
export function upsertBackoff(current: InjuryBackoff[], next: InjuryBackoff): InjuryBackoff[] {
  const key = next.area.trim().toLowerCase();
  return [...current.filter((b) => b.area.trim().toLowerCase() !== key), next];
}

/** Drop the backoff for one area, or all of them when `area` is omitted. */
export function clearBackoff(current: InjuryBackoff[], area?: string): InjuryBackoff[] {
  if (!area || !area.trim()) return [];
  const key = area.trim().toLowerCase();
  return current.filter((b) => b.area.trim().toLowerCase() !== key);
}

export interface PainOutcome {
  /** The backoff to write, or null when the answer does not warrant one. */
  backoff: InjuryBackoff | null;
  /** Pain-free: drop any backoff on this area, the athlete is through it. */
  clear: boolean;
  /** Sharp pain. The caller should stop prescribing and hand this to a human. */
  severe: boolean;
}

// The escalation, kept in one place so the thresholds can be argued with rather
// than rediscovered in three call sites. The scale is the wellness soreness
// scale (1 = none, 5 = sharp), because asking an athlete to hold two different
// 1-5 scales in their head is how you get meaningless data.
//
//   1  no pain            clear the backoff, this is the exit condition
//   2  a niggle           nothing changes, one twinge is not a trend
//   3  noticeable         ease for a week: keep training it, cap the intensity
//   4  it hurt            avoid for a week: stop loading it
//   5  sharp              avoid for two weeks, and say the quiet part out loud
export const PAIN_EASE_AT = 3;
export const PAIN_AVOID_AT = 4;
export const PAIN_SEVERE_AT = 5;
export const BACKOFF_DAYS = 7;
export const BACKOFF_DAYS_SEVERE = 14;

export function backoffFromPain(
  area: string,
  pain: number,
  today: string,
  reason?: string,
): PainOutcome {
  const p = Math.round(pain);
  if (!area.trim() || !Number.isFinite(p) || p < 1) {
    return { backoff: null, clear: false, severe: false };
  }
  if (p < PAIN_EASE_AT) {
    return { backoff: null, clear: p === 1, severe: false };
  }
  const severe = p >= PAIN_SEVERE_AT;
  const level: InjuryBackoff["level"] = p >= PAIN_AVOID_AT ? "avoid" : "ease";
  return {
    backoff: {
      area: area.trim(),
      sports: [],
      level,
      until: addDays(today, severe ? BACKOFF_DAYS_SEVERE : BACKOFF_DAYS),
      reason: (reason ?? `pain ${p} of 5 reported after a session`).slice(0, 200),
      set_at: today,
    },
    clear: false,
    severe,
  };
}

// ---------------------------------------------------------------------------
// Prompt surface. The block is BELT AND BRACES, not the mechanism: the strip in
// reviewWorkout and the sports filter in plan-week are what actually guarantee
// the backoff is honored. This is here so the coach can explain itself in the
// session note instead of silently serving a different workout.
// ---------------------------------------------------------------------------

export function backoffBlock(backoffs: InjuryBackoff[]): string {
  if (!backoffs.length) return "";
  const lines = backoffs.map((b) => {
    const how = b.level === "avoid"
      ? `Avoid movements loading this area. Restricted sports: ${backoffSports(b).join(", ") || "none"}. Do not infer additional sport bans from the body-area label`
      : `EASE OFF loading this area. Sports requiring reduced intensity: ${backoffSports(b).join(", ") || "none"}. Do not infer additional sport restrictions`;
    const why = b.reason ? ` Reported: ${b.reason}.` : "";
    return `- ${b.area} (until ${b.until}, inclusive). ${how}.${why}`;
  });
  return "\n\nACTIVE INJURY BACKOFF (the athlete reported pain, these are HARD constraints " +
    "and outrank the week's target load, the plan, and anything in the notes above):\n" +
    lines.join("\n") +
    "\nSay one plain sentence about working around it. Do not talk about it as if it were permanent, " +
    "and do not add extra volume elsewhere to make up for what you removed.";
}

/**
 * The follow-up question, as the athlete reads it. Lives here rather than in
 * the Android layer so the wording is the same wherever it is asked (the Home
 * card today, a coach turn tomorrow).
 */
export function followUpQuestion(i: InjuryEntry, today: string): string {
  const raised = isIsoDate(i.raised_at) ? daysBetween(i.raised_at, today) : null;
  const when = raised !== null && raised > 0
    ? (raised === 1 ? "yesterday" : `${raised} days ago`)
    : null;
  const area = i.area.trim().toLowerCase();
  return when
    ? `You mentioned your ${area} ${when}. How is it now?`
    : `How is your ${area} doing?`;
}
