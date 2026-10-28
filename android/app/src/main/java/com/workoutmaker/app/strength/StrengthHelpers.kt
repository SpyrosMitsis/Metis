package com.workoutmaker.app.strength

import kotlin.math.roundToInt

// Epley estimated 1RM.
fun epley1rm(weightKg: Double, reps: Int): Double =
    if (reps <= 1) weightKg else weightKg * (1 + reps / 30.0)

// --- Plate calculator -------------------------------------------------------
object PlateMath {
    val barbellKg = 20.0
    private val platesKg = listOf(25.0, 20.0, 15.0, 10.0, 5.0, 2.5, 1.25)

    data class PerSide(val plate: Double, val count: Int)

    /** Plates needed per side to reach [target] total on a [bar]-kg barbell. */
    fun perSide(target: Double, bar: Double = barbellKg): List<PerSide> {
        var remaining = (target - bar) / 2.0
        if (remaining <= 0) return emptyList()
        val out = mutableListOf<PerSide>()
        for (p in platesKg) {
            val n = (remaining / p).toInt()
            if (n > 0) {
                out.add(PerSide(p, n))
                remaining -= n * p
            }
        }
        return out
    }
}

// --- Per-exercise stats / PRs ----------------------------------------------
data class SessionPoint(val dateMillis: Long, val e1rm: Double, val volume: Double, val bestWeight: Double)

data class ExerciseStats(
    val name: String,
    val bestE1rm: Double,
    val bestWeight: Double,
    val bestVolume: Double,
    val points: List<SessionPoint>,
) {
    val hasData get() = points.isNotEmpty()
}

object StrengthStats {
    /** Reduce raw sets (with their workout dates) into per-session points + PRs. */
    fun compute(name: String, sets: List<SetWithDate>): ExerciseStats {
        val working = sets.filter { !it.isWarmup && it.quantityUnit == "reps" && ExerciseMetadataCatalog.byName[name]?.loadMode !in listOf("band", "assistance") }
        val byDay = working.groupBy { it.startedAt }
        val points = byDay.entries
            .sortedBy { it.key }
            .map { (date, daySets) ->
                val e1rm = daySets.maxOf { epley1rm(it.weightKg, it.reps) }
                val volume = daySets.sumOf { it.weightKg * it.reps }
                val best = daySets.maxOf { it.weightKg }
                SessionPoint(date, round1(e1rm), round1(volume), best)
            }
        return ExerciseStats(
            name = name,
            bestE1rm = points.maxOfOrNull { it.e1rm } ?: 0.0,
            bestWeight = points.maxOfOrNull { it.bestWeight } ?: 0.0,
            bestVolume = points.maxOfOrNull { it.volume } ?: 0.0,
            points = points,
        )
    }
}

private fun round1(v: Double): Double = (v * 10).roundToInt() / 10.0
