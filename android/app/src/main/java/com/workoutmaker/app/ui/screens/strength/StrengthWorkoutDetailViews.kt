package com.workoutmaker.app.ui.screens.strength

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.workoutmaker.app.strength.ExerciseCatalog
import com.workoutmaker.app.strength.StrengthViewModel
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.SectionCard
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.key
import com.workoutmaker.app.strength.SetEntity
import java.time.Instant
import java.time.ZoneId

// ---------------------------------------------------------------------------
// Workout detail — drill into one logged session: every exercise and set.
// ---------------------------------------------------------------------------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkoutDetailView(vm: StrengthViewModel, onOpenStats: (String) -> Unit = {}) {
    val detail by vm.workoutDetail.collectAsStateSafe()
    var confirmDelete by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val d = detail
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(d?.workout?.name ?: "Workout") },
                navigationIcon = { IconButton(onClick = { vm.goHome() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    if (d != null) {
                        IconButton(onClick = { vm.editWorkout(d.workout.id) }) { Icon(Icons.Filled.Edit, "Edit workout") }
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("Save as routine") },
                                onClick = { menu = false; vm.saveWorkoutAsRoutine(d.workout.id) })
                            DropdownMenuItem(text = { Text("Delete workout") },
                                onClick = { menu = false; confirmDelete = true })
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (d == null) {
            Box(Modifier.padding(padding).fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                Text("Loading…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            return@Scaffold
        }
        if (confirmDelete) ConfirmDeleteDialog(
            what = "“${d.workout.name}”",
            detail = "This removes the workout and its ${d.totalSets} sets from your history.",
            onConfirm = { confirmDelete = false; vm.deleteWorkout(d.workout.id) },
            onDismiss = { confirmDelete = false },
        )
        val date = Instant.ofEpochMilli(d.workout.startedAt)
            .atZone(ZoneId.systemDefault()).toLocalDate().toString()
        LazyColumn(
            Modifier.padding(padding).fillMaxWidth(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Pr("Volume", "${d.workout.totalVolumeKg.toInt()} kg")
                    Pr("Sets", "${d.totalSets}")
                    Pr("Exercises", "${d.exercises.size}")
                    if (d.workout.durationSec > 0) Pr("Time", fmtClock(d.workout.durationSec.toLong()))
                }
                Text(date, Modifier.padding(top = 6.dp), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (d.workout.note.isNotBlank()) {
                    Text("“${d.workout.note}”", Modifier.padding(top = 4.dp),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                }
            }
            items(d.exercises, key = { it.first }) { (name, sets) ->
                WorkoutDetailExercise(name, sets, onStats = { onOpenStats(name) })
            }
        }
    }
}

@Composable
internal fun WorkoutDetailExercise(name: String, sets: List<SetEntity>, onStats: () -> Unit) {
    val cardio = ExerciseCatalog.find(name)?.category == "Cardio"
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                val meta = if (cardio) {
                    val mins = sets.sumOf { it.reps }
                    "Cardio · ${sets.size} interval(s) · $mins min"
                } else {
                    val vol = sets.filter { !it.isWarmup && it.quantityUnit == "reps" }.sumOf { it.weightKg * it.reps }
                    "${ExerciseCatalog.muscleOf(name)} · ${sets.size} sets · ${vol.toInt()} kg"
                }
                Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onStats) { Icon(Icons.Filled.BarChart, "Exercise stats") }
        }
        sets.forEach { s ->
            Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.width(34.dp), contentAlignment = Alignment.Center) {
                        Text(if (s.isWarmup) "W" else "${s.idx}",
                            color = if (s.isWarmup) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurface,
                            fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodySmall)
                    }
                    Text(if (cardio) "${s.reps} min" else "${trimKg(s.weightKg)} kg × ${s.reps} ${s.quantityUnit}",
                        style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.weight(1f))
                    s.rpe?.let { Text("RPE $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                if (s.note.isNotBlank()) {
                    Text(s.note, Modifier.padding(start = 34.dp),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
