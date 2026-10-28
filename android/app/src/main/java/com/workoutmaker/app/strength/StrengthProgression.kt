package com.workoutmaker.app.strength

import kotlin.math.abs
import kotlin.math.roundToInt

// ============================================================================
// Pure strength "intelligence": 1RM tables, PR detection, auto-progression,
// deload detection, and weekly volume / balance. All functions are side-effect
// free and operate on the decoupled [LogSet] type so they're unit-testable
// without Room. Callers map their SetEntity / FinishedSet / DatedSet into this.
// ============================================================================

/** A single logged set, decoupled from persistence for testable logic. */
data class LogSet(
    val weightKg: Double,
    val reps: Int,
    val rpe: Int? = null,
    val isWarmup: Boolean = false,
    val muscle: String = "",
    val dateMillis: Long = 0L,
    val quantityUnit: String = "reps",
)

private const val WEEK_MS = 7L * 24 * 60 * 60 * 1000

private fun fmt(v: Double): String =
    if (abs(v - v.roundToInt()) < 0.05) v.roundToInt().toString() else ((v * 10).roundToInt() / 10.0).toString()

// --- C6: estimated 1RM & %-of-1RM table -------------------------------------
data class OneRmRow(val pct: Int, val reps: Int, val weightKg: Double)

object OneRepMax {
    // Standard %1RM → reps reference (Epley-aligned, common lifting chart).
    private val pctReps = listOf(100 to 1, 95 to 2, 90 to 4, 85 to 6, 80 to 8, 75 to 10, 70 to 12, 65 to 15, 60 to 20)

    fun weightForPct(e1rm: Double, pct: Int, step: Double = 2.5): Double = roundToStep(e1rm * pct / 100.0, step)

    fun table(e1rm: Double, step: Double = 2.5): List<OneRmRow> =
        pctReps.map { (pct, reps) -> OneRmRow(pct, reps, weightForPct(e1rm, pct, step)) }
}

/** Round to the nearest loadable increment (default 2.5kg → 1.25/side). */
fun roundToStep(kg: Double, step: Double = 2.5): Double =
    if (step <= 0) kg else (kg / step).roundToInt() * step

// --- C2: personal records ---------------------------------------------------
data class PrRecord(
    val bestWeight: Double = 0.0,
    val bestE1rm: Double = 0.0,
    val bestVolume: Double = 0.0,      // best single-set weight*reps
    val repPRs: Map<Int, Double> = emptyMap(), // heaviest weight ever done for each rep count
)

data class PrHit(val type: String, val detail: String) // type: weight | e1rm | rep | volume | session_volume

object Prs {
    fun record(history: List<LogSet>): PrRecord {
        val w = history.filter { !it.isWarmup && it.reps > 0 && it.quantityUnit == "reps" }
        if (w.isEmpty()) return PrRecord()
        val repPRs = HashMap<Int, Double>()
        for (s in w) {
            val cur = repPRs[s.reps]
            if (cur == null || s.weightKg > cur) repPRs[s.reps] = s.weightKg
        }
        return PrRecord(
            bestWeight = w.maxOf { it.weightKg },
            bestE1rm = w.maxOf { epley1rm(it.weightKg, it.reps) },
            bestVolume = w.maxOf { it.weightKg * it.reps },
            repPRs = repPRs,
        )
    }

    /** New PRs in [session] vs the [prior] record (call BEFORE folding the session in). */
    fun detect(prior: PrRecord, session: List<LogSet>): List<PrHit> {
        val w = session.filter { !it.isWarmup && it.reps > 0 && it.quantityUnit == "reps" }
        if (w.isEmpty()) return emptyList()
        val hits = mutableListOf<PrHit>()
        val newBestWeight = w.maxOf { it.weightKg }
        if (newBestWeight > prior.bestWeight + 1e-6) hits.add(PrHit("weight", "Heaviest set ${fmt(newBestWeight)}kg"))
        val newBestE1rm = w.maxOf { epley1rm(it.weightKg, it.reps) }
        if (newBestE1rm > prior.bestE1rm + 0.05) hits.add(PrHit("e1rm", "Est. 1RM ${fmt(newBestE1rm)}kg"))
        // Rep PRs: heaviest weight for a given rep count.
        val bestByRep = HashMap<Int, Double>()
        for (s in w) {
            val prev = prior.repPRs[s.reps]
            if ((prev == null || s.weightKg > prev + 1e-6) && s.weightKg > (bestByRep[s.reps] ?: 0.0)) {
                bestByRep[s.reps] = s.weightKg
            }
        }
        bestByRep.toSortedMap().forEach { (reps, wt) -> hits.add(PrHit("rep", "${reps}-rep ${fmt(wt)}kg")) }
        return hits
    }
}

// --- B1: auto progression ---------------------------------------------------
enum class ProgressionRule { DOUBLE, LINEAR, NONE }

data class ProgressionSuggestion(val weightKg: Double, val reps: Int, val note: String)

object Progression {
    /**
     * Suggest the next session's top-set target from the last session's working
     * sets. [compound] picks the load increment (2.5 vs 1.25 kg).
     */
    fun suggest(
        lastWorking: List<LogSet>,
        rule: ProgressionRule,
        repLow: Int,
        repHigh: Int,
        compound: Boolean,
    ): ProgressionSuggestion? {
        val work = lastWorking.filter { !it.isWarmup && it.reps > 0 && it.quantityUnit == "reps" }
        if (work.isEmpty()) return null
        val topWeight = work.maxOf { it.weightKg }
        val topSets = work.filter { it.weightKg >= topWeight - 1e-6 }
        val inc = if (compound) 2.5 else 1.25
        return when (rule) {
            ProgressionRule.LINEAR ->
                ProgressionSuggestion(topWeight + inc, repLow, "Linear +${fmt(inc)}kg")
            ProgressionRule.DOUBLE -> {
                val hitTop = topSets.all { it.reps >= repHigh }
                if (hitTop) {
                    ProgressionSuggestion(topWeight + inc, repLow, "Hit ${repHigh} reps everywhere → +${fmt(inc)}kg, reset to $repLow")
                } else {
                    val target = (topSets.maxOf { it.reps } + 1).coerceIn(repLow, repHigh)
                    ProgressionSuggestion(topWeight, target, "Add a rep toward $repHigh")
                }
            }
            ProgressionRule.NONE ->
                ProgressionSuggestion(topWeight, topSets.maxOf { it.reps }, "Repeat last")
        }
    }
}

// --- B5: weekly volume by muscle + balance ----------------------------------
data class MuscleVolume(val muscle: String, val sets: Int, val status: String) // under | in_range | over
data class BalanceWarning(val text: String)

object VolumeBalance {
    const val LOW = 10
    const val HIGH = 20

    /** Hard (working) set counts per muscle over the supplied window. */
    fun byMuscle(sets: List<LogSet>): List<MuscleVolume> =
        sets.filter { !it.isWarmup && it.reps > 0 && it.quantityUnit == "reps" }
            .groupBy { it.muscle.ifBlank { "Other" } }
            .map { (m, s) ->
                val n = s.size
                MuscleVolume(m, n, if (n < LOW) "under" else if (n > HIGH) "over" else "in_range")
            }
            .sortedByDescending { it.sets }

    fun balance(byMuscle: List<MuscleVolume>): List<BalanceWarning> {
        val map = byMuscle.associate { it.muscle to it.sets }
        val warns = mutableListOf<BalanceWarning>()
        val push = (map["Chest"] ?: 0) + (map["Shoulders"] ?: 0) + (map["Triceps"] ?: 0)
        val pull = (map["Back"] ?: 0) + (map["Biceps"] ?: 0)
        if (push >= 4 && pull >= 4) {
            val r = push.toDouble() / pull
            if (r > 1.5) warns.add(BalanceWarning("Push:pull ${fmt(r)}:1, add pulling volume to balance the shoulders."))
            if (r < 0.66) warns.add(BalanceWarning("Pull-dominant (${fmt(1 / r)}:1), add pressing volume."))
        }
        val quad = map["Quads"] ?: 0
        val post = (map["Hamstrings"] ?: 0) + (map["Glutes"] ?: 0)
        if (quad >= 4 && post >= 4 && quad.toDouble() / post > 1.6) {
            warns.add(BalanceWarning("Quad-dominant, add hamstring/glute work to protect the knees."))
        }
        return warns
    }
}

// --- B2: deload detection ---------------------------------------------------
data class WeeklyVolume(val weekIndex: Long, val volume: Double, val avgRpe: Double?, val hardSets: Int)
data class DeloadAdvice(val recommended: Boolean, val reason: String, val suggestedVolumePct: Int = 60)

object Deload {
    /** Bucket sets into ISO-ish epoch weeks (ascending). */
    fun weekly(sets: List<LogSet>): List<WeeklyVolume> {
        val work = sets.filter { !it.isWarmup && it.reps > 0 && it.quantityUnit == "reps" && it.dateMillis > 0 }
        return work.groupBy { it.dateMillis / WEEK_MS }
            .toSortedMap()
            .map { (wk, s) ->
                val rpes = s.mapNotNull { it.rpe }
                WeeklyVolume(
                    weekIndex = wk,
                    volume = s.sumOf { it.weightKg * it.reps },
                    avgRpe = if (rpes.isEmpty()) null else rpes.average(),
                    hardSets = s.size,
                )
            }
    }

    fun analyze(weeks: List<WeeklyVolume>): DeloadAdvice {
        if (weeks.size < 4) return DeloadAdvice(false, "Building base, not enough history to call a deload yet.")
        val recent = weeks.takeLast(4)
        // Genuine week-over-week growth (>3% each), not merely flat volume.
        val monotonicUp = recent.zipWithNext().all { (a, b) -> b.volume > a.volume * 1.03 }
        val rpes = recent.mapNotNull { it.avgRpe }
        val rpeHighRising = rpes.size >= 3 && rpes.last() >= 8.3 && rpes.last() >= rpes.first() - 0.1
        return when {
            monotonicUp -> DeloadAdvice(true, "Volume has climbed 4 weeks straight, take a deload (~60% volume) so adaptations can catch up.")
            rpeHighRising -> DeloadAdvice(true, "Average RPE is high and not dropping, back off to ~60% volume this week to shed fatigue.")
            else -> DeloadAdvice(false, "Fatigue looks manageable, keep progressing.")
        }
    }
}
