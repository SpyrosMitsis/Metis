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
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.health.HealthConnectManager
import com.workoutmaker.app.notify.Notifications
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.Calendar
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import android.app.PendingIntent
import com.workoutmaker.app.data.AppPreferences
import com.workoutmaker.app.data.DailySummary
import com.workoutmaker.app.data.LocationProvider
import com.workoutmaker.app.data.WeatherCheckResult
import com.workoutmaker.app.data.cachedDailySummary
import com.workoutmaker.app.data.dailySummary
import com.workoutmaker.app.data.syncHealth
import com.workoutmaker.app.data.weatherCheck
import com.workoutmaker.app.data.wellnessCheckin

// Daily morning readiness notification, timed to the athlete's actual WAKE-UP:
// the worker starts at 06:00 and keeps retrying (30-min backoff) until last
// night's sleep session (Health Connect) shows the user is awake — falling
// back to a fixed time when there's no sleep data/permission. Shows the
// readiness score, the recovery one-liner, and today's planned session; nudges
// for the subjective check-in only while it's unanswered. The greeting adapts
// to the hour it actually fires. Costs nothing: daily-summary is deterministic
// (never calls the LLM brief here).
@HiltWorker
class CheckinReminderWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val repo: WorkoutRepository,
    private val health: HealthConnectManager,
    private val prefs: AppPreferences,
    private val location: LocationProvider,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        // Not signed in → nothing to say.
        if (repo.auth.currentUserOrNull() == null) return Result.success()
        // User turned the morning summary off in Settings.
        val wanted = runCatching { prefs.settings.first().morningNotify }.getOrDefault(true)
        if (!wanted) return Result.success()

        val today = LocalDate.now()
        val now = LocalTime.now()
        // Sleep-based timing: wait until last night's sleep session has ENDED
        // today (i.e. the user is up). Background reads can be restricted, so
        // any failure falls back to the fixed-time path.
        val sleepEnd = health.lastSleepEnd()
        val wokeToday = sleepEnd != null &&
            sleepEnd.atZone(ZoneId.systemDefault()).toLocalDate() == today

        val fireNow = when {
            wokeToday -> true
            // No wake recorded yet: still asleep, or the watch hasn't synced.
            // Retry every ~30 min until the 9:30 fallback.
            sleepEnd != null || health.isAvailable -> now >= LocalTime.of(9, 30)
            // No Health Connect at all: plain 7:30 reminder.
            else -> now >= LocalTime.of(7, 30)
        }
        if (!fireNow) return Result.retry()

        // Push last night's Health Connect data (HRV/RHR/sleep) BEFORE fetching
        // the summary, so readiness reflects this morning even if the app hasn't
        // been opened. After the fireNow gate so the 30-min retries don't re-sync.
        runCatching { repo.syncHealth() }

        // Check-in still pending? Then the notification also asks for it.
        val answered = runCatching {
            repo.wellnessCheckin(today.toString())?.energy != null
        }.getOrDefault(false)

        // Fresh summary if the network allows, else this morning's cache.
        val summary = runCatching { repo.dailySummary(today) }.getOrNull()
            ?: runCatching { repo.cachedDailySummary()?.first }.getOrNull()
                ?.takeIf { it.date == today.toString() }

        // Token-free (no LLM) weather viability check. Best-effort: a failed
        // call just means no weather line, never a broken reminder.
        val loc = location.lastKnown()
        val weather = runCatching { repo.weatherCheck(today, loc?.first, loc?.second) }.getOrNull()

        showReminder(summary, checkinPending = !answered, weather = weather)
        return Result.success()
    }

    private fun showReminder(
        summary: DailySummary?,
        checkinPending: Boolean,
        weather: WeatherCheckResult? = null,
    ) {
        if (ActivityCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return
        val launch = applicationContext.packageManager
            .getLaunchIntentForPackage(applicationContext.packageName)
            ?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (weather?.should_prompt == true) {
                    putExtra("open_weather_workout_id", weather.workout_id)
                    putExtra("open_weather_sport", weather.sport)
                    putExtra("open_weather_reason", weather.reason)
                    putExtra("open_weather_swap_type", weather.swap_type)
                }
            }
        val pi = launch?.let {
            PendingIntent.getActivity(
                applicationContext, 1, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        val greeting = Notifications.greeting()
        val readiness = summary?.readiness
        val title = if (readiness != null) {
            "$greeting. Readiness ${readiness.score}, ${readiness.band.lowercase()}."
        } else {
            "$greeting ☀️"
        }
        val weatherLine = if (weather?.should_prompt == true) {
            "Today's ${weather.sport} looks unsafe: ${weather.reason}. Tap to see options."
        } else null
        val recoveryLine = summary?.recovery?.summary?.takeIf { it.isNotBlank() }
            ?: summary?.recovery?.drivers?.firstOrNull()?.label
        val planLine = summary?.today_workout?.workout_json?.title
            ?.takeIf { it.isNotBlank() }?.let { "On the plan: $it." }
        val askLine = if (checkinPending) "Tap to log how you feel." else null
        val text = listOfNotNull(weatherLine, recoveryLine, planLine, askLine)
            .joinToString(" ")
            .ifBlank { "How do you feel today? Tap to log energy, soreness and sleep." }

        val n = NotificationCompat.Builder(applicationContext, Notifications.CH_REMINDERS)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(applicationContext).notify(1001, n)
    }
}

object CheckinReminderScheduler {
    fun schedule(context: Context) {
        // Start checking at the next 06:00 local; the worker retries itself
        // (30-min linear backoff) until the user is actually awake.
        val now = Calendar.getInstance()
        val target = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 6); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0)
            if (before(now)) add(Calendar.DAY_OF_MONTH, 1)
        }
        val initialDelay = target.timeInMillis - now.timeInMillis

        val request = PeriodicWorkRequestBuilder<CheckinReminderWorker>(1, TimeUnit.DAYS)
            .setInitialDelay(initialDelay, TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.MINUTES)
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "morning-checkin", ExistingPeriodicWorkPolicy.UPDATE, request,
        )
    }
}
