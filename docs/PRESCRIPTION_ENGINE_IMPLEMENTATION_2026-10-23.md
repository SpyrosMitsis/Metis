# Prescription engine implementation — 2026-10-23

The P1 engineering implementation now covers running, cycling, swimming, strength, recovery and mixed-sport scheduling. Independent coach review and real trainer/watch acceptance testing remain release validation work; tests do not certify training suitability. Changes are local, with migrations 47–51 pending production deployment.

## Start here when changing the engine

| Concern | Main files under `supabase/functions/_shared/` unless stated otherwise |
|---|---|
| Executable dose contract | `shared/prescription.ts`, `prescription.ts` |
| Deterministic sport recipes and eligibility | `session_engine.ts`, `open_water.ts` |
| Model proposal compilation | `proposal_compiler.ts`; daily, weekly and template entry points |
| Athlete state and feed completeness | `session_context.ts` |
| Actual-based multiweek progression | `program_state.ts` |
| Joint scheduling, event priorities, long sessions | `deterministic_week.ts`, `training_demands.ts` |
| Double sessions and transitions | `session_slots.ts`, migration 49 |
| Targets and measurement provenance | `target_selection.ts` |
| Exact catalog and substitutions | `exercise_catalog.ts`, `exercise_requirements.ts` |
| Publication, time budgets and transaction calls | `plan_store.ts`, migrations 47/49/51 |
| Execution evidence and strength session analysis | `execution_evidence.ts`, `analyze_core.ts`, migration 50 |
| Structured transport and lossless interchange | `intervals_workout.ts`, `workout_exchange.ts`, `shared/workout_exchange.ts` |
| Android logging | `strength/StrengthRepository.kt`, `StrengthViewModel.kt`, Room migration 8→9 |
| Profile controls | Android `settings/PlanningControls.kt`, web `components/planning-controls.tsx` |
| Database regression runner | `scripts/engine-tests/run.py` |

## Authority and publication

Models interpret intent and propose work. New daily, weekly and saved-template sessions must be compiled into a typed prescription before publication. The compiler resolves venues, checks eligibility and exact catalog identity, rebuilds targets from athlete calibration, caps exercise loads against that exercise's history and recomputes complete duration. A model cannot disable catalog enforcement or publish contradictory display sections.

`Workout.prescription` is the executable contract. Legacy `sections` are its generated display/logging projection. Publication rejects changes to one without corresponding changes to the other. Old saved workouts remain readable and exportable; newly scheduled legacy templates are compiled again using current constraints.

All work, between-repetition recovery, optional final recovery, setup, transitions, warm-up and cool-down enter duration arithmetic. Distance is null if the complete distance is unknown; known work distance is not falsely labeled whole-session distance. Strength repetition ranges use their upper bound for time estimates; unilateral work includes both sides.

Failed generation, compilation, content checks, budget checks or revision checks preserve the existing plan. Replacement is atomic and idempotent. Requests retain input/program/policy metadata. Calendar writes use an outbox. Moving a session preserves its ID, validates destination constraints and checks plan revision and occupancy in one database transaction. Completed/skipped sessions and individual halves of a combined session cannot be moved individually.

## Programs and scheduling

Progression uses deduplicated actual sessions and explicitly linked athlete responses. Planned or missed work does not authorize increases or create training debt. Incomplete/stale/failed feeds lead to familiarization. Unknown response repeats; difficult response reduces; pain requires reassessment. Ordinary automatic progression changes duration only. Explicit program start/periodization enables a reduced fourth week. Explicit event policies control preparation windows and retained dose; a race date alone does not invent a taper.

Primary/secondary goals, goal distance, nearest applicable priority-A event and available windows influence scheduling. Long sessions use actual recent exposure and the longest available day. Joint demand checks consider actual hard work and fixed/future planned sessions, including running/strength lower-body overlap and swimming/strength upper-body overlap. Substitution reasons state which sport-specific benefit is not preserved. Material reductions in availability and sparse exposure near an event produce timeline reassessment observations.

Each date has slots 0/1 with independent planned UUIDs. A second session requires an explicit local start and duration window. Independent sessions need a configured recovery gap, defaulting to 180 minutes with a minimum configurable value of 60. Two demanding independent sessions are rejected. Combined sessions require an explicit triathlon/duathlon goal, different endurance sports and a 0–30 minute transition; that transition consumes the daily/weekly budget. These are versioned engineering policies pending external review.

The weekly planner uses deterministic scheduling whenever double-session windows are configured. Single-session model weeks still compile every candidate and check joint recovery. Slot-specific replacement preserves the other slot and protected sessions. Reads use the owner-filtered `reconciled_session_plans`; the old view remains for compatibility.

## Sport behavior

Running recipes include easy, recovery, long, run/walk, technique, strides, hills, tempo, threshold and intervals. Cycling includes easy/endurance, recovery, long, tempo, threshold, intervals and technique/cadence. Swimming includes easy/aerobic, recovery, long/endurance, technique, threshold and intervals. Recipes have explicit work and recovery rather than strength-style free text.

Power, threshold heart rate and sport-specific pace measurements retain date, reliability and value. Only current measured calibration with suitable equipment can produce numerical targets. Personal bests remain separate records and never silently become thresholds. Running trail/hills/strides, environmental caution and open-water swimming avoid inappropriate precise pace targets; short hard repetitions avoid lagging heart-rate targets. RPE remains available. The current 90-day freshness policy is configurable code, not a universal physiological expiry rule.

Pool configuration records length, metres/yards, strokes and comfortable length time. Distance repetitions use whole lengths and explicit rests. Without a length time, easy swimming uses time and unknown distance. Open water requires confirmations for the exact date, established experience, supervised venue, buddy, venue opening and venue-approved conditions. Only easy/recovery is supported; missing checks use a configured pool or fail. Confirmations do not establish safety. Current observations and future forecasts retain distinct dates/provenance; blocked outdoor sessions require confirmed indoor equipment or fail.

Strength uses bundled exercise IDs, implement requirements, difficulty, movement patterns, unilateral metadata, load mode and logging unit. Exact inventory overrides broad gym categories, including an empty inventory; legacy equipment bundles have a compatibility adapter. Splits rotate upper/lower or push/pull/legs; compound work precedes accessories. New exercises use familiarization and never borrow another exercise's kilograms. Assistance kilograms and bands do not receive ordinary plate progression. Bands record setup notes; repetitions, seconds, metres and minutes survive Room/cloud/CSV sync. Timed/distance quantities and band/assistance loads cannot produce ordinary repetition-based volume or 1RM records; server sync recomputes lifted volume from eligible sets. Catalog metadata is generated by `scripts/sync-exercise-metadata.ts`, with a parity regression test.

Complete rest, optional light activity, mobility and deliberate active recovery have separate objectives and dose blocks. Recovery recommendations do not become completed load automatically. Mobility is general comfortable movement, never injury rehabilitation. Other recorded activities remain actual shared fatigue while their sport-specific transfer stays uncertain.

## What happened versus what was planned

Cross-sport substitutions, shortened/longer sessions and easier/harder reported effort remain explicit evidence. Total duration cannot verify interval structure, strokes, technique or recovery execution. Exact strength exercise, movement coverage and same-muscle overlap are separate fields. Holds and carries are verified only when recorded units match; old repetition-only entries remain uncertain.

Strength workouts link to a planned session by UUID. Analysis/cache keys use the logged workout UUID, allowing two sessions on the same date. Date aggregates do not guess a matching plan. Watch enrichment requires a unique timestamp candidate within the engineering matching window, rather than the first activity on that date. Source writes invalidate affected caches. Owner checks and RLS protect session data.

## Interchange and verification

Both clients can export the complete prescription JSON. The server importer validates the versioned envelope and reconstructs its canonical workout. Intervals text exports explicit seconds/metres, converts yards and preserves work/rest repetition semantics. Supported absolute power and pace ranges are exported; unsupported absolute-HR transport stays an instruction rather than a fabricated zone. An independent parser tests our emitted subset. This establishes local fidelity, not real watch acceptance.

Validation commands:

```sh
scripts/dev.sh deno:test
scripts/dev.sh deno:check
(cd web && npx tsc --noEmit)
python3 scripts/engine-tests/run.py
python3 scripts/engine-tests/room_migration.py
(cd android && JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew testPlayDebugUnitTest testFossDebugUnitTest --no-daemon --no-parallel -Pksp.incremental=false -Pkotlin.incremental=false -Pkotlin.compiler.execution.strategy=in-process)
git diff --check
```

Latest completed shared validation: **671 tests passed**, all edge functions type-check, web TypeScript passes, all PostgreSQL scenarios pass, and Android Play/FOSS unit tests pass. `git diff --check` also passes. The SQLite migration contract test verifies preserved existing rows and exact schema/default parity for Room 8→9; physical-device migration validation remains separate.

The database runner creates an isolated PostgreSQL container, applies all migrations and tests retries, protected slots, rollback, independent calendar IDs, quantity units, session cache invalidation, ownership/RLS and atomic moves. Cron/net scheduling extensions are stubbed; real hosted cron and HTTP delivery are outside this harness. The runner removes its container on completion.

## Release validation still requiring external evidence

- Independent coaching review of each sport recipe, progression policy, recovery spacing, event policy and eligibility rule for intended athlete populations.
- Real Intervals.icu/trainer/watch tests, especially RPE-only sessions, pace ranges, yard conversion and transitions; Android physical-device rendering and existing-install Room migration checks.
- Production migration/function deployment, then staged monitoring of rejected proposals, failed sync, corrections and unwanted plan changes. No production deployment was performed for this task.

## Sources and policy limits

[TrainingPeaks power levels](https://www.trainingpeaks.com/blog/power-training-levels/) informs power bands. [USMS critical swim speed guidance](https://www.usms.org/fitness-and-training/articles-and-videos/articles/how-to-train-with-critical-swim-speed-intervals) supports swimming-specific calibration rather than running pace transfer. [USMS workout library](https://www.usms.org/workout-library/) describes workouts adapted to swimmer ability and pace/rest estimates.

[RNLI open-water guidance](https://rnli.org/water-safety/choose-your-activity/open-water-swimming) informs the supervised venue/buddy/conditions confirmations. [USA Triathlon brick guidance](https://www.usatriathlon.org/articles/training-tips/how-to-use-brick-workouts-in-triathlon-training) supports combined sessions for an actual multisport objective. [Intervals.icu syntax](https://forum.intervals.icu/t/workout-builder-syntax-quick-guide/123701) documents the transport subset. These sources inform representation and policy; they do not independently validate this implementation.

## Activity correction follow-up

A Home activity can be a digest placeholder (`digest:<date>:<name>`) rather than a saved database row. Never pass that ID, or a group derived from it, to `correct_session`, which requires UUIDs. Android now preserves the Intervals source ID in summaries and resolves a unique saved row before editing. Legacy summaries only resolve when name/date/type/duration yield one candidate; ambiguous candidates stay uneditable until resolved. A separate sync action handles activities that are not yet persisted.

Activity details now show classification as a compact summary by default. Editor data is loaded only after Edit; type, workout and outcome use selectors, while session parts/duplicates are optional additional controls. Saves use the current content revision, refresh Home/Calendar through `PlanChangeBus`, and update the visible classification. Correction errors use fixed user-facing messages; transport exceptions containing request headers must never be rendered.

Regression coverage is in Android `ActivityClassificationTest.kt`: temporary IDs, exact source identity, ambiguous legacy matches, plan-required outcomes and request-header redaction. Physical-device visual validation requires a connected device.

Activity correction validation: Android Play/FOSS unit tests pass, including the five new classification regressions; all 671 shared tests and the `intervals-stats` type check pass. No device was connected for installation or visual QA.
