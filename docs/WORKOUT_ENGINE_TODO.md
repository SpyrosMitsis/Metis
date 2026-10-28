# Workout engine improvement TODO

Scope: running, cycling, swimming, strength, recovery and mixed-sport programs. Walking, hiking, rowing and other imported activities must contribute appropriately to actual training history even when the app does not generate dedicated programs for them.

This is an implementation backlog, not a claim that proposed coaching policies have been validated. P0 implementation is in migration `20261022000047_engine_reliability.sql` and the shared generation/reconciliation paths, pending deployment and acceptance validation. Migrations 47 and 48 have not been deployed. Shared tests, edge-function type checks, Android unit tests for both flavors and web TypeScript checks have been run; see the dated implementation report for the latest results. Background and research: [Coach engine review](COACH_ENGINE_REVIEW_2026-10-22.md).

Priority: **P0** reliable data and preservation of user plans; **P1** prescription quality; **P2** adaptation and coaching; **P3** evaluated personalization. Implement shared foundations before adding model complexity. Numerical training thresholds should be configurable, sourced and reviewed for their intended population, rather than invented during implementation.

## P0 — Trustworthy observations and session matching

- [x] Introduce stable actual-session IDs, source IDs, timestamps, local dates and timezone provenance.
- [x] Persist explicit plan-to-actual links instead of repeatedly guessing from date and sport.
- [x] Represent completed-as-planned, modified, substituted, explicitly skipped, unplanned and unknown states separately.
- [x] Separate athlete-confirmed completion from inferred sport compatibility and measured dose adherence.
- [x] Handle multiple sessions on one day, sessions crossing midnight, and activities recorded in several parts. Ambiguous multi-session links abstain pending athlete correction; grouping is explicit.
- [x] Deduplicate same-source retries by stable source identity and high-confidence cross-source duplicates; keep uncertain pairs under athlete control.
- [x] Reconcile late synchronization and corrected activities idempotently; invalidate affected analysis without counting hidden duplicate rows.
- [x] Track synchronization freshness and missing data; never interpret an unavailable feed as confirmed inactivity.
- [x] Let the athlete correct session links and classifications; retain those corrections during later syncs, with a way to restore hidden duplicates.
- [x] Keep all effective actual training in load history, including activities that do not match the proposed workout.
- [x] Preserve measurement provenance: observed, user-reported, estimated or unavailable.
- [x] Distinguish zero from missing values and normalize stored time/distance units consistently.
- [x] Make calendar, coach context, adherence, analysis and planning consume the shared reconciliation views.

Acceptance: double sessions, duplicate imports, midnight boundaries, late sync, unrelated activities and explicit skips produce consistent results across clients. Reprocessing the same inputs does not change totals or duplicate records.

## P0 — Reliable generation and storage

- [x] Validate the complete replacement plan before changing the existing plan.
- [x] Replace plans transactionally; retain the last valid plan if any write fails.
- [x] Add version checks and idempotency keys for concurrent generation, retries and user edits.
- [x] Preserve completed, skipped and athlete-locked sessions; template scheduling is additive and rejects occupied dates.
- [x] Coordinate external calendar/watch updates through a retryable outbox, including scheduled retry delivery.
- [x] Define typed, machine-readable review issues alongside human-readable messages.
- [x] Apply the shared final validation to daily and weekly generation, including repair attempts.
- [x] Make catalog enforcement independent of a caller remembering an optional flag such as `catalogOnly`.
- [x] Distinguish generation failure from an intentional recovery day; failed generation retains the existing plan.
- [x] Gate fallback behavior on known athlete constraints; no reviewed generic fallback is defined yet, so unsafe/invalid generation retains the existing plan and reports the failure.
- [x] Version prescriptions, policy rules, templates and model configurations for reproducible debugging. Generated rows store the engine version, provider/model and request ID; template scheduling hashes the exact template structure into its idempotency scope and result metadata.

Acceptance: simulated provider timeouts, malformed output, failed inserts and concurrent edits never erase a valid plan or silently overwrite an athlete's newer choice.

### P0 implementation notes for future work

- `effective_activities` is the deduplicated observation surface. `reconciled_plans` is the shared plan status surface. Use these for reads; write provider observations to `completed_activities` and let the trigger maintain identity and links.
- A sport/date candidate is only an inferred link (`link_source = inferred`, `session_state = unknown`). It must not be described as completed. Athlete corrections use `correct_session` and are marked `link_source = athlete`.
- Generation routes use `_shared/plan_store.ts`: validate first, take a plan revision, then call `replace_generated_plan` with an idempotency request ID. The SQL function preserves completed, skipped and locked rows. Template scheduling uses additive mode and rejects occupied dates.
- `calendar_outbox` stores provider work in the same transaction as a plan change. `_shared/calendar_outbox.ts` leases and retries jobs; `/sync-calendar` is also scheduled every five minutes. Set the same `app.functions_base_url` and `app.service_role_key` database settings used by the existing cron integration.
- Cross-source auto-dedup requires matching sport, start time within ten seconds, duration within thirty seconds and distance within one percent (or unavailable distance). Fuzzier records are never auto-hidden; the activity detail correction picker allows an athlete to mark a duplicate manually. Every hidden duplicate can be restored from activity detail.
- Remaining P0 caveats: ambiguous two-session days require athlete correction; multi-part activity grouping is currently user-directed; fuzzy duplicate suggestions are not ranked; there is no reviewed fallback workout. Coach-approved acceptance scenarios still need to be run after deployment.
- The migration is pending and has not been applied to a database. Apply it before deploying edge functions or Android/web changes; clients will otherwise call views/RPCs that do not exist.

P1 engineering implementation and codebase map: [Prescription engine implementation, 2026-10-23](PRESCRIPTION_ENGINE_IMPLEMENTATION_2026-10-23.md). New daily, weekly and template sessions require typed compilation and independent publication checks. Completed items below describe implemented engineering behavior, not independent coach certification. External review and device validation remain explicitly listed after P1. Changes are local; production migrations 47–51 and function deployment are pending.

## P1 — Shared deterministic prescription engine

- [x] Define a common session model: objective, sport, warm-up, main work, recovery intervals, cool-down, target intensity and estimated duration.
- [x] Add sport-specific typed prescriptions rather than forcing every sport through strength-style exercise fields.
- [x] Construct candidate sessions from versioned sport templates and validated athlete data; obtain independent template review before release.
- [x] Separate hard constraints from preferences and ranking criteria.
- [x] Make code authoritative for dates, equipment, eligibility, dose calculation and progression limits.
- [x] Restrict models to proposing candidates or interpreting intent; validate every final prescription independently.
- [x] Calculate total duration from work, rest, warm-up, transitions and cool-down; recompute after edits.
- [x] Respect both daily time limits and the weekly time budget.
- [x] Select intensity measures supported by available data and equipment; avoid unsupported numerical precision.
- [x] Track age and reliability of thresholds, personal bests and other calibration measurements.
- [x] Establish a conservative calibration/familiarization workflow for new athletes and unfamiliar activities.
- [x] Provide supported alternatives when equipment, venue or conditions prevent the primary session.
- [x] Record the reason a session was selected and why alternatives were rejected.
- [x] Prevent generated descriptions from contradicting structured durations, targets or constraints.

Acceptance: identical athlete state and policy version yield reproducible valid prescriptions; explanations cannot change the underlying plan.

## P1 — Longitudinal programs for every sport

- [x] Maintain an explicit multiweek program with goals, priorities, phases and progression state.
- [x] Distinguish general fitness, performance, technique, strength, hypertrophy and return-to-consistency objectives.
- [x] Preserve successful sessions and useful continuity instead of regenerating the whole program unnecessarily.
- [x] Progress from actual completed work and response, not from planned work that never happened.
- [x] Separate progression of frequency, duration, volume, density and intensity; avoid increasing everything together without justification.
- [x] Define when to progress, repeat, reduce, substitute or reassess.
- [x] Support reduced-load periods and event preparation using goal-specific policies.
- [x] Handle interruptions, travel and long breaks without automatically resuming the previous peak workload.
- [x] Keep event dates and priorities structured, including competing events or goals.
- [x] Reassess goals and expected timelines when availability or training history changes materially.

Acceptance: a multiweek simulation with missed sessions, extra training and changing availability remains coherent and does not accumulate training debt.

## P1 — Running workout quality

- [x] Create versioned, test-covered templates for easy running, long runs, recovery runs, run/walk progression, strides, hills, tempo/threshold work and intervals.
- [x] Match templates to experience, current running exposure, goal distance and available time.
- [x] Express interval repetitions, work duration/distance, recovery mode and recovery duration explicitly.
- [x] Verify total distance and time, including warm-up, recoveries and cool-down.
- [x] Calibrate pace and heart-rate targets from appropriate running data; support perceived-effort targets when calibration is missing.
- [x] Account for terrain, elevation, treadmill context and environmental conditions when interpreting pace.
- [x] Track running-specific exposure separately from cycling or other cardiovascular work.
- [x] Manage placement of long runs, demanding intervals and lower-body strength sessions jointly.
- [x] Evaluate execution by intended stimulus: an easy run is not unsuccessful because it was slower than an arbitrary pace.
- [x] Distinguish easy running replacing intervals, shortened long runs and planned run/walk sessions from full completion.
- [x] Support event-specific preparation and reduced training before events without applying one schedule universally.

Acceptance: every running session is executable from its instructions and fits the athlete's running history, goal and current constraints.

## P1 — Cycling workout quality

- [x] Create versioned, test-covered templates for endurance, recovery, tempo, threshold, higher-intensity intervals, long rides and technique/cadence work.
- [x] Use cycling-specific power or heart-rate calibration; track threshold freshness and uncertainty.
- [x] Provide heart-rate or perceived-effort alternatives when no power meter is available.
- [x] Distinguish indoor trainer, outdoor road, gravel and mountain-bike contexts where supported by the athlete profile.
- [x] Prefer time-based prescriptions when terrain, traffic or wind makes distance a poor workload target.
- [x] Specify interval targets, recoveries, repetitions and total session duration consistently.
- [x] Avoid interpreting coasting, stops or terrain-driven power variation as simple noncompliance.
- [x] Evaluate group rides and unscheduled hard rides as actual load even when they replace a different planned session.
- [x] Schedule demanding rides with running and strength fatigue in mind.
- [x] Export structured trainer/watch workouts and test unit/target fidelity on reimport.

Acceptance: indoor and outdoor versions preserve the intended training objective without requiring unavailable equipment or unrealistic continuous targets.

## P1 — Swimming workout quality

- [x] Create versioned, test-covered templates for technique, easy aerobic work, endurance, threshold and intervals.
- [x] Collect pool length, preferred units, swimming experience, supported strokes and available equipment.
- [x] Make set distances compatible with pool length and verify the complete session distance.
- [x] Specify repetitions, stroke, drill, rest or send-off clearly; do not confuse rest duration with interval start time.
- [x] Use appropriate swim-specific pace calibration when available and effort-based alternatives otherwise.
- [x] Scale drills and complexity to demonstrated skill and confidence.
- [x] Include warm-up and cool-down and realistic estimates for rest and transitions.
- [x] Distinguish pool and open-water sessions; do not transfer pool precision uncritically to open water.
- [x] Define explicit open-water eligibility and conditions policies rather than letting a model invent reassurance about safety.
- [x] Handle missing heart rate, unreliable distance and rest detection without manufacturing precise adherence scores.
- [x] Account for shoulder/upper-body fatigue and relevant strength work when scheduling.
- [x] Treat partial sets, technique substitutions and shortened sessions as structured modifications.

Acceptance: pool workouts add up correctly, can be followed at the stated pool length and remain meaningful when wearable measurements are incomplete.

## P1 — Strength workout quality

- [x] Add stable exercise IDs, movement patterns, required implements, difficulty and supported logging units.
- [x] Replace broad equipment tiers with actual implement requirements, including benches, racks, bars and assistance machines.
- [x] Add resistance-band support consistently across catalog, availability filtering, prescriptions and logging.
- [x] Create curated substitution groups; separate same-muscle overlap from equivalent movement or training objective.
- [x] Support goal-specific templates for general strength, hypertrophy and other explicitly supported goals.
- [x] Order exercises deliberately and balance compound work, accessories and session fatigue.
- [x] Prescribe warm-up sets, working sets, reps, rest and effort targets distinctly.
- [x] Calculate initial loads from the exercise's own history; use familiarization when reliable history is absent.
- [x] Make progression recovery-aware; allow repeating or reducing work without an automatic correction back to the previous load.
- [x] Never transfer target kilograms directly across different equipment or exercises.
- [x] Model unilateral work, bodyweight/assisted movements, timed holds and carries appropriately.
- [x] Separate exact exercise completion, movement coverage and completed dose in the debrief.
- [x] Audit catalog gaps periodically and preserve Android/server parity automatically.

Acceptance: workouts use available equipment and bundled exercises, fit the time budget and have an explainable progression from actual logged performance.

## P1 — Recovery, mobility and other activities

- [x] Distinguish complete rest, optional light activity, mobility and a deliberately prescribed recovery session.
- [x] Avoid assigning fictitious completed load to an unperformed recovery recommendation.
- [x] Build explicit mobility templates with clear movements, duration and required equipment.
- [x] Avoid presenting generic mobility as rehabilitation for an injury.
- [x] Account for walks, hikes, rowing, classes, sport matches and physical work without assuming they replace sport-specific training.
- [x] Allow the athlete to report the duration and effort of activities lacking device recordings.
- [x] Keep unsupported activity types visible and explain uncertainty rather than silently forcing them into the nearest supported sport.
- [x] Require dedicated templates, dose models and validation before adding generation support for another sport.

## P1 — Mixed-sport scheduling

- [x] Represent primary and secondary goals explicitly.
- [x] Maintain sport-specific load alongside shared fatigue indicators; do not treat equal estimated load as interchangeable stimulus.
- [x] Track overlapping muscular/mechanical demands across sports.
- [x] Schedule demanding sessions, long sessions and strength work jointly rather than using independent sport calendars.
- [x] Respect double-session availability and recovery between sessions.
- [x] Define explicit cross-training substitution policies, including what benefit is preserved and what is not.
- [x] Handle competing events and goal priorities without promising simultaneous maximum progress everywhere.
- [x] Support combined sessions and transitions only when they serve an actual multisport goal.
- [x] Explain which goal is prioritized when time or recovery requires a tradeoff.

Acceptance: an unscheduled hard ride or heavy leg session can influence the next run without being counted as completed running-specific work.

## P1 — External release validation

These require evidence beyond local implementation and remain open:

- [ ] Independent coach review of sport recipes, dose/progression defaults, event policies and recovery/open-water eligibility for intended populations.
- [ ] Real trainer/watch export acceptance and reimport checks, plus Android physical-device rendering and existing-install Room migration validation.
- [ ] Apply production migrations and deploy functions, then verify hosted cron/outbox delivery and staged rollout monitoring.

P2 implementation and operating guide: [Adaptation, feedback and evaluation, 2026-10-26](P2_ADAPTATION_IMPLEMENTATION_2026-10-26.md). Engineering changes are local. Rollout defaults to preview-only; independent review, real device/provider evidence and production deployment remain separate requirements.

## P2 — Adaptation after changes or missed sessions

- [x] Collect concise reasons for changes: time, fatigue, pain, illness, equipment, conditions, preference or other.
- [x] Ask only when the missing information could materially change the next decision.
- [x] Define different adaptation policies for skipped, shortened, easier, harder and substituted sessions.
- [x] Preserve completed training and athlete-locked commitments during adaptation.
- [x] Replan the smallest necessary part of the schedule instead of replacing everything by default.
- [x] Explain the proposed change and offer feasible alternatives when the decision is preference-sensitive.
- [x] Prevent missed-session accumulation and inappropriate catch-up schedules.
- [x] Recompute future progression from actual dose and response.
- [x] Handle conflicting user feedback and device data explicitly, retaining both sources.
- [x] Allow undo and inspection of previous plan versions.

Acceptance: the same missed workout produces different justified adjustments for lack of time, unavailable equipment and illness; missing sync remains unknown until resolved.

## P2 — Readiness, feedback and coaching communication

- [x] Combine relevant subjective feedback and observed training without treating any single metric as an oracle.
- [x] Track soreness location, perceived effort, enjoyment and session difficulty with minimal input burden.
- [x] Separate pain reports from normal effort or soreness; enforce existing backoffs and explicit planning holds.
- [ ] Independently review pain/illness escalation, hold and return-to-training policies for intended populations.
- [x] Treat readiness with no measurements as unknown rather than a precise midrange score.
- [x] Keep load ratios descriptive; avoid unsupported diagnoses of overtraining or precise injury risk.
- [x] Distinguish execution adherence from training quality: an appropriate adjustment can be a good decision despite deviating from the plan.
- [x] Explain what happened, what is uncertain, what changes and why.
- [x] Give one useful next action instead of reciting metrics or scolding noncompliance.
- [x] Keep numeric claims grounded in structured data and label estimates.
- [x] Check that chat advice, workout instructions and the saved plan agree.

## P2 — Independent evaluation and observability

- [x] Build versioned scenario sets and independent-review packets for each supported sport and mixed-sport schedules.
- [ ] Obtain independent coach review of the cases and expected judgments; no review is fabricated by the runner.
- [x] Include novice/experienced athletes, sparse history, stale thresholds, limited equipment and restricted availability.
- [x] Include missed weeks, changed activities, pain/illness reports, bad weather, duplicate imports, late sync and two-session days.
- [x] Test matching accuracy separately from prescription quality and explanation quality.
- [x] Implement and exercise false-completion, missed-match, abstention and correction metrics by sport; population accuracy still requires independently labeled production observations.
- [x] Measure equipment/catalog violations, dose arithmetic, availability and failed replacement; retain independent coaching review for realistic execution estimates.
- [x] Evaluate multiweek behavior, not just individual attractive-looking workouts.
- [ ] Complete independent expert review in addition to the engineering checks; the release gate requires it.
- [x] Align the offline evaluation harness with every production constraint, including catalog enforcement.
- [x] Track user-reported usefulness, adherence and unwanted plan changes without treating engagement alone as training success.
- [x] Record policy decisions, input provenance, model versions and correction reasons with appropriate retention/access controls.
- [x] Add regression cases for every confirmed production failure.
- [x] Run local export/import round-trip and unit/target checks; add isolated phone UI/Room fixtures.
- [ ] Run those phone fixtures after Android installation approval and complete real trainer/watch acceptance checks. The connected device rejected APK installation before tests ran.
- [x] Establish release gates and a staged rollout/rollback process for prescription changes.

## P3 — Jev and other model experiments

- [ ] Establish rule-based and existing-LLM baselines before introducing a new provider.
- [ ] Evaluate Jev on narrow feedback interpretation and clarification tasks across every supported sport.
- [ ] Include explicit unknown/other outcomes and independently labeled ambiguous cases.
- [ ] Evaluate classification and calibration per task; do not equate schema validity or reported confidence with correctness.
- [ ] Run new classifiers in shadow mode before allowing their output to influence plans.
- [ ] Compare accuracy, harmful errors, abstention, latency, cost and outage behavior.
- [ ] Keep deterministic constraints authoritative regardless of classifier confidence.
- [ ] Pin model versions and rerun regression evaluations before upgrades.
- [ ] Review provider data handling before sending athlete health information; minimize transmitted context.
- [ ] Consider simple statistical/tabular ranking models only after collecting suitable labeled outcomes.
- [ ] Evaluate raw-sensor activity recognition only if raw-sensor detection becomes a product requirement.
- [ ] Defer reinforcement-learning exploration of training prescriptions; initially personalize low-risk preferences within validated constraints.

## Already completed in the preceding review

These are foundations, not completion of the broader tasks above:

- [x] Restrict newly generated strength exercises to the bundled library in both generation paths.
- [x] Remove automatic registration of model-invented custom exercises.
- [x] Expand the permanent catalog from 93 to 119 entries and test Android/server parity.
- [x] Stop matching walking to running and generic `Workout` labels to strength automatically.
- [x] Apply one-to-one matching within adherence context and Android reconciliation.
- [x] Bound actual adherence load to the requested historical date window.
- [x] Distinguish missing recordings from confirmed misses in coaching context.
- [x] Stop transferring prescribed weights to detected strength substitutions and qualify muscle coverage.

## Suggested delivery order

1. P0 session identity, reconciliation and atomic persistence.
2. Shared session schema, exercise/equipment metadata and deterministic construction interfaces.
3. Reviewed sport-specific templates and longitudinal progression, integrated with mixed-sport constraints.
4. Reason-aware adaptation, coaching explanations and user correction flows.
5. Independent evaluations throughout; controlled rollout of each completed slice.
6. Jev or other classifier experiments after trustworthy baselines exist.

For each implementation ticket, record owner, dependencies, acceptance scenarios, verification evidence and rollout status before marking it complete.
