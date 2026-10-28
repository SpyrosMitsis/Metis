package com.workoutmaker.app.data

import com.workoutmaker.app.util.runCatching

import io.github.jan.supabase.functions.functions
import io.ktor.client.call.body
import io.ktor.client.request.setBody
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.put
import com.workoutmaker.app.calendar.DeviceCalendarManager
import com.workoutmaker.app.calendar.calendarEventDetail
import com.workoutmaker.app.calendar.calendarEventTitle
import com.workoutmaker.app.util.AppLog
import java.time.LocalDate
import kotlinx.serialization.json.buildJsonObject

// --- Edge functions ------------------------------------------------------
// Write-through cached: a successful fetch is persisted so an offline cold
// start can still show the last dashboard instead of a bare error.
// Sends the device's LOCAL date — the server's UTC clock is yesterday for
// tz-ahead users until mid-morning, which made Home show the wrong day.
suspend fun WorkoutRepository.dailySummary(date: LocalDate = LocalDate.now()): DailySummary = withAccount {
    val body = buildJsonObject {
        put("date", JsonPrimitive(date.toString()))
    }.toString()
    val s: DailySummary = json.decodeFromString(
        supabase.functions.invoke("daily-summary") { setBody(body) }.body(),
    )
    runCatching {
        cache.upsertSummary(
            CachedSummary(
                date = s.date,
                json = json.encodeToString(DailySummary.serializer(), s),
                fetchedAt = System.currentTimeMillis(),
            ),
        )
    }.logFailure("dailySummary/cache")
    return@withAccount s
}

// --- Injury follow-up loop ------------------------------------------------
// Both answers go to the server rather than being written from here, because
// both have consequences the phone should not be deciding: "resolved" also has
// to drop any active backoff, and a pain score is escalated into a dated
// instruction by one rule that lives (and is tested) in _shared/injury.ts.
// Token-free: injury-checkin calls no LLM.

// "Is it still bothering you?" -> present | better | resolved.
suspend fun WorkoutRepository.answerInjuryCheckin(
    area: String,
    status: String,
    date: LocalDate = LocalDate.now(),
) = withAccount {
    val body = buildJsonObject {
        put("kind", JsonPrimitive("followup"))
        put("area", JsonPrimitive(area))
        put("status", JsonPrimitive(status))
        put("date", JsonPrimitive(date.toString()))
    }.toString()
    supabase.functions.invoke("injury-checkin") { setBody(body) }
}

// Post-workout pain, 1-5 on the same scale as the morning soreness check.
// Returns what the server decided to do about it, so the UI can say so.
suspend fun WorkoutRepository.reportPain(
    area: String,
    pain: Int,
    plannedWorkoutId: String? = null,
    date: LocalDate = LocalDate.now(),
): PainReportResult = json.decodeFromString(
    supabase.functions.invoke("injury-checkin") {
        setBody(
            buildJsonObject {
                put("kind", JsonPrimitive("pain"))
                put("area", JsonPrimitive(area))
                put("pain", JsonPrimitive(pain))
                put("date", JsonPrimitive(date.toString()))
                plannedWorkoutId?.let { put("planned_workout_id", JsonPrimitive(it)) }
            }.toString(),
        )
    }.body(),
)

// Token-free daily viability check (weather-check/index.ts calls no LLM).
// Best-effort by design: a failed/null result just means no weather line on
// the morning notification, never a broken reminder.
suspend fun WorkoutRepository.weatherCheck(date: LocalDate, lat: Double?, lon: Double?): WeatherCheckResult = withAccount {
    val body = buildJsonObject {
        put("date", JsonPrimitive(date.toString()))
        lat?.let { put("lat", JsonPrimitive(it)) }
        lon?.let { put("lon", JsonPrimitive(it)) }
    }.toString()
    return@withAccount json.decodeFromString(
        supabase.functions.invoke("weather-check") { setBody(body) }.body(),
    )
}

// The coach's proactive daily note. Generated server-side at most once per
// calendar day; cached in Room keyed by date so re-opening Home is free and
// offline. Returns null when disabled, not yet generated offline, or empty.
// Whether today's brief is already cached, i.e. whether requesting it would
// trigger the day's one LLM generation. Lets Home sync fresh recovery data
// BEFORE the generation, and skip that work on every later open.
suspend fun WorkoutRepository.hasCachedBrief(date: String = LocalDate.now().toString()): Boolean =
    runCatching { cache.brief(date) != null }.getOrDefault(false)

suspend fun WorkoutRepository.coachBrief(date: String = LocalDate.now().toString()): String? = withAccount {
    runCatching { cache.brief(date) }.getOrNull()?.let { return@withAccount it.text }
    val body = buildJsonObject {
        put("date", JsonPrimitive(date))
    }.toString()
    val resp: CoachBriefResponse = runCatching {
        json.decodeFromString<CoachBriefResponse>(
            supabase.functions.invoke("coach-brief") { setBody(body) }.body(),
        )
    }.logFailure("coachBrief").getOrNull() ?: return@withAccount null
    val text = resp.brief?.takeIf { it.isNotBlank() }
    // Only a real brief is cached. The server returns none while there is no
    // readiness to speak of (skipped = "no_readiness_data") rather than spending
    // a generation on its placeholder score, and caching that would mean today's
    // check-in never produced the note it just earned.
    if (text != null) runCatching { cache.upsertBrief(CachedBrief(date, text)) }.logFailure("coachBrief/cache")
    return@withAccount text
}

// The coach's weekly recap, generated once per week (one LLM call) and cached
// in Room keyed by the week-start so re-opening Home is free. `weekStart` must
// be the Monday of the target week. Null when not generated / empty / offline.
suspend fun WorkoutRepository.weekReview(weekStart: String): String? = withAccount {
    runCatching { cache.weekReview(weekStart) }.getOrNull()?.let { return@withAccount it.text }
    val body = buildJsonObject {
        put("week_start", JsonPrimitive(weekStart))
    }.toString()
    val resp: CoachWeekReviewResponse = runCatching {
        json.decodeFromString<CoachWeekReviewResponse>(
            supabase.functions.invoke("coach-week-review") { setBody(body) }.body(),
        )
    }.logFailure("weekReview").getOrNull() ?: return@withAccount null
    val text = resp.review?.takeIf { it.isNotBlank() }
    if (text != null) runCatching { cache.upsertWeekReview(CachedWeekReview(weekStart, text)) }.logFailure("weekReview/cache")
    return@withAccount text
}

// Last successfully-fetched summary + when it was fetched (offline fallback).
suspend fun WorkoutRepository.cachedDailySummary(): Pair<DailySummary, Long>? = runCatching {
    cache.latestSummary()?.let { row ->
        json.decodeFromString(DailySummary.serializer(), row.json) to row.fetchedAt
    }
}.logFailure("cachedDailySummary").getOrNull()

suspend fun WorkoutRepository.generateWorkout(req: GenerateRequest): String =
    AppLog.time("gen", "generate-workout date=${req.date} type=${req.type}") {
        val enriched = req.copy(date = req.date ?: java.time.LocalDate.now().toString(), calendar_busy = req.calendar_busy ?: calendarBusy(req.date, days = 1))
        val out: String = supabase.functions.invoke("generate-workout") {
            setBody(json.encodeToString(GenerateRequest.serializer(), enriched))
        }.body()
        if (req.push) syncPlanToDeviceCalendar()
        out
    }

// Mirror the next two weeks of the plan into the device calendar as all-day
// events. Called after anything that changes planned_workouts; cheap no-op
// when the toggle is off. Failures never break the caller.
suspend fun WorkoutRepository.syncPlanToDeviceCalendar() = withAccount {
    runCatching {
        val enabled = prefs.settings.first().calendarWrite
        if (!enabled || !deviceCalendar.hasWritePermission()) return@withAccount
        val from = LocalDate.now()
        val until = from.plusDays(14)
        val entries = plannedWorkouts(from.toString())
            .filter { it.workout_json.duration_minutes > 0 && !it.skipped }
            .mapNotNull { p ->
                val date = runCatching { LocalDate.parse(p.date) }.getOrNull()
                    ?: return@mapNotNull null
                if (date >= until) return@mapNotNull null
                val w = p.workout_json
                DeviceCalendarManager.PlanEntry(
                    date = p.date,
                    title = calendarEventTitle(w, p.type),
                    detail = calendarEventDetail(w, p.type),
                    startMinute = p.start_minute, durationMinutes = w.duration_minutes.toDouble(),
                )
            }
        deviceCalendar.syncPlan(entries, from, 14)
    }.logFailure("syncPlanToDeviceCalendar")
}

suspend fun WorkoutRepository.syncIntervals(): String =
    supabase.functions.invoke("sync-intervals").body()

suspend fun WorkoutRepository.intervalsStats(): IntervalsStats =
    json.decodeFromString(supabase.functions.invoke("intervals-stats").body())

suspend fun WorkoutRepository.connectIntervals(athleteId: String, apiKey: String): String =
    supabase.functions.invoke("connect-intervals") {
        setBody(
            buildJsonObject {
                put("athleteId", JsonPrimitive(athleteId))
                put("apiKey", JsonPrimitive(apiKey))
            }.toString(),
        )
    }.body()

suspend fun WorkoutRepository.testLlmKey(req: TestKeyRequest): TestKeyResponse =
    json.decodeFromString(
        supabase.functions.invoke("test-llm-key") {
            setBody(json.encodeToString(TestKeyRequest.serializer(), req))
        }.body(),
    )

private fun WorkoutRepository.workoutIdBody(workoutId: String): String =
    buildJsonObject { put("workout_id", JsonPrimitive(workoutId)) }.toString()

suspend fun WorkoutRepository.pushWorkout(workoutId: String): String =
    supabase.functions.invoke("push-workout") { setBody(workoutIdBody(workoutId)) }.body()

// Delete a planned workout (and its Intervals.icu/watch event) server-side.
suspend fun WorkoutRepository.deletePlannedWorkout(workoutId: String): String = withAccount {
    val out: String = supabase.functions.invoke("delete-workout") { setBody(workoutIdBody(workoutId)) }.body()
    syncPlanToDeviceCalendar()
    return@withAccount out
}

// Garmin-style execution analysis (score, pace-vs-target series, AI
// feedback). Cached server-side; force = true recomputes.
// peek = true returns only an already-cached analysis (never runs the LLM).
suspend fun WorkoutRepository.analyzeActivity(activityId: String, force: Boolean = false, peek: Boolean = false): ActivityAnalysis =
    json.decodeFromString(
        supabase.functions.invoke("analyze-activity") {
            setBody(
                buildJsonObject {
                    put("activity_id", JsonPrimitive(activityId))
                    put("force", JsonPrimitive(force))
                    put("peek", JsonPrimitive(peek))
                }.toString(),
            )
        }.body(),
    )

// Execution analysis for a logged strength session (planned vs lifted).
suspend fun WorkoutRepository.analyzeStrength(date: String, force: Boolean = false, peek: Boolean = false, workoutId: String? = null): StrengthAnalysis =
    json.decodeFromString(
        supabase.functions.invoke("analyze-strength") {
            setBody(
                buildJsonObject {
                    put("date", JsonPrimitive(date))
                    workoutId?.let { put("workout_id", JsonPrimitive(it)) }
                    put("force", JsonPrimitive(force))
                    put("peek", JsonPrimitive(peek))
                }.toString(),
            )
        }.body(),
    )

suspend fun WorkoutRepository.pushStrengthWorkout(req: PushStrengthRequest): PushResult =
    json.decodeFromString(
        supabase.functions.invoke("push-strength") {
            setBody(json.encodeToString(PushStrengthRequest.serializer(), req))
        }.body(),
    )
