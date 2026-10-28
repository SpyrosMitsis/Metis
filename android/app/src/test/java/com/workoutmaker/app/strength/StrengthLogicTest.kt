package com.workoutmaker.app.strength

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StrengthLogicTest {

    @Test fun epley_oneRepIsTheWeight() {
        assertEquals(100.0, epley1rm(100.0, 1), 1e-6)
    }

    @Test fun epley_increasesWithReps() {
        assertTrue(epley1rm(100.0, 5) > epley1rm(100.0, 1))
        // 100 * (1 + 5/30) = 116.667
        assertEquals(116.6667, epley1rm(100.0, 5), 1e-3)
    }

    @Test fun plates_100kgOn20Bar() {
        // (100 - 20) / 2 = 40 kg per side
        val perSide = PlateMath.perSide(100.0)
        assertEquals(40.0, perSide.sumOf { it.plate * it.count }, 1e-6)
        // greedy largest-first: 25 + 15
        assertEquals(listOf(25.0 to 1, 15.0 to 1), perSide.map { it.plate to it.count })
    }

    @Test fun plates_emptyBarOrBelow() {
        assertTrue(PlateMath.perSide(20.0).isEmpty())
        assertTrue(PlateMath.perSide(10.0).isEmpty())
    }

    @Test fun stats_picksBestE1rmAndVolumePerDay() {
        val sets = listOf(
            SetWithDate(weightKg = 100.0, reps = 5, isWarmup = false, startedAt = 1_000L),
            SetWithDate(weightKg = 60.0, reps = 5, isWarmup = true, startedAt = 1_000L),  // warmup ignored
            SetWithDate(weightKg = 105.0, reps = 3, isWarmup = false, startedAt = 2_000L),
        )
        val stats = StrengthStats.compute("Back Squat", sets)
        assertEquals(2, stats.points.size)
        // best e1rm is from the 105x3 session
        assertTrue(stats.bestE1rm >= epley1rm(105.0, 3) - 1e-6)
        // day 1 volume = 100*5 = 500 (warmup excluded)
        assertEquals(500.0, stats.points.first().volume, 1e-6)
    }

    // --- C6: 1RM / %-of-1RM ------------------------------------------------
    @Test fun oneRm_roundsToLoadableStep() {
        assertEquals(100.0, roundToStep(100.6), 1e-9)
        assertEquals(102.5, roundToStep(101.3), 1e-9)
    }

    @Test fun oneRm_tableScalesByPercent() {
        val table = OneRepMax.table(100.0)
        assertEquals(100.0, table.first { it.pct == 100 }.weightKg, 1e-9)
        // 80% of 100 = 80, rounded to step
        assertEquals(80.0, table.first { it.pct == 80 }.weightKg, 1e-9)
    }

    // --- C2: PRs -----------------------------------------------------------
    @Test fun prs_detectsWeightE1rmAndRepPr() {
        val prior = Prs.record(listOf(LogSet(100.0, 5), LogSet(90.0, 8)))
        // New 105x5 beats best weight, best e1rm, and the 5-rep PR.
        val hits = Prs.detect(prior, listOf(LogSet(105.0, 5)))
        assertTrue(hits.any { it.type == "weight" })
        assertTrue(hits.any { it.type == "e1rm" })
        assertTrue(hits.any { it.type == "rep" })
    }

    @Test fun prs_noFalsePositiveOnLighterSet() {
        val prior = Prs.record(listOf(LogSet(100.0, 5)))
        assertTrue(Prs.detect(prior, listOf(LogSet(95.0, 5))).isEmpty())
    }

    @Test fun prs_warmupsIgnored() {
        val prior = Prs.record(listOf(LogSet(100.0, 5)))
        // a heavy "warmup" should not count
        assertTrue(Prs.detect(prior, listOf(LogSet(200.0, 1, isWarmup = true))).isEmpty())
    }

    // --- B1: progression ---------------------------------------------------
    @Test fun progression_doubleAddsLoadWhenTopRepsHit() {
        // last: 3x8 @ 80 with rep range 6-8 → hit top → +2.5kg, reset to 6
        val s = Progression.suggest(
            listOf(LogSet(80.0, 8), LogSet(80.0, 8), LogSet(80.0, 8)),
            ProgressionRule.DOUBLE, repLow = 6, repHigh = 8, compound = true,
        )!!
        assertEquals(82.5, s.weightKg, 1e-9)
        assertEquals(6, s.reps)
    }

    @Test fun progression_doubleAddsRepWhenBelowTop() {
        val s = Progression.suggest(
            listOf(LogSet(80.0, 6), LogSet(80.0, 6)),
            ProgressionRule.DOUBLE, repLow = 6, repHigh = 8, compound = true,
        )!!
        assertEquals(80.0, s.weightKg, 1e-9)
        assertEquals(7, s.reps)
    }

    @Test fun progression_linearAddsIncrement() {
        val s = Progression.suggest(
            listOf(LogSet(60.0, 5)), ProgressionRule.LINEAR, 5, 5, compound = false,
        )!!
        assertEquals(61.25, s.weightKg, 1e-9)
    }

    // --- B5: volume + balance ---------------------------------------------
    @Test fun volume_countsWorkingSetsPerMuscleAndStatus() {
        val sets = List(12) { LogSet(80.0, 8, muscle = "Chest") } +
            List(3) { LogSet(60.0, 10, muscle = "Back") } +
            listOf(LogSet(60.0, 5, muscle = "Chest", isWarmup = true)) // ignored
        val v = VolumeBalance.byMuscle(sets)
        val chest = v.first { it.muscle == "Chest" }
        assertEquals(12, chest.sets)
        assertEquals("in_range", chest.status)
        assertEquals("under", v.first { it.muscle == "Back" }.status)
    }

    @Test fun volume_flagsPushPullImbalance() {
        val v = VolumeBalance.byMuscle(
            List(12) { LogSet(50.0, 10, muscle = "Chest") } + List(4) { LogSet(50.0, 10, muscle = "Back") },
        )
        assertTrue(VolumeBalance.balance(v).any { it.text.contains("pull", ignoreCase = true) })
    }

    // --- B2: deload --------------------------------------------------------
    @Test fun deload_recommendsAfterFourRisingWeeks() {
        val week = 7L * 24 * 60 * 60 * 1000
        val sets = mutableListOf<LogSet>()
        // weeks 0..3 with increasing set counts → rising volume
        for (w in 0..3) repeat(6 + w * 2) { sets.add(LogSet(100.0, 5, dateMillis = w * week + 1000)) }
        val advice = Deload.analyze(Deload.weekly(sets))
        assertTrue(advice.recommended)
        assertEquals(60, advice.suggestedVolumePct)
    }

    @Test fun deload_notRecommendedWhenFlat() {
        val week = 7L * 24 * 60 * 60 * 1000
        val sets = mutableListOf<LogSet>()
        for (w in 0..4) repeat(8) { sets.add(LogSet(100.0, 5, rpe = 7, dateMillis = w * week + 1000)) }
        assertTrue(!Deload.analyze(Deload.weekly(sets)).recommended)
    }

    // --- F2: CSV import ----------------------------------------------------
    @Test fun csv_parsesHevyFormatWithWarmupAndKg() {
        val csv = """
            "title","start_time","exercise_title","set_index","set_type","weight_kg","reps","rpe"
            "Push Day","2024-01-05 08:00:00","Bench Press","0","warmup","40","10",""
            "Push Day","2024-01-05 08:00:00","Bench Press","1","normal","80","8","8"
            "Push Day","2024-01-05 08:00:00","Bench Press","2","normal","80","7","9"
        """.trimIndent()
        val r = StrengthCsvImport.parse(csv)
        assertEquals("Hevy", r.format)
        assertEquals(1, r.workoutCount)
        assertEquals(3, r.setCount)
        val bench = r.workouts.first().exercises.first()
        assertEquals("Bench Press", bench.name)
        assertTrue(bench.sets[0].isWarmup)
        assertEquals(80.0, bench.sets[1].weightKg, 1e-6)
        assertEquals(8, bench.sets[1].rpe)
    }

    @Test fun csv_parsesStrongFormatAndConvertsLb() {
        val csv = """
            Date,Workout Name,Exercise Name,Set Order,Weight (lbs),Reps,RPE
            2023-09-15 18:30:00,Legs,Back Squat,1,225,5,
            2023-09-15 18:30:00,Legs,Back Squat,2,225,5,
        """.trimIndent()
        val r = StrengthCsvImport.parse(csv)
        assertEquals("Strong", r.format)
        assertEquals(1, r.workoutCount)
        // 225 lb ≈ 102.06 kg
        assertEquals(102.06, r.workouts.first().exercises.first().sets.first().weightKg, 0.2)
    }
    @Test fun csv_preservesExplicitTimedAndCarryUnits() {
        val csv = "Date;Workout Name;Exercise Name;Weight;Reps;Quantity Unit\n2026-10-22 08:00:00;Mixed;Plank;0;30;seconds\n2026-10-22 08:00:00;Mixed;Farmer Carry;20;25;metres"
        val sets = StrengthCsvImport.parse(csv).workouts.single().exercises.flatMap { it.sets }
        assertEquals(listOf("seconds", "metres"), sets.map { it.quantityUnit })
        assertEquals(listOf(30, 25), sets.map { it.reps })
    }

    @Test fun timedSetsDoNotCreateRepOrVolumeRecords() {
        val sets = listOf(LogSet(20.0, 30, quantityUnit = "seconds"), LogSet(20.0, 25, quantityUnit = "metres"))
        assertEquals(0.0, Prs.record(sets).bestE1rm, 0.0)
        assertTrue(Prs.detect(PrRecord(), sets).isEmpty())
    }

}
