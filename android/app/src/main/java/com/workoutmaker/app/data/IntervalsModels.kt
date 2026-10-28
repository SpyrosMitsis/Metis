package com.workoutmaker.app.data

import kotlinx.serialization.Serializable

// Kotlin mirror of /shared/types.ts. Keep field names in sync with the schema.
//
// Intervals.icu mirror: fitness (CTL/ATL/TSB), zones and synced activities.

// --- Intervals.icu fitness dashboard ----------------------------------------
@Serializable
data class FitnessPoint(val date: String, val ctl: Double = 0.0, val atl: Double = 0.0, val tsb: Double = 0.0)

@Serializable
data class HrZone(val name: String, val min: Int = 0, val max: Int = 0)

@Serializable
data class FitnessSummary(val ctl: Double = 0.0, val atl: Double = 0.0, val tsb: Double = 0.0, val ramp: Double = 0.0)

@Serializable
data class IntervalsActivity(
    val date: String,
    val name: String = "",
    val type: String = "",
    val distance_km: Double? = null,
    val duration_min: Int? = null,
    val tss: Double? = null,
    val avg_hr: Int? = null,
    val intervals_id: String? = null,
)

@Serializable
data class IntervalsStats(
    val connected: Boolean = false,
    val athlete_name: String? = null,
    val summary: FitnessSummary? = null,
    val fitness: List<FitnessPoint> = emptyList(),
    val hr_zones: List<HrZone> = emptyList(),
    val activities: List<IntervalsActivity> = emptyList(),
    val error: String? = null,
)

@Serializable
data class ConnectIntervalsResult(
    val ok: Boolean = false,
    val athlete_name: String? = null,
    val error: String? = null,
)

@Serializable
data class WorkoutTemplate(
    val id: String,
    val name: String,
    val description: String? = null,
    val kind: String = "workout",
)
