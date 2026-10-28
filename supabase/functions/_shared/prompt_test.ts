import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  BRIEF_SYSTEM,
  buildBriefPrompt,
  buildRunPrompt,
  buildWeekReviewPrompt,
  CHAT_COACHING_DIGEST,
  COACH_SYSTEM_PROMPT,
  COACHING_PRINCIPLES,
  effortWord,
  loadWord,
  SYSTEM_PROMPT,
  WEEK_REVIEW_SYSTEM,
  WEEK_SYSTEM_PROMPT,
} from "./prompt.ts";

// ---------------------------------------------------------------------------
// COACH_SYSTEM_PROMPT.
//
// Nothing asserted anything about the chat prompt's voice or style before, even
// though it is the single biggest lever on how the coach reads. These pin the
// contract; the offline eval measures whether models actually follow it.
// ---------------------------------------------------------------------------

Deno.test("the chat prompt carries the reply-shape contract", () => {
  const p = COACH_SYSTEM_PROMPT;
  assertStringIncludes(p, "AT MOST ONE question per turn");
  assertStringIncludes(p, "2 to 5 sentences");
  // Table rules exist because the app renders each row as its own card.
  assertStringIncludes(p, "first column is the row's label");
  assertStringIncludes(p, "own card");
  assert(/do not\s+use headings, code fences/i.test(p), "must forbid headings and fences");
});

Deno.test("the chat prompt keeps the voice rule, including the worked example", () => {
  assertStringIncludes(COACH_SYSTEM_PROMPT, "not a dashboard");
  // The DON'T/DO pair is the part that actually shifts output; keep it whole.
  assertStringIncludes(COACH_SYSTEM_PROMPT, "DON'T:");
  assertStringIncludes(COACH_SYSTEM_PROMPT, "DO:");
});

Deno.test("chat does not carry the generation-only session-design science", () => {
  const p = COACH_SYSTEM_PROMPT;
  assert(!p.includes(COACHING_PRINCIPLES), "chat must use the digest, not the full principles");
  // Spot-check the specific detail that only matters when writing a session.
  for (const jargon of ["%1RM", "work:rest", "pace_zone", "hard sets/muscle/week"]) {
    assert(!p.includes(jargon), `chat prompt should not carry "${jargon}"`);
  }
});

Deno.test("the generation prompts keep the FULL principles", () => {
  assert(SYSTEM_PROMPT.includes(COACHING_PRINCIPLES), "workout generation needs the detail");
  assert(WEEK_SYSTEM_PROMPT.includes(COACHING_PRINCIPLES), "week planning needs the detail");
});

Deno.test("the digest still carries the rules the coach reasons from", () => {
  const d = CHAT_COACHING_DIGEST;
  for (const rule of [/80%/, /10%/, /descriptive context/, /back to back/i, /cold start/i, /RIR 1-3/, /48h/]) {
    assert(rule.test(d), `digest lost a load-bearing rule: ${rule}`);
  }
  // The sentence that justifies dropping the rest.
  assertStringIncludes(d, "generator's job");
});

// A size fence, mirroring how llm_test.ts pins the token budgets. The prompt is
// resent on every call of an agentic turn (up to 12), so growth here is
// multiplied. It was 8071 chars before the digest; this stops it creeping back.
Deno.test("the chat prompt stays under its size fence", () => {
  assert(
    COACH_SYSTEM_PROMPT.length < 7000,
    `COACH_SYSTEM_PROMPT grew to ${COACH_SYSTEM_PROMPT.length} chars, over the 7000 fence`,
  );
});

// ---------------------------------------------------------------------------
// Word helpers: these exist so raw figures stop being injected into the chat
// context, where the voice rule then had to argue the model out of reciting them.
// ---------------------------------------------------------------------------

Deno.test("loadWord describes the week relative to the athlete's own target", () => {
  assertEquals(loadWord(0, 350), "well short of a normal week so far");
  assertEquals(loadWord(175, 350), "part way through a normal week");
  assertEquals(loadWord(350, 350), "on track for a normal week");
  assertEquals(loadWord(450, 350), "a bigger week than usual");
  assertEquals(loadWord(700, 350), "a much heavier week than usual");
  // "On track" is meaningless with nothing to be on track for.
  assertEquals(loadWord(0, null), "nothing logged yet this week");
  assertEquals(loadWord(200, 0), "some work banked this week");
});

Deno.test("effortWord turns per-session load into a word, and stays quiet when unknown", () => {
  assertEquals(effortWord(20), "easy");
  assertEquals(effortWord(55), "moderate");
  assertEquals(effortWord(100), "hard");
  assertEquals(effortWord(200), "very hard");
  assertEquals(effortWord(null), "");
  assertEquals(effortWord(0), "");
});

const hrZones = [
  { zone: "Z1", min: 95, max: 130 }, { zone: "Z2", min: 131, max: 145 },
  { zone: "Z3", min: 146, max: 160 }, { zone: "Z4", min: 161, max: 172 },
  { zone: "Z5", min: 173, max: 190 },
];
const runBase = {
  hrZones, tsb: 2, ctl: 50, atl: 48, acwr: 1.0, phase: "Build",
  wellness3d: { energy: 4, soreness: 2, sleep: 4 }, weeklyKm: 40, goal: "10K",
  daysSinceLastRun: 1, daysSinceLastHard: 3, durationNote: "~50 min", experience: "Intermediate",
};

Deno.test("brief system enforces the no-dashboard voice", () => {
  assert(/not a\s+dashboard/i.test(BRIEF_SYSTEM));
  assert(/interpret the signals/i.test(BRIEF_SYSTEM));
  assert(/1-2 sentences/i.test(BRIEF_SYSTEM));
});

Deno.test("buildBriefPrompt interprets signals, never dumps raw numbers as the ask", () => {
  const p = buildBriefPrompt({
    name: "Sam", readiness: 42, band: "amber", tsb: -12, tsbTrend: "falling",
    todayPlan: "Tempo run (run)", todayDone: false, phase: "Build", goal: "10K",
    weeklyLoadPct: 80,
  });
  assertStringIncludes(p, "Sam");
  assertStringIncludes(p, "Tempo run");
  // Freshness/readiness are framed as words, not bare metrics to read back.
  assertStringIncludes(p, "carrying fatigue");
  assertStringIncludes(p, "moderately recovered");
});

Deno.test("buildBriefPrompt flags when no objective recovery synced today", () => {
  const p = buildBriefPrompt({
    name: "Sam", readiness: 55, band: "amber", tsb: -4, tsbTrend: "flat",
    todayPlan: "Easy run (run)", todayDone: false, phase: "Base", goal: "10K",
    weeklyLoadPct: 60, objectiveData: false,
  });
  assert(/no hrv\/sleep synced/i.test(p));
  assert(/subjective feel|how they're feeling/i.test(p));
  // It must NOT frame readiness as a settled recovery verdict here.
  assert(!p.includes("moderately recovered"));
});

Deno.test("buildBriefPrompt weaves in debrief and missed-session signals only when present", () => {
  const base = {
    name: "Sam", readiness: 62, band: "amber", tsb: -6, tsbTrend: "flat" as const,
    todayPlan: "Easy run (run)", todayDone: false, phase: "Build", goal: "10K",
    weeklyLoadPct: 70,
  };
  const plain = buildBriefPrompt(base);
  assert(!plain.includes("yesterday's session actually went"));
  assert(!plain.includes("done and analyzed"));
  assert(!plain.includes("no recorded activity"));

  const rich = buildBriefPrompt({
    ...base,
    yesterdayDebrief: `ran the tempo hot: "went out too fast, second half drifted"`,
    todayDebrief: `solid: "held the target pace all the way"`,
    yesterdayMissed: true,
  });
  assertStringIncludes(rich, "How yesterday's session actually went (measured vs plan): ran the tempo hot");
  assertStringIncludes(rich, "Connect it to today's advice.");
  assertStringIncludes(rich, "Today's session is done and analyzed: solid");
  assertStringIncludes(rich, "no recorded activity. Don't scold");
  // Debrief lines carry the analyst's words, never numeric execution scores.
  assert(!/\d+\/100/.test(rich.split("SIGNALS")[1].split("Form\/freshness")[1] ?? ""));
});

// The training goal and the goal RACE are two facts. They shared one field, so
// the coach was told the athlete's goal was "Athens Marathon" and never heard
// about the muscle they also wanted to build. Both now, on separate lines.
Deno.test("buildBriefPrompt names the training goal and the goal race separately", () => {
  const p = buildBriefPrompt({
    name: "Sam", readiness: 62, band: "amber", tsb: -6, tsbTrend: "flat",
    todayPlan: "Easy run (run)", todayDone: false, phase: "Peak",
    goal: "Marathon pace + Build muscle",
    goalRace: "Athens Marathon on 2026-11-08, in 13 weeks",
    weeklyLoadPct: 70,
  });
  assertStringIncludes(p, "training goal: Marathon pace + Build muscle");
  assertStringIncludes(p, "Next goal event: Athens Marathon on 2026-11-08, in 13 weeks");
  // The brief is two sentences: the race is context, not its subject.
  assertStringIncludes(p, "Mention it only if today's session speaks to it");
});

Deno.test("buildBriefPrompt says nothing about an event the athlete does not have", () => {
  const p = buildBriefPrompt({
    name: "Sam", readiness: 62, band: "amber", tsb: -6, tsbTrend: "flat",
    todayPlan: "Easy run (run)", todayDone: false, phase: "Base",
    goal: "Build muscle", weeklyLoadPct: 70,
  });
  assertStringIncludes(p, "training goal: Build muscle");
  assert(!p.includes("Next goal event"));
});

Deno.test("brief system tells the coach to use recent execution when given", () => {
  assert(/how a recent session actually went/i.test(BRIEF_SYSTEM));
});

Deno.test("week review system enforces coach voice + a forward line", () => {
  assert(/2-4 sentences/i.test(WEEK_REVIEW_SYSTEM));
  assert(/forward-looking/i.test(WEEK_REVIEW_SYSTEM));
  assert(/never recite/i.test(WEEK_REVIEW_SYSTEM));
});

Deno.test("buildWeekReviewPrompt surfaces adherence, load trend, and the standout", () => {
  const p = buildWeekReviewPrompt({
    name: "Sam", sessions: 4, adherenceDone: 4, adherencePlanned: 5,
    tss: 320, targetTss: 350, loadDeltaPct: 12,
    bySport: [{ sport: "run", tss: 220 }, { sport: "strength", tss: 100 }],
    standout: { sport: "run", date: "2026-06-27", tss: 95 },
    phase: "Build", goal: "10K",
  });
  assertStringIncludes(p, "Sam");
  assertStringIncludes(p, "4/5");          // adherence
  assertStringIncludes(p, "+12% vs last week"); // load trend
  assertStringIncludes(p, "run on 2026-06-27"); // standout
});

// This recap had no ATHLETE PROFILE block, so onboarding.goal was the only goal
// it ever saw: a race name after any set_goal_race, and the athlete's real
// training goals never at all.
Deno.test("buildWeekReviewPrompt carries the training goal, and the event when there is one", () => {
  const base = {
    name: "Sam", sessions: 4, adherenceDone: 4, adherencePlanned: 5,
    tss: 320, targetTss: 350, loadDeltaPct: 12,
    bySport: [{ sport: "run", tss: 220 }],
    standout: null,
    phase: "Peak", goal: "Marathon pace + Build muscle",
  };
  const withRace = buildWeekReviewPrompt({
    ...base,
    goalRace: "Athens Marathon on 2026-11-08, in 13 weeks",
  });
  assertStringIncludes(withRace, "training goal: Marathon pace + Build muscle");
  assertStringIncludes(withRace, "Next goal event: Athens Marathon on 2026-11-08, in 13 weeks");

  const noRace = buildWeekReviewPrompt(base);
  assertStringIncludes(noRace, "training goal: Marathon pace + Build muscle");
  assert(!noRace.includes("Next goal event"));
});

Deno.test("cycling prompt programs power zones + cadence, not run phrasing", () => {
  const p = buildRunPrompt({ ...runBase, sport: "ride", ftp: 250 });
  assertStringIncludes(p, "CYCLING");
  assertStringIncludes(p, "FTP 250W");
  assert(/cadence/i.test(p));
  // %FTP translated to a concrete watt target (250 * 0.95 ≈ 238W).
  assertStringIncludes(p, "238W");
});

Deno.test("swim prompt programs metres, CSS, and a drill block", () => {
  const p = buildRunPrompt({ ...runBase, sport: "swim" });
  assertStringIncludes(p, "SWIMMING");
  assert(/CSS/i.test(p));
  assert(/drill/i.test(p));
  assert(/metres/i.test(p));
});

// ---------------------------------------------------------------------------
// Body composition in the strength prompt.
// ---------------------------------------------------------------------------

import { bodyLine, buildStrengthPrompt } from "./prompt.ts";

const strengthBase = {
  muscleGroupsLast48h: [],
  weeklySetsByMuscle: { Chest: 6 },
  equipment: "Full gym",
  experience: "Intermediate",
  goal: "Hybrid athlete",
  soreness: 2,
  phase: "Base",
  mainLifts: [],
  durationNote: "Aim for about 60 minutes.",
};

Deno.test("strength prompt renders the Body line with computed BMI when body data exists", () => {
  const p = buildStrengthPrompt({ ...strengthBase, body: { weightKg: 74, heightCm: 180, bodyFatPct: 15 } });
  assertStringIncludes(p, "- Body: 74 kg, 180 cm, BMI 22.8, ~15% body fat");
  assert(/bodyweight movements/i.test(p));
});

Deno.test("strength prompt omits the Body line entirely without body data", () => {
  const none = buildStrengthPrompt(strengthBase);
  assert(!none.includes("- Body:"));
  const empty = buildStrengthPrompt({ ...strengthBase, body: {} });
  assert(!empty.includes("- Body:"));
});

Deno.test("bodyLine renders partial data without BMI or blank segments", () => {
  assertEquals(bodyLine({ weightKg: 74 }), "74 kg");
  assertEquals(bodyLine({ bodyFatPct: 12.5 }), "~12.5% body fat");
  assertEquals(bodyLine(null), "");
});

Deno.test("strength prompt appends the body trend line when provided, omits when not", () => {
  const withTrend = buildStrengthPrompt({
    ...strengthBase,
    body: { weightKg: 74 },
    bodyTrend: "Body trend: weight 74.0 kg, down 0.3 kg per week. The trend matches their goal of losing fat.",
  });
  assertStringIncludes(withTrend, "down 0.3 kg per week");
  assertStringIncludes(withTrend, "steer the session's bias");
  const without = buildStrengthPrompt({ ...strengthBase, body: { weightKg: 74 } });
  assert(!without.includes("Body trend:"));
});

Deno.test("brief prompt renders the body trend as an extras line only when present", () => {
  const base = {
    name: "Sam", readiness: 70, band: "green", tsb: 2.0,
    tsbTrend: "flat" as const, todayPlan: "Easy run", todayDone: false,
    phase: "Base", goal: "10K", weeklyLoadPct: 40,
  };
  const withTrend = buildBriefPrompt({
    ...base,
    bodyTrend: "Body trend: lean mass 62.0 kg, up 0.2 kg per week. The trend matches their goal of building muscle.",
  });
  assertStringIncludes(withTrend, "lean mass 62.0 kg");
  assertStringIncludes(withTrend, "only when it earns a place");
  assert(!buildBriefPrompt(base).includes("Body trend:"));
});
