# Workout detection, prescription and coaching review

Reviewed 2026-10-22. Scope: Android, shared Deno coaching engine, single-session and weekly generation, activity analysis, catalog, and TypeSafe AI's **System One / Jev**. Jev is not JEPA. Research and code inspection are not a clinical validation or a measured comparison of model accuracy. Existing unrelated working-tree changes were preserved. No production deployment or paid model benchmark was performed.

## Decision

Use a **deterministic prescription and adaptation engine, with models at well-defined interpretation and communication boundaries**. Keep the LLM for conversation, extracting intent, explaining decisions and proposing candidates. Make code authoritative for catalog membership, available equipment, dates, progression, constraints, allowable changes and persistence. Introduce a classifier only where rules cannot interpret the input reliably, and measure it against a simpler baseline first.

The current application is already a hybrid: an LLM proposes the program and deterministic functions review it. That is a useful foundation, but the model still makes substantial scheduling and prescription decisions. The present implementation should not be described as a validated expert coach. The largest immediate quality gains come from reliable session identity, actual-versus-planned reconciliation and consistent policy, rather than switching model providers.

## What the app currently does

| Concern | Code to read | Behavior and limits |
|---|---|---|
| Single session | `supabase/functions/generate-workout/index.ts` | Builds athlete context, asks the LLM for JSON, validates shape, reviews content, attempts a content repair, persists the corrected result. Empty content falls back to recovery. |
| Weekly planning | `supabase/functions/plan-week/index.ts`, `_shared/week_planning.ts`, `_shared/plan_checks.ts` | LLM creates days; structured availability, pauses and locked days constrain scheduling. Per-day review carries load and muscle state forward. This is not a constraint optimizer. |
| Prescription rules | `_shared/workout_review.ts`, `_shared/progression.ts`, `_shared/injury.ts` | Double progression, load checks, volume/recovery rules, readiness, injury/backoff filters, equipment categories and estimated TSS. Thresholds and injury regexes are policy heuristics, not proof of medical safety. |
| Imported activity detection | Android `health/HealthConnectManager.kt`, `sync-intervals/index.ts` | Primarily imports already classified exercise sessions and measurements. This is not a raw accelerometer recognition engine. |
| Endurance debrief | `_shared/analyze_core.ts`, `_shared/analysis.ts` | Same-date sport match followed by analysis of available duration, intensity and streams. A sport match alone does not establish completion of the prescribed workout. |
| Strength debrief | `_shared/analyze_core.ts` | Aggregates logged sets by date, matches a strength plan, combines logger/watch information. Same-primary-muscle coverage is only a coarse substitution proxy. |
| Adherence context | `_shared/context.ts::adherenceBlock` | Supplies recent plan-versus-actual context to coaching/generation. Now distinguishes explicit completion, sport matches, explicit skips, and unmatched recordings. |
| User-triggered adaptation | Android `data/WorkoutRepositoryPlan.kt::adaptWeek` | Reconciles past plans and calls weekly generation from today. This is not a continuous, transactionally versioned adaptation service. |
| Exercise collection | Android `strength/ExerciseCatalog.kt`, `_shared/exercise_catalog.ts` | Mirrored bundled names and metadata, with manual custom exercises retained for logging/history. Generated strength plans now use bundled entries only. |

## Defects corrected in this pass

1. **AI-created exercises escaped the library.** The prompt explicitly allowed inventions and both generators automatically registered them as custom exercises. Removed that registration mechanism and prompt exception. Both generation paths enable `catalogOnly` review, including the single-session repair pass. Review removes unknown entries, reports the problem for repair, canonicalizes accepted spelling and overwrites AI muscle/equipment metadata from the library. It does not guess a different equipment variant through fuzzy matching. A completely empty session uses the existing fallback; partially corrected sessions retain their valid entries. Historical plans and manual custom exercises are not deleted or rewritten.
2. **The permanent collection lacked practical alternatives.** Expanded from **93 to 119 entries**, mirrored on Android and server. Added home lower-body movements, dumbbell alternatives, core work and selected gym variations. A parity test checks every name, muscle, category and compound flag, as well as duplicate normalized names.
3. **Any activity could count as completion in adherence context.** Replaced date-only detection with one-to-one date-and-sport matching. Explicit completion and skip feedback take precedence. A walk no longer satisfies a run. Generic `Workout` no longer establishes strength training. Unmatched observations still contribute actual load.
4. **Historical load included activities on/after the cutoff.** Actual activities now use the same `[since, beforeDate)` window as planned sessions.
5. **Missing recordings were described as missed workouts, and high load as overtraining.** Context now acknowledges missing synchronization/unlogged training and reports load deviation without diagnosing overtraining. It instructs the coach not to cram missed sessions.
6. **Android reconciliation reused recordings and overstated successful saves.** Matching consumes each recording once, reserves recordings for explicitly completed sessions, honors skipped sessions, and increments successful reconciliation only after a successful write. Calendar and notification sport matching now share the same Android helper.
7. **Substitutions inherited another exercise's target weight.** Strength debrief no longer attaches prescribed kilograms to same-muscle substitutions. Substring names no longer count as identical movements. The prompt and displayed coverage text explain that primary-muscle overlap is not proof of equivalent training; feedback must avoid comparing weights across different exercises/equipment.
8. **An empty generation fallback blamed an injury even when the catalog caused the failure.** Updated the explanation to identify the library/current constraints without inventing an injury.

### Permanent additions

- Chest: Incline Push-Up; Dumbbell Floor Press.
- Back: Chest-Supported Dumbbell Row; Assisted Pull-Up; Inverted Row.
- Shoulders: Pike Push-Up; Dumbbell Shrug.
- Quads: Bodyweight Squat; Reverse Lunge (Bodyweight); Split Squat (Bodyweight); Reverse Lunge (Dumbbell); Kettlebell Goblet Squat.
- Hamstrings: Romanian Deadlift (Dumbbell); Single-Leg Romanian Deadlift (Dumbbell); Kettlebell Deadlift.
- Glutes: Glute Bridge (Bodyweight); Single-Leg Glute Bridge; Hip Thrust (Dumbbell).
- Calves: Standing Calf Raise (Bodyweight); Single-Leg Calf Raise (Bodyweight); Standing Calf Raise (Dumbbell).
- Core: Side Plank; Dead Bug; Bird Dog; Pallof Press; Reverse Crunch.

The list now covers more common movement/equipment combinations; it is not exhaustive. More entries alone do not produce better programs. Next catalog work should add stable IDs, movement patterns, required implements (bench, pull-up bar, etc.), unilateral/bilateral and timed/repetition metadata, and curated substitution groups. Resistance bands and specialty equipment still need a consistent category/availability model. The current broad `Bodyweight` category does not guarantee an exercise needs no equipment: an inverted row needs a suitable support. Likewise, the legacy dumbbell equipment tier includes kettlebells. These are remaining equipment-model limitations, not solved by catalog membership.

## What should happen when reality differs from the plan?

| Situation | Current behavior / remaining risk | Recommended coaching policy |
|---|---|---|
| No recording | Context now marks unmatched rather than declaring a miss. Android adaptation still uses a coarse unmatched/missed count. | Check synchronization and ask whether the session happened. Unknown is a first-class state. |
| Explicitly skipped | Context honors the skip; adaptation leaves it alone. | Ask for the reason when useful: time, fatigue, pain, preference, illness or equipment. Drop, shorten or reschedule based on that reason. Never accumulate training debt automatically. |
| Planned run, actual walk | No longer auto-matched as a run. Walking still contributes recorded load. | Acknowledge activity; distinguish recovery activity from the intended running stimulus. |
| Planned intervals, actual easy run | Sport match can still look completed; intensity debrief can reveal deviation. | Mark a modified session, preserve actual easy load, reassess the next hard day. Do not pretend interval stimulus happened. |
| Planned strength, actual cycling | Separate activity rather than strength completion in context. | Count cardiovascular work; strength-specific progression remains based on actual lifting. |
| Different lifting exercise | Possible same-muscle substitution, now explicitly qualified. | Compare movement, goal, effort, range and dose. Establish load from the replacement's own history. |
| Two sessions on one date | Context/adaptation now consume recordings once, but analysis still picks a same-date plan and strength analysis is date-aggregated. | Persist session links and timestamps; support explicit split/combined recordings. Avoid grading both sessions against the first plan. |
| More/harder work than planned | Actual load reaches context; no justified diagnosis follows from a ratio alone. | Reassess fatigue, subjective effort, symptoms and schedule before adding more work. |
| Equipment unavailable | Library membership is enforced, but equipment tiers remain coarse. | Select a curated alternative with compatible movement/goal and known available implements; otherwise change the session transparently. |

A professional response explains the observation, its uncertainty, the consequence for the goal, and a small concrete adjustment. Example: “You rode instead of lifting. That still adds training load, but it does not provide the planned strength work. Was the change due to time or soreness? We can move the lift only if your next sessions leave enough recovery.” That is more useful than an unexplained compliance score.

## Architecture to build toward

1. **Observation layer:** retain source IDs, timestamps, timezone, synchronization freshness, actual session type, sets/reps/load, duration, available intensity, RPE/RIR and user corrections. Deduplicate sources before summing load. Preserve absent values instead of inventing measurements.
2. **Reconciliation layer:** store a durable plan-to-actual link, evidence and status: planned, completed-as-planned, modified, substituted, skipped, unplanned or unknown. Prefer an explicit link over heuristic matching. In ambiguous double-session cases ask instead of guessing.
3. **Policy layer:** convert goals, schedule, actual history and constraints into admissible sessions and progression targets. Separate hard constraints from adjustable preferences. Version policies and record why a change happened. Existing progression and review modules are starting points.
4. **Candidate construction:** instantiate reviewed templates and exercise IDs, calculate dose deterministically, filter constraints, then rank feasible candidates. Stable exercises enable interpretable progression; novelty should serve a reason. This can work without a new ML model.
5. **Optional interpretation/ranking model:** classify free-text reasons, infer a tentative intent or rank already-valid options. Include `unknown`/`needs clarification`; a classifier cannot override the policy layer.
6. **Explanation layer:** provide the LLM the selected decision, evidence and allowed alternatives. It explains these without inventing metrics or changing the prescription in prose.
7. **Persistence:** validate the final plan before replacement and use a transaction/version check. Keep the last valid plan on failure. Current weekly replacement deletes open plans before the later insert and is not atomic; that deserves a dedicated migration and failure/concurrency tests.

## Jev, LLMs and other classifiers

| Option | Appropriate role here | Limitation / decision |
|---|---|---|
| Deterministic rules + templates | Eligibility, catalog, dates, arithmetic, progression and reproducible constraints | Best initial investment. Requires domain-reviewed policies and explicit uncertainty; deterministic mistakes are still mistakes. |
| General LLM with schema validation | Conversation, explaining decisions, extracting complex user intent, bounded candidate proposals | Flexible, but valid JSON is not a valid prescription. Keep the current review and strengthen policy ownership. |
| TypeSafe Jev | Narrow text decisions such as reason-for-change, whether clarification is needed, or choosing among feasible alternatives | Worth an offline comparison; not a replacement for a longitudinal planning engine. No workout-specific outcome validation was established in this review. |
| Logistic regression / boosted trees | Tabular prediction/ranking when enough labeled local outcomes exist | Good baseline candidates. The app does not yet establish a sufficient labeled training/evaluation dataset; do not train a bespoke recommender on one athlete and claim generality. |
| Embedding similarity | Retrieve related exercise descriptions or historical examples | Similarity is not physiological equivalence. It must not authorize substitutions or transfer target kilograms. |
| Wearable time-series models | Recognizing activities from raw sensor streams if that product capability is added | Different problem and data modality from the app's current imported session summaries. |
| Contextual bandits / reinforcement learning | Later personalization of low-risk preferences | Defer. Confounded feedback, sparse outcomes and exploration costs make this a poor first step for prescribing training load. |

TypeSafe documents Jev as typed questions over supplied state, with Choice, Score and Noul primitives. Its recommended decomposition fits narrow interpretation decisions followed by ordinary code. This supports the architecture above; it does not demonstrate that Jev knows which program will improve an athlete. [TypeSafe introduction](https://docs.typesafe.ai/introduction)

The launch's no-type-error claim concerns output structure. A schema-valid choice can still be the wrong choice. Vendor workflow demonstrations and speed/cost claims should not be treated as independent coaching benchmarks. [TypeSafe launch and evaluation qualifications](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

Do not treat Jev's `confidence` field as a direct measured probability that an action is safe. Choice confidence is a rescaling of the largest answer probability relative to a uniform distribution; Score uses a different formula. Thresholds need validation on our own questions and data, including out-of-distribution examples. [Confidence specification](https://docs.typesafe.ai/confidence)

As of this review, TypeSafe also describes image, bounding-box and longer-context capabilities as experimental. They are not a reason to add form assessment or sensor recognition to this app without a separate evaluation. [October 2026 release](https://typesafe.ai/blog/jev-1-14)

**Recommended Jev experiment, not yet implemented:** anonymized short feedback → `{reason: time|fatigue|pain|equipment|preference|other|unknown, clarification_needed}`. Compare Jev, the existing LLM and rules against independently labeled examples. Run in shadow mode with no automatic schedule writes. Pin the model version, record per-class errors and abstention, measure calibration and latency/cost, and handle timeout/provider failure locally. Explicit pain reports must remain visible even if a classifier disagrees. Do not silently send health context to a new provider.

## Training evidence and its implications

The 2026 ACSM position-stand announcement emphasizes consistent participation and individualization, with load/volume depending on the desired outcome. My design inference is to prioritize usable, repeatable programs and goal-specific templates over constant exercise novelty or a single universal volume target. Its scope is healthy adults; it does not validate this application's injury rules. [ACSM 2026 guidance](https://acsm.org/resistance-training-guidelines-update-2026/)

Training-load monitoring is a multidisciplinary problem involving internal and external load. Preserve actual performance and subjective response instead of collapsing every sport into one apparent measure of readiness. [Monitoring Athlete Training Loads consensus](https://pubmed.ncbi.nlm.nih.gov/28463642/)

The ACWR literature includes substantial conceptual and methodological criticism. Use load ratios as descriptive context rather than a personalized probability of injury or an overtraining diagnosis. [Impellizzeri et al., 2020](https://pubmed.ncbi.nlm.nih.gov/32502973/)

There is credible research on self-supervised wearable activity recognition, including a model trained on 700,000 person-days of accelerometer data. That supports investigating specialized sensor models **if raw-sensor recognition becomes a requirement**; it does not establish workout-prescription ability or justify adding one to a summary-based import pipeline. [npj Digital Medicine, 2024](https://www.nature.com/articles/s41746-024-01062-3)

## Remaining priorities and acceptance criteria

**First:** durable session reconciliation and transactional plan replacement. Evaluate doubles, late sync, duplicate sources, explicit skip, partial completion and unscheduled training. One-to-one matching in this patch is scoped to adherence context and Android adaptation; it is not a global database uniqueness guarantee.

**Next:** separate exact exercise completion, muscle coverage and dose adherence in scoring; use movement-pattern substitution groups. Add an explicit recovery-aware progression policy rather than universally treating a lower load than the prior top set as an error. Improve equipment constraints using the existing onboarding equipment list and required implements. Estimate remaining-session duration after removals rather than leaving the model's original duration untouched.

**Then:** templates/policy engine and model comparison. Current offline evaluation checks useful invariants, but tests of the engine's own rules are not independent expert validation. Align the evaluation harness with production catalog enforcement; historical-review callers can currently omit `catalogOnly`, while both production generation paths explicitly enable it.

A useful evaluation set includes: beginners, experienced lifters, mixed sports, only bodyweight/dumbbells, unavailable bench/bar, missed week, illness/pain report, easy run replacing intervals, unrelated activity, different lift, duplicate import, two sessions/day, stale measurements and conflicting feedback. Use coach-reviewed expected decisions and held-out users/time periods. Measure:

- False completion and missed-match rates by sport; ambiguity/abstention and correction rates.
- Catalog/equipment/date constraint violations, invalid prescriptions and loss of existing plans on failure.
- Goal-appropriate dose, consistency of progression and quality of adaptation, assessed independently by qualified coaches.
- Calibration/Brier score and error rate among automatically accepted classifier decisions.
- User adherence, perceived usefulness and unwanted plan changes; latency, provider cost and failure recovery.

## Verification and rollout

- Shared Deno suite: **620 passed, 0 failed** after the changes.
- `scripts/dev.sh deno:check`: all edge-function entry points passed.
- Android Play and Foss debug JVM suites: **243 tests passed per flavor**; includes regression coverage for sport matching.
- New tests cover catalog parity, unknown removal, canonical metadata, equipment filtering after catalog validation, empty-catalog fallback input, one-to-one adherence and date boundaries, plus substring substitution handling.
- No live provider evaluation, device UX test, release build or production deployment was performed for this pass.
- Server rollout must include callers of changed shared modules (generation, analysis, context and coach brief). Android requires a new build for the expanded picker and matching fixes. No database migration is required by this patch. The earlier Android sync migration remains a separate outstanding rollout item documented in the Android review.
