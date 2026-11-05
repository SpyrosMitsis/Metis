package com.workoutmaker.app.util

import org.junit.Assert.*
import org.junit.Test

class LogRedactionTest {
    @Test fun credentialsAreRemovedFromHeadersJsonAndUrls() {
        val input = "Headers: [Authorization=[Bearer secret-one], apikey=[secret-two]]\n" +
            "{\"access_token\":\"secret-three\",\"refresh_token\":\"secret-four\",\"password\":\"secret-five\"}\n" +
            "https://example.test?api_key=secret-six&x=1"
        val safe = redactLog(input)
        listOf("secret-one", "secret-two", "secret-three", "secret-four", "secret-five", "secret-six").forEach {
            assertFalse("Leaked $it: $safe", safe.contains(it))
        }
        assertTrue(safe.contains("REDACTED"))
    }
    @Test fun ordinaryDiagnosticsSurvive() {
        val text = "reference=abc-123 plan-week HTTP 422: Missing dose"
        assertEquals(text, redactLog(text))
    }
    @Test fun bearerTokenAcrossMultilineHeaderIsRemoved() {
        assertFalse(redactLog("Authorization: Bearer secret-value\nHTTP 401").contains("secret-value"))
    }
}
