package com.workoutmaker.app.data

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt

// ===========================================================================
// The endurance target: how far, and how fast.
//
// Onboarding used to ask this as a chip row ("5K / 10K / Half Marathon / …"),
// which could say WHICH classic distance but never "17 km" and never a pace.
// The picker that replaced it is a line with the classics standing on it as
// posts and a flag you drag, so every value in between is reachable and the
// pace comes with it.
//
// Everything here is pure: the same numbers drive the control, the goal phrase
// that reaches the LLM, and the tests. No Compose, no Android.
// ===========================================================================

/** One classic distance standing on the picker's line. */
data class DistancePost(val label: String, val km: Double, val name: String)

/** How a sport's target effort is entered and read back. */
enum class PaceMode { PER_KM, SPEED, PER_100M }

/**
 * Pace is stored as seconds per kilometre for ALL THREE sports, and only the
 * display differs. One stored unit means the estimate maths (`km × sec`) is the
 * same everywhere, and a triathlete's three targets are directly comparable.
 */
data class PaceSpec(
    val mode: PaceMode,
    val refSecPerKm: Int,
    val minSecPerKm: Int,
    val maxSecPerKm: Int,
    val caption: String,
)

object EnduranceGoals {

    val posts: Map<String, List<DistancePost>> = mapOf(
        "run" to listOf(
            DistancePost("5K", 5.0, "5K"),
            DistancePost("10K", 10.0, "10K"),
            DistancePost("Half", 21.1, "Half marathon"),
            DistancePost("Full", 42.2, "Marathon"),
            DistancePost("50K", 50.0, "Ultra, 50K"),
        ),
        "ride" to listOf(
            DistancePost("20", 20.0, "Short ride"),
            DistancePost("40", 40.0, "Club distance"),
            DistancePost("80", 80.0, "Half century"),
            DistancePost("120", 120.0, "Gran fondo"),
            DistancePost("160", 160.0, "Century"),
        ),
        "swim" to listOf(
            DistancePost("750m", 0.75, "Sprint tri"),
            DistancePost("1.5K", 1.5, "Olympic tri"),
            DistancePost("1.9K", 1.9, "70.3"),
            DistancePost("3.8K", 3.8, "Ironman"),
            DistancePost("5K", 5.0, "Open water 5K"),
        ),
    )

    // Ride's range is expressed backwards on purpose: 15 km/h is 240 s/km (the
    // SLOW end) and 45 km/h is 80 s/km. min/max are in stored units, always.
    val pace: Map<String, PaceSpec> = mapOf(
        "run" to PaceSpec(PaceMode.PER_KM, refSecPerKm = 322, minSecPerKm = 180, maxSecPerKm = 600, caption = "Target pace"),
        "ride" to PaceSpec(PaceMode.SPEED, refSecPerKm = 133, minSecPerKm = 80, maxSecPerKm = 240, caption = "Target speed"),
        "swim" to PaceSpec(PaceMode.PER_100M, refSecPerKm = 1090, minSecPerKm = 800, maxSecPerKm = 1800, caption = "Target pace"),
    )

    /** Steps for the minus/plus buttons, in the unit the athlete sees. */
    private const val RUN_STEP_SEC = 5
    private const val SWIM_STEP_SEC_PER_KM = 50 // 5 s per 100 m
    private const val RIDE_STEP_KMH = 0.5

    /** The picker only exists for sports that cover ground. The gym has no line. */
    fun isEndurance(sport: String): Boolean = posts.containsKey(sport)

    private fun postsOf(sport: String) = posts[sport] ?: posts.getValue("run")
    private fun specOf(sport: String) = pace[sport] ?: pace.getValue("run")

    /** Where a sport's target starts before the athlete touches anything. */
    fun defaultFraction(): Float = 0.25f
    fun defaultPaceSec(sport: String): Int = specOf(sport).refSecPerKm

    // --- Distance ----------------------------------------------------------
    //
    // The fraction is INDEX space, not distance space: the posts sit at equal
    // screen intervals even though 5K→10K and 42.2→50 are very different gaps.
    // Dragging therefore feels linear against the labels you can see, which is
    // the only frame of reference on the line.

    fun kmForFraction(sport: String, fraction: Float): Double {
        val list = postsOf(sport)
        val n = list.size - 1
        val idx = (fraction.coerceIn(0f, 1f) * n).toDouble()
        val lo = floor(idx).toInt().coerceIn(0, n - 1)
        val t = idx - lo
        return list[lo].km + t * (list[lo + 1].km - list[lo].km)
    }

    /** Inverse of [kmForFraction], so a stored goal reopens under the flag. */
    fun fractionForKm(sport: String, km: Double): Float {
        val list = postsOf(sport)
        val n = list.size - 1
        if (km <= list.first().km) return 0f
        if (km >= list.last().km) return 1f
        for (i in 0 until n) {
            val lo = list[i].km
            val hi = list[i + 1].km
            if (km in lo..hi) {
                val t = if (hi > lo) (km - lo) / (hi - lo) else 0.0
                return ((i + t) / n).toFloat()
            }
        }
        return 0f
    }

    /** On release, a flag left near a post drops onto it. Classics beat 41.8 km. */
    fun snapFraction(sport: String, fraction: Float): Float {
        val n = postsOf(sport).size - 1
        val idx = fraction.coerceIn(0f, 1f) * n
        val near = idx.roundToInt()
        return if (abs(idx - near) < 0.28f) near.toFloat() / n else fraction.coerceIn(0f, 1f)
    }

    /** The post the flag is standing ON (tighter than the snap radius), if any. */
    fun postAt(sport: String, fraction: Float): DistancePost? {
        val list = postsOf(sport)
        val n = list.size - 1
        val idx = fraction.coerceIn(0f, 1f) * n
        val near = idx.roundToInt()
        return if (abs(idx - near) < 0.035f) list[near] else null
    }

    /** "750 m" under 2 km (rounded to 25 m), otherwise km. Value only. */
    fun formatKmValue(km: Double): String = when {
        km < 2.0 -> ((km * 1000 / 25).roundToInt() * 25).toString()
        km < 100.0 -> "%.1f".format(km)
        else -> km.roundToInt().toString()
    }

    fun kmUnit(km: Double): String = if (km < 2.0) "m" else "km"

    fun formatKm(km: Double): String = "${formatKmValue(km)} ${kmUnit(km)}"

    // --- Pace --------------------------------------------------------------

    fun formatPace(sport: String, secPerKm: Int): String = when (specOf(sport).mode) {
        PaceMode.SPEED -> "%.1f km/h".format(3600.0 / secPerKm)
        PaceMode.PER_100M -> "${mmss(secPerKm / 10.0)} /100 m"
        PaceMode.PER_KM -> "${mmss(secPerKm.toDouble())} /km"
    }

    /** The number alone, for the big readout that puts its unit beside it. */
    fun paceValue(sport: String, secPerKm: Int): String = when (specOf(sport).mode) {
        PaceMode.SPEED -> "%.1f".format(3600.0 / secPerKm)
        PaceMode.PER_100M -> mmss(secPerKm / 10.0)
        PaceMode.PER_KM -> mmss(secPerKm.toDouble())
    }

    fun paceUnit(sport: String): String = when (specOf(sport).mode) {
        PaceMode.SPEED -> "km/h"
        PaceMode.PER_100M -> "/100 m"
        PaceMode.PER_KM -> "/km"
    }

    fun paceCaption(sport: String): String = specOf(sport).caption

    /**
     * Slider position, 0..1. Deliberately inverted against the stored value so
     * RIGHT IS ALWAYS FASTER, whether the displayed unit counts up (km/h) or
     * down (min/km). The slider ends are labeled by effort.
     */
    fun paceFraction(sport: String, secPerKm: Int): Float {
        val s = specOf(sport)
        val span = (s.maxSecPerKm - s.minSecPerKm).toFloat()
        if (span <= 0f) return 0f
        return ((s.maxSecPerKm - secPerKm) / span).coerceIn(0f, 1f)
    }

    fun secForPaceFraction(sport: String, fraction: Float): Int {
        val s = specOf(sport)
        val raw = s.maxSecPerKm - fraction.coerceIn(0f, 1f) * (s.maxSecPerKm - s.minSecPerKm)
        return clampPace(sport, raw.roundToInt())
    }

    /** One step faster or slower, in whatever unit this sport is shown in. */
    fun stepPace(sport: String, secPerKm: Int, faster: Boolean): Int {
        val s = specOf(sport)
        return when (s.mode) {
            PaceMode.SPEED -> {
                val kmh = 3600.0 / secPerKm + if (faster) RIDE_STEP_KMH else -RIDE_STEP_KMH
                if (kmh <= 0) secPerKm else clampPace(sport, (3600.0 / kmh).roundToInt())
            }
            PaceMode.PER_100M -> clampPace(sport, secPerKm + if (faster) -SWIM_STEP_SEC_PER_KM else SWIM_STEP_SEC_PER_KM)
            PaceMode.PER_KM -> clampPace(sport, secPerKm + if (faster) -RUN_STEP_SEC else RUN_STEP_SEC)
        }
    }

    /** Minus/plus change the displayed number, including time-based paces. */
    fun stepPaceValue(sport: String, secPerKm: Int, increase: Boolean): Int =
        stepPace(sport, secPerKm, faster = if (specOf(sport).mode == PaceMode.SPEED) increase else !increase)

    fun clampPace(sport: String, secPerKm: Int): Int {
        val s = specOf(sport)
        return secPerKm.coerceIn(s.minSecPerKm, s.maxSecPerKm)
    }

    fun paceEndLabels(sport: String): Pair<String, String> =
        if (specOf(sport).mode == PaceMode.SPEED) "Steady" to "Flat out" else "Easier" to "Faster"

    /**
     * How fast the figure moves, relative to its reference pace. Capped at both
     * ends: an uncapped rate makes the runner either freeze or vibrate.
     */
    fun animationRate(sport: String, secPerKm: Int): Float =
        (secPerKm.toFloat() / specOf(sport).refSecPerKm).coerceIn(0.42f, 1.9f)

    // --- What it all adds up to --------------------------------------------

    fun estimateMinutes(km: Double, secPerKm: Int): Int = (km * secPerKm / 60.0).roundToInt()

    fun formatDuration(minutes: Int): String =
        if (minutes >= 60) "${minutes / 60}h %02dm".format(minutes % 60) else "$minutes min"

    /**
     * The catalog goal this distance stands for, so the parts of the app that
     * key on named goals (the goal-race step, the Settings chips, the legacy
     * `goal` string) keep working unchanged.
     *
     * Only run has distance names in its catalog. Ride and swim used to be
     * force-mapped here to "Go longer" / "Swim further", which silently answered
     * a question the athlete was never asked: a cyclist chasing FTP, or riding
     * for general fitness, was recorded as wanting to go longer. Those two are
     * ordinary choices now, see [distanceOwnedGoals].
     */
    fun catalogGoal(sport: String, km: Double): String? = when (sport) {
        "run" -> when (postsOf("run").minByOrNull { abs(it.km - km) }?.label) {
            "5K" -> "5K"
            "10K" -> "10K"
            "Half" -> "Half Marathon"
            else -> "Marathon"
        }
        else -> null
    }

    /**
     * Catalog goals the distance picker OWNS, so a screen showing goal chips can
     * leave them out: picking 21.1 km on the line IS picking "Half Marathon",
     * and a chip that contradicts the flag is a chip that will contradict it.
     */
    fun distanceOwnedGoals(sport: String): Set<String> =
        if (sport == "run") setOf("5K", "10K", "Half Marathon", "Marathon") else emptySet()

    /**
     * What a sport is pre-set to want when the athlete has not said. Ride and
     * swim open on the goal a distance target most often means, so the step
     * still leaves a real answer behind for someone who just taps through.
     */
    fun defaultIntentGoal(sport: String): String? = when (sport) {
        "ride" -> "Go longer"
        "swim" -> "Swim further"
        else -> null
    }

    /**
     * Fold a new distance target into a sport's goal list. The old distance name
     * is replaced (you cannot be training for both a 10K and a marathon) and
     * everything else the athlete picked is left exactly where it was, which is
     * the whole point: dragging the flag must not quietly unpick "Racing".
     */
    fun withDistanceGoal(existing: List<String>, sport: String, km: Double): List<String> {
        val owned = distanceOwnedGoals(sport)
        val kept = existing.filterNot { it in owned }
        val goals = (listOfNotNull(catalogGoal(sport, km)) + kept).distinct()
        return goals.ifEmpty { listOfNotNull(defaultIntentGoal(sport)) }
    }

    /**
     * The line the LLM actually reads, e.g. "Run 21.1 km at 5:22 /km". Precise
     * where the catalog name is vague, which is the entire point of the picker:
     * "Marathon" and "42.2 km in 3:30" are not the same instruction.
     */
    fun goalPhrase(sport: String, km: Double, secPerKm: Int?): String {
        val verb = when (sport) {
            "run" -> "Run"
            "ride" -> "Ride"
            "swim" -> "Swim"
            else -> "Cover"
        }
        val base = "$verb ${formatKm(km)}"
        return if (secPerKm == null) base else "$base at ${formatPace(sport, secPerKm)}"
    }

    private fun mmss(seconds: Double): String {
        val total = seconds.roundToInt()
        return "%d:%02d".format(total / 60, total % 60)
    }
}
