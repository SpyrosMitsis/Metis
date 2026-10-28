package com.workoutmaker.app.work

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.workoutmaker.app.strength.StrengthRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

// Drains the offline strength sync queue (unsynced workouts/routines/custom
// exercises + pending deletes). The work request carries a CONNECTED network
// constraint, so WorkManager runs it the moment a connection is available —
// even if the app has been closed — and retries with backoff on failure.
@HiltWorker
class StrengthSyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val repo: StrengthRepository,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = try {
        if (repo.syncPending() == 0) Result.success() else Result.retry()
    } catch (cancelled: kotlinx.coroutines.CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        // Network/transient failure → let WorkManager retry with backoff, but
        // cap it: a durable server rejection would otherwise retry forever.
        // Failed items stay unsynced locally, and every workout save / app
        // foreground enqueues a fresh sync, so giving up here loses nothing.
        if (runAttemptCount >= 5) Result.failure() else Result.retry()
    }
}

object StrengthSync {
    private const val WORK_NAME = "strength-sync"

    /** Request a sync. Runs now if online, otherwise as soon as a network appears. */
    fun request(context: Context) {
        val req = OneTimeWorkRequestBuilder<StrengthSyncWorker>()
            .addTag("account-sync")
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
            .build()
        // Preserve requests made while a worker is finishing its current snapshot.
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
    }
}
