package com.workoutmaker.app.ui.screens.onboarding

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Timer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.workoutmaker.app.ui.components.GhostButton
import com.workoutmaker.app.ui.components.SectionCard
import android.app.AlarmManager
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * Onboarding's permissions step. Every OS permission this app can ever ask for,
 * in one place: what it buys, what breaks without it, and whether it's actually
 * load-bearing — instead of system dialogs ambushing the user later from five
 * different screens with no explanation attached.
 *
 * Honest framing, deliberately: none of these are required to sign in, plan a
 * week or log a session, so the badge says NEEDED only where the feature it
 * powers is dead without it (the rest timer can't alert you with notifications
 * off), and OPTIONAL everywhere else. All of them stay re-askable in Settings.
 */
@Composable
internal fun StepPermissions(vm: OnboardingViewModel) {
    val context = LocalContext.current

    // Grants happen outside Compose (system dialogs, Settings screens), so the
    // cards re-read their state on every resume and after each launcher result.
    var refresh by remember { mutableIntStateOf(0) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refresh++
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    val notifLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { refresh++ }
    val healthLauncher = rememberLauncherForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { refresh++ }
    val calReadLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) vm.setCalendarRead(true); refresh++ }
    val calWriteLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) vm.setCalendarWrite(true); refresh++ }
    val locLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { refresh++ }

    fun granted(perm: String) = ContextCompat.checkSelfPermission(context, perm) ==
        PackageManager.PERMISSION_GRANTED

    val notifGranted = remember(refresh) {
        Build.VERSION.SDK_INT < 33 || granted(android.Manifest.permission.POST_NOTIFICATIONS)
    }
    val locGranted = remember(refresh) { granted(android.Manifest.permission.ACCESS_COARSE_LOCATION) }
    val calRead = remember(refresh) { vm.calendarReadGranted() }
    val calWrite = remember(refresh) { vm.calendarWriteGranted() }
    val exactGranted = remember(refresh) {
        if (Build.VERSION.SDK_INT < 31) true
        else context.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms() ?: false
    }
    // Health Connect answers asynchronously; treat "unknown" as not-granted so
    // the card never claims a grant it hasn't confirmed.
    val healthGranted by produceState(initialValue = false, refresh) {
        value = vm.healthAvailable && vm.grantedHealthPerms().isNotEmpty()
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            "None of these are required to use the app, and nothing is asked for silently. " +
                "Each one unlocks a specific feature, and you can change any of them later in " +
                "Settings or from your phone's app settings.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        PermissionCard(
            icon = Icons.Outlined.Notifications,
            title = "Notifications",
            needed = true,
            why = "Rest-timer alerts between sets, the live timer while a workout is running, " +
                "and your morning check-in and evening feedback nudges.",
            without = "The rest timer can't tell you when to start your next set, and reminders never appear.",
            granted = notifGranted,
        ) {
            GhostButton(
                onClick = { if (android.os.Build.VERSION.SDK_INT >= 33) notifLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Allow notifications") }
        }

        PermissionCard(
            icon = Icons.Outlined.Timer,
            title = "Exact alarms",
            needed = false,
            why = "Fires the rest timer at the exact second it's due, even with the screen off " +
                "and the app in the background.",
            without = "The timer still works, it just drifts a little when Android batches it.",
            granted = exactGranted,
        ) {
            GhostButton(
                onClick = {
                    if (android.os.Build.VERSION.SDK_INT >= 31) runCatching {
                        context.startActivity(
                            Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM),
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Open alarm settings") }
        }

        PermissionCard(
            icon = Icons.Outlined.MonitorHeart,
            title = "Health Connect",
            needed = false,
            why = "Reads HRV, resting heart rate, sleep, steps and body composition that your watch " +
                "or scale already writes to your phone, so your daily readiness score is real data " +
                "instead of a guess.",
            without = "Readiness falls back to how you say you feel, and body trends stay empty.",
            granted = healthGranted,
        ) {
            if (!vm.healthAvailable) {
                Text(
                    "Health Connect isn't installed on this phone. Install it from the Play Store, " +
                        "then come back to this screen.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                GhostButton(
                    onClick = { healthLauncher.launch(vm.healthPermissions) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Choose what to share") }
            }
        }

        PermissionCard(
            icon = Icons.Outlined.CalendarMonth,
            title = "Calendar",
            needed = false,
            why = "Reading busy times lets the planner put long or hard sessions on days you're " +
                "actually free. Writing adds your planned sessions as all-day entries. " +
                "Only busy TIMES are read; event titles never leave your phone.",
            without = "The plan is built from your weekly availability alone, and workouts stay in the app.",
            granted = if (calRead && calWrite) true else null,
        ) {
            GhostButton(
                onClick = {
                    if (calRead) vm.setCalendarRead(true)
                    else calReadLauncher.launch(android.Manifest.permission.READ_CALENDAR)
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (calRead) "✓ Reading busy times" else "Plan around my calendar") }
            GhostButton(
                onClick = {
                    if (calWrite) vm.setCalendarWrite(true)
                    else calWriteLauncher.launch(android.Manifest.permission.WRITE_CALENDAR)
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (calWrite) "✓ Writing workouts" else "Show workouts in my calendar") }
        }

        PermissionCard(
            icon = Icons.Outlined.Place,
            title = "Approximate location",
            needed = false,
            why = "Looks up today's weather for your area so an outdoor session accounts for heat, " +
                "rain and wind. Coarse only, so it's your rough area, never a precise position.",
            without = "Outdoor workouts are planned as if the weather is neutral.",
            granted = locGranted,
        ) {
            GhostButton(
                onClick = { locLauncher.launch(android.Manifest.permission.ACCESS_COARSE_LOCATION) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Allow location") }
        }

        Text(
            "Denied something by mistake? Android stops asking after two refusals, but you can " +
                "always grant it from your phone's Settings under Apps → Metis → Permissions.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * One permission, explained. [granted] drives the whole card: true collapses the
 * actions away (nothing left to ask for), false shows them, and null means
 * "partly granted" — the calendar's two halves are independent, so its actions
 * stay visible with their own per-half state.
 */
@Composable
private fun PermissionCard(
    icon: ImageVector,
    title: String,
    needed: Boolean,
    why: String,
    without: String,
    granted: Boolean?,
    actions: @Composable () -> Unit,
) {
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(
                icon, null,
                modifier = Modifier.size(20.dp),
                tint = if (granted == true) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            PermBadge(needed)
        }
        Text(why, style = MaterialTheme.typography.bodySmall)
        Text(
            if (granted == true) "Granted, this is working." else "Without it: $without",
            style = MaterialTheme.typography.bodySmall,
            color = if (granted == true) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (granted != true) actions()
    }
}

/** NEEDED vs OPTIONAL, theme-mapped so it reads on light paper too. */
@Composable
private fun PermBadge(needed: Boolean) {
    val bg = if (needed) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
    else MaterialTheme.colorScheme.surfaceContainerHigh
    val fg = if (needed) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
    Box(
        Modifier
            .background(bg, RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(
            if (needed) "NEEDED" else "OPTIONAL",
            style = MaterialTheme.typography.labelSmall,
            color = fg,
            letterSpacing = 1.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}
