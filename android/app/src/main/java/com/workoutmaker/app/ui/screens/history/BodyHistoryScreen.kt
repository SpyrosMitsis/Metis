package com.workoutmaker.app.ui.screens.history

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.MonitorWeight
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.BodyHistoryPoint
import com.workoutmaker.app.data.BodyMetricUpsert
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.data.deriveLeanKg
import com.workoutmaker.app.data.slopePerWeek
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.ui.components.EmptyState
import com.workoutmaker.app.ui.components.LineChart
import com.workoutmaker.app.ui.components.ScreenScaffold
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.SkeletonCard
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import androidx.compose.runtime.LaunchedEffect
import com.workoutmaker.app.ui.components.LocalAppSnackbar
import com.workoutmaker.app.ui.theme.amberAccent
import java.time.LocalDate
import com.workoutmaker.app.data.bodyHistory
import com.workoutmaker.app.data.loadProfile
import com.workoutmaker.app.data.saveProfile
import com.workoutmaker.app.data.upsertBodyMetrics

// The goal decides which trend matters — same mapping as the backend's
// body_trend.ts bodyFocus, keyed on the strength goal strings.
internal fun bodyFocusOf(strengthGoals: List<String>): String {
    val goals = strengthGoals.map { it.lowercase() }
    val muscle = goals.any { it.contains("build muscle") }
    val fat = goals.any { it.contains("lose fat") }
    return when {
        goals.any { it.contains("recomposition") } || (muscle && fat) -> "recomp"
        muscle -> "muscle"
        fat -> "fat_loss"
        else -> "general"
    }
}

@HiltViewModel
class BodyHistoryViewModel @Inject constructor(
    private val repo: WorkoutRepository,
) : ViewModel() {
    val points = MutableStateFlow<List<BodyHistoryPoint>>(emptyList())
    val strengthGoals = MutableStateFlow<List<String>>(emptyList())
    val loading = MutableStateFlow(true)
    val status = MutableStateFlow<String?>(null)

    init { load() }

    fun load() = viewModelScope.launch {
        loading.value = true
        // Widest window once (a year); the range chips filter client-side.
        val from = LocalDate.now().minusDays(365).toString()
        runCatching { repo.bodyHistory(from) }.onSuccess { points.value = it }
        runCatching { repo.loadProfile() }.getOrNull()?.let {
            strengthGoals.value = it.goals_by_sport["strength"].orEmpty()
        }
        loading.value = false
    }

    /** Manual quick-log: today's measurement into history + the profile. */
    fun logToday(weightKg: Double?, bodyFatPct: Double?, leanMassKg: Double?) {
        if (weightKg == null && bodyFatPct == null && leanMassKg == null) return
        viewModelScope.launch {
            val today = LocalDate.now().toString()
            val saved = runCatching {
                repo.upsertBodyMetrics(
                    listOf(
                        BodyMetricUpsert(
                            date = today,
                            weight_kg = weightKg,
                            body_fat_pct = bodyFatPct,
                            lean_mass_kg = leanMassKg,
                            source = "manual",
                        ),
                    ),
                )
            }.isSuccess
            // Keep the profile's single values current so generation sees them.
            runCatching {
                val p = repo.loadProfile() ?: return@runCatching
                val w = weightKg?.let { Math.round(it).toInt() } ?: p.weight_kg
                val bf = bodyFatPct ?: p.body_fat_pct
                if (w != p.weight_kg || bf != p.body_fat_pct) {
                    repo.saveProfile(p.copy(weight_kg = w, body_fat_pct = bf))
                }
            }
            status.value = if (saved) "✓ Logged today's measurement." else "Couldn't save, try again."
            if (saved) load()
        }
    }
}

private data class BodyRange(val label: String, val days: Long)
private val BODY_RANGES = listOf(
    BodyRange("1M", 30), BodyRange("3M", 90), BodyRange("6M", 180), BodyRange("1Y", 365),
)

@Composable
fun BodyHistoryScreen(onBack: () -> Unit, vm: BodyHistoryViewModel = hiltViewModel()) {
    val points by vm.points.collectAsStateSafe()
    val goals by vm.strengthGoals.collectAsStateSafe()
    val loading by vm.loading.collectAsStateSafe()
    val status by vm.status.collectAsStateSafe()
    var range by remember { mutableStateOf(BODY_RANGES[1]) } // 3M

    val snackbar = LocalAppSnackbar.current
    LaunchedEffect(status) {
        status?.let { snackbar?.show(it); vm.status.value = null }
    }

    ScreenScaffold(
        title = "Body trends",
        subtitle = "Last ${range.label}",
        eyebrow = "BODY COMPOSITION",
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        isRefreshing = loading,
        onRefresh = { vm.load() },
    ) { mod ->
        if (loading && points.isEmpty()) {
            Column(mod, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SkeletonCard(lines = 3); SkeletonCard(lines = 3); SkeletonCard(lines = 3)
            }
            return@ScreenScaffold
        }

        val cutoff = LocalDate.now().minusDays(range.days).toString()
        val inRange = points.filter { it.date >= cutoff }
        val weight = inRange.mapNotNull { p -> p.weight_kg?.let { p.date to it } }
        val fat = inRange.mapNotNull { p -> p.body_fat_pct?.let { p.date to it } }
        val lean = inRange.mapNotNull { p ->
            (p.lean_mass_kg ?: deriveLeanKg(p.weight_kg, p.body_fat_pct))?.let { p.date to it }
        }
        val focus = bodyFocusOf(goals)

        Column(mod, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BODY_RANGES.forEach { r ->
                    FilterChip(selected = range == r, onClick = { range = r }, label = { Text(r.label) })
                }
            }

            if (focus != "general") {
                GoalFocusCard(focus, weight, fat, lean)
            }

            if (points.isEmpty()) {
                EmptyState(
                    title = "No body data yet",
                    subtitle = "Weight, body fat and muscle chart here as your smart scale syncs through Health Connect, or log a measurement below.",
                    icon = Icons.Outlined.MonitorWeight,
                )
            } else {
                // The goal decides which chart leads.
                val cards: List<@Composable () -> Unit> = buildList {
                    val w: @Composable () -> Unit =
                        { BodyMetricCard("Weight", "kg", weight, MaterialTheme.colorScheme.primary, goodWhen(focus, "weight")) }
                    val f: @Composable () -> Unit =
                        { BodyMetricCard("Body fat", "%", fat, amberAccent(), goodWhen(focus, "fat")) }
                    val l: @Composable () -> Unit =
                        { BodyMetricCard("Muscle (lean mass)", "kg", lean, MaterialTheme.colorScheme.secondary, goodWhen(focus, "lean")) }
                    when (focus) {
                        "muscle" -> { add(l); add(w); add(f) }
                        "fat_loss" -> { add(w); add(f); add(l) }
                        "recomp" -> { add(l); add(f); add(w) }
                        else -> { add(w); add(f); add(l) }
                    }
                }
                cards.forEach { it() }
            }

            QuickLogCard(onLog = { w, f2, l2 -> vm.logToday(w, f2, l2) })
        }
    }
}

// Which slope direction counts as progress for this metric under this goal;
// null = neutral (no goal-colored judgement, just the number).
private fun goodWhen(focus: String, metric: String): Boolean? = when (focus) {
    "muscle" -> if (metric == "lean") true else null
    "fat_loss" -> if (metric == "weight" || metric == "fat") false else null
    "recomp" -> when (metric) {
        "lean" -> true
        "fat" -> false
        else -> null
    }
    else -> null
}

@Composable
private fun GoalFocusCard(
    focus: String,
    weight: List<Pair<String, Double>>,
    fat: List<Pair<String, Double>>,
    lean: List<Pair<String, Double>>,
) {
    val (title, watch) = when (focus) {
        "muscle" -> "Goal: build muscle" to "Lean mass is the trend that matters; expect weight to creep up with it."
        "fat_loss" -> "Goal: lose fat" to "Weight and body fat trending down is progress; hold lean mass steady."
        else -> "Goal: recomposition" to "The win is lean mass up while body fat drifts down, even at a steady weight."
    }
    val leanSlope = slopePerWeek(lean)
    val weightSlope = slopePerWeek(weight)
    val fatSlope = slopePerWeek(fat)
    val onTrack: Boolean? = when (focus) {
        "muscle" -> leanSlope?.let { it > 0 }
        "fat_loss" -> if (weightSlope == null && fatSlope == null) null else (weightSlope ?: 0.0) < 0 || (fatSlope ?: 0.0) < 0
        else -> if (leanSlope == null || fatSlope == null) null else leanSlope >= 0 && fatSlope <= 0
    }
    SectionCard(title = title) {
        Text(watch, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        onTrack?.let { ok ->
            Text(
                if (ok) "On track ✓" else "Not trending the right way yet",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = if (ok) MaterialTheme.colorScheme.primary else amberAccent(),
            )
        }
    }
}

@Composable
private fun BodyMetricCard(
    label: String,
    unit: String,
    series: List<Pair<String, Double>>,
    color: Color,
    higherIsGood: Boolean?, // null = neutral for the current goal
) {
    SectionCard(title = label) {
        if (series.size < 2) {
            Text(
                "Not enough readings yet.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@SectionCard
        }
        val latest = series.last().second
        val slope = slopePerWeek(series)
        val trendText = when {
            slope == null -> "trend needs a couple more weeks of readings"
            kotlin.math.abs(slope) < 0.05 -> "steady"
            else -> "${if (slope > 0) "up" else "down"} ${"%.1f".format(kotlin.math.abs(slope))} $unit/week"
        }
        val trendColor = when {
            slope == null || kotlin.math.abs(slope) < 0.05 || higherIsGood == null ->
                MaterialTheme.colorScheme.onSurfaceVariant
            (slope > 0) == higherIsGood -> MaterialTheme.colorScheme.primary
            else -> amberAccent()
        }
        Row(verticalAlignment = Alignment.Bottom) {
            // Never bake the unit into the format template: "%" as a unit reads
            // as a broken conversion and crashes String.format.
            Text("%.1f".format(latest) + " $unit", style = MaterialTheme.typography.titleMedium, color = color)
            Spacer(Modifier.width(8.dp))
            Text("· $trendText", style = MaterialTheme.typography.bodySmall, color = trendColor)
        }
        val epochs = series.map { LocalDate.parse(it.first).toEpochDay().toDouble() }
        LineChart(
            t = epochs,
            values = series.map { it.second },
            color = color,
            formatY = { "%.1f".format(it) },
            xLabels = series.first().first.takeLast(5) to series.last().first.takeLast(5),
            showPoints = series.size <= 40, // scale readings are sparse; show them
        )
    }
}

@Composable
internal fun QuickLogCard(onLog: (Double?, Double?, Double?) -> Unit) {
    var weight by remember { mutableStateOf("") }
    var fat by remember { mutableStateOf("") }
    var lean by remember { mutableStateOf("") }
    SectionCard(title = "Log today") {
        Text(
            "No smart scale needed: type what you know, leave the rest blank.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MeasurementField(weight, { weight = it }, "Weight", "kg", Modifier.weight(1f))
            MeasurementField(fat, { fat = it }, "Fat", "%", Modifier.weight(1f))
            MeasurementField(lean, { lean = it }, "Muscle", "kg", Modifier.weight(1f))
        }
        val w = weight.toDoubleOrNull()?.takeIf { it in 30.0..250.0 }
        val f = fat.toDoubleOrNull()?.takeIf { it in 3.0..60.0 }
        val l = lean.toDoubleOrNull()?.takeIf { it in 20.0..150.0 }
        Button(
            onClick = { onLog(w, f, l); weight = ""; fat = ""; lean = "" },
            enabled = w != null || f != null || l != null,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Save measurement") }
    }
}

@Composable
private fun MeasurementField(value: String, onValue: (String) -> Unit, name: String, unit: String, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(name, style = MaterialTheme.typography.bodySmall, maxLines = 1)
        OutlinedTextField(
            value, onValue,
            singleLine = true,
            suffix = { Text(unit, style = MaterialTheme.typography.bodySmall) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "$name, $unit" },
        )
    }
}
