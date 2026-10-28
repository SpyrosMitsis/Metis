# Direct Zepp workout delivery — 2026-10-27

## Finding

A supported route exists in principle for removing Intervals.icu from workout delivery:

**Metis → Zepp Open Platform → Zepp ecosystem → compatible Amazfit watch.**

This is direct integration with Zepp's cloud, not a demonstrated direct Bluetooth protocol from Metis to the watch. Amazfit's [Active 3 Premium June update](https://us.amazfit.com/blogs/product-update/elevate-transcend-the-active-3-premium-june-update) explicitly announces third-party plan imports and training-calendar display. That supports device feasibility; it does not establish that every workout type in our app can execute natively on this particular watch.

No Zepp connector was implemented or authenticated during this investigation. No account or watch was connected, and the existing Intervals.icu integration was not removed.

## Official API and access

The [Zepp Workout API](https://devopen.zepp.com/docs/data-apis/workout-api) accepts structured future workouts through `POST /users/-/workouts?version=2.0.0` using a bearer token. Updates represent a complete seven-calendar-day window, including when only one session changes. A populated window's end date must be start date plus six days. Empty-window submissions have separate rolling deletion semantics; do not treat an empty payload as an innocuous no-op.

Production access requires [partner onboarding](https://devopen.zepp.com/docs/getting-started/partner-onboarding), enterprise verification, application registration, permission approval and client credentials. The documented process asks for enterprise/organization information; individual-project eligibility needs confirmation with Zepp rather than assuming that an ordinary Zepp account grants API access. [OAuth authorization code flow](https://devopen.zepp.com/docs/authentication/oauth2-overview) is the recommended authorization mechanism.

## Workout-format limits

The [V2 schema](https://devopen.zepp.com/docs/data-apis/workout-v2-schema) documents workout identity/date/sport, warm-up/work/recovery/cool-down stages, time/distance durations, repeated blocks, and pace/heart-rate/power targets. Running, cycling and swimming are example sports.

It does not document a structured strength exercise/set/reps/load schema or an RPE target type. Therefore:

- Endurance export looks feasible, subject to target/unit and watch-mode validation.
- Never invent pace, heart rate or watts merely to fill required numeric fields for our effort-only prescriptions.
- Exact strength execution and effort-only export need confirmation from Zepp. Putting text in a description is not equivalent to native set-by-set guidance.
- API acceptance is not proof of watch receipt or execution fidelity. Test each supported sport on the Active 3 Premium.

## Fit with this app

The current retryable delivery code in `_shared/calendar_outbox.ts` is Intervals-specific. A direct Zepp implementation should retain the prescription engine and atomic app-calendar saves, then add a separate provider adapter:

1. OAuth connect/disconnect, server-side client secret and encrypted token storage/refresh; no Zepp password collection for the official route.
2. Stable numeric provider identity mapping for the app's UUID workout IDs.
3. A canonical-prescription exporter that rejects unsupported dose/target representations rather than silently changing the workout.
4. Coalesced seven-day snapshot delivery. One changed session must not accidentally erase the other six days. Preserve provider ownership and make retries/deletions explicit.
5. Separate app-save, Zepp-accepted and watch-verification states. Do not claim watch delivery from an HTTP success alone.
6. Physical tests for repeated intervals, rest, edits/deletes, two sessions on one day, timezone boundaries, token expiry and unavailable watch modes.

Intervals can become optional after direct delivery is proven; it also currently supplies incoming activity/fitness data. Replacing outbound delivery alone does not automatically replace those inbound sources. Zepp separately documents activity FIT and health delivery in its [platform introduction](https://devopen.zepp.com/docs/getting-started/introduction).

## Unofficial alternative

The author's [amazfit-mcp project](https://github.com/fjuliofontes/amazfit-mcp) implements workout-template/calendar writes using reverse-engineered Zepp cloud endpoints and web-account login. This demonstrates another technical avenue, but it is not official partner access or evidence of reliable support for this watch and every sport. Account/password handling and dependence on undocumented endpoints make it a separate experimental option rather than a drop-in production replacement.

## First prerequisite

Confirm partner eligibility and obtain approved Zepp application credentials. The public documentation explicitly places onboarding/permission approval before technical integration. An ordinary “Connect Zepp” button cannot supply those developer credentials by itself.

## Inbound data parity investigation

The app can be designed to operate without Intervals.icu, but “all current values directly from Zepp” is not established. Provider measurements, provider-derived training scores and app/user data must remain distinct.

### Current dependencies found in code

- `sync-intervals/index.ts` imports 60 days of activity identity, local date, sport, moving duration, distance, average HR, training load and CTL/ATL; it retains the raw payload.
- The same sync mirrors sleep duration/score, HRV, resting HR and VO2max into wellness observations.
- `_shared/intervals.ts` also exposes demographics, weight, sport thresholds and HR/pace/power zones.
- `_shared/analyze_core.ts` requests time, velocity, HR, distance, cadence and power streams for execution analysis. Its stream acquisition and strength/watch-HR paths currently remain Intervals-specific; a new summary-only importer would not replace these features.
- `_shared/load.ts` already estimates CTL/ATL from dated TSS and derives form from their difference. This is a starting point, not evidence that a Zepp pipeline will reproduce Intervals' numbers.
- Android `HealthConnectManager` and `WorkoutRepositoryHealth` already support a non-Intervals route for some health/activity observations and estimated activity load. Actual Zepp-to-Health-Connect availability still needs validation.
- In-app strength sets, goals, injuries, subjective check-ins, preferences and feedback are app-owned and do not require Intervals.

### Official Zepp capabilities and gaps

| Current input/function | Direct Zepp replacement assessment |
| --- | --- |
| Completed activity feed | Official [activity notifications](https://devopen.zepp.com/docs/webhook/activity-events) plus [FIT downloads](https://devopen.zepp.com/docs/data-apis/download-fit-file). Parse records into provider-neutral activities rather than pretending they are Intervals rows. |
| Workout graphs and execution analysis | Potentially reconstruct from FIT samples when present. Exact HR/speed/power/cadence/pool/set coverage must be checked against real Active 3 Premium exports; an activity-type enumeration alone proves no field-level coverage. |
| Sleep duration, stages, naps and score | Explicitly documented by [Sleep Events](https://devopen.zepp.com/docs/webhook/sleep-events). Optional/null fields must remain unknown. |
| Overnight HRV | [HRV Events](https://devopen.zepp.com/docs/webhook/hrv-events) documents a nightly average; granular samples may be null. Confirm metric definition and units before mapping it into the app's `hrv_rmssd` field or merging it with an existing baseline. |
| Heart-rate observations | A [transitional heart-rate API](https://devopen.zepp.com/docs/data-apis/heartrate-data-pull) is documented. This does not itself prove a separately exposed resting-HR summary. Do not substitute minimum pulse for resting HR. |
| Resting HR, VO2max and exact sport thresholds/zones | Field-level parity not confirmed from the public contracts inspected. Seek approved payload examples/Zepp confirmation; Health Connect or explicit user calibration may supply some values. Do not invent them. |
| TSS/training-load scores | Current Intervals values are derived provider data, not guaranteed Zepp equivalents. Implement/validate an app-owned estimate from appropriate measured inputs and label its provenance; never relabel an unrelated Zepp score as TSS. |
| CTL/ATL/TSB trends | Can be calculated in the app/backend from a consistent load series. Existing `_shared/load.ts` supplies an implementation. Matching Intervals numerically is not guaranteed, particularly during history/baseline changes. |
| App readiness and adaptations | Existing app logic can consume normalized supported observations. Availability of every proprietary Zepp readiness/recovery score is not established or required for the app's own model. |
| Demographics/body data | The [profile API](https://devopen.zepp.com/docs/data-apis/user-profile-api) covers a limited profile and even shows birthday at month precision. Do not replace a precise saved birth date with an invented day. The [body API](https://devopen.zepp.com/docs/data-apis/body-data-pull) is transitional; actual measurement coverage needs validation. |
| Imported activity from other vendors | Zepp cannot be assumed to contain everything aggregated by Intervals. Preserve existing cached history and separately assess other devices/accounts. |

Historical activities, sleep and HRV can be requested through the [Backfill API](https://devopen.zepp.com/docs/data-apis/backfill-api). Its 30-day maximum is per request, not proof that only 30 days of history exist or proof of unlimited retention. Availability and completeness need verification before declaring training history reviewed.

### Migration implications

Direct inbound integration requires OAuth, asynchronous webhook handling, FIT ingestion/decoding, a provider-neutral sample store/reader, metric provenance, coverage/freshness tracking and duplicate reconciliation. Keep existing app plan IDs and actual-versus-planned evidence separate. A provider switch must neither double training load nor silently turn missing historical days into confirmed rest. Older Intervals-derived load and newly estimated load need an explicit consistency/baseline policy.

Run both sources against real watch exports before removing the bridge, comparing dates, durations, samples, sleep, HRV and missing fields. Preserve imported history and user-entered settings. Only mark a feature replaced after its complete path works, including detailed analysis rather than just dashboard summaries.

The same [Zepp partner/enterprise/permission approval](https://devopen.zepp.com/docs/getting-started/partner-onboarding) remains a prerequisite for official production access. No direct inbound connector or live account authorization was implemented in this research pass.
