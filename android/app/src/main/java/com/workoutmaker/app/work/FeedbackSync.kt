package com.workoutmaker.app.work

import com.workoutmaker.app.util.runCatching

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.workoutmaker.app.data.WorkoutFeedback
import com.workoutmaker.app.data.WorkoutRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit
import com.workoutmaker.app.data.markPlannedComplete
import com.workoutmaker.app.data.refreshMemory
import com.workoutmaker.app.data.reportPain
import com.workoutmaker.app.data.submitFeedback
import java.time.LocalDate

// Durably submit a post-workout effort rating. The set data is already safe in
// Room; this makes the session RPE/difficulty survive being offline at the gym
// (or even an app kill) instead of being dropped by a swallowed insert. The
// payload rides in WorkManager's input Data, which persists across restarts, so
// no extra local table is needed. On a network failure WorkManager retries with
// backoff — even if the app has been closed.
//
// It covers BOTH ways a session gets rated, which it did not always: the
// strength logger queued through here while Home wrote straight to postgrest
// and surfaced a failure as an error string, losing the rating. Same data, same
// basement-gym network, two different levels of care. Home now falls back to
// this queue (HomeViewModel.submitFeedback), so the only difference between the
// paths is that Home tries the direct write first for an instant refresh.
//
// `planned_workout_id` is what separates the two: with one, the day's planned
// row is marked complete/skipped as well as rated; without one, this is a
// session that was never on the plan and only the feedback row is written.
@HiltWorker
class FeedbackSyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val repo: WorkoutRepository,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        // Never submit one account's queued feedback under another account.
        // Legacy jobs without an owner cannot safely be attributed.
        val owner = inputData.getString(KEY_OWNER) ?: return Result.failure()
        val current = repo.auth.currentUserOrNull()?.id ?: return Result.retry()
        if (current != owner) return Result.failure()
        val date = inputData.getString(KEY_DATE) ?: return Result.success()
        val rpe = inputData.getInt(KEY_RPE, -1).takeIf { it in 1..10 }
        val difficulty = inputData.getString(KEY_DIFFICULTY)?.takeIf { it.isNotBlank() }
        val notes = inputData.getString(KEY_NOTES)?.takeIf { it.isNotBlank() }
        val plannedId = inputData.getString(KEY_PLANNED_ID)?.takeIf { it.isNotBlank() }
        val completed = inputData.getBoolean(KEY_COMPLETED, true)
        val painArea = inputData.getString(KEY_PAIN_AREA)?.takeIf { it.isNotBlank() }
        val pain = inputData.getInt(KEY_PAIN, -1).takeIf { it in 1..5 }
        return try {
            repo.withAccount(owner) {
            val feedbackId = inputData.getString(KEY_FEEDBACK_ID) ?: id.toString()
            if (plannedId != null) {
                // Marks the planned row done/skipped AND writes the rating, and
                // is idempotent per planned session (it replaces any existing
                // feedback row), so a retry after a partial failure is safe.
                repo.markPlannedComplete(plannedId, date, completed = completed, difficulty = difficulty, rpe = rpe, feedbackId = feedbackId, notes = notes)
            } else if (rpe != null || difficulty != null) {
                // Only write a feedback row when there's an actual rating; a bare
                // "completed" is already implied by the synced session.
                repo.submitFeedback(
                    WorkoutFeedback(id = feedbackId, date = date, completed = completed, actual_rpe = rpe, difficulty = difficulty, notes = notes),
                )
            }
            // The pain answer rides on the same queued item so it cannot be the
            // half that survives. Ordered after the feedback write because
            // injury-checkin updates the row that write just created.
            if (painArea != null && pain != null && completed) {
                repo.reportPain(painArea, pain, plannedId, runCatching { LocalDate.parse(date) }.getOrDefault(LocalDate.now()))
            }
            // Fold the session into the coach's rolling memory; best-effort.
            runCatching { repo.refreshMemory() }
            Result.success()
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Network/transient failure → retry with backoff.
            Result.retry()
        }
    }

    companion object {
        private const val KEY_FEEDBACK_ID = "feedback_id"
        private const val KEY_OWNER = "owner_uid"
        private const val KEY_DATE = "date"
        private const val KEY_RPE = "rpe"
        private const val KEY_DIFFICULTY = "difficulty"
        private const val KEY_NOTES = "notes"
        private const val KEY_PLANNED_ID = "planned_id"
        private const val KEY_COMPLETED = "completed"
        private const val KEY_PAIN_AREA = "pain_area"
        private const val KEY_PAIN = "pain"

        /** Queue a durable, retried feedback submission for a finished session. */
        fun request(
            context: Context,
            date: String,
            rpe: Int?,
            difficulty: String?,
            notes: String?,
            ownerUid: String?,
            feedbackId: String = java.util.UUID.randomUUID().toString(),
            plannedId: String? = null,
            completed: Boolean = true,
            painArea: String? = null,
            pain: Int? = null,
        ) {
            if (ownerUid.isNullOrBlank()) return
            val req = OneTimeWorkRequestBuilder<FeedbackSyncWorker>()
                .addTag("account-sync")
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .setInputData(
                    workDataOf(
                        KEY_FEEDBACK_ID to feedbackId,
                        KEY_OWNER to ownerUid,
                        KEY_DATE to date,
                        KEY_RPE to (rpe ?: -1),
                        KEY_DIFFICULTY to (difficulty ?: ""),
                        KEY_NOTES to (notes ?: ""),
                        KEY_PLANNED_ID to (plannedId ?: ""),
                        KEY_COMPLETED to completed,
                        KEY_PAIN_AREA to (painArea ?: ""),
                        KEY_PAIN to (pain ?: -1),
                    ),
                )
                .build()
            WorkManager.getInstance(context).enqueue(req)
        }
    }
}
