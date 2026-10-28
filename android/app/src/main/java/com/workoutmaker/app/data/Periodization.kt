package com.workoutmaker.app.data

import kotlin.math.roundToInt
import java.time.LocalDate
import java.time.temporal.ChronoUnit

// Client-side mirror of the periodization rules in supabase/functions/plan-week
// (search "PERIODIZATION" there — that block is the source of truth). It builds
// these same numbers into the planning prompt but never returns or stores them,
// so there is no ladder for the app to read back; projecting it here is the only
// way to show the athlete their own week-by-week loads. Keep the constants in
// step with plan-week. Precedent for a deliberate mirror like this:
// _shared/progression.ts mirrors StrengthProgression.kt.
//
// KNOWN DIVERGENCE from plan-week, on purpose: plan-week ramps off *last week's
// actual* TSS, so after a deload the next block restarts from the deload level
// and every cycle peaks ~18% lower than the last. That is almost certainly not
// the intent (the animated PeriodizationGraph shows each block peaking higher,
// which is what periodization means). This projection resumes the ramp from the
// last build peak. If plan-week is fixed, this needs no change.
object Periodization {
    /** Starting a program should not require a second, technical date setting. */
    fun configure(profile: TrainingProfile, enabled: Boolean, today: LocalDate = LocalDate.now()): TrainingProfile =
        profile.copy(periodized = enabled, program_started_on = profile.program_started_on ?: today.toString().takeIf { enabled })

    /** Build weeks before a deload is due. */
    const val DELOAD_AFTER = 4

    /** "progress gently on last week" — the weekly build multiplier. */
    const val BUILD_RAMP = 1.08f

    /** "cut total volume ~40%" on a deload week. */
    const val DELOAD_CUT = 0.40f

    /** plan-week's fallback when the athlete has set no weekly target. */
    const val DEFAULT_WEEKLY_TSS = 350

    // Mirrors plan_checks.ts MIXED_TSS_PER_MIN: an 80/20 week priced with the
    // engine's own zone rates (0.8 x Z2 + 0.2 x Z3 = 0.88 TSS/min). The server
    // clamps the weekly target to minutes x this; the effort chips below offer
    // fractions of the same ceiling so a suggestion is always achievable.
    const val MIXED_TSS_PER_MIN = 0.88f

    /** The most weekly TSS the athlete's declared minutes can hold. Null = unset. */
    fun availabilityCeiling(weeklyMinutes: Int): Int? =
        if (weeklyMinutes <= 0) null else (weeklyMinutes * MIXED_TSS_PER_MIN).toInt()

    /** Effort levels as fractions of the athlete's own ceiling, rounded to 10. */
    enum class Effort(val label: String, val fraction: Float) {
        LIGHT("Light", 0.6f), MODERATE("Moderate", 0.8f), SOLID("Solid", 0.95f);

        fun targetFor(ceiling: Int): Int = ((ceiling * fraction) / 10f).toInt() * 10
    }

    // Mirror of prompt.ts trainingPhase: the bands the SERVER plans with, so
    // the phase the athlete sees is the phase the AI was told.
    data class Phase(val name: String, val weeksToGoal: Int?) {
        /** 0..1 position along Base→Build→Peak→Taper for the visual strip. */
        val progress: Float
            get() {
                val w = weeksToGoal ?: return 0f
                return (1f - w.coerceIn(0, 20) / 20f)
            }
    }

    fun phaseFor(goalDate: LocalDate?, weekStart: LocalDate): Phase {
        if (goalDate == null || goalDate.isBefore(weekStart)) return Phase("Maintenance", null)
        val weeks = (ChronoUnit.DAYS.between(weekStart, goalDate) / 7.0)
            .let { Math.round(it).toInt() }
        val name = when {
            weeks <= 2 -> "Taper"
            weeks <= 6 -> "Peak"
            weeks <= 14 -> "Build"
            else -> "Base"
        }
        return Phase(name, weeks)
    }

    data class Week(val number: Int, val tss: Int, val deload: Boolean)

    /**
     * The next [weeks] weeks of training load starting from [baseTss], the
     * athlete's current typical week.
     *
     * A plan, not a prediction: the ramp assumes each week is actually hit, and
     * plan-week re-reads real completed load every week, so reality will drift.
     */
    fun projectedWeeks(baseTss: Int, weeks: Int = 8): List<Week> {
        val base = baseTss.coerceAtLeast(1)
        // The load at the top of the current build block. Carried across the
        // deload so the next block resumes from it rather than from the dip.
        var peak = base.toFloat()
        var built = 0
        return (1..weeks).map { n ->
            if (built >= DELOAD_AFTER) {
                built = 0
                Week(n, (peak * (1f - DELOAD_CUT)).roundToInt(), deload = true)
            } else {
                built++
                peak *= BUILD_RAMP
                Week(n, peak.roundToInt(), deload = false)
            }
        }
    }
}
