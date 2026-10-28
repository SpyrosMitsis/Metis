package com.workoutmaker.app.ui.screens.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.EditCalendar
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.WorkoutChoice
import com.workoutmaker.app.data.workoutChoiceRequest
import java.time.LocalDate
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.text.input.KeyboardType
import com.workoutmaker.app.data.Workout
import com.workoutmaker.app.data.WorkoutExercise
import com.workoutmaker.app.data.WorkoutSection
import java.time.Instant
import java.time.ZoneOffset

@Composable
internal fun LogActivityDialog(
    date: LocalDate,
    onDismiss: () -> Unit,
    onConfirm: (type: String, durationMin: Int, distanceKm: Double?, rpe: Int?) -> Unit,
) {
    var type by remember { mutableStateOf("Run") }
    var duration by remember { mutableStateOf("45") }
    var distance by remember { mutableStateOf("") }
    var rpe by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = { onConfirm(type, duration.toIntOrNull() ?: 0, distance.toDoubleOrNull(), rpe.toIntOrNull()) },
                enabled = (duration.toIntOrNull() ?: 0) > 0,
            ) { Text("Log") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("Log a session · $date") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("Run", "WeightTraining", "Other").forEach { t ->
                        FilterChip(
                            selected = type == t, onClick = { type = t },
                            label = { Text(if (t == "WeightTraining") "Strength" else t) },
                        )
                    }
                }
                OutlinedTextField(duration, { duration = it }, label = { Text("Duration (min)") })
                OutlinedTextField(distance, { distance = it }, label = { Text("Distance km (optional)") })
                OutlinedTextField(rpe, { rpe = it }, label = { Text("RPE 1-10 (optional)") })
            }
        },
    )
}

// #3 — ask the AI for a fixed, locked-in session on a specific day from a
// free-text request. The result is locked so the weekly re-planner works around
// it rather than replacing it.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RequestSessionDialog(date: LocalDate, onDismiss: () -> Unit, onSubmit: (LocalDate, String, String) -> Unit) {
    var day by remember { mutableStateOf(date) }
    var text by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("auto") }
    var focus by remember { mutableStateOf("") }
    var showPicker by remember { mutableStateOf(false) }

    if (showPicker) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = { TextButton(onClick = {
                state.selectedDateMillis?.let { day = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }
                showPicker = false
            }) { Text("Set date") } },
            dismissButton = { TextButton(onClick = { showPicker = false }) { Text("Cancel") } },
        ) { DatePicker(state = state) }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(enabled = text.isNotBlank() || type != "auto", onClick = { onSubmit(day, workoutChoiceRequest(type, focus, text), type) }) { Text("Create & lock") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("AI session for a day") },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { showPicker = true }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.EditCalendar, null); Text("  $day")
                }
                WorkoutChoice(type, focus, { type = it }, { focus = it })
                OutlinedTextField(
                    text, { text = it },
                    label = { Text("What's the plan?") },
                    placeholder = { Text("e.g. social 10k run with friends, keep it easy") },
                    modifier = Modifier.fillMaxWidth(), minLines = 2,
                )
                Text("It'll be 🔒 locked, your weekly AI re-plan will schedule around it, not over it.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
    )
}

// E5 — structured interval builder. Each step has a zone, minutes and a repeat
// count; the list compiles into a Workout (one "Main" section) with a duration
// and a TSS estimate from per-zone intensity factors.
internal class BuilderStep(kind: String = "Work", zone: String = "Z4", minutes: String = "3", reps: String = "1") {
    var kind by mutableStateOf(kind)
    var zone by mutableStateOf(zone)
    var minutes by mutableStateOf(minutes)
    var reps by mutableStateOf(reps)
}

internal val ZONE_IF = mapOf("Z1" to 0.55, "Z2" to 0.70, "Z3" to 0.83, "Z4" to 0.95, "Z5" to 1.10)

internal val STEP_KINDS = listOf("Warm-up", "Work", "Recovery", "Steady", "Cool-down")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun IntervalBuilderDialog(date: LocalDate, onDismiss: () -> Unit, onSave: (Workout, Boolean) -> Unit) {
    var title by remember { mutableStateOf("Interval session") }
    var type by remember { mutableStateOf("run") }
    var push by remember { mutableStateOf(true) }
    val steps = remember {
        mutableStateListOf(
            BuilderStep("Warm-up", "Z1", "10", "1"),
            BuilderStep("Work", "Z4", "3", "5"),
            BuilderStep("Recovery", "Z1", "2", "5"),
            BuilderStep("Cool-down", "Z1", "10", "1"),
        )
    }

    fun stepMinutes(s: BuilderStep) = (s.minutes.toDoubleOrNull() ?: 0.0) * (s.reps.toIntOrNull() ?: 1)
    val totalMin = steps.sumOf { stepMinutes(it) }
    val tss = steps.sumOf { s ->
        val mins = stepMinutes(s); val iff = ZONE_IF[s.zone] ?: 0.7
        mins / 60.0 * iff * iff * 100.0
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                enabled = steps.isNotEmpty() && totalMin > 0,
                onClick = {
                    val exercises = steps.map { s ->
                        val r = s.reps.toIntOrNull() ?: 1
                        WorkoutExercise(
                            name = (if (r > 1) "$r× " else "") + s.kind,
                            reps = "${s.minutes} min", hr_zone = s.zone,
                        )
                    }
                    val w = Workout(
                        type = type, title = title.ifBlank { "Interval session" },
                        duration_minutes = totalMin, tss_estimate = tss, rpe_target = 7.0,
                        sections = listOf(WorkoutSection("Main", totalMin, exercises)),
                        coach_note = "Built manually.",
                    )
                    onSave(w, push)
                },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("Build session · $date") },
        text = {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 460.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(title, { title = it }, label = { Text("Title") },
                    singleLine = true, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("run" to "Run", "ride" to "Ride").forEach { (k, label) ->
                        FilterChip(selected = type == k, onClick = { type = k }, label = { Text(label) })
                    }
                }
                Text("${totalMin.toInt()} min · ~${tss.toInt()} TSS", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)

                steps.forEachIndexed { i, s ->
                    SectionCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${i + 1}", Modifier.width(20.dp), style = MaterialTheme.typography.labelMedium)
                            ZoneDropdown(s.kind, STEP_KINDS) { s.kind = it }
                            Spacer(Modifier.weight(1f))
                            IconButton(onClick = { steps.removeAt(i) }, modifier = Modifier.size(28.dp)) {
                                Icon(Icons.Filled.Delete, "Remove step", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            ZoneDropdown(s.zone, listOf("Z1", "Z2", "Z3", "Z4", "Z5")) { s.zone = it }
                            OutlinedTextField(
                                s.minutes, { s.minutes = it }, label = { Text("min") },
                                singleLine = true, modifier = Modifier.width(84.dp),
                                keyboardOptions = KeyboardOptions(
                                    keyboardType = KeyboardType.Number),
                            )
                            OutlinedTextField(
                                s.reps, { s.reps = it }, label = { Text("× reps") },
                                singleLine = true, modifier = Modifier.width(84.dp),
                                keyboardOptions = KeyboardOptions(
                                    keyboardType = KeyboardType.Number),
                            )
                        }
                    }
                }
                TextButton(onClick = { steps.add(BuilderStep()) }) { Icon(Icons.Filled.Add, null); Text(" Add step") }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = push, onCheckedChange = { push = it })
                    Text("Push to Intervals.icu watch calendar", style = MaterialTheme.typography.bodySmall)
                }
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ZoneDropdown(value: String, options: List<String>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        AssistChip(onClick = { open = true }, label = { Text(value) })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o ->
                DropdownMenuItem(text = { Text(o) }, onClick = { onPick(o); open = false })
            }
        }
    }
}
