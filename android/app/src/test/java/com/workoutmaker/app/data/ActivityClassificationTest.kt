package com.workoutmaker.app.data

import org.junit.Assert.*
import org.junit.Test

class ActivityClassificationTest {
    private val id = "11111111-1111-4111-8111-111111111111"
    private fun activity(id: String = this.id, source: String = "i42") = CompletedActivity(id, source, type = "Swim", date = "2026-10-22", duration_seconds = 1200)

    @Test fun temporaryDigestIdsCannotBeSaved() {
        assertFalse(persistedActivityId("digest:2026-10-22:Morning Swim"))
        assertTrue(persistedActivityId(id))
        assertFalse(ActivityReconciliationViewModel.State(activity = activity("digest:date:name"), actualType = "Swim").canSave)
    }
    @Test fun sourceIdentityResolvesDigestWithoutGuessingByDate() {
        val pending = activity("digest:date:name")
        val wrong = activity("22222222-2222-4222-8222-222222222222", "i99")
        assertEquals(id, resolveActivity(pending, listOf(wrong, activity()))?.id)
        assertNull(resolveActivity(pending, listOf(wrong)))
    }
    @Test fun ambiguousLegacyDigestNeverEditsFirstMatchingSession() {
        val pending = activity("digest:date:name", "digest")
        assertNull(resolveActivity(pending, listOf(activity(), activity("22222222-2222-4222-8222-222222222222"))))
        assertEquals(id, resolveActivity(pending, listOf(activity()))?.id)
    }
    @Test fun planBasedOutcomeNeedsALinkAndViewingDoesNotOpenEditor() {
        val state = ActivityReconciliationViewModel.State(activity = activity(), actualType = "Swim", status = "completed_as_planned")
        assertFalse(state.editing)
        assertFalse(state.canSave)
        assertTrue(state.copy(planId = id).canSave)
    }
    @Test fun failuresNeverExposeRequestHeadersOrTokens() {
        val raw = RuntimeException("invalid input syntax for type uuid URL: https://private.invalid Headers: Authorization=Bearer secret-token")
        val message = activityCorrectionError(raw)
        assertFalse(message.contains("secret-token"))
        assertFalse(message.contains("Authorization"))
        assertFalse(message.contains("https://"))
        assertEquals("This activity changed elsewhere. Reopen the editor and try again.", activityCorrectionError(RuntimeException("activity changed; refresh")))
    }
}
