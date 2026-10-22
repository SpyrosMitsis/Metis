# Workout engine improvement TODO

Scope: running, cycling, swimming, strength, recovery and mixed-sport programs. Walking, hiking, rowing and other imported activities must contribute appropriately to actual training history even when the app does not generate dedicated programs for them.

This is an implementation backlog, not a claim that the features are already implemented or that proposed coaching policies have been validated. Background and research: [Coach engine review](COACH_ENGINE_REVIEW_2026-10-22.md).

Priority: **P0** reliable data and preservation of user plans; **P1** prescription quality; **P2** adaptation and coaching; **P3** evaluated personalization. Implement shared foundations before adding model complexity. Numerical training thresholds should be configurable, sourced and reviewed for their intended population, rather than invented during implementation.

## P0 — Trustworthy observations and session matching

- [ ] Introduce stable actual-session IDs, source IDs, timestamps, local dates and timezone provenance.
- [ ] Persist explicit plan-to-actual links instead of repeatedly guessing from date and sport.
- [ ] Represent completed-as-planned, modified, substituted, explicitly skipped, unplanned and unknown states separately.
- [ ] Separate athlete-confirmed completion from inferred sport compatibility and measured dose adherence.
- [ ] Handle multiple sessions on one day, sessions crossing midnight, and activities recorded in several parts.
- [ ] Deduplicate the same session imported from a watch, Health Connect, Intervals.icu and manual logging without merging distinct sessions.
- [ ] Reconcile late synchronization and corrected activities idempotently; update affected analysis without duplicating load or feedback.
- [ ] Track synchronization freshness and missing data; never interpret an unavailable feed as confirmed inactivity.
- [ ] Let the athlete correct session links and classifications; retain those corrections during later syncs.
- [ ] Keep all actual training in load history, including activities that do not match the proposed workout.
- [ ] Preserve measurement provenance: observed, user-reported, estimated or unavailable.
- [ ] Distinguish zero from missing values and normalize units consistently.
- [ ] Make calendar, notifications, debriefs and planning consume the same reconciliation result.

Acceptance: double sessions, duplicate imports, midnight boundaries, late sync, unrelated activities and explicit skips produce consistent results across clients. Reprocessing the same inputs does not change totals or duplicate records.

## P0 — Reliable generation and storage

- [ ] Validate the complete replacement plan before changing the existing plan.
- [ ] Replace plans transactionally; retain the last valid plan if any write fails.
- [ ] Add version checks and idempotency keys for concurrent generation, retries and user edits.
- [ ] Preserve completed, skipped and athlete-locked sessions according to explicit replacement rules.
- [ ] Coordinate external calendar/watch updates through retryable synchronization rather than deleting them before a successful plan save.
- [ ] Define typed, machine-readable violations instead of depending on free-text messages.
- [ ] Apply identical final validation to daily generation, weekly generation, chat adjustments and repair attempts.
- [ ] Make enforcement independent of a caller remembering an optional flag such as `catalogOnly`.
- [ ] Distinguish generation failure from an intentional recovery day; do not describe a failed generation as a medical necessity.
- [ ] Provide a reviewed fallback session only when it satisfies the athlete's known constraints; otherwise retain the existing plan and explain the failure.
- [ ] Version prescriptions, policy rules, templates and model configurations for reproducible debugging.

Acceptance: simulated provider timeouts, malformed output, failed inserts and concurrent edits never erase a valid plan or silently overwrite an athlete's newer choice.

## P1 — Shared deterministic prescription engine

- [ ] Define a common session model: objective, sport, warm-up, main work, recovery intervals, cool-down, target intensity and estimated duration.
- [ ] Add sport-specific typed prescriptions rather than forcing every sport through strength-style exercise fields.
- [ ] Construct candidate sessions from reviewed templates and validated athlete data.
- [ ] Separate hard constraints from preferences and ranking criteria.
- [ ] Make code authoritative for dates, equipment, eligibility, dose calculation and progression limits.
- [ ] Restrict models to proposing candidates or interpreting intent; validate every final prescription independently.
- [ ] Calculate total duration from work, rest, warm-up, transitions and cool-down; recompute after edits.
- [ ] Respect both daily time limits and the weekly time budget.
- [ ] Select intensity measures supported by available data and equipment; avoid unsupported numerical precision.
- [ ] Track age and reliability of thresholds, personal bests and other calibration measurements.
- [ ] Establish a conservative calibration/familiarization workflow for new athletes and unfamiliar activities.
- [ ] Provide supported alternatives when equipment, venue or conditions prevent the primary session.
- [ ] Record the reason a session was selected and why alternatives were rejected.
- [ ] Prevent generated descriptions from contradicting structured durations, targets or constraints.

Acceptance: identical athlete state and policy version yield reproducible valid prescriptions; explanations cannot change the underlying plan.

## P1 — Longitudinal programs for every sport

- [ ] Maintain an explicit multiweek program with goals, priorities, phases and progression state.
- [ ] Distinguish general fitness, performance, technique, strength, hypertrophy and return-to-consistency objectives.
- [ ] Preserve successful sessions and useful continuity instead of regenerating the whole program unnecessarily.
- [ ] Progress from actual completed work and response, not from planned work that never happened.
- [ ] Separate progression of frequency, duration, volume, density and intensity; avoid increasing everything together without justification.
- [ ] Define when to progress, repeat, reduce, substitute or reassess.
- [ ] Support reduced-load periods and event preparation using goal-specific policies.
- [ ] Handle interruptions, travel and long breaks without automatically resuming the previous peak workload.
- [ ] Keep event dates and priorities structured, including competing events or goals.
- [ ] Reassess goals and expected timelines when availability or training history changes materially.

Acceptance: a multiweek simulation with missed sessions, extra training and changing availability remains coherent and does not accumulate training debt.

## P1 — Running workout quality

- [ ] Create reviewed templates for easy running, long runs, recovery runs, run/walk progression, strides, hills, tempo/threshold work and intervals.
- [ ] Match templates to experience, current running exposure, goal distance and available time.
- [ ] Express interval repetitions, work duration/distance, recovery mode and recovery duration explicitly.
- [ ] Verify total distance and time, including warm-up, recoveries and cool-down.
- [ ] Calibrate pace and heart-rate targets from appropriate running data; support perceived-effort targets when calibration is missing.
- [ ] Account for terrain, elevation, treadmill context and environmental conditions when interpreting pace.
- [ ] Track running-specific exposure separately from cycling or other cardiovascular work.
- [ ] Manage placement of long runs, demanding intervals and lower-body strength sessions jointly.
- [ ] Evaluate execution by intended stimulus: an easy run is not unsuccessful because it was slower than an arbitrary pace.
- [ ] Distinguish easy running replacing intervals, shortened long runs and planned run/walk sessions from full completion.
- [ ] Support event-specific preparation and reduced training before events without applying one schedule universally.

Acceptance: every running session is executable from its instructions and fits the athlete's running history, goal and current constraints.

## P1 — Cycling workout quality

- [ ] Create reviewed templates for endurance, recovery, tempo, threshold, higher-intensity intervals, long rides and technique/cadence work.
- [ ] Use cycling-specific power or heart-rate calibration; track threshold freshness and uncertainty.
- [ ] Provide heart-rate or perceived-effort alternatives when no power meter is available.
- [ ] Distinguish indoor trainer, outdoor road, gravel and mountain-bike contexts where supported by the athlete profile.
- [ ] Prefer time-based prescriptions when terrain, traffic or wind makes distance a poor workload target.
- [ ] Specify interval targets, recoveries, repetitions and total session duration consistently.
- [ ] Avoid interpreting coasting, stops or terrain-driven power variation as simple noncompliance.
- [ ] Evaluate group rides and unscheduled hard rides as actual load even when they replace a different planned session.
- [ ] Schedule demanding rides with running and strength fatigue in mind.
- [ ] Export structured trainer/watch workouts and test unit/target fidelity on reimport.

Acceptance: indoor and outdoor versions preserve the intended training objective without requiring unavailable equipment or unrealistic continuous targets.

## P1 — Swimming workout quality

- [ ] Create reviewed templates for technique, easy aerobic work, endurance, threshold and intervals.
- [ ] Collect pool length, preferred units, swimming experience, supported strokes and available equipment.
- [ ] Make set distances compatible with pool length and verify the complete session distance.
- [ ] Specify repetitions, stroke, drill, rest or send-off clearly; do not confuse rest duration with interval start time.
- [ ] Use appropriate swim-specific pace calibration when available and effort-based alternatives otherwise.
- [ ] Scale drills and complexity to demonstrated skill and confidence.
- [ ] Include warm-up and cool-down and realistic estimates for rest and transitions.
- [ ] Distinguish pool and open-water sessions; do not transfer pool precision uncritically to open water.
- [ ] Define reviewed open-water eligibility and conditions policies rather than letting a model invent reassurance about safety.
- [ ] Handle missing heart rate, unreliable distance and rest detection without manufacturing precise adherence scores.
- [ ] Account for shoulder/upper-body fatigue and relevant strength work when scheduling.
- [ ] Treat partial sets, technique substitutions and shortened sessions as structured modifications.

Acceptance: pool workouts add up correctly, can be followed at the stated pool length and remain meaningful when wearable measurements are incomplete.

## P1 — Strength workout quality

- [ ] Add stable exercise IDs, movement patterns, required implements, difficulty and supported logging units.
- [ ] Replace broad equipment tiers with actual implement requirements, including benches, racks, bars and assistance machines.
- [ ] Add resistance-band support consistently across catalog, availability filtering, prescriptions and logging.
- [ ] Create curated substitution groups; separate same-muscle overlap from equivalent movement or training objective.
- [ ] Support goal-specific templates for general strength, hypertrophy and other explicitly supported goals.
- [ ] Order exercises deliberately and balance compound work, accessories and session fatigue.
- [ ] Prescribe warm-up sets, working sets, reps, rest and effort targets distinctly.
- [ ] Calculate initial loads from the exercise's own history; use familiarization when reliable history is absent.
- [ ] Make progression recovery-aware; allow repeating or reducing work without an automatic correction back to the previous load.
- [ ] Never transfer target kilograms directly across different equipment or exercises.
- [ ] Model unilateral work, bodyweight/assisted movements, timed holds and carries appropriately.
- [ ] Separate exact exercise completion, movement coverage and completed dose in the debrief.
- [ ] Audit catalog gaps periodically and preserve Android/server parity automatically.

Acceptance: workouts use available equipment and bundled exercises, fit the time budget and have an explainable progression from actual logged performance.

## P1 — Recovery, mobility and other activities

- [ ] Distinguish complete rest, optional light activity, mobility and a deliberately prescribed recovery session.
- [ ] Avoid assigning fictitious completed load to an unperformed recovery recommendation.
- [ ] Build reviewed mobility templates with clear movements, duration and required equipment.
- [ ] Avoid presenting generic mobility as rehabilitation for an injury.
- [ ] Account for walks, hikes, rowing, classes, sport matches and physical work without assuming they replace sport-specific training.
- [ ] Allow the athlete to report the duration and effort of activities lacking device recordings.
- [ ] Keep unsupported activity types visible and explain uncertainty rather than silently forcing them into the nearest supported sport.
- [ ] Require dedicated templates, dose models and validation before adding generation support for another sport.

## P1 — Mixed-sport scheduling

- [ ] Represent primary and secondary goals explicitly.
- [ ] Maintain sport-specific load alongside shared fatigue indicators; do not treat equal estimated load as interchangeable stimulus.
- [ ] Track overlapping muscular/mechanical demands across sports.
- [ ] Schedule demanding sessions, long sessions and strength work jointly rather than using independent sport calendars.
- [ ] Respect double-session availability and recovery between sessions.
- [ ] Define explicit cross-training substitution policies, including what benefit is preserved and what is not.
- [ ] Handle competing events and goal priorities without promising simultaneous maximum progress everywhere.
- [ ] Support combined sessions and transitions only when they serve an actual multisport goal.
- [ ] Explain which goal is prioritized when time or recovery requires a tradeoff.

Acceptance: an unscheduled hard ride or heavy leg session can influence the next run without being counted as completed running-specific work.

## P2 — Adaptation after changes or missed sessions

- [ ] Collect concise reasons for changes: time, fatigue, pain, illness, equipment, conditions, preference or other.
- [ ] Ask only when the missing information could materially change the next decision.
- [ ] Define different adaptation policies for skipped, shortened, easier, harder and substituted sessions.
- [ ] Preserve completed training and athlete-locked commitments during adaptation.
- [ ] Replan the smallest necessary part of the schedule instead of replacing everything by default.
- [ ] Explain the proposed change and offer feasible alternatives when the decision is preference-sensitive.
- [ ] Prevent missed-session accumulation and inappropriate catch-up schedules.
- [ ] Recompute future progression from actual dose and response.
- [ ] Handle conflicting user feedback and device data explicitly, retaining both sources.
- [ ] Allow undo and inspection of previous plan versions.

Acceptance: the same missed workout produces different justified adjustments for lack of time, unavailable equipment and illness; missing sync remains unknown until resolved.

## P2 — Readiness, feedback and coaching communication

- [ ] Combine relevant subjective feedback and observed training without treating any single metric as an oracle.
- [ ] Track soreness location, perceived effort, enjoyment and session difficulty with minimal input burden.
- [ ] Separate pain reports from normal effort or soreness and enforce reviewed escalation/backoff policies.
- [ ] Treat readiness with no measurements as unknown rather than a precise midrange score.
- [ ] Keep load ratios descriptive; avoid unsupported diagnoses of overtraining or precise injury risk.
- [ ] Distinguish execution adherence from training quality: an appropriate adjustment can be a good decision despite deviating from the plan.
- [ ] Explain what happened, what is uncertain, what changes and why.
- [ ] Give one useful next action instead of reciting metrics or scolding noncompliance.
- [ ] Keep numeric claims grounded in structured data and label estimates.
- [ ] Check that chat advice, workout instructions and the saved plan agree.

## P2 — Independent evaluation and observability

- [ ] Build coach-reviewed scenario sets for each supported sport and mixed-sport schedules.
- [ ] Include novice/experienced athletes, sparse history, stale thresholds, limited equipment and restricted availability.
- [ ] Include missed weeks, changed activities, pain/illness reports, bad weather, duplicate imports, late sync and two-session days.
- [ ] Test matching accuracy separately from prescription quality and explanation quality.
- [ ] Measure false completion, missed matches, abstention and user correction rates by sport.
- [ ] Measure equipment/catalog violations, dose consistency, realistic duration and failed plan replacement.
- [ ] Evaluate multiweek behavior, not just individual attractive-looking workouts.
- [ ] Use independent expert review rather than only scoring outputs against the engine's own rules.
- [ ] Align the offline evaluation harness with every production constraint, including catalog enforcement.
- [ ] Track user-reported usefulness, adherence and unwanted plan changes without treating engagement alone as training success.
- [ ] Record policy decisions, input provenance, model versions and correction reasons with appropriate retention/access controls.
- [ ] Add regression cases for every confirmed production failure.
- [ ] Run device and export/import checks for sport-specific units and session instructions.
- [ ] Establish release gates and a staged rollout/rollback process for prescription changes.

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
