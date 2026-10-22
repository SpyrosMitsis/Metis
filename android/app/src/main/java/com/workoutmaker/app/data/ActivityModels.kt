package com.workoutmaker.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Kotlin mirror of /shared/types.ts. Keep field names in sync with the schema.
//
// What actually happened: a completed activity and its computed metrics, plus
// the post-session analysis (streams, splits, targets) for run/ride and gym.

@Serializable
data class ManualActivityInsert(
    val intervals_id: String,
    val type: String,
    val date: String,
    val duration_seconds: Int? = null,
    val distance_m: Double? = null,
    val tss: Double? = null,
)

// A Health Connect exercise session pushed as a fallback activity when
// intervals.icu isn't connected (intervals_id = "hc:<record uid>").
@Serializable
data class HcActivityInsert(
    val intervals_id: String,
    val source: String = "health_connect",
    val source_id: String? = null,
    val started_at: String? = null,
    val ended_at: String? = null,
    val start_local_date: String? = null,
    val end_local_date: String? = null,
    val timezone_name: String? = null,
    val timezone_provenance: String = "unavailable",
    val data_json: JsonObject? = null,
    val type: String,
    val date: String,
    val duration_seconds: Int? = null,
    val distance_m: Double? = null,
    val avg_hr: Int? = null,
    val tss: Double? = null,
)

// A past activity pulled from Intervals.icu (or logged manually) into
// completed_activities. data_json holds the full Intervals object for the
// detail view (avg/max HR & power, elevation, calories, pace, name…).
@Serializable
data class CompletedActivity(
    val id: String,
    val intervals_id: String,
    val type: String? = null,
    val date: String? = null,
    val duration_seconds: Int? = null,
    val distance_m: Double? = null,
    val avg_hr: Int? = null,
    val tss: Double? = null,
    val ctl: Double? = null,
    val atl: Double? = null,
    val data_json: JsonObject? = null,
    val planned_workout_id: String? = null,
    val link_source: String? = null,
    val session_state: String = "unknown",
    val content_revision: Long = 1,
    val session_group_id: String? = null,
    val started_at: String? = null,
    val ended_at: String? = null,
    val timezone_provenance: String = "unavailable",
    val measurement_provenance: JsonObject? = null,
) {
    val isManual: Boolean get() = intervals_id.startsWith("manual:")
    val distanceKm: Double? get() = distance_m?.let { it / 1000.0 }
    val durationMin: Int? get() = duration_seconds?.let { it / 60 }

    /** A human label: the Intervals activity name if present, else the type. */
    val displayName: String
        get() = str("name")?.takeIf { it.isNotBlank() } ?: (type ?: "Activity")

    /** Average pace in sec/km, when this looks like a run/walk with distance. */
    val paceSecPerKm: Int?
        get() {
            val d = distance_m ?: return null
            val s = duration_seconds ?: return null
            if (d < 100) return null
            return (s / (d / 1000.0)).toInt()
        }

    // Swims are paced per 100 m everywhere (summary tiles, charts, splits).
    val isSwim: Boolean get() = (type ?: "").contains("swim", ignoreCase = true)

    /** Average swim pace in sec/100m. */
    val paceSecPer100m: Int?
        get() {
            val d = distance_m ?: return null
            val s = duration_seconds ?: return null
            if (d < 100) return null
            return (s / (d / 100.0)).toInt()
        }

    // --- typed pulls out of the raw Intervals object ---
    fun str(key: String): String? =
        (data_json?.get(key) as? JsonPrimitive)?.contentOrNull
    fun num(key: String): Double? =
        (data_json?.get(key) as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()

    fun numArray(key: String): List<Double>? {
        val arr = data_json?.get(key) as? JsonArray ?: return null
        return arr.map { (it as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull() ?: 0.0 }
    }

    val avgPower: Int? get() = num("icu_average_watts")?.toInt() ?: num("average_watts")?.toInt()
    val maxHr: Int? get() = num("max_heartrate")?.toInt()
    val elevationGain: Int? get() = num("total_elevation_gain")?.toInt() ?: num("icu_elevation_gain")?.toInt()
    val calories: Int? get() = num("calories")?.toInt()
    val avgCadence: Int? get() = num("average_cadence")?.toInt()
    val maxCadence: Int? get() = num("max_cadence")?.toInt()

    // Elapsed (clock) time including pauses — only interesting when it meaningfully
    // exceeds moving time.
    val elapsedSeconds: Int? get() = num("elapsed_time")?.toInt()
    // Max pace from peak speed (m/s → sec/km); ignores GPS spikes under ~0.5 m/s.
    val maxPaceSecPerKm: Int? get() = num("max_speed")?.let { if (it > 0.5) (1000.0 / it).toInt() else null }
    // Max swim pace (m/s → sec/100m); a lower floor since swim speeds are lower.
    val maxPaceSecPer100m: Int? get() = num("max_speed")?.let { if (it > 0.25) (100.0 / it).toInt() else null }
    // Normalized/weighted power for runs/rides with a power source.
    val normalizedPower: Int? get() = num("icu_weighted_avg_watts")?.toInt()
    // Aerobic decoupling (Pa:HR / Pw:HR drift), as a percentage.
    val decouplingPct: Double? get() = num("icu_decoupling")
    // Average ambient temperature (°C), when the device recorded it.
    val avgTempC: Int? get() = num("average_temp")?.toInt()
    // Seconds spent in each HR zone (Z1..Zn), when HR zones are configured.
    val hrZoneTimes: List<Int>? get() =
        numArray("icu_hr_zone_times")?.map { it.toInt() }?.takeIf { secs -> secs.sum() > 0 }
}

private val JsonPrimitive.contentOrNull: String?
    get() = if (this is JsonNull) null else content

// Result of an adaptive re-plan: how the plan was reconciled with reality.
data class AdaptResult(
    val reconciled: Int = 0,   // planned sessions auto-completed from actuals
    val missed: Int = 0,       // past planned sessions with no matching activity
    val replanned: Boolean = false,
    val message: String = "",
    val error: String? = null,
)

// --- Post-workout execution analysis (analyze-activity) ---------------------
@Serializable
data class AnalysisComponent(val name: String, val score: Int = 0, val detail: String = "")

@Serializable
data class AnalysisSeries(
    val t: List<Double> = emptyList(),
    val pace: List<Double?> = emptyList(),  // sec/km, null while stopped
    val hr: List<Double?> = emptyList(),
    val cadence: List<Double?> = emptyList(),  // spm/rpm, null when not recorded
    val power: List<Double?> = emptyList(),    // watts, null when not recorded
)

@Serializable
data class AnalysisTarget(
    val pace_lo: Double? = null,
    val pace_hi: Double? = null,
    val hr_lo: Int? = null,
    val hr_hi: Int? = null,
    val zones: String = "",
)

@Serializable
data class AnalysisSplit(val km: Double, val sec: Int = 0, val avg_hr: Int? = null, val in_band: Boolean? = null)

@Serializable
data class ActivityAnalysis(
    val ok: Boolean = false,
    val score: Int? = null,
    val label: String? = null,
    val components: List<AnalysisComponent> = emptyList(),
    val feedback: String? = null,
    val feedback_provider: String? = null,
    val series: AnalysisSeries? = null,
    val target: AnalysisTarget? = null,
    val splits: List<AnalysisSplit> = emptyList(),
    val planned_title: String? = null,
    // "/km" (default) or "/100m" for swims; old cached analyses lack it.
    val pace_unit: String? = null,
    // Metres per split (1000, or 100 for swims).
    val split_m: Int? = null,
    val streams_error: String? = null,
    val error: String? = null,
) {
    val isPer100m: Boolean get() = pace_unit == "/100m"
}

// --- Strength session analysis (analyze-strength) ---------------------------
@Serializable
data class StrengthAnalysisExercise(
    val name: String,
    val actual_sets: Int = 0,
    val top_weight_kg: Double? = null,
    val volume_kg: Double? = null,
    val planned: String? = null,
)

@Serializable
data class StrengthAnalysisWatch(
    val duration_min: Int? = null,
    val avg_hr: Int? = null,
    val tss: Double? = null,
)

@Serializable
data class StrengthAnalysis(
    val ok: Boolean = false,
    val score: Int? = null,
    val label: String? = null,
    val components: List<AnalysisComponent> = emptyList(),
    val feedback: String? = null,
    val feedback_provider: String? = null,
    val exercises: List<StrengthAnalysisExercise> = emptyList(),
    val total_volume_kg: Double? = null,
    val total_sets: Int? = null,
    val watch: StrengthAnalysisWatch? = null,
    // HR trace from the paired watch recording, when available (for the chart).
    val series: AnalysisSeries? = null,
    val planned_title: String? = null,
    val error: String? = null,
)
