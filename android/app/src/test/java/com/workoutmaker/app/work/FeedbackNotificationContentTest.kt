package com.workoutmaker.app.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedbackNotificationContentTest {

    @Test fun plainAskWhenNoAnalysis() {
        val (title, text) = FeedbackNotificationContent.build(
            greeting = "Good evening", workoutTitle = "Tempo run",
            label = null, feedback = null, feedbackPending = true,
        )
        assertEquals("Good evening. How did it feel?", title)
        assertTrue(text.contains("Tempo run"))
        assertTrue(text.contains("tune the next sessions"))
    }

    @Test fun debriefLeadsWithVerdictAndAsksForFeedback() {
        val (title, text) = FeedbackNotificationContent.build(
            greeting = "Good evening", workoutTitle = "Tempo run",
            label = "solid", feedback = "Held the target pace, drifted late.",
            feedbackPending = true,
        )
        assertEquals("Coach debrief: solid", title)
        assertTrue(text.startsWith("Held the target pace"))
        assertTrue(text.contains("tell your coach how it felt"))
    }

    @Test fun debriefWithoutPendingFeedbackSkipsTheAsk() {
        val (title, text) = FeedbackNotificationContent.build(
            greeting = "Good evening", workoutTitle = "Tempo run",
            label = "solid", feedback = "Nice work.", feedbackPending = false,
        )
        assertEquals("Coach debrief: solid", title)
        assertFalse(text.contains("tell your coach"))
        assertTrue(text.contains("Tap for the full breakdown."))
    }

    @Test fun longFeedbackIsClippedAndWhitespaceCollapsed() {
        val (_, text) = FeedbackNotificationContent.build(
            greeting = "Hi", workoutTitle = "Run",
            label = "solid", feedback = "a  b\n c " + "x".repeat(300),
            feedbackPending = false,
        )
        assertTrue(text.startsWith("a b c"))
        assertTrue(text.contains("…"))
    }

    @Test fun labelOnlyStillReadsAsDebrief() {
        val (title, text) = FeedbackNotificationContent.build(
            greeting = "Hi", workoutTitle = "Run",
            label = "strong finish", feedback = null, feedbackPending = true,
        )
        assertEquals("Coach debrief: strong finish", title)
        assertTrue(text.contains("Tap for the full breakdown"))
    }

    @Test fun typeMatchingTable() {
        val f = FeedbackNotificationContent::typeLooksLike
        assertTrue(f("run", "Run"))
        assertTrue(f("run", "VirtualRun"))
        assertFalse(f("run", "Walk"))
        assertTrue(f("ride", "VirtualRide"))
        assertTrue(f("ride", "Cycling"))
        assertTrue(f("swim", "OpenWaterSwim"))
        assertTrue(f("strength", "WeightTraining"))
        assertTrue(f("strength", "Gym"))
        assertFalse(f("run", "Ride"))
        assertFalse(f("swim", null))
        assertFalse(f("rest", "Run"))
    }
}
