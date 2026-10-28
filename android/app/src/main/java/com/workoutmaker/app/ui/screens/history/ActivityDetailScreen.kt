package com.workoutmaker.app.ui.screens.history

import com.workoutmaker.app.ui.components.SessionFeedbackPanel
import com.workoutmaker.app.data.persistedActivityId
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material3.Icon
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workoutmaker.app.data.PlannedWorkout
import com.workoutmaker.app.data.WorkoutRepository
import com.workoutmaker.app.ui.collectAsStateSafe
import com.workoutmaker.app.data.CompletedActivity
import com.workoutmaker.app.data.ActivityReconciliationViewModel
import com.workoutmaker.app.data.activityStatusLabel
import com.workoutmaker.app.ui.components.fmtClock
import com.workoutmaker.app.ui.components.GhostButton
import com.workoutmaker.app.ui.components.StatTileGrid
import com.workoutmaker.app.ui.components.SectionCard
import com.workoutmaker.app.ui.components.SectionLabel
import com.workoutmaker.app.ui.components.ChartCadence
import com.workoutmaker.app.ui.components.ChartHr
import com.workoutmaker.app.ui.components.ChartPace
import com.workoutmaker.app.ui.components.ChartPower
import com.workoutmaker.app.ui.theme.mossAccent
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import com.workoutmaker.app.data.ActivityAnalysis
import com.workoutmaker.app.data.AnalysisSeries
import com.workoutmaker.app.data.AnalysisTarget
import com.workoutmaker.app.data.Zones
import com.workoutmaker.app.ui.components.LineChart
import com.workoutmaker.app.util.friendlyError
import com.workoutmaker.app.ui.theme.BandAmber
import com.workoutmaker.app.ui.theme.BandGreen
import com.workoutmaker.app.ui.theme.amberAccent
import com.workoutmaker.app.util.AppLog
import com.workoutmaker.app.util.friendlyFnError
import com.workoutmaker.app.ui.screens.calendar.fmtPaceSec
import com.workoutmaker.app.ui.screens.calendar.looksLike
import com.workoutmaker.app.ui.screens.home.HomeViewModel
import com.workoutmaker.app.ui.screens.strength.fmtClock
import com.workoutmaker.app.data.analyzeActivity

// Full detail page for a past workout/run/ride — rich data from Intervals.icu.
// Non-private so the dedicated Workout History screen can reuse it.
@Composable
fun ActivityDetailScreen(activity: CompletedActivity, planned: PlannedWorkout?, onBack: () -> Unit) {
    val correctionVm: ActivityReconciliationViewModel = hiltViewModel()
    val correction by correctionVm.state.collectAsStateSafe()
    val displayedActivity = correction.activity?.takeIf { correction.sourceId == activity.id } ?: activity
    Column(
        Modifier.fillMaxWidth().fillMaxHeight().verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Column(Modifier.padding(start = 4.dp)) {
                Text(displayedActivity.displayName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    "${displayedActivity.type ?: "Activity"} · ${displayedActivity.date ?: ""}" + if (displayedActivity.isManual) " · logged manually" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // Order: headline first (how it went), then the key numbers and the
        // coach's take, then the graphs, then the deeper analytical breakdowns.

        // 1. Execution verdict vs the plan — the headline.
        if (!displayedActivity.isManual) AnalysisScoreCard(displayedActivity)

        // 2. Key metrics at a glance.
        SectionCard {
            SectionLabel("Summary", color = MaterialTheme.colorScheme.primary)
            StatTileGrid(
                buildList {
                    displayedActivity.distanceKm?.let { if (it > 0) add("Distance" to "%.2f km".format(it)) }
                    displayedActivity.durationMin?.let { if (it > 0) add("Duration" to "$it min") }
                    // Elapsed only when it differs meaningfully from moving time (≥1 min of pauses).
                    displayedActivity.elapsedSeconds?.let { el ->
                        val mv = displayedActivity.duration_seconds ?: 0
                        if (el - mv >= 60) add("Elapsed" to "${el / 60} min")
                    }
                    if (displayedActivity.isSwim) {
                        displayedActivity.paceSecPer100m?.let { add("Avg pace" to "${fmtPaceSec(it)} /100m") }
                        displayedActivity.maxPaceSecPer100m?.let { add("Best pace" to "${fmtPaceSec(it)} /100m") }
                    } else {
                        displayedActivity.paceSecPerKm?.let { add("Avg pace" to "${fmtPaceSec(it)} /km") }
                        displayedActivity.maxPaceSecPerKm?.let { add("Best pace" to "${fmtPaceSec(it)} /km") }
                    }
                    displayedActivity.avg_hr?.let { add("Avg HR" to "$it bpm") }
                    displayedActivity.maxHr?.let { add("Max HR" to "$it bpm") }
                    displayedActivity.avgPower?.let { add("Avg power" to "$it W") }
                    displayedActivity.normalizedPower?.let { add("Norm. power" to "$it W") }
                    displayedActivity.avgCadence?.let { add("Avg cadence" to "$it spm") }
                    displayedActivity.maxCadence?.let { add("Max cadence" to "$it spm") }
                    displayedActivity.decouplingPct?.let { add("HR drift" to "%.1f%%".format(it)) }
                    displayedActivity.elevationGain?.let { add("Elevation" to "$it m") }
                    displayedActivity.avgTempC?.let { add("Avg temp" to "$it°C") }
                    displayedActivity.calories?.let { add("Calories" to "$it kcal") }
                    displayedActivity.tss?.let { if (it > 0) add("Training load" to "${it.toInt()} TSS") }
                },
            )
        }

        ActivityReconciliation(activity, correctionVm)
        if (persistedActivityId(displayedActivity.id)) SessionFeedbackPanel(date = displayedActivity.date ?: java.time.LocalDate.now().toString(), planId = displayedActivity.planned_workout_id, activityId = displayedActivity.id)

        // 3. The coach's narrative takeaway.
        if (!displayedActivity.isManual) CoachFeedbackCard(displayedActivity)

        // 4. Graphs over time: pace, heart rate, cadence, power.
        if (!displayedActivity.isManual) ActivityChartsSection(displayedActivity)

        // --- deeper analytical detail below -----------------------------------

        // 5. How the session's intensity was distributed.
        displayedActivity.hrZoneTimes?.let { HrZoneCard(it) }

        // 6. Per-kilometre splits.
        if (!displayedActivity.isManual) SplitsCard(displayedActivity)

        // 7. Plan match summary.
        planned?.let { p ->
            SectionCard {
                SectionLabel("On the plan that day", color = mossAccent())
                Text(p.workout_json.title, style = MaterialTheme.typography.titleSmall)
                Text(
                    if (displayedActivity.planned_workout_id == p.id) {
                        if (displayedActivity.link_source == "athlete") "Your assessment: ${displayedActivity.session_state.replace('_', ' ')}."
                        else "Possible match to this plan; completion and dose are not confirmed."
                    } else "This activity has not been linked to this plan.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (displayedActivity.planned_workout_id == p.id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary,
                )
            }
        }

        // 8. E3-style load context: what this did to your fitness.
        if (displayedActivity.ctl != null || displayedActivity.atl != null) {
            SectionCard {
                SectionLabel("Fitness after this", color = MaterialTheme.colorScheme.secondary)
                StatTileGrid(
                    buildList {
                        displayedActivity.ctl?.let { add("Fitness (CTL)" to "%.0f".format(it)) }
                        displayedActivity.atl?.let { add("Fatigue (ATL)" to "%.0f".format(it)) }
                        if (displayedActivity.ctl != null && displayedActivity.atl != null) {
                            add("Form (TSB)" to "%.0f".format(displayedActivity.ctl!! - displayedActivity.atl!!))
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun ClassificationSelector(label: String, selected: String, options: List<Pair<String, String>>, enabled: Boolean = true, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(onClick = { expanded = true }, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
                Text(selected, modifier = Modifier.weight(1f), textAlign = TextAlign.Start)
                Text("▾")
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.heightIn(max = 360.dp)) {
                options.forEach { (value, title) ->
                    DropdownMenuItem(text = { Text(title) }, onClick = { expanded = false; onSelect(value) })
                }
            }
        }
    }
}

@Composable
private fun ActivityReconciliation(activity: CompletedActivity, vm: ActivityReconciliationViewModel) {
    val state by vm.state.collectAsStateSafe()
    var advanced by remember(activity.id) { mutableStateOf(false) }
    LaunchedEffect(activity.id, activity.content_revision) { vm.load(activity) }
    val saved = state.activity ?: activity
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Activity classification", color = MaterialTheme.colorScheme.secondary)
            Spacer(Modifier.weight(1f))
            if (!state.editing) TextButton(onClick = { vm.edit(activity) }, enabled = !state.loading) {
                Text(if (state.loading) "Loading…" else "Edit")
            }
        }
        Text("${saved.type ?: "Activity"} · ${if (saved.session_state == "unknown") "Recorded activity" else activityStatusLabel(saved.session_state)}", style = MaterialTheme.typography.bodyMedium)
        Text(if (saved.planned_workout_id == null) "No linked workout" else if (saved.link_source == "athlete") "Linked workout" else "Possible workout match",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.editing) {
            ClassificationSelector("Activity type", state.actualType.ifBlank { "Choose activity" },
                listOf("Run", "Ride", "Swim", "Weight training", "Walk", "Hike", "Rowing", "Other").map { it to it }, enabled = !state.saving) { value ->
                vm.state.value = state.copy(actualType = value, message = null)
            }
            ClassificationSelector("Workout", state.plans.find { it.id == state.planId }?.let { "${it.date} · ${it.workout_json.title}" } ?: if (state.planId.isBlank()) "No linked workout" else "Linked workout",
                listOf("" to "No linked workout") + state.plans.map { it.id to "${it.date} · ${it.workout_json.title}" }, enabled = !state.saving) { value ->
                vm.state.value = state.copy(planId = value, duplicateId = "", status = if (value.isEmpty() || state.status == "unplanned") "unknown" else state.status, message = null)
            }
            val statuses = if (state.planId.isBlank()) listOf("unplanned", "unknown") else listOf("completed_as_planned", "modified", "substituted", "unknown")
            ClassificationSelector("How it relates to the workout", activityStatusLabel(state.status), statuses.map { it to activityStatusLabel(it) }, enabled = !state.saving) { value ->
                vm.state.value = state.copy(status = value, message = null)
            }
            TextButton(onClick = { advanced = !advanced }, enabled = !state.saving) { Text(if (advanced) "Hide additional options" else "Parts and duplicate recordings") }
            if (advanced) {
                ClassificationSelector("Session parts", state.activities.find { (it.session_group_id ?: it.id) == state.groupId }?.displayName ?: "Separate activity",
                    listOf(saved.id to "Separate activity") + state.activities.map { (it.session_group_id ?: it.id) to "Part of ${it.displayName}" }, enabled = !state.saving) { value ->
                    vm.state.value = state.copy(groupId = value, duplicateId = "", message = null)
                }
                ClassificationSelector("Duplicate recording", state.activities.find { it.id == state.duplicateId }?.displayName ?: "Keep this activity",
                    listOf("" to "Keep this activity") + state.activities.map { it.id to "Duplicate of ${it.displayName}" }, enabled = !state.saving) { value ->
                    vm.state.value = state.copy(duplicateId = value, groupId = "", planId = if (value.isNotEmpty()) "" else state.planId, status = if (value.isNotEmpty()) "unknown" else state.status, message = null)
                }
                if (saved.duplicate_candidate_ids.isNotEmpty()) ClassificationSelector("Restore a hidden recording", state.unmergeId.take(8).ifBlank { "None" },
                    listOf("" to "None") + saved.duplicate_candidate_ids.map { it to "Recording ${it.take(8)}" }, enabled = !state.saving) { value -> vm.state.value = state.copy(unmergeId = value) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.correct() }, enabled = state.canSave) { Text(if (state.saving) "Saving…" else "Save changes") }
                TextButton(onClick = { vm.cancel() }, enabled = !state.saving) { Text("Cancel") }
            }
        }
        state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (state.needsSync) TextButton(onClick = { vm.edit(activity, sync = true) }, enabled = !state.loading) { Text("Sync activity") }
    }
}

// ---------------------------------------------------------------------------
// Post-workout analysis (analyze-activity edge function)
// ---------------------------------------------------------------------------
@HiltViewModel
class ActivityAnalysisViewModel @Inject constructor(
    private val repo: WorkoutRepository,
) : ViewModel() {
    val results = MutableStateFlow<Map<String, ActivityAnalysis>>(emptyMap())
    val busy = MutableStateFlow<String?>(null)
    val error = MutableStateFlow<String?>(null)

    fun analyze(activityId: String, force: Boolean = false) = viewModelScope.launch {
        busy.value = activityId
        error.value = null
        runCatching { repo.analyzeActivity(activityId, force) }
            .onSuccess { results.value = results.value + (activityId to it) }
            .onFailure {
                AppLog.w("analyze", "analyze-activity failed id=$activityId", it)
                // Surface the server's own {"error": ...} text; the raw exception
                // message carries the whole URL + headers and gets masked as the
                // useless generic line.
                error.value = friendlyFnError(it)
            }
        busy.value = null
    }

    // Auto-load an analysis that already exists (e.g. computed in the background
    // after a sync) without ever triggering a fresh LLM run.
    private val peeked = mutableSetOf<String>()
    fun peek(activityId: String) = viewModelScope.launch {
        if (activityId in peeked || results.value.containsKey(activityId)) return@launch
        peeked += activityId
        runCatching { repo.analyzeActivity(activityId, peek = true) }
            .onSuccess { if (it.ok) results.value = results.value + (activityId to it) }
    }
}

// The execution-verdict card: score vs the plan, or the prompt to analyze when
// it hasn't run yet. Owns the peek so the sibling analysis cards below can just
// read the cached result (they share this same ViewModel instance).
@Composable
internal fun AnalysisScoreCard(
    activity: CompletedActivity,
    vm: ActivityAnalysisViewModel = hiltViewModel(),
) {
    val results by vm.results.collectAsStateSafe()
    val busy by vm.busy.collectAsStateSafe()
    val error by vm.error.collectAsStateSafe()
    val a = results[activity.id]

    // Digest placeholders are fabricated client-side when a Home digest entry
    // has no matching synced completed_activities row (HomeViewModel
    // toCompleted). There is nothing in the DB to analyze, so offering the
    // button just produced a guaranteed "activity not found".
    if (activity.id.startsWith("digest:")) {
        SectionCard {
            SectionLabel("Workout analysis", color = MaterialTheme.colorScheme.primary)
            Text(
                "This session hasn't fully synced yet, so it can't be analyzed. Pull to refresh on Home and reopen it from Recent activities.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    // Display a background-computed analysis immediately, no button press needed.
    LaunchedEffect(activity.id) { vm.peek(activity.id) }

    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Workout analysis", color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.weight(1f))
            if (a != null) {
                TextButton(onClick = { vm.analyze(activity.id, force = true) }, enabled = busy == null) {
                    Text("Re-analyze")
                }
            }
        }

        if (a == null) {
            Text(
                "Break the session down: pacing and splits, heart rate response, and AI coach feedback. Scored against your plan when a matching one exists.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            GhostButton(
                onClick = { vm.analyze(activity.id) },
                enabled = busy == null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.AutoAwesome, null, Modifier.size(18.dp))
                Text(if (busy == activity.id) "  Analyzing…" else "  Analyze this workout")
            }
            error?.let {
                Text(friendlyError(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
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
        a.execution_evidence?.let { evidence ->
            Text(evidence.summary, style = MaterialTheme.typography.bodyMedium)
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
    }
}

// The coach's narrative takeaway for this session.
@Composable
private fun CoachFeedbackCard(
    activity: CompletedActivity,
    vm: ActivityAnalysisViewModel = hiltViewModel(),
) {
    val results by vm.results.collectAsStateSafe()
    val a = results[activity.id] ?: return
    if (a.feedback.isNullOrBlank()) return
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.AutoAwesome, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(6.dp))
            SectionLabel("Coach feedback" + (a.feedback_provider?.let { " · $it" } ?: ""), color = MaterialTheme.colorScheme.primary)
        }
        Text(a.feedback!!, style = MaterialTheme.typography.bodyMedium)
    }
}

// Time-series graphs from the recording: pace + HR (with their planned target
// bands), then cadence and power when the device recorded them.
@Composable
private fun ActivityChartsSection(
    activity: CompletedActivity,
    vm: ActivityAnalysisViewModel = hiltViewModel(),
) {
    val results by vm.results.collectAsStateSafe()
    val a = results[activity.id] ?: return
    val series = a.series ?: return

    // Strictly from the server's unit: old cached swim analyses hold sec/km
    // values, so guessing /100m from the activity type would mislabel them.
    // Re-analyze regenerates them in /100m.
    val per100m = a.isPer100m
    val paceUnit = if (per100m) "/100m" else "/km"
    if (series.pace.any { it != null }) {
        SectionCard {
            SectionLabel(
                "Pace · $paceUnit" + (a.target?.takeIf { it.pace_lo != null && it.pace_hi != null }?.let { t ->
                    " · target ${t.zones} ${fmtPaceSec(t.pace_lo!!.toInt())}-${fmtPaceSec(t.pace_hi!!.toInt())}"
                } ?: ""),
                color = ChartPace,
            )
            PaceChart(series, a.target, per100m)
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                LegendDotSmall("Actual pace", ChartPace)
                if (a.target?.pace_lo != null) LegendDotSmall("Target band", MaterialTheme.colorScheme.secondary)
            }
        }
    }
    if (series.hr.any { it != null }) {
        SectionCard {
            SectionLabel(
                "Heart rate · bpm" + (a.target?.takeIf { it.hr_lo != null && it.hr_hi != null }?.let { " · target ${it.hr_lo}-${it.hr_hi}" } ?: ""),
                color = ChartHr,
            )
            HrChart(series, a.target)
        }
    }
    if (series.cadence.any { it != null }) {
        SectionCard {
            SectionLabel("Cadence · spm", color = ChartCadence)
            LineChart(
                t = series.t, values = series.cadence, color = ChartCadence,
                formatY = { "${it.toInt()}" }, xLabels = timeAxis(series.t),
                formatX = { fmtClock(it.toInt()) }, height = 120.dp,
            )
        }
    }
    if (series.power.any { it != null }) {
        SectionCard {
            SectionLabel("Power · W", color = ChartPower)
            LineChart(
                t = series.t, values = series.power, color = ChartPower,
                formatY = { "${it.toInt()}" }, xLabels = timeAxis(series.t),
                formatX = { fmtClock(it.toInt()) }, height = 120.dp,
            )
        }
    }
}

// "(0, "N min")" time-axis labels from a seconds series.
private fun timeAxis(t: List<Double>): Pair<String, String> =
    "0" to "${((t.lastOrNull() ?: 0.0) / 60).toInt()} min"

// Per-kilometre splits with pace and average HR.
@Composable
private fun SplitsCard(
    activity: CompletedActivity,
    vm: ActivityAnalysisViewModel = hiltViewModel(),
) {
    val results by vm.results.collectAsStateSafe()
    val a = results[activity.id] ?: return
    if (a.splits.isEmpty()) return
    val per100m = a.isPer100m
    val banded = a.splits.count { it.in_band != null }
    val onTarget = a.splits.count { it.in_band == true }
    SectionCard {
        SectionLabel(
            "Splits" + if (banded > 0) " · $onTarget/$banded on target" else "",
            color = mossAccent(),
        )
        a.splits.forEach { s ->
            // Tint the pace by whether the split landed in the planned target band.
            val paceColor = when (s.in_band) {
                true -> BandGreen
                false -> BandAmber
                null -> MaterialTheme.colorScheme.onSurface
            }
            // Swim splits are 100 m each (km carries 0.1, 0.2, ...): label in metres.
            val distLabel = if (per100m) "${Math.round(s.km * 1000)} m"
            else "km ${if (s.km % 1.0 == 0.0) s.km.toInt().toString() else s.km.toString()}"
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(distLabel,
                    Modifier.width(64.dp), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${fmtPaceSec(s.sec)} ${if (per100m) "/100m" else "/km"}", style = MaterialTheme.typography.bodyMedium, color = paceColor)
                s.in_band?.let { Text(if (it) "  ✓" else "  ✗", style = MaterialTheme.typography.bodySmall, color = paceColor) }
                Spacer(Modifier.weight(1f))
                s.avg_hr?.let {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Favorite, contentDescription = "Heart rate",
                            modifier = Modifier.size(13.dp), tint = ChartHr)
                        Text(" $it", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
internal fun scoreColor(score: Int) = when {
    score >= 75 -> MaterialTheme.colorScheme.primary
    score >= 55 -> amberAccent()
    else -> MaterialTheme.colorScheme.error
}

@Composable
internal fun ExecutionRing(score: Int) {
    val color = scoreColor(score)
    val track = MaterialTheme.colorScheme.surfaceVariant
    Box(Modifier.size(72.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(72.dp)) {
            drawArc(track, -90f, 360f, false,
                style = Stroke(width = 14f))
            drawArc(color, -90f, 360f * (score / 100f), false,
                style = Stroke(
                    width = 14f, cap = StrokeCap.Round))
        }
        Text("$score", style = MaterialTheme.typography.titleLarge, color = color)
    }
}

@Composable
internal fun ScoreBar(score: Int) {
    Box(
        Modifier.fillMaxWidth().height(6.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh),
    ) {
        Box(
            Modifier.fillMaxWidth((score / 100f).coerceIn(0.02f, 1f)).height(6.dp)
                .background(scoreColor(score), RoundedCornerShape(3.dp)),
        )
    }
}

@Composable
private fun LegendDotSmall(label: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(9.dp).background(color, CircleShape))
        Text("  $label", style = MaterialTheme.typography.labelSmall)
    }
}

// Time-in-zone breakdown: one labelled bar per HR zone (Z1 easy → Zn max), with
// the time spent and its share of the session. Trailing empty zones are dropped.
@Composable
private fun HrZoneCard(zoneTimes: List<Int>) {
    val zones = zoneTimes.dropLastWhile { it == 0 }
    if (zones.isEmpty()) return
    val total = zones.sum().coerceAtLeast(1)
    val zoneColors = listOf(mossAccent(), MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.secondary, amberAccent(), MaterialTheme.colorScheme.error)
    SectionCard {
        SectionLabel("Time in HR zones", color = MaterialTheme.colorScheme.secondary)
        zones.forEachIndexed { i, secs ->
            val frac = secs / total.toFloat()
            val color = zoneColors.getOrElse(i) { zoneColors.last() }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Z${i + 1}",
                    Modifier.width(28.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Box(
                    Modifier.weight(1f).height(10.dp).clip(RoundedCornerShape(5.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh),
                ) {
                    Box(
                        Modifier.fillMaxWidth(frac.coerceIn(0f, 1f)).height(10.dp)
                            .background(color, RoundedCornerShape(5.dp)),
                    )
                }
                Text(
                    "${fmtClock(secs)} · ${(frac * 100 + 0.5f).toInt()}%",
                    Modifier.padding(start = 10.dp).width(88.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.End,
                )
            }
        }
    }
}

// Actual pace line over time with the planned pace band shaded behind it.
// Y axis is inverted (faster = higher), as runners expect.
@Composable
private fun PaceChart(
    series: AnalysisSeries,
    target: AnalysisTarget?,
    per100m: Boolean = false,
) {
    val paces = series.pace.filterNotNull()
    if (paces.isEmpty()) return
    // Clamp the scale to a sensible window so one GPS blip doesn't flatten it.
    // Swim paces live in sec/100m (roughly 1:00-4:00), not the run sec/km range.
    val floor = if (per100m) 45.0 else 120.0
    val ceil = if (per100m) 300.0 else 720.0
    val lo = paces.min().coerceAtLeast(floor).let { minOf(it, target?.pace_lo ?: it) } - 10
    val hi = paces.max().coerceAtMost(ceil).let { maxOf(it, target?.pace_hi ?: it) } + 10
    LineChart(
        t = series.t,
        values = series.pace,
        color = ChartPace,
        formatY = { Zones.formatPace(it.toInt().coerceAtLeast(0)) },
        xLabels = timeAxis(series.t),
        formatX = { fmtClock(it.toInt()) },
        inverted = true,
        band = target?.takeIf { it.pace_lo != null && it.pace_hi != null }?.let { it.pace_lo!! to it.pace_hi!! },
        bandColor = MaterialTheme.colorScheme.secondary,
        minOverride = lo,
        maxOverride = hi,
        height = 150.dp,
    )
}

@Composable
internal fun HrChart(
    series: AnalysisSeries,
    target: AnalysisTarget?,
) {
    val hrs = series.hr.filterNotNull()
    if (hrs.isEmpty()) return
    LineChart(
        t = series.t,
        values = series.hr,
        // Hard requirement: the HR line is ALWAYS red, regardless of theme.
        color = ChartHr,
        formatY = { "${it.toInt()}" },
        xLabels = timeAxis(series.t),
        formatX = { fmtClock(it.toInt()) },
        band = target?.takeIf { it.hr_lo != null && it.hr_hi != null }?.let { it.hr_lo!!.toDouble() to it.hr_hi!!.toDouble() },
        bandColor = MaterialTheme.colorScheme.primary,
        height = 130.dp,
    )
}
