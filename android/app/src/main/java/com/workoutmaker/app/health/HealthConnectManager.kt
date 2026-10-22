package com.workoutmaker.app.health

import com.workoutmaker.app.util.runCatching

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import dagger.hilt.android.qualifiers.ApplicationContext
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject
import javax.inject.Singleton
import androidx.health.connect.client.records.Record
import com.workoutmaker.app.data.adaptWeek

/** A day's wellness snapshot read from Health Connect. All fields are optional. */
data class HealthSnapshot(
    val date: String,
    val hrvRmssd: Double? = null,
    val restingHr: Int? = null,
    val sleepMinutes: Int? = null,
    val sleepDeepMin: Int? = null,
    val sleepRemMin: Int? = null,
    val steps: Int? = null,
    val vo2max: Double? = null,
) {
    val hasAny: Boolean get() =
        hrvRmssd != null || restingHr != null || sleepMinutes != null || steps != null || vo2max != null
}

/** A workout session read from Health Connect (any watch brand's app writes these). */
data class HcExercise(
    val uid: String,
    val type: String,          // app-friendly: "Run", "Ride", "Weight training", …
    val date: String,          // local calendar date of the session start
    val startMs: Long,
    val endMs: Long,
    val durationSec: Int,
    val distanceM: Double? = null,
    val avgHr: Int? = null,
    val endDate: String? = null,
    val timezoneName: String? = null,
    val timezoneProvenance: String = "unavailable",
    val origin: String? = null,
)

@Singleton
class HealthConnectManager @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    val permissions: Set<String> = setOf(
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(Vo2MaxRecord::class),
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        // Body composition (smart scales write these): feeds the profile's
        // weight/body-fat so strength prescriptions know the athlete's mass,
        // and the dated history behind the Body trends screen.
        HealthPermission.getReadPermission(WeightRecord::class),
        HealthPermission.getReadPermission(BodyFatRecord::class),
        HealthPermission.getReadPermission(LeanBodyMassRecord::class),
        // Lets WorkManager (morning readiness) read last night's data without the
        // app in the foreground. Literal string: the connect-client constant only
        // exists in newer alphas. Best-effort — denial keeps the fixed-time path.
        "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND",
    )

    /** SDK_AVAILABLE / SDK_UNAVAILABLE / SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED. */
    fun sdkStatus(): Int = HealthConnectClient.getSdkStatus(context)

    val isAvailable: Boolean get() = sdkStatus() == HealthConnectClient.SDK_AVAILABLE

    /** Play Store / system URL to install or update the Health Connect provider. */
    val providerPackage: String get() = "com.google.android.apps.healthdata"

    private val client: HealthConnectClient by lazy { HealthConnectClient.getOrCreate(context) }

    suspend fun hasAllPermissions(): Boolean =
        runCatching { client.permissionController.getGrantedPermissions().containsAll(permissions) }
            .getOrDefault(false)

    /** The read permissions actually granted (empty on any failure). */
    suspend fun grantedPermissions(): Set<String> =
        runCatching { client.permissionController.getGrantedPermissions().intersect(permissions) }
            .getOrDefault(emptySet())

    /** When the most recent sleep session (last ~36h) ended — i.e. when the
     *  user woke up. Null when there's no data or no permission. */
    suspend fun lastSleepEnd(): Instant? = runCatching {
        val now = Instant.now()
        val window = TimeRangeFilter.between(now.minus(Duration.ofHours(36)), now)
        client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, window))
            .records.maxByOrNull { it.endTime }?.endTime
    }.getOrNull()

    /** Most recent body-composition readings (any source: smart scale, manual
     *  entry in the HC app). Looks back [days] days; null fields = no data. */
    data class BodyComp(val weightKg: Double? = null, val bodyFatPct: Double? = null)

    suspend fun readBodyComp(days: Long = 90): BodyComp {
        val now = Instant.now()
        val window = TimeRangeFilter.between(now.minus(Duration.ofDays(days)), now)
        val weight = runCatching {
            client.readRecords(ReadRecordsRequest(WeightRecord::class, window))
                .records.maxByOrNull { it.time }?.weight?.inKilograms
        }.getOrNull()
        val bodyFat = runCatching {
            client.readRecords(ReadRecordsRequest(BodyFatRecord::class, window))
                .records.maxByOrNull { it.time }?.percentage?.value
        }.getOrNull()
        return BodyComp(
            weightKg = weight?.takeIf { it in 30.0..250.0 },
            bodyFatPct = bodyFat?.takeIf { it in 3.0..60.0 },
        )
    }

    /**
     * Dated body-composition history for the last [days] days: one entry per
     * local date that has any reading (latest reading wins within a day).
     * Three windowed paged reads, NOT a per-day loop (365 days x 3 record
     * types would be ~1000 binder calls). Empty on missing permission/data.
     */
    suspend fun readBodyHistory(days: Long = 365): List<BodyDayReading> {
        val now = Instant.now()
        val window = TimeRangeFilter.between(now.minus(Duration.ofDays(days)), now)
        val weights = runCatching {
            readAllRecords(WeightRecord::class, window).map { it.time.toEpochMilli() to it.weight.inKilograms }
        }.getOrDefault(emptyList())
        val fats = runCatching {
            readAllRecords(BodyFatRecord::class, window).map { it.time.toEpochMilli() to it.percentage.value }
        }.getOrDefault(emptyList())
        val leans = runCatching {
            readAllRecords(LeanBodyMassRecord::class, window).map { it.time.toEpochMilli() to it.mass.inKilograms }
        }.getOrDefault(emptyList())
        return bodyDaysFromReadings(weights, fats, leans, ZoneId.systemDefault())
    }

    // Full paged read: readRecords caps a page at ~1000 records, and a year of
    // daily-scale data brushes against that.
    private suspend fun <T : Record> readAllRecords(
        cls: kotlin.reflect.KClass<T>,
        window: TimeRangeFilter,
    ): List<T> {
        val out = mutableListOf<T>()
        var token: String? = null
        do {
            val resp = client.readRecords(
                if (token == null) ReadRecordsRequest(cls, window)
                else ReadRecordsRequest(cls, window, pageToken = token),
            )
            out += resp.records
            token = resp.pageToken
        } while (token != null)
        return out
    }

    /**
     * Read the most recent ~36h of metrics and reduce to today's snapshot:
     * latest HRV rmssd & resting HR, last night's sleep duration, today's steps.
     */
    suspend fun readSnapshot(): HealthSnapshot {
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now()
        val startOfToday = today.atStartOfDay(zone).toInstant()
        val now = Instant.now()
        val window = TimeRangeFilter.between(now.minus(Duration.ofHours(36)), now)
        val todayWindow = TimeRangeFilter.between(startOfToday, now)

        // Last night's sleep session — used to scope the overnight HRV average.
        val sleepSession = runCatching {
            client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, window))
                .records.maxByOrNull { it.endTime }
        }.getOrNull()
        val sleep = sleepSession?.let { sessionToSleep(it) }

        // HRV: Zepp logs one RMSSD sample per minute across the night. Average the
        // samples within the sleep window (the standard overnight HRV figure)
        // instead of grabbing a single noisy reading.
        val hrv = runCatching {
            val recs = client.readRecords(ReadRecordsRequest(HeartRateVariabilityRmssdRecord::class, window)).records
            avgRmssdOverNight(recs, sleepSession?.startTime, sleepSession?.endTime)
        }.getOrNull()

        val rhr = runCatching {
            val recs = client.readRecords(ReadRecordsRequest(RestingHeartRateRecord::class, window)).records
            avgRestingHr(recs)
        }.getOrNull()

        val steps = runCatching {
            client.readRecords(ReadRecordsRequest(StepsRecord::class, todayWindow))
                .records.sumOf { it.count }.toInt()
        }.getOrNull()

        // VO2 max is updated occasionally (e.g. after a run) — look back further.
        val vo2 = runCatching {
            val wide = TimeRangeFilter.between(now.minus(Duration.ofDays(30)), now)
            client.readRecords(ReadRecordsRequest(Vo2MaxRecord::class, wide))
                .records.maxByOrNull { it.time }?.vo2MillilitersPerMinuteKilogram
        }.getOrNull()

        return HealthSnapshot(
            date = today.toString(),
            hrvRmssd = hrv,
            restingHr = rhr,
            sleepMinutes = sleep?.total,
            sleepDeepMin = sleep?.deep,
            sleepRemMin = sleep?.rem,
            steps = steps,
            vo2max = vo2,
        )
    }

    /**
     * Read the last [days] days as one snapshot per day, so the backend can
     * compute HRV baseline/deviation and sleep-debt trends rather than relying
     * on a single value.
     */
    suspend fun readWeek(days: Int = 7): List<HealthSnapshot> {
        val zone = ZoneId.systemDefault()
        val out = mutableListOf<HealthSnapshot>()
        for (offset in 0 until days) {
            val day = LocalDate.now().minusDays(offset.toLong())
            val start = day.atStartOfDay(zone).toInstant()
            val end = day.plusDays(1).atStartOfDay(zone).toInstant()
            val range = TimeRangeFilter.between(start, end)

            // Sleep that ENDED on this calendar day (i.e. the night before).
            val sleepSession = runCatching {
                client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, range))
                    .records.maxByOrNull { it.endTime }
            }.getOrNull()
            val sleep = sleepSession?.let { sessionToSleep(it) }

            // Average the night's per-minute RMSSD samples (see readSnapshot).
            val hrv = runCatching {
                val recs = client.readRecords(ReadRecordsRequest(HeartRateVariabilityRmssdRecord::class, range)).records
                avgRmssdOverNight(recs, sleepSession?.startTime, sleepSession?.endTime)
            }.getOrNull()
            val rhr = runCatching {
                val recs = client.readRecords(ReadRecordsRequest(RestingHeartRateRecord::class, range)).records
                avgRestingHr(recs)
            }.getOrNull()
            val steps = runCatching {
                client.readRecords(ReadRecordsRequest(StepsRecord::class, range))
                    .records.sumOf { it.count }.toInt()
            }.getOrNull()

            val vo2 = runCatching {
                client.readRecords(ReadRecordsRequest(Vo2MaxRecord::class, range))
                    .records.maxByOrNull { it.time }?.vo2MillilitersPerMinuteKilogram
            }.getOrNull()
            val snap = HealthSnapshot(
                date = day.toString(),
                hrvRmssd = hrv, restingHr = rhr,
                sleepMinutes = sleep?.total, sleepDeepMin = sleep?.deep, sleepRemMin = sleep?.rem,
                steps = steps, vo2max = vo2,
            )
            if (snap.hasAny) out.add(snap)
        }
        return out
    }

    /**
     * Read the last [days] days of exercise sessions (the fallback activity
     * source when intervals.icu isn't connected). Per session, avg HR and
     * total distance are aggregated over the session's time range. Empty on
     * missing permission or no data (same best-effort stance as readWeek).
     */
    suspend fun readExerciseSessions(days: Int = 30): List<HcExercise> {
        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        val window = TimeRangeFilter.between(now.minus(Duration.ofDays(days.toLong())), now)
        val sessions = mutableListOf<ExerciseSessionRecord>()
        var pageToken: String? = null
        do {
            val page = client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, window, pageToken = pageToken))
            sessions.addAll(page.records)
            pageToken = page.pageToken
        } while (pageToken != null)
        return sessions.mapNotNull { s ->
            val durationSec = Duration.between(s.startTime, s.endTime).seconds.toInt()
            if (durationSec < 60) return@mapNotNull null // discard sub-minute noise
            val range = TimeRangeFilter.between(s.startTime, s.endTime)
            val avgHr = runCatching {
                client.aggregate(AggregateRequest(setOf(HeartRateRecord.BPM_AVG), range))[HeartRateRecord.BPM_AVG]?.toInt()
            }.getOrNull()
            val distance = runCatching {
                client.aggregate(AggregateRequest(setOf(DistanceRecord.DISTANCE_TOTAL), range))[DistanceRecord.DISTANCE_TOTAL]?.inMeters
            }.getOrNull()
            HcExercise(
                uid = s.metadata.id,
                type = exerciseTypeName(s.exerciseType),
                date = s.startTime.atOffset(s.startZoneOffset ?: zone.rules.getOffset(s.startTime)).toLocalDate().toString(),
                endDate = s.endTime.atOffset(s.endZoneOffset ?: zone.rules.getOffset(s.endTime)).toLocalDate().toString(),
                timezoneName = s.startZoneOffset?.id ?: zone.id,
                timezoneProvenance = if (s.startZoneOffset != null) "recorded_offset" else "device_zone_fallback",
                origin = s.metadata.dataOrigin.packageName,
                startMs = s.startTime.toEpochMilli(),
                endMs = s.endTime.toEpochMilli(),
                durationSec = durationSec,
                distanceM = distance,
                avgHr = avgHr,
            )
        }
    }

    // Names are chosen to satisfy the app's type matching (adaptWeek's
    // typeMatches, daily-summary's sportOf). Unknown types map to "Other",
    // NOT "Workout": "workout" substring-matches planned strength and would
    // auto-complete gym sessions from any unclassified activity.
    private fun exerciseTypeName(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL,
        -> "Run"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "Walk"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING,
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY,
        -> "Ride"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL,
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER,
        -> "Swim"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING,
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING,
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS,
        -> "Weight training"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING,
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE,
        -> "Row"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "Hike"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "Elliptical"
        else -> "Other"
    }

    private data class Sleep(val total: Int, val deep: Int?, val rem: Int?)

    private fun sessionToSleep(s: SleepSessionRecord): Sleep {
        val total = Duration.between(s.startTime, s.endTime).toMinutes().toInt()
        fun stageMinutes(stage: Int): Int? {
            val mins = s.stages.filter { it.stage == stage }
                .sumOf { Duration.between(it.startTime, it.endTime).toMinutes() }
            return if (mins > 0) mins.toInt() else null
        }
        return Sleep(
            total = total,
            deep = stageMinutes(SleepSessionRecord.STAGE_TYPE_DEEP),
            rem = stageMinutes(SleepSessionRecord.STAGE_TYPE_REM),
        )
    }

    /**
     * Overnight HRV: the mean of the per-minute RMSSD samples taken during sleep.
     * Restricts to [sleepStart, sleepEnd] when available (so daytime/awake readings
     * don't skew it); otherwise averages everything passed in. Returns null if
     * there are no samples.
     */
    private fun avgRmssdOverNight(
        records: List<HeartRateVariabilityRmssdRecord>,
        sleepStart: Instant?,
        sleepEnd: Instant?,
    ): Double? {
        val night = if (sleepStart != null && sleepEnd != null) {
            records.filter { !it.time.isBefore(sleepStart) && !it.time.isAfter(sleepEnd) }
        } else {
            emptyList()
        }
        val pool = night.ifEmpty { records }
        val vals = pool.map { it.heartRateVariabilityMillis }
        if (vals.isEmpty()) return null
        // Round to 1 decimal — RMSSD is in ms; spurious precision helps no one.
        return Math.round(vals.average() * 10) / 10.0
    }

    /** Resting HR: mean of the resting-HR records in the window (one/day for most
     *  providers; averaging is a no-op then but smooths if several exist). */
    private fun avgRestingHr(records: List<RestingHeartRateRecord>): Int? {
        val vals = records.map { it.beatsPerMinute.toInt() }
        return if (vals.isEmpty()) null else Math.round(vals.average()).toInt()
    }
}

/** One local date's body readings (any subset may be present). */
data class BodyDayReading(
    val date: String,
    val weightKg: Double? = null,
    val bodyFatPct: Double? = null,
    val leanMassKg: Double? = null,
)

// Pure reducer so JVM tests cover it without a HealthConnectClient: raw
// (epochMs, value) readings → per-local-date latest, bounds-checked and
// rounded to 1 decimal, sorted by date.
internal fun bodyDaysFromReadings(
    weights: List<Pair<Long, Double>>,
    fats: List<Pair<Long, Double>>,
    leans: List<Pair<Long, Double>>,
    zone: ZoneId,
): List<BodyDayReading> {
    fun latestPerDay(readings: List<Pair<Long, Double>>, lo: Double, hi: Double): Map<String, Double> =
        readings
            .filter { (_, v) -> v in lo..hi }
            .groupBy { (ms, _) -> Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toString() }
            .mapValues { (_, day) -> day.maxBy { it.first }.second.let { Math.round(it * 10) / 10.0 } }

    val w = latestPerDay(weights, 30.0, 250.0)
    val f = latestPerDay(fats, 3.0, 60.0)
    val l = latestPerDay(leans, 20.0, 150.0)
    return (w.keys + f.keys + l.keys).sorted().map { d ->
        BodyDayReading(date = d, weightKg = w[d], bodyFatPct = f[d], leanMassKg = l[d])
    }
}
