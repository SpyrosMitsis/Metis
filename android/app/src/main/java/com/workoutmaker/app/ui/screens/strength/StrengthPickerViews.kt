package com.workoutmaker.app.ui.screens.strength

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.Surface
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.runtime.saveable.rememberSaveable
import com.workoutmaker.app.strength.ExerciseLogSummary
import com.workoutmaker.app.strength.ExerciseStatsFilter
import com.workoutmaker.app.strength.exerciseStatsNames
import com.workoutmaker.app.strength.isCustomStatsEntry
import com.workoutmaker.app.strength.ExerciseCatalog
import com.workoutmaker.app.strength.StrengthViewModel
import com.workoutmaker.app.strength.OneRepMax
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.EmptyState
import com.workoutmaker.app.ui.components.ScreenScaffold
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.SectionLabel
import com.workoutmaker.app.ui.components.StatTileGrid
import com.workoutmaker.app.ui.components.LineChart
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// ---------------------------------------------------------------------------
// Exercise picker
// ---------------------------------------------------------------------------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ExercisePickerView(vm: StrengthViewModel) {
    var query by remember { mutableStateOf("") }
    var muscle by remember { mutableStateOf<String?>(null) }
    var category by remember { mutableStateOf<String?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var confirmDeleteCustom by remember { mutableStateOf<String?>(null) }
    val selected = remember { mutableStateListOf<String>() }
    val favorites by vm.favorites.collectAsStateSafe()
    val recents by vm.recentExercises.collectAsStateSafe()
    val custom by vm.customExercises.collectAsStateSafe()
    // Replace mode (hamburger → "Replace exercise"): tap once to swap, no multi-select.
    val replacing by vm.replaceTarget.collectAsStateSafe()
    // Recompute when custom list or filters change.
    val results = remember(query, muscle, category, custom) { ExerciseCatalog.search(query, muscle, category) }

    if (showCreate) CreateExerciseDialog(onClose = { showCreate = false }) { n, m, c, comp ->
        vm.addCustomExercise(n, m, c, comp); showCreate = false
    }

    confirmDeleteCustom?.let { name ->
        AlertDialog(
            onDismissRequest = { confirmDeleteCustom = null },
            confirmButton = {
                TextButton(onClick = { vm.deleteCustomExercise(name); selected.remove(name); confirmDeleteCustom = null }) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteCustom = null }) { Text("Cancel") } },
            title = { Text("Delete “$name”?") },
            text = { Text("This removes your custom exercise. Past sessions that used it are unaffected.") },
        )
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(replacing?.let { "Replace “${it.name}”" } ?: "Add exercises") },
                navigationIcon = { IconButton(onClick = { vm.backToActive() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = { TextButton(onClick = { showCreate = true }) { Icon(Icons.Filled.Add, null); Text(" New") } },
            )
        },
        bottomBar = {
            if (replacing == null) {
                Button(
                    onClick = { vm.addExercises(selected.toList()) },
                    enabled = selected.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                ) { Text("Add ${selected.size} exercise(s)") }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxWidth()) {
            OutlinedTextField(query, { query = it }, label = { Text("Search") },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp), singleLine = true)

            // D5: quick-add favorites & recents (hidden while replacing — one tap swaps)
            if (replacing == null && query.isBlank() && muscle == null && category == null) {
                QuickAddRow("★ Favorites", favorites, selected)
                QuickAddRow("Recent", recents, selected)
            }

            Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(12.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected = muscle == null, onClick = { muscle = null }, label = { Text("All") })
                    ExerciseCatalog.muscles.forEach { m ->
                        FilterChip(selected = muscle == m, onClick = { muscle = if (muscle == m) null else m }, label = { Text(m) })
                    }
                }
            }
            Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ExerciseCatalog.categories.forEach { c ->
                        FilterChip(selected = category == c, onClick = { category = if (category == c) null else c }, label = { Text(c) })
                    }
                }
            }
            LazyColumn(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                items(results, key = { it.name }) { ex ->
                    val isSel = selected.contains(ex.name)
                    val isFav = favorites.contains(ex.name)
                    Row(
                        Modifier.fillMaxWidth().clickable {
                            if (replacing != null) vm.replaceExercise(ex.name)
                            else if (isSel) selected.remove(ex.name) else selected.add(ex.name)
                        }.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(ex.name + if (ExerciseCatalog.isCustom(ex.name)) "  ·  custom" else "",
                                style = MaterialTheme.typography.bodyLarge)
                            Text("${ex.muscle} · ${ex.category}", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (ExerciseCatalog.isCustom(ex.name)) {
                            IconButton(onClick = { confirmDeleteCustom = ex.name }) {
                                Icon(Icons.Filled.Delete, "Delete custom exercise",
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        IconButton(onClick = { vm.toggleFavorite(ex.name) }) {
                            Icon(if (isFav) Icons.Filled.Star else Icons.Filled.StarBorder, "Favorite",
                                tint = if (isFav) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (replacing == null) {
                            Checkbox(checked = isSel, onCheckedChange = {
                                if (isSel) selected.remove(ex.name) else selected.add(ex.name)
                            })
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun QuickAddRow(label: String, names: List<String>, selected: MutableList<String>) {
    if (names.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                names.forEach { n ->
                    val isSel = selected.contains(n)
                    FilterChip(selected = isSel, onClick = { if (isSel) selected.remove(n) else selected.add(n) }, label = { Text(n) })
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Per-exercise stats
// ---------------------------------------------------------------------------

// Searchable, full-page picker behind the top-bar 📊 button. Tap an exercise
// to push its stats page (see ExerciseStatsScreen below).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExerciseStatsPickerScreen(
    exercises: List<String>, onPick: (String) -> Unit, onBack: () -> Unit,
    customNames: Set<String> = emptySet(),
    summaries: Map<String, ExerciseLogSummary> = emptyMap(),
    hiddenNames: Set<String> = emptySet(),
    onDeleteCustom: (String) -> Unit = {}, onRestore: (String) -> Unit = {},
    message: String? = null,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(ExerciseStatsFilter.ALL) }
    var pendingDelete by rememberSaveable { mutableStateOf<String?>(null) }
    val filtered = remember(exercises, query, filter, hiddenNames, customNames) {
        exerciseStatsNames(exercises, query, filter, hiddenNames, customNames)
    }
    val visibleCount = exercises.count { it !in hiddenNames }
    val listState = rememberLazyListState()
    LaunchedEffect(query, filter) { listState.scrollToItem(0) }
    ScreenScaffold(
        title = "Exercise stats",
        subtitle = "$visibleCount exercises logged · Tap to view progress",
        eyebrow = "STRENGTH LOG", scrollable = false,
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
    ) { mod ->
        Column(mod.imePadding()) {
            OutlinedTextField(
                value = query, onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth(), singleLine = true,
                shape = RoundedCornerShape(16.dp),
                leadingIcon = { Icon(Icons.Filled.Search, null) },
                placeholder = { Text("Search exercises") },
                trailingIcon = {
                    if (query.isNotBlank()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "Clear") }
                },
            )
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ExerciseStatsFilter.entries.forEach { option ->
                    FilterChip(selected = filter == option, onClick = { filter = option },
                        label = { Text(if (option == ExerciseStatsFilter.HIDDEN) "Hidden (${exercises.count { it in hiddenNames }})" else option.label) })
                }
            }
            message?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(bottom = 8.dp))
            }
            if (filtered.isEmpty()) {
                EmptyState(title = if (query.isNotBlank()) "No matches" else if (filter == ExerciseStatsFilter.ALL) "No exercises yet" else "No ${filter.label.lowercase()} exercises",
                    subtitle = if (query.isNotBlank()) "Try another name, muscle or equipment." else if (filter == ExerciseStatsFilter.HIDDEN)
                        "Deleted custom entries appear here. Your workout history is kept." else "Logged exercises will appear here.",
                    icon = Icons.Filled.BarChart)
            }
            LazyColumn(Modifier.weight(1f), state = listState, contentPadding = PaddingValues(bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(filtered, key = { it }) { name ->
                    val custom = isCustomStatsEntry(name, customNames)
                    val hidden = name in hiddenNames
                    var menu by remember { mutableStateOf(false) }
                    val exercise = ExerciseCatalog.find(name)
                    val summary = summaries[name]
                    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                        Row(
                            Modifier.fillMaxWidth().clickable { onPick(name) }.heightIn(min = 60.dp)
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(Icons.Filled.BarChart, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                            Column(Modifier.weight(1f)) {
                                Text(name, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                val details = listOfNotNull(if (custom) "Custom" else null, exercise?.muscle, exercise?.category)
                                if (details.isNotEmpty()) Text(details.joinToString(" · "), style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                summary?.let {
                                    val date = Instant.ofEpochMilli(it.lastPerformedAt).atZone(ZoneId.systemDefault()).toLocalDate()
                                        .format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
                                    Text("${it.sessionCount} ${if (it.sessionCount == 1) "session" else "sessions"} · Last $date",
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                            if (hidden) {
                                IconButton(onClick = { onRestore(name) }) { Icon(Icons.Filled.Restore, "Restore $name") }
                            } else if (custom) {
                                Box {
                                    IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "Options for $name") }
                                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                        DropdownMenuItem(text = { Text("Delete custom entry") }, leadingIcon = { Icon(Icons.Filled.Delete, null) },
                                            onClick = { menu = false; pendingDelete = name })
                                    }
                                }
                            } else Icon(Icons.Filled.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
    pendingDelete?.let { name ->
        AlertDialog(onDismissRequest = { pendingDelete = null },
            title = { Text("Delete “$name”?") },
            text = { Text(if (ExerciseCatalog.all.any { it.name == name })
                "Remove your custom definition. The bundled exercise and all logged workouts stay available."
                else "Remove this custom exercise from your collection and hide it from stats. Logged sets and workouts are kept. You can show its stats again from Hidden.") },
            confirmButton = { TextButton(onClick = { onDeleteCustom(name); pendingDelete = null }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Cancel") } })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExerciseStatsScreen(vm: StrengthViewModel, exercise: String, onBack: () -> Unit) {
    LaunchedEffect(exercise) { vm.openStats(exercise) }
    val stats by vm.currentStats.collectAsStateSafe()
    val s = stats
    ScreenScaffold(
        title = exercise,
        subtitle = if (s != null && s.hasData) "${s.points.size} sessions logged" else null,
        eyebrow = "EXERCISE STATS",
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
    ) { mod ->
        if (s == null || !s.hasData) {
            EmptyState(
                modifier = mod,
                title = "No history yet",
                subtitle = "Log this exercise to see e1RM and PRs.",
                icon = Icons.Filled.BarChart,
            )
            return@ScreenScaffold
        }
        SectionCard(mod) {
            SectionLabel("Personal records", color = MaterialTheme.colorScheme.secondary)
            StatTileGrid(
                listOf(
                    "Best e1RM" to "${s.bestE1rm.toInt()} kg",
                    "Best set" to "${s.bestWeight.toInt()} kg",
                    "Best volume" to "${s.bestVolume.toInt()} kg",
                ),
            )
        }

        // C1: progression chart with a metric toggle.
        var metric by remember { mutableStateOf("e1RM") }
        SectionCard(mod, title = "Progression") {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("e1RM", "Top weight", "Volume").forEach { m ->
                    FilterChip(selected = metric == m, onClick = { metric = m }, label = { Text(m) })
                }
            }
            val series = s.points.map {
                when (metric) {
                    "Top weight" -> it.bestWeight
                    "Volume" -> it.volume
                    else -> it.e1rm
                }
            }
            MetricChart(series, unit = if (metric == "Volume") "kg vol" else "kg")
            Text(
                "${s.points.size} sessions · latest ${series.lastOrNull()?.toInt() ?: 0}" +
                    if (metric == "Volume") " kg vol" else " kg",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // C6: %-of-1RM training table off the best estimated 1RM.
        SectionCard(mod, title = "Training loads (% of ${s.bestE1rm.toInt()}kg 1RM)") {
            OneRepMax.table(s.bestE1rm).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${row.pct}% · ~${row.reps} reps", style = MaterialTheme.typography.bodySmall)
                    Text("${trimKg(row.weightKg)} kg", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                }
            }
        }

        SectionCard(mod, title = "Sessions") {
            s.points.reversed().forEach { p ->
                val d = Instant.ofEpochMilli(p.dateMillis)
                    .atZone(ZoneId.systemDefault()).toLocalDate().toString()
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(d, style = MaterialTheme.typography.bodySmall)
                    Text("e1RM ${p.e1rm.toInt()}kg · ${p.volume.toInt()}kg vol",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
internal fun Pr(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun MetricChart(values: List<Double>, unit: String = "kg") {
    if (values.isEmpty()) {
        Text("Log a few sessions to see your trend.", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    // The latest value + unit is shown in the caption below the chart, so the
    // chart itself stays clean: a filled, rounded progression line with a dot
    // per session. (unit kept for source compatibility.)
    LineChart(
        t = values.indices.map { it.toDouble() },
        values = values.map { it as Double? },
        color = MaterialTheme.colorScheme.primary,
        formatY = { "${it.toInt()}" },
        showPoints = true,
        height = 140.dp,
    )
}
