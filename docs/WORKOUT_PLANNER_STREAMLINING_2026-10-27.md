# Workout planner streamlining — 2026-10-27

## What changed

This pass simplifies weekly bookkeeping and the Android training-week setup. It preserves the existing prescription policies, both generation modes, specialist settings and independent publication checks. It does not introduce a new exercise-selection or progression algorithm.

### Planner code

`supabase/functions/_shared/deterministic_week.ts` now computes invariant information once instead of rediscovering it inside every sport candidate:

- Session windows and the longest available window are prepared once.
- A request-local calendar-week record owns sport quotas, protected commitments, the reserved primary-sport day and the starting weekly time budget.
- One `commitments(sport)` calculation supplies completed sessions, protected/new sessions and committed minutes. Allocation and dose construction use the same bookkeeping.
- The existing `withForecast` helper supplies date-specific weather, as it already does for templates, moves and the model weekly path.

`session_context.ts` filters retained plans once and reuses that result for committed minutes and linked-actual deduplication.

The cache lives only inside one generation request, is separated by Monday calendar boundaries, and is never shared between users or requests. Newly constructed workouts still deduct their minutes and transitions. Publication, revision checks and atomic persistence remain in the existing store layer.

This is a reduction in repeated work and decision paths, not a claim of fewer total source lines. Small named calculations replace dense repeated expressions; independent review is intentionally retained.

### Training-week experience

The main page now asks for the things a person ordinarily tells a coach:

1. Main sport, whether recent training is up to date, and an optional weekly time ceiling.
2. Available training days, ordinary session length and longer days.
3. Progression style and recovery-day preference.

Specialist controls remain available in collapsed sections, each with a summary:

- **Two-session days:** session windows, multisport goal and recovery gap.
- **Event preparation:** program start and per-sport event policies.
- **Equipment details:** exact inventory, including a way back to general equipment preferences. An explicitly empty inventory still means bodyweight only.
- **Performance tests:** dated calibration and provenance.
- **Workout generation options:** structured versus AI proposals.
- **Training load illustration:** the previous eight-week graph, explicitly described as illustrative rather than an exact structured-engine forecast.

Labels such as `optional_light`, `heart_rate` and `ride` are shown as ordinary language while stored values remain compatible. Opening or collapsing a specialist section does not change the profile. Saveable drafts preserve unfinished performance-test input across collapse/expand and restoration.

`Periodization.configure` is shared by settings and onboarding. Enabling a periodized program supplies today's local date only if no start exists; disabling/re-enabling preserves the existing date. This removes the need to discover an additional technical setting before the structured program has an anchor. Existing profiles are not silently migrated or replanned.

The screen explains that time limits are ceilings and that saved preferences apply when generating or adjusting a plan. It does not imply that saving settings has already rewritten the calendar.

## Verification

- **731 shared backend tests passed.** New regressions cover one budget read per calendar week, separate budgets across Monday boundaries and failure to read commitments remaining a blocking error.
- **432 before/after comparisons produced identical complete planner results**, not just equal workout counts. Fixtures span all supported sports, explicit/legacy schedules, three time budgets, fragmented/mixed/pain history, protected sessions, two-session windows, event preparation and cross-week requests.
- In those comparisons, weekly-budget database reads fell from **4,176 to 864**, approximately **79% fewer**. This is a query-count measurement, not an end-to-end latency claim.
- All edge-function entry points passed type checking.
- Existing offline evaluation: **232 cases**, **215 valid prescriptions**, **17 expected abstentions**, **zero unexpected failures** and no catalog/equipment/dose/availability violations.
- Android: **259 unit tests passed in each Play/FOSS variant**; the Play debug APK and instrumentation APK built successfully. Two Compose regressions cover optional-control disclosure without profile mutation and preserving an unfinished measurement after collapse/expand. Device/Compose tests were compiled but not run: no Android device was attached.

The parity harness and reference implementation are local artifacts: `/tmp/streamline-week-parity.ts`, `/tmp/deterministic-week-before-streamline.ts`; result: `/tmp/workout-streamline-parity.log`. Durable ongoing checks live in `_shared/deterministic_week_test.ts`, Android `PeriodizationTest.kt`, and `PlanningControlsTest.kt`.

## Delivery and limits

Backend changes were deployed to all nine importing functions: `adapt-plan`, `coach-brief`, `coach-chat`, `daily-summary`, `generate-workout`, `move-workout`, `plan-week`, `schedule-template`, and `session-feedback`.

Android APK: `/tmp/workout-maker-strength-ui-check/app/build/outputs/apk/play/debug/app-play-debug.apk`; installing it is required for the new settings experience.

No existing calendar was regenerated during this refactor. No training data, exercise definitions, injuries or saved specialist preferences were deleted. The web companion was not redesigned in this Android settings pass.

The simpler screen does not make the engine a complete expert-coach optimizer: movement selection still uses the existing eligibility/history rules, and the eight-week illustration remains separate from the structured program calculation. Those distinctions are explicit rather than hidden behind a stronger coaching claim.

## Read these files first

- `_shared/deterministic_week.ts`: per-week preparation, commitments, candidate construction and final review.
- `_shared/session_context.ts`: actual evidence, remaining time and the shared forecast helper.
- Android `ui/screens/settings/SettingsSections.kt`: everyday training-week setup.
- Android `ui/screens/settings/PlanningControls.kt`: disclosure, summaries, human-readable choices and specialist controls.
- Android `data/Periodization.kt`: shared program-start behavior and legacy illustration calculations.

The underlying dose, injury, recovery, time and catalog invariants are documented in `WORKOUT_ENGINE_AUDIT_2026-10-27.md`.
