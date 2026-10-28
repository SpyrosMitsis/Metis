import { assert, assertEquals } from "jsr:@std/assert@1";
import { matchDemand } from "./feasibility.ts";
import {
  dateError,
  executeTool,
  goalTextFor,
  matchesGoal,
  nativeToolDefs,
  TOOL_CATALOG,
  toolCatalogPrompt,
} from "./coach_tools.ts";
// deno-lint-ignore no-explicit-any
type Any = any;

// Minimal PostgREST query-builder stub: every method chains, and the chain
// resolves (awaited or .single()) to the canned `data` for that table.
function adminStub(byTable: Record<string, unknown>): Any {
  const chainFor = (data: unknown): Any => {
    const c: Any = {};
    for (const m of ["select", "eq", "gte", "lte", "in", "not", "order", "limit"]) c[m] = () => c;
    c.single = () => Promise.resolve({ data: Array.isArray(data) ? data[0] : data });
    c.then = (res: Any, rej: Any) => Promise.resolve({ data }).then(res, rej);
    return c;
  };
  return { from: (t: string) => chainFor(byTable[t] ?? []) };
}

Deno.test("coach tools: set_rest_day + make_easier are registered as act tools", () => {
  const byName = (n: string) => TOOL_CATALOG.find((t) => t.name === n);
  const rest = byName("set_rest_day");
  const easier = byName("make_easier");
  assert(rest, "set_rest_day missing");
  assert(easier, "make_easier missing");
  assertEquals(rest!.kind, "act");
  assertEquals(easier!.kind, "act");
  // set_rest_day requires a date; make_easier's date is optional.
  assertEquals((rest!.schema as { required?: string[] }).required, ["date"]);
  assert(!(easier!.schema as { required?: string[] }).required);
});

Deno.test("coach tools: new tools are advertised to the model", () => {
  const native = nativeToolDefs().map((t) => t.name);
  assert(native.includes("set_rest_day"));
  assert(native.includes("make_easier"));
  const prompt = toolCatalogPrompt();
  assert(prompt.includes("set_rest_day"));
  assert(prompt.includes("make_easier"));
});

Deno.test("executeTool get_fitness: leads with an interpreted word, keeps the raw figures", async () => {
  const admin = adminStub({
    effective_activities: [
      { date: "2026-06-29", tss: 50, ctl: 42, atl: 50 },
      { date: "2026-06-22", tss: 60, ctl: 41, atl: 48 },
    ],
  });
  const obs = JSON.parse(await executeTool(admin, "u1", "auth", "get_fitness", {}));
  // Plain-language interpretation is present so the coach doesn't recite numbers.
  assert(typeof obs.freshness === "string" && obs.freshness.length > 0);
  // Raw figures still come through for the model's own reasoning, but nested
  // under `raw` so the payload's SURFACE is prose. A model that lazily echoes
  // the top level now echoes a word. This replaced a prose "note: interpret
  // this in plain words" field, which was one of five copies of that rule and
  // asked the model to do what the structure can just make true.
  assertEquals(obs.raw.ctl, 42);
  assertEquals(obs.raw.tsb, -8);
  assertEquals(obs.note, undefined);
  for (const k of Object.keys(obs)) {
    if (k === "raw") continue;
    assert(typeof obs[k] !== "number", `top-level ${k} should not be a bare number`);
  }
});

// ---------------------------------------------------------------------------
// update_app_settings: the safe-subset whitelist that lets chat change device
// settings. Everything not whitelisted must bounce, values must normalize to
// strings the app can parse, and update_profile's new body fields must bound.
// ---------------------------------------------------------------------------

import { validateAppSettings } from "./coach_tools.ts";

Deno.test("validateAppSettings: valid values normalize to string pairs", () => {
  const { changes, rejected } = validateAppSettings({
    theme: "Dark",
    units: "lb",
    rest_timer_seconds: 90.4,
    keep_screen_on: false,
  });
  assertEquals(rejected, []);
  assertEquals(changes, [
    { key: "theme", value: "dark" },
    { key: "units", value: "lb" },
    { key: "rest_timer_seconds", value: "90" },
    { key: "keep_screen_on", value: "false" },
  ]);
});

Deno.test("validateAppSettings: non-whitelisted keys are rejected, never passed through", () => {
  const { changes, rejected } = validateAppSettings({
    api_key: "sk-evil",
    delete_account: true,
    theme: "light",
  });
  assertEquals(changes, [{ key: "theme", value: "light" }]);
  assertEquals(rejected.length, 2);
  assert(rejected.some((r) => r.startsWith("api_key")));
});

Deno.test("validateAppSettings: out-of-range and wrong-typed values bounce", () => {
  const { changes, rejected } = validateAppSettings({
    theme: "neon",
    rest_timer_seconds: 5000,
    morning_notification: "yes",
  });
  assertEquals(changes, []);
  assertEquals(rejected.length, 3);
});

Deno.test("update_app_settings is advertised but not executable outside chat", async () => {
  assert(nativeToolDefs().some((t) => t.name === "update_app_settings"));
  assert(toolCatalogPrompt().includes("update_app_settings"));
  const obs = await executeTool(adminStub({}), "u1", "auth", "update_app_settings", { theme: "dark" });
  assert(obs.startsWith("error:"));
});

Deno.test("update_profile: body fields save in range, bounce out of range", async () => {
  const updates: Record<string, unknown>[] = [];
  const admin: Any = {
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { onboarding: {} } }) }) }),
      update: (u: Record<string, unknown>) => {
        updates.push(u);
        return { eq: () => Promise.resolve({}) };
      },
    }),
  };
  const ok = JSON.parse(await executeTool(admin, "u1", "auth", "update_profile", {
    weight_kg: 74.4, height_cm: 180, body_fat_pct: 15.25, session_duration: 75,
  }));
  assertEquals(ok.saved, { weight_kg: 74, height_cm: 180, body_fat_pct: 15.3, session_duration: 75 });
  const bad = await executeTool(admin, "u1", "auth", "update_profile", { weight_kg: 900 });
  assert(bad.startsWith("error:"));
});

Deno.test("update_profile: display_name saves into onboarding AND mirrors the column", async () => {
  const updates: Record<string, unknown>[] = [];
  const admin: Any = {
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { onboarding: { goal: "10K" } } }) }) }),
      update: (u: Record<string, unknown>) => {
        updates.push(u);
        return { eq: () => Promise.resolve({}) };
      },
    }),
  };
  const ok = JSON.parse(await executeTool(admin, "u1", "auth", "update_profile", {
    display_name: "  Gianluca  ", sex: "male", birth_year: 1992,
  }));
  assertEquals(ok.saved.display_name, "Gianluca");
  assertEquals(updates[0].display_name, "Gianluca"); // top-level column mirror
  const onboarding = updates[0].onboarding as Record<string, unknown>;
  assertEquals(onboarding.display_name, "Gianluca");
  assertEquals(onboarding.goal, "10K"); // existing fields preserved
  assertEquals(onboarding.sex, "male");
  assertEquals(onboarding.birth_year, 1992);

  const bad = await executeTool(admin, "u1", "auth", "update_profile", { display_name: "   ", sex: "yes" });
  assert(bad.startsWith("error:"));
});

Deno.test("remember: appends a new fact, skips an exact duplicate", async () => {
  const updates: Record<string, unknown>[] = [];
  let knowledge = "- dislikes burpees";
  const admin: Any = {
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { coach_knowledge: knowledge } }) }) }),
      update: (u: Record<string, unknown>) => {
        updates.push(u);
        knowledge = u.coach_knowledge as string;
        return { eq: () => Promise.resolve({}) };
      },
    }),
  };
  const first = JSON.parse(await executeTool(admin, "u1", "auth", "remember", { fact: "left knee niggle" }));
  assertEquals(first.ok, true);
  assertEquals(knowledge, "- dislikes burpees\n- left knee niggle");

  // Same fact again (even different case/whitespace) must not duplicate the line.
  const dupe = JSON.parse(await executeTool(admin, "u1", "auth", "remember", { fact: "  Left Knee Niggle  " }));
  assertEquals(dupe.duplicate, true);
  assertEquals(updates.length, 1); // no second write
  assertEquals(knowledge, "- dislikes burpees\n- left knee niggle");
});

// ---------------------------------------------------------------------------
// set_training_pause / resume_training: a stated "stop training until X" must
// get real structural effect (see plan-week's dayList.available), not just a
// remember() line the planner has no obligation to notice.
// ---------------------------------------------------------------------------

function withFetchStub<T>(stub: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: URL | Request | string) =>
    Promise.resolve(stub(String(input instanceof Request ? input.url : input)))) as typeof fetch;
  return fn().finally(() => { globalThis.fetch = orig; });
}

Deno.test("coach tools: set_training_pause + resume_training are registered as act tools", () => {
  const byName = (n: string) => TOOL_CATALOG.find((t) => t.name === n);
  const pause = byName("set_training_pause");
  const resume = byName("resume_training");
  assert(pause, "set_training_pause missing");
  assert(resume, "resume_training missing");
  assertEquals(pause!.kind, "act");
  assertEquals((pause!.schema as { required?: string[] }).required, ["until_date"]);
  const native = nativeToolDefs().map((t) => t.name);
  assert(native.includes("set_training_pause"));
  assert(native.includes("resume_training"));
  assert(toolCatalogPrompt().includes("set_training_pause"));
});

Deno.test("set_training_pause: writes the pause window and clears upcoming unlocked sessions", async () => {
  const profileUpdates: Record<string, unknown>[] = [];
  const deletedIds: string[] = [];
  const admin: Any = {
    from: (table: string) => {
      if (table === "user_profiles") {
        return {
          update: (u: Record<string, unknown>) => {
            profileUpdates.push(u);
            return { eq: () => Promise.resolve({}) };
          },
        };
      }
      // reconciled_session_plans: chain of eq/gte/lte/neq, resolves to two clearable rows.
      const rows = [{ id: "w1", type: "run" }, { id: "w2", type: "strength" }];
      const chain: Any = {};
      for (const m of ["select", "eq", "gte", "lte", "neq"]) chain[m] = () => chain;
      chain.then = (res: Any) => Promise.resolve({ data: rows }).then(res);
      return chain;
    },
  };
  const farFuture = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const out = await withFetchStub(
    (url) => {
      assert(url.includes("delete-workout"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    () =>
      executeTool(admin, "u1", "auth", "set_training_pause", {
        until_date: farFuture,
        reason: "travel to Italy",
      }),
  );
  const obs = JSON.parse(out);
  assertEquals(obs.ok, true);
  assertEquals(obs.until_date, farFuture);
  assertEquals(obs.cleared, 2);
  assertEquals(profileUpdates[0].training_paused_until, farFuture);
  assertEquals(profileUpdates[0].training_pause_reason, "travel to Italy");
});

Deno.test("set_training_pause: rejects a past until_date without writing anything", async () => {
  const admin: Any = { from: () => ({ update: () => ({ eq: () => Promise.resolve({}) }) }) };
  const out = await executeTool(admin, "u1", "auth", "set_training_pause", { until_date: "2020-01-01" });
  assert(out.startsWith("error:"));
});

Deno.test("resume_training: nulls both pause columns", async () => {
  const updates: Record<string, unknown>[] = [];
  const admin: Any = {
    from: () => ({
      update: (u: Record<string, unknown>) => { updates.push(u); return { eq: () => Promise.resolve({}) }; },
    }),
  };
  const obs = JSON.parse(await executeTool(admin, "u1", "auth", "resume_training", {}));
  assertEquals(obs.ok, true);
  assertEquals(updates[0], { training_paused_until: null, training_pause_reason: null });
});

// ---------------------------------------------------------------------------
// set_goal_race + assess_goal.
//
// THE BUG: set_goal_race only ever wrote user_profiles.onboarding.goal, which
// Home reads. Settings > Goals and races reads the `races` table, so a goal set
// through chat showed on Home while the races table stayed empty. Adding a race
// by hand does BOTH halves (addRace + setGoalRace); the coach now does too.
// ---------------------------------------------------------------------------

/** Stub that also records what was written, per table. */
function writeStub(byTable: Record<string, unknown>) {
  const writes: Array<{ table: string; op: string; row: Any }> = [];
  const chainFor = (table: string, data: unknown): Any => {
    const c: Any = {};
    for (const m of ["select", "eq", "neq", "gte", "lte", "not", "order", "limit"]) c[m] = () => c;
    // Captured, not ignored: a delete is only correct if it names the right
    // ids, and .in() is where they are.
    c.in = (_col: string, ids: Any) => { c._in = ids; return c; };
    c.single = () => Promise.resolve({ data: Array.isArray(data) ? data[0] : data });
    c.maybeSingle = () => Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data });
    c.insert = (row: Any) => { writes.push({ table, op: "insert", row }); return c; };
    c.update = (row: Any) => { writes.push({ table, op: "update", row }); return c; };
    c.delete = () => {
      const w = { table, op: "delete", row: c };
      writes.push(w);
      return c;
    };
    c.then = (res: Any, rej: Any) => Promise.resolve({ data }).then(res, rej);
    return c;
  };
  return {
    admin: { from: (t: string) => chainFor(t, byTable[t] ?? []) } as Any,
    writes,
    of: (table: string) => writes.filter((w) => w.table === table),
  };
}

const FIT_ATHLETE = {
  // The training goal is set, so every goal tool can be checked for leaving it
  // alone. It is a different fact from the goal RACE and lives in a different
  // place; the two sharing onboarding.goal is the bug this fixture guards.
  user_profiles: [{
    onboarding: {
      experience: "intermediate",
      goal: "Marathon pace + Build muscle",
      goals: ["Marathon pace", "Build muscle"],
    },
  }],
  effective_activities: Array.from({ length: 16 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    distance_m: 14_000,
    duration_seconds: 4200,
    ctl: 55,
  })),
  races: [],
};

Deno.test("set_goal_race writes the races row Settings reads, not just the profile", async () => {
  const s = writeStub(FIT_ATHLETE);
  const obs = JSON.parse(await executeTool(s.admin, "u1", "auth", "set_goal_race", {
    name: "Athens Marathon", date: "2027-11-14", sport: "run",
    distance: "Marathon", priority: "A", target: "sub 4:00",
  }));

  const race = s.of("races").find((w) => w.op === "insert");
  assert(race, "the races table must be written, this is the reported bug");
  assertEquals(race!.row.name, "Athens Marathon");
  assertEquals(race!.row.date, "2027-11-14");
  assertEquals(race!.row.sport, "run");
  assertEquals(race!.row.distance, "Marathon");
  assertEquals(race!.row.priority, "A");
  assertEquals(race!.row.target, "sub 4:00");
  assertEquals(race!.row.user_id, "u1");

  // And the periodization anchor is still set: a DATE pointing at that row.
  const prof = s.of("user_profiles").find((w) => w.op === "update");
  assert(prof, "an A goal must still anchor periodization");
  assertEquals((prof!.row.onboarding as Any).goal_date, "2027-11-14");
  // The regression this whole split exists to stop: the event name used to be
  // copied over the athlete's training goal, and every coach prompt read it
  // back as if it were the goal.
  assertEquals((prof!.row.onboarding as Any).goal, "Marathon pace + Build muscle");

  assertEquals(obs.saved_to_goals_and_races, true);
  assertEquals(obs.anchors_periodization, true);
});

Deno.test("a B-priority tune-up is saved but does not steal the periodization anchor", async () => {
  const s = writeStub(FIT_ATHLETE);
  const obs = JSON.parse(await executeTool(s.admin, "u1", "auth", "set_goal_race", {
    name: "Local 10K", date: "2026-09-05", distance: "10K", priority: "B",
  }));
  assert(s.of("races").some((w) => w.op === "insert"), "B races are still saved");
  assertEquals(s.of("user_profiles").filter((w) => w.op === "update").length, 0);
  assertEquals(obs.anchors_periodization, false);
  // Exactly one row: the tune-up. A B goal used to also backfill a race named
  // after onboarding.goal, which now holds the training goal, so that would
  // have created a race called "Marathon pace + Build muscle".
  assertEquals(s.of("races").filter((w) => w.op === "insert").length, 1);
});

Deno.test("re-saving the same event updates it instead of duplicating", async () => {
  const s = writeStub({ ...FIT_ATHLETE, races: [{ id: "r1" }] });
  await executeTool(s.admin, "u1", "auth", "set_goal_race", {
    name: "Athens Marathon", date: "2027-11-14", distance: "Marathon", priority: "B",
  });
  assertEquals(s.of("races").filter((w) => w.op === "insert").length, 0);
  assertEquals(s.of("races").filter((w) => w.op === "update").length, 1);
});

Deno.test("set_goal_race rejects a malformed date rather than writing junk", async () => {
  const s = writeStub(FIT_ATHLETE);
  const obs = await executeTool(s.admin, "u1", "auth", "set_goal_race", {
    name: "Some race", date: "next November",
  });
  assert(obs.startsWith("error:"), obs);
  assertEquals(s.writes.length, 0, "nothing should be written on a bad date");
});

Deno.test("saving a goal returns the feasibility verdict with it", async () => {
  const s = writeStub({
    user_profiles: [{ onboarding: {} }],
    effective_activities: [{ date: "2026-07-20", distance_m: 5_000, duration_seconds: 1800, ctl: 8 }],
    races: [],
  });
  // ~1.25km/week, longest 5km, and an Ironman six weeks out.
  const obs = JSON.parse(await executeTool(s.admin, "u1", "auth", "set_goal_race", {
    name: "Ironman Barcelona", date: iso6WeeksOut(), distance: "Ironman",
  }));
  assertEquals(obs.feasibility.verdict, "unrealistic");
  assertEquals(obs.feasibility.push_back, true);
  assert(obs.feasibility.suggestion, "must offer an alternative, not just refuse");
  // The goal is still saved: the athlete asked for it, the coach argues in prose.
  assertEquals(obs.saved_to_goals_and_races, true);
});

Deno.test("assess_goal judges without writing anything", async () => {
  const s = writeStub(FIT_ATHLETE);
  const obs = JSON.parse(await executeTool(s.admin, "u1", "auth", "assess_goal", {
    goal: "marathon", date: iso6WeeksOut(),
  }));
  assertEquals(s.writes.length, 0, "assess_goal is a read tool");
  assertEquals(obs.push_back, true);
  assert(Array.isArray(obs.evidence) && obs.evidence.length > 0);
});

Deno.test("both goal tools are advertised to the model", () => {
  const native = nativeToolDefs().map((t) => t.name);
  assert(native.includes("assess_goal"));
  assert(native.includes("set_goal_race"));
  const setter = TOOL_CATALOG.find((t) => t.name === "set_goal_race")!;
  // Distance drives the feasibility match, so the model must be told to send it.
  assert(Object.keys((setter.schema as Any).properties).includes("distance"));
  assert(/feasibility/i.test(setter.description));
});

function iso6WeeksOut(): string {
  return new Date(Date.now() + 42 * 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// remove_goal_race.
//
// THE BUG: there was no removal tool at all. Asked to "remove the Ironman", the
// coach confirmed it had, because confirming is all it could do. onboarding.goal
// still said Ironman, so Home kept showing it and it reappeared as soon as
// anything refreshed, even after another goal was added.
// ---------------------------------------------------------------------------

const IRONMAN = { id: "r1", name: "Ironman Barcelona", date: "2027-10-03", priority: "A" };
const MARATHON = { id: "r2", name: "February Marathon", date: "2027-02-14", priority: "B" };

/** Athlete whose anchor points at the Ironman, with a training goal of their own. */
function withIronman(races = [IRONMAN, MARATHON]) {
  return writeStub({
    user_profiles: [{ onboarding: { goal: "Marathon pace", goal_date: IRONMAN.date } }],
    races,
    effective_activities: [],
  });
}

Deno.test("remove_goal_race deletes the race AND clears the anchor date", async () => {
  const s = withIronman();
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "remove_goal_race", { name: "Ironman" }),
  );

  const del = s.of("races").find((w) => w.op === "delete");
  assert(del, "the races row must actually be deleted");
  assertEquals((del!.row as Any)._in, ["r1"], "only the Ironman, not the marathon");

  // The half that was missing: without this the goal comes straight back.
  const prof = s.of("user_profiles").find((w) => w.op === "update");
  assert(prof, "the periodization anchor must be cleared too");
  assertEquals((prof!.row.onboarding as Any).goal_date, null);
  // And the athlete's training goal is not collateral damage: removing a race
  // used to null this field, so the coach lost the goal along with the event.
  assertEquals((prof!.row.onboarding as Any).goal, "Marathon pace");

  assertEquals(obs.removed_count, 1);
  assertEquals(obs.cleared_from_home, true);
});

Deno.test("removing the anchor promotes the next A goal rather than leaving none", async () => {
  const nextA = { id: "r3", name: "Autumn Marathon", date: iso6WeeksOut(), priority: "A" };
  const s = withIronman([IRONMAN, MARATHON, nextA]);
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "remove_goal_race", { name: "Ironman" }),
  );
  // Phase, taper and weeks-to-goal all read the anchor; an empty one quietly
  // flattens the plan. The B-priority marathon must NOT be promoted.
  assertEquals(obs.new_goal_anchor?.name, "Autumn Marathon");
  const prof = s.of("user_profiles").find((w) => w.op === "update");
  assertEquals((prof!.row.onboarding as Any).goal_date, nextA.date);
  // The name is reported to the coach so it can say what took over, but only
  // the date is persisted. onboarding.goal is not this tool's to write.
  assertEquals((prof!.row.onboarding as Any).goal, "Marathon pace");
});

Deno.test("a dangling anchor is cleared when the athlete names its date", async () => {
  // A goal_date left pointing at nothing, from before the anchor became a
  // pointer into `races`. There is no row to delete, so clearing the date is
  // the whole job, and it must still happen or the phase keeps counting down
  // to a goal that does not exist.
  const s = writeStub({
    user_profiles: [{ onboarding: { goal: "Marathon pace", goal_date: "2027-10-03" } }],
    races: [],
    effective_activities: [],
  });
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "remove_goal_race", { date: "2027-10-03" }),
  );
  assertEquals(obs.removed_count, 0);
  assertEquals(obs.cleared_from_home, true, "the anchor is the only thing left, and it must go");
  const prof = s.of("user_profiles").find((w) => w.op === "update");
  assertEquals((prof!.row.onboarding as Any).goal_date, null);
});

Deno.test("removing an unrelated race never moves the anchor", async () => {
  // Same dangling anchor, but the athlete asked for a different race. Matching
  // loosely here would silently repoint their periodization.
  const s = writeStub({
    user_profiles: [{ onboarding: { goal: "Marathon pace", goal_date: "2027-10-03" } }],
    races: [MARATHON],
    effective_activities: [],
  });
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "remove_goal_race", { name: "February Marathon" }),
  );
  assertEquals(obs.removed_count, 1);
  assertEquals(obs.cleared_from_home, false);
  assertEquals(s.of("user_profiles").filter((w) => w.op === "update").length, 0);
});

Deno.test("removing something that does not exist says so instead of confirming", async () => {
  const s = withIronman();
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "remove_goal_race", { name: "Berlin" }),
  );
  assertEquals(obs.removed_count, 0);
  assertEquals(obs.cleared_from_home, false);
  assert(/nothing matched/i.test(obs.note ?? ""), "the coach must be able to tell it failed");
  assertEquals(s.of("races").filter((w) => w.op === "delete").length, 0);
});

Deno.test("remove_goal_race needs something to match on", async () => {
  const s = withIronman();
  const obs = await executeTool(s.admin, "u1", "auth", "remove_goal_race", {});
  assert(obs.startsWith("error:"), obs);
  assertEquals(s.writes.length, 0, "an unqualified remove must never delete everything");
});

Deno.test("matchesGoal: loose on the name, strict when a date is given", () => {
  const g = { name: "Ironman Barcelona", date: "2027-10-03" };
  // People say "the Ironman", not the full stored name, and vice versa.
  assert(matchesGoal(g, "Ironman", ""));
  assert(matchesGoal(g, "ironman barcelona 2027", ""));
  assert(matchesGoal(g, "IRONMAN", ""));
  // A date narrows it: same name, different year, must not match.
  assert(matchesGoal(g, "Ironman", "2027-10-03"));
  assert(!matchesGoal(g, "Ironman", "2028-10-03"));
  // A date alone removes everything on that day.
  assert(matchesGoal(g, "", "2027-10-03"));
  assert(!matchesGoal(g, "", "2027-10-04"));
  // Neither is not a licence to match everything.
  assert(!matchesGoal(g, "", ""));
  assert(!matchesGoal(g, "Berlin", ""));
  // An empty stored name must not swallow every query by substring.
  assert(!matchesGoal({ name: "", date: "2027-10-03" }, "Ironman", ""));
});

Deno.test("remove_goal_race is advertised to the model", () => {
  assert(nativeToolDefs().map((t) => t.name).includes("remove_goal_race"));
  const t = TOOL_CATALOG.find((t) => t.name === "remove_goal_race")!;
  assertEquals(t.kind, "act");
  // The description has to warn against confirming a removal that did not
  // happen, since that is the behaviour this tool exists to stop.
  assert(/removed nothing|nothing/i.test(t.description));
});

Deno.test("goalTextFor: distance wins when real, name is the fallback", () => {
  // The measured failure: deepseek sends "sub-4 marathon" as the goal and
  // often omits distance entirely, so `distance ?? name` judged nothing.
  assertEquals(goalTextFor("Athens Marathon", null), "Athens Marathon");
  assertEquals(goalTextFor("Athens Marathon", ""), "Athens Marathon");
  // Distance names a real event: it is authoritative.
  assertEquals(goalTextFor("Athens Marathon", "Marathon"), "Marathon");
  assertEquals(goalTextFor("Nice", "70.3"), "70.3");
  // Distance is prose the demand table cannot read: fall back to the name,
  // which is where the distance usually hides.
  assertEquals(goalTextFor("Berlin Marathon", "the classic distance"), "Berlin Marathon");
  assertEquals(goalTextFor("Some 10K", "sub 40 minutes"), "Some 10K");
});

Deno.test("goalTextFor never lets a longer event swallow a shorter one", () => {
  // Why the two are not simply concatenated: matchDemand tests `marathon`
  // before `10k`, so "10K Athens Marathon" would be judged as a marathon and
  // wildly overstate what the athlete signed up for.
  const text = goalTextFor("Athens Marathon 10K Fun Run", "10K");
  assertEquals(matchDemand(text)?.label, "10K");
});

Deno.test("a goal whose distance is a target time still gets a real verdict", async () => {
  const s = writeStub({
    user_profiles: [{ onboarding: {} }],
    effective_activities: [{ date: "2026-07-20", distance_m: 5_000, duration_seconds: 1800, ctl: 8 }],
    races: [],
  });
  const obs = JSON.parse(await executeTool(s.admin, "u1", "auth", "set_goal_race", {
    name: "Athens Marathon", date: iso6WeeksOut(), distance: "sub 4 hours",
  }));
  // Before goalTextFor this matched nothing and came back "I don't have a
  // standard training demand", i.e. saved with no judgement at all.
  assertEquals(obs.feasibility.verdict, "unrealistic");
  assertEquals(obs.feasibility.push_back, true);
});

// ---------------------------------------------------------------------------
// dateError: write tools must not accept a date that has already passed.
//
// THE BUG: generate_workout passed args.date straight through with NO checks.
// Asked for a ride "on Sunday", the model decided Sunday was not an available
// training day, walked BACKWARDS to the nearest allowed one, and scheduled the
// session on yesterday. Confirmed live in planned_workouts.
// ---------------------------------------------------------------------------

Deno.test("dateError rejects a date before today", () => {
  const e = dateError("2026-07-25", "2026-07-26", { field: "date", required: true });
  assert(e, "yesterday must be refused");
  assert(e!.includes("has already passed"));
  // The message is read by the MODEL, so it has to say what to do instead.
  assert(/next one|later/i.test(e!), `unhelpful error: ${e}`);
});

Deno.test("dateError allows today and the future", () => {
  assertEquals(dateError("2026-07-26", "2026-07-26", { field: "date", required: true }), null);
  assertEquals(dateError("2027-01-01", "2026-07-26", { field: "date", required: true }), null);
});

Deno.test("dateError distinguishes missing from malformed", () => {
  // Optional and absent means "today", which is a normal call, not an error.
  assertEquals(dateError(undefined, "2026-07-26", { field: "date", required: false }), null);
  assertEquals(dateError("", "2026-07-26", { field: "date", required: false }), null);
  assert(dateError(undefined, "2026-07-26", { field: "date", required: true })?.includes("required"));
  // "next Sunday" is the shape a model actually sends when it gives up on dates.
  assert(dateError("next Sunday", "2026-07-26", { field: "date", required: true })?.includes("YYYY-MM-DD"));
  assert(dateError("2026-7-5", "2026-07-26", { field: "date", required: true })?.includes("YYYY-MM-DD"));
});

Deno.test("generate_workout refuses to schedule into the past", async () => {
  const s = writeStub({ user_profiles: [{ onboarding: {} }], reconciled_session_plans: [] });
  const obs = await executeTool(
    s.admin, "u1", "auth", "generate_workout", { date: "2026-07-25" }, "2026-07-26",
  );
  assert(obs.startsWith("error:"), obs);
  assertEquals(s.writes.length, 0, "nothing may be written for a past date");
});

Deno.test("set_rest_day and move_workout refuse the past too", async () => {
  const s = writeStub({ reconciled_session_plans: [] });
  for (const [tool, args] of [
    ["set_rest_day", { date: "2026-07-01" }],
    ["move_workout", { workout_id: "w1", new_date: "2026-07-01" }],
  ] as const) {
    const obs = await executeTool(s.admin, "u1", "auth", tool, args, "2026-07-26");
    assert(obs.startsWith("error:"), `${tool} accepted a past date: ${obs}`);
  }
});

Deno.test("with no client date, a day of slack is allowed rather than a wrong refusal", async () => {
  // The server runs in UTC and the athlete may not. Without a client-supplied
  // today, refusing strictly would reject a legitimate "today" for anyone in a
  // timezone behind UTC, which is worse than accepting one stale day.
  const s = writeStub({ reconciled_session_plans: [] });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const obs = await executeTool(s.admin, "u1", "auth", "set_rest_day", { date: yesterday });
  assert(!obs.startsWith("error:"), `slack date should be accepted, got ${obs}`);
});

// ---------------------------------------------------------------------------
// Grounding: a write tool must report what LANDED, not what was asked for.
//
// THE BUG: "make next week easier" produced a reply describing "3 easy runs and
// 2 short strength sessions" for a week that actually held 4 strength sessions
// and no runs. Two causes, both here:
//   - make_easier regenerated the day with type "auto", so easing a run was
//     free to return a strength session instead;
//   - plan_week reported only `scheduled: <count>`, so the model had nothing to
//     describe and described its own intention instead.
// ---------------------------------------------------------------------------

Deno.test("make_easier keeps the session's sport instead of regenerating freely", async () => {
  let sentType: unknown = "NOT SENT";
  const s = writeStub({
    reconciled_session_plans: [{ id: "w1", type: "run", workout_json: { title: "Easy Run with Strides" } }],
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_u: string | URL | Request, init?: RequestInit) => {
    sentType = JSON.parse(String(init?.body ?? "{}")).type;
    return Promise.resolve(
      new Response(JSON.stringify({ workout_id: "w2", workout: { title: "Easy Recovery Run" } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const obs = JSON.parse(
      await executeTool(s.admin, "u1", "auth", "make_easier", { date: "2026-07-27" }, "2026-07-26"),
    );
    // The whole point: a run stays a run.
    assertEquals(sentType, "run", "the existing sport must be pinned, never 'auto'");
    assertEquals(obs.was.type, "run");
    assertEquals(obs.now.type, "run");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("make_easier refuses a day with nothing planned instead of inventing one", async () => {
  const s = writeStub({ reconciled_session_plans: [] });
  const obs = await executeTool(s.admin, "u1", "auth", "make_easier", { date: "2026-07-27" }, "2026-07-26");
  assert(obs.startsWith("error:"), obs);
  assert(obs.includes("nothing is planned"), obs);
});

Deno.test("plan_week reports the real days, not just how many", async () => {
  const s = writeStub({
    reconciled_session_plans: [
      { date: "2026-07-27", type: "run", workout_json: { title: "Easy Run" } },
      { date: "2026-07-28", type: "strength", workout_json: { title: "Full Body" } },
    ],
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ scheduled: 2, week_focus: "base", pushed: 2 }), {
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;
  try {
    const obs = JSON.parse(
      await executeTool(s.admin, "u1", "auth", "plan_week", { start_date: "2026-07-27" }, "2026-07-26"),
    );
    // A bare count is what let the model describe a week it had not created.
    assertEquals(obs.week_now.length, 2);
    assertEquals(obs.week_now[0], { date: "2026-07-27", type: "run", title: "Easy Run" });
    assertEquals(obs.week_now[1].type, "strength");
    assertEquals(obs.week_start, "2026-07-27");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("plan_week still accepts the current week's Monday, which is in the past", async () => {
  // A week legitimately starts before today; only the FORMAT is enforced.
  const s = writeStub({ reconciled_session_plans: [] });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ scheduled: 0 }), {
      headers: { "Content-Type": "application/json" },
    }))) as typeof fetch;
  try {
    const obs = await executeTool(
      s.admin, "u1", "auth", "plan_week", { start_date: "2026-07-20" }, "2026-07-26",
    );
    assert(!obs.startsWith("error:"), `a past week start must be allowed, got ${obs}`);
    // But garbage is still refused.
    const bad = await executeTool(s.admin, "u1", "auth", "plan_week", { start_date: "next week" }, "2026-07-26");
    assert(bad.startsWith("error:"), bad);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("get_planned_week says where each day sits relative to today", async () => {
  // Measured live: the coach read Monday's session from six days earlier and
  // told the athlete it was "tomorrow". A week starts on Monday, so by Sunday
  // most of it is history and bare dates were not enough to stop that.
  const s = writeStub({
    reconciled_session_plans: [
      { id: "a", date: "2026-07-20", type: "run", completed: true, locked: false, workout_json: { title: "Easy Run" } },
      { id: "b", date: "2026-07-26", type: "ride", completed: false, locked: false, workout_json: { title: "Long Ride" } },
      { id: "c", date: "2026-07-27", type: "strength", completed: false, locked: false, workout_json: { title: "Full Body" } },
    ],
  });
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "get_planned_week", {}, "2026-07-26"),
  );
  assertEquals(obs.today, "2026-07-26");
  assertEquals(obs.sessions.map((x: Any) => x.when), ["past", "today", "upcoming"]);
});

Deno.test("get_planned_week's default week is anchored to the athlete's date", async () => {
  // mondayOf() read the SERVER clock, which is UTC and not the athlete's day.
  const s = writeStub({ reconciled_session_plans: [] });
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "get_planned_week", {}, "2026-07-26"),
  );
  assertEquals(obs.week_start, "2026-07-20", "Sunday the 26th belongs to the week starting Monday the 20th");
});

// ---------------------------------------------------------------------------
// week_now: every write reports the calendar AS IT STANDS AFTER it.
//
// THE BUG: a re-plan turn called plan_week (which correctly returned the week
// it built), then set_rest_day four times, deleting the four training sessions
// it had just created. The reply described plan_week's result, which no longer
// existed. Grounding a write in its OWN result is not enough when a later write
// in the same turn moves the ground.
// ---------------------------------------------------------------------------

Deno.test("set_rest_day names what it deleted instead of counting it", async () => {
  const s = writeStub({
    reconciled_session_plans: [
      { id: "w1", type: "run", workout_json: { title: "Easy Run with Strides" } },
    ],
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response("{}", { headers: { "Content-Type": "application/json" } }))) as typeof fetch;
  try {
    const obs = JSON.parse(
      await executeTool(s.admin, "u1", "auth", "set_rest_day", { date: "2026-07-27" }, "2026-07-26"),
    );
    assertEquals(obs.cleared_count, 1);
    // The name is the point: "cleared: 1" gave the model no way to notice it
    // had just undone a session it created moments earlier.
    assertEquals(obs.cleared[0].title, "Easy Run with Strides");
    assertEquals(obs.cleared[0].type, "run");
    assert(Array.isArray(obs.week_now), "a write must report the resulting week");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("every calendar write reports week_now", async () => {
  const s = writeStub({
    reconciled_session_plans: [{ id: "w1", type: "run", workout_json: { title: "Easy Run" } }],
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ workout_id: "w2", workout: { title: "X" }, scheduled: 1 }), {
      headers: { "Content-Type": "application/json" },
    }))) as typeof fetch;
  try {
    for (const [tool, args] of [
      ["plan_week", { start_date: "2026-07-27" }],
      ["generate_workout", { date: "2026-07-27" }],
      ["make_easier", { date: "2026-07-27" }],
      ["set_rest_day", { date: "2026-07-27" }],
      ["move_workout", { workout_id: "w1", new_date: "2026-07-28" }],
    ] as const) {
      const obs = JSON.parse(await executeTool(s.admin, "u1", "auth", tool, args, "2026-07-26"));
      assert(Array.isArray(obs.week_now), `${tool} did not report week_now`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// log_stretch_session (Trello #73) — logs a COMPLETED session, so unlike
// set_rest_day/move_workout its date constraint runs the other way: today is
// the ceiling, not the floor.
// ---------------------------------------------------------------------------

Deno.test("coach tools: log_stretch_session is registered as an act tool, not a write of the calendar", () => {
  const t = TOOL_CATALOG.find((x) => x.name === "log_stretch_session");
  assert(t, "log_stretch_session missing");
  assertEquals(t!.kind, "act");
  const native = nativeToolDefs().map((x) => x.name);
  assert(native.includes("log_stretch_session"));
});

Deno.test("log_stretch_session writes date, duration and notes", async () => {
  const s = writeStub({});
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "log_stretch_session", {
      date: "2026-07-27", duration_min: 15.6, notes: "  hips and hamstrings  ",
    }, "2026-07-29"),
  );
  const row = s.of("stretch_logs").find((w) => w.op === "insert");
  assert(row, "stretch_logs must be written");
  assertEquals(row!.row.user_id, "u1");
  assertEquals(row!.row.date, "2026-07-27");
  assertEquals(row!.row.duration_min, 16); // rounded
  assertEquals(row!.row.notes, "hips and hamstrings"); // trimmed
  assertEquals(obs.ok, true);
  assertEquals(obs.date, "2026-07-27");
});

Deno.test("log_stretch_session defaults to today when no date is given", async () => {
  const s = writeStub({});
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "log_stretch_session", {}, "2026-07-29"),
  );
  assertEquals(obs.date, "2026-07-29");
  assertEquals(s.of("stretch_logs")[0].row.date, "2026-07-29");
});

Deno.test("log_stretch_session rejects a future date (it logs what already happened)", async () => {
  const s = writeStub({});
  const obs = await executeTool(s.admin, "u1", "auth", "log_stretch_session", {
    date: "2026-07-30",
  }, "2026-07-29");
  assert(obs.startsWith("error:"), obs);
  assertEquals(s.of("stretch_logs").length, 0);
});

Deno.test("log_stretch_session accepts a past date, unlike set_rest_day/move_workout", async () => {
  const s = writeStub({});
  const obs = JSON.parse(
    await executeTool(s.admin, "u1", "auth", "log_stretch_session", {
      date: "2026-07-20",
    }, "2026-07-29"),
  );
  assertEquals(obs.ok, true);
  assertEquals(obs.date, "2026-07-20");
});

// --- injury backoff + follow-up tools ----------------------------------------
// The point of these tools is that they write a STRUCTURED field the generators
// enforce, rather than a coach_knowledge sentence a model may or may not honor
// later. So the assertions are about what lands in the row, not about wording.

function profileStub(row: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  const admin: Any = {
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: row }) }) }),
      update: (u: Record<string, unknown>) => {
        updates.push(u);
        return { eq: () => Promise.resolve({}) };
      },
    }),
  };
  return { admin, updates };
}

Deno.test("injury tools are registered and advertised to the model", () => {
  const names = ["report_injury", "set_injury_backoff", "clear_injury_backoff", "update_injury_status"];
  for (const n of names) {
    const t = TOOL_CATALOG.find((x) => x.name === n);
    assert(t, `${n} missing from the catalog`);
    assertEquals(t!.kind, "act");
    assert(nativeToolDefs().some((d) => d.name === n), `${n} not advertised natively`);
    assert(toolCatalogPrompt().includes(n), `${n} not in the protocol prompt`);
  }
});

Deno.test("report_injury: atomically creates a structured injury and initial protection", async () => {
  const { admin, updates } = profileStub({ onboarding: { goal: "10K" }, injury_backoff: [] });
  const out = JSON.parse(await executeTool(admin, "u1", "auth", "report_injury", {
    area: " left knee ", pain: 6, detail: "Hurts when I squat",
  }, "2026-07-26"));
  assertEquals(out.ok, true);
  assertEquals(out.created, true);
  assertEquals(out.injury.area, "left knee");
  assertEquals(out.injury.severity, "moderate");
  const onboarding = updates[0].onboarding as Record<string, unknown>;
  const injuries = onboarding.injuries as Record<string, unknown>[];
  assertEquals(injuries.length, 1);
  assertEquals(injuries[0].area, "left knee");
  assertEquals(injuries[0].severity, "moderate");
  assertEquals(injuries[0].note, "Hurts when I squat");
  assertEquals(injuries[0].raised_at, "2026-07-26");
  assertEquals((updates[0].injury_backoff as Record<string, unknown>[])[0].level, "ease");
});

Deno.test("report_injury: enriches an existing injury and escalates severe pain", async () => {
  const { admin, updates } = profileStub({
    onboarding: { injuries: [{ area: "Left knee", severity: "", raised_at: "2026-07-20" }] },
    injury_backoff: [{ area: "Left knee", level: "ease", until: "2026-08-01" }],
  });
  const out = JSON.parse(await executeTool(admin, "u1", "auth", "report_injury", {
    area: "left knee", pain: 8, detail: "Sharp pain on stairs",
  }, "2026-07-26"));
  assertEquals(out.created, false);
  const injuries = (updates[0].onboarding as Record<string, unknown>).injuries as Record<string, unknown>[];
  assertEquals(injuries.length, 1);
  assertEquals(injuries[0].area, "Left knee", "keeps the existing canonical label");
  assertEquals(injuries[0].severity, "serious");
  assertEquals((updates[0].injury_backoff as Record<string, unknown>[])[0].level, "avoid");
});

Deno.test("set_injury_backoff: writes a dated, structured backoff", () => {
  const t = TOOL_CATALOG.find((x) => x.name === "set_injury_backoff")!;
  assertEquals((t.schema as { required?: string[] }).required, ["area", "level"]);
});

Deno.test("set_injury_backoff: saves area, level and an end date", async () => {
  const { admin, updates } = profileStub({ injury_backoff: [] });
  const out = JSON.parse(
    await executeTool(admin, "u1", "auth", "set_injury_backoff", { area: " Knee ", level: "avoid", days: 10 }),
  );
  assertEquals(out.ok, true);
  assertEquals(out.area, "Knee");
  assertEquals(out.level, "avoid");
  const saved = updates[0].injury_backoff as Record<string, unknown>[];
  assertEquals(saved.length, 1);
  assertEquals(saved[0].area, "Knee");
  assertEquals(saved[0].until, out.until);
  assert(typeof out.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(out.until));
});

Deno.test("set_injury_backoff: rejects a bad level rather than guessing", async () => {
  const { admin } = profileStub({ injury_backoff: [] });
  assert((await executeTool(admin, "u1", "auth", "set_injury_backoff", { area: "Knee", level: "stop" })).startsWith("error:"));
  assert((await executeTool(admin, "u1", "auth", "set_injury_backoff", { area: " ", level: "ease" })).startsWith("error:"));
});

Deno.test("set_injury_backoff: one per area, and the duration is bounded", async () => {
  const { admin, updates } = profileStub({
    injury_backoff: [{ area: "Knee", level: "ease", until: "2099-01-01" }],
  });
  const out = JSON.parse(
    await executeTool(admin, "u1", "auth", "set_injury_backoff", { area: "knee", level: "avoid", days: 9999 }),
  );
  const saved = updates[0].injury_backoff as Record<string, unknown>[];
  assertEquals(saved.length, 1, "the same area must not stack two windows");
  assertEquals(saved[0].level, "avoid");
  // 60-day cap: a coach that types 9999 must not sideline the athlete for 27 years.
  const days = Math.round(
    (new Date(out.until + "T12:00:00").getTime() - new Date(new Date().toISOString().slice(0, 10) + "T12:00:00").getTime()) / 86400000,
  );
  assertEquals(days, 60);
});

Deno.test("clear_injury_backoff: by area, and wholesale", async () => {
  const two = [
    { area: "Knee", level: "ease", until: "2099-01-01" },
    { area: "Shoulder", level: "avoid", until: "2099-01-01" },
  ];
  const one = profileStub({ injury_backoff: two });
  const outOne = JSON.parse(await executeTool(one.admin, "u1", "auth", "clear_injury_backoff", { area: "Knee" }));
  assertEquals(outOne.cleared, 1);
  assertEquals((one.updates[0].injury_backoff as Record<string, unknown>[]).length, 1);

  const all = profileStub({ injury_backoff: two });
  const outAll = JSON.parse(await executeTool(all.admin, "u1", "auth", "clear_injury_backoff", {}));
  assertEquals(outAll.cleared, 2);
  assertEquals((all.updates[0].injury_backoff as Record<string, unknown>[]).length, 0);
});

Deno.test("update_injury_status: 'better' records the answer without dropping the injury", async () => {
  const { admin, updates } = profileStub({
    onboarding: { goal: "10K", injuries: [{ area: "Knee", severity: "moderate", raised_at: "2026-07-01" }] },
    injury_backoff: [],
  });
  const out = JSON.parse(
    await executeTool(admin, "u1", "auth", "update_injury_status", { area: "Knee", status: "better" }),
  );
  assertEquals(out.removed_from_injuries, false);
  const onboarding = updates[0].onboarding as Record<string, unknown>;
  const injuries = onboarding.injuries as Record<string, unknown>[];
  assertEquals(injuries.length, 1);
  assertEquals(injuries[0].status, "better");
  assert(typeof injuries[0].last_checked === "string");
  assertEquals(onboarding.goal, "10K", "unrelated onboarding fields must survive");
});

Deno.test("update_injury_status: 'resolved' removes the injury AND its backoff", async () => {
  // Otherwise the athlete says "it's fine now" and keeps getting sessions built
  // around a healed knee until the dated window happens to lapse.
  const { admin, updates } = profileStub({
    onboarding: { injuries: [{ area: "Knee", severity: "moderate" }, { area: "Shoulder", severity: "" }] },
    injury_backoff: [{ area: "Knee", level: "avoid", until: "2099-01-01" }],
  });
  const out = JSON.parse(
    await executeTool(admin, "u1", "auth", "update_injury_status", { area: "Knee", status: "resolved" }),
  );
  assertEquals(out.removed_from_injuries, true);
  const injuries = (updates[0].onboarding as Record<string, unknown>).injuries as Record<string, unknown>[];
  assertEquals(injuries.map((i) => i.area), ["Shoulder"]);
  assertEquals((updates[0].injury_backoff as unknown[]).length, 0);
});

Deno.test("update_injury_status: an unknown area errors and names what IS on file", async () => {
  // A silent no-op would let the coach tell the athlete their elbow is logged
  // as resolved when nothing was written.
  const { admin } = profileStub({ onboarding: { injuries: [{ area: "Knee", severity: "" }] }, injury_backoff: [] });
  const err = await executeTool(admin, "u1", "auth", "update_injury_status", { area: "Elbow", status: "resolved" });
  assert(err.startsWith("error:"), err);
  assert(err.includes("Knee"), err);
});

Deno.test("update_injury_status: rejects a status outside the three answers", async () => {
  const { admin } = profileStub({ onboarding: { injuries: [{ area: "Knee", severity: "" }] }, injury_backoff: [] });
  assert((await executeTool(admin, "u1", "auth", "update_injury_status", { area: "Knee", status: "fine" })).startsWith("error:"));
});

Deno.test("get_profile: surfaces injury follow-up state and active backoffs", async () => {
  // The coach could set a backoff and then had no way to know it existed, so it
  // re-imposed one every turn.
  const admin = adminStub({
    user_profiles: {
      display_name: "A",
      onboarding: { injuries: [{ area: "Knee", severity: "moderate", raised_at: "2026-07-01", status: "present" }] },
      injury_backoff: [
        { area: "Knee", level: "avoid", until: "2099-01-01" },
        { area: "Shoulder", level: "ease", until: "2000-01-01" }, // expired
      ],
    },
  });
  const obs = JSON.parse(await executeTool(admin, "u1", "auth", "get_profile", {}));
  assertEquals(obs.injury_status.length, 1);
  assertEquals(obs.injury_status[0].area, "Knee");
  assertEquals(obs.injury_status[0].status, "present");
  assertEquals(obs.injury_backoff.length, 1, "expired backoffs must not be reported as in force");
  assertEquals(obs.injury_backoff[0].area, "Knee");
});


Deno.test("plan_week pins local week and forwards local today when args are empty", async () => {
  const s = writeStub({reconciled_session_plans:[{date:"2026-10-27",type:"run",workout_json:{title:"Easy run"}}]});
  const original = globalThis.fetch;
  let sent: Any;
  globalThis.fetch = ((_url: Any, init: Any) => {
    sent = JSON.parse(init.body);
    return Promise.resolve(new Response(JSON.stringify({scheduled:1})));
  }) as typeof fetch;
  try {
    const result = JSON.parse(await executeTool(s.admin,"u","auth","plan_week",{},"2026-10-27"));
    assertEquals(sent.start_date,"2026-10-26");
    assertEquals(sent.today,"2026-10-27");
    assertEquals(result.week_start,"2026-10-26");
    assertEquals(result.ok,true);
  } finally { globalThis.fetch = original; }
});

Deno.test("plan_week rejects HTTP errors, empty responses and zero writes even with existing sessions", async () => {
  const s = writeStub({reconciled_session_plans:[{date:"2026-10-27",type:"run",workout_json:{title:"Old run"}}]});
  const original = globalThis.fetch;
  try {
    for (const [status, body] of [[502,"upstream unavailable"],[401,JSON.stringify({message:"Invalid JWT"})],[200,"{}"],[200,JSON.stringify({scheduled:0})]] as const) {
      globalThis.fetch = (() => Promise.resolve(new Response(body,{status}))) as typeof fetch;
      const result = JSON.parse(await executeTool(s.admin,"u","auth","plan_week",{},"2026-10-27"));
      assertEquals(result.ok,false);
      assert(result.error);
    }
  } finally { globalThis.fetch = original; }
});

Deno.test("plan_week requires saved calendar rows, not only a count", async () => {
  const s = writeStub({reconciled_session_plans:[]});
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({scheduled:3})))) as typeof fetch;
  try {
    const result = JSON.parse(await executeTool(s.admin,"u","auth","plan_week",{},"2026-10-27"));
    assertEquals(result.ok,false);
    assert(result.error.includes("verified"));
  } finally { globalThis.fetch = original; }
});

Deno.test("generate_workout pins the athlete's local date when args are empty", async () => {
  const s = writeStub({reconciled_session_plans:[]});
  const original = globalThis.fetch;
  let sent: Any;
  globalThis.fetch = ((_url: Any, init: Any) => {
    sent=JSON.parse(init.body);
    return Promise.resolve(new Response(JSON.stringify({workout_id:"new",workout:{title:"Easy run"}})));
  }) as typeof fetch;
  try {
    const result=JSON.parse(await executeTool(s.admin,"u","auth","generate_workout",{},"2026-10-27"));
    assertEquals(sent.date,"2026-10-27");
    assertEquals(sent.today,"2026-10-27");
    assertEquals(result.ok,true);
  } finally { globalThis.fetch=original; }
});

Deno.test("get_today_plan reads the local date and returns the saved instructions without a generation call", async () => {
  const queries:Any[]=[];
  const saved={id:"existing",date:"2026-10-27",type:"strength",session_slot:0,completed:false,skipped:false,workout_json:{title:"Existing strength",sections:[{name:"Main",exercises:[{name:"Squat",sets:3,reps:"8"}]}]}};
  const base=adminStub({reconciled_session_plans:[saved]});
  const admin={from:(table:string)=>{const chain=base.from(table);chain.eq=(key:string,value:unknown)=>{queries.push([key,value]);return chain};return chain}};
  const result=JSON.parse(await executeTool(admin as Any,"owner","auth","get_today_plan",{},"2026-10-27"));
  assertEquals(result.today,"2026-10-27");assertEquals(result.sessions[0].id,"existing");
  assertEquals(result.sessions[0].workout,saved.workout_json);
  assert(queries.some(([key,value])=>key==="date"&&value==="2026-10-27"));
});

Deno.test("a saved workout with queued watch delivery remains a successful calendar action", async () => {
  const original=globalThis.fetch;
  let sent:Any;
  globalThis.fetch=((_url:Any,init:Any)=>{sent=JSON.parse(init.body);return Promise.resolve(new Response(JSON.stringify({workout_id:"saved",workout:{title:"Swim"},push_error:"provider unavailable"})))}) as typeof fetch;
  try {
    const result=JSON.parse(await executeTool(adminStub({}),"u","auth","generate_workout",{type:"swim",session_slot:1},"2026-10-27"));
    assertEquals(result.ok,true);assertEquals(result.calendar_saved,true);assertEquals(result.delivery,"pending");
    assertEquals(sent.type,"swim");assertEquals(sent.session_slot,1);
    const schema=TOOL_CATALOG.find(t=>t.name==="generate_workout")!.schema as Any;
    assert(schema.properties.type.enum.includes("ride"));assert(schema.properties.type.enum.includes("swim"));
  } finally {globalThis.fetch=original}
});

Deno.test("coach profile exposes the same planning preferences the workout engine uses", async () => {
 const onboarding={sports:["run","strength"],primary_sport:"run",implements:["dumbbells"],weekly_minutes_max:180,session_windows:[{day:"Tue",slot:0,start_minute:420,max_minutes:30}],prescription_engine:"deterministic",training_history_confirmed:true,automatic_event_preparation:false,event_policies:{run:{days:3,duration_factor:0.8,allow_quality:false}}};
 const result=JSON.parse(await executeTool(adminStub({user_profiles:[{onboarding}]}),"owner","auth","get_profile",{},"2026-10-27"));
 for(const key of ["sports","primary_sport","implements","weekly_minutes_max","session_windows","prescription_engine","training_history_confirmed","automatic_event_preparation","event_policies"] as const) assertEquals(result[key],onboarding[key]);
});
