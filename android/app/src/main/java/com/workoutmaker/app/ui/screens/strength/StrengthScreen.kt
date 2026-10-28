package com.workoutmaker.app.ui.screens.strength

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.FitnessCenter
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.workoutmaker.app.strength.StrengthNav
import com.workoutmaker.app.strength.StrengthViewModel
import com.workoutmaker.app.strength.MuscleVolume
import com.workoutmaker.app.strength.StrengthProgram
import com.workoutmaker.app.strength.WeeklyReport
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.EmptyState
import com.workoutmaker.app.ui.components.GhostButton
import com.workoutmaker.app.ui.components.ScreenScaffold
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.SectionLabel
import com.workoutmaker.app.ui.theme.amberAccent
import androidx.compose.foundation.ExperimentalFoundationApi
import com.workoutmaker.app.data.PlannedWorkout
import com.workoutmaker.app.ui.components.fmtWeight
import com.workoutmaker.app.ui.screens.home.WorkoutDetail

internal fun fmtClock(totalSec: Long): String = com.workoutmaker.app.ui.components.fmtClock(totalSec)

internal fun trimKg(v: Double): String = fmtWeight(v)

@Composable
fun StrengthScreen(
    vm: StrengthViewModel = hiltViewModel(),
    onOpenHistory: () -> Unit = {},
    onOpenStats: (String) -> Unit = {},
    onOpenStatsPicker: () -> Unit = {},
) {
    val nav by vm.nav.collectAsStateSafe()
    val pendingPlanned by vm.pendingPlannedStart.collectAsStateSafe()
    val pendingEdit by vm.pendingEditStart.collectAsStateSafe()
    LaunchedEffect(Unit) { vm.loadHome() }
    when (nav) {
        is StrengthNav.Home -> StrengthHomeView(vm, onOpenHistory, onOpenStatsPicker)
        is StrengthNav.Active -> ActiveWorkoutView(vm, onOpenStats)
        is StrengthNav.Picker -> ExercisePickerView(vm)
        is StrengthNav.WorkoutDetail -> WorkoutDetailView(vm, onOpenStats)
        is StrengthNav.RateEffort -> RateEffortView(vm)
    }

    // Guard: an edit of a logged workout was requested while a session is in
    // progress — editing replaces the logger's contents.
    if (pendingEdit != null) {
        AlertDialog(
            onDismissRequest = { vm.keepCurrentSessionOverEdit() },
            confirmButton = {
                TextButton(onClick = { vm.confirmReplaceWithEdit() }) { Text("Discard & edit", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { vm.keepCurrentSessionOverEdit() }) { Text("Keep current") } },
            title = { Text("Unsaved session in progress") },
            text = {
                Text(
                    "You're in the middle of logging a workout. Open the logged session " +
                        "for editing instead? Your current, unsaved sets will be discarded.",
                )
            },
        )
    }

    // Guard: a planned session was requested while one is in progress.
    pendingPlanned?.let { req ->
        AlertDialog(
            onDismissRequest = { vm.keepCurrentSession() },
            confirmButton = {
                TextButton(onClick = { vm.confirmReplaceWithPlanned() }) { Text("Discard & load", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { vm.keepCurrentSession() }) { Text("Keep current") } },
            title = { Text("Unsaved session in progress") },
            text = {
                Text(
                    "You're in the middle of logging a workout. Load the planned session " +
                        "“${req.workout.title}” instead? Your current, unsaved sets will be discarded.",
                )
            },
        )
    }
}

// ---------------------------------------------------------------------------
// Home: start workout, routines, history, per-exercise stats entry
// ---------------------------------------------------------------------------
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun StrengthHomeView(
    vm: StrengthViewModel,
    onOpenHistory: () -> Unit = {},
    onOpenStatsPicker: () -> Unit = {},
) {
    val history by vm.history.collectAsStateSafe()
    val routines by vm.routines.collectAsStateSafe()
    val logged by vm.loggedExercises.collectAsStateSafe()
    val loading by vm.loading.collectAsStateSafe()
    val status by vm.status.collectAsStateSafe()
    val report by vm.weeklyReport.collectAsStateSafe()
    val prs by vm.lastPrs.collectAsStateSafe()
    val pendingSync by vm.pendingSync.collectAsStateSafe()
    val editingRoutine by vm.editingRoutine.collectAsStateSafe()
    val todayPlanned by vm.todayPlanned.collectAsStateSafe()

    if (prs.isNotEmpty()) {
        val haptics = LocalHapticFeedback.current
        LaunchedEffect(prs) { haptics.performHapticFeedback(HapticFeedbackType.LongPress) }
        PrCelebrationDialog(prs) { vm.dismissPrs() }
    }
    editingRoutine?.let { r ->
        RoutineEditorDialog(
            routine = r,
            onSave = { name, items -> vm.saveEditedRoutine(name, items) },
            onCancel = { vm.cancelEditRoutine() },
        )
    }

    ScreenScaffold(
        title = "Strength",
        subtitle = "${history.size} workouts logged",
        eyebrow = "STRENGTH LOG",
        actions = {
            IconButton(onClick = onOpenStatsPicker, enabled = logged.isNotEmpty()) {
                Icon(Icons.Filled.BarChart, contentDescription = "Exercise stats")
            }
            IconButton(onClick = onOpenHistory) {
                Icon(Icons.Filled.History, contentDescription = "Workout history")
            }
        },
        isRefreshing = loading,
        onRefresh = { vm.loadHome() },
    ) { modifier ->
        status?.let { Text(it, modifier, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary) }
        if (pendingSync > 0) {
            Text("⟳ $pendingSync change${if (pendingSync > 1) "s" else ""} saved offline, will sync when you're back online.",
                modifier, style = MaterialTheme.typography.bodySmall, color = amberAccent())
        }

        // Deload banner (B2)
        report?.deload?.takeIf { it.recommended }?.let { DeloadBanner(modifier, it.reason) }

        // Today's planned strength session(s) from the calendar — the plan is
        // the headline of this tab when one exists.
        todayPlanned.forEach { pw ->
            val undoing by vm.undoingPlanned.collectAsStateSafe()
            TodayPlannedCard(
                modifier, pw,
                onStart = { vm.startPlannedFromHome(pw) },
                onMarkUndone = { vm.markPlannedUndone(pw.id) },
                undoEnabled = undoing == null,
            )
        }

        // Start actions: AI generate is the primary path; empty/repeat are the
        // secondary "skip the AI" shortcuts.
        Button(
            onClick = { vm.generateAiLift() },
            enabled = !loading,
            modifier = modifier.height(52.dp),
            shape = RoundedCornerShape(12.dp),
        ) { Icon(Icons.Filled.AutoAwesome, null); Text("  Generate today's lift with AI") }
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GhostButton(onClick = { vm.startEmpty() }, modifier = Modifier.weight(1f).height(48.dp)) {
                Icon(Icons.Filled.Add, null); Text("  Empty")
            }
            GhostButton(onClick = { vm.startFromLastWorkout() }, modifier = Modifier.weight(1f).height(48.dp)) {
                Icon(Icons.Filled.Refresh, null); Text("  Repeat")
            }
        }

        // Weekly volume + balance (B5)
        report?.let { WeeklyVolumeCard(modifier, it) }

        SectionLabel("Or run your own plan", modifier)

        SectionCard(modifier, title = "Routines") {
            Text(
                "A reusable template for a single session, your exercises pre-loaded so you can start a workout in one tap (e.g. “Push Day”).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (routines.isEmpty()) {
                EmptyState(
                    title = "No routines yet",
                    subtitle = "Start a workout and “Save as routine”, or pick a program below.",
                    icon = Icons.Filled.FitnessCenter,
                )
            }
            if (routines.isNotEmpty()) {
                Text(
                    "Tip: long-press a routine to edit its name and exercises.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            routines.forEach { r ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .combinedClickable(
                            onClick = { vm.startFromRoutine(r) },
                            onLongClick = { vm.beginEditRoutine(r) },
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(r.routine.name, style = MaterialTheme.typography.titleSmall)
                        Text(r.items.joinToString(", ") { it.exerciseName }.ifBlank { "No exercises yet" },
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1)
                    }
                    TextButton(onClick = { vm.startFromRoutine(r) }) { Text("Start") }
                    IconButton(onClick = { vm.beginEditRoutine(r) }) {
                        Icon(Icons.Filled.Edit, "Edit routine")
                    }
                    IconButton(onClick = { vm.deleteRoutine(r.routine.id) }) {
                        Icon(Icons.Filled.Delete, "Delete routine")
                    }
                }
            }
        }

        // Program builder (B4)
        ProgramsCard(modifier, vm.programs) { vm.createProgram(it) }
    }
}

// Today's planned strength session from the calendar, with a one-tap start
// into the logger (same handoff the Calendar's "Log this session" uses).
@Composable
internal fun TodayPlannedCard(
    modifier: Modifier,
    pw: PlannedWorkout,
    onStart: () -> Unit,
    onMarkUndone: () -> Unit,
    undoEnabled: Boolean = true,
) {
    SectionCard(modifier, title = "Today's plan") {
        WorkoutDetail(pw.workout_json)
        if (pw.completed) {
            Text("✓ Completed", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            TextButton(onClick = onMarkUndone, enabled = undoEnabled) { Text("Mark as not done") }
        } else {
            Button(
                onClick = onStart,
                modifier = Modifier.fillMaxWidth().height(48.dp),
                shape = RoundedCornerShape(12.dp),
            ) {
                Icon(Icons.Filled.PlayArrow, null)
                Text("  Start this session")
            }
        }
    }
}

@Composable
internal fun DeloadBanner(modifier: Modifier, reason: String) {
    Box(modifier.background(amberAccent().copy(alpha = 0.18f), RoundedCornerShape(14.dp)).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("⚠️", Modifier.padding(end = 10.dp))
            Column {
                Text("Deload suggested", style = MaterialTheme.typography.titleSmall, color = amberAccent(), fontWeight = FontWeight.Bold)
                Text(reason, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
internal fun WeeklyVolumeCard(modifier: Modifier, report: WeeklyReport) {
    SectionCard(modifier, title = "This week's volume") {
        Text("${report.totalHardSets} hard sets · target 10-20 per muscle",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (report.muscleVolume.isEmpty()) {
            Text("Log a session to see per-muscle volume.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        report.muscleVolume.forEach { mv -> VolumeBar(mv) }
        report.balance.forEach { w ->
            Text("• ${w.text}", style = MaterialTheme.typography.bodySmall, color = amberAccent())
        }
    }
}

@Composable
internal fun VolumeBar(mv: MuscleVolume) {
    val color = when (mv.status) { "under" -> amberAccent(); "over" -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.primary }
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(mv.muscle, Modifier.width(86.dp), style = MaterialTheme.typography.bodySmall)
        Box(
            Modifier.weight(1f).height(10.dp)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(5.dp)),
        ) {
            Box(
                Modifier.fillMaxWidth((mv.sets / 20f).coerceIn(0.04f, 1f)).height(10.dp)
                    .background(color, RoundedCornerShape(5.dp)),
            )
        }
        Text("  ${mv.sets}", Modifier.width(32.dp), style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.End, color = color)
    }
}

@Composable
internal fun ProgramsCard(modifier: Modifier, programs: List<StrengthProgram>, onAdd: (StrengthProgram) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    SectionCard(modifier, title = "Programs") {
        Text(
            "A multi-week training plan (e.g. a 3-day full-body block). Adding one creates a routine for " +
                "each training day, and auto-progression bumps the loads week to week, so a program is " +
                "really a set of routines that work together over time.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!expanded) {
            TextButton(onClick = { expanded = true }) { Text("Browse ${programs.size} programs") }
        } else {
            programs.forEach { p ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(p.name, style = MaterialTheme.typography.titleSmall)
                        Text(p.schedule, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        Text(p.description, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = { onAdd(p) }) { Text("Add") }
                }
            }
        }
    }
}

internal fun prEmoji(type: String): String = when (type) {
    "session_volume" -> "🏆"
    "volume" -> "💪"
    "weight" -> "🏋️"
    "e1rm" -> "📈"
    "rep" -> "🔁"
    else -> "⭐"
}
