# Android review — 2026-10-21

## Assessment and scope

The app has a practical feature-oriented structure, useful pure domain tests, explicit offline storage, flavor separation and CI. The weakest area is coordination across local state, background work and remote persistence. Large ViewModels and broad `runCatching` blocks make failures and lifetime boundaries harder to reason about. This is a focused source/build review, not a claim that every screen or integration is defect-free.

Reviewed startup/auth wiring, repositories and Room schema, strength persistence/sync, queued work, calendar/location integration, build/flavor setup and test coverage. Changes prioritize reproducible data-integrity problems and preserve product features. Existing uncommitted onboarding/settings/backend edits were preserved.

## Fixed

| Finding | Trigger and consequence | Change |
| --- | --- | --- |
| Active session write race | Async edits and ON_STOP shared one temp file; cancellation does not interrupt synchronous file writes. An older write could replace newer state or resurrect a discarded session. | One revision-guarded, synchronized atomic writer; real debounce; synchronous background/discard saves; errors logged. Two JVM regressions cover stale saves and discard. |
| Non-atomic offline plan refresh | Failure after clearing a fetched date window could erase the offline plan. | `CacheDao.replaceWorkoutsFrom` wraps clear/insert in a Room transaction. Device regression checks history preservation, removal and rollback using an injected SQL failure. |
| Deleted strength sessions restored | Merge treated a locally deleted workout as missing and pulled it back before the deletion queue drained. Empty-store restore also ignored tombstones. | Merge and restore respect tombstones; local edits/deletes are rechecked after fetching remote data. Workout/set replacement is atomic. Restore reuses the merge path. |
| Partial routine/custom deletion | Process death between child deletion, parent updates and tombstones could lose routine contents or forget a cloud deletion. | Transactional routine creation/edit/deletion and custom-exercise delete/tombstone writes. |
| Removed routine exercises remained in cloud | Upserting remaining child rows never deleted removed rows, including when a routine became empty. | Replace remote routine children before uploading the current list; mark synced only after successful completion. |
| Queued feedback crossed accounts | WorkManager payload had no owner; after an account switch it used whichever session was current. | New payloads include the originating UID, worker rejects mismatches, and temporarily missing auth retries. Legacy ownerless jobs are rejected because ownership cannot be recovered reliably. |

Simplification removed duplicate workout restore logic and duplicate session file write code, plus excessive blank lines left by repository extraction. The initial fixes did not change Room schemas. The follow-up below adds a required backend migration.

## Follow-up: outstanding code issues addressed

**Deployment requirement:** apply [20261021000046_atomic_android_sync.sql](../supabase/migrations/20261021000046_atomic_android_sync.sql) before distributing this Android build. The new client requires its RPCs. The migration was tested against isolated PostgreSQL; it has not been applied to the live backend.

| Previous finding | Follow-up change |
| --- | --- |
| Account lifetime | Concurrent account leases and exclusive auth transitions. Sign-in/out, deletion and auth-link imports drain registered operations. Workers establish local ownership before syncing. Cleanup is transactional and errors propagate; onboarding offers retry. Sign-out cancels queued account-sync jobs. Profile cache checks ownership. |
| Upload acknowledgement races | Captures workout/set, routine/item and custom snapshots; acknowledges only unchanged local data in a Room transaction. Concurrent edits stay dirty. Sync requests arriving during a running worker are preserved. |
| Non-atomic replacement | RLS-scoped sync_strength RPC commits workout sets, routines, custom exercises, tombstones and daily coaching totals together. Mandatory owner IDs reject stale payloads. |
| Feedback duplicates | save_workout_feedback commits completion and feedback together. Stable IDs survive direct-write fallback and WorkManager retries, including unplanned feedback. |
| Incomplete restoration | strength_snapshot returns all owned parents/children in coherent JSON without PostgREST row caps. Merge handles complete set contents, remote deletions, routines and customs. Dirty rows and tombstones win. Set notes round-trip. Partial restoration no longer prevents later pulls. |
| Stale totals after deletion | Sync obtains old/new dates from server rows and rebuilds affected dates in the same transaction. No local tombstone schema change is needed. |
| Swallowed cancellation | Explicit cancellation-preserving helper at repository, worker, health and ViewModel boundaries; sync workers rethrow cancellation. Added regression tests. |
| Skipped Navigation lint | Navigation updated from 2.8.1 to 2.8.9 on the existing toolchain. The fix is documented in the [official release notes](https://developer.android.com/jetpack/androidx/releases/navigation#2.8.3). |
| Other lint cleanup | OS guards for notification/alarm actions, Android 12+ backup/transfer exclusions, app-name resource reference and Compose modifier naming. |

Removed the old client-side multi-request daily rebuild and duplicate initial restoration path. Room remains v8 with unchanged entities.

## Validation and limits

- PostgreSQL tests passed in disposable PostgreSQL 16 using repository baseline migrations and RLS: rollback, removed routine children, retry idempotency, 1,100 parents/children, notes, deletion totals, feedback rollback and account isolation.
- Reproduce with bash scripts/test_android_sync.sh (Docker required; never connects to the configured backend).
- Added JVM tests for account draining/concurrency, nested leases and cancellation, plus a Room device test for edits/deletion during upload.
- Both flavors: 242 JVM tests passed, zero failures/errors/skips. Android 16 emulator: all 12 instrumented tests passed, including cache rollback and acknowledgement-race tests.
- Room schemas remain unchanged; git diff --check passed.
- Final lint/release verification is incomplete: the combined build reported Gradle heap exhaustion at 2 GiB. No successful completion was captured, and the temporary build log is no longer available. Existing lint reports predate the final changes and must not be treated as final verification. Re-run lint and assemblePlayRelease with fewer workers and a larger Gradle heap before release.
- Work was wrapped up on 2026-10-22 at the user’s request; no production migration or deployment was performed.

Still requiring product acceptance: real Play purchases, Health Connect data/permissions, manufacturer-specific background alarms and authenticated live-backend account switching. General dependency-age notifications are not all bugs; this pass updates the dependency causing skipped checks, without migrating the whole toolchain.

The coordinator covers registered repository operations and sync; internal token refresh remains SDK-managed. A complete in-memory snapshot avoids paging inconsistencies; very large accounts may eventually require a versioned paging protocol. Existing daily coaching-feed semantics remain per-day replacement, now atomic.

## Navigation for future models

Read [ANDROID_CODEBASE_GUIDE.md](ANDROID_CODEBASE_GUIDE.md) first for entry points, data ownership, invariants and commands. Treat this report as a dated review, and verify current code before implementing its follow-ups.
