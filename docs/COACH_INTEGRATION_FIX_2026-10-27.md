# Coach integration and automatic race preparation — 2026-10-27

## Findings

A real coach turn attempted `generate_workout` twice when the athlete wanted today's instructions. Both attempts failed because the model proposed an elliptical warm-up without the required implement. The validator correctly refused the proposal, but the turn then replaced the useful failure with a generic calendar-update message.

The underlying problems were broader than that exercise:

- The chat prompt strongly encouraged action without separating daily information questions from calendar changes.
- Daily context supplied a workout title, while the weekly read tool supplied metadata rather than full daily instructions.
- The anti-stall retry could encourage a write even when no write had been requested.
- Tool schemas advertised only running/strength and omitted configured second-session slots.
- The model did not receive the exact executable exercise choices before its first proposal.
- The coach profile read omitted several preferences already enforced by the engine.
- The Android proposal banner understood `get_planned_week`, but initially misclassified the new daily read as an unsaved proposal.

## Changes

### Asking about today reads the existing calendar

`coach_turn.ts` recognizes common daily information questions, including “What do I need to do today?”, “Today's workout?” and explanations of earlier actions. Explicit generation, replacement and movement requests retain the action path.

For daily information turns:

1. The server prefetches `get_today_plan` using the athlete's local date.
2. The observation includes full saved workout instructions, all session slots, and completion/skipped/locked state.
3. Native and JSON tool channels receive the same restricted tool catalog and focused explanation instructions.
4. The executor independently refuses calendar mutation tools, even if the model emits an unadvertised tool request.
5. The action-oriented anti-stall retry is disabled. A provider failure or an unsupported write claim falls back to a grounded description of the saved plan.

Rest days, completed sessions, skipped sessions and empty calendars are distinct. An empty calendar does not silently trigger generation. New injury disclosures can still be structurally recorded; safety restrictions are not bypassed by the information route.

Android recognizes daily-plan reads as explanations and suppresses the misleading “Put it on my calendar” proposal banner. The daily starter explicitly requests the existing plan rather than a new prescription.

### Better action contracts and proposals

- The single-workout tool supports running, cycling, swimming, strength and configured session slots.
- Saved app-calendar state and external delivery are reported separately (`calendar_saved` and `delivery`). Pending/unconfirmed watch delivery is not a failed app save or a reason to generate another workout.
- Failed action messages identify equipment/catalog, training-restriction or protected-session conflicts without exposing raw diagnostics.
- Generation establishes athlete constraints and the complete-session time ceiling before asking the model. Strength proposals, including warm-ups, receive a concrete eligible exercise list.
- `eligibleSessionExercises` is shared by deterministic construction and that prompt, preserving one eligibility definition.
- `get_profile` exposes selected/primary sports, exact available implements, time limits, session windows, generation preference, history confirmation, recovery preference and event policies. Its date-sensitive profile information uses the client-local date.

### Race preparation and optional double sessions

Dated A-priority goal races automatically receive the existing preparation preset when a plan is generated or adjusted: a seven-day preparation window, 70% usual duration and no automatic permission for quality work. This is the existing product preset becoming automatic, not a claim of an individualized event taper. Explicit per-sport policies take precedence. B/C tune-ups do not automatically receive that full reduction. An advanced automatic-preparation opt-out remains available.

The settings page no longer presents an “Event preparation” setup task. Optional start-date and preparation overrides live under **Advanced program options**. **Advanced schedule options** explains that two sessions means two separate workouts in one day, such as morning swimming and evening strength. Ordinary one-workout days require no additional setup.

Saving a race does not silently rewrite existing calendar entries. The automatic policy feeds subsequent generation/adaptation; locked/completed work and publication checks remain protected.

## Verification and delivery

- **739 shared backend tests passed**, including daily intent, both tool catalogs, executor permissions, local-date/full-instruction reads, completion/rest/double-session fallbacks, delivery receipts, automatic event preparation and profile preference visibility.
- All edge-function entry points passed type checking.
- Offline evaluation: **232 cases**, **215 valid prescriptions**, **17 expected abstentions**, zero unexpected failures or catalog/equipment/dose/availability violations.
- **259 Android unit tests passed per Play/FOSS variant.** Configured Play debug and instrumentation APKs built successfully.
- Physical phone: **11 Compose UI regressions passed**, plus **one live signed-in coach test**. The final live reply explained the existing strength workout and showed neither an update claim nor the false unsaved-proposal banner. Before/after server read-back confirmed the same workout ID, contents, lock and completion state. The new information flow was also checked once before the banner fix, which is how that additional UI defect was found.

All 12 affected backend functions were deployed; the final tool/profile updates were then redeployed to `coach-chat`. The app was installed on the connected phone.

## Device/build configuration correction

The first isolated APK installed during this investigation omitted the production server configuration. That caused sign-in/connectivity failure despite working internet. The isolated build was corrected by copying the real local configuration; generated backend values were compared with the source configuration and the authentication health endpoint returned HTTP 200 before installation. The original signed-in session restored without deleting application data.

The phone also exposed an outdated instrumentation dependency: Espresso attempted the removed reflective `InputManager.getInstance` API. AndroidX Test dependencies were updated to the stable compatible versions, including Espresso 3.7.0, whose [official release notes](https://developer.android.com/jetpack/androidx/releases/test#espresso-3.7.0) document that fix. Device Compose tests subsequently ran successfully. Shell hierarchy dumps remained unreliable, so the live check uses an opt-in Compose test against the real signed-in app.

## Code map and remaining limits

- `_shared/coach_turn.ts`: narrow daily-question policy, tool permissions and grounded/error fallbacks.
- `coach-chat/index.ts`: prefetch, prompt/catalog selection, executor enforcement and both transport loops.
- `_shared/coach_tools.ts`: authoritative reads, profile visibility and action receipts.
- `_shared/program_state.ts`: automatic goal-race policy and explicit overrides.
- `_shared/session_engine.ts`, `generate-workout/index.ts`: shared eligibility and model proposal constraints.
- Android `PlanningControls.kt`, `CoachPrompts.kt`, `CoachScreen.kt`: optional setup, daily starter and banner gating.
- `CoachTodayLiveTest.kt`: explicit `liveCoach=true` opt-in; spends a real coach turn on the signed-in device. Never use it as an unconditional CI test.

The daily-question detector is deliberately narrow and tested against English app wording. It is not a universal natural-language authorization classifier. Explicit action requests still use the existing bounded agent and independent prescription review. No independent coach/device-delivery validation is implied by a successful chat answer. The preparation preset remains a configurable product policy rather than a sport/distance-specific optimized taper.
