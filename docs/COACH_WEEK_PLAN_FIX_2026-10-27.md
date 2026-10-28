# Coach week planning repair — 2026-10-27

## Observed failure

The Android coach displayed adjacent JSON tool requests as “Coach data”, then claimed to have planned a week despite showing an empty calendar. The fix is server-side and works with the existing APK.

## Causes and behavior

- `plan_week` advertised optional arguments, but the weekly endpoint required an explicit valid `start_date`. The bridge now sends a concrete Monday and the athlete's local today; the endpoint also supports an omitted start date using local today. The saved week and the read-back use the same date window. Daily generation also pins the local date.
- Some native-tool providers emitted the JSON action protocol as ordinary text. `coach_protocol.ts` accepts a whole single request, an array, or adjacent/JSONL requests with validated object arguments and a maximum batch of eight. Malformed/mixed payloads are not partially executed or returned to the athlete as the final answer.
- Native observations now carry into the JSON fallback, rather than spending the remaining turn budget re-reading fitness, readiness and profile data. Existing per-turn read/write deduplication remains intact.
- `tools_used` in completed responses now includes write names only after an explicit successful observation. Attempted writes still emit progress events. This keeps existing Android/web success cards compatible without treating attempts as completed actions.
- HTTP errors, non-JSON/invalid responses, zero newly scheduled sessions, failed calendar read-back, and missing persisted rows cannot confirm a weekly save. Successful read-back includes the actual calendar sessions. A failed-only turn produces an honest failure message; exhausting narration after a confirmed write does not falsely claim nothing was applied.

## Code map

- `supabase/functions/coach-chat/index.ts`: native/JSON fallback, observations, write receipts and final response.
- `supabase/functions/_shared/coach_protocol.ts`: bounded protocol parsing and success detection.
- `supabase/functions/_shared/coach_tools.ts`: explicit dates, HTTP validation and verified weekly save observations.
- `supabase/functions/plan-week/index.ts`: optional start-date normalization.

## Validation and deployment

- Shared suite: 704 tests passed, including eight new regression cases for the screenshot's payload, malformed commands, write receipts, omitted arguments, local dates, failed HTTP responses, zero writes and missing persisted sessions.
- `coach-chat` and `plan-week` passed Deno type checking and were deployed.
- An authenticated live past-week request reached the deployed planner and returned the expected “week already over” rejection. Before/after calendar IDs and dates were unchanged. This verifies the live authenticated request/database path without generating or replacing the athlete's plan.
- A complete live week generation was not run as a test. The athlete can retry “Plan my week”; historical failed chat messages remain in conversation history.

## Follow-up: actual profile validation failure

The first live check only verified a past-week rejection, so it missed a separate failure inside session construction. Live `generate-workout` logs showed `pool.seconds_per_length` failing numeric validation because Android profile JSON stores an unanswered timing value as `null`. That shared swim configuration was passed into every sport, so it also prevented strength/running sessions and complete weeks from building.

`session_context.ts` now converts an unanswered timing value to absence, preserving the engine's unknown-pace behavior. Pool settings are included only in swimming state. Invalid supplied timings (zero, negative or nonnumeric) still fail validation. A missing pool profile remains missing; no pace or distance is invented.

Validation: 707 shared tests passed, including all five sport states and a complete mixed-sport week from the nullable serialized profile. All edge functions passed type checking. A read-only preview against the configured development profile/history built six executable sessions and verified that the calendar was unchanged. The shared change is deployed to all nine affected functions. Full generation/save was not invoked as a test.

The diagnostic CLI also now uses the supported unified log query endpoint and ISO timestamps. The old endpoint had been removed; see the [official Supabase migration notice](https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint). The helper was checked with `bash -n` and a real `generate-workout` log query.

## Follow-up: final review and persistence on the affected app account

The configured development account differed from the account behind the app failure. Its preview was therefore insufficient evidence for the athlete's complete request. Reproduction against the affected account's stored profile/history identified an active injury: the strength selector chose a contraindicated movement, and final review removed it from display sections while the canonical prescription still contained it. The final projection gate correctly rejected the inconsistent workout.

`sessionState` now derives exercise exclusions from the same active injury rules used by final review. The deterministic strength builder selects from eligible exercises before constructing work/sets, and the proposal compiler rejects an excluded exercise too. Final review and canonical projection checks remain enabled. An additional projection bug omitted `plan`, `plan_expires_at` and `use_hosted_ai` from generation profile reads, incorrectly routing hosted subscribers to unconfigured personal keys; those entitlement fields are now included and tested.

Validation: 710 shared tests passed and all function entry points type-checked. The exact deployed planner implementation was invoked for the affected account through the authenticated administrative database client, including generation, final safety review, atomic save and read-back. Six executable calendar days were persisted, with protected sessions preserved. This was an actual save, not a preview. The injury-dependent functions and all users of the expanded profile projection were deployed.

External delivery remains queued: the local verification environment could not decrypt the calendar credential; a subsequent administrative remote sync request was rejected as unauthorized. Neither failure rolled back the saved week. The app's user-authenticated sync path was not exercised in this verification. Do not describe this as a successful watch push.
