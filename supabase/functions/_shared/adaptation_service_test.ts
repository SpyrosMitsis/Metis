import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { previewAdaptation, validateAdaptation } from "./adaptation_service.ts";
import { buildSession } from "./session_engine.ts";
import { reviewGeneratedWorkout } from "./plan_store.ts";

const date = "2026-10-26", owner = "11111111-1111-4111-8111-111111111111";
function fixture(
  patch: Record<string, unknown[]> = {},
  fail?: string,
  stale = false,
) {
  const workout = buildSession({
    date,
    sport: "run",
    max_minutes: 20,
    weekly_remaining_minutes: 60,
    experience: "Beginner",
    actual: [],
    history_complete: false,
    implements: [],
    venue: "road",
    fatigue: "normal",
    blocked_sports: [],
  }, "easy");
  const plan = {
    id: "22222222-2222-4222-8222-222222222222",
    user_id: owner,
    date,
    session_slot: 0,
    type: "run",
    workout_json: workout,
    completed: false,
    skipped: false,
    locked: false,
    activity_ids: [] as string[],
  };
  const tables: Record<string, unknown[]> = {
    user_profiles: [{
      id: owner,
      onboarding: {
        sports: ["run", "ride"],
        venues: { run: "road" },
        session_duration: 20,
        training_history_confirmed: true,
      },
      injury_backoff: [],
    }],
    reconciled_session_plans: [plan],
    adaptation_proposals: [],
    athlete_versions: [{ user_id: owner, revision: 0 }],
    ...patch,
  };
  let revisions = 0;
  const db = {
    from: (name: string) => {
      const predicates: ((r: Record<string, unknown>) => boolean)[] = [];
      let single = false;
      let sort: string | undefined, ascending = true;
      let inserting: unknown;
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          predicates.push((r) => r[key] === value);
          return q;
        },
        gte: (key: string, value: string) => {
          predicates.push((r) => String(r[key]) >= value);
          return q;
        },
        lte: (key: string, value: string) => {
          predicates.push((r) => String(r[key]) <= value);
          return q;
        },
        order: (key: string, opts?: { ascending?: boolean }) => {
          sort = key;
          ascending = opts?.ascending !== false;
          return q;
        },
        single: () => {
          single = true;
          return q;
        },
        maybeSingle: () => {
          single = true;
          return q;
        },
        insert: (value: unknown) => {
          inserting = value;
          return q;
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (inserting && name !== fail) {
            tables[name] ??= [];
            tables[name].push(inserting);
          }
          let values = (tables[name] ?? []).filter((r) =>
            predicates.every((p) => p(r as Record<string, unknown>))
          );
          if (sort) {
            values = [...values].sort((a, b) =>
              String((a as Record<string, unknown>)[sort!]).localeCompare(
                String((b as Record<string, unknown>)[sort!]),
              ) * (ascending ? 1 : -1)
            );
          }
          return Promise.resolve(
            resolve({
              data: single ? values[0] ?? null : values,
              error: name === fail ? { message: "fixture unavailable" } : null,
            }),
          );
        },
      };
      return q;
    },
    rpc: (name: string) =>
      Promise.resolve({
        data: name === "plan_revision" && stale && revisions++ > 0 ? 1 : 0,
        error: null,
      }),
  } as unknown as SupabaseClient;
  return { db, tables, plan };
}
Deno.test("preview keeps an unchanged week and never treats an absent recording as a miss", async () => {
  const { db, tables, plan } = fixture();
  const original = JSON.stringify(plan);
  const p = await previewAdaptation(db, owner, { today: date });
  assertEquals(p.changes.length, 0);
  assertEquals(JSON.stringify(plan), original);
  assertEquals(tables.adaptation_proposals.length, 1);
  assert(p.explanation.includes("Missing recordings"));
});
Deno.test("an explicit shorter window changes only one future session and keeps its ID", async () => {
  const { db, tables, plan } = fixture();
  const other = {
    ...plan,
    id: "33333333-3333-4333-8333-333333333333",
    date: "2026-10-27",
    workout_json: {
      ...plan.workout_json,
      prescription: {
        ...plan.workout_json.prescription!,
        scheduled_date: "2026-10-27",
      },
    },
  };
  tables.reconciled_session_plans.push(other);
  const before = JSON.stringify(tables.reconciled_session_plans);
  const p = await previewAdaptation(db, owner, { today: date, minutes: 15 });
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].id, plan.id);
  assertEquals(
    (p.changes[0].after as { duration_minutes: number }).duration_minutes,
    15,
  );
  assertEquals(JSON.stringify(tables.reconciled_session_plans), before);
});
Deno.test("recorded and locked work is preserved even with a pain/illness hold", async () => {
  const { db, tables, plan } = fixture({
    training_holds: [{
      id: crypto.randomUUID(),
      user_id: owner,
      reason: "illness",
      sport: null,
      start_date: date,
      active: true,
    }],
  });
  plan.locked = true;
  const p = await previewAdaptation(db, owner, { today: date });
  assertEquals(p.changes.length, 0);
  assert(p.uncertainties.some((s) => s.includes("preserved")));
  plan.locked = false;
  plan.activity_ids = ["recording"];
  const q = await previewAdaptation(db, owner, { today: date });
  assertEquals(q.changes.length, 0);
  assertEquals(tables.reconciled_session_plans[0], plan);
});
Deno.test("active illness hold makes all affected mutable sessions explicit rest", async () => {
  const { db, plan } = fixture({
    training_holds: [{
      id: crypto.randomUUID(),
      user_id: owner,
      reason: "illness",
      sport: null,
      start_date: date,
      active: true,
    }],
  });
  const p = await previewAdaptation(db, owner, { today: date });
  assertEquals(p.changes.length, 1);
  assertEquals(p.changes[0].id, plan.id);
  assertEquals((p.changes[0].after as { type: string }).type, "rest");
});
Deno.test("unavailable input and concurrent observation/plan changes cannot save a candidate", async () => {
  const a = fixture({}, "effective_activities");
  await assertRejects(() =>
    previewAdaptation(a.db, owner, { today: date, minutes: 15 })
  );
  assertEquals(a.tables.adaptation_proposals.length, 0);
  const b = fixture({}, undefined, true);
  await assertRejects(
    () => previewAdaptation(b.db, owner, { today: date, minutes: 15 }),
    Error,
    "Inputs changed",
  );
  assertEquals(b.tables.adaptation_proposals.length, 0);
});
Deno.test("preview retry compares canonical JSON rather than PostgreSQL property order", async () => {
  const { db, tables } = fixture();
  const id = crypto.randomUUID();
  const p = await previewAdaptation(db, owner, { today: date, request_id: id });
  const stored = tables.adaptation_proposals[0] as {
    provenance: { scope: Record<string, unknown> };
  };
  stored.provenance.scope = Object.fromEntries(
    Object.entries(stored.provenance.scope).reverse(),
  );
  assertEquals(
    (await previewAdaptation(db, owner, { today: date, request_id: id })).id,
    p.id,
  );
  assertEquals(tables.adaptation_proposals.length, 1);
  await assertRejects(
    () =>
      previewAdaptation(db, owner, {
        today: date,
        request_id: id,
        minutes: 15,
      }),
    Error,
    "another preview",
  );
});
Deno.test("undo rejects past or newly unsupported prescriptions instead of silently forcing a restore", async () => {
  const { db, plan } = fixture();
  const before = reviewGeneratedWorkout(plan.workout_json, {
    mainLifts: [],
    weeklySetsByMuscle: {},
    muscleGroupsLast48h: [],
    tsb: 0,
    daysSinceLastHard: 99,
    experience: "Beginner",
    readinessBasis: "none",
  }).corrected;
  await assertRejects(
    () =>
      validateAdaptation(
        db,
        owner,
        {
          id: crypto.randomUUID(),
          state: "applied",
          changes: [{
            id: plan.id,
            date: "2026-10-25",
            session_slot: 0,
            before,
            after: before,
            explanation: "fixture",
          }],
          explanation: "fixture",
          next_action: "fixture",
          uncertainties: [],
          alternatives: [],
          clarification: null,
        },
        date,
        true,
      ),
    Error,
    "Past training",
  );
});
Deno.test("an illness hold pauses both unprotected parts of a combined session and removes transition dose", async () => {
  const { db, tables, plan } = fixture({
    training_holds: [{
      id: crypto.randomUUID(),
      user_id: owner,
      reason: "illness",
      sport: null,
      start_date: date,
      active: true,
    }],
    user_profiles: [{
      id: owner,
      onboarding: {
        sports: ["run", "ride"],
        session_duration: 20,
        session_windows: [{
          day: "Mon",
          slot: 0,
          start_minute: 420,
          max_minutes: 20,
        }, { day: "Mon", slot: 1, start_minute: 445, max_minutes: 20 }],
      },
    }],
  });
  Object.assign(plan, { combined_group: "brick", start_minute: 420 });
  tables.reconciled_session_plans.push({
    ...plan,
    id: "33333333-3333-4333-8333-333333333333",
    type: "ride",
    session_slot: 1,
    start_minute: 445,
    transition_before_seconds: 300,
    workout_json: {
      ...plan.workout_json,
      type: "ride",
      prescription: undefined,
    },
  });
  const p = await previewAdaptation(db, owner, { today: date });
  assertEquals(p.changes.length, 2);
  assert(
    p.changes.every((c) =>
      (c.after as { type: string }).type === "rest" &&
      c.after_transition_seconds === 0
    ),
  );
  assertEquals(p.changes[1].before_transition_seconds, 300);
});
Deno.test("undo cannot restore a numeric target whose calibration is no longer supported", async () => {
  const { db, plan } = fixture();
  const workout = structuredClone(plan.workout_json);
  const block = workout.prescription!.blocks.find((b) =>
    b.kind === "endurance"
  )!;
  if (block.kind !== "endurance") throw new Error("fixture");
  block.numeric_target = {
    kind: "pace_seconds_per_km",
    min: 300,
    max: 330,
    calibration_date: "2025-01-01",
    calibration_value: 300,
    reliability: "measured",
    advisory: true,
  };
  await assertRejects(
    () =>
      validateAdaptation(
        db,
        owner,
        {
          id: crypto.randomUUID(),
          state: "applied",
          changes: [{
            id: plan.id,
            date,
            session_slot: 0,
            before: workout,
            after: workout,
            explanation: "fixture",
          }],
          explanation: "fixture",
          next_action: "fixture",
          uncertainties: [],
          alternatives: [],
          clarification: null,
        },
        date,
        true,
      ),
    Error,
    "Intensity calibration changed",
  );
});
