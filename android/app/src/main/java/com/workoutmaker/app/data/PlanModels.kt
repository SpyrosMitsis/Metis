package com.workoutmaker.app.data

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.OffsetDateTime

// Kotlin mirror of /shared/types.ts. Keep field names in sync with the schema.
//
// Asking the engine for work: generate-workout / plan-week / schedule-template
// request and result shapes, plus the plan status they hang off.

// Billing state from user_profiles — plan columns are server-written only
// (verify-purchase / play-rtdn); use_hosted_ai is the user's own toggle.
data class PlanStatus(
    val plan: String = "free",
    val expiresAt: String? = null,
    val useHostedAi: Boolean = true,
) {
    // Mirrors isPro() in _shared/entitlement.ts: belt-and-braces expiry, because a
    // lost RTDN can leave plan='pro' on a subscription that already lapsed. No
    // expiry means no expiry. An unparseable date fails OPEN (still Pro) — this
    // only drives UI, and the server is the real gate for hosted AI.
    val isPro: Boolean get() {
        if (plan != "pro") return false
        val exp = expiresAt ?: return true
        return runCatching { OffsetDateTime.parse(exp).toInstant() }
            .map { it.isAfter(Instant.now()) }
            .getOrDefault(true)
    }
}

@Serializable
data class GenerateRequest(
    val session_slot: Int = 0,
    val objective: String? = null,
    val request_id: String = java.util.UUID.randomUUID().toString(),
    val date: String? = java.time.LocalDate.now().toString(),
    val type: String = "auto",
    // null → the server derives length from the profile preference/max and
    // treats it as flexible guidance instead of a fixed number.
    val duration: Int? = null,
    val push: Boolean = true,
    // "Adjust this workout": revise base_workout per a natural-language request.
    val adjustment: String? = null,
    val base_workout: Workout? = null,
    // Coarse location for weather-aware outdoor sessions.
    val lat: Double? = null,
    val lon: Double? = null,
    // Free-text athlete request for a specific date ("social 10k with friends").
    val request: String? = null,
    // Today's busy windows from the device calendar (opt-in; times only, no titles).
    val calendar_busy: List<BusyDay>? = null,
    // Lock the result so the weekly re-planner won't move/replace it.
    val lock: Boolean = false,
)

@Serializable
data class GenerateResult(
    val workout: Workout? = null,
    val workout_id: String? = null,
    val provider: String? = null,
    val estimated_cost_usd: Double = 0.0,
)

// weather-check response: a deterministic (no-LLM) verdict on whether today's
// planned outdoor run/ride is viable, computed server-side from live weather.
@Serializable
data class WeatherCheckResult(
    val should_prompt: Boolean = false,
    val tier: String? = null,
    val reason: String? = null,
    val sport: String? = null,
    val workout_id: String? = null,
    val workout_title: String? = null,
    val swap_type: String? = null,
    val suppressed_reason: String? = null,
)

@Serializable
data class PlanWeekRequest(
    val request_id: String = java.util.UUID.randomUUID().toString(),
    val today: String = java.time.LocalDate.now().toString(),
    val start_date: String? = java.time.LocalDate.now().toString(),
    val push: Boolean = true,
    // The week's busy windows from the device calendar (opt-in; times only, no
    // titles) so the planner puts hard/long sessions on the free days.
    val calendar_busy: List<BusyDay>? = null,
)

// One day's busy summary, derived on-device from the calendar. Only times and
// an all-day flag cross the wire, never event titles.
@Serializable
data class BusyDay(
    val date: String,
    val windows: List<String> = emptyList(), // "18:00-20:30"
    val all_day: Boolean = false,
)

@Serializable
data class WeekPlanRow(val start_date: String, val focus: String? = null, val rationale: String? = null)

@Serializable
data class PlanDaySummary(
    val date: String,
    val weekday: String = "",
    val type: String = "",
    val title: String = "",
    val tss: Int = 0,
)

@Serializable
data class PlanWeekResult(
    val start_date: String? = null,
    val end_date: String? = null,
    val week_focus: String? = null,
    val rationale: String? = null,
    val scheduled: Int = 0,
    val pushed: Int = 0,
    val days: List<PlanDaySummary> = emptyList(),
    val error: String? = null,
)

@Serializable
data class ScheduleRequest(
    val request_id: String = java.util.UUID.randomUUID().toString(),
    val template_id: String,
    val start_date: String? = null,
    val push: Boolean = true,
)

@Serializable
data class ScheduleResult(
    val scheduled: Int = 0,
    val pushed: Int = 0,
    val start_date: String? = null,
    val error: String? = null,
)
