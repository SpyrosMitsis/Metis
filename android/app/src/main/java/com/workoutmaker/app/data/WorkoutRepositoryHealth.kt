package com.workoutmaker.app.data

import com.workoutmaker.app.util.runCatching

import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Order
import io.ktor.client.call.body
import com.workoutmaker.app.health.HcExercise
import com.workoutmaker.app.health.HealthSnapshot
import com.workoutmaker.app.util.AppLog

suspend fun WorkoutRepository.upsertWellness(checkin: WellnessCheckin) = withAccount {
    supabase.postgrest.from("wellness_checkins").upsert(checkin, onConflict = "user_id,date")
}

// Manually-entered HRV / resting HR / sleep for a day the watch didn't sync —
// writes only the provided columns onto that day's wellness row (source=manual),
// exactly like the Health Connect path so energy/soreness aren't clobbered.
suspend fun WorkoutRepository.upsertManualRecovery(date: String, hrvMs: Double?, restingHr: Int?, sleepMinutes: Int?) = withAccount {
    val row = WellnessHealthUpdate(
        date = date,
        hrv_rmssd = hrvMs,
        resting_hr = restingHr,
        zepp_sleep_minutes = sleepMinutes,
        source = "manual",
    )
    supabase.postgrest.from("wellness_checkins").upsert(row, onConflict = "user_id,date")
}

// HRV / resting-HR / sleep history for the recovery-trends screen, oldest→newest.
suspend fun WorkoutRepository.recoveryHistory(fromDate: String): List<RecoveryHistoryPoint> =
    supabase.postgrest.from("wellness_checkins").select {
        filter { gte("date", fromDate) }
        order("date", Order.ASCENDING)
    }.decodeList()

// Body-composition history for the Body trends screen, oldest→newest.
// Explicit columns: pre-migration DBs error on them → empty list, and the
// screen shows its empty state instead of crashing.
suspend fun WorkoutRepository.bodyHistory(fromDate: String): List<BodyHistoryPoint> = runCatching {
    supabase.postgrest.from("wellness_checkins").select(
        io.github.jan.supabase.postgrest.query.Columns.list("date", "weight_kg", "body_fat_pct", "lean_mass_kg"),
    ) {
        filter { gte("date", fromDate) }
        order("date", Order.ASCENDING)
    }.decodeList<BodyHistoryPoint>().filter {
        it.weight_kg != null || it.body_fat_pct != null || it.lean_mass_kg != null
    }
}.logFailure("bodyHistory").getOrDefault(emptyList())

// Dated body metrics (scale sync or manual quick-log) onto wellness rows.
suspend fun WorkoutRepository.upsertBodyMetrics(rows: List<BodyMetricUpsert>) = withAccount {
    if (rows.isEmpty()) return@withAccount
    supabase.postgrest.from("wellness_checkins").upsert(rows, onConflict = "user_id,date")
}

// Today's subjective check-in (energy/soreness/sleep quality), if answered.
// The row may exist with only Health Connect metrics — energy == null means
// the morning questions haven't been answered yet.
suspend fun WorkoutRepository.wellnessCheckin(date: String): WellnessCheckin? =
    supabase.postgrest.from("wellness_checkins").select {
        filter { eq("date", date) }
    }.decodeList<WellnessCheckin>().firstOrNull()

// Upsert a multi-day Health Connect series (7-day trend) in one call.
suspend fun WorkoutRepository.submitHealthSnapshots(snaps: List<HealthSnapshot>) = withAccount {
    val rows = snaps.filter { it.hasAny }.map { snap ->
        WellnessHealthUpdate(
            date = snap.date,
            hrv_rmssd = snap.hrvRmssd,
            resting_hr = snap.restingHr,
            zepp_sleep_minutes = snap.sleepMinutes,
            steps = snap.steps,
            sleep_deep_min = snap.sleepDeepMin,
            sleep_rem_min = snap.sleepRemMin,
            vo2max = snap.vo2max,
        )
    }
    if (rows.isNotEmpty()) {
        supabase.postgrest.from("wellness_checkins").upsert(rows, onConflict = "user_id,date")
    }
}

data class HealthSyncResult(
    val week: List<HealthSnapshot> = emptyList(),
    val activitiesUpserted: Int = 0,
)

// One Health Connect sync for every trigger (Home pull-to-refresh, Settings,
// Calendar): pushes the 7-day wellness trend, and — only when intervals.icu
// is NOT connected — ingests exercise sessions as fallback activities with
// an estimated training load. Intervals users get richer versions of the
// same sessions from sync-intervals, so the gate avoids cross-source dupes.
suspend fun WorkoutRepository.syncHealth(): HealthSyncResult = withAccount {
    if (!health.isAvailable) return@withAccount HealthSyncResult()
    val week = health.readWeek(7)
    if (week.isNotEmpty()) submitHealthSnapshots(week)
    runCatching { syncBodyComp() }.logFailure("syncBodyComp")
    val intervalsConnected = runCatching { intervalsConnection() != null }.getOrDefault(true)
    if (intervalsConnected) return@withAccount HealthSyncResult(week)
    return@withAccount HealthSyncResult(week, ingestHcExercises())
}

// Smart-scale weight/body-fat from Health Connect → the training profile,
// so strength generation always sees current body composition. Only patches
// an already-set-up profile (never resurrects a half-finished onboarding),
// and only when a value actually changed.
private suspend fun WorkoutRepository.syncBodyComp() {
    val bc = health.readBodyComp()
    if (bc.weightKg == null && bc.bodyFatPct == null) return
    val p = loadProfile() ?: return
    if (p == TrainingProfile()) return
    val newWeight = bc.weightKg?.let { Math.round(it).toInt() } ?: p.weight_kg
    val newBodyFat = bc.bodyFatPct?.let { Math.round(it * 10) / 10.0 } ?: p.body_fat_pct
    if (newWeight != p.weight_kg || newBodyFat != p.body_fat_pct) {
        AppLog.i("health", "body comp from HC: ${newWeight}kg, bf=$newBodyFat%")
        saveProfile(p.copy(weight_kg = newWeight, body_fat_pct = newBodyFat))
    }
    // Dated history behind the Body trends screen. Own runCatching: on a
    // pre-migration DB the upsert fails and must never undo the profile
    // patch above; it starts working the moment the columns exist.
    runCatching {
        val rows = health.readBodyHistory().map {
            BodyMetricUpsert(
                date = it.date,
                weight_kg = it.weightKg,
                body_fat_pct = it.bodyFatPct,
                lean_mass_kg = it.leanMassKg,
            )
        }
        upsertBodyMetrics(rows)
        if (rows.isNotEmpty()) {
            AppLog.d("health", "body history: ${rows.size} days upserted")
        }
    }.logFailure("bodyHistoryUpsert")
}

// Health Connect exercise sessions → completed_activities rows ("hc:<uid>").
// Upsert on (user_id, intervals_id) keeps re-syncs idempotent.
private suspend fun WorkoutRepository.ingestHcExercises(): Int {
    suspend fun recordSync(error: String? = null, success: Boolean = false) {
        supabase.postgrest.from("activity_sync_state").upsert(kotlinx.serialization.json.buildJsonObject {
            put("user_id", kotlinx.serialization.json.JsonPrimitive(uid()))
            put("source", kotlinx.serialization.json.JsonPrimitive("health_connect"))
            put("last_attempt_at", kotlinx.serialization.json.JsonPrimitive(java.time.Instant.now().toString()))
            put("last_error", error?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
            if (success) {
                put("last_success_at", kotlinx.serialization.json.JsonPrimitive(java.time.Instant.now().toString()))
                put("coverage_from", kotlinx.serialization.json.JsonPrimitive(java.time.LocalDate.now().minusDays(30).toString()))
                put("coverage_to", kotlinx.serialization.json.JsonPrimitive(java.time.LocalDate.now().toString()))
            }
        }, onConflict = "user_id,source")
    }
    recordSync()
    try {
    val sessions = health.readExerciseSessions(30)
    if (sessions.isEmpty()) { recordSync(success = true); return 0 }
    // Skip watch-recorded gym sessions the athlete also logged in the app.
    val earliest = sessions.minOf { it.startMs }
    val logged = runCatching { strengthDao.workoutsSince(earliest) }.getOrDefault(emptyList())
    val slackMs = 30 * 60 * 1000L
    fun overlapsLoggedStrength(s: HcExercise): Boolean =
        logged.any { w -> s.startMs < w.endedAt + slackMs && w.startedAt < s.endMs + slackMs }
    val lthr = runCatching { loadProfile()?.lthr }.getOrNull()
    val rows = sessions
        .filterNot { it.type == "Weight training" && overlapsLoggedStrength(it) }
        .map { s ->
            val hours = s.durationSec / 3600.0
            // HR-based estimate when we can (TRIMP-style: an hour at LTHR
            // ≈ 100 TSS); otherwise the same duration heuristic manual
            // logging uses (≈ 50 TSS/hour, a moderate effort).
            val tss = if (s.avgHr != null && lthr != null && lthr > 0) {
                val r = s.avgHr.toDouble() / lthr
                hours * r * r * 100
            } else {
                (s.durationSec / 60) * 5 / 6.0
            }
            HcActivityInsert(
                intervals_id = "hc:${s.uid}",
                source_id = s.uid,
                started_at = java.time.Instant.ofEpochMilli(s.startMs).toString(),
                ended_at = java.time.Instant.ofEpochMilli(s.endMs).toString(),
                start_local_date = s.date,
                end_local_date = s.endDate,
                timezone_name = s.timezoneName,
                timezone_provenance = s.timezoneProvenance,
                data_json = kotlinx.serialization.json.buildJsonObject {
                    s.origin?.let { put("origin", kotlinx.serialization.json.JsonPrimitive(it)) }
                },
                measurement_provenance = kotlinx.serialization.json.buildJsonObject {
                    put("duration_seconds", kotlinx.serialization.json.JsonPrimitive("observed"))
                    put("distance_m", kotlinx.serialization.json.JsonPrimitive(if (s.distanceM == null) "unavailable" else "observed"))
                    put("avg_hr", kotlinx.serialization.json.JsonPrimitive(if (s.avgHr == null) "unavailable" else "observed"))
                    put("tss", kotlinx.serialization.json.JsonPrimitive("estimated"))
                },
                type = s.type,
                date = s.date,
                duration_seconds = s.durationSec,
                distance_m = s.distanceM,
                avg_hr = s.avgHr,
                tss = Math.round(tss * 10) / 10.0,
            )
        }
    if (rows.isNotEmpty()) {
        supabase.postgrest.from("completed_activities")
            .upsert(rows, onConflict = "user_id,intervals_id")
    }
    AppLog.d(
        "health",
        "hc exercise ingest: ${sessions.size} sessions, ${rows.size} upserted",
    )
    recordSync(success = true)
    return rows.size
    } catch (e: Exception) {
        runCatching { recordSync(error = e.message ?: "Health Connect sync failed") }
        throw e
    }
}
