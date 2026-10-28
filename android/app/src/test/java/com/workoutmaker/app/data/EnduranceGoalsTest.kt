package com.workoutmaker.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EnduranceGoalsTest {

    @Test
    fun `plus increases and minus decreases the displayed pace or speed`() {
        for (sport in listOf("run", "swim", "ride")) {
            val initial = EnduranceGoals.defaultPaceSec(sport)
            val plus = EnduranceGoals.stepPaceValue(sport, initial, increase = true)
            val minus = EnduranceGoals.stepPaceValue(sport, initial, increase = false)
            if (sport == "ride") {
                assertTrue(3600.0 / plus > 3600.0 / initial)
                assertTrue(3600.0 / minus < 3600.0 / initial)
            } else {
                assertTrue(plus > initial)
                assertTrue(minus < initial)
            }
            val spec = EnduranceGoals.pace.getValue(sport)
            for (edge in listOf(spec.minSecPerKm, spec.maxSecPerKm)) {
                for (increase in listOf(false, true)) {
                    assertTrue(EnduranceGoals.stepPaceValue(sport, edge, increase) in spec.minSecPerKm..spec.maxSecPerKm)
                }
            }
        }
    }


    @Test
    fun `posts sit at even screen intervals even though the distances do not`() {
        // Index space, not distance space: the flag is a quarter of the way along
        // at 10K, halfway at the half, three quarters at the marathon.
        assertEquals(5.0, EnduranceGoals.kmForFraction("run", 0f), 0.001)
        assertEquals(10.0, EnduranceGoals.kmForFraction("run", 0.25f), 0.001)
        assertEquals(21.1, EnduranceGoals.kmForFraction("run", 0.5f), 0.001)
        assertEquals(42.2, EnduranceGoals.kmForFraction("run", 0.75f), 0.001)
        assertEquals(50.0, EnduranceGoals.kmForFraction("run", 1f), 0.001)
        // Between posts it interpolates within that segment only.
        assertEquals(7.5, EnduranceGoals.kmForFraction("run", 0.125f), 0.01)
    }

    @Test
    fun `every sport round-trips a distance back to the fraction that produced it`() {
        for (sport in listOf("run", "ride", "swim")) {
            for (step in 0..20) {
                val f = step / 20f
                val km = EnduranceGoals.kmForFraction(sport, f)
                assertEquals("$sport at $f", f, EnduranceGoals.fractionForKm(sport, km), 0.005f)
            }
        }
    }

    @Test
    fun `letting go near a post locks onto it, letting go between them does not`() {
        // A quarter is exactly 10K; 0.24 is inside the snap radius, 0.13 is not.
        assertEquals(0.25f, EnduranceGoals.snapFraction("run", 0.24f), 0.0001f)
        assertEquals(0.13f, EnduranceGoals.snapFraction("run", 0.13f), 0.0001f)
        assertEquals(1f, EnduranceGoals.snapFraction("run", 0.98f), 0.0001f)
    }

    @Test
    fun `the post name only shows when the flag is actually standing on it`() {
        assertEquals("Half marathon", EnduranceGoals.postAt("run", 0.5f)?.name)
        assertNull(EnduranceGoals.postAt("run", 0.4f))
        assertEquals("Ironman", EnduranceGoals.postAt("swim", 0.75f)?.name)
        assertEquals("Gran fondo", EnduranceGoals.postAt("ride", 0.75f)?.name)
    }

    @Test
    fun `short distances read in metres, long ones lose the decimal`() {
        assertEquals("750 m", EnduranceGoals.formatKm(0.75))
        assertEquals("1900 m", EnduranceGoals.formatKm(1.9))
        assertEquals("5.0 km", EnduranceGoals.formatKm(5.0))
        assertEquals("21.1 km", EnduranceGoals.formatKm(21.1))
        assertEquals("160 km", EnduranceGoals.formatKm(160.0))
    }

    @Test
    fun `each sport shows the pace in its own units from one stored value`() {
        assertEquals("5:22 /km", EnduranceGoals.formatPace("run", 322))
        assertEquals("27.1 km/h", EnduranceGoals.formatPace("ride", 133))
        assertEquals("1:49 /100 m", EnduranceGoals.formatPace("swim", 1090))
    }

    // The one rule that makes the slider learnable across three sports whose
    // units point in opposite directions.
    @Test
    fun `right is always faster and speed steps follow the requested effort`() {
        for (sport in listOf("run", "ride", "swim")) {
            val spec = EnduranceGoals.pace.getValue(sport)
            // Fastest possible = fraction 1.
            assertEquals("$sport", 1f, EnduranceGoals.paceFraction(sport, spec.minSecPerKm), 0.0001f)
            assertEquals("$sport", 0f, EnduranceGoals.paceFraction(sport, spec.maxSecPerKm), 0.0001f)

            val mid = (spec.minSecPerKm + spec.maxSecPerKm) / 2
            val faster = EnduranceGoals.stepPace(sport, mid, faster = true)
            val slower = EnduranceGoals.stepPace(sport, mid, faster = false)
            assertTrue("$sport: + must lower seconds per km", faster < mid)
            assertTrue("$sport: - must raise seconds per km", slower > mid)
            assertTrue("$sport: + must move the slider right", EnduranceGoals.paceFraction(sport, faster) > EnduranceGoals.paceFraction(sport, mid))
        }
    }

    @Test
    fun `stepping and dragging can never leave the plausible range`() {
        for (sport in listOf("run", "ride", "swim")) {
            val spec = EnduranceGoals.pace.getValue(sport)
            assertEquals(spec.minSecPerKm, EnduranceGoals.stepPace(sport, spec.minSecPerKm, faster = true))
            assertEquals(spec.maxSecPerKm, EnduranceGoals.stepPace(sport, spec.maxSecPerKm, faster = false))
            assertEquals(spec.minSecPerKm, EnduranceGoals.secForPaceFraction(sport, 2f))
            assertEquals(spec.maxSecPerKm, EnduranceGoals.secForPaceFraction(sport, -1f))
        }
    }

    @Test
    fun `the figure's cadence follows the pace and is capped at both ends`() {
        assertEquals(1f, EnduranceGoals.animationRate("run", 322), 0.001f)
        assertTrue(EnduranceGoals.animationRate("run", 600) > 1f)   // slower pace, slower plod
        assertTrue(EnduranceGoals.animationRate("run", 180) < 1f)   // faster pace, tighter cadence
        // Nothing outside the cap, whatever gets stored.
        assertEquals(1.9f, EnduranceGoals.animationRate("run", 100_000), 0.001f)
        assertEquals(0.42f, EnduranceGoals.animationRate("run", 1), 0.001f)
    }

    @Test
    fun `the estimate is the distance at the chosen pace`() {
        // A marathon at 5:00/km is 3h 31m.
        assertEquals(211, EnduranceGoals.estimateMinutes(42.2, 300))
        assertEquals("3h 31m", EnduranceGoals.formatDuration(211))
        assertEquals("25 min", EnduranceGoals.formatDuration(25))
        assertEquals("1h 00m", EnduranceGoals.formatDuration(60))
    }

    @Test
    fun `a dragged distance still lands on a catalog goal the rest of the app keys on`() {
        assertEquals("5K", EnduranceGoals.catalogGoal("run", 5.0))
        assertEquals("10K", EnduranceGoals.catalogGoal("run", 10.0))
        assertEquals("Half Marathon", EnduranceGoals.catalogGoal("run", 21.1))
        assertEquals("Marathon", EnduranceGoals.catalogGoal("run", 42.2))
        // An in-between distance takes the nearest post's name, never null.
        assertNotNull(EnduranceGoals.catalogGoal("run", 17.4))
        // Ride and swim have no distance names to derive: what a rider wants out
        // of 80 km is a question, not a lookup, so nothing is inferred here.
        assertNull(EnduranceGoals.catalogGoal("ride", 80.0))
        assertNull(EnduranceGoals.catalogGoal("swim", 1.9))
        assertNull(EnduranceGoals.catalogGoal("strength", 0.0))
    }

    @Test
    fun `only run's own distance names belong to the picker`() {
        assertTrue("Half Marathon" in EnduranceGoals.distanceOwnedGoals("run"))
        assertTrue("Run faster" !in EnduranceGoals.distanceOwnedGoals("run"))
        // Every ride and swim goal stays a chip the athlete can tap.
        assertTrue(EnduranceGoals.distanceOwnedGoals("ride").isEmpty())
        assertTrue(EnduranceGoals.distanceOwnedGoals("swim").isEmpty())
    }

    // The regression behind bug #84: dragging the flag used to REPLACE the goal
    // list, so a cyclist who said "Racing" had it overwritten with "Go longer"
    // by their next touch of the distance line.
    @Test
    fun `changing the distance keeps the goals the athlete picked`() {
        assertEquals(
            listOf("Racing", "General fitness"),
            EnduranceGoals.withDistanceGoal(listOf("Racing", "General fitness"), "ride", 80.0),
        )
        // Run swaps one distance name for another and leaves the rest alone.
        assertEquals(
            listOf("Marathon", "Run faster"),
            EnduranceGoals.withDistanceGoal(listOf("10K", "Run faster"), "run", 42.2),
        )
    }

    @Test
    fun `a sport with nothing picked still ends up with a goal`() {
        assertEquals(listOf("Go longer"), EnduranceGoals.withDistanceGoal(emptyList(), "ride", 80.0))
        assertEquals(listOf("Swim further"), EnduranceGoals.withDistanceGoal(emptyList(), "swim", 1.9))
        assertEquals(listOf("5K"), EnduranceGoals.withDistanceGoal(emptyList(), "run", 5.0))
    }

    @Test
    fun `the phrase the coach reads carries the numbers the name throws away`() {
        assertEquals("Run 21.1 km at 5:22 /km", EnduranceGoals.goalPhrase("run", 21.1, 322))
        assertEquals("Swim 1900 m at 1:49 /100 m", EnduranceGoals.goalPhrase("swim", 1.9, 1090))
        assertEquals("Ride 120 km", EnduranceGoals.goalPhrase("ride", 120.0, null))
    }

    @Test
    fun `only the sports that cover ground get a picker`() {
        assertTrue(EnduranceGoals.isEndurance("run"))
        assertTrue(EnduranceGoals.isEndurance("ride"))
        assertTrue(EnduranceGoals.isEndurance("swim"))
        assertTrue(!EnduranceGoals.isEndurance("strength"))
    }
}

// deriveLegacyFields is the ONLY writer of `goal` now. setGoalRace used to copy
// the goal race's name over it, so what the coach was told the athlete's goal
// was depended on which of the two wrote last. These tests are what holds that
// field to one meaning.
class DistanceGoalDerivationTest {

    @Test
    fun `a distance target replaces its catalog name in what the backend reads`() {
        val p = TrainingProfile(
            sports = listOf("run"),
            goals_by_sport = mapOf("run" to listOf("Half Marathon")),
            distance_goal_km = mapOf("run" to 21.1),
            goal_pace_sec_per_km = mapOf("run" to 322),
        ).deriveLegacyFields()

        assertEquals(listOf("Run 21.1 km at 5:22 /km"), p.goals)
        assertEquals("Run 21.1 km at 5:22 /km", p.goal)
        // goals_by_sport is untouched: the goal-race gate and the Settings chips
        // still need the catalog value.
        assertEquals(listOf("Half Marathon"), p.goals_by_sport["run"])
    }

    @Test
    fun `sports without a distance target keep their chosen goals`() {
        val p = TrainingProfile(
            sports = listOf("run", "strength"),
            goals_by_sport = mapOf("run" to listOf("Marathon"), "strength" to listOf("Get stronger")),
            distance_goal_km = mapOf("run" to 42.2),
            goal_pace_sec_per_km = mapOf("run" to 300),
        ).deriveLegacyFields()

        assertEquals(listOf("Get stronger", "Run 42.2 km at 5:00 /km"), p.goals)
    }

    @Test
    fun `a profile with no distance target derives exactly as it always did`() {
        val p = TrainingProfile(
            sports = listOf("strength"),
            goals_by_sport = mapOf("strength" to listOf("Build muscle", "Lose fat")),
        ).deriveLegacyFields()

        assertEquals(listOf("Build muscle", "Lose fat"), p.goals)
        assertEquals("Build muscle + Lose fat", p.goal)
    }
}
