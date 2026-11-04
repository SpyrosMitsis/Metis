import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  activeBackoffs,
  addDays,
  backoffBlock,
  backoffForArea,
  backoffFromPain,
  clearBackoff,
  daysBetween,
  exerciseLoadsArea,
  followUpQuestion,
  FOLLOWUP_AFTER_DAYS,
  FOLLOWUP_REPEAT_DAYS,
  injuryFollowUpDue,
  markInjuryChecked,
  painCheckArea,
  parseBackoffs,
  sportsForArea,
  sportsToAvoid,
  stampRaisedAt,
  substituteSport,
  unresolvedInjuries,
  upsertBackoff,
} from "./injury.ts";
import type { InjuryEntry, Workout, WorkoutExercise } from "./types.ts";
import { muscleOf } from "./workout_review.ts";
import { validateWorkout } from "./workout_schema.ts";

const TODAY = "2026-08-01";

function injury(over: Partial<InjuryEntry> & { area: string }): InjuryEntry {
  return { severity: "", ...over };
}

const enduranceSection = {
  name: "Main",
  duration_minutes: 40,
  exercises: [{
    name: "Steady", sets: 1, reps: "40 min", weight_kg: null,
    pace_zone: "Z2", hr_zone: "Z2", rest_seconds: null, notes: "",
  }],
};

function mkWorkout(over: Record<string, unknown>): Workout {
  const v = validateWorkout({
    type: "run", title: "Session", duration_minutes: 40, tss_estimate: 40,
    rpe_target: 5, coach_note: "", sections: [enduranceSection], ...over,
  });
  assert(v.ok, `fixture failed to validate: ${v.error}`);
  return v.workout!;
}

const strengthWith = (...names: string[]) =>
  mkWorkout({
    type: "strength",
    sections: [{
      name: "Main",
      duration_minutes: 40,
      exercises: names.map((name) => ({
        name, sets: 3, reps: "8", weight_kg: 60,
        pace_zone: null, hr_zone: null, rest_seconds: 90, notes: "",
      })),
    }],
  });

// --- dates -------------------------------------------------------------------

Deno.test("daysBetween/addDays: whole days, and they round-trip", () => {
  assertEquals(daysBetween("2026-08-01", "2026-08-04"), 3);
  assertEquals(daysBetween("2026-08-04", "2026-08-01"), -3);
  assertEquals(addDays("2026-08-01", 7), "2026-08-08");
  assertEquals(addDays("2026-08-29", 7), "2026-09-05"); // month boundary
});

Deno.test("daysBetween: a DST boundary does not shorten the gap", () => {
  // EU clocks go back on 2026-10-25. Computed off midnight this reads 6.958
  // days and rounds to 7 only by luck; local noon makes it exact.
  assertEquals(daysBetween("2026-10-22", "2026-10-29"), 7);
  assertEquals(daysBetween("2026-03-26", "2026-03-30"), 4); // clocks forward
});

// --- follow-up ---------------------------------------------------------------

Deno.test("injuryFollowUpDue: nothing to ask about when there are no injuries", () => {
  assertEquals(injuryFollowUpDue([], TODAY), null);
});

Deno.test("injuryFollowUpDue: not due until FOLLOWUP_AFTER_DAYS have passed", () => {
  const raised = addDays(TODAY, -(FOLLOWUP_AFTER_DAYS - 1));
  assertEquals(injuryFollowUpDue([injury({ area: "Knee", raised_at: raised })], TODAY), null);
});

Deno.test("injuryFollowUpDue: due exactly on FOLLOWUP_AFTER_DAYS", () => {
  const raised = addDays(TODAY, -FOLLOWUP_AFTER_DAYS);
  const due = injuryFollowUpDue([injury({ area: "Knee", raised_at: raised })], TODAY);
  assertEquals(due?.area, "Knee");
});

Deno.test("injuryFollowUpDue: an injury with no dates at all is due immediately", () => {
  // The migration adds no columns, so every injury captured before this feature
  // has neither raised_at nor last_checked. Those are precisely the ones nobody
  // has ever revisited, so they must ask, not stay silent forever.
  const due = injuryFollowUpDue([injury({ area: "Shoulder" })], TODAY);
  assertEquals(due?.area, "Shoulder");
});

Deno.test("injuryFollowUpDue: after an answer it waits FOLLOWUP_REPEAT_DAYS, not FOLLOWUP_AFTER_DAYS", () => {
  const answered = injury({
    area: "Knee",
    raised_at: addDays(TODAY, -30),
    last_checked: addDays(TODAY, -FOLLOWUP_AFTER_DAYS),
    status: "present",
  });
  assertEquals(injuryFollowUpDue([answered], TODAY), null);

  const older = { ...answered, last_checked: addDays(TODAY, -FOLLOWUP_REPEAT_DAYS) };
  assertEquals(injuryFollowUpDue([older], TODAY)?.area, "Knee");
});

Deno.test("injuryFollowUpDue: resolved injuries are never asked about again", () => {
  const resolved = injury({ area: "Knee", raised_at: addDays(TODAY, -30), status: "resolved" });
  assertEquals(injuryFollowUpDue([resolved], TODAY), null);
});

Deno.test("injuryFollowUpDue: the freeform note entry (blank area) is never asked about", () => {
  // InjuryEditor stores "anything else" as an entry with area "". There is no
  // coherent question to ask about it, and asking one would be nonsense copy.
  assertEquals(injuryFollowUpDue([injury({ area: "", note: "only train mornings" })], TODAY), null);
  assertEquals(unresolvedInjuries([injury({ area: "" })]).length, 0);
});

Deno.test("injuryFollowUpDue: asks one at a time, oldest unanswered first", () => {
  const list = [
    injury({ area: "Knee", raised_at: addDays(TODAY, -5) }),
    injury({ area: "Shoulder", raised_at: addDays(TODAY, -20) }),
  ];
  assertEquals(injuryFollowUpDue(list, TODAY)?.area, "Shoulder");
});

Deno.test("injuryFollowUpDue: a never-asked injury outranks an old but answered one", () => {
  const list = [
    injury({ area: "Knee", raised_at: addDays(TODAY, -60), last_checked: addDays(TODAY, -30) }),
    injury({ area: "Shoulder" }),
  ];
  assertEquals(injuryFollowUpDue(list, TODAY)?.area, "Shoulder");
});

Deno.test("injuryFollowUpDue: a future raised_at (clock skew) does not fire", () => {
  assertEquals(injuryFollowUpDue([injury({ area: "Knee", raised_at: addDays(TODAY, 2) })], TODAY), null);
});

Deno.test("markInjuryChecked: 'present' records the answer and the date", () => {
  const out = markInjuryChecked([injury({ area: "Knee", raised_at: "2026-07-01" })], "knee", "present", TODAY);
  assertEquals(out[0].status, "present");
  assertEquals(out[0].last_checked, TODAY);
  assertEquals(out[0].raised_at, "2026-07-01", "raised_at must survive a follow-up");
});

Deno.test("markInjuryChecked: 'resolved' REMOVES the injury", () => {
  // Flagging it resolved but keeping it would leave injuriesText telling the
  // coach to train around a healed knee forever, which is the bug this loop
  // exists to end.
  const list = [injury({ area: "Knee" }), injury({ area: "Shoulder" })];
  const out = markInjuryChecked(list, "Knee", "resolved", TODAY);
  assertEquals(out.map((i) => i.area), ["Shoulder"]);
});

Deno.test("markInjuryChecked: area matching is case and whitespace insensitive", () => {
  const out = markInjuryChecked([injury({ area: "Lower back" })], "  LOWER BACK ", "better", TODAY);
  assertEquals(out[0].status, "better");
});

Deno.test("stampRaisedAt: fills only what is missing", () => {
  const out = stampRaisedAt(
    [injury({ area: "Knee" }), injury({ area: "Shoulder", raised_at: "2026-01-01" }), injury({ area: "" })],
    TODAY,
  );
  assertEquals(out[0].raised_at, TODAY);
  assertEquals(out[1].raised_at, "2026-01-01");
  assertEquals(out[2].raised_at, undefined, "the freeform note entry gets no date");
});

Deno.test("followUpQuestion: names the area and how long it has been", () => {
  const q = followUpQuestion(injury({ area: "Knee", raised_at: addDays(TODAY, -3) }), TODAY);
  assertEquals(q, "You mentioned your knee 3 days ago. How is it now?");
  assertEquals(
    followUpQuestion(injury({ area: "Achilles", raised_at: addDays(TODAY, -1) }), TODAY),
    "You mentioned your achilles yesterday. How is it now?",
  );
  assertEquals(followUpQuestion(injury({ area: "Shoulder" }), TODAY), "How is your shoulder doing?");
});

Deno.test("followUpQuestion: no em dashes in the copy the athlete reads", () => {
  const qs = [
    followUpQuestion(injury({ area: "Knee", raised_at: addDays(TODAY, -3) }), TODAY),
    followUpQuestion(injury({ area: "Knee" }), TODAY),
  ];
  for (const q of qs) assert(!/[—–]/.test(q), `follow-up copy contains a dash: ${q}`);
});

// --- involvement -------------------------------------------------------------

Deno.test("exerciseLoadsArea: matches by movement name", () => {
  assert(exerciseLoadsArea("Knee", "Barbell Back Squat", null));
  assert(exerciseLoadsArea("Lower back", "Deadlift", null));
  assert(exerciseLoadsArea("Achilles", "Standing Calf Raise", null));
});

Deno.test("exerciseLoadsArea: matches by catalog muscle when the name says nothing", () => {
  assert(exerciseLoadsArea("Knee", "Hack Machine Thing", "Quads"));
  assert(!exerciseLoadsArea("Knee", "Hack Machine Thing", "Chest"));
});

Deno.test("exerciseLoadsArea: an unrelated lift is not involved", () => {
  assertEquals(exerciseLoadsArea("Knee", "Barbell Bench Press", "Chest"), false);
  assertEquals(exerciseLoadsArea("Wrist", "Running", "Cardio"), false);
});

Deno.test("exerciseLoadsArea: an unknown area matches nothing rather than guessing", () => {
  assertEquals(exerciseLoadsArea("Jaw", "Barbell Back Squat", "Quads"), false);
  assertEquals(sportsForArea("Jaw"), []);
});

Deno.test("involvement is WIDER than the contraindication engine", () => {
  // workout_review's SAFETY_RULES forbid only the handful of movements that are
  // outright contraindicated for a knee (pistols, depth jumps). A plain squat is
  // safe to prescribe but absolutely loads the knee, so the pain check must see
  // it. If these two ever collapse into one list, the question stops being asked
  // after most sessions.
  assert(exerciseLoadsArea("Knee", "Barbell Back Squat", "Quads"));
});

Deno.test("sportsForArea: only endurance modalities, never strength", () => {
  assertEquals(sportsForArea("Knee").sort(), ["ride", "run"]);
  assertEquals(sportsForArea("Achilles"), ["run"]);
  assertEquals(sportsForArea("Shoulder"), ["swim"]);
  for (const area of ["Knee", "Shoulder", "Achilles", "Lower back"]) {
    assert(!(sportsForArea(area) as string[]).includes("strength"));
  }
});

Deno.test("painCheckArea: asks after a run when a run-loading injury is on file", () => {
  const area = painCheckArea([injury({ area: "Achilles" })], mkWorkout({ type: "run" }), muscleOf);
  assertEquals(area, "Achilles");
});

Deno.test("painCheckArea: stays quiet when the session cannot have touched it", () => {
  // A swim does not load an Achilles, so asking would be noise the athlete
  // learns to tap through.
  assertEquals(painCheckArea([injury({ area: "Achilles" })], mkWorkout({ type: "swim" }), muscleOf), null);
});

Deno.test("painCheckArea: rest days never ask", () => {
  assertEquals(painCheckArea([injury({ area: "Knee" })], mkWorkout({ type: "rest" }), muscleOf), null);
  assertEquals(painCheckArea([injury({ area: "Knee" })], null, muscleOf), null);
});

Deno.test("painCheckArea: strength asks only when a lift in the session loads the area", () => {
  const injuries = [injury({ area: "Knee" })];
  assertEquals(painCheckArea(injuries, strengthWith("Barbell Back Squat"), muscleOf), "Knee");
  assertEquals(painCheckArea(injuries, strengthWith("Barbell Bench Press"), muscleOf), null);
});

Deno.test("painCheckArea: resolved injuries are not asked about", () => {
  const injuries = [injury({ area: "Knee", status: "resolved" })];
  assertEquals(painCheckArea(injuries, strengthWith("Barbell Back Squat"), muscleOf), null);
});

Deno.test("painCheckArea: two involved injuries ask about the more serious one", () => {
  const injuries = [
    injury({ area: "Knee", severity: "mild" }),
    injury({ area: "Achilles", severity: "serious" }),
  ];
  assertEquals(painCheckArea(injuries, mkWorkout({ type: "run" }), muscleOf), "Achilles");
});

// --- backoff -----------------------------------------------------------------

Deno.test("parseBackoffs: drops anything malformed instead of throwing", () => {
  const raw = [
    { area: "Knee", level: "ease", until: "2026-08-08" },
    { area: "", level: "ease", until: "2026-08-08" }, // no area
    { area: "Knee", level: "stop", until: "2026-08-08" }, // not a level
    { area: "Knee", level: "ease", until: "soon" }, // not a date
    null,
    "nonsense",
  ];
  assertEquals(parseBackoffs(raw).length, 1);
  assertEquals(parseBackoffs(null), []);
  assertEquals(parseBackoffs({ area: "Knee" }), []);
});

Deno.test("activeBackoffs: inclusive end date, and self-expiring the day after", () => {
  const raw = [{ area: "Knee", level: "ease", until: TODAY }];
  assertEquals(activeBackoffs(raw, TODAY).length, 1, "the last day is still covered");
  assertEquals(activeBackoffs(raw, addDays(TODAY, 1)).length, 0, "expires with no cleanup job");
});

Deno.test("backoffFromPain: 1 of 5 clears, it does not create a backoff", () => {
  const out = backoffFromPain("Knee", 1, TODAY);
  assertEquals(out.backoff, null);
  assertEquals(out.clear, true);
  assertEquals(out.severe, false);
});

Deno.test("backoffFromPain: 2 of 5 changes nothing, one twinge is not a trend", () => {
  const out = backoffFromPain("Knee", 2, TODAY);
  assertEquals(out.backoff, null);
  assertEquals(out.clear, false);
});

Deno.test("backoffFromPain: 3 of 5 eases for a week", () => {
  const out = backoffFromPain("Knee", 3, TODAY);
  assertEquals(out.backoff?.level, "ease");
  assertEquals(out.backoff?.until, addDays(TODAY, 7));
  assertEquals(out.backoff?.set_at, TODAY);
  assertEquals(out.severe, false);
});

Deno.test("backoffFromPain: 4 of 5 avoids for a week", () => {
  const out = backoffFromPain("Knee", 4, TODAY);
  assertEquals(out.backoff?.level, "avoid");
  assertEquals(out.backoff?.until, addDays(TODAY, 7));
  assertEquals(out.severe, false);
});

Deno.test("backoffFromPain: 5 of 5 avoids for two weeks and flags severe", () => {
  const out = backoffFromPain("Knee", 5, TODAY);
  assertEquals(out.backoff?.level, "avoid");
  assertEquals(out.backoff?.until, addDays(TODAY, 14));
  assertEquals(out.severe, true);
});

Deno.test("backoffFromPain: carries the reason, capped", () => {
  const out = backoffFromPain("Knee", 4, TODAY, "x".repeat(500));
  assertEquals(out.backoff?.reason?.length, 200);
});

Deno.test("backoffFromPain: junk input is inert", () => {
  assertEquals(backoffFromPain("", 5, TODAY).backoff, null);
  assertEquals(backoffFromPain("Knee", 0, TODAY).backoff, null);
  assertEquals(backoffFromPain("Knee", Number.NaN, TODAY).backoff, null);
});

Deno.test("upsertBackoff: one per area, the new one wins", () => {
  const first = backoffFromPain("Knee", 3, TODAY).backoff!;
  const second = backoffFromPain("knee", 5, TODAY).backoff!;
  const out = upsertBackoff(upsertBackoff([], first), second);
  assertEquals(out.length, 1);
  assertEquals(out[0].level, "avoid");
});

Deno.test("clearBackoff: by area, or all of them", () => {
  const list = [
    { area: "Knee", level: "ease", until: "2026-09-01" },
    { area: "Shoulder", level: "avoid", until: "2026-09-01" },
  ] as const;
  assertEquals(clearBackoff([...list], "knee").map((b) => b.area), ["Shoulder"]);
  assertEquals(clearBackoff([...list]).length, 0);
});

Deno.test("backoffForArea: avoid outranks ease when both are somehow on file", () => {
  const list = [
    { area: "Knee", level: "ease" as const, until: "2026-09-30" },
    { area: "Knee", level: "avoid" as const, until: "2026-08-10" },
  ];
  assertEquals(backoffForArea(list, "Knee")?.level, "avoid");
  assertEquals(backoffForArea(list, "Shoulder"), null);
});

Deno.test("sportsToAvoid: only 'avoid' bans a sport, 'ease' does not", () => {
  const avoid = sportsToAvoid([{ area: "Achilles", level: "avoid", until: "2026-09-01" }]);
  assertEquals([...avoid], ["run"]);
  const ease = sportsToAvoid([{ area: "Achilles", level: "ease", until: "2026-09-01" }]);
  assertEquals(ease.size, 0, "easing off means train it lighter, not stop the sport");
});

Deno.test("sportsToAvoid: an unknown area bans nothing", () => {
  assertEquals(sportsToAvoid([{ area: "Jaw", level: "avoid", until: "2026-09-01" }]).size, 0);
});

Deno.test("substituteSport: an unaffected sport is left alone", () => {
  const avoid = new Set(["run"] as const);
  assertEquals(substituteSport("ride", ["run", "ride"], avoid), { type: "ride", swappedFrom: null });
  assertEquals(substituteSport("strength", ["run", "strength"], avoid).type, "strength");
});

Deno.test("substituteSport: an avoided sport becomes another one the athlete does", () => {
  const out = substituteSport("run", ["run", "swim"], new Set(["run"] as const));
  assertEquals(out, { type: "swim", swappedFrom: "run" });
});

Deno.test("substituteSport: falls back to strength when no endurance option is left", () => {
  // Strength is never banned wholesale: reviewWorkout strips the lifts that
  // load the area and keeps the rest of the session.
  const out = substituteSport("run", ["run", "strength"], new Set(["run", "ride", "swim"] as const));
  assertEquals(out, { type: "strength", swappedFrom: "run" });
});

Deno.test("substituteSport: rest only when there is genuinely nothing else", () => {
  const out = substituteSport("run", ["run"], new Set(["run"] as const));
  assertEquals(out, { type: "rest", swappedFrom: "run" });
});

Deno.test("substituteSport: an empty sports list means no restriction, so any sport is fair game", () => {
  const out = substituteSport("run", [], new Set(["run"] as const));
  assertEquals(out, { type: "ride", swappedFrom: "run" });
});

Deno.test("backoffBlock: empty when there is nothing in force", () => {
  assertEquals(backoffBlock([]), "");
});

Deno.test("backoffBlock: states the area, the date and the instruction", () => {
  const block = backoffBlock([
    { area: "Knee", level: "avoid", until: "2026-08-08", reason: "pain 4 of 5 after a run" },
  ]);
  assert(block.includes("Knee"));
  assert(block.includes("2026-08-08"));
  assert(block.includes("Avoid movements loading this area"));
  assert(block.includes("pain 4 of 5 after a run"));
});

Deno.test("backoffBlock: no em dashes, it reaches the athlete through the coach note", () => {
  const block = backoffBlock([
    { area: "Knee", level: "avoid", until: "2026-08-08", reason: "pain" },
    { area: "Shoulder", level: "ease", until: "2026-08-05" },
  ]);
  assert(!/[—–]/.test(block), "backoffBlock contains a dash");
});

// --- the loop, end to end (pure) ---------------------------------------------

Deno.test("the whole loop: raise, ask, hurt, back off, recover, clear", () => {
  // 1. The athlete adds a knee on day 0. Nothing to ask yet.
  let injuries = stampRaisedAt([injury({ area: "Knee", severity: "moderate" })], "2026-08-01");
  let backoffs = parseBackoffs([]);
  assertEquals(injuryFollowUpDue(injuries, "2026-08-02"), null);

  // 2. Three days later the follow-up is due, and they say it is still there.
  assertEquals(injuryFollowUpDue(injuries, "2026-08-04")?.area, "Knee");
  injuries = markInjuryChecked(injuries, "Knee", "present", "2026-08-04");
  assertEquals(injuryFollowUpDue(injuries, "2026-08-05"), null, "answering quiets it");

  // 3. They squat on the 5th; the session loaded the knee, so we ask, and it hurt.
  assertEquals(painCheckArea(injuries, strengthWith("Barbell Back Squat"), muscleOf), "Knee");
  const hurt = backoffFromPain("Knee", 4, "2026-08-05", "sore squatting");
  backoffs = upsertBackoff(backoffs, hurt.backoff!);

  // 4. That is now a hard constraint on generation, with an end date.
  assertEquals(activeBackoffs(backoffs, "2026-08-06").length, 1);
  assertEquals([...sportsToAvoid(activeBackoffs(backoffs, "2026-08-06"))], []); // Squat pain is not evidence that running or cycling hurts.
  assert(backoffBlock(activeBackoffs(backoffs, "2026-08-06")).includes("Knee"));

  // 5. It expires by itself a week later. Nothing had to delete it.
  assertEquals(activeBackoffs(backoffs, "2026-08-12").length, 1, "the last day is still covered");
  assertEquals(activeBackoffs(backoffs, "2026-08-13").length, 0, "gone the next morning");

  // 6. The weekly follow-up comes round and they say it is gone: the injury
  //    leaves the profile, so nothing is programmed around it any more.
  assertEquals(injuryFollowUpDue(injuries, "2026-08-11")?.area, "Knee");
  injuries = markInjuryChecked(injuries, "Knee", "resolved", "2026-08-11");
  assertEquals(injuries.length, 0);
  assertEquals(injuryFollowUpDue(injuries, "2026-09-01"), null);
});

// muscleOf is imported from the review engine on purpose: the pain check and the
// safety strip must agree on what muscle a lift trains, or a session can be
// stripped for an area the athlete was never asked about.
Deno.test("painCheckArea uses the review engine's own muscle lookup", () => {
  const ex: WorkoutExercise = {
    name: "Leg Press", sets: 3, reps: "10", weight_kg: 100,
    pace_zone: null, hr_zone: null, rest_seconds: 90, notes: "",
  };
  assertEquals(muscleOf(ex), "Quads");
  assert(exerciseLoadsArea("Knee", ex.name, muscleOf(ex)));
});

Deno.test("explicit movement-only backoff does not ban pain-free sports", () => {
  const b = { area: "Lower back", level: "avoid" as const, until: "2026-11-07", sports: [] };
  assertEquals([...sportsToAvoid([b])], []);
  assert(exerciseLoadsArea(b.area, "Barbell Deadlift", "Back"));
  assertEquals([...sportsToAvoid([{ ...b, sports: ["ride"] }])], ["ride"]);
  assert(backoffBlock([b]).includes("Restricted sports: none"));
});
