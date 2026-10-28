import { availableImplements, sessionState } from "./session_context.ts";
// Agentic coach tools — give the coach real reads into the athlete's data and
// real actions (plan, generate, set goals, remember). Provider-agnostic: the
// coach selects a tool by emitting JSON, the server runs it here and feeds back
// an observation. Works on any LLM the user has configured (no native
// function-calling required).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { InjuryEntry } from "./types.ts";

import { computeRecovery } from "./recovery.ts";
import { freshnessWord, recoveryWord } from "./prompt.ts";
import { applyFallbackFitness } from "./load.ts";
import { goalsText, injuriesOf, injuriesText } from "./profile.ts";
import {
  activeBackoffs,
  addDays,
  BACKOFF_DAYS,
  clearBackoff,
  FOLLOWUP_REPEAT_DAYS,
  markInjuryChecked,
  unresolvedInjuries,
  upsertBackoff,
} from "./injury.ts";
import { assessFeasibility, type FeasibilityInput, matchDemand } from "./feasibility.ts";
import { goalRaceLine, pickGoalRace, type RaceRow } from "./context.ts";

const DAY = 86400000;
const iso = (d: number) => new Date(d).toISOString().slice(0, 10);

/**
 * Gather the real numbers a feasibility verdict has to stand on: recent weekly
 * volume, the longest single session, and chronic load. Shared by assess_goal
 * and set_goal_race so a goal cannot be saved without the same judgement the
 * coach would have got by asking.
 */
async function feasibilityInputs(
  admin: SupabaseClient,
  userId: string,
  goal: string,
  date: string,
): Promise<FeasibilityInput> {
  const since = iso(Date.now() - 28 * DAY);
  const { data } = await admin.from("effective_activities")
    .select("date, distance_m, duration_seconds, ctl")
    .eq("user_id", userId).gte("date", since).order("date", { ascending: false });
  const acts = data ?? [];

  const totalKm = acts.reduce((s, r) => s + ((r.distance_m ?? 0) / 1000), 0);
  const totalHours = acts.reduce((s, r) => s + ((r.duration_seconds ?? 0) / 3600), 0);
  const longestKm = acts.reduce((m, r) => Math.max(m, (r.distance_m ?? 0) / 1000), 0);

  const { data: prof } = await admin.from("user_profiles")
    .select("onboarding").eq("id", userId).single();
  const o = (prof?.onboarding ?? {}) as Record<string, unknown>;

  const weeksAway = (new Date(date).getTime() - Date.now()) / (7 * DAY);
  return {
    goal,
    weeksAway,
    // Over 28 days, so a quarter of the total is the weekly rate.
    currentWeeklyKm: totalKm > 0 ? totalKm / 4 : null,
    currentWeeklyHours: totalHours > 0 ? totalHours / 4 : null,
    longestRecentKm: longestKm > 0 ? longestKm : null,
    ctl: acts.find((r) => r.ctl != null)?.ctl ?? null,
    experience: (o.experience as string | undefined) ?? null,
  };
}

/**
 * The text the feasibility check should judge, given a goal's name and its
 * (optional, model-supplied) distance.
 *
 * `distance ?? name` was too trusting: models routinely omit distance or fill
 * it with prose, and a goal that matches no known event gets no verdict at all
 * while still looking saved. Measured against deepseek-v4-flash, it also sends
 * things like "sub-4 marathon", where the useful word is in the name.
 *
 * Naively concatenating both is wrong in the other direction: distance "10K"
 * with name "Athens Marathon" would match `marathon`, which is tested before
 * `10k`, and overstate the event. So distance wins WHEN IT MATCHES something
 * real, and the name is the fallback rather than a peer.
 */
export function goalTextFor(name: string, distance: string | null): string {
  if (distance && matchDemand(distance)) return distance;
  return name || distance || "";
}

/**
 * Does a race row answer to what the athlete asked to remove?
 *
 * Loose on the name deliberately: people say "the Ironman", not "Ironman
 * Barcelona 2027". Substring either way, so both a shorter and a longer phrase
 * than the stored name match. A date alone matches every goal on that date; a
 * name AND a date must both agree, which is what disambiguates two events
 * sharing a name.
 *
 * Exported for tests: the matching is the part with teeth, since a rule that is
 * too loose deletes the wrong race and one too tight silently deletes nothing.
 */
export function matchesGoal(
  goal: { name: string; date: string },
  name: string,
  date: string,
): boolean {
  const byDate = date ? goal.date === date : true;
  if (!name) return date ? byDate : false;
  const a = goal.name.trim().toLowerCase();
  const b = name.trim().toLowerCase();
  if (!a) return false;
  const byName = a.includes(b) || b.includes(a);
  return byName && byDate;
}

/**
 * The seven days around [anchor], as they stand RIGHT NOW.
 *
 * THE BUG THIS FIXES: a re-plan turn called plan_week, which correctly returned
 * the week it had built, and then called set_rest_day four times, deleting the
 * four training sessions it had just created. The reply described the week
 * plan_week had returned, which by then no longer existed. Grounding each write
 * in its OWN result is not enough when a later write in the same turn changes
 * the state underneath it.
 *
 * So every write returns this. The last observation the model sees before it
 * writes the reply is always the calendar the athlete will actually open.
 */
async function weekSnapshot(
  admin: SupabaseClient,
  userId: string,
  anchor: string,
): Promise<Array<{ date: string; type: string; title: string | null }>> {
  const start = mondayOf(new Date(anchor));
  const end = iso(new Date(start + "T00:00:00").getTime() + 6 * DAY);
  const { data } = await admin.from("reconciled_session_plans")
    .select("date, type, workout_json")
    .eq("user_id", userId).gte("date", start).lte("date", end)
    .order("date", { ascending: true });
  return (data ?? []).map((d) => ({
    date: d.date,
    type: d.type,
    title: (d.workout_json as { title?: string } | null)?.title ?? null,
  }));
}

function mondayOf(date = new Date()): string {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export interface ToolDef {
  name: string;
  kind: "read" | "act";
  description: string;
  args: string; // human description of the args shape (JSON-protocol prompt)
  schema: Record<string, unknown>; // JSON Schema (native tool calling)
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

export const TOOL_CATALOG: ToolDef[] = [
  { name: "get_today_plan", kind: "read", args: "{}", schema: NO_ARGS,
    description: "Read today's saved sessions with full workout instructions, session slots and completion/skipped state. Use for what should I do today; do not generate a replacement just to explain an existing plan." },
  {name:"get_adaptation_history",kind:"read",args:"{}",schema:NO_ARGS,description:"Inspect prior adaptation IDs, reasons and before/after sessions before an undo or when explaining plan changes."},
  { name:"preview_adaptation",kind:"read",args:"{ today: 'YYYY-MM-DD', minutes?: number, unavailable_implements?: string[] }",schema:{type:"object",properties:{today:{type:"string"},minutes:{type:"number"},unavailable_implements:{type:"array",items:{type:"string"}}},required:["today"]},description:"Preview the smallest justified schedule adjustment after changed or missed training. Read before applying; preserves completed, recorded and locked sessions. Missing recordings stay unknown." },
  { name:"apply_adaptation",kind:"act",args:"{ proposal_id: string, today: 'YYYY-MM-DD' }",schema:{type:"object",properties:{proposal_id:{type:"string"},today:{type:"string"}},required:["proposal_id","today"]},description:"Apply a previously previewed adaptation when the athlete requested the schedule change. Report exactly the saved changes and next action. A preview with clarification cannot be applied." },
  { name:"undo_adaptation",kind:"act",args:"{ proposal_id: string, today: 'YYYY-MM-DD' }",schema:{type:"object",properties:{proposal_id:{type:"string"},today:{type:"string"}},required:["proposal_id","today"]},description:"Undo an adaptation while preserving subsequent completed/locked work. Rejects stale or currently unsuitable restores." },

  {
    name: "get_fitness", kind: "read", args: "{}", schema: NO_ARGS,
    description: "Current fitness: CTL (fitness), ATL (fatigue), TSB (form), weekly TSS load and acute:chronic ratio.",
  },
  {
    name: "get_recent_activities", kind: "read", args: "{ days?: number = 14 }",
    schema: { type: "object", properties: { days: { type: "number", description: "Lookback window in days (default 14, max 60)" } } },
    description: "Recently completed activities recorded by the athlete's watch or Intervals.icu (type, date, distance, duration, HR, TSS).",
  },
  {
    name: "get_planned_week", kind: "read", args: "{ week_start?: 'YYYY-MM-DD' }",
    schema: { type: "object", properties: { week_start: { type: "string", description: "Week start date YYYY-MM-DD (defaults to the current week's Monday)" } } },
    description: "The planned sessions for a week (title, type, completed, locked). Defaults to the current week.",
  },
  {
    name: "get_strength_summary", kind: "read", args: "{}", schema: NO_ARGS,
    description: "Recent strength sessions and 28-day working-set volume per muscle group.",
  },
  {
    name: "get_profile", kind: "read", args: "{}", schema: NO_ARGS,
    description: "Athlete profile: goal, experience, available days, session length, equipment, injuries, thresholds (LTHR/FTP/pace) and upcoming goals/races across sports (run/ride/swim/strength), each with date, priority and target.",
  },
  {
    name: "get_readiness", kind: "read", args: "{}", schema: NO_ARGS,
    description: "Today's recovery/readiness score (0-100) with the signals behind it: HRV trend, resting-HR trend, sleep, subjective wellness.",
  },
  {
    name: "get_execution_analysis", kind: "read", args: "{}", schema: NO_ARGS,
    description: "Measured execution of recent sessions vs their plan: per-workout score (0-100), what drifted (duration/load/intensity, or skipped exercises for strength). Use to answer 'how did my run/lift go?' and to autoregulate.",
  },
  {
    name: "plan_week", kind: "act", args: "{ start_date?: 'YYYY-MM-DD' }",
    schema: { type: "object", properties: { start_date: { type: "string", description: "YYYY-MM-DD; defaults to today" } } },
    description: "Generate/regenerate a full training week (pushes near-term sessions to the watch). Use after agreeing a plan with the athlete.",
  },
  {
    name: "generate_workout", kind: "act",
    args: "{ date?: 'YYYY-MM-DD', type?: 'run'|'ride'|'swim'|'strength'|'auto', session_slot?: 0|1, duration?: number, request?: string, lock?: boolean }",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        type: { type: "string", enum: ["run", "ride", "swim", "strength", "auto"] },
        session_slot: { type: "integer", enum: [0, 1], description: "Use an existing configured session slot; defaults to 0" },
        duration: { type: "number", description: "Requested minutes; omit to use the saved availability and training history" },
        request: { type: "string", description: "Free-text session request, e.g. 'easy 8k' or 'upper-body push'" },
        lock: { type: "boolean", description: "Fix the session so re-planning won't replace it" },
      },
    },
    description: "Create or replace one workout only when the athlete requests it, not when they ask what is already planned. Read get_today_plan first for today. Pass `request` for a specific session ('easy 8k', 'upper-body push'); set lock=true to fix it.",
  },
  {
    name: "move_workout", kind: "act",
    args: "{ new_date: 'YYYY-MM-DD', workout_id?: string, date?: 'YYYY-MM-DD' }",
    schema: {
      type: "object",
      properties: {
        new_date: { type: "string", description: "Target date YYYY-MM-DD" },
        workout_id: { type: "string", description: "Planned workout id (from get_planned_week)" },
        date: { type: "string", description: "Alternative to workout_id: move the (first incomplete) session on this date" },
      },
      required: ["new_date"],
    },
    description: "Move a planned workout to another date (the watch event moves with it). Identify it by workout_id from get_planned_week, or just by its current date.",
  },
  {
    name: "set_rest_day", kind: "act", args: "{ date: 'YYYY-MM-DD' }",
    schema: {
      type: "object",
      properties: { date: { type: "string", description: "Day to clear to rest, YYYY-MM-DD" } },
      required: ["date"],
    },
    description: "Turn a day into a rest day, removes any planned session on that date (the watch event is removed too). Use when the athlete needs a day off.",
  },
  {
    name: "log_stretch_session", kind: "act",
    args: "{ date?: 'YYYY-MM-DD', duration_min?: number, notes?: string }",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Day it happened, YYYY-MM-DD; defaults to today. Cannot be in the future." },
        duration_min: { type: "number", description: "How long, in minutes" },
        notes: { type: "string", description: "Any detail worth remembering, e.g. 'hips and hamstrings'" },
      },
    },
    description: "Log a completed stretching/mobility session (a record of what the athlete just did, NOT a planned workout — it doesn't touch the calendar). Use when the athlete says they stretched, did mobility work, foam rolled, etc.",
  },
  {
    name: "make_easier", kind: "act", args: "{ date?: 'YYYY-MM-DD' }",
    schema: {
      type: "object",
      properties: { date: { type: "string", description: "Day to ease off; defaults to today" } },
    },
    description: "Regenerate a day's workout noticeably easier, lower intensity and volume, aerobic/recovery focus. Use when the athlete feels rough or wants to back off without skipping entirely.",
  },
  {
    name: "set_training_pause", kind: "act", args: "{ until_date: 'YYYY-MM-DD', reason?: string }",
    schema: {
      type: "object",
      properties: {
        until_date: { type: "string", description: "Last day of the pause (inclusive), YYYY-MM-DD; training resumes the day after" },
        reason: { type: "string", description: "Why, e.g. 'travel to Italy', 'flu', 'work crunch'" },
      },
      required: ["until_date"],
    },
    description: "Pause all training through a date (inclusive) — travel, illness, work crunch. Clears upcoming unlocked planned sessions in that window and stops plan_week from scheduling more until then. Use whenever the athlete says they're stopping/pausing training for a stretch WITH a return date.",
  },
  {
    name: "resume_training", kind: "act", args: "{}", schema: NO_ARGS,
    description: "End an active training pause early. Use if the athlete says they're back / resuming sooner than the pause's original end date.",
  },
  {
    name: "report_injury", kind: "act",
    args: "{ area: string, pain?: number (1-10), severity?: 'mild'|'moderate'|'serious', detail?: string, days?: number }",
    schema: {
      type: "object",
      properties: {
        area: { type: "string", description: "Specific body area and side when known, e.g. 'left knee' or 'front of right knee'" },
        pain: { type: "number", description: "Athlete's current pain from 1 (minimal) to 10 (severe), if they supplied it" },
        severity: { type: "string", enum: ["mild", "moderate", "serious"], description: "Use only when the athlete clearly described severity; pain is preferred when they gave a 1-10 score" },
        detail: { type: "string", description: "Useful context such as onset, trigger, swelling, sharpness, or what movement hurts" },
        days: { type: "number", description: "Initial protection window in days; defaults to 7 and is capped at 60" },
      },
      required: ["area"],
    },
    description:
      "Record a NEW or newly-described injury in the structured profile injuries list AND apply a dated training backoff in one atomic action. " +
      "Call immediately when the athlete mentions pain or an injury; never use remember as a substitute. It is valid with only area: the coach should record first, then ask targeted questions for exact location, 1-10 pain, onset/trigger and red flags. Pain 7-10 or serious wording creates avoid protection; otherwise it creates ease protection until details arrive.",
  },
  {
    name: "set_injury_backoff", kind: "act",
    args: "{ area: string, level: 'ease'|'avoid', days?: number, reason?: string }",
    schema: {
      type: "object",
      properties: {
        area: { type: "string", description: "Body area, e.g. 'Knee', 'Lower back', 'Achilles'. Match an existing injury area when there is one." },
        level: {
          type: "string",
          enum: ["ease", "avoid"],
          description: "ease = keep training it but cap the intensity; avoid = do not load it at all (also stops the sports that stress it being scheduled)",
        },
        days: { type: "number", description: "How long, in days from today. Defaults to 7. Capped at 60." },
        reason: { type: "string", description: "Why, e.g. 'sharp pain on Tuesday's run'" },
      },
      required: ["area", "level"],
    },
    description:
      "Back off an injured area for a set number of days. This is what actually changes the workouts: it strips the movements that load that area out of generated sessions and, at 'avoid', stops the affected sports being scheduled. Use whenever the athlete reports pain in an area, do NOT rely on remember alone for this.",
  },
  {
    name: "clear_injury_backoff", kind: "act", args: "{ area?: string }",
    schema: {
      type: "object",
      properties: { area: { type: "string", description: "Area to release. Omit to clear every active backoff." } },
    },
    description: "End an injury backoff early, when the athlete says the area feels fine again. Backoffs expire on their own, so this is only for 'it's better already'.",
  },
  {
    name: "update_injury_status", kind: "act",
    args: "{ area: string, status: 'present'|'better'|'resolved' }",
    schema: {
      type: "object",
      properties: {
        area: { type: "string", description: "The injury area the athlete is talking about" },
        status: {
          type: "string",
          enum: ["present", "better", "resolved"],
          description: "resolved REMOVES it from the injuries the coach programs around, use it only when they say it is genuinely gone",
        },
      },
      required: ["area", "status"],
    },
    description:
      "Record how a known injury is doing. 'resolved' takes it off the list so sessions stop being built around it; 'present'/'better' just log the answer and push the next check-in out a week. Use when the athlete volunteers an update on an injury, so the app stops asking.",
  },
  {
    name: "set_weather_prompt_pref", kind: "act", args: "{ opt_out: boolean, reason?: string }",
    schema: {
      type: "object",
      properties: {
        opt_out: {
          type: "boolean",
          description: "true = stop asking about weather-blocked outdoor sessions (athlete has an indoor alternative like a gym/treadmill/trainer); false = resume asking",
        },
        reason: { type: "string", description: "Why, e.g. 'have a home gym', 'treadmill at work'" },
      },
      required: ["opt_out"],
    },
    description: "Set whether the daily weather check should prompt the athlete to swap outdoor sessions when conditions are unsafe. Use when the athlete says something like 'I have gym access, stop asking about weather' or conversely 'go ahead and ask me again'.",
  },
  {
    name: "set_goal_race",
    kind: "act",
    args:
      "{ name: string, date: 'YYYY-MM-DD', sport?: 'run'|'ride'|'swim'|'strength'|'other', distance?: string, priority?: 'A'|'B'|'C', target?: string, notes?: string }",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Event name, e.g. 'Athens Marathon'" },
        date: { type: "string", description: "YYYY-MM-DD" },
        sport: {
          type: "string",
          enum: ["run", "ride", "swim", "strength", "other"],
          description: "Defaults to run. Use 'other' for triathlon and hybrid events.",
        },
        distance: {
          type: "string",
          description: "Event distance, e.g. 'Marathon', '10K', '70.3', 'Ironman'. Drives the feasibility check.",
        },
        priority: {
          type: "string",
          enum: ["A", "B", "C"],
          description: "A = the goal that anchors periodization (default). B/C are tune-ups.",
        },
        target: { type: "string", description: "Free-text target: '4:45/km', 'sub 3:30', 'FTP 260W'" },
        notes: { type: "string" },
      },
      required: ["name", "date"],
    },
    description:
      "Save a goal event to the athlete's goals and races list. An A-priority goal also anchors periodization and taper. Returns a FEASIBILITY assessment from the athlete's real numbers: if it says push_back, do NOT plan a training block, talk to them about the verdict first.",
  },
  {
    name: "remove_goal_race",
    kind: "act",
    args: "{ name?: string, date?: 'YYYY-MM-DD' }",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Event name to remove, e.g. 'Ironman Barcelona'. Matched loosely." },
        date: { type: "string", description: "YYYY-MM-DD, to disambiguate two events with the same name." },
      },
    },
    description:
      "Remove a goal event from the athlete's goals and races list when they say they are not doing it any more. Give at least one of name or date. Also clears it from Home if it was the goal anchoring their training. Returns what was actually removed: if it removed nothing, say so rather than claiming the goal is gone.",
  },
  {
    name: "assess_goal",
    kind: "read",
    args: "{ goal: string, date: 'YYYY-MM-DD' }",
    schema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The event, e.g. 'marathon', '70.3', 'Ironman'" },
        date: { type: "string", description: "Target date, YYYY-MM-DD" },
      },
      required: ["goal", "date"],
    },
    description:
      "Judge whether a goal is realistically achievable in the time available, from the athlete's actual volume, longest recent session and chronic load. Call this BEFORE agreeing to a goal or planning toward one, whenever the athlete names a race and a date.",
  },
  {
    name: "remember", kind: "act", args: "{ fact: string }",
    schema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
    description: "Save a durable fact/preference/constraint about the athlete (e.g. 'dislikes burpees', 'left knee niggle').",
  },
  {
    name: "update_profile",
    kind: "act",
    args: "{ display_name?: string, sex?: 'male'|'female', birth_year?: number, ftp?: number, lthr?: number, threshold_pace_per_km?: 'm:ss', css_per_100m?: 'm:ss', weekly_tss_target?: number, weight_kg?: number, height_cm?: number, body_fat_pct?: number, session_duration?: number }",
    schema: {
      type: "object",
      properties: {
        display_name: { type: "string", description: "What the coach should call the athlete (their name)" },
        sex: { type: "string", enum: ["male", "female"], description: "Biological sex, for zones/demographics" },
        birth_year: { type: "number", description: "Year of birth, like 1992" },
        ftp: { type: "number", description: "Cycling FTP in watts (50-600)" },
        lthr: { type: "number", description: "Lactate threshold heart rate in bpm (120-210)" },
        threshold_pace_per_km: { type: "string", description: "Run threshold pace per km, like 4:45" },
        css_per_100m: { type: "string", description: "Swim critical pace per 100m, like 1:55" },
        weekly_tss_target: { type: "number", description: "Weekly training load target in TSS (100-1000)" },
        weight_kg: { type: "number", description: "Bodyweight in kg (30-250)" },
        height_cm: { type: "number", description: "Height in cm (120-230)" },
        body_fat_pct: { type: "number", description: "Body fat percentage (3-60)" },
        session_duration: { type: "number", description: "Typical session length in minutes (15-300)" },
      },
    },
    description:
      "Save the athlete's profile facts and numbers when they state them in conversation: their name, " +
      "sex, birth year, a new FTP test, a threshold pace, a swim CSS, a weekly load target, bodyweight, " +
      "body fat, a preferred session length. This is the SAME profile the Settings screens edit, so a " +
      "saved change shows up there too. Only include fields the athlete gave.",
  },
  {
    name: "update_app_settings",
    kind: "act",
    args: "{ theme?: 'system'|'dark'|'light', palette?: string, units?: 'kg'|'lb', rest_timer_seconds?: number, keep_screen_on?: boolean, morning_notification?: boolean, rest_vibrate?: boolean, rest_notify?: boolean }",
    schema: {
      type: "object",
      properties: {
        theme: { type: "string", enum: ["system", "dark", "light"], description: "App theme" },
        palette: {
          type: "string",
          enum: ["serene", "ember", "tidal", "nocturne", "bloom", "solstice"],
          description: "Colour palette",
        },
        units: { type: "string", enum: ["kg", "lb"], description: "Weight units" },
        rest_timer_seconds: { type: "number", description: "Default strength rest timer in seconds (0-600)" },
        keep_screen_on: { type: "boolean", description: "Keep the screen awake during a gym session" },
        morning_notification: { type: "boolean", description: "Morning readiness notification" },
        rest_vibrate: { type: "boolean", description: "Vibrate when the rest timer ends" },
        rest_notify: { type: "boolean", description: "Notify when the rest timer ends" },
      },
    },
    description:
      "Change the athlete's app settings on their phone: theme, colour palette, weight units, default " +
      "rest timer, keep-screen-on, morning readiness notification, rest-timer alerts. The change is " +
      "applied on the device when your reply arrives; report it as done. Sensitive settings (API keys, " +
      "account, data export) cannot be changed from chat, point the athlete to Settings for those.",
  },
];

// ---------------------------------------------------------------------------
// update_app_settings validation. The tool's effect happens ON THE DEVICE (the
// settings live in the phone's DataStore, not the DB), so the server only
// validates against this whitelist and ships normalized {key, value-as-string}
// pairs back with the reply. Anything not listed here is rejected, which is the
// "safe subset" guarantee: chat can never touch keys, account or data actions.
// ---------------------------------------------------------------------------

export interface AppSettingChange {
  key: string;
  value: string;
}

const SETTING_RULES: Record<string, (v: unknown) => string | null> = {
  theme: (v) => (typeof v === "string" && ["system", "dark", "light"].includes(v.toLowerCase()) ? v.toLowerCase() : null),
  palette: (v) =>
    typeof v === "string" && ["serene", "ember", "tidal", "nocturne", "bloom", "solstice"].includes(v.toLowerCase())
      ? v.toLowerCase()
      : null,
  units: (v) => (typeof v === "string" && ["kg", "lb"].includes(v.toLowerCase()) ? v.toLowerCase() : null),
  rest_timer_seconds: (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 600 ? String(Math.round(v)) : null,
  keep_screen_on: (v) => (typeof v === "boolean" ? String(v) : null),
  morning_notification: (v) => (typeof v === "boolean" ? String(v) : null),
  rest_vibrate: (v) => (typeof v === "boolean" ? String(v) : null),
  rest_notify: (v) => (typeof v === "boolean" ? String(v) : null),
};

/** Validate an update_app_settings call into device-ready changes + rejections. */
export function validateAppSettings(
  args: Record<string, unknown>,
): { changes: AppSettingChange[]; rejected: string[] } {
  const changes: AppSettingChange[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const rule = SETTING_RULES[key];
    if (!rule) {
      rejected.push(`${key}: not a setting chat may change`);
      continue;
    }
    const normalized = rule(value);
    if (normalized === null) rejected.push(`${key}: invalid value`);
    else changes.push({ key, value: normalized });
  }
  return { changes, rejected };
}

/** Tool definitions in the shape native tool-calling APIs expect. */
export function nativeToolDefs(catalog: ToolDef[] = TOOL_CATALOG): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return catalog.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
}

export function toolCatalogPrompt(catalog: ToolDef[] = TOOL_CATALOG): string {
  const lines = catalog.map((t) => `- ${t.name}(${t.args}), ${t.description}`);
  return lines.join("\n");
}

async function callFunction(auth: string, name: string, body: unknown): Promise<unknown> {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${name}`;
  // Generous deadline: these proxy to generate-workout / plan-week, which run
  // their own LLM calls — but a hung one shouldn't stall the coach turn forever.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { error: `Planner returned HTTP ${res.status} without a valid JSON response`, status: res.status }; }
  if (!res.ok) {
    const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    return { ...body, error: body.error || body.message || `Planner returned HTTP ${res.status}`, status: res.status };
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed : { error: "Planner returned an invalid response" };
}

/** Execute a coach tool; returns a concise observation string for the LLM. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reject a date a write tool must not accept, or null when it is fine.
 *
 * THE BUG THIS FIXES: generate_workout passed `args.date` through with no
 * validation whatsoever, not even a format check. Asked for a ride "on Sunday",
 * the model reasoned that Sunday was not an available training day, walked
 * BACKWARDS to the nearest allowed one, and scheduled the session on yesterday.
 * A session in the past cannot be done, cannot be pushed to the watch, and
 * quietly counts against plan-versus-reality forever.
 *
 * [minDate] is the earliest date a write may target, computed by the caller
 * from the CLIENT's local date. Deliberately not derived here from the server
 * clock: this runs in UTC and the athlete may not, so a server-side "today"
 * would reject a legitimate today for anyone west of it.
 *
 * The message is written for the model, not the athlete: it has to say what to
 * do next, because this error is fed straight back into the tool loop.
 */
export function dateError(
  value: unknown,
  minDate: string,
  opts: { field: string; required: boolean },
): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return opts.required ? `error: ${opts.field} (YYYY-MM-DD) is required` : null;
  }
  if (!ISO_DATE.test(raw)) {
    return `error: ${opts.field} must be a real date as YYYY-MM-DD, got "${raw}"`;
  }
  if (raw < minDate) {
    return `error: ${raw} has already passed (today is ${minDate}). ` +
      `Pick ${minDate} or later. If the athlete's preferred weekday is gone this week, use the NEXT one, never an earlier date.`;
  }
  return null;
}

export async function executeTool(
  admin: SupabaseClient,
  userId: string,
  auth: string,
  name: string,
  args: Record<string, unknown>,
  // The athlete's local today. Optional so existing callers and tests keep
  // working; when absent, date checks fall back to the server's UTC date less
  // one day, which is tolerant enough for any timezone offset.
  today?: string,
): Promise<string> {
  const localToday = today && ISO_DATE.test(today) ? today : iso(Date.now());
  const minDate = today && ISO_DATE.test(today) ? today : iso(Date.now() - DAY);
  try {
    switch (name) {
      case "get_fitness": {
        const since = iso(Date.now() - 28 * DAY);
        const { data } = await admin.from("effective_activities")
          .select("date, tss, ctl, atl").eq("user_id", userId).gte("date", since)
          .order("date", { ascending: false });
        // No intervals-provided CTL? Fill estimated values from stored TSS so
        // the coach still sees a fitness signal without intervals.icu.
        const a = await applyFallbackFitness(admin, userId, iso(Date.now()), data ?? []);
        const fit = a.find((r) => r.ctl != null) ?? { ctl: 0, atl: 0 };
        const ctl = fit.ctl ?? 0, atl = fit.atl ?? 0;
        const since7 = iso(Date.now() - 7 * DAY);
        const load7 = a.filter((r) => (r.date ?? "") >= since7).reduce((s, r) => s + (r.tss ?? 0), 0);
        const load28 = a.reduce((s, r) => s + (r.tss ?? 0), 0);
        const acwr = load28 > 0 ? (load7 / (load28 / 4)).toFixed(2) : "n/a";
        // Words at the top level, numbers nested under `raw`. A model that
        // lazily echoes the payload's surface now echoes prose. The figures
        // stay available because "quote a number when it's actionable"
        // requires the number to exist. The prose `note:` field that used to
        // ask for this is gone: it was one of five copies of the same rule.
        return JSON.stringify({
          freshness: freshnessWord(ctl - atl),
          raw: {
            ctl: +ctl.toFixed(0),
            atl: +atl.toFixed(0),
            tsb: +(ctl - atl).toFixed(0),
            weekly_tss: Math.round(load7),
            acwr,
          },
        });
      }
      case "get_recent_activities": {
        const days = Math.min(60, Math.max(1, Number(args.days) || 14));
        const since = iso(Date.now() - days * DAY);
        const { data } = await admin.from("effective_activities")
          .select("type, date, distance_m, duration_seconds, avg_hr, tss")
          .eq("user_id", userId).gte("date", since).order("date", { ascending: false }).limit(40);
        const rows = (data ?? []).map((r) => ({
          date: r.date, type: r.type,
          km: r.distance_m ? +(r.distance_m / 1000).toFixed(1) : null,
          min: r.duration_seconds ? Math.round(r.duration_seconds / 60) : null,
          hr: r.avg_hr, tss: r.tss ? Math.round(r.tss) : null,
        }));
        return JSON.stringify(rows);
      }
      case "get_today_plan": {
        const { data, error } = await admin.from("reconciled_session_plans")
          .select("id,date,session_slot,start_minute,type,completed,skipped,locked,reconciliation_status,workout_json")
          .eq("user_id", userId).eq("date", localToday).order("session_slot");
        return JSON.stringify({ today: localToday, error: error ? "Today's calendar could not be read" : null,
          sessions: (data ?? []).map(r => ({ id: r.id, date: r.date, session_slot: r.session_slot ?? 0,
            start_minute: r.start_minute, type: r.type, completed: r.completed, skipped: r.skipped,
            locked: r.locked, status: r.reconciliation_status, workout: r.workout_json })) });
      }
      case "get_planned_week": {
        const start = (typeof args.week_start === "string" && args.week_start) ||
          mondayOf(new Date(minDate));
        const end = iso(new Date(start + "T00:00:00").getTime() + 6 * DAY);
        const { data, error } = await admin.from("reconciled_session_plans")
          .select("id, date, type, completed, skipped, locked, reconciliation_status, activity_ids, workout_json")
          .eq("user_id", userId).gte("date", start).lte("date", end).order("date");
        // Each day's position relative to TODAY, stated rather than left to be
        // worked out. A week starts on Monday, so by Sunday most of it is
        // history: measured live, the coach read Monday's session from six days
        // ago and told the athlete it was "tomorrow". Dates alone were not
        // enough; this makes the tense unmissable.
        const rows = (data ?? []).map((r) => ({
          id: r.id,
          date: r.date,
          when: r.date < minDate ? "past" : r.date === minDate ? "today" : "upcoming",
          type: r.type,
          completed: r.completed,
          skipped: r.skipped,
          status: r.reconciliation_status,
          actual_activity_ids: r.activity_ids,
          locked: r.locked,
          title: (r.workout_json as { title?: string })?.title ?? "",
        }));
        return JSON.stringify({ today: minDate, week_start: start, sessions: rows, ...(error ? {error:"The planned week could not be read"} : {}) });
      }
      case "get_strength_summary": {
        const cutoff = Date.now() - 28 * DAY;
        const { data: ws } = await admin.from("strength_workouts")
          .select("id, name, started_at, total_volume_kg").eq("user_id", userId)
          .gte("started_at", cutoff).order("started_at", { ascending: false }).limit(50);
        const workouts = ws ?? [];
        const ids = workouts.map((w) => w.id);
        let volByMuscle: Record<string, number> = {};
        if (ids.length) {
          const { data: sets } = await admin.from("strength_workout_sets")
            .select("muscle, is_warmup, workout_id").in("workout_id", ids);
          for (const s of sets ?? []) {
            if (s.is_warmup) continue;
            volByMuscle[s.muscle] = (volByMuscle[s.muscle] ?? 0) + 1;
          }
        }
        const recent = workouts.slice(0, 5).map((w) => ({
          name: w.name, date: iso(w.started_at), volume_kg: Math.round(w.total_volume_kg ?? 0),
        }));
        return JSON.stringify({ recent_sessions: recent, sets_per_muscle_28d: volByMuscle });
      }
      case "get_profile": {
        const { data: p } = await admin.from("user_profiles")
          .select("display_name, onboarding, coach_knowledge, training_paused_until, training_pause_reason, injury_backoff")
          .eq("id", userId).single();
        const o = (p?.onboarding ?? {}) as Record<string, unknown>;
        const { data: races } = await admin.from("races")
          .select("name, date, priority, sport, distance, target").eq("user_id", userId).order("date");
        // Mobility work the athlete logged (log_stretch_session). It was
        // write-only until now: the coach could record a session and then had
        // no way to know it had ever happened, so it asked again.
        const { data: stretches } = await admin.from("stretch_logs")
          .select("date, duration_min, notes")
          .eq("user_id", userId)
          .gte("date", iso(Date.now() - 28 * DAY))
          .order("date", { ascending: false })
          .limit(8);
        const pausedUntil = p?.training_paused_until as string | null;
        const today = localToday;
        return JSON.stringify({
          // `goal` is the overarching TRAINING goal; the dated goal is a row in
          // `goals` below, named here so the two can never be read as one.
          goal: goalsText(o), goal_date: o.goal_date,
          goal_race: goalRaceLine(pickGoalRace((races ?? []) as RaceRow[], today, o.goal_date as string), today) || null,
          experience: o.experience,
          days: o.days, session_min: o.session_duration, equipment: o.equipment,
          sports: o.sports, primary_sport: o.primary_sport, implements: availableImplements(o),
          weekly_minutes_max: o.weekly_minutes_max ?? null, session_windows: o.session_windows ?? [],
          prescription_engine: o.prescription_engine ?? "model", training_history_confirmed: o.training_history_confirmed === true,
          recovery_day_style: o.recovery_day_style ?? "rest", program_objectives: o.program_objectives ?? {},
          automatic_event_preparation: o.automatic_event_preparation !== false, event_policies: o.event_policies ?? {},
          injuries: injuriesText(o), lthr: o.lthr, ftp: o.ftp, threshold_pace: o.threshold_pace_per_km,
          target_pace: o.target_pace, goals: races ?? [], known: p?.coach_knowledge ?? "",
          // Richer onboarding: per-activity goals + experience, per-day availability.
          training_goals: o.goals, goals_by_sport: o.goals_by_sport,
          experience_by_sport: o.experience_by_sport, availability: o.day_availability,
          mobility_28d: stretches ?? [],
          // Active training pause (set_training_pause), null when there isn't one.
          training_paused_until: pausedUntil && pausedUntil >= today ? pausedUntil : null,
          training_pause_reason: p?.training_pause_reason ?? null,
          // The follow-up loop's state, so the coach can ask about a niggle it
          // has not heard about in a week instead of re-asking about one the
          // athlete answered this morning. `injuries` above is the prose line;
          // this is the same list with its dates.
          injury_status: unresolvedInjuries(injuriesOf(o)).map((i) => ({
            area: i.area,
            severity: i.severity || null,
            raised_at: i.raised_at ?? null,
            last_checked: i.last_checked ?? null,
            status: i.status || "not asked yet",
          })),
          // Dated backoffs in force RIGHT NOW. These are already being enforced
          // on generation, so the coach should describe them, not re-impose them.
          injury_backoff: activeBackoffs(p?.injury_backoff, today),
        });
      }
      case "get_readiness": {
        const since = iso(Date.now() - 7 * DAY);
        const { data } = await admin.from("wellness_checkins")
          .select("date, energy, soreness, sleep_score, hrv_rmssd, resting_hr, zepp_sleep_minutes")
          .eq("user_id", userId).gte("date", since).order("date", { ascending: false });
        const wells = data ?? [];
        const isNum = (v: unknown): v is number => typeof v === "number";
        const chrono = [...wells].reverse();
        const rec = computeRecovery(
          wells,
          chrono.filter(w=>isNum(w.hrv_rmssd)).map(w=>({date:w.date,value:w.hrv_rmssd!})),
          chrono.filter(w=>isNum(w.resting_hr)).map(w=>({date:w.date,value:w.resting_hr!})),
          today,
        );
        const {data: athlete}=await admin.from("user_profiles").select("onboarding").eq("id",userId).single();
        const state=await sessionState(admin,userId,athlete?.onboarding??{},today??iso(Date.now()),"rest");
        // basis "none" means nothing was measured: the coach must not read the
        // placeholder 50 back to the athlete as a state of their body.
        return JSON.stringify({
          decision_context: state.readiness,
          readiness: rec.basis === "none" ? "not measured today" : recoveryWord(rec.band),
          summary: rec.summary,
          basis: rec.basis,
          raw: {
            score: rec.basis === "none" ? null : rec.score,
            band: rec.band,
            hrv: rec.hrv ?? null,
            resting_hr: rec.rhr ?? null,
            sleep: rec.sleep ?? null,
            wellness_1to5: rec.wellness,
          },
        });
      }
      case "get_execution_analysis": {
        interface Comp { name: string; score: number; detail: string }
        interface Stored { score?: number; label?: string; components?: Comp[]; feedback?: string }
        const { data: endu } = await admin.from("effective_activities")
          .select("date, type, analysis_json")
          .eq("user_id", userId).not("analysis_json", "is", null)
          .order("date", { ascending: false }).limit(5);
        const { data: str } = await admin.from("strength_analyses")
          .select("date, analysis_json")
          .eq("user_id", userId).order("date", { ascending: false }).limit(3);
        const brief = (kind: string, date: string, a: Stored) => ({
          date, kind,
          score: a.score ?? null, label: a.label ?? null,
          components: (a.components ?? []).map((c) => `${c.name} ${c.score}/100 (${c.detail})`),
        });
        const rows = [
          ...(endu ?? []).map((r) => brief(String(r.type ?? "endurance"), r.date, r.analysis_json as Stored)),
          ...(str ?? []).map((r) => brief("strength", r.date, r.analysis_json as Stored)),
        ].sort((x, y) => y.date.localeCompare(x.date));
        if (!rows.length) return JSON.stringify({ note: "no analyzed sessions yet, the athlete can analyze a workout from its detail page, or it happens automatically after a sync" });
        return JSON.stringify(rows);
      }
      case "get_adaptation_history": {
        const result=await callFunction(auth,"adapt-plan",{action:"history"}) as {history?:Array<{id:string;state:string;explanation:string;changes:Array<{date:string;session_slot:number;before:{title:string;duration_minutes:number};after:{title:string;duration_minutes:number}}>}>};
        return JSON.stringify({history:(result.history??[]).map(p=>({id:p.id,state:p.state,explanation:p.explanation,changes:p.changes.map(c=>({date:c.date,session_slot:c.session_slot,before:c.before.title,after:c.after.title,before_minutes:c.before.duration_minutes,after_minutes:c.after.duration_minutes}))}))});
      }
      case "preview_adaptation":
      case "apply_adaptation":
      case "undo_adaptation": {
        const date=String(args.today??today??iso(Date.now()));
        const bad=dateError(date,minDate,{field:"today",required:true}); if(bad)return bad;
        const result=await callFunction(auth,"adapt-plan",{...args,today:date,action:name==="preview_adaptation"?"preview":name==="undo_adaptation"?"undo":"apply"});
        return JSON.stringify({ ...result as Record<string,unknown>,week_now:await weekSnapshot(admin,userId,date) });
      }
      case "move_workout": {
        const newDate = String(args.new_date ?? "");
        const badMove = dateError(newDate, minDate, { field: "new_date", required: true });
        if (badMove) return badMove;
        let workoutId = typeof args.workout_id === "string" ? args.workout_id : null;
        if (!workoutId && typeof args.date === "string") {
          const { data: rows } = await admin.from("reconciled_session_plans")
            .select("id, type, completed")
            .eq("user_id", userId).eq("date", args.date).neq("type", "rest")
            .order("created_at", { ascending: false });
          workoutId = (rows ?? []).find((r) => !r.completed)?.id ?? (rows ?? [])[0]?.id ?? null;
        }
        if (!workoutId) return "error: no workout found, pass workout_id (see get_planned_week) or date";
        const r = await callFunction(auth, "move-workout", { workout_id: workoutId, new_date: newDate }) as Record<string, unknown>;
        return JSON.stringify({
          ok: !r.error,
          old_date: r.old_date ?? null,
          new_date: r.new_date ?? newDate,
          event_moved: r.event_moved ?? null,
          error: r.error ?? null,
          week_now: await weekSnapshot(admin, userId, newDate),
        });
      }
      case "set_rest_day": {
        const d = String(args.date ?? "");
        const badRest = dateError(d, minDate, { field: "date", required: true });
        if (badRest) return badRest;
        // Clear every non-rest planned session that day; delete-workout removes the
        // watch event too (same path the app's delete uses).
        const { data: rows } = await admin.from("reconciled_session_plans")
          .select("id, type, workout_json").eq("user_id", userId).eq("date", d).neq("type", "rest").eq("completed",false).eq("locked",false).eq("skipped",false);
        // NAME what was deleted, do not just count it. This returned a bare
        // `cleared: 4` while quietly destroying the four sessions plan_week had
        // created moments earlier in the same turn; a count gave the model no
        // way to notice it had just undone its own work.
        const cleared = (rows ?? []).map((r) => ({
          type: r.type,
          title: (r.workout_json as { title?: string } | null)?.title ?? null,
        }));
        for (const row of rows ?? []) {
          await callFunction(auth, "delete-workout", { workout_id: row.id });
        }
        return JSON.stringify({
          ok: true,
          date: d,
          cleared_count: cleared.length,
          cleared,
          week_now: await weekSnapshot(admin, userId, d),
        });
      }
      case "log_stretch_session": {
        // A completed session, not a calendar edit — no week_now needed. This
        // records something that already happened, so the date constraint is
        // the OPPOSITE of dateError's (which floors at today for editing
        // future plan days): here today is the ceiling, not the floor.
        const raw = typeof args.date === "string" ? args.date.trim() : "";
        const todayCeiling = today && ISO_DATE.test(today) ? today : iso(Date.now());
        if (raw && (!ISO_DATE.test(raw) || raw > todayCeiling)) {
          return `error: date must be a real date as YYYY-MM-DD, not in the future (today is ${todayCeiling})`;
        }
        const d = raw || todayCeiling;
        const durationMin = typeof args.duration_min === "number" && isFinite(args.duration_min)
          ? Math.max(0, Math.round(args.duration_min))
          : null;
        const notes = typeof args.notes === "string" && args.notes.trim() ? args.notes.trim().slice(0, 500) : null;
        await admin.from("stretch_logs").insert({
          user_id: userId, date: d, duration_min: durationMin, notes,
        });
        return JSON.stringify({ ok: true, date: d, duration_min: durationMin });
      }
      case "set_training_pause": {
        const until = String(args.until_date ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return "error: until_date (YYYY-MM-DD) is required";
        const today = iso(Date.now());
        if (until < today) return "error: until_date is in the past";
        const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim().slice(0, 200) : null;
        await admin.from("user_profiles").update({
          training_paused_until: until,
          training_pause_reason: reason,
        }).eq("id", userId);
        // Clear upcoming unlocked, incomplete sessions in the pause window now —
        // plan_week will also respect the pause on its own next run, but this
        // makes the calendar reflect it immediately.
        const { data: rows } = await admin.from("reconciled_session_plans")
          .select("id, type").eq("user_id", userId).gte("date", today).lte("date", until)
          .eq("completed", false).eq("locked", false).neq("type", "rest");
        let cleared = 0;
        for (const row of rows ?? []) {
          await callFunction(auth, "delete-workout", { workout_id: row.id });
          cleared++;
        }
        return JSON.stringify({ ok: true, until_date: until, reason, cleared });
      }
      case "resume_training": {
        await admin.from("user_profiles").update({
          training_paused_until: null, training_pause_reason: null,
        }).eq("id", userId);
        return JSON.stringify({ ok: true });
      }
      case "set_injury_backoff": {
        const area = String(args.area ?? "").trim();
        if (!area) return "error: area is required";
        const level = args.level === "avoid" ? "avoid" : args.level === "ease" ? "ease" : null;
        if (!level) return "error: level must be 'ease' or 'avoid'";
        const today = iso(Date.now());
        const days = typeof args.days === "number" && isFinite(args.days)
          ? Math.min(60, Math.max(1, Math.round(args.days)))
          : BACKOFF_DAYS;
        const reason = typeof args.reason === "string" && args.reason.trim()
          ? args.reason.trim().slice(0, 200)
          : undefined;
        const { data: p } = await admin.from("user_profiles")
          .select("injury_backoff").eq("id", userId).single();
        const next = upsertBackoff(activeBackoffs(p?.injury_backoff, today), {
          area, level, until: addDays(today, days), reason, set_at: today,
        });
        await admin.from("user_profiles").update({ injury_backoff: next }).eq("id", userId);
        return JSON.stringify({
          ok: true, area, level, until: addDays(today, days),
          // Named back so the coach can say what it actually did rather than
          // promising a vaguer version of it.
          effect: level === "avoid"
            ? "movements loading this area are removed from generated sessions, and the sports that stress it will not be scheduled"
            : "the area is still trained, but hard zones and heavy loading through it are capped",
        });
      }
      case "report_injury": {
        // This deliberately combines profile capture with immediate protection.
        // The old two-tool choreography (remember + set_injury_backoff) let a
        // model successfully "remember" a knee injury without ever adding it
        // to onboarding.injuries, so follow-ups and the Injury screen missed it.
        const area = String(args.area ?? "").replace(/\s+/g, " ").trim();
        if (!area) return "error: area is required";
        const pain = typeof args.pain === "number" && Number.isFinite(args.pain)
          ? Math.round(args.pain)
          : null;
        if (args.pain !== undefined && (pain === null || pain < 1 || pain > 10)) {
          return "error: pain must be a whole number from 1 to 10";
        }
        const statedSeverity = args.severity;
        if (statedSeverity !== undefined && statedSeverity !== "mild" && statedSeverity !== "moderate" && statedSeverity !== "serious") {
          return "error: severity must be 'mild', 'moderate' or 'serious'";
        }
        const severity = pain === null
          ? (statedSeverity ?? "")
          : pain <= 3 ? "mild" : pain <= 6 ? "moderate" : "serious";
        const detail = typeof args.detail === "string" ? args.detail.trim().slice(0, 240) : "";
        const days = typeof args.days === "number" && Number.isFinite(args.days)
          ? Math.min(60, Math.max(1, Math.round(args.days)))
          : BACKOFF_DAYS;
        const today = minDate;
        const { data: p } = await admin.from("user_profiles")
          .select("onboarding, injury_backoff").eq("id", userId).single();
        const o = (p?.onboarding ?? {}) as Record<string, unknown>;
        const existing = injuriesOf(o);
        const sameArea = (i: InjuryEntry) => i.area.trim().toLowerCase() === area.toLowerCase();
        const prior = existing.find(sameArea);
        const entry: InjuryEntry = {
          area: prior?.area || area,
          severity: severity || prior?.severity || "",
          note: detail || prior?.note,
          raised_at: prior?.raised_at || today,
          status: "present",
        };
        const injuries = prior
          ? existing.map((i) => sameArea(i) ? entry : i)
          : [...existing, entry];
        // A severe report is structurally avoided; all other reports get a
        // reversible ease-level cap while the coach gathers the missing detail.
        const level = severity === "serious" ? "avoid" : "ease";
        const backoffs = upsertBackoff(activeBackoffs(p?.injury_backoff, today), {
          area: entry.area,
          level,
          until: addDays(today, days),
          reason: detail || undefined,
          set_at: today,
        });
        await admin.from("user_profiles").update({
          onboarding: { ...o, injuries },
          injury_backoff: backoffs,
        }).eq("id", userId);
        return JSON.stringify({
          ok: true,
          created: !prior,
          injury: { area: entry.area, severity: entry.severity || null, detail: entry.note ?? null },
          protection: level,
          until: addDays(today, days),
          next_questions: ["exact location / side", "pain 1-10", "what triggers it and when it began"],
          effect: level === "avoid"
            ? "movements loading this area are removed from generated sessions, and the sports that stress it will not be scheduled"
            : "hard zones and heavy loading through this area are capped while you clarify the injury",
        });
      }
      case "clear_injury_backoff": {
        const today = iso(Date.now());
        const area = typeof args.area === "string" ? args.area.trim() : "";
        const { data: p } = await admin.from("user_profiles")
          .select("injury_backoff").eq("id", userId).single();
        const before = activeBackoffs(p?.injury_backoff, today);
        const next = clearBackoff(before, area || undefined);
        await admin.from("user_profiles").update({ injury_backoff: next }).eq("id", userId);
        return JSON.stringify({ ok: true, cleared: before.length - next.length });
      }
      case "update_injury_status": {
        const area = String(args.area ?? "").trim();
        if (!area) return "error: area is required";
        const status = args.status;
        if (status !== "present" && status !== "better" && status !== "resolved") {
          return "error: status must be 'present', 'better' or 'resolved'";
        }
        const today = iso(Date.now());
        const { data: p } = await admin.from("user_profiles")
          .select("onboarding, injury_backoff").eq("id", userId).single();
        const o = (p?.onboarding ?? {}) as Record<string, unknown>;
        const before = injuriesOf(o);
        if (!before.some((i) => i.area.trim().toLowerCase() === area.toLowerCase())) {
          return `error: no injury on file matching "${area}". Known: ${
            before.map((i) => i.area).filter(Boolean).join(", ") || "none"
          }`;
        }
        const injuries = markInjuryChecked(before, area, status, today);
        // A resolved area must also stop backing off, or the athlete says "it's
        // fine now" and keeps getting sessions built around it until the dated
        // window happens to lapse.
        const backoffs = status === "resolved"
          ? clearBackoff(activeBackoffs(p?.injury_backoff, today), area)
          : activeBackoffs(p?.injury_backoff, today);
        await admin.from("user_profiles").update({
          onboarding: { ...o, injuries },
          injury_backoff: backoffs,
        }).eq("id", userId);
        return JSON.stringify({
          ok: true, area, status,
          removed_from_injuries: status === "resolved",
          next_check_in_days: status === "resolved" ? null : FOLLOWUP_REPEAT_DAYS,
        });
      }
      case "set_weather_prompt_pref": {
        const optOut = args.opt_out === true;
        const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim().slice(0, 200) : null;
        await admin.from("user_profiles").update({
          weather_prompt_opt_out: optOut,
          weather_prompt_opt_out_reason: optOut ? reason : null,
        }).eq("id", userId);
        return JSON.stringify({ ok: true, opt_out: optOut, reason });
      }
      case "make_easier": {
        const bad = dateError(args.date, minDate, { field: "date", required: false });
        if (bad) return bad;
        const day = typeof args.date === "string" && args.date ? args.date : minDate;

        // THE BUG THIS FIXES: this passed type "auto", so "make it easier"
        // regenerated the day with a FREE choice of sport. Measured live, four
        // easy runs came back as four identical strength sessions. Easing a run
        // must produce an easier run: read what is actually planned and pin it.
        const { data: planned } = await admin.from("reconciled_session_plans")
          .select("id, type, workout_json").eq("user_id", userId).eq("date", day)
          .neq("type", "rest").order("created_at", { ascending: false });
        const current = (planned ?? [])[0];
        if (!current) {
          return `error: nothing is planned on ${day} to make easier. Check get_planned_week first.`;
        }

        const r = await callFunction(auth, "generate-workout", {
          date: day,
          type: current.type ?? "auto",
          request: "Make this day noticeably easier, lower the intensity and volume, keep it aerobic/recovery. " +
            `Keep it the same kind of session (${current.type}), do not switch sport.`,
          push: true,
        }) as Record<string, unknown>;
        const w = r.workout as { title?: string } | undefined;
        return JSON.stringify({
          ok: !!r.workout_id,
          date: day,
          // Report the sport both ways so a swap is visible in the observation
          // rather than only on the athlete's calendar.
          was: { type: current.type, title: (current.workout_json as { title?: string } | null)?.title ?? null },
          now: { type: current.type, title: w?.title ?? null },
          error: r.error ?? null,
          week_now: await weekSnapshot(admin, userId, day),
        });
      }
      case "plan_week": {
        const badWeek = dateError(args.start_date, minDate, { field: "start_date", required: false });
        // A week may legitimately START in the past (the current week's Monday),
        // so only the FORMAT is enforced here, not the floor.
        if (badWeek && !badWeek.includes("has already passed")) return badWeek;

        // Resolve and forward the SAME local date/week used by the read-back.
        const requestedStart = typeof args.start_date === "string" ? args.start_date : mondayOf(new Date(localToday));
        const r = await callFunction(auth, "plan-week", { start_date: requestedStart, today: localToday }) as Record<string, unknown>;

        // THE BUG THIS FIXES: this returned `scheduled: 5` and nothing else, so
        // the model had no way to describe the week it had just created and
        // described the one it MEANT to create instead. Measured live, it
        // reported "3 easy runs and 2 strength sessions" for a week that
        // actually held 4 strength sessions and no runs at all. Read the days
        // back from the database so the summary is grounded in what exists.
        const start = typeof args.start_date === "string" && ISO_DATE.test(args.start_date)
          ? args.start_date
          : requestedStart;
        const end = iso(new Date(start).getTime() + 6 * DAY);
        const { data: days, error: readError } = await admin.from("reconciled_session_plans")
          .select("date, type, workout_json")
          .eq("user_id", userId).gte("date", start).lte("date", end)
          .order("date", { ascending: true });

        return JSON.stringify({
          ok: !r.error && !readError && typeof r.scheduled === "number" && r.scheduled > 0 && (days?.length ?? 0) > 0,
          error: r.error ?? readError?.message ?? (typeof r.scheduled !== "number" ? "Planner did not confirm saved sessions" : null)
            ?? (r.scheduled === 0 ? r.rationale ?? "No new sessions were scheduled; requested dates may be protected" : null)
            ?? (!days?.length ? "Saved sessions could not be verified on the calendar" : null),
          scheduled: r.scheduled ?? 0,
          week_start: start,
          week_focus: r.week_focus,
          rationale: r.rationale,
          pushed: r.pushed,
          calendar_saved: !r.error && typeof r.scheduled === "number" && r.scheduled > 0,
          delivery: r.sync_error ? "pending" : Number(r.pushed) > 0 ? "sent" : "not_confirmed",
          // The authoritative answer to "what is on the calendar now".
          week_now: (days ?? []).map((d) => ({
            date: d.date,
            type: d.type,
            title: (d.workout_json as { title?: string } | null)?.title ?? null,
          })),
        });
      }
      case "generate_workout": {
        const bad = dateError(args.date, minDate, { field: "date", required: false });
        if (bad) return bad;
        const r = await callFunction(auth, "generate-workout", {
          date: args.date ?? localToday, type: args.type ?? "auto", session_slot: args.session_slot ?? 0,
          // Only pin a duration when explicitly requested — otherwise the
          // generator applies the athlete's flexible length preference.
          ...(typeof args.duration === "number" ? { duration: args.duration } : {}),
          request: args.request, lock: args.lock === true, push: true, today: localToday,
        }) as Record<string, unknown>;
        const w = r.workout as { title?: string } | undefined;
        return JSON.stringify({
          ok: !!r.workout_id,
          title: w?.title ?? null,
          calendar_saved: !!r.workout_id,
          delivery: r.push_error || r.sync_error ? "pending" : r.intervals_event_id ? "sent" : "not_confirmed",
          // The date the workout actually landed on, echoed from the generator
          // where it knows it. "today" was a guess the model then repeated to
          // the athlete as fact.
          date: (typeof r.date === "string" ? r.date : null) ?? args.date ?? minDate,
          type: args.type ?? "auto",
          error: r.error ?? null,
          week_now: await weekSnapshot(admin, userId, String(args.date ?? minDate)),
        });
      }
      case "assess_goal": {
        if (!args.goal || !args.date) return "error: goal and date are required";
        const f = assessFeasibility(
          await feasibilityInputs(admin, userId, String(args.goal), String(args.date)),
        );
        return JSON.stringify({
          verdict: f.band,
          headline: f.headline,
          evidence: f.reasons,
          suggestion: f.suggestion,
          weeks_needed: f.weeksNeeded,
          push_back: f.pushBack,
        });
      }
      case "set_goal_race": {
        if (!args.name || !args.date) return "error: name and date are required";
        const name = String(args.name).trim().slice(0, 120);
        const date = String(args.date).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "error: date must be YYYY-MM-DD";

        const sportRaw = String(args.sport ?? "run").toLowerCase();
        const sport = ["run", "ride", "swim", "strength", "other"].includes(sportRaw) ? sportRaw : "run";
        const priorityRaw = String(args.priority ?? "A").toUpperCase();
        const priority = ["A", "B", "C"].includes(priorityRaw) ? priorityRaw : "A";
        const str = (v: unknown) => {
          const s = typeof v === "string" ? v.trim() : "";
          return s ? s.slice(0, 200) : null;
        };
        const distance = str(args.distance);
        // target_pace is the pre-multisport name for the same field; accept it
        // so an older prompt or model habit still lands somewhere sensible.
        const target = str(args.target) ?? str(args.target_pace);
        const notes = str(args.notes);

        // THE BUG THIS FIXES: this tool only ever wrote onboarding.goal, which
        // Home reads, so a goal set through chat appeared on Home while
        // Settings > Goals and races (which reads the `races` table) stayed
        // empty. The app does BOTH halves when you add a race by hand
        // (addRace + setGoalRace); the coach now does too.
        const { data: existing } = await admin.from("races")
          .select("id").eq("user_id", userId).eq("name", name).eq("date", date).maybeSingle();
        if (existing?.id) {
          await admin.from("races").update({ priority, sport, distance, target, notes })
            .eq("id", existing.id);
        } else {
          await admin.from("races").insert({
            user_id: userId, name, date, priority, sport, distance, target, notes,
          });
        }

        // Only an A goal anchors periodization, matching setGoalRace on device.
        //
        // The anchor is a DATE pointing into `races`, never a copy of the name.
        // onboarding.goal is the athlete's OVERARCHING training goal (the phone
        // derives it from goals_by_sport), and writing the event name over it is
        // what made every coach prompt say their goal was "Athens Marathon" and
        // forget they also wanted to build muscle.
        let anchored = false;
        if (priority === "A") {
          const { data: p } = await admin.from("user_profiles").select("onboarding").eq("id", userId).single();
          const o = (p?.onboarding ?? {}) as Record<string, unknown>;
          const pace = sport === "run" && target ? { target_pace: target } : {};
          await admin.from("user_profiles").update({
            onboarding: { ...o, goal_date: date, ...pace },
          }).eq("id", userId);
          anchored = true;
        }

        // Return the verdict WITH the write, so the coach cannot save a goal
        // and start planning without having seen whether it is achievable.
        const f = assessFeasibility(
          await feasibilityInputs(admin, userId, goalTextFor(name, distance), date),
        );
        return JSON.stringify({
          ok: true,
          saved_to_goals_and_races: true,
          anchors_periodization: anchored,
          goal: { name, date, sport, distance, priority, target, notes },
          feasibility: {
            verdict: f.band,
            headline: f.headline,
            evidence: f.reasons,
            suggestion: f.suggestion,
            weeks_needed: f.weeksNeeded,
            push_back: f.pushBack,
          },
        });
      }
      case "remove_goal_race": {
        // The bug this fixes: there was no way to take a goal back. Asked to
        // "remove the Ironman", the coach had no tool for it, so it said it had
        // and nothing was written. The goal stayed in onboarding.goal, Home
        // kept reading it, and it reappeared the moment anything refreshed.
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const date = typeof args.date === "string" ? args.date.trim() : "";
        if (!name && !date) return "error: give a name or a date to remove";
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return "error: date must be YYYY-MM-DD";
        }

        const { data: rows } = await admin.from("races")
          .select("id, name, date, priority").eq("user_id", userId);
        const all = (rows ?? []) as Array<
          { id: string; name: string; date: string; priority: string | null }
        >;
        const doomed = all.filter((r) => matchesGoal(r, name, date));

        if (doomed.length) {
          await admin.from("races").delete()
            .eq("user_id", userId).in("id", doomed.map((r) => r.id));
        }

        // The anchor lives in onboarding, separately from the races list, so
        // deleting the row is only half the job: move it here too when it
        // pointed at what was just removed.
        //
        // The anchor is a DATE pointing into `races` now, so this is a date
        // comparison rather than the name match matchesGoal does on the rows.
        // The second arm covers a DANGLING anchor, a date with no row behind it
        // (left over from before the goal field was split): it clears only when
        // the athlete asked for that exact date, so removing an unrelated race
        // can never silently move their periodization.
        const { data: p } = await admin.from("user_profiles")
          .select("onboarding").eq("id", userId).single();
        const o = (p?.onboarding ?? {}) as Record<string, unknown>;
        const anchorDate = typeof o.goal_date === "string" ? o.goal_date : "";
        const clearing = Boolean(anchorDate) && (
          doomed.some((r) => r.date === anchorDate) ||
          (date === anchorDate && !all.some((r) => r.date === anchorDate))
        );

        let newAnchor: { name: string; date: string } | null = null;
        if (clearing) {
          // Promote the soonest remaining A goal rather than leaving the
          // athlete with no anchor at all: periodization, phase and taper all
          // read it, so an empty anchor quietly flattens their plan.
          const today = new Date().toISOString().slice(0, 10);
          const next = all
            .filter((r) => !doomed.some((d) => d.id === r.id))
            .filter((r) => (r.priority ?? "A").toUpperCase() === "A" && r.date >= today)
            .sort((a, b) => a.date.localeCompare(b.date))[0];
          // The name is reported back so the coach can say which goal took over,
          // but only the date is persisted: onboarding.goal is the athlete's
          // training goal and this tool has no business rewriting it.
          newAnchor = next ? { name: next.name, date: next.date } : null;
          await admin.from("user_profiles").update({
            onboarding: { ...o, goal_date: newAnchor?.date ?? null },
          }).eq("id", userId);
        }

        // Report what happened, not what was asked for: nothing matched has to
        // be distinguishable from removed, or the coach confirms a deletion
        // that never occurred, which is exactly how this went wrong before.
        return JSON.stringify({
          ok: true,
          removed: doomed.map((r) => ({ name: r.name, date: r.date })),
          removed_count: doomed.length,
          cleared_from_home: clearing,
          new_goal_anchor: newAnchor,
          note: doomed.length === 0 && !clearing
            ? "nothing matched, so nothing was removed. Tell the athlete, and check the name against get_profile."
            : undefined,
        });
      }
      case "update_profile": {
        // Bounded per field: a misheard "FTP 9000" must not become the zones
        // every future workout is built on. Out-of-range values are rejected
        // per-field with a reason the model can relay.
        const paceRe = /^\d{1,2}:\d{2}$/;
        const updates: Record<string, unknown> = {};
        const rejected: string[] = [];
        const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
        if (args.display_name !== undefined) {
          const name = String(args.display_name).trim().slice(0, 40);
          if (name) updates.display_name = name;
          else rejected.push("display_name must not be empty");
        }
        if (args.sex !== undefined) {
          const s = String(args.sex).trim().toLowerCase();
          if (s === "male" || s === "female") updates.sex = s;
          else rejected.push("sex must be male or female");
        }
        const by = num(args.birth_year);
        if (args.birth_year !== undefined) {
          const maxYear = new Date().getFullYear() - 5;
          if (by !== null && by >= 1900 && by <= maxYear) updates.birth_year = Math.round(by);
          else rejected.push(`birth_year must be 1900-${maxYear}`);
        }
        const ftp = num(args.ftp);
        if (args.ftp !== undefined) {
          if (ftp !== null && ftp >= 50 && ftp <= 600) updates.ftp = Math.round(ftp);
          else rejected.push("ftp must be 50-600 watts");
        }
        const lthr = num(args.lthr);
        if (args.lthr !== undefined) {
          if (lthr !== null && lthr >= 120 && lthr <= 210) updates.lthr = Math.round(lthr);
          else rejected.push("lthr must be 120-210 bpm");
        }
        if (args.threshold_pace_per_km !== undefined) {
          const p = String(args.threshold_pace_per_km).trim();
          if (paceRe.test(p)) updates.threshold_pace_per_km = p;
          else rejected.push("threshold_pace_per_km must look like 4:45");
        }
        if (args.css_per_100m !== undefined) {
          const p = String(args.css_per_100m).trim();
          if (paceRe.test(p)) updates.css_per_100m = p;
          else rejected.push("css_per_100m must look like 1:55");
        }
        const tss = num(args.weekly_tss_target);
        if (args.weekly_tss_target !== undefined) {
          if (tss !== null && tss >= 100 && tss <= 1000) updates.weekly_tss_target = Math.round(tss);
          else rejected.push("weekly_tss_target must be 100-1000");
        }
        const weight = num(args.weight_kg);
        if (args.weight_kg !== undefined) {
          if (weight !== null && weight >= 30 && weight <= 250) updates.weight_kg = Math.round(weight);
          else rejected.push("weight_kg must be 30-250");
        }
        const height = num(args.height_cm);
        if (args.height_cm !== undefined) {
          if (height !== null && height >= 120 && height <= 230) updates.height_cm = Math.round(height);
          else rejected.push("height_cm must be 120-230");
        }
        const bf = num(args.body_fat_pct);
        if (args.body_fat_pct !== undefined) {
          if (bf !== null && bf >= 3 && bf <= 60) updates.body_fat_pct = Math.round(bf * 10) / 10;
          else rejected.push("body_fat_pct must be 3-60");
        }
        const dur = num(args.session_duration);
        if (args.session_duration !== undefined) {
          if (dur !== null && dur >= 15 && dur <= 300) updates.session_duration = Math.round(dur);
          else rejected.push("session_duration must be 15-300 minutes");
        }
        if (Object.keys(updates).length === 0) {
          return `error: nothing to save${rejected.length ? ` (${rejected.join("; ")})` : ""}`;
        }
        const { data: p } = await admin.from("user_profiles").select("onboarding").eq("id", userId).single();
        const o = (p?.onboarding ?? {}) as Record<string, unknown>;
        await admin.from("user_profiles").update({
          onboarding: { ...o, ...updates },
          // Mirror the name to the top-level column, exactly like the app's
          // saveProfile — the backend and Settings read it from there.
          ...(typeof updates.display_name === "string" ? { display_name: updates.display_name } : {}),
        }).eq("id", userId);
        return JSON.stringify({ ok: true, saved: updates, ...(rejected.length ? { rejected } : {}) });
      }
      case "remember": {
        const fact = String(args.fact ?? "").trim();
        if (!fact) return "error: fact is empty";
        const { data: p } = await admin.from("user_profiles").select("coach_knowledge").eq("id", userId).single();
        const prev = (p?.coach_knowledge ?? "") as string;
        const normalized = (s: string) => s.trim().toLowerCase().replace(/^-\s*/, "");
        const lines = prev.trim() ? prev.trim().split("\n") : [];
        const isDuplicate = lines.some((l) => normalized(l) === normalized(fact));
        if (isDuplicate) return JSON.stringify({ ok: true, remembered: fact, duplicate: true });
        const next = (prev.trim() ? prev.trim() + "\n" : "") + `- ${fact}`;
        await admin.from("user_profiles").update({ coach_knowledge: next }).eq("id", userId);
        return JSON.stringify({ ok: true, remembered: fact });
      }
      case "update_app_settings":
        // Executed by coach-chat itself (the changes ride back to the device);
        // reaching here means a caller without that channel invoked it.
        return "error: update_app_settings is only available in chat";
      default:
        return `error: unknown tool "${name}"`;
    }
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
