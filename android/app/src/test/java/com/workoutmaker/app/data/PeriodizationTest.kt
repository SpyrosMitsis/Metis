package com.workoutmaker.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.roundToInt

// Guards the constants mirrored from supabase/functions/plan-week/index.ts. If
// plan-week's ramp/deload rules change, these fail and point at the mirror.
class PeriodizationTest {

    @Test
    fun `enabling a program supplies its start date once and preserves explicit dates`() {
        val today = java.time.LocalDate.of(2026, 10, 27)
        val started = Periodization.configure(TrainingProfile(), true, today)
        assertTrue(started.periodized)
        assertEquals("2026-10-27", started.program_started_on)
        val paused = Periodization.configure(started, false, today.plusDays(7))
        assertFalse(paused.periodized)
        assertEquals(started.program_started_on, paused.program_started_on)
        assertEquals(started, Periodization.configure(paused, true, today.plusDays(14)))
        assertEquals("2026-10-01", Periodization.configure(TrainingProfile(program_started_on = "2026-10-01"), true, today).program_started_on)
        assertEquals(null, Periodization.configure(TrainingProfile(), false, today).program_started_on)
    }


    @Test
    fun `builds for four weeks then deloads, repeating`() {
        val weeks = Periodization.projectedWeeks(baseTss = 350, weeks = 10)

        assertEquals(10, weeks.size)
        // Weeks 5 and 10 are the deloads: every 5th week, after 4 build weeks.
        assertEquals(listOf(5, 10), weeks.filter { it.deload }.map { it.number })
        assertTrue(weeks.filterNot { it.deload }.none { it.deload })
    }

    @Test
    fun `build weeks ramp by the documented multiplier`() {
        val weeks = Periodization.projectedWeeks(baseTss = 350, weeks = 4)

        // 350 * 1.08^n, rounded.
        assertEquals(listOf(378, 408, 441, 476), weeks.map { it.tss })
        assertTrue(weeks.none { it.deload })
    }

    @Test
    fun `deload cuts the block peak by forty percent`() {
        val weeks = Periodization.projectedWeeks(baseTss = 350, weeks = 5)
        val peak = weeks[3].tss // week 4, top of the build block
        val deload = weeks[4]

        assertTrue(deload.deload)
        assertEquals((peak * 0.6f).roundToInt(), deload.tss)
    }

    @Test
    fun `the next block resumes from the build peak, not the deload`() {
        // The divergence from plan-week that Periodization documents: each block
        // must peak higher than the last, or periodization is just decay.
        val weeks = Periodization.projectedWeeks(baseTss = 350, weeks = 10)
        val firstPeak = weeks[3].tss   // week 4
        val secondPeak = weeks[8].tss  // week 9

        assertTrue("second block should peak higher", secondPeak > firstPeak)
        assertFalse(weeks[5].deload)
        // Week 6 resumes the ramp above the pre-deload peak.
        assertTrue(weeks[5].tss > firstPeak)
    }

    @Test
    fun `a personalized base scales the whole ladder`() {
        val low = Periodization.projectedWeeks(baseTss = 200, weeks = 4)
        val high = Periodization.projectedWeeks(baseTss = 600, weeks = 4)

        assertTrue(high.zip(low).all { (h, l) -> h.tss > l.tss })
        assertEquals(216, low.first().tss)  // 200 * 1.08
        assertEquals(648, high.first().tss) // 600 * 1.08
    }

    @Test
    fun `a nonsense base cannot produce a nonsense ladder`() {
        val weeks = Periodization.projectedWeeks(baseTss = 0, weeks = 6)

        assertEquals(6, weeks.size)
        assertTrue("loads stay positive", weeks.all { it.tss >= 0 })
    }
}
