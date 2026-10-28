# Workout generation and presentation audit — 2026-10-27

## Outcome

This pass repaired scheduling, dose construction, goal interpretation and Android strength import/presentation. The five-day reproduction now uses the selected training days rather than turning them into rest because of several activity records on one earlier day. Existing exposure still controls conservative dose, recovery, and whether harder work is eligible.

The affected account's remaining week was regenerated and read back: four training days plus the earlier recorded training day satisfy the five-day preference. Unavailable days stay rest. Today's existing workout ID, contents and lock state were preserved to avoid disrupting an in-progress log. The primary endurance sport retains the longer available window. No private account identifiers or source health records are included here.

## Defects repaired

| Finding | Change |
| --- | --- |
| Several recordings on one date consumed several ordinary training days. | `weekly_schedule.ts` counts ordinary completed slots by date; explicit double-session windows retain their separate capacity. All physical minutes remain in workload calculations. Zero-duration imports cannot occupy a requested training day. |
| A rolling history count acted as a hard schedule quota. | Explicit availability now produces calendar-week sport quotas, prioritizing the primary sport and including strength. Past training, protected sessions and new planned slots are reconciled in that calendar week. Profiles without explicit availability retain the conservative legacy fallback. |
| A short fragment could become the next workout's duration baseline or support quality eligibility. | Use a median of meaningful recent durations. Brief records still contribute workload, but do not reset interruption status or establish multiple quality-training days. |
| The longest window could be assigned to a secondary sport after the primary quota was used early. | Reserve an eligible mutable window for the primary endurance goal; never displace a protected session. This reserves time, not permission for a longer/harder dose. |
| Saved UI goal choices were not necessarily read by the deterministic engine. | Interpret `goals_by_sport`, distance goals and compatible legacy goals, with explicit `program_objectives` taking precedence. A goal never becomes evidence of present capacity or measured pace. |
| Warm-up/main blocks looked like separate exercises. | Android and web group strength doses under one exercise name while retaining separate warm-up and working-set lines, rest information and expandable notes. Canonical executable blocks remain unchanged. |
| Planned logging duplicated exercises and lost warm-up flags. | The Android handoff groups doses and marks warm-up sets. Distinct movement variants stay separate. |
| Progression suggestions could replace a prescribed lighter load/repetition target. | Plan-seeded targets are preserved. A backward-compatible active-session snapshot flag also preserves standalone prescribed targets after a process restart. Historical sets remain available as PREV. |
| Dated backoffs could be discovered only after construction. | Apply review restrictions before daily/weekly/template/moved-session construction, and keep the independent final review. Resolved standing injury entries no longer create permanent exclusions. |
| A structured easy strength prescription could be rejected by a legacy ease-backoff rule despite respecting its effort ceiling. | Preserve the legacy check for legacy workouts, and inspect structured strength effort targets against the existing ease ceiling. Avoid restrictions remain structural exclusions. |
| New and protected strength work could exhaust a muscle's weekly set allowance only at final review. | Reserve working-set budgets during candidate construction, including fixed same-week work, and exclude warm-up sets. |
| An explicit weekly time ceiling could omit unplanned work already performed. | Deduct known actual minutes not already represented by retained plans. Linked actual/fixed sessions are not counted twice. Cross-week planned time uses the correct week. |
| Extra requested days could defeat a reduced/event-preparation dose budget. | Those dose limits remain binding; insufficient capacity is reported instead of filling the schedule unsafely. |
| Assistance was bounded like added weight, and null weights could become zero. | Assistance uses the easier direction; missing weights stay unknown. Bodyweight and band modes do not invent kilogram loads. New bodyweight wording has a separate presentation version so existing saved projections stay valid. |
| Rest explanations and titles exposed internal labels. | Give specific reasons for unavailable days, holds, quotas and time constraints. Versioned readable presentations 2/3 provide readable titles and concise notes, while older canonical projections still validate. Full decision reasons remain in the prescription. |

## Rules checked

- Selected sports and weekdays; daily availability, maximum session duration and explicit second-session windows.
- Exact work/rest/transition arithmetic, pool lengths/units, unilateral work and timed/distance strength units. Strength/pool durations remain estimates.
- Weekly time ceilings, recorded unplanned work, fixed sessions, skipped sessions, linked-record double counting, and Monday boundaries.
- Bundled exercise identity and available implements; active injury exclusions, dated backoffs, holds, recovery spacing and muscle-set limits.
- Missing/incomplete history, interrupted training, tiny records, uncertain effort, and lack of permission for harder work merely because a plan was generated.
- Saved sport objectives, primary-sport allocation, explicit event-preparation policies and longer availability windows.
- Preserving locked/completed sessions and atomic saving; immutable executable dose versus presentation; warm-up import, explicit prescribed targets and active-session compatibility.

These are checked constraints, not a claim that a greedy scheduler finds every feasible optimal plan. If constraints prevent the requested frequency, rest must carry a concrete reason. The engine does not invent availability, equipment, calibration, recovery measurements or completion evidence to fill a calendar.

## Time and frequency semantics

A typical session length is a preference, while per-day/session/weekly maxima are hard ceilings. Introducing more selected training days initially uses shorter easy sessions. It does not immediately fill every 45/90-minute window or infer that increased intensity is tolerated. Explicit reduced-dose and event policies still apply. Requested frequency changes are an athlete instruction, separate from evidence-based automatic progression.

The five-day fixture uses Mon/Tue/Wed/Fri/Sun. Several run records from Monday count as one occupied ordinary training day. Tuesday's protected strength session stays intact; the remaining schedule supplies Wed/Fri/Sun training and Thu/Sat rest. Sunday is reserved for the primary running goal without treating the longer window as permission to increase dose.

## Verification

- Shared Deno suite: 729 tests passed (19 additional named regressions since the 710-test baseline, including nested checks over all supported sports and short budgets).
- Offline engine evaluation: 232 cases, 215 valid prescriptions, 17 expected abstentions; zero unexpected failures and zero catalog, equipment, dose-consistency or availability violations.
- All edge-function entry points passed type checking; the final scheduling changes were checked again before deployment.
- Android: 258 unit tests passed in each Play/FOSS variant; the debug APK and instrumentation test APK built successfully. Instrumentation/device tests were compiled, not run.
- Web companion: TypeScript check passed.
- Live verification used the affected app account, not the configured development account. It ran the exact planner implementation through candidate construction, independent review, atomic persistence and read-back. Today's session was temporarily protected for this maintenance operation, then its original lock state restored.

## Delivery and limits

Backend changes, including window reservation and load-mode handling, are deployed to all 21 affected functions. Android presentation/import changes require installing the new debug APK. The web companion source was updated and type-checked; no web-hosting publication was performed.

External calendar/watch delivery remains queued. The local verification environment has a different calendar-credential encryption key, so its delivery attempt was not a successful provider/watch test. A separate administrative remote retry was rejected. Neither failure removes the successfully saved app plan. Do not equate an app-calendar save with a successful watch push.

Physical phone UI and watch checks and independent coach reviews were not fabricated. Existing P2 release-review gates remain in place. Raw imported fragments with no explicit grouping retain their separate workload evidence; the scheduler counts training days without claiming those records are verified components of one completed planned workout.

## Personalization follow-up — 2026-10-28

Saved lift references now supplement missing or stale matching lift history independently of unrelated activity logs. The session compiler exposes recent completed sessions and executable limits to both daily and weekly model generation. Frequency transitions no longer impose a permanent 20-minute familiarization cap. Known lifts and scalable gym movements take precedence over catalog order; reported lifting ability is not counted as a completed exposure.

Presentation version 4 carries explicit endurance zones through the app projection and provider export while retaining older projection semantics. Model repairs retain the rejected candidate and are bounded by the same compiler limits. Optional dose booleans accept exact numeric/string boolean encodings; invalid nested dose objects fail validation rather than silently becoming a generic exercise.

Verification: 748 shared Deno tests passed. Daily and weekly generators and the seven other schema/prompt consumers were deployed. Live read-back confirmed the remaining Sunday run was replaced with 34 minutes (6 Z1 / 22 Z2 / 6 Z1), with no review violations. Completed and locked workouts were excluded from that replacement. Generation used `push:false`; this is not watch-delivery verification.

## Read this code first

- `_shared/weekly_schedule.ts`: requested quotas, calendar weeks and completed ordinary slots.
- `_shared/program_state.ts`: saved goal interpretation, meaningful history, duration/progression policy.
- `_shared/deterministic_week.ts`: sport allocation, primary window reservation, fixed sessions, time/set reservations and rest explanations.
- `_shared/session_context.ts`, `review_context.ts`, `session_engine.ts`: actual evidence, preconstruction restrictions and bounded executable recipes.
- `_shared/proposal_compiler.ts`, `plan_store.ts`: independent model compilation, final gates and persistence.
- `_shared/prescription.ts` and `shared/prescription.ts`: exact arithmetic, canonical projections and backward-compatible presentation versioning.
- Android `strength/PlannedExerciseGroups.kt`, `StrengthViewModel.kt`, `StrengthSessionSnapshot.kt`, and `ui/screens/home/WorkoutDetailViews.kt`: grouped presentation, logging handoff and prescription-preserving resume.
- Web `components/workout-detail.tsx`: compact grouped strength doses and retained notes.
