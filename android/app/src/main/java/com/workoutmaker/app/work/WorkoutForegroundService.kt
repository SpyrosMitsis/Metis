package com.workoutmaker.app.work

import com.workoutmaker.app.util.runCatching

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.workoutmaker.app.notify.Notifications

/**
 * Keeps the process alive — and shows a live timer in the status bar — while a
 * strength workout is in progress, like a dedicated watch app. Without it the
 * system can kill a backgrounded/swiped-away app and the session only comes back
 * on next launch (via the saved-session restore). With it, the workout truly
 * keeps running: the ongoing notification carries a chronometer of the elapsed
 * time and tapping it returns to the logger.
 */
class WorkoutForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val name = intent?.getStringExtra(EXTRA_NAME)?.takeIf { it.isNotBlank() } ?: "Workout"
        val startedAt = intent?.getLongExtra(EXTRA_STARTED_AT, System.currentTimeMillis())
            ?: System.currentTimeMillis()
        startForegroundCompat(buildNotification(name, startedAt))
        // STICKY so the system re-creates the service (and notification) if it
        // ever reclaims it under memory pressure mid-workout.
        return START_STICKY
    }

    private fun buildNotification(name: String, startedAt: Long): Notification {
        Notifications.ensureChannels(this)
        val launch = packageManager.getLaunchIntentForPackage(packageName)
            ?.apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        val pi = launch?.let {
            PendingIntent.getActivity(
                this, 2, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        return NotificationCompat.Builder(this, Notifications.CH_WORKOUT)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(name)
            .setContentText("Workout in progress")
            .setUsesChronometer(true) // status bar shows the live elapsed time
            .setWhen(startedAt)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun startForegroundCompat(n: Notification) {
        // specialUse, not health: this service never reads a health sensor, it
        // only shows a chronometer notification — health type requires a Health
        // Connect/activity-recognition runtime permission to already be granted
        // just to start, which crashed on fresh installs with none granted yet.
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    companion object {
        private const val NOTIF_ID = 3001
        private const val ACTION_STOP = "com.workoutmaker.app.STOP_WORKOUT_FGS"
        private const val EXTRA_NAME = "name"
        private const val EXTRA_STARTED_AT = "started_at"

        /** Start (or refresh) the ongoing workout notification. Safe to call
         *  repeatedly — the system delivers a fresh onStartCommand each time. */
        fun start(ctx: Context, name: String, startedAt: Long) {
            val i = Intent(ctx, WorkoutForegroundService::class.java).apply {
                putExtra(EXTRA_NAME, name)
                putExtra(EXTRA_STARTED_AT, startedAt)
            }
            runCatching { ContextCompat.startForegroundService(ctx, i) }
        }

        fun stop(ctx: Context) {
            runCatching { ctx.stopService(Intent(ctx, WorkoutForegroundService::class.java)) }
        }
    }
}
