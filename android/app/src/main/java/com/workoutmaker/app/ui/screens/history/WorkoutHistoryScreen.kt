package com.workoutmaker.app.ui.screens.history

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FitnessCenter
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Watch
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.CompletedActivity
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.strength.ExerciseCatalog
import com.workoutmaker.app.strength.SetEntity
import com.workoutmaker.app.strength.StrengthRepository
import com.workoutmaker.app.strength.WorkoutEntity
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.ChipRow
import com.workoutmaker.app.ui.components.EmptyState
import com.workoutmaker.app.ui.components.ScreenScaffold
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.SectionLabel
import com.workoutmaker.app.ui.components.StatTileGrid
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.TextButton
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import com.workoutmaker.app.data.StrengthAnalysis
import com.workoutmaker.app.strength.StrengthHandoff
import com.workoutmaker.app.ui.components.ChartHr
import com.workoutmaker.app.ui.components.GhostButton
import com.workoutmaker.app.ui.components.SkeletonCard
import com.workoutmaker.app.util.AppLog
import com.workoutmaker.app.util.friendlyFnError
import java.time.format.TextStyle
import java.util.Locale
import com.workoutmaker.app.ui.screens.strength.ConfirmDeleteDialog
import com.workoutmaker.app.data.analyzeStrength
import com.workoutmaker.app.data.completedActivities

// ===========================================================================
// Dedicated, full-screen STRENGTH history: every logged lifting session, one
// chronological feed. Cardio activities live in the Calendar — not here. When
// the same session was also tracked on the watch (HR + calories), that watch
// data is merged INTO the strength record (display-time merge,
// non-destructive) instead of showing as a second entry.
// ===========================================================================

// One row in the feed: a strength session, optionally paired with watch data.
data class StrengthHistoryRow(val workout: WorkoutEntity, val watch: CompletedActivity?) {
    val epoch get() = workout.startedAt
}

private fun isStrengthType(type: String?): Boolean {
    val t = (type ?: "").lowercase()
    return t.contains("weight") || t.contains("strength") || t.contains("gym") || t == "workout"
}

private fun dateOf(epoch: Long): LocalDate =
    Instant.ofEpochMilli(epoch).atZone(ZoneId.systemDefault()).toLocalDate()

@HiltViewModel
class HistoryViewModel @Inject constructor(
    private val strength: StrengthRepository,
    private val repo: WorkoutRepository,
    private val handoff: StrengthHandoff,
) : ViewModel() {
    // Ask the Strength tab to open this workout in its edit mode; the caller
    // then navigates to the tab.
    fun requestEdit(workoutId: String) = handoff.requestEdit(workoutId)

    val rows = MutableStateFlow<List<StrengthHistoryRow>>(emptyList())
    val loading = MutableStateFlow(true)

    // Lazily-loaded sets for an opened strength session, keyed by workout id.
    val detailSets = MutableStateFlow<Map<String, List<SetEntity>>>(emptyMap())

    fun load() = viewModelScope.launch {
        loading.value = true
        val workouts = runCatching { strength.recentWorkouts(500) }.getOrDefault(emptyList())
        val from = LocalDate.now().minusYears(2).toString()
        // Watch activities are only fetched to enrich strength rows (HR/kcal/TSS).
        val activities = runCatching { repo.completedActivities(from) }.getOrDefault(emptyList())
            .filter { isStrengthType(it.type) }

        val pairedIds = HashSet<String>()
        fun watchFor(w: WorkoutEntity): CompletedActivity? {
            val candidates = activities.filter { activity ->
                activity.id !in pairedIds && activity.started_at?.let { value ->
                    runCatching { kotlin.math.abs(java.time.Instant.parse(value).toEpochMilli() - w.startedAt) <= 30 * 60 * 1000L }.getOrDefault(false)
                } == true
            }
            return candidates.singleOrNull()?.also { pairedIds.add(it.id) }
        }

        rows.value = workouts.map { StrengthHistoryRow(it, watchFor(it)) }
            .sortedByDescending { it.epoch }
        loading.value = false
    }

    fun loadSets(workoutId: String) = viewModelScope.launch {
        if (detailSets.value.containsKey(workoutId)) return@launch
        val sets = runCatching { strength.setsForWorkout(workoutId) }.getOrDefault(emptyList())
        detailSets.value = detailSets.value + (workoutId to sets)
    }

    fun deleteWorkout(workoutId: String) = viewModelScope.launch {
        runCatching { strength.deleteWorkout(workoutId) }
        load()
    }
}

@Composable
fun WorkoutHistoryScreen(
    onBack: () -> Unit,
    onEditInLogger: () -> Unit = {},
    vm: HistoryViewModel = hiltViewModel(),
) {
    val rows by vm.rows.collectAsStateSafe()
    val loading by vm.loading.collectAsStateSafe()
    val detailSets by vm.detailSets.collectAsStateSafe()
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<StrengthHistoryRow?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    // Detail is a full sub-screen.
    selected?.let { row ->
        BackHandler { selected = null }
        LaunchedEffect(row.workout.id) { vm.loadSets(row.workout.id) }
        StrengthSessionDetailScreen(
            w = row.workout,
            sets = detailSets[row.workout.id].orEmpty(),
            watch = row.watch,
            onBack = { selected = null },
            onDelete = { vm.deleteWorkout(row.workout.id); selected = null },
            onEdit = { vm.requestEdit(row.workout.id); selected = null; onEditInLogger() },
        )
        return
    }

    val filtered = remember(rows, query) {
        if (query.isBlank()) rows
        else rows.filter { it.workout.name.contains(query.trim(), ignoreCase = true) }
    }

    ScreenScaffold(
        title = "Strength history",
        subtitle = "${rows.size} sessions",
        eyebrow = "ALL SESSIONS",
        navigationIcon = {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        },
        isRefreshing = loading,
        onRefresh = { vm.load() },
    ) { mod ->
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            modifier = mod,
            singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, null) },
            placeholder = { Text("Search sessions") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        )

        if (loading && rows.isEmpty()) {
            repeat(4) { SkeletonCard() }
            return@ScreenScaffold
        }

        if (!loading && rows.isEmpty()) {
            EmptyState(
                title = "No strength sessions yet",
                subtitle = "Finished sessions land here. Import from Strong/Hevy in Settings → Import data, or start a workout from the Strength tab.",
                icon = Icons.Filled.FitnessCenter,
            )
            return@ScreenScaffold
        }

        // Group the feed by date for scannable section headers.
        var lastHeader: String? = null
        filtered.forEach { row ->
            val header = dateOf(row.epoch).let { d ->
                d.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault()) +
                    " · " + d
            }
            if (header != lastHeader) {
                SectionLabel(header, color = MaterialTheme.colorScheme.onSurfaceVariant)
                lastHeader = header
            }
            HistoryCard(row) { selected = row }
        }
    }
}

@Composable
private fun HistoryCard(row: StrengthHistoryRow, onClick: () -> Unit) {
    SectionCard(Modifier.clickable { onClick() }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SourceIcon(Icons.Filled.FitnessCenter, MaterialTheme.colorScheme.secondary)
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Text(row.workout.name, style = MaterialTheme.typography.titleMedium)
                val chips = buildList {
                    add("${row.workout.totalVolumeKg.toInt()} kg")
                    if (row.workout.durationSec > 0) add("${row.workout.durationSec / 60} min")
                }
                ChipRow(chips)
            }
        }
        row.watch?.let { w ->
            // Unified record: this strength session also has watch data.
            Row(
                Modifier.fillMaxWidth().padding(top = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Watch, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                val parts = buildList {
                    w.avg_hr?.let { add("♥ $it bpm") }
                    w.calories?.let { add("$it kcal") }
                    w.tss?.let { if (it > 0) add("TSS ${it.toInt()}") }
                }
                Text(
                    "  Merged with watch" + if (parts.isNotEmpty()) " · ${parts.joinToString(" · ")}" else "",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Strength execution analysis (analyze-strength edge function)
// ---------------------------------------------------------------------------
@HiltViewModel
class StrengthAnalysisViewModel @javax.inject.Inject constructor(
    private val repo: WorkoutRepository,
) : ViewModel() {
    val results = MutableStateFlow<Map<String, StrengthAnalysis>>(emptyMap())
    val busy = MutableStateFlow<String?>(null)
    val error = MutableStateFlow<String?>(null)

    fun analyze(date: String, force: Boolean = false, workoutId: String? = null) = viewModelScope.launch {
        val key = workoutId ?: date
        busy.value = key
        error.value = null
        runCatching { repo.analyzeStrength(date, force, workoutId = workoutId) }
            .onSuccess { results.value = results.value + (key to it) }
            .onFailure {
                AppLog.w("analyze", "analyze-strength failed date=$date", it)
                error.value = friendlyFnError(it)
            }
        busy.value = null
    }

    // Auto-load an analysis that already exists (computed right after the session
    // synced) without ever triggering a fresh LLM run.
    private val peeked = mutableSetOf<String>()
    fun peek(date: String, workoutId: String? = null) = viewModelScope.launch {
        val key = workoutId ?: date
        if (key in peeked || results.value.containsKey(key)) return@launch
        peeked += key
        runCatching { repo.analyzeStrength(date, peek = true, workoutId = workoutId) }
            .onSuccess { if (it.ok) results.value = results.value + (key to it) }
    }
}

@Composable
internal fun StrengthAnalysisSection(
    date: String,
    vm: StrengthAnalysisViewModel = hiltViewModel(),
    workoutId: String? = null,
) {
    val results by vm.results.collectAsStateSafe()
    val busy by vm.busy.collectAsStateSafe()
    val error by vm.error.collectAsStateSafe()
    val key = workoutId ?: date
    val a = results[key]

    // Display a background-computed analysis immediately, no button press needed.
    LaunchedEffect(key) { vm.peek(date, workoutId) }

    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Workout analysis", color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.weight(1f))
            if (a != null) {
                TextButton(
                    onClick = { vm.analyze(date, force = true, workoutId = workoutId) },
                    enabled = busy == null,
                ) { Text("Re-analyze") }
            }
        }

        if (a == null) {
            Text(
                "Compare what you lifted with what was prescribed: completion, volume vs plan, and AI coach feedback on load selection.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            GhostButton(
                onClick = { vm.analyze(date, workoutId = workoutId) },
                enabled = busy == null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    Icons.Filled.AutoAwesome, null,
                    Modifier.size(18.dp),
                )
                Text(if (busy == key) "  Analyzing…" else "  Analyze this session")
            }
            error?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            return@SectionCard
        }

        if (a.score != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ExecutionRing(a.score!!)
                Column(Modifier.padding(start = 14.dp)) {
                    Text(a.label ?: "", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    a.planned_title?.let {
                        Text("vs “$it”", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        } else {
            Text(a.label ?: "No planned session to compare against.", style = MaterialTheme.typography.bodyMedium)
        }
        a.coverage_evidence?.let { coverage ->
            Text("Exact exercises: ${coverage.exact}/${coverage.total} · Movement coverage: ${coverage.movement}/${coverage.total} · Muscle overlap: ${coverage.muscle}/${coverage.total}", style = MaterialTheme.typography.bodySmall)
        }
        a.dose_evidence.forEach { dose ->
            Text("${dose.exercise}: ${dose.logged_sets}/${dose.planned_sets} working sets recorded${dose.sets_in_rep_range?.let { "; $it in the planned rep range" } ?: "; units need confirmation"}", style = MaterialTheme.typography.bodySmall)
        }
        a.components.forEach { c ->
            Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(c.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Text("${c.score}/100", style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold, color = scoreColor(c.score))
                }
                ScoreBar(c.score)
                Text(c.detail, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        // Planned vs lifted, per exercise.
        if (a.exercises.isNotEmpty()) {
            SectionLabel("Planned vs lifted", color = MaterialTheme.colorScheme.secondary)
            a.exercises.forEach { ex ->
                Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text(ex.name, style = MaterialTheme.typography.titleSmall)
                    val actual = buildString {
                        append("${ex.actual_sets} sets")
                        ex.top_weight_kg?.let { append(" · top ${if (it % 1.0 == 0.0) it.toInt() else it} kg") }
                        ex.volume_kg?.let { append(" · ${it.toInt()} kg volume") }
                    }
                    Text(
                        actual + (ex.planned?.let { "   (planned $it)" } ?: ""),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

    }

    // Coach's narrative takeaway — its own card so the strength detail reads like
    // the run/ride one: the score on top, the planned-vs-lifted data, then the AI
    // feedback in a separate block below.
    a?.let { an ->
        if (!an.feedback.isNullOrBlank()) {
            SectionCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.AutoAwesome, null,
                        Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.width(6.dp))
                    SectionLabel("Coach feedback" + (an.feedback_provider?.let { " · $it" } ?: ""), color = MaterialTheme.colorScheme.primary)
                }
                Text(an.feedback!!, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }

    // Heart-rate trace from the paired watch recording, when one was synced.
    a?.series?.let { s ->
        if (s.hr.any { it != null }) {
            SectionCard {
                SectionLabel("Heart rate", color = ChartHr)
                HrChart(s, null)
            }
        }
    }
}

@Composable
private fun SourceIcon(icon: ImageVector, tint: Color) {
    Box(
        Modifier.size(40.dp)
            .clip(CircleShape)
            .background(tint.copy(alpha = 0.16f)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp)) }
}

// Full-screen strength session detail with its sets — plus the paired watch data
// when present, forming one unified record. Public so the Calendar can reuse it.
@Composable
fun StrengthSessionDetailScreen(
    w: WorkoutEntity,
    sets: List<SetEntity>,
    watch: CompletedActivity?,
    onBack: () -> Unit,
    onDelete: (() -> Unit)? = null,
    // Opens this workout in the Strength logger's edit mode (sets/reps/weights
    // editable; finishing re-saves it in place).
    onEdit: (() -> Unit)? = null,
) {
    var confirmDelete by remember { mutableStateOf(false) }
    if (confirmDelete && onDelete != null) {
        ConfirmDeleteDialog(
            what = "“${w.name}”",
            detail = "This removes the workout and its sets from your history.",
            onConfirm = { confirmDelete = false; onDelete() },
            onDismiss = { confirmDelete = false },
        )
    }
    ScreenScaffold(
        title = w.name,
        subtitle = dateOf(w.startedAt).toString(),
        eyebrow = "SESSION DETAIL",
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        actions = {
            if (onEdit != null) {
                IconButton(onClick = onEdit) {
                    Icon(Icons.Filled.Edit, "Edit workout", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (onDelete != null) {
                IconButton(onClick = { confirmDelete = true }) {
                    Icon(Icons.Filled.Delete, "Delete workout", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
    ) { mod ->
        SectionCard(mod) {
            SectionLabel("Logged in app", color = MaterialTheme.colorScheme.secondary)
            // Full name here — the app bar ellipsizes long ones to a single line.
            Text(w.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            StatTileGrid(
                buildList {
                    add("Volume" to "${w.totalVolumeKg.toInt()} kg")
                    if (w.durationSec > 0) add("Time" to "${w.durationSec / 60} min")
                    add("Sets" to "${sets.size}")
                },
            )
            if (w.note.isNotBlank()) Text("“${w.note}”", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
        }

        // Unified: watch contributions for the same session.
        watch?.let { a ->
            SectionCard(mod) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Watch, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(6.dp))
                    SectionLabel("From your watch", color = MaterialTheme.colorScheme.primary)
                }
                StatTileGrid(
                    buildList {
                        a.avg_hr?.let { add("Avg HR" to "$it bpm") }
                        a.maxHr?.let { add("Max HR" to "$it bpm") }
                        a.calories?.let { add("Calories" to "$it kcal") }
                        a.tss?.let { if (it > 0) add("Training load" to "${it.toInt()} TSS") }
                    },
                )
            }
        }

        // Execution analysis: planned prescription vs what was actually lifted,
        // with AI coach feedback — sibling of the run/ride analysis.
        StrengthAnalysisSection(dateOf(w.startedAt).toString(), workoutId = w.id)

        val byExercise = remember(sets) { sets.groupBy { it.exerciseName } }
        byExercise.forEach { (name, exSets) ->
            SectionCard(mod) {
                Text(name, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                val vol = exSets.filter { !it.isWarmup }.sumOf { it.weightKg * it.reps }
                Text("${ExerciseCatalog.muscleOf(name)} · ${exSets.size} sets · ${vol.toInt()} kg",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                exSets.forEach { s ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.width(28.dp), contentAlignment = Alignment.Center) {
                            Text(if (s.isWarmup) "W" else "${s.idx}",
                                fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodySmall,
                                color = if (s.isWarmup) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurface)
                        }
                        val kg = if (s.weightKg % 1.0 == 0.0) s.weightKg.toInt().toString() else s.weightKg.toString()
                        Text("$kg kg × ${s.reps}", style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.weight(1f))
                        s.rpe?.let { Text("RPE $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
    }
}
