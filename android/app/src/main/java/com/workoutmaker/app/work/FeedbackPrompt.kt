package com.workoutmaker.app.work

import com.workoutmaker.app.util.runCatching

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.notify.Notifications
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.postgrest.postgrest
import java.time.LocalDate
import java.util.Calendar
import java.util.concurrent.TimeUnit
import kotlinx.serialization.Serializable
import android.app.PendingIntent
import com.workoutmaker.app.data.analyzeActivity
import com.workoutmaker.app.data.completedActivities
import com.workoutmaker.app.data.plannedWorkouts

// Evening prompt: if a completed activity matched today's planned session, lead
// with the coach's measured debrief when the analysis is ready ("Coach debrief:
// solid"), falling back to the plain "how did it feel?" ask — feedback is what
// closes the autoregulation loop (the generator reads it to adjust the next
// sessions). Tapping a debrief deep-links straight to the activity detail.
@HiltWorker
class FeedbackPromptWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val repo: WorkoutRepository,
    private val supabase: SupabaseClient,
) : CoroutineWorker(appContext, params) {

    @Serializable
    private data class FeedbackRow(val date: String)

    override suspend fun doWork(): Result {
        // Not signed in → nothing to do (don't retry).
        if (repo.auth.currentUserOrNull() == null) return Result.success()

        val today = LocalDate.now().toString()
        val state = runCatching {
            val planned = repo.plannedWorkouts(today).filter { it.date == today && it.type != "rest" }
            if (planned.isEmpty()) return@runCatching null

            val acts = repo.completedActivities(today).filter { it.date == today }
            val match = planned.firstNotNullOfOrNull { p ->
                acts.firstOrNull { a -> a.planned_workout_id == p.id }
                    ?.let { p to it }
            }
            val done = match?.first ?: planned.firstOrNull { it.completed } ?: return@runCatching null

            val feedback: List<FeedbackRow> = supabase.postgrest.from("workout_feedback").select {
                filter { eq("date", today) }
            }.decodeList()

            // Debrief: cached execution analysis of the matched activity. peek
            // never triggers an LLM call; absent/unanalyzed reads as null.
            val analysis = match?.second?.let { a ->
                runCatching { repo.analyzeActivity(a.id, peek = true) }.getOrNull()
            }
            val hasDebrief = analysis?.label != null || analysis?.feedback != null

            // Nothing new to say: feedback already logged and no debrief to show.
            if (feedback.isNotEmpty() && !hasDebrief) return@runCatching null

            Pending(
                workoutTitle = done.workout_json.title.ifBlank { "today's session" },
                label = analysis?.label,
                feedback = analysis?.feedback,
                feedbackPending = feedback.isEmpty(),
                activityId = if (hasDebrief) match?.second?.id else null,
                date = today,
            )
        }.getOrNull() ?: return Result.success()

        notify(state)
        return Result.success()
    }

    private data class Pending(
        val workoutTitle: String,
        val label: String?,
        val feedback: String?,
        val feedbackPending: Boolean,
        val activityId: String?,
        val date: String,
    )

    private fun notify(p: Pending) {
        if (ActivityCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return
        val launch = applicationContext.packageManager
            .getLaunchIntentForPackage(applicationContext.packageName)
            ?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                // Deep link: MainActivity routes these to the activity detail.
                if (p.activityId != null) {
                    putExtra("open_activity_id", p.activityId)
                    putExtra("open_activity_date", p.date)
                }
            }
        val pi = launch?.let {
            PendingIntent.getActivity(
                applicationContext, 0, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        val (title, text) = FeedbackNotificationContent.build(
            greeting = Notifications.greeting(),
            workoutTitle = p.workoutTitle,
            label = p.label,
            feedback = p.feedback,
            feedbackPending = p.feedbackPending,
        )
        val n = NotificationCompat.Builder(applicationContext, Notifications.CH_REMINDERS)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(applicationContext).notify(ID, n)
    }

    private companion object {
        const val ID = 1002
    }
}

object FeedbackPromptScheduler {
    fun schedule(context: Context) {
        // Fire at the next 18:30 local time, then daily.
        val now = Calendar.getInstance()
        val target = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 18); set(Calendar.MINUTE, 30); set(Calendar.SECOND, 0)
            if (before(now)) add(Calendar.DAY_OF_MONTH, 1)
        }
        val request = PeriodicWorkRequestBuilder<FeedbackPromptWorker>(1, TimeUnit.DAYS)
            .setInitialDelay(target.timeInMillis - now.timeInMillis, TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "evening-feedback", ExistingPeriodicWorkPolicy.UPDATE, request,
        )
    }
}
