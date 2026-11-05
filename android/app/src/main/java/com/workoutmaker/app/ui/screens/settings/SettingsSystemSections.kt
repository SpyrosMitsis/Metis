package com.workoutmaker.app.ui.screens.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.EventAvailable
import androidx.compose.material.icons.outlined.Favorite
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.ScreenLockPortrait
import androidx.compose.material.icons.outlined.Timer
import androidx.compose.material.icons.outlined.Vibration
import androidx.compose.material.icons.outlined.WbTwilight
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material3.TextButton
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import com.workoutmaker.app.ui.components.GhostButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.workoutmaker.app.ui.components.StatTileGrid
import com.workoutmaker.app.ui.components.SectionLabel
import androidx.compose.foundation.clickable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.data.format
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.SectionCard
import kotlinx.coroutines.launch
import android.content.Intent
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import com.workoutmaker.app.data.GenerationLogRow
import com.workoutmaker.app.data.RestChime
import com.workoutmaker.app.notify.playRestOverSound
import com.workoutmaker.app.strength.ImportSummary
import com.workoutmaker.app.ui.components.EmptyState
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import com.workoutmaker.app.data.connectIntervals
import com.workoutmaker.app.data.syncHealth

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConnectionsSection(vm: SettingsViewModel) {
    val intervalsStatus by vm.intervalsStatus.collectAsStateSafe()
    val intervalsSaved by vm.intervalsSaved.collectAsStateSafe()
    val healthStatus by vm.healthStatus.collectAsStateSafe()
    val busy by vm.busy.collectAsStateSafe()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    // Sync runs with whatever was granted — a partial grant (e.g. no steps) is
    // still useful; only a fully-empty grant is a real denial.
    val healthPermLauncher = rememberLauncherForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted ->
        if (granted.intersect(vm.healthPermissions).isNotEmpty()) vm.syncHealth()
        else vm.setHealthStatus(
            "Permission denied. Android stops asking after two denials. Use “Open Health Connect” below " +
                "and grant Metis access under App permissions.",
        )
    }
    val connected = intervalsSaved != null || intervalsStatus?.startsWith("✓") == true

    LinkCard(
        icon = Icons.Outlined.Link,
        title = "Intervals.icu",
        status = intervalsSaved?.let { "Linked as athlete ${it.first}" } ?: "Not connected",
        connected = connected,
        body = if (connected) {
            "Sends structured workouts to your watch and pulls your history back every 30 minutes."
        } else {
            "Without it I never see what you actually did, only what I asked for."
        },
    ) {
        intervalsSaved?.let { (athlete, hint) ->
            Text(
                "Athlete $athlete · API key ${hint ?: "••••••••"}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
            )
            // Sync uses the saved credentials server-side — no need to re-enter
            // the key/id. (Also runs automatically every 30 min via the backend.)
            Button(
                onClick = { vm.syncIntervalsNow() },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Syncing…" else "Sync now") }
        }
        Text("Find the athlete ID and API key in Intervals.icu → Settings → Developer.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        var athleteId by remember { mutableStateOf("") }
        var apiKey by remember { mutableStateOf("") }
        OutlinedTextField(
            athleteId, { athleteId = it },
            label = { Text(if (intervalsSaved != null) "Athlete ID (replace)" else "Athlete ID (e.g. i123456)") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            apiKey, { apiKey = it },
            label = { Text(if (intervalsSaved != null) "API key (replace)" else "API key") },
            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { vm.connectIntervals(athleteId.trim(), apiKey.trim()) }, enabled = !busy && athleteId.isNotBlank() && apiKey.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Verify & connect") }
        intervalsStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
    LinkCard(
        icon = Icons.Outlined.Favorite,
        title = "Health Connect",
        status = if (vm.healthAvailable) "Available on this phone" else "Not available",
        connected = healthStatus?.startsWith("✓") == true,
        body = "Without sleep and HRV, your readiness score is a guess from training load alone. " +
            "Pulls from Zepp/Amazfit, Google Fit, Fitbit and the rest.",
    ) {
        Button(
            onClick = {
                if (!vm.healthAvailable) vm.setHealthStatus("Health Connect isn't available. Install/update it from the Play Store.")
                else scope.launch {
                    if (vm.grantedHealthPerms().isNotEmpty()) vm.syncHealth()
                    else healthPermLauncher.launch(vm.healthPermissions)
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Sync wellness from Health Connect") }
        // Recovery path when the in-app dialog can no longer appear (Android
        // auto-denies after two refusals): grant directly in Health Connect.
        GhostButton(
            onClick = {
                runCatching {
                    context.startActivity(
                        Intent(
                            HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS,
                        ),
                    )
                }.onFailure { vm.setHealthStatus("Couldn't open Health Connect, open it from your app drawer instead.") }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Open Health Connect (manage permissions)") }
        healthStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
    SectionCard {
        Text("Your calendar", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        val s by vm.appSettings.collectAsStateSafe()
        val calendarStatus by vm.calendarStatus.collectAsStateSafe()
        val readPermLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) vm.setCalendarRead(true)
            else vm.setCalendarStatus("Permission denied. Grant calendar access in system settings to use this.")
        }
        val writePermLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) vm.setCalendarWrite(true)
            else vm.setCalendarStatus("Permission denied. Grant calendar access in system settings to use this.")
        }
        Text(
            "Connects training to real life. Works with any calendar synced to this phone (Google, Outlook…). " +
                "For planning, only busy TIMES are used; event titles never leave your phone.",
            style = MaterialTheme.typography.bodySmall,
        )
        IconToggleRow(
            Icons.Outlined.CalendarMonth,
            "Plan around busy times",
            "Titles never leave the phone",
            s.calendarRead,
        ) { on ->
            when {
                !on -> vm.setCalendarRead(false)
                vm.calendarReadGranted() -> vm.setCalendarRead(true)
                else -> readPermLauncher.launch(android.Manifest.permission.READ_CALENDAR)
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHigh)
        IconToggleRow(
            Icons.Outlined.EventAvailable,
            "Show workouts there",
            "All-day entries, no reminders",
            s.calendarWrite,
        ) { on ->
            when {
                !on -> vm.setCalendarWrite(false)
                vm.calendarWriteGranted() -> vm.setCalendarWrite(true)
                else -> writePermLauncher.launch(android.Manifest.permission.WRITE_CALENDAR)
            }
        }
        calendarStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun NotificationsSection(vm: SettingsViewModel) {
    val s by vm.appSettings.collectAsStateSafe()
    val context = LocalContext.current
    SectionCard {
        IconToggleRow(Icons.Outlined.WbTwilight, "Morning readiness", "At wake-up, your score and today's plan", s.morningNotify) { vm.setMorningNotify(it) }
        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHigh)
        IconToggleRow(Icons.Outlined.Timer, "Rest is over", "Works with the app in the background", s.restNotify) { vm.setRestNotify(it) }
        HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHigh)
        IconToggleRow(Icons.Outlined.Vibration, "Buzz too", "When the rest timer finishes", s.restVibrate) { vm.setRestVibrate(it) }
    }
    SectionCard {
        Text("Sound, tap to hear it", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            RestChime.entries.forEach { c ->
                FilterChip(
                    selected = s.restChime == c,
                    onClick = {
                        vm.setRestChime(c)
                        // Preview the pick right away so choosing doesn't need a live timer.
                        playRestOverSound(context, c)
                    },
                    label = { Text(c.label) },
                )
            }
        }
        Text(
            "Media volume, so it cuts through music and plays on silent. Background alerts use the system notification sound.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
internal fun DiagnosticsSection(vm: SettingsViewModel) {
    val logs by vm.logs.collectAsStateSafe()
    if (logs.isEmpty()) {
        SectionCard {
            EmptyState(
                title = "No AI generations yet",
                subtitle = "Generate a workout or plan and it'll be logged here.",
                icon = Icons.Filled.AutoAwesome,
            )
        }
        return
    }
    // Local-date based windows (the app's "today" is the client's local date).
    val today = LocalDate.now()
    fun daysAgo(l: GenerationLogRow): Long = runCatching {
        ChronoUnit.DAYS.between(LocalDate.parse(l.created_at?.take(10)), today)
    }.getOrDefault(99999L)
    fun money(v: Double) = "$${"%.3f".format(v)}"
    val within30 = logs.filter { daysAgo(it) <= 29 }
    val spentToday = logs.filter { daysAgo(it) <= 0 }.sumOf { it.estimated_cost_usd ?: 0.0 }
    val spent7 = logs.filter { daysAgo(it) <= 6 }.sumOf { it.estimated_cost_usd ?: 0.0 }
    val spent30 = within30.sumOf { it.estimated_cost_usd ?: 0.0 }
    val fails = within30.count { !it.parsed_ok }
    val byProvider = within30.groupBy { it.provider ?: "?" }
        .mapValues { e -> e.value.sumOf { it.estimated_cost_usd ?: 0.0 } }
        .entries.sortedByDescending { it.value }
    val byFeature = within30.groupBy { it.feature ?: "?" }
        .mapValues { e -> e.value.sumOf { it.estimated_cost_usd ?: 0.0 } }
        .entries.sortedByDescending { it.value }

    val appSettings by vm.appSettings.collectAsStateSafe()
    val cap = appSettings.spendCapUsd

    SectionCard {
        // The 30-day total as the hero, because that is the number anyone opening
        // this screen came to see. The windows beside it give it a shape.
        Text(money(spent30), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
        Text(
            "Last 30 days · ${within30.size} generations · " +
                (if (fails > 0) "$fails failed" else "all succeeded"),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        StatTileGrid(
            listOf(
                "Today" to money(spentToday),
                "7 days" to money(spent7),
                "Cap" to (if (cap > 0) money(cap) else "off"),
            ),
        )

        // Soft monthly cap: a warning banner only — never blocks generation.
        if (cap > 0 && spent30 >= cap) {
            Text(
                "⚠ Over your ${money(cap)}/month cap, 30-day spend is ${money(spent30)}. " +
                    "Consider a cheaper provider or turning off the daily briefing.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        var capText by remember(cap) { mutableStateOf(if (cap > 0) cap.toString() else "") }
        OutlinedTextField(
            value = capText,
            onValueChange = { capText = it.filter { c -> c.isDigit() || c == '.' } },
            label = { Text("Monthly spend cap (USD, 0 = off)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            trailingIcon = {
                TextButton(onClick = { vm.setSpendCap(capText.toDoubleOrNull() ?: 0.0) }) { Text("Set") }
            },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
    }
    // Where it went, as a readable column rather than one run-on line. Sorted by
    // cost, so the thing worth turning off is always at the top.
    if (byFeature.isNotEmpty()) {
        SectionCard {
            SectionLabel("Where it went")
            byFeature.forEach { BreakdownRow(it.key, money(it.value)) }
            if (byProvider.isNotEmpty()) {
                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHigh)
                byProvider.forEach { BreakdownRow(it.key, money(it.value)) }
            }
        }
    }
    SectionCard {
        SectionLabel("Latest calls")
        logs.take(12).forEach { l ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (l.parsed_ok) Icons.Filled.CheckCircle else Icons.Filled.Error,
                    contentDescription = null,
                    tint = if (l.parsed_ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(end = 10.dp).size(18.dp),
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        l.feature ?: "?",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "${l.created_at?.take(16)?.replace('T', ' ') ?: ""} · ${l.provider ?: "?"}" +
                            (if (!l.parsed_ok && l.error != null) " · ${l.error.take(40)}" else ""),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    if (l.parsed_ok) money(l.estimated_cost_usd ?: 0.0) else "-",
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@Composable
internal fun DataSection(vm: SettingsViewModel) {
    val importStatus by vm.importStatus.collectAsStateSafe()
    val importBusy by vm.importBusy.collectAsStateSafe()
    val result by vm.importResult.collectAsStateSafe()
    val context = LocalContext.current
    val importLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) {
            Log.i("IMPORT", "picker returned null (no file selected)")
            vm.importResult.value = ImportSummary(
                ok = false, error = "No file was selected.")
        } else {
            val read = runCatching {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() }
            }
            val text = read.getOrNull()
            Log.i("IMPORT", "picked uri=$uri readOk=${read.isSuccess} len=${text?.length ?: -1} err=${read.exceptionOrNull()?.message}")
            if (text.isNullOrBlank()) {
                vm.importResult.value = ImportSummary(
                    ok = false, error = "Couldn't read that file (${read.exceptionOrNull()?.message ?: "empty"}). " +
                        "Pick the .csv exported from Strong or Hevy.")
            } else vm.importCsv(text)
        }
    }
    result?.let { ImportResultDialog(it) { vm.dismissImportResult() } }
    LinkCard(
        icon = Icons.Outlined.UploadFile,
        title = "Bring history in",
        status = "A CSV from Strong or Hevy",
        connected = false,
        body = "Units and set types are detected for you, and importing the same file twice changes nothing.",
    ) {
        Button(
            // Broadest filter: some file pickers (notably Samsung's) grey out CSVs
            // when given several specific MIME types. "*/*" reliably shows them.
            onClick = { importLauncher.launch(arrayOf("*/*")) },
            enabled = !importBusy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (importBusy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp), strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary)
                Text("  Importing…")
            } else Text("Choose a file")
        }
        importStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }

    ExportCard(vm)
}

@Composable
internal fun ExportCard(vm: SettingsViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<String?>(null) }
    val exportLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/csv"),
    ) { uri ->
        if (uri == null) { status = "Export cancelled." } else scope.launch {
            status = "Exporting…"
            val ok = runCatching {
                val csv = vm.buildExportCsv()
                context.contentResolver.openOutputStream(uri)?.use { it.write(csv.toByteArray()) }
                csv.count { it == '\n' } - 1
            }
            status = ok.fold({ "✓ Exported $it sets to CSV." }, { "Export failed: ${com.workoutmaker.app.util.reportFailure(it)}" })
        }
    }
    LinkCard(
        icon = Icons.Outlined.Download,
        title = "Take it with you",
        status = "Strong-compatible CSV",
        connected = false,
        body = "Your entire strength history, re-importable here or openable anywhere.",
    ) {
        OutlinedButton(
            onClick = { exportLauncher.launch("workout-maker-strength-${java.time.LocalDate.now()}.csv") },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Export strength CSV") }
        status?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
}

@Composable
internal fun DebugLogSection(vm: SettingsViewModel) {
    val s by vm.appSettings.collectAsStateSafe()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var exportStatus by remember { mutableStateOf<String?>(null) }
    val exportLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/plain"),
    ) { uri ->
        if (uri == null) { exportStatus = "Export cancelled." } else scope.launch {
            exportStatus = "Exporting…"
            val ok = runCatching {
                val text = com.workoutmaker.app.util.AppLog.file()?.takeIf { it.exists() }?.readText().orEmpty()
                context.contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }
            }
            exportStatus = ok.fold({ "✓ Log exported." }, { "Export failed: ${com.workoutmaker.app.util.reportFailure(it)}" })
        }
    }
    SectionCard {
        SectionLabel("Debug logs")
        Text(
            "The app keeps a rolling log on your phone for troubleshooting. It never " +
                "leaves the device unless you turn this on.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 4.dp),
        )
        IconToggleRow(
            Icons.Outlined.BugReport,
            "Send debug logs to developer",
            "Lets the developer see what went wrong",
            s.debugLogSharingEnabled,
        ) { vm.setDebugLogSharing(it) }
    }
    SectionCard {
        OutlinedButton(
            onClick = { exportLauncher.launch("workout-maker-debug-log-${java.time.LocalDate.now()}.txt") },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Export log to file") }
        exportStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
    }
}

@Composable
internal fun AccountSection(vm: SettingsViewModel) {
    val deleteState = vm.deleteAccountState.collectAsStateSafe().value
    val confirmDelete = remember { mutableStateOf(false) }
    SectionCard {
        Row(
            Modifier.fillMaxWidth().clickable { vm.signOut() },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.AutoMirrored.Outlined.Logout,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(end = 14.dp).size(22.dp),
            )
            Text(
                "Sign out",
                Modifier.weight(1f),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.outline,
            )
        }
    }
    // The irreversible one gets its own card and spells out the consequence
    // before the button, not after it.
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Outlined.DeleteForever,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(end = 14.dp).size(22.dp),
            )
            Text(
                "Delete everything",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Text(
            "Profile, workouts, strength logs, coach conversations and stored keys. " +
                "There is no undo, and anything already in Intervals.icu stays there.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = { confirmDelete.value = true }, modifier = Modifier.fillMaxWidth()) {
            Text("Delete my account", color = MaterialTheme.colorScheme.error)
        }
        if (deleteState != null && deleteState.isNotEmpty()) {
            Text(deleteState, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
    if (confirmDelete.value) {
        AlertDialog(
            onDismissRequest = { confirmDelete.value = false },
            title = { Text("Delete account?") },
            text = {
                Text(
                    "This permanently deletes your account and everything in it, profile, " +
                        "workouts, strength logs, coach conversations, and stored API keys. " +
                        "There is no undo. Data already pushed to Intervals.icu stays there.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { confirmDelete.value = false; vm.deleteAccount() },
                    enabled = deleteState?.isEmpty() != true,
                ) { Text("Delete everything", color = MaterialTheme.colorScheme.onErrorContainer) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete.value = false }) { Text("Cancel") }
            },
        )
    }
}
