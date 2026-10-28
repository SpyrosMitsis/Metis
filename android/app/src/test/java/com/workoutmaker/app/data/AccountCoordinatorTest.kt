package com.workoutmaker.app.data

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class AccountCoordinatorTest {
    @Test fun transitionDrainsRequestsAndBlocksNewAdmissions() = runBlocking {
        withTimeout(5000) {
            val gate = AccountCoordinator()
            val started = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            var owner = "first"
            val operation = launch {
                gate.run { started.complete(Unit); release.await(); assertEquals("first", owner) }
            }
            started.await()
            val transition = launch(start = CoroutineStart.UNDISPATCHED) {
                gate.exclusive { owner = "second" }
            }
            val next = async(start = CoroutineStart.UNDISPATCHED) { gate.run { owner } }
            assertFalse(transition.isCompleted)
            assertFalse(next.isCompleted)
            release.complete(Unit)
            operation.join(); transition.join()
            assertEquals("second", next.await())
        }
    }

    @Test fun cancellationReleasesLeaseAndNestedOperationsDoNotDeadlock() = runBlocking {
        withTimeout(5000) {
            val gate = AccountCoordinator()
            val started = CompletableDeferred<Unit>()
            val operation = launch {
                gate.run { gate.run { started.complete(Unit); awaitCancellation() } }
            }
            started.await()
            operation.cancelAndJoin()
            assertEquals("signed out", gate.exclusive { "signed out" })
        }
    }

    @Test fun accountOperationsCanOverlap() = runBlocking {
        withTimeout(5000) {
            val gate = AccountCoordinator()
            val entered = CompletableDeferred<Unit>()
            val second = CompletableDeferred<Unit>()
            val first = launch { gate.run { entered.complete(Unit); second.await() } }
            entered.await()
            gate.run { second.complete(Unit) }
            first.join()
        }
    }
}
