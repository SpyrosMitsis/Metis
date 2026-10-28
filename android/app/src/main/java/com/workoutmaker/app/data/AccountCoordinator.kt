package com.workoutmaker.app.data

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.coroutineContext

/** Concurrent account operations; auth transitions drain them before changing identity. */
@Singleton
class AccountCoordinator @Inject constructor() {
    private val admission = Mutex()
    private val active = mutableSetOf<CompletableDeferred<Unit>>()
    private class Lease(val coordinator: AccountCoordinator) : AbstractCoroutineContextElement(Key) {
        companion object Key : CoroutineContext.Key<Lease>
    }

    suspend fun <T> run(prepare: suspend () -> Unit = {}, block: suspend () -> T): T {
        if (coroutineContext[Lease]?.coordinator === this) return block()
        val done = CompletableDeferred<Unit>()
        admission.withLock {
            prepare()
            synchronized(active) { active.add(done) }
        }
        try {
            return withContext(Lease(this)) { coroutineScope { block() } }
        } finally {
            synchronized(active) { active.remove(done) }
            done.complete(Unit)
        }
    }

    suspend fun <T> exclusive(block: suspend () -> T): T = admission.withLock {
        synchronized(active) { active.toList() }.forEach { it.await() }
        block()
    }
}
