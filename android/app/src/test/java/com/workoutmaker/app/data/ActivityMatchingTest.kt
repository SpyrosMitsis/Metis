package com.workoutmaker.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityMatchingTest {
    @Test fun sportMatchingDoesNotCompleteRunsFromWalksOrStrengthFromGenericWorkouts() {
        assertFalse(activityMatchesPlan("run", "Walk"))
        assertFalse(activityMatchesPlan("strength", "Workout"))
        assertFalse(activityMatchesPlan("run", null))
        assertTrue(activityMatchesPlan("run", "TrailRun"))
        assertTrue(activityMatchesPlan("strength", "WeightTraining"))
        assertTrue(activityMatchesPlan("ride", "VirtualRide"))
        assertTrue(activityMatchesPlan("swim", "Open Water Swim"))
    }
}
