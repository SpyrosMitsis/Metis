package com.workoutmaker.app.util

import kotlinx.coroutines.CancellationException
import com.workoutmaker.app.util.runCatching as catching
import org.junit.Assert.*
import org.junit.Test

class CatchingTest {
    @Test fun cancellationPropagates() {
        val cancelled = CancellationException("cancel")
        try {
            catching { throw cancelled }
            fail("Cancellation was swallowed")
        } catch (actual: CancellationException) { assertSame(cancelled, actual) }
    }
    @Test fun recoverableFailuresStillReturnFailure() {
        val failure = IllegalStateException("offline")
        assertSame(failure, catching { throw failure }.exceptionOrNull())
    }
}
