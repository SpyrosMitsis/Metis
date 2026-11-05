package com.workoutmaker.app.util
import org.junit.Assert.*
import org.junit.Test
class SupportReferenceTest {
    @Test fun friendlyMessageKeepsSupportReference() {
        val id = "12345678-1234-1234-1234-123456789abc"
        assertTrue(friendlyError("Network timeout\nSupport reference: $id").endsWith("Support reference: $id"))
        assertTrue(friendlyError("Support reference: $id").endsWith(id))
    }
}
