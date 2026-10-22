# Android codebase guide

Reviewed 2026-10-21. Read this before exploring the whole Android tree. Paths below are relative to `android/app/src/main/java/com/workoutmaker/app/` unless stated otherwise. See [review report](ANDROID_REVIEW_2026-10-21.md) for known limitations and validation.

## Shape and ownership

Single Android application module, Kotlin, Jetpack Compose, Hilt, Room, DataStore, WorkManager, Supabase Kotlin SDK 2.x and Ktor/OkHttp. `play` adds Play Billing; `foss` supplies a no-billing implementation. Minimum SDK 26, compile/target SDK 35, JDK 17. Product label is Metis; package remains `com.workoutmaker.app`.

| Concern | Read first | Responsibilities |
| --- | --- | --- |
| Startup and routing | `WorkoutMakerApp.kt`, `MainActivity.kt`, `ui/AuthGate.kt` | Logging, notification channels, workers, auth links, auth/onboarding gates, tab and detail navigation |
| Dependencies/backend | `di/AppModule.kt`, `data/BackendConfig.kt` | Singleton Supabase client, auth, timeouts; custom server changes require restart |
| Remote data | `data/WorkoutRepository.kt`, `data/WorkoutRepository*.kt` | Auth/account scope, profile cache, feature-specific extension functions, Supabase queries/functions |
| Local storage | `data/Cache.kt`, `data/AppPreferences.kt`, `strength/StrengthData.kt` | Room v8, migrations, offline dashboard/plan, settings, strength entities/DAOs |
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
- Room strength data can be the only copy of an offline workout. Do not replace migrations with destructive upgrade fallback. Exported schema is `android/app/schemas/`; current version is 8.
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
