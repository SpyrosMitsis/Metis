# Android codebase guide

Reviewed 2026-10-21. Read this before exploring the whole Android tree. Paths below are relative to `android/app/src/main/java/com/workoutmaker/app/` unless stated otherwise. See [review report](ANDROID_REVIEW_2026-10-21.md) for known limitations and validation.

## Shape and ownership

Single Android application module, Kotlin, Jetpack Compose, Hilt, Room, DataStore, WorkManager, Supabase Kotlin SDK 2.x and Ktor/OkHttp. `play` adds Play Billing; `foss` supplies a no-billing implementation. Minimum SDK 26, compile/target SDK 35, JDK 17. Product label is Metis; package remains `com.workoutmaker.app`.

| Concern | Read first | Responsibilities |
| --- | --- | --- |
| Startup and routing | `WorkoutMakerApp.kt`, `MainActivity.kt`, `ui/AuthGate.kt` | Logging, notification channels, workers, auth links, auth/onboarding gates, tab and detail navigation |
| Dependencies/backend | `di/AppModule.kt`, `data/BackendConfig.kt` | Singleton Supabase client, auth, timeouts; custom server changes require restart |
| Remote data | `data/WorkoutRepository.kt`, `data/WorkoutRepository*.kt` | Auth/account scope, profile cache, feature-specific extension functions, Supabase queries/functions |
| Local storage | `data/Cache.kt`, `data/AppPreferences.kt`, `strength/StrengthData.kt` | Room v9, migrations, offline dashboard/plan, settings, strength entities/DAOs |
| Home | `ui/screens/home/HomeViewModel.kt`, `HomeScreen.kt` | Summary, readiness, check-in, plan generation, feedback; cards split across section files |
| Coach | `ui/screens/coach/CoachViewModel.kt`, `CoachUiState.kt`, `data/WorkoutRepositoryCoach.kt` | Conversations, SSE streaming, tool progress, settings changes; `CoachScreen` wires content/state |
| Calendar | `ui/screens/calendar/CalendarViewModel.kt`, `data/WorkoutRepositoryPlan.kt` | Plans, rescheduling, locking, completion, offline plan fallback |
| Strength | `strength/StrengthViewModel.kt`, `StrengthRepository.kt`, `StrengthCatalog.kt` | Active session, rest timer, import/export, routines, progression, history and sync |
| Setup/settings | `ui/screens/onboarding/OnboardingViewModel.kt`, `ui/screens/settings/SettingsViewModel.kt` | Profile, preferences, permissions, integrations, goals and AI settings |
| Integrations | `health/HealthConnectManager.kt`, `calendar/DeviceCalendarManager.kt`, `data/LocationProvider.kt` | Optional Health Connect, local calendar and weather location |
| Background work | `work/StrengthSync.kt`, `FeedbackSync.kt`, `CheckinReminder.kt`, `FeedbackPrompt.kt` | Network-constrained queues and recurring notifications |
| Diagnostics | `util/AppLog.kt`, `CrashReporter.kt`, `Errors.kt` | Debug log, crash files, readable transport/auth errors |

## Important flows

1. `WorkoutMakerApp` installs logging/crash capture, channels and scheduled workers. `MainActivity` handles auth/notification intents and navigation. `AuthGate` handles authenticated and cached-session offline entry. Onboarding rechecks account ownership before showing normal UI.
2. Home/Calendar ask repository extensions for server data; Room supplies offline fallback. Planned-workout refresh replaces only dates at/after the requested date, atomically. Older history must survive a narrow refresh.
3. Strength edits live in Compose state. `SavedSession` serializes them to `active_session.json`. `SessionSnapshotFile` orders writes by revision; ordinary edits debounce 150 ms, backgrounding saves immediately, discard invalidates older writes. Finished sessions move into Room.
4. Strength rows with synced=false and deletion tombstones form the queue. StrengthSyncWorker sends a captured batch to sync_strength, committing source rows and coaching totals atomically. Android acknowledges only unchanged snapshots; edits during upload stay pending.
5. strength_snapshot returns all workouts, sets, routines, items and customs without row caps. Merge applies remote edits/deletions transactionally while preserving dirty rows and tombstones. Set notes round-trip. The old root CLAUDE.md description of one-way strength sync is outdated.
6. Feedback uses atomic save_workout_feedback and stable IDs through direct-write fallback and WorkManager retries. Queued items carry owner_uid; mismatches and ownerless legacy items are rejected.
7. Coach streaming uses a separate raw Ktor client because the functions SDK buffers responses. Both clients deliberately allow 150-second requests/socket waits. Preserve tool/reset/done handling when changing streaming.

## Invariants worth preserving

- Use client-local dates for today and workout grouping. Calendar all-day event timestamps are UTC by provider contract; this is intentionally different.
- Room strength data can be the only copy of an offline workout. Do not replace migrations with destructive upgrade fallback. Exported schema is `android/app/schemas/`; current version is 9.
- Keep parent/children replacement and delete/tombstone creation transactional. Never hold a Room transaction across a network call.
- Pending local edits win cloud merges. A tombstone means the remote row must not be re-imported.
- RLS scopes many remote queries; Android often does not include an explicit user filter. Verify schema policies when changing these queries.
- Profile row reads have a five-minute in-memory TTL; profile mutations should invalidate it.
- Health/calendar/location integrations are optional. Permission denial and missing providers must remain usable paths.
- Hilt supplies the WorkManager factory; the manifest disables its default initializer.
- Theme accents come from Material color scheme. UI strings and rendering contracts have existing tests; avoid unrelated visual rewrites during persistence work.
- `BackendConfig.commit()` is intentional: settings must reach disk before the immediate process restart. Do not mechanically apply the lint suggestion to switch to `apply()`.
- Backend/cloud DTO fields are often nullable for compatibility. Local entities supply defaults; changing wire shapes may require a Supabase migration and web changes.

## Required backend migration

Apply [20261021000046_atomic_android_sync.sql](../supabase/migrations/20261021000046_atomic_android_sync.sql) before installing this client against a backend. It supplies the three RPCs and cloud set notes. Test locally with bash scripts/test_android_sync.sh.

AccountCoordinator.run admits concurrent operations; exclusive drains them before auth transitions. Nested repository calls share a lease. Do not call exclusive from inside a lease. Explicitly import util.runCatching at suspend boundaries so cancellation propagates.

## Working efficiently

Use `scripts/dev.sh` for normal developer tasks; it sets JDK 17 and reads untracked local device/backend configuration. Do not copy secrets or device serials into tracked docs.

```sh
scripts/dev.sh android:test
scripts/dev.sh android:uitest
scripts/dev.sh qa:device
```

Explicit checks from `android/` (set `JAVA_HOME` to your JDK 17):

```sh
./gradlew :app:testFossDebugUnitTest :app:testPlayDebugUnitTest
./gradlew :app:lintFossDebug :app:lintPlayDebug
./gradlew :app:compileFossDebugAndroidTestKotlin
./gradlew :app:assemblePlayRelease
```

JVM tests live in `app/src/test`; Room/device/Compose tests in `app/src/androidTest`. `CacheReplacementTest` checks scoped replacement and rollback after an injected SQL failure. `SessionSnapshotFileTest` checks stale-write rejection and discard. A compiled instrumented test has not necessarily been run.

For a feature change, start at its ViewModel, follow the repository extension, then inspect the corresponding `supabase/functions/<name>/index.ts` and migrations. For strength, also read the DAO and queue sequence. Avoid reading every UI section unless the change affects rendering. CI runs both flavors' unit tests, Play lint, Play release/R8, and checks committed Room schemas.

For workout detection, prescription architecture, Jev assessment and catalog constraints, read [Coach engine review](COACH_ENGINE_REVIEW_2026-10-22.md).

## Strength stats and keyboard layout (2026-10-27)

- `StrengthPickerViews.kt` renders the stats index with pinned search/filters and a lazy list. `ExerciseStatsIndex.kt` owns visibility and name/muscle/equipment search. Differently named variants keep separate histories.
- Custom entries (including imported names outside the bundled catalog) expose a confirmed delete action. `StrengthCatalog` deletes the custom definition through the existing sync tombstone path. Logged sets, routines and workouts remain intact. Bundled definitions are protected.
- Hiding the deleted name from stats is account-scoped, device-local DataStore presentation state (`hidden_exercise_stats_<owner>`), separate from transient sync tombstones. Hidden rows still open historical stats and can be restored; restoring visibility does not recreate a custom definition. Creating the custom exercise again clears its hidden flag. A custom override of a bundled name reverts to the bundled definition and remains visible.
- `StrengthDao.exerciseLogSummaries()` counts distinct workout IDs and returns each exercise's latest local timestamp. This is a projection only, with no Room schema change.
- `ActiveWorkoutView` applies `imePadding()` to its Scaffold so the live rest countdown stays above the keyboard. `MainActivity` already consumes outer navigation insets: do not add a second keyboard-height spacer. Secondary add/rest buttons hide while typing; countdown adjustment and skip remain available.
- Regression coverage: `ExerciseStatsIndexTest` (filtering and variants), `StrengthStatsContentTest` (confirmed deletion, restore and timer controls), `ExerciseStatsPersistenceTest` (session counts and preserved history). Device tests require an accepted installation on a phone/emulator.

Build recovery note: overlapping Gradle invocations in the same checkout were observed with missing generated Hilt classes (`StrengthViewModel_HiltModules.BindsModule` / `WorkoutMakerApp`). A clean single-worker `assemblePlayDebug` succeeded, followed by the ordinary `scripts/dev.sh android:build` command. Keep builds in one checkout sequential; use a separate checkout/copy for parallel validation. Clearing generated outputs does not require changing application source or deleting app data.

## Prescribed strength presentation and import (2026-10-27)

`PlannedExerciseGroups.kt` groups warm-up and main dose entries for one exercise without changing the canonical prescription. `WorkoutDetailViews.kt` shows one card per exercise, separate warm-up/working-set rows and expandable notes. `StrengthViewModel.seedFromWorkout` uses those same groups, preserves planned targets and marks warm-up sets. `SavedSession.prescribedTargets` keeps that behavior after restart, including workouts without a calendar link; old snapshots remain readable. See `WORKOUT_ENGINE_AUDIT_2026-10-27.md` for scheduling, time, goal and injury invariants and verification.

## Training-week setup and planner streamlining (2026-10-27)

`SettingsSections.TrainingWeekSection` keeps everyday coaching preferences visible. `PlanningControls.kt` uses `PlanningDetailsCard` for specialist settings and `PlanningChoiceGroup` for readable labels without changing stored keys. Saveable state holders retain optional form drafts when sections collapse. `Periodization.configure` is the shared onboarding/settings action: enabling sets a missing local start date once, preserving existing dates on later toggles. The load illustration is explicitly separate from the actual structured program.

Backend weekly invariants are prepared in a request-local `weekFor(date)` record in `deterministic_week.ts`; its budget is fetched once per calendar week. `commitments(sport)` supplies frequency and minute accounting; `withForecast` supplies the existing shared forecast behavior. See [Planner streamlining](WORKOUT_PLANNER_STREAMLINING_2026-10-27.md) for parity evidence and limitations.

## Daily coach questions and configured device builds (2026-10-27)

`get_today_plan` is a read with full saved instructions. `coach_turn.ts` and the chat executor prevent ordinary daily questions from invoking calendar edits; both model transports use the same restricted catalog. `CoachScreen` suppresses unsaved-proposal prompts after either daily or weekly plan reads. Goal-race preparation now defaults on for A events; overrides live under advanced program options. See `COACH_INTEGRATION_FIX_2026-10-27.md`.

**Before installing an isolated-checkout APK, copy the real `android/local.properties` into that checkout and verify its generated backend URL/key match.** A successful compile does not establish runtime server configuration. Do not print keys or copy private configuration into tracked files. An APK built without those settings can appear signed out and unable to reach the server. The corrected build restored the existing session without a data wipe.

Physical UI tests require the updated AndroidX Test/Espresso dependencies on newer Android. `PlanningControlsTest` and `CoachContentTest` use fixtures. `CoachTodayLiveTest` requires explicit `liveCoach=true`; it sends a real daily question on the signed-in account, so opt-in is required even though it does not request a calendar change.
